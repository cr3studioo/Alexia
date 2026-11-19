// SPDX-License-Identifier: AGPL-3.0-only
//! The Telegram channel: poll, pairing, offsets, buttons. Ported from v2's
//! `plugins/telegram` (`index.js` pairing, `acks.js` offsets, `incoming.js` photos, `api.js`
//! chunking, `clash.js` back-off).
//!
//! `from_owner` is the trust boundary: only a user id paired by code is an owner. Never a
//! username, never a chat id on its own (a private chat's id is its user's id).

#[doc(hidden)]
pub mod api;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::hash::BuildHasher;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use alexia_core::Budget;
use alexia_store::{Content, Ms, Part, Store};
use base64::Engine;
use serde_json::json;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use self::api::{Api, TgMessage, Update};
use crate::{Channel, ChatRef, Error, InFile, InKind, Inbound, MsgRef, Outbound, Result};

const NS: &str = "_core";
const OWNERS: &str = "telegram_owners";
const CODE: &str = "telegram_pairing_code";
const OFFSET: &str = "telegram_offset";
/// v2's POLL_SECONDS.
const POLL_S: u32 = 50;
/// Telegram's message length.
const LIMIT: usize = 4096;
/// The largest photo size downloaded (v2 `bestPhoto`).
const PHOTO_MAX: u64 = 10 * 1024 * 1024;
const CLASH_FIRST: Duration = Duration::from_secs(10);
const CLASH_MAX: Duration = Duration::from_secs(5 * 60);
const DOWN_FIRST: Duration = Duration::from_secs(1);
const DOWN_MAX: Duration = Duration::from_secs(30);
/// Wrong pairing guesses before the code changes.
const GUESSES: u32 = 5;
/// Added to what the owner wrote when a photo, voice note or file couldn't be fetched.
const UNREAD: &str = "[The attachment couldn't be read.]";

/// v2's `Acks`: the saved offset is the oldest update not yet finished, else one past the
/// newest. `poll` is what the loop asks for next, which runs ahead of it.
struct Offsets {
    poll: i64,
    /// update id → chat id, for every update passed on and not yet answered.
    open: BTreeMap<i64, i64>,
    newest: Option<i64>,
    saved: Option<i64>,
}

impl Offsets {
    fn mark(&self) -> Option<i64> {
        let oldest = self.open.keys().next().copied();
        oldest.or(self.newest.map(|n| n + 1))
    }
}

/// An ask waiting for its button: its number and who to tell.
type Pending = (u64, oneshot::Sender<bool>);

pub struct Telegram {
    api: Api,
    store: Arc<Store>,
    cache: PathBuf,
    /// (chat id, ask message id) → the ask's number and its waiting `ask()`.
    asks: Mutex<HashMap<(i64, i64), Pending>>,
    /// Seeded from the clock, so a button left over from an earlier run never matches.
    ask_seq: AtomicU64,
    /// Sender id → wrong pairing guesses since that sender's count last reset.
    misses: Mutex<HashMap<i64, u32>>,
    /// Chats whose last `send` failed: their updates stay open, so a restart replays them.
    failed: Mutex<HashSet<i64>>,
    offsets: Mutex<Offsets>,
    /// chat id → the draft id of the reply being written there.
    drafts: Mutex<HashMap<i64, i64>>,
    told_unpaired: AtomicBool,
    told_clash: AtomicBool,
    refused: AtomicBool,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> Ms {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as Ms)
        .unwrap_or(0)
}

/// ponytail: std's per-process-seeded SipHash over the clock, enough for a six-digit code and a
/// draft id; take a CSPRNG crate if anything here ever needs real randomness.
fn random() -> u64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::collections::hash_map::RandomState::new().hash_one(nanos)
}

fn new_code() -> String {
    (100_000 + random() % 900_000).to_string()
}

/// v2 `draftId()`: 1 ..= 2^31 - 1.
fn draft_id() -> i64 {
    1 + (random() % ((1 << 31) - 1)) as i64
}

