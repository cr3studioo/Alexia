// SPDX-License-Identifier: AGPL-3.0-only
import { ArgumentError, toMs } from './calendar.js'

/**
 * Gmail, read only: request builders and response mappers, pure.
 *
 * **Nothing here can change a message.** Every request is a `GET` on `messages` or
 * `messages/<id>`; there is no builder for `modify`, `trash` or `batchModify`, and reading a
 * message through the API never marks it read (only `modify` removing `UNREAD` does). Lists use
 * `format=metadata`, a read uses `format=full` and prefers the `text/plain` part.
 */

export const API = 'https://gmail.googleapis.com/gmail/v1/users/me'

/** Plain-text characters returned by `mail.read`, at most. */
export const READ_MAX = 20_000

const HEADERS = ['From', 'To', 'Subject', 'Date']

/** `GET` the ids matching a search. `since` becomes Gmail's `after:` (whole seconds). */
export function listRequest({ since, query, limit } = {}) {
  const terms = []
  if (typeof query === 'string' && query.trim() !== '') terms.push(query.trim())
  if (since !== undefined && since !== null && since !== '') {
    const ms = toMs(since)
    if (ms === undefined) throw new ArgumentError('`since` is not a date or time Alexia understands.')
    terms.push(`after:${Math.floor(ms / 1000)}`)
  }
  const n = Math.min(50, Math.max(1, Math.floor(Number(limit) || 20)))
  const url = new URL(`${API}/messages`)
  url.searchParams.set('maxResults', String(n))
  if (terms.length > 0) url.searchParams.set('q', terms.join(' '))
  return { url: url.toString(), method: 'GET', limit: n }
}

const idOf = (id) => {
  const text = String(id ?? '').trim()
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new ArgumentError('That is not a message id from `mail.list`.')
  return text
}

/** `GET` one message's headers, labels and snippet. */
export function metadataRequest(id) {
  const url = new URL(`${API}/messages/${idOf(id)}`)
  url.searchParams.set('format', 'metadata')
  for (const h of HEADERS) url.searchParams.append('metadataHeaders', h)
  return { url: url.toString(), method: 'GET' }
}

/** `GET` one whole message. */
export function readRequest(id) {
  const url = new URL(`${API}/messages/${idOf(id)}`)
  url.searchParams.set('format', 'full')
  return { url: url.toString(), method: 'GET' }
}

/** The ids in a `messages.list` answer. */
export const listedIds = (json) =>
  (Array.isArray(json?.messages) ? json.messages : []).map((m) => m?.id).filter((id) => typeof id === 'string')

const header = (payload, name) => {
  const found = (Array.isArray(payload?.headers) ? payload.headers : []).find(
    (h) => typeof h?.name === 'string' && h.name.toLowerCase() === name.toLowerCase(),
  )
  return typeof found?.value === 'string' ? found.value : ''
}

/** One message in the INTERFACES shape. */
export function mapMessage(msg) {
  const labels = Array.isArray(msg?.labelIds) ? msg.labelIds.filter((l) => typeof l === 'string') : []
  const internal = Number(msg?.internalDate)
  const dated = Date.parse(header(msg?.payload, 'Date'))
  return {
    id: String(msg?.id ?? ''),
    threadId: String(msg?.threadId ?? ''),
    from: header(msg?.payload, 'From'),
    to: header(msg?.payload, 'To'),
    subject: header(msg?.payload, 'Subject'),
    snippet: decodeEntities(String(msg?.snippet ?? '')),
    at: Number.isFinite(internal) && internal > 0 ? internal : Number.isFinite(dated) ? dated : 0,
    unread: labels.includes('UNREAD'),
    labels,
  }
}

/** One readable line per message. */
export const messageLine = (m) =>
  `- ${m.unread ? '● ' : ''}${m.at ? new Date(m.at).toISOString().slice(0, 16).replace('T', ' ') : ''} ${m.from}: ${m.subject || '(no subject)'} [${m.id}]`

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

/** The common HTML entities, numeric ones included. */
export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name) => {
    const lower = name.toLowerCase()
    if (lower.startsWith('#x')) return safeChar(parseInt(lower.slice(2), 16), whole)
    if (lower.startsWith('#')) return safeChar(parseInt(lower.slice(1), 10), whole)
    return NAMED[lower] ?? whole
  })
}

const safeChar = (code, fallback) => {
  try {
    return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : fallback
  } catch {
    return fallback
  }
}

/**
 * **HTML to plain text.** Scripts, styles and the head go entirely; block ends become line
 * breaks; every other tag goes; entities are decoded; runs of blank lines collapse.
 */
export function stripHtml(html) {
  const text = String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table|section|article)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]*>/g, '')
  return decodeEntities(text)
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const decodePart = (data) => {
  if (typeof data !== 'string' || data === '') return ''
  return Buffer.from(data, 'base64url').toString('utf8')
}

/** Every leaf part, depth first. */
function leaves(part, out = []) {
  if (!part || typeof part !== 'object') return out
  if (Array.isArray(part.parts) && part.parts.length > 0) {
    for (const p of part.parts) leaves(p, out)
  } else {
    out.push(part)
  }
  return out
}

/**
 * **The text of a full message**: its `text/plain` parts when there are any, otherwise its
 * `text/html` parts stripped. Attachments (parts with a filename) are skipped. Capped at
 * {@link READ_MAX} characters.
 */
export function messageText(msg) {
  const parts = leaves(msg?.payload).filter((p) => !(typeof p.filename === 'string' && p.filename !== ''))
  const of = (type) => parts.filter((p) => String(p.mimeType ?? '').toLowerCase() === type).map((p) => decodePart(p.body?.data))
  const plain = of('text/plain').filter((t) => t.trim() !== '')
  const body =
    plain.length > 0 ? plain.join('\n\n').replace(/\r\n/g, '\n').trim() : of('text/html').map(stripHtml).filter(Boolean).join('\n\n')
  const text = body === '' ? decodeEntities(String(msg?.snippet ?? '')) : body
  return text.length > READ_MAX ? `${text.slice(0, READ_MAX)}…` : text
}
