// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Telegram Bot API, the two calls this needs.
 *
 * ponytail: no grammY. The plan named it and it earns its place at about a dozen API
 * surfaces — middleware, sessions, scenes, keyboards. This uses `getUpdates` and
 * `sendMessage`, which is forty lines of `fetch`, and a long-polling loop somebody can
 * read in one sitting is worth more here than a framework's reconnect semantics. The day
 * this wants inline keyboards or file uploads, grammY is the sanctioned replacement.
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
  call(token, 'getUpdates', { offset, timeout: seconds, allowed_updates: ['message'] }, signal)

export const send = (token, chatId, text, signal) =>
  call(token, 'sendMessage', { chat_id: chatId, text, disable_web_page_preview: true }, signal)

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