/// The six-digit code, created on first use and kept in kv `_core/telegram_pairing_code`.
pub(crate) fn pairing_code(store: &Store) -> Result<String> {
    if let Some(code) = store
        .kv_get(NS, CODE)?
        .and_then(|v| v.as_str().map(str::to_owned))
    {
        return Ok(code);
    }
    let code = new_code();
    store.kv_set(NS, CODE, &json!(code))?;
    Ok(code)
}

pub(crate) fn owners(store: &Store) -> Result<Vec<i64>> {
    Ok(store
        .kv_get(NS, OWNERS)?
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default())
}

fn chat_id(chat: &ChatRef) -> Result<i64> {
    chat.chat
        .parse()
        .map_err(|_| Error::Service("That isn't a Telegram chat.".into()))
}

fn msg_id(msg: &MsgRef) -> Result<i64> {
    msg.id
        .parse()
        .map_err(|_| Error::Service("That isn't a Telegram message.".into()))
}

/// Telegram counts UTF-16 units; so does every limit here.
fn units(s: &str) -> usize {
    s.encode_utf16().count()
}

/// The longest prefix of `s` within `limit` UTF-16 units, on a char boundary.
fn head(s: &str, limit: usize) -> &str {
    let mut n = 0;
    for (i, c) in s.char_indices() {
        n += c.len_utf16();
        if n > limit {
            return &s[..i];
        }
    }
    s
}

/// The shortest suffix holding the last `limit` UTF-16 units.
fn tail(s: &str, limit: usize) -> &str {
    let mut n = 0;
    for (i, c) in s.char_indices().rev() {
        n += c.len_utf16();
        if n > limit {
            return &s[i + c.len_utf8()..];
        }
    }
    s
}

/// v2 `chunk()`: split at `limit` on a paragraph, then a line, then a word, when one lies in
/// the second half of the piece; else a hard cut.
fn chunk(text: &str, limit: usize) -> Vec<String> {
    let mut parts = Vec::new();
    let mut left = text;
    while units(left) > limit {
        let piece = head(left, limit);
        let half = piece.len() / 2;
        let at = [
            piece.rfind("\n\n").map(|i| i + 2),
            piece.rfind('\n').map(|i| i + 1),
            piece.rfind(' ').map(|i| i + 1),
        ]
        .into_iter()
        .flatten()
        .find(|&i| i > half)
        .unwrap_or(
            piece
                .len()
                .max(left.chars().next().map_or(1, char::len_utf8)),
        );
        parts.push(left[..at].trim_end().to_owned());
        left = &left[at..];
    }
    parts.push(left.trim_end().to_owned());
    parts.retain(|p| !p.trim().is_empty());
    parts
}

/// v2 `safeName`: only the basename, `[A-Za-z0-9._-]`, no leading dot, at most 100, never
/// empty. The name comes from the sender, so it must not climb out of the cache folder.
fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let clean: String = clean.trim_start_matches('.').chars().take(100).collect();
    if clean.is_empty() {
        "file".into()
    } else {
        clean
    }
}

fn write(path: &Path, bytes: &[u8]) -> Result<()> {
    std::fs::write(path, bytes).map_err(|e| Error::Service(format!("couldn't save the file: {e}")))
}

fn read(path: &Path) -> Result<Vec<u8>> {
    std::fs::read(path).map_err(|e| Error::Service(format!("couldn't read the file: {e}")))
}

impl Telegram {
    /// Restarts from kv `_core/telegram_offset`, or from Telegram's backlog when there is none.
    pub fn new(api: Api, store: Arc<Store>, cache: PathBuf) -> Telegram {
        let saved = match store.kv_get(NS, OFFSET) {
            Ok(v) => v.and_then(|v| v.as_i64()),
            Err(e) => {
                tracing::warn!("telegram: the saved offset couldn't be read: {e}");
                None
            }
        };
        Telegram {
            api,
            store,
            cache,
            asks: Mutex::default(),
            ask_seq: AtomicU64::new(now_ms().max(0) as u64),
            misses: Mutex::default(),
            failed: Mutex::default(),
            offsets: Mutex::new(Offsets {
                poll: saved.unwrap_or(0),
                open: BTreeMap::new(),
                newest: None,
                saved,
            }),
            drafts: Mutex::default(),
            told_unpaired: AtomicBool::new(false),
            told_clash: AtomicBool::new(false),
            refused: AtomicBool::new(false),
        }
    }

