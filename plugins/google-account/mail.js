// SPDX-License-Identifier: AGPL-3.0-only
import { ArgumentError, toMs } from './calendar.js'

/**
 * Gmail: request builders and response mappers, pure.
 *
 * **Nothing here can change a message.** Every read is a `GET` on `messages` or
 * `messages/<id>`; there is no builder for `modify`, `trash` or `batchModify`, and reading a
 * message through the API never marks it read (only `modify` removing `UNREAD` does). Lists use
 * `format=metadata`, a read uses `format=full` and prefers the `text/plain` part.
 *
 * **The one write is {@link sendRequest}**, and the service builds it only after
 * {@link checkApproval} and the mail desk's `mail.approval` have both passed: a send carries a
 * one-time `approved_draft` token that only the desk's `send_draft` makes, after the owner said
 * yes to that exact message (D214, DY-06). Nothing is ever put in Gmail's drafts.
 */

export const API = 'https://gmail.googleapis.com/gmail/v1/users/me'

/** Plain-text characters returned by `mail.read`, at most. */
export const READ_MAX = 20_000

const HEADERS = ['From', 'To', 'Subject', 'Date']

/** How many sent messages one list may ask for: the sample the mail desk learns a voice from. */
export const SENT_MAX = 200

/** True for a search of the sent folder, which may list up to {@link SENT_MAX}. */
export const isSentQuery = (query) => typeof query === 'string' && /(^|\s)in:sent(\s|$)/i.test(query)

/**
 * `GET` the ids matching a search. `since` becomes Gmail's `after:` (whole seconds). At most 50,
 * or {@link SENT_MAX} for an `in:sent` search (the sent-mail sample).
 */
