// SPDX-License-Identifier: AGPL-3.0-only
//! P1-10: the Telegram channel against a fake Bot API speaking raw HTTP/1.1.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use alexia_gateway::channels::telegram::api::Api;
use alexia_gateway::channels::telegram::Telegram;
use alexia_gateway::channels::{configured, pairing_codes, secret_keys};
use alexia_gateway::{Channel, ChatRef, Error, InKind, Inbound, Outbound};
use alexia_store::{secrets, Content, Layout, Part, Store};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

/// Generous: a loaded Windows machine is slow.
const WAIT: Duration = Duration::from_secs(30);
/// What the fake's `/file/` download serves; base64 "aGVsbG8ganBlZyE=".
const FILE_BYTES: &[u8] = b"hello jpeg!";

/// The token, built at runtime so no credential-shaped literal sits in the source.
fn token() -> String {
    format!("{}:{}", "123456", "fake-test-secret-value")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// One request the fake saw.
#[derive(Clone, Debug)]
struct Seen {
    path: String,
    body: Vec<u8>,
}

impl Seen {
    fn method(&self) -> &str {
        self.path.rsplit('/').next().unwrap_or("")
    }
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
}

/// A fake Bot API (the P1-09 helper, scripted): `getUpdates` answers the next queued batch, or
/// an empty one after 100 ms when nothing is queued. Every other method answers success.
#[derive(Clone)]
struct Fake {
    base: String,
    log: Arc<Mutex<Vec<Seen>>>,
    updates: Arc<Mutex<VecDeque<(u16, Value)>>>,
    /// When each non-empty `getUpdates` answer was written.
    replied_at: Arc<Mutex<Vec<i64>>>,
}

impl Fake {
    async fn start() -> Fake {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fake = Fake {
            base: format!("http://{}", listener.local_addr().unwrap()),
            log: Arc::default(),
            updates: Arc::default(),
            replied_at: Arc::default(),
        };
        let f = fake.clone();
        tokio::spawn(async move {
            loop {
                let Ok((sock, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(f.clone().serve(sock));
            }
        });
        fake
    }

    async fn serve(self, mut sock: tokio::net::TcpStream) {
        let mut buf = Vec::new();
        let mut byte = [0u8; 8192];
        let header_end = loop {
            let n = sock.read(&mut byte).await.unwrap_or(0);
            if n == 0 {
                return;
            }
            buf.extend_from_slice(&byte[..n]);
            if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break at + 4;
            }
        };
        let headers = String::from_utf8_lossy(&buf[..header_end]).to_lowercase();
        let length: usize = headers
            .lines()
            .find_map(|l| l.strip_prefix("content-length:"))
            .map_or(0, |v| v.trim().parse().unwrap());
        while buf.len() < header_end + length {
            let n = sock.read(&mut byte).await.unwrap_or(0);
            if n == 0 {
                return;
            }
            buf.extend_from_slice(&byte[..n]);
        }
        let seen = Seen {
            path: headers.split(' ').nth(1).unwrap_or("").to_owned(),
            body: buf[header_end..].to_vec(),
        };
        let (status, body) = if seen.path.contains("/file/") {
            (200, FILE_BYTES.to_vec())
        } else {
            let (status, value) = match seen.method() {
                "getupdates" => {
                    let next = self.updates.lock().unwrap().pop_front();
                    match next {
                        Some(answer) => answer,
                        None => {
                            self.log.lock().unwrap().push(seen);
                            tokio::time::sleep(Duration::from_millis(100)).await;
                            return reply(sock, 200, ok(json!([])).to_string().into_bytes()).await;
                        }
                    }
                }
                "getfile" => (200, ok(json!({"file_id": "x", "file_path": "f/x"}))),
                "sendmessage" | "senddocument" | "sendvoice" => (
                    200,
                    ok(json!({"message_id": 77, "date": 1, "chat": {"id": 5, "type": "private"}})),
                ),
                _ => (200, ok(json!(true))),
            };
            if seen.method() == "getupdates" {
                self.replied_at.lock().unwrap().push(now_ms());
            }
            (status, value.to_string().into_bytes())
        };
        self.log.lock().unwrap().push(seen);
        reply(sock, status, body).await;
    }

    fn push(&self, status: u16, body: Value) {
        self.updates.lock().unwrap().push_back((status, body));
    }

    fn batch(&self, updates: Value) {
        self.push(200, ok(updates));
    }

    fn seen(&self, method: &str) -> Vec<Seen> {
        let log = self.log.lock().unwrap();
        log.iter()
            .filter(|s| s.method() == method.to_lowercase())
            .cloned()
            .collect()
    }

    /// Waits until `method` has been called `n` times.
    async fn until(&self, method: &str, n: usize) -> Vec<Seen> {
        let start = Instant::now();
        loop {
            let got = self.seen(method);
            if got.len() >= n {
                return got;
            }
            assert!(
                start.elapsed() < WAIT,
                "{method} was called {} times, not {n}",
                got.len()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    fn channel(&self, store: &Arc<Store>, cache: PathBuf) -> Arc<Telegram> {
        Arc::new(Telegram::new(
            Api::new(&self.base, token()),
            store.clone(),
            cache,
        ))
    }
}

async fn reply(mut sock: tokio::net::TcpStream, status: u16, body: Vec<u8>) {
    let head = format!(
        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    let _ = sock.write_all(head.as_bytes()).await;
    let _ = sock.write_all(&body).await;
    let _ = sock.flush().await;
}

fn ok(result: Value) -> Value {
    json!({"ok": true, "result": result})
}

fn store_with_owners(owners: &[i64]) -> Arc<Store> {
    let store = Store::open_in_memory().unwrap();
    if !owners.is_empty() {
        store
            .kv_set("_core", "telegram_owners", &json!(owners))
            .unwrap();
    }
    Arc::new(store)
}

fn cache(test: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("alexia-p1-10-{test}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

/// A private-chat message from `user`, with `extra` fields merged in.
fn message(update: i64, user: i64, extra: Value) -> Value {
    let mut m = json!({
        "message_id": update * 10,
        "date": 1_700_000_000,
        "chat": {"id": user, "type": "private"},
        "from": {"id": user, "is_bot": false, "first_name": "U"},
    });
    for (k, v) in extra.as_object().unwrap() {
        m[k] = v.clone();
    }
    json!({"update_id": update, "message": m})
}

async fn next(ch: &Telegram) -> Vec<Inbound> {
    tokio::time::timeout(WAIT, ch.next(CancellationToken::new()))
        .await
        .expect("next() timed out")
        .expect("next() failed")
}

fn chat(id: i64) -> ChatRef {
    ChatRef {
        chat: id.to_string(),
    }
}

fn plain(text: &str) -> Outbound {
    Outbound {
        text: text.into(),
        files: Vec::new(),
        voice: false,
    }
}

fn saved_offset(store: &Store) -> Option<i64> {
    store
        .kv_get("_core", "telegram_offset")
        .unwrap()
        .and_then(|v| v.as_i64())
}

/// Runs `next()` until `stop` resolves, then cancels it and returns what it ended with.
async fn next_until<F: std::future::Future>(
    ch: &Telegram,
    stop: F,
) -> alexia_gateway::Result<Vec<Inbound>> {
    let cancel = CancellationToken::new();
    let run = ch.next(cancel.clone());
    tokio::pin!(run);
    tokio::select! {
        got = &mut run => return got,
        _ = stop => {}
    }
    cancel.cancel();
    tokio::time::timeout(WAIT, run)
        .await
        .expect("next() ignored cancel")
}

#[tokio::test]
async fn unpaired_messages_are_dropped() {
    let fake = Fake::start().await;
    let store = store_with_owners(&[]);
    let ch = fake.channel(&store, cache("unpaired"));
    fake.batch(json!([message(100, 9, json!({"text": "hello"}))]));
    // The second poll means the first batch was handled.
    let got = next_until(&ch, fake.until("getUpdates", 2)).await;
    assert!(matches!(got, Err(Error::Cancelled)), "{got:?}");
    assert!(
        fake.seen("sendMessage").is_empty(),
        "a stranger gets no reply"
    );
    assert_eq!(fake.until("getUpdates", 2).await[1].json()["offset"], 101);
    assert_eq!(
        saved_offset(&store),
        Some(101),
        "a dropped update is finished"
    );
}

#[tokio::test]
async fn pairing_code_pairs_and_sets_primary() {
    let fake = Fake::start().await;
    let store = store_with_owners(&[]);
    let ch = fake.channel(&store, cache("pairing"));
    let code = ch.pairing_code().unwrap();
    assert_eq!(code.len(), 6);
    assert!(code.chars().all(|c| c.is_ascii_digit()));
    assert_eq!(ch.pairing_code().unwrap(), code, "the code is kept");
    fake.batch(json!([message(
        100,
        7,
        json!({"text": format!(" {code} ")})
    )]));
    fake.batch(json!([message(101, 7, json!({"text": "hi"}))]));
    let got = next(&ch).await;
    assert_eq!(got.len(), 1, "the code itself is not passed on");
    assert_eq!(got[0].content, Content::Text("hi".into()));
    assert!(got[0].from_owner);
    let sent = fake.seen("sendMessage");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].json()["text"], "Paired. I'm listening.");
    assert_eq!(sent[0].json()["chat_id"], 7);
    assert_eq!(
        store.kv_get("_core", "telegram_owners").unwrap(),
        Some(json!([7]))
    );
    assert_eq!(
        store.primary_chat("telegram").unwrap().as_deref(),
        Some("7")
    );
    assert_ne!(ch.pairing_code().unwrap(), code, "a used code is spent");
}

#[tokio::test]
async fn owner_message_becomes_inbound_with_receipt_time() {
    let fake = Fake::start().await;
    let store = store_with_owners(&[5]);
    let ch = fake.channel(&store, cache("receipt"));
    fake.batch(json!([
        message(100, 5, json!({"text": "hello"})),
        message(101, 5, json!({"text": "again"})),
    ]));
    let got = next(&ch).await;
    assert_eq!(got.len(), 2);
    let replied = fake.replied_at.lock().unwrap()[0];
    assert!(
        (got[0].at - replied).abs() <= 5,
        "at {} vs reply {replied}",
        got[0].at
    );
    assert_eq!(got[0].at, got[1].at, "one receipt time per batch");
    assert_eq!(got[0].chat, chat(5));
    assert_eq!(got[0].msg.id, "1000");
    assert_eq!(got[0].kind, InKind::Message);
    assert!(got[0].from_owner);
    assert_eq!(got[0].content, Content::Text("hello".into()));
    assert!(got[0].files.is_empty());
}

#[tokio::test]
async fn photo_becomes_image_part() {
    let fake = Fake::start().await;
    let store = store_with_owners(&[5]);
    let dir = cache("photo");
    let ch = fake.channel(&store, dir.clone());
    let photo = json!([
        {"file_id": "small", "file_unique_id": "s", "width": 90, "height": 60, "file_size": 1200},
        {"file_id": "big", "file_unique_id": "b", "width": 1280, "height": 853, "file_size": 98000},
        {"file_id": "huge", "file_unique_id": "h", "width": 4000, "height": 3000, "file_size": 11_000_000}
    ]);
    fake.batch(json!([message(
        101,
        5,
        json!({"caption": "a sunset", "photo": photo})
    )]));
    let got = next(&ch).await;
    assert_eq!(got.len(), 1);
    assert_eq!(fake.seen("getFile")[0].json()["file_id"], "big");
    assert_eq!(
        got[0].content,
        Content::Parts(vec![
            Part::Text {
                text: "a sunset".into()
            },
            Part::Image {
                url: "data:image/jpeg;base64,aGVsbG8ganBlZyE=".into()
            },
        ])
    );
    let saved = dir.join("telegram").join("101.jpg");
    assert_eq!(std::fs::read(saved).unwrap(), FILE_BYTES);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn voice_becomes_infile() {
    let fake = Fake::start().await;
    let store = store_with_owners(&[5]);
    let dir = cache("voice");
    let ch = fake.channel(&store, dir.clone());
    let voice = json!({"file_id": "v1", "file_unique_id": "vu", "duration": 4, "mime_type": "audio/ogg", "file_size": 9000});
    fake.batch(json!([message(102, 5, json!({"voice": voice}))]));
    let got = next(&ch).await;
    assert_eq!(got.len(), 1);
    assert_eq!(fake.seen("getFile")[0].json()["file_id"], "v1");
    assert_eq!(got[0].content, Content::Text(String::new()));
    assert_eq!(got[0].files.len(), 1);
    let file = &got[0].files[0];
    assert_eq!(file.mime, "audio/ogg");
    assert_eq!(file.path, dir.join("telegram").join("102.ogg"));
    assert_eq!(std::fs::read(&file.path).unwrap(), FILE_BYTES);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn stop_update_is_stop_kind() {
    let fake = Fake::start().await;
    let store = store_with_owners(&[5]);
    let ch = fake.channel(&store, cache("stop"));
    fake.batch(json!([
        {"update_id": 104, "stopped_message_generation": {"chat": {"id": 9, "type": "private"}, "draft_id": 1}},
        {"update_id": 105, "stopped_message_generation": {"chat": {"id": 5, "type": "private"}, "draft_id": 424242}},
    ]));
    let got = next(&ch).await;
    assert_eq!(got.len(), 1, "a stranger's Stop is dropped");
    assert_eq!(got[0].kind, InKind::Stop);
    assert_eq!(got[0].chat, chat(5));
    assert!(got[0].from_owner);
    assert_eq!(
        saved_offset(&store),
        Some(106),
        "a Stop is finished at once"
    );
}

#[tokio::test]
async fn offset_survives_restart_without_replay() {
    let fake = Fake::start().await;
    let store = store_with_owners(&[5, 6]);
    let ch = fake.channel(&store, cache("offset"));
    fake.batch(json!([
        message(200, 5, json!({"text": "one"})),
        message(201, 6, json!({"text": "two"})),
    ]));
    assert_eq!(next(&ch).await.len(), 2);
    assert_eq!(
        saved_offset(&store),
        Some(200),
        "both started, none finished"
    );
    ch.send(&chat(6), &plain("done")).await.unwrap();
    assert_eq!(saved_offset(&store), Some(200), "200 is still unfinished");
    drop(ch);

    let polls_before = fake.seen("getUpdates").len();
    let ch = fake.channel(&store, cache("offset"));
    fake.batch(json!([
        message(200, 5, json!({"text": "one"})),
        message(201, 6, json!({"text": "two"})),
    ]));
    assert_eq!(next(&ch).await.len(), 2);
    let polls = fake.seen("getUpdates");
    assert_eq!(
        polls[polls_before].json()["offset"],
        200,
        "restart asks for the unfinished one"
    );
    ch.send(&chat(5), &plain("done")).await.unwrap();
    ch.send(&chat(6), &plain("done")).await.unwrap();
    assert_eq!(saved_offset(&store), Some(202), "all finished: newest + 1");
}

/// Starts `ask` in a task and waits for its question to reach the fake.
async fn asking(
    fake: &Fake,
    ch: &Arc<Telegram>,
    cancel: CancellationToken,
) -> (
    tokio::task::JoinHandle<alexia_gateway::Result<Option<bool>>>,
    Value,
) {
    let c = ch.clone();
    let task = tokio::spawn(async move { c.ask(&chat(5), "Delete it?", cancel).await });
    let sent = fake.until("sendMessage", 1).await;
    (task, sent[0].json())
}

/// A button press on the question message 77 in chat 5.
fn press(update: i64, user: i64, data: &str) -> Value {
    json!({"update_id": update, "callback_query": {
        "id": format!("cb{update}"),
        "from": {"id": user, "is_bot": false, "first_name": "U"},
        "chat_instance": "ci",
        "message": {"message_id": 77, "date": 1, "chat": {"id": 5, "type": "private"}, "text": "Delete it?"},
        "data": data,
    }})
}

/// Keeps `next()` polling in the background, as the gateway does.
fn polling(ch: &Arc<Telegram>) -> CancellationToken {
    let cancel = CancellationToken::new();
    let (c, stop) = (ch.clone(), cancel.clone());
    tokio::spawn(async move { while c.next(stop.clone()).await.is_ok() {} });
    cancel
}

#[tokio::test]
async fn ask_resolves_on_owner_press() {
    let fake = Fake::start().await;
    let store = store_with_owners(&[5]);
    let ch = fake.channel(&store, cache("ask-yes"));
    let poll = polling(&ch);
    let (task, question) = asking(&fake, &ch, CancellationToken::new()).await;
    assert_eq!(question["text"], "Delete it?");
    let row = &question["reply_markup"]["inline_keyboard"][0];
    assert_eq!(row[0]["text"], "Approve");
    assert_eq!(row[1]["text"], "Deny");
    let yes = row[0]["callback_data"].as_str().unwrap().to_owned();
    assert!(yes.starts_with("y:"));
    fake.batch(json!([press(300, 5, &yes)]));
    let got = tokio::time::timeout(WAIT, task).await.unwrap().unwrap();
    assert_eq!(got.unwrap(), Some(true));
    assert_eq!(
        fake.until("answerCallbackQuery", 1).await[0].json()["callback_query_id"],
        "cb300"
    );
    fake.until("editMessageReplyMarkup", 1).await;
    let edit = fake.until("editMessageText", 1).await[0].json();
    assert_eq!(edit["text"], "Delete it? — approved");
    poll.cancel();
}

#[tokio::test]
async fn ask_ignores_non_owner() {
    let fake = Fake::start().await;
    let store = store_with_owners(&[5]);
    let ch = fake.channel(&store, cache("ask-stranger"));
    let poll = polling(&ch);
    let (task, question) = asking(&fake, &ch, CancellationToken::new()).await;
    let row = &question["reply_markup"]["inline_keyboard"][0];
    let yes = row[0]["callback_data"].as_str().unwrap().to_owned();
    let no = row[1]["callback_data"].as_str().unwrap().to_owned();
    fake.batch(json!([press(300, 9, &yes)]));
    let answered = fake.until("answerCallbackQuery", 1).await[0].json();
    assert_eq!(answered["text"], "Only the owner can answer this.");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!task.is_finished(), "a stranger's press decides nothing");
    assert!(fake.seen("editMessageText").is_empty());
    fake.batch(json!([press(301, 5, &no)]));
    let got = tokio::time::timeout(WAIT, task).await.unwrap().unwrap();
    assert_eq!(got.unwrap(), Some(false));
    let edit = fake.until("editMessageText", 1).await[0].json();
    assert_eq!(edit["text"], "Delete it? — denied");
    poll.cancel();
}

#[tokio::test]
async fn ask_cancel_is_none() {
    let fake = Fake::start().await;
    let store = store_with_owners(&[5]);
    let ch = fake.channel(&store, cache("ask-cancel"));
    let cancel = CancellationToken::new();
    let (task, _) = asking(&fake, &ch, cancel.clone()).await;
    cancel.cancel();
    let got = tokio::time::timeout(WAIT, task).await.unwrap().unwrap();
    assert_eq!(got.unwrap(), None);
    let removed = fake.until("editMessageReplyMarkup", 1).await[0].json();
    assert_eq!(removed["message_id"], 77);
    assert_eq!(removed["reply_markup"]["inline_keyboard"], json!([]));
}

#[tokio::test]
async fn long_text_is_split() {
    let fake = Fake::start().await;
    let store = store_with_owners(&[5]);
    let ch = fake.channel(&store, cache("long"));
    let text = "abcd ".repeat(1800);
    assert_eq!(text.chars().count(), 9000);
    let id = ch.send(&chat(5), &plain(&text)).await.unwrap();
    assert_eq!(id.id, "77");
    let sent = fake.seen("sendMessage");
    assert_eq!(sent.len(), 3);
    let mut letters = 0;
    for s in &sent {
        let part = s.json()["text"].as_str().unwrap().to_owned();
        assert!(part.encode_utf16().count() <= 4096, "{}", part.len());
        assert!(part.ends_with("abcd"), "split on a word boundary");
        letters += part.chars().filter(|c| *c != ' ').count();
    }
    assert_eq!(letters, 7200, "nothing lost");
}

#[tokio::test]
async fn draft_keeps_one_id_per_reply_and_shows_the_tail() {
    let fake = Fake::start().await;
    let store = store_with_owners(&[5]);
    let ch = fake.channel(&store, cache("draft"));
    ch.draft(&chat(5), Some("Hel")).await.unwrap();
    let long = format!("{}{}", "x".repeat(5000), "END");
    ch.draft(&chat(5), Some(&long)).await.unwrap();
    ch.draft(&chat(5), None).await.unwrap();
    ch.draft(&chat(5), Some("Next")).await.unwrap();
    let drafts: Vec<Value> = fake
        .seen("sendMessageDraft")
        .iter()
        .map(Seen::json)
        .collect();
    assert_eq!(drafts.len(), 3, "None sends nothing");
    assert_eq!(drafts[0]["draft_id"], drafts[1]["draft_id"]);
    assert_ne!(
        drafts[1]["draft_id"], drafts[2]["draft_id"],
        "a new reply, a new id"
    );
    assert_eq!(drafts[0]["can_stop"], true);
    let tail = drafts[1]["text"].as_str().unwrap();
    assert_eq!(tail.chars().count(), 4096);
    assert!(tail.ends_with("END"));
}

#[tokio::test]
async fn conflict_backs_off() {
    let fake = Fake::start().await;
    let store = store_with_owners(&[5]);
    let ch = fake.channel(&store, cache("conflict"));
    fake.push(
        409,
        json!({"ok": false, "error_code": 409, "description": "Conflict: terminated by other getUpdates request"}),
    );
    let got = next_until(&ch, tokio::time::sleep(Duration::from_secs(3))).await;
    assert!(matches!(got, Err(Error::Cancelled)), "{got:?}");
    assert_eq!(
        fake.seen("getUpdates").len(),
        1,
        "no second poll inside the 10 s back-off"
    );
}

#[tokio::test]
async fn unauthorized_stops_polling() {
    let fake = Fake::start().await;
    let store = store_with_owners(&[5]);
    let ch = fake.channel(&store, cache("refused"));
    fake.push(
        401,
        json!({"ok": false, "error_code": 401, "description": "Unauthorized"}),
    );
    let got = tokio::time::timeout(WAIT, ch.next(CancellationToken::new())).await;
    assert!(matches!(got, Ok(Err(Error::Unauthorized))), "{got:?}");
    let again = tokio::time::timeout(WAIT, ch.next(CancellationToken::new())).await;
    assert!(matches!(again, Ok(Err(Error::Unauthorized))));
    assert_eq!(fake.seen("getUpdates").len(), 1, "polling stopped");
}

/// The in-memory secrets map is one per process: tests that touch it take turns.
fn secrets_lock() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    let guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::env::set_var(secrets::MEMORY_BACKEND_ENV, "1");
    guard
}

#[test]
fn configured_is_empty_without_token() {
    let _lock = secrets_lock();
    secrets::delete("_core", "telegram_bot_token").unwrap();
    let layout = Layout::new(cache("configured-none"));
    let store = store_with_owners(&[]);
    assert!(configured(store.clone(), &layout).is_empty());
    assert!(pairing_codes(&store).unwrap().is_empty());
}

#[test]
fn configured_has_one_with_token() {
    let _lock = secrets_lock();
    assert_eq!(secret_keys(), &["telegram_bot_token"]);
    secrets::set("_core", "telegram_bot_token", &token()).unwrap();
    let layout = Layout::new(cache("configured-one"));
    let got = configured(store_with_owners(&[]), &layout);
    secrets::delete("_core", "telegram_bot_token").unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].name(), "telegram");
}

#[test]
fn pairing_codes_lists_unpaired_only() {
    let _lock = secrets_lock();
    secrets::set("_core", "telegram_bot_token", &token()).unwrap();
    let unpaired = store_with_owners(&[]);
    let paired = store_with_owners(&[5]);
    let codes = pairing_codes(&unpaired);
    let none = pairing_codes(&paired);
    secrets::delete("_core", "telegram_bot_token").unwrap();
    let codes = codes.unwrap();
    assert_eq!(codes.len(), 1);
    assert_eq!(codes[0].0, "telegram");
    let kept = unpaired.kv_get("_core", "telegram_pairing_code").unwrap();
    assert_eq!(
        kept,
        Some(json!(codes[0].1)),
        "the same code the bot expects"
    );
    assert!(none.unwrap().is_empty());
}