    /// The six-digit code, created on first use and kept in kv `_core/telegram_pairing_code`.
    pub fn pairing_code(&self) -> Result<String> {
        pairing_code(&self.store)
    }

    /// The final reply for `chat` went out: every started update of that chat is done.
    pub(crate) fn finished(&self, chat: i64) {
        let mut o = lock(&self.offsets);
        o.open.retain(|_, c| *c != chat);
        self.save(&mut o);
    }

    /// Every chunk, then every file; the id of the last message sent.
    async fn send_all(&self, chat: i64, out: &Outbound) -> Result<i64> {
        let mut last = None;
        for part in chunk(&out.text, LIMIT) {
            last = Some(self.api.send_message(chat, &part, None, None).await?);
        }
        let voice = out.voice && out.files.len() == 1 && out.files[0].mime == "audio/ogg";
        for f in &out.files {
            let bytes = read(&f.path)?;
            last = Some(if voice {
                self.api.send_voice(chat, bytes, None).await?
            } else {
                self.api
                    .send_document(chat, &f.name, &f.mime, bytes)
                    .await?
            });
        }
        last.ok_or_else(|| Error::Service("There was nothing to send.".into()))
    }

    fn save(&self, o: &mut Offsets) {
        let mark = o.mark();
        if mark.is_none() || mark == o.saved {
            return;
        }
        match self.store.kv_set(NS, OFFSET, &json!(mark)) {
            Ok(()) => o.saved = mark,
            Err(e) => tracing::warn!("telegram: the offset couldn't be saved: {e}"),
        }
    }

    fn tell_if_unpaired(&self) {
        if self.told_unpaired.load(Ordering::Relaxed) {
            return;
        }
        match owners(&self.store).and_then(|o| Ok((o, self.pairing_code()?))) {
            Ok((o, code)) if o.is_empty() => {
                self.told_unpaired.store(true, Ordering::Relaxed);
                tracing::info!("Waiting to be paired — send {code} to the bot");
            }
            Ok(_) => self.told_unpaired.store(true, Ordering::Relaxed),
            Err(e) => tracing::warn!("telegram: couldn't read who is paired: {e}"),
        }
    }

    /// Turns one batch into inbounds. Every update not passed on is finished at once.
    async fn take_all(&self, updates: Vec<Update>, at: Ms) -> Vec<Inbound> {
        let mut out = Vec::new();
        for u in updates {
            let id = u.update_id;
            {
                let mut o = lock(&self.offsets);
                o.poll = o.poll.max(id + 1);
                o.newest = Some(o.newest.map_or(id, |n| n.max(id)));
            }
            let got = match self.take(u, at).await {
                Ok(got) => got,
                Err(e) => {
                    tracing::warn!("telegram: update {id} was dropped: {e}");
                    None
                }
            };
            let mut o = lock(&self.offsets);
            if let Some(inbound) = got {
                if inbound.kind == InKind::Message {
                    if let Ok(chat) = inbound.chat.chat.parse() {
                        o.open.insert(id, chat);
                    }
                }
                out.push(inbound);
            }
            self.save(&mut o);
        }
        out
    }

    async fn take(&self, u: Update, at: Ms) -> Result<Option<Inbound>> {
        if let Some(cq) = u.callback_query {
            self.pressed(cq).await?;
            return Ok(None);
        }
        if let Some(stop) = u.stopped_message_generation {
            // Only the user of a private chat can press Stop in it, so the chat id is the user.
            let owner = stop.chat.kind == "private" && owners(&self.store)?.contains(&stop.chat.id);
            if !owner {
                return Ok(None);
            }
            return Ok(Some(Inbound {
                chat: ChatRef {
                    chat: stop.chat.id.to_string(),
                },
                msg: MsgRef {
                    id: stop.draft_id.to_string(),
                },
                kind: InKind::Stop,
                from_owner: true,
                content: Content::Text(String::new()),
                files: Vec::new(),
                at,
            }));
        }
        let Some(m) = u.message else {
            return Ok(None);
        };
        // Group chats are ignored in P1.
        if m.chat.kind != "private" {
            return Ok(None);
        }
        let Some(from) = m.from.as_ref().filter(|f| !f.is_bot) else {
            return Ok(None);
        };
        if !owners(&self.store)?.contains(&from.id) {
            self.stranger(&m, from.id).await?;
            return Ok(None);
        }
        self.message(u.update_id, m, at).await
    }