export function listRequest({ since, query, limit } = {}) {
  const terms = []
  if (typeof query === 'string' && query.trim() !== '') terms.push(query.trim())
  if (since !== undefined && since !== null && since !== '') {
    const ms = toMs(since)
    if (ms === undefined) throw new ArgumentError('`since` is not a date or time Alexia understands.')
    terms.push(`after:${Math.floor(ms / 1000)}`)
  }
  const n = Math.min(isSentQuery(query) ? SENT_MAX : 50, Math.max(1, Math.floor(Number(limit) || 20)))
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

export const header = (payload, name) => {
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
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
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

/** The headers of a full message a reply needs: who it is from, who to answer, what about. */
export function readHeaders(msg) {
  const replyTo = header(msg?.payload, 'Reply-To')
  return {
    from: header(msg?.payload, 'From'),
    to: header(msg?.payload, 'To'),
    subject: header(msg?.payload, 'Subject'),
    threadId: String(msg?.threadId ?? ''),
    ...(replyTo !== '' && { reply_to: replyTo }),
  }
}

// --- Sending ------------------------------------------------------------------------------------

/** What every send without the owner's yes answers, word for word (P3-24). */
export const NEEDS_YES = 'Sending needs your yes on the draft first.'

/** How long a yes stays good. The mail desk keeps its token exactly as long. */
export const APPROVAL_MS = 60_000

/** `<issued at, epoch ms>.<32 base64url characters>`, as `send_draft` makes it. */
const TOKEN = /^(\d{13})\.([A-Za-z0-9_-]{32})$/

/**
 * **The local half of the token check**: is this shaped like a yes, from the last minute, and
 * not one this process already spent? Returns a refusal sentence, or `undefined` when the token
 * may go on to the mail desk (`mail.approval`), which alone knows whether the owner said it.
 */
export function checkApproval(token, { now, used }) {
  if (typeof token !== 'string' || token === '') return NEEDS_YES
  const m = TOKEN.exec(token)
  if (!m) return NEEDS_YES
  const issued = Number(m[1])
  // A few seconds of skew between two processes' clocks is not a reason to refuse.
  if (issued > now + 5_000) return NEEDS_YES
  if (now - issued > APPROVAL_MS) return `That yes ran out after a minute. ${NEEDS_YES}`
  if (used.has(token)) return `That yes was already used. ${NEEDS_YES}`
  return undefined
}

/** Spent tokens past their minute can be forgotten: the clock refuses them anyway. */
export function pruneUsed(used, now) {
  for (const token of used) {
    const m = TOKEN.exec(token)
    if (!m || now - Number(m[1]) > APPROVAL_MS + 5_000) used.delete(token)
  }
}

const ADDRESS = /^[^\s@<>",;:()[\]\\]+@[^\s@<>",;:()[\]\\]+\.[^\s@<>",;:()[\]\\]+$/

/** The bare address in `Name <address>` or `address`. */
export function bareAddress(text) {
  const s = String(text ?? '').trim()
  const angled = /<([^<>]*)>\s*$/.exec(s)
  return (angled ? angled[1] : s).trim()
}

/**
 * The recipients of a send: a comma-separated string or a list, each `Name <address>` or a bare
 * address. Every one must look like a real address; at most 20.
 */
export function recipients(to) {
  const list = (Array.isArray(to) ? to : String(to ?? '').split(','))
    .map((t) => String(t ?? '').trim())
    .filter(Boolean)
  if (list.length === 0) throw new ArgumentError('Who should it go to? `to` is empty.')
  if (list.length > 20) throw new ArgumentError('That is more than 20 recipients.')
  return list.map((item) => {
    if (/[\r\n]/.test(item)) throw new ArgumentError('An address cannot hold a line break.')
    const address = bareAddress(item)
    if (!ADDRESS.test(address)) throw new ArgumentError(`“${address}” is not an email address.`)
    return address
  })
}

/** The subject: one line. */
export function subjectOf(subject) {
  const s = String(subject ?? '')
  if (/[\r\n]/.test(s)) throw new ArgumentError('A subject is one line.')
  return s.trim()
}

/** RFC 2047 for a header that is not plain ASCII, in encoded words short enough for any reader. */
export function encodeHeader(value) {
  if (/^[\x20-\x7e]*$/.test(value)) return value
  const chars = [...value]
  const words = []
  for (let i = 0; i < chars.length; i += 15) {
    words.push(`=?UTF-8?B?${Buffer.from(chars.slice(i, i + 15).join(''), 'utf8').toString('base64')}?=`)
  }
  return words.join('\r\n ')
}

const oneLine = (v) => (typeof v === 'string' && /^[^\r\n]+$/.test(v.trim()) ? v.trim() : '')

/**
 * **One plain-text message**, RFC 5322, as Gmail's `raw` wants it. `inReplyTo` and `references`
 * (the original's `Message-ID` and `References`) make Gmail and every other client thread it.
 */
export function rawMessage({ to, subject, text, inReplyTo, references }) {
  const body = Buffer.from(String(text ?? '').replace(/\r?\n/g, '\r\n'), 'utf8')
    .toString('base64')
    .replace(/.{1,76}/g, '$&\r\n')
  const lines = [
    `To: ${recipients(to).join(', ')}`,
    `Subject: ${encodeHeader(subjectOf(subject))}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ]
  if (oneLine(inReplyTo)) lines.push(`In-Reply-To: ${oneLine(inReplyTo)}`)
  const refs = [oneLine(references), oneLine(inReplyTo)].filter(Boolean).join(' ')
  if (refs) lines.push(`References: ${refs}`)
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n${body}`, 'utf8').toString('base64url')
}

/** `GET` the headers of the message being answered, so the reply threads under it. */
export function replyHeadersRequest(id) {
  const url = new URL(`${API}/messages/${idOf(id)}`)
  url.searchParams.set('format', 'metadata')
  for (const h of ['Message-ID', 'References']) url.searchParams.append('metadataHeaders', h)
  return { url: url.toString(), method: 'GET' }
}

/** `POST messages/send`: the only request in this plugin that sends mail. */
export function sendRequest({ raw, threadId }) {
  return { url: `${API}/messages/send`, method: 'POST', body: { raw, ...(threadId && { threadId }) } }
}
