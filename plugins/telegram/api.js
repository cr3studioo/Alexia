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
    // a keyboard impossible rather than merely absent (M7-5).
    { offset, timeout: seconds, allowed_updates: ['message', 'callback_query'] },
    signal,
  )

export const send = (token, chatId, text, signal, buttons) =>
  call(
    token,
    'sendMessage',
    {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(buttons && { reply_markup: { inline_keyboard: [buttons.map(({ label, data }) => ({ text: label, callback_data: data }))] } }),
    },
    signal,
  )

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

/** Where a file Telegram is holding actually lives, so it can be fetched. */
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
export async function sendVoice(token, chatId, ogg, signal) {
  const form = new FormData()
  form.set('chat_id', String(chatId))
  form.set('voice', new Blob([ogg], { type: 'audio/ogg' }), 'reply.ogg')
  const response = await fetch(`${BASE}${token}/sendVoice`, { method: 'POST', body: form, ...(signal && { signal }) })
  const answer = await response.json().catch(() => ({}))
  if (!response.ok || answer.ok !== true) {
    throw new TelegramError(response.status, answer.description ?? `Telegram answered ${response.status}`)
  }
  return answer.result
}

/**
 * A file a task made, sent on (D122).
 *
 * Two methods, one shape: `sendPhoto` gets the inline preview a picture wants and refuses
 * anything that is not a raster image under 10 MB; `sendDocument` takes anything at all and
 * shows it as an attachment. The caller picks by mime type, and a photo that Telegram
 * rejects falls back to a document rather than not arriving.
 */
async function upload(token, method, field, chatId, bytes, name, caption, signal) {
  const form = new FormData()
  form.set('chat_id', String(chatId))
  form.set(field, new Blob([bytes]), name || 'file')
  if (caption) form.set('caption', String(caption).slice(0, 1024))
  const response = await fetch(`${BASE}${token}/${method}`, { method: 'POST', body: form, ...(signal && { signal }) })
  const answer = await response.json().catch(() => ({}))
  if (!response.ok || answer.ok !== true) {
    throw new TelegramError(response.status, answer.description ?? `Telegram answered ${response.status}`)
  }
  return answer.result
}

export const sendPhoto = (token, chatId, bytes, name, caption, signal) =>
  upload(token, 'sendPhoto', 'photo', chatId, bytes, name, caption, signal)

export const sendDocument = (token, chatId, bytes, name, caption, signal) =>
  upload(token, 'sendDocument', 'document', chatId, bytes, name, caption, signal)

/** Telegram's own cap. A longer answer is split rather than refused by the API mid-sentence. */
export const LIMIT = 4096

export function chunk(text) {
  const parts = []
  let left = String(text)
  while (left.length > LIMIT) {
    // Break on a line if there is one in reach, so a split does not land mid-word.
    const cut = left.lastIndexOf('\n', LIMIT)
    const at = cut > LIMIT / 2 ? cut : LIMIT
    parts.push(left.slice(0, at))
    left = left.slice(at)
  }
  parts.push(left)
  return parts.filter((part) => part.trim() !== '')
}