    /// Somebody not paired: the code pairs them; anything else gets no answer at all.
    async fn stranger(&self, m: &TgMessage, user: i64) -> Result<()> {
        // Once paired, nobody can know the code (it is shown only while unpaired), so a guess
        // serves nobody: no compare, no count, no rotation, and no code is ever created.
        if !owners(&self.store)?.is_empty() {
            return Ok(());
        }
        let code = self.pairing_code()?;
        let Some(guess) = m.text.as_deref().map(str::trim) else {
            return Ok(());
        };
        if guess != code {
            // ponytail: the map lives in memory, so a restart grants five more guesses per
            // sender, and many accounts can still rotate the code before pairing; the owner is
            // at the console then and sees the new code in the log. Keep it in kv if that bites.
            let rotate = {
                let mut misses = lock(&self.misses);
                let n = misses.entry(user).or_insert(0);
                *n += 1;
                let rotate = *n >= GUESSES;
                if rotate {
                    misses.remove(&user);
                }
                rotate
            };
            if rotate {
                let code = new_code();
                self.store.kv_set(NS, CODE, &json!(code))?;
                tracing::info!(
                    "telegram: {GUESSES} wrong pairing codes, so the code changed. \
                     Waiting to be paired — send {code} to the bot"
                );
            }
            return Ok(());
        }
        lock(&self.misses).clear();
        let mut who = owners(&self.store)?;
        who.push(user);
        self.store.kv_set(NS, OWNERS, &json!(who))?;
        // A used code is spent: one screenshot must not be a permanent way in.
        self.store.kv_set(NS, CODE, &json!(new_code()))?;
        // The chat that paired is where Alexia speaks when nothing asked her. It must be known
        // before it can be the primary.
        let chat = m.chat.id.to_string();
        self.store.channel_session("telegram", &chat)?;
        self.store.set_primary_chat("telegram", &chat)?;
        tracing::info!("telegram: paired a new account");
        self.api
            .send_message(m.chat.id, "Paired. I'm listening.", None, None)
            .await?;
        Ok(())
    }

    async fn message(&self, update: i64, m: TgMessage, at: Ms) -> Result<Option<Inbound>> {
        let text = m.text.clone().or(m.caption.clone()).unwrap_or_default();
        let (content, files) = match self.attachment(update, &m, &text).await {
            Ok(Some(got)) => got,
            // A sticker, a location: nothing P1 reads.
            Ok(None) if text.trim().is_empty() => return Ok(None),
            Ok(None) => (Content::Text(text), Vec::new()),
            // Passed on anyway, so the owner hears back instead of losing the message.
            Err(e) => {
                tracing::warn!("telegram: the attachment of update {update} was not read: {e}");
                let text = if text.trim().is_empty() {
                    UNREAD.to_owned()
                } else {
                    format!("{text}\n\n{UNREAD}")
                };
                (Content::Text(text), Vec::new())
            }
        };
        Ok(Some(Inbound {
            chat: ChatRef {
                chat: m.chat.id.to_string(),
            },
            msg: MsgRef {
                id: m.message_id.to_string(),
            },
            kind: InKind::Message,
            from_owner: true,
            content,
            files,
            at,
        }))
    }

