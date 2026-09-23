// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Telegram Bot API, the two calls this needs.
 *
 * ponytail: no grammY. The plan named it and it earns its place at about a dozen API
 * surfaces — middleware, sessions, scenes, keyboards. This uses `getUpdates` and
 * `sendMessage`, which is forty lines of `fetch`, and a long-polling loop somebody can
 * read in one sitting is worth more here than a framework's reconnect semantics. The day
 * this wants inline keyboards or file uploads, grammY is the sanctioned replacement.
 *
 * **M7-5 wanted a keyboard and D122 wanted an upload, and it is still not grammY**, which is
 * worth writing down rather than quietly not doing: a keyboard is one extra field on
 * `sendMessage`, a press is one extra `allowed_updates` entry, and an upload is a `FormData`.
 * Eight calls rather than two. The sanction stands and the day it is taken will be a day this
 * file is doing something a framework is better at than eighty lines of `fetch`, which it is
 * not yet.
 *
 * D192 made it ten — *typing…* is one `call` — and that sentence still holds.
 *
 * **D194 adds `extra`, which is the one shape decision in this file.** Threading a reply,
 * formatting one, and whatever Telegram adds next are all *one more field on the same call*,
 * and a positional argument each would be four more slots nobody can read at the call site.
 * So every send takes an optional object that is spread into the body as it stands. It is a
 * deliberately thin place: this file does not know what `reply_parameters` means, only that
 * the caller wants it sent, which keeps the knowledge of *why* next to the answer it belongs
 * to rather than smeared across the transport.
 */

const BASE = 'https://api.telegram.org/bot'

export class TelegramError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