    /// The photo, voice note or document of `m`, fetched into the cache; `None` when it has none.
    async fn attachment(
        &self,
        update: i64,
        m: &TgMessage,
        text: &str,
    ) -> Result<Option<(Content, Vec<InFile>)>> {
        let dir = self.cache.join("telegram");
        let ensure_dir = || {
            std::fs::create_dir_all(&dir)
                .map_err(|e| Error::Service(format!("couldn't make the cache folder: {e}")))
        };
        let caption = || Content::Text(text.to_owned());
        let best = m
            .photo
            .iter()
            .filter(|p| p.file_size.is_none_or(|n| n <= PHOTO_MAX))
            .max_by_key(|p| u64::from(p.width) * u64::from(p.height));
        if let Some(photo) = best {
            // Only the image part is passed on, so nothing is written to the cache.
            let bytes = self.api.download(&photo.file_id).await?;
            let url = format!(
                "data:image/jpeg;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(&bytes)
            );
            let text = text.to_owned();
            Ok(Some((
                Content::Parts(vec![Part::Text { text }, Part::Image { url }]),
                Vec::new(),
            )))
        } else if !m.photo.is_empty() {
            Err(Error::Service(
                "every size of that photo is over 10 MB".into(),
            ))
        } else if let Some(voice) = m.voice.as_ref().or(m.audio.as_ref()) {
            ensure_dir()?;
            let name = format!("{update}.ogg");
            let path = dir.join(&name);
            write(&path, &self.api.download(&voice.file_id).await?)?;
            let file = InFile {
                name,
                mime: "audio/ogg".into(),
                path,
            };
            Ok(Some((caption(), vec![file])))
        } else if let Some(doc) = &m.document {
            ensure_dir()?;
            let name = safe_name(doc.file_name.as_deref().unwrap_or("file"));
            let path = dir.join(format!("{update}-{name}"));
            write(&path, &self.api.download(&doc.file_id).await?)?;
            let mime = doc
                .mime_type
                .clone()
                .unwrap_or_else(|| "application/octet-stream".into());
            Ok(Some((caption(), vec![InFile { name, mime, path }])))
        } else {
            Ok(None)
        }
    }

    /// A button press: routed to the waiting `ask()` when it is the owner's.
    async fn pressed(&self, cq: api::CallbackQuery) -> Result<()> {
        let data = cq.data.as_deref().unwrap_or("");
        let parsed = match data.split_once(':') {
            Some(("y", n)) => n.parse::<u64>().ok().map(|n| (true, n)),
            Some(("n", n)) => n.parse::<u64>().ok().map(|n| (false, n)),
            _ => None,
        };
        let Some((yes, n)) = parsed else {
            return self.api.answer_callback(&cq.id, None).await;
        };
        if !owners(&self.store)?.contains(&cq.from.id) {
            let only = "Only the owner can answer this.";
            return self.api.answer_callback(&cq.id, Some(only)).await;
        }
        // Only the ask that sent this very message, with this very number, is answered.
        let waiting = cq.message.as_ref().and_then(|m| {
            let mut asks = lock(&self.asks);
            let key = (m.chat.id, m.message_id);
            match asks.get(&key) {
                Some((seq, _)) if *seq == n => asks.remove(&key).map(|(_, tx)| tx),
                _ => None,
            }
        });
        let (Some(tx), Some(m)) = (waiting, cq.message) else {
            // Stale or unknown (an earlier run, a cancelled ask): the message stays as it is.
            let expired = "This question has expired.";
            return self.api.answer_callback(&cq.id, Some(expired)).await;
        };
        let _ = tx.send(yes);
        self.api.answer_callback(&cq.id, None).await?;
        let word = if yes { "approved" } else { "denied" };
        let text = format!("{} — {word}", m.text.unwrap_or_default());
        self.api.remove_buttons(m.chat.id, m.message_id).await?;
        self.api.edit_message(m.chat.id, m.message_id, &text).await
    }
}

#[async_trait::async_trait]
impl Channel for Telegram {
    fn name(&self) -> &'static str {
        "telegram"
    }

    fn budget(&self) -> Budget {
        Budget::CHAT
    }

    async fn next(&self, cancel: CancellationToken) -> Result<Vec<Inbound>> {
        if self.refused.load(Ordering::Relaxed) {
            return Err(Error::Unauthorized);
        }
        self.tell_if_unpaired();
        let mut clash = CLASH_FIRST;
        let mut down = DOWN_FIRST;
        loop {
            let offset = lock(&self.offsets).poll;
            let got = self.api.get_updates(offset, POLL_S, &cancel).await;
            // The receipt time: one value for the whole batch.
            let at = now_ms();
            let wait = match got {
                Ok(updates) => {
                    self.told_clash.store(false, Ordering::Relaxed);
                    clash = CLASH_FIRST;
                    down = DOWN_FIRST;
                    let out = self.take_all(updates, at).await;
                    if !out.is_empty() {
                        return Ok(out);
                    }
                    continue;
                }
                Err(Error::Cancelled) => return Err(Error::Cancelled),
                Err(Error::Unauthorized) => {
                    tracing::error!("The bot token was refused.");
                    self.refused.store(true, Ordering::Relaxed);
                    return Err(Error::Unauthorized);
                }
                Err(Error::Conflict) => {
                    // Reported, nothing more: whoever else polls is not ours to name or stop.
                    if !self.told_clash.swap(true, Ordering::Relaxed) {
                        tracing::warn!("Another program is reading this bot's messages");
                    }
                    let w = clash;
                    clash = (clash * 2).min(CLASH_MAX);
                    w
                }
                Err(Error::RateLimited { retry_after_ms }) => Duration::from_millis(retry_after_ms),
                // Unreachable, or a Telegram outage (a 5xx comes back as Service).
                Err(e) => {
                    tracing::debug!("telegram: polling failed: {e}");
                    let w = down;
                    down = (down * 2).min(DOWN_MAX);
                    w
                }
            };
            tokio::select! {
                () = cancel.cancelled() => return Err(Error::Cancelled),
                () = tokio::time::sleep(wait) => {}
            }
        }
    }

    async fn react(&self, chat: &ChatRef, msg: &MsgRef, emoji: &str) -> Result<()> {
        self.api
            .set_reaction(chat_id(chat)?, msg_id(msg)?, emoji)
            .await
    }

    async fn typing(&self, chat: &ChatRef) -> Result<()> {
        self.api.chat_action(chat_id(chat)?, "typing").await
    }

    async fn send(&self, chat: &ChatRef, out: &Outbound) -> Result<MsgRef> {
        let chat = chat_id(chat)?;
        match self.send_all(chat, out).await {
            Ok(last) => {
                lock(&self.failed).remove(&chat);
                self.finished(chat);
                Ok(MsgRef {
                    id: last.to_string(),
                })
            }
            Err(e) => {
                // Nothing is finished: the following `draft(None)` must not finish it either.
                lock(&self.failed).insert(chat);
                Err(e)
            }
        }
    }

    async fn draft(&self, chat: &ChatRef, text: Option<&str>) -> Result<()> {
        let chat = chat_id(chat)?;
        let Some(text) = text else {
            // Telegram drops an unrefreshed draft by itself. A reply cleared with nothing sent
            // (a stopped turn) is done, so a crash now does not replay it (v2 `Acks`). One
            // cleared after a failed send is not: its updates stay open and a restart replays it.
            lock(&self.drafts).remove(&chat);
            if !lock(&self.failed).remove(&chat) {
                self.finished(chat);
            }
            return Ok(());
        };
        let id = *lock(&self.drafts).entry(chat).or_insert_with(draft_id);
        self.api.send_draft(chat, id, tail(text, LIMIT), true).await
    }

    async fn edit(&self, chat: &ChatRef, msg: &MsgRef, text: &str) -> Result<()> {
        self.api
            .edit_message(chat_id(chat)?, msg_id(msg)?, text)
            .await
    }

    async fn ask(
        &self,
        chat: &ChatRef,
        text: &str,
        cancel: CancellationToken,
    ) -> Result<Option<bool>> {
        let chat = chat_id(chat)?;
        let n = self.ask_seq.fetch_add(1, Ordering::Relaxed) + 1;
        let buttons = [
            ("Approve".to_owned(), format!("y:{n}")),
            ("Deny".to_owned(), format!("n:{n}")),
        ];
        let msg = self
            .api
            .send_message(chat, text, Some(&buttons), None)
            .await?;
        // Keyed by the message, known only once it is sent. A press needs the owner to see the
        // message first, so it cannot beat this insert.
        let (tx, rx) = oneshot::channel();
        lock(&self.asks).insert((chat, msg), (n, tx));
        tokio::select! {
            got = rx => Ok(got.ok()),
            () = cancel.cancelled() => {
                lock(&self.asks).remove(&(chat, msg));
                let _ = self.api.remove_buttons(chat, msg).await;
                Ok(None)
            }
        }
    }
}