async function call(token, method, body, signal) {
  const response = await fetch(`${BASE}${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    ...(signal && { signal }),
  })
  const answered = await response.json().catch(() => ({}))
  if (!response.ok || answered.ok !== true) {
    // Telegram's own sentence when there is one: `401 Unauthorized` for a bad token is the
    // single most likely failure and the user is the only one who can fix it.
    throw new TelegramError(response.status, answered.description ?? `Telegram answered ${response.status}`)
  }
  return answered.result
}

/** Who this bot is. The cheapest possible check that a token is real, used at startup. */
export const me = (token, signal) => call(token, 'getMe', {}, signal)

/**
 * Long polling. One request that Telegram holds open until something arrives or `timeout`
 * seconds pass — no webhook, no port, no firewall dialog, which is the whole reason this
 * shape was chosen over the other one.
 *
 * `offset` is the acknowledgement: asking for `last + 1` is what tells Telegram the
 * previous batch was handled. Get that wrong and every restart replays the backlog.
 */
export const updates = (token, offset, seconds, signal) =>
  call(
    token,
    'getUpdates',
    // Button presses arrive as their own update kind. Asking for messages only is what made
    // a keyboard impossible rather than merely absent (M7-5). `stopped_message_generation` is
    // the Stop button on a draft, which is the same stop `/stop` is (D195) — and a kind left
    // off this list is one Telegram never sends, so the button would simply do nothing.
    { offset, timeout: seconds, allowed_updates: ['message', 'callback_query', 'stopped_message_generation'] },
    signal,
  )

export const send = (token, chatId, text, signal, buttons, extra) =>
  call(
    token,
    'sendMessage',
    {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(buttons && { reply_markup: { inline_keyboard: [buttons.map(({ label, data }) => ({ text: label, callback_data: data }))] } }),
      ...extra,
    },
    signal,
  )

/**
 * The same message, rendered (D194).
 *
 * `sendRichMessage` takes real Markdown — bold, lists, tables, a fenced code block — and
 * renders it, where `sendMessage` shows the asterisks. It is what a model has been writing all
 * along and what a chat window has always shown; the phone was the one place it arrived as
 * source. What goes in has been through `forRich()` first, because Telegram's servers fetch a
 * Markdown image's URL and a model's Markdown is not always the model's idea.
 *
 * Newer than most of this file, so the caller has to survive its absence: a Bot API that does
 * not have it answers 404, and `say()` in `index.js` stops asking for the rest of the session.
 */
export const sendRich = (token, chatId, markdown, extra, signal) =>
  call(token, 'sendRichMessage', { chat_id: chatId, rich_message: { markdown }, ...extra }, signal)

/**
 * The answer while it is still being written, as Telegram's own draft (D195).
 *
 * A draft is not a message: it is the line the chat shows where a message is being composed,
 * it belongs to this bot in this chat, and **it expires after about thirty seconds** unless it
 * is sent again. That expiry is the whole reason this is a draft rather than one message
 * edited over and over — an edit per delta is an edit Telegram rate-limits and a notification
 * per word on somebody's phone, while a draft that is never finished simply vanishes, which is
 * exactly the right behaviour for words that were never an answer.
 *
 * `can_stop` is what puts the Stop button on it, and pressing that button sends a
 * `stopped_message_generation` update carrying the same `draft_id` this call chose. Two
 * methods, the same shape, for the same reason `sendMessage` and `sendRichMessage` are two:
 * one renders Markdown and the older one does not.
 */
export const sendDraft = (token, chatId, draftId, text, canStop, signal) =>
  call(
    token,
    'sendMessageDraft',
    { chat_id: chatId, draft_id: draftId, text, ...(canStop && { can_stop: true }) },
    signal,
  )

export const sendRichDraft = (token, chatId, draftId, markdown, canStop, signal) =>
  call(
    token,
    'sendRichMessageDraft',
    { chat_id: chatId, draft_id: draftId, rich_message: { markdown }, ...(canStop && { can_stop: true }) },
    signal,
  )

/**
 * The list behind the *"/"* button in the chat (D195).
 *
 * `all_private_chats` rather than the default scope, which is *every* chat including groups a
 * bot has been added to: this plugin answers one paired account in a private chat, and a menu
 * offering Alexia's commands to a group it happens to be in would be offering something it
 * will refuse. Telegram replaces the whole list each time, so this is the only call — there is
 * nothing to remove first, and a list built from core's own commands cannot drift out of step
 * by being appended to.
 */
export const setMyCommands = (token, commands, scope = { type: 'all_private_chats' }, signal) =>
  call(token, 'setMyCommands', { commands, scope }, signal)

/**
 * Telegram's cap on what a button may carry, and the reason the real action never goes on
 * one: **64 bytes** (M7-5).
 *
 * A length check somebody has to remember is a length check somebody forgets, so the action
 * is not shortened to fit — it never travels. What goes on the button is an opaque token of
 * a fixed size, and the action it stands for is looked up on this side.
 */
export const CALLBACK_LIMIT = 64

/**
 * Acknowledge a press. Telegram shows a spinner on the button until this arrives, so
 * skipping it looks exactly like a bot that has hung.
 */
export const answered = (token, queryId, text, signal) =>
  call(token, 'answerCallbackQuery', { callback_query_id: queryId, ...(text && { text }) }, signal)

/** Take the buttons off a message that has been answered, so it cannot be answered twice. */
export const unbutton = (token, chatId, messageId, signal) =>
  call(token, 'editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }, signal)

/**
 * *Typing…*, *sending photo…*, *recording voice…* — the line under the chat's name while an
 * answer is being made (D192).
 *
 * Telegram shows it for five seconds at most, or until this bot's next message arrives, so one
 * call is one blink. Keeping it up for a whole answer is `presence.js`'s job, not this one's.
 */
export const act = (token, chatId, action, signal) => call(token, 'sendChatAction', { chat_id: chatId, action }, signal)

/** Change the words of a message this bot sent — the status line where drafts do not work (D198). */
export const retext = (token, chatId, messageId, text, signal) =>
  call(token, 'editMessageText', { chat_id: chatId, message_id: messageId, text }, signal)

/** Delete a message this bot sent. */
export const remove = (token, chatId, messageId, signal) =>
  call(token, 'deleteMessage', { chat_id: chatId, message_id: messageId }, signal)

export const filePath = async (token, fileId, signal) => {
  const file = await call(token, 'getFile', { file_id: fileId }, signal)
  return `${BASE}${token}`.replace('/bot', '/file/bot') + `/${file.file_path}`
}

/**
 * A voice bubble rather than a paragraph.
 *
 * `sendVoice` takes Ogg/Opus and nothing else — Telegram plays anything else as a file
 * attachment, which is not what anybody meant by a voice note. So the caller checks the
 * format before reaching this, and there is no conversion here: a converter is ffmpeg, and
 * ffmpeg is a dependency this plugin has managed not to have.
 */
export async function sendVoice(token, chatId, ogg, signal, extra) {
  const form = new FormData()
  form.set('chat_id', String(chatId))
  form.set('voice', new Blob([ogg], { type: 'audio/ogg' }), 'reply.ogg')
  fill(form, extra)
  const response = await fetch(`${BASE}${token}/sendVoice`, { method: 'POST', body: form, ...(signal && { signal }) })
  const answer = await response.json().catch(() => ({}))
  if (!response.ok || answer.ok !== true) {
    throw new TelegramError(response.status, answer.description ?? `Telegram answered ${response.status}`)
  }
  return answer.result
}

/**
 * `extra`, put into a multipart upload rather than a JSON body (D194).
 *
 * The same fields, and Telegram takes them either way — but a form field is a string, so an
 * object like `reply_parameters` goes in as its JSON text. Telegram's own documentation says
 * to do exactly this, and it is the one line of difference between the two kinds of send.
 */
function fill(form, extra) {
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value === undefined) continue
    form.set(key, typeof value === 'string' ? value : JSON.stringify(value))
  }
}

/**
 * A file a task made, sent on (D122).
 *
 * Two methods, one shape: `sendPhoto` gets the inline preview a picture wants and refuses
 * anything that is not a raster image under 10 MB; `sendDocument` takes anything at all and
 * shows it as an attachment. The caller picks by mime type, and a photo that Telegram
 * rejects falls back to a document rather than not arriving.
 */
async function upload(token, method, field, chatId, bytes, name, caption, signal, extra) {
  const form = new FormData()
  form.set('chat_id', String(chatId))
  form.set(field, new Blob([bytes]), name || 'file')
  if (caption) form.set('caption', String(caption).slice(0, 1024))
  fill(form, extra)
  const response = await fetch(`${BASE}${token}/${method}`, { method: 'POST', body: form, ...(signal && { signal }) })
  const answer = await response.json().catch(() => ({}))
  if (!response.ok || answer.ok !== true) {
    throw new TelegramError(response.status, answer.description ?? `Telegram answered ${response.status}`)
  }
  return answer.result
}

export const sendPhoto = (token, chatId, bytes, name, caption, signal, extra) =>
  upload(token, 'sendPhoto', 'photo', chatId, bytes, name, caption, signal, extra)

export const sendDocument = (token, chatId, bytes, name, caption, signal, extra) =>
  upload(token, 'sendDocument', 'document', chatId, bytes, name, caption, signal, extra)

/** Telegram's own cap. A longer answer is split rather than refused by the API mid-sentence. */
export const LIMIT = 4096

/**
 * Split at whatever this particular call is capped at.
 *
 * A plain `sendMessage` refuses anything over 4096 characters; a rich message takes 32768
 * (`RICH_LIMIT` in `format.js`). Same splitting, eight times the room — so the limit is an
 * argument rather than a second copy of this function, and a rich answer that would have been
 * cut into eight bubbles arrives as one (D194).
 */
export function chunk(text, limit = LIMIT) {
  const parts = []
  let left = String(text)
  while (left.length > limit) {
    // Break on a line if there is one in reach, so a split does not land mid-word.
    const cut = left.lastIndexOf('\n', limit)
    const at = cut > limit / 2 ? cut : limit
    parts.push(left.slice(0, at))
    left = left.slice(at)
  }
  parts.push(left)
  return parts.filter((part) => part.trim() !== '')
}
