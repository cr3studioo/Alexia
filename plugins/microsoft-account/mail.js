// SPDX-License-Identifier: AGPL-3.0-only
import { ArgumentError, toMs } from './calendar.js'
import { GRAPH } from './oauth.js'

/**
 * Outlook mail through Microsoft Graph: request builders and response mappers, pure.
 *
 * **Nothing here can change a message.** Every read is a `GET` with a `$select`; there is no
 * builder for `PATCH` (which is how Graph marks mail read), `move`, `copy` or `DELETE`, and a
 * `GET` never changes `isRead`. A read asks for the body as plain text
 * (`Prefer: outlook.body-content-type="text"`) and strips HTML itself if Graph sends HTML anyway.
 *
 * **The one write is sending** ({@link sendMailRequest}, {@link replyRequest}), and the service
 * builds it only after {@link checkApproval} and the mail desk's `mail.approval` have both
 * passed: a send carries a one-time `approved_draft` token that only the desk's `send_draft`
 * makes, after the owner said yes to that exact message (D214, DY-06). Neither request goes by
 * way of Outlook's Drafts folder.
 */

/** Plain-text characters returned by `mail.read`, at most. */
export const READ_MAX = 20_000

const LIST_SELECT = [
  'id',
  'conversationId',
  'from',
  'toRecipients',
  'subject',
  'bodyPreview',
  'receivedDateTime',
  'isRead',
  'isDraft',
  'importance',
  'flag',
  'categories',
  'parentFolderId',
  'inferenceClassification',
].join(',')

/** The well-known folders whose ids become labels (`INBOX`, `SENT`). */
export const FOLDERS = { inbox: 'INBOX', sentitems: 'SENT' }

/** How many sent messages one list may ask for: the sample the mail desk learns a voice from. */
export const SENT_MAX = 200

const IN_SENT = /(^|\s)in:sent(?=\s|$)/i

/** True for a search of the sent folder (Gmail's words, which the mail desk uses for both). */
export const isSentQuery = (query) => typeof query === 'string' && IN_SENT.test(query)

/**
 * `GET` recent messages. `since` becomes `$filter=receivedDateTime ge …`, newest first. A
 * `query` is Graph's `$search` (KQL: `from:school`, `subject:invoice`, plain words) — Graph
 * will not combine `$search` with `$filter` or `$orderby` on mail, so with both, `since` is
 * applied to the answer instead (the returned `since`).
 *
 * `in:sent` in the query (Gmail's words) reads the SentItems folder instead of every folder,
 * up to {@link SENT_MAX}: the sent-mail sample.
 */
export function listRequest({ since, query, limit } = {}) {
  let sinceMs
  if (since !== undefined && since !== null && since !== '') {
    sinceMs = toMs(since)
    if (sinceMs === undefined) throw new ArgumentError('`since` is not a date or time Alexia understands.')
  }
  const sent = isSentQuery(query)
  const n = Math.min(sent ? SENT_MAX : 50, Math.max(1, Math.floor(Number(limit) || 20)))
  const words = sent ? query.replace(new RegExp(IN_SENT.source, 'gi'), ' ') : query
  const search = typeof words === 'string' ? words.trim().replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim() : ''
  const url = new URL(sent ? `${GRAPH}/me/mailFolders/sentitems/messages` : `${GRAPH}/me/messages`)
  url.searchParams.set('$select', LIST_SELECT)
  url.searchParams.set('$top', String(n))
  if (search !== '') {
    url.searchParams.set('$search', `"${search}"`)
  } else {
    if (sinceMs !== undefined) url.searchParams.set('$filter', `receivedDateTime ge ${new Date(sinceMs).toISOString()}`)
    url.searchParams.set('$orderby', 'receivedDateTime desc')
  }
  return { url: url.toString(), method: 'GET', limit: n, ...(search !== '' && sinceMs !== undefined && { since: sinceMs }) }
}

const idOf = (id) => {
  const text = String(id ?? '').trim()
  // Graph ids are base64: letters, digits, `-`, `_`, `=`, `+`, `/`. Never a dot, so never `..`.
  if (!/^[A-Za-z0-9_=+/-]{1,512}$/.test(text)) throw new ArgumentError('That is not a message id from `mail.list`.')
  return text
}

/** `GET` one message's body, as text; with `headers`, who it is from and what about as well. */
export function readRequest(id, { headers = false } = {}) {
  const url = new URL(`${GRAPH}/me/messages/${encodeURIComponent(idOf(id))}`)
  url.searchParams.set('$select', headers ? 'body,bodyPreview,from,toRecipients,replyTo,subject,conversationId' : 'body,bodyPreview')
  return { url: url.toString(), method: 'GET', headers: { Prefer: 'outlook.body-content-type="text"' } }
}

/** `GET` a well-known folder's id (`inbox`, `sentitems`), so list answers can carry labels. */
export function folderRequest(name) {
  if (!Object.hasOwn(FOLDERS, name)) throw new ArgumentError('Not a folder this plugin reads.')
  const url = new URL(`${GRAPH}/me/mailFolders/${name}`)
  url.searchParams.set('$select', 'id')
  return { url: url.toString(), method: 'GET' }
}

/** A Graph `recipient` as `Name <address>`, or just the address. */
export function addressOf(recipient) {
  const address = typeof recipient?.emailAddress?.address === 'string' ? recipient.emailAddress.address.trim() : ''
  const name = typeof recipient?.emailAddress?.name === 'string' ? recipient.emailAddress.name.trim() : ''
  if (address === '') return name
  return name !== '' && name.toLowerCase() !== address.toLowerCase() ? `${name} <${address}>` : address
}

/**
 * One message in the INTERFACES shape. `folders` maps a folder id to a label (`INBOX`, `SENT`).
 * `labels` holds what Gmail would call one: `UNREAD`, the folder, `DRAFT`, `IMPORTANT` (high
 * importance), `FLAGGED`, `OTHER` (outside the Focused inbox), then the message's categories.
 */
export function mapMessage(msg, folders = {}) {
  const unread = msg?.isRead === false
  const at = Date.parse(String(msg?.receivedDateTime ?? ''))
  const labels = [
    ...(unread ? ['UNREAD'] : []),
    ...(typeof folders[msg?.parentFolderId] === 'string' ? [folders[msg.parentFolderId]] : []),
    ...(msg?.isDraft === true ? ['DRAFT'] : []),
    ...(msg?.importance === 'high' ? ['IMPORTANT'] : []),
    ...(msg?.flag?.flagStatus === 'flagged' ? ['FLAGGED'] : []),
    ...(msg?.inferenceClassification === 'other' ? ['OTHER'] : []),
    ...(Array.isArray(msg?.categories) ? msg.categories.filter((c) => typeof c === 'string' && c.trim() !== '') : []),
  ]
  return {
    id: String(msg?.id ?? ''),
    threadId: String(msg?.conversationId ?? ''),
    from: addressOf(msg?.from),
    to: (Array.isArray(msg?.toRecipients) ? msg.toRecipients : []).map(addressOf).filter(Boolean).join(', '),
    subject: typeof msg?.subject === 'string' ? msg.subject : '',
    snippet: typeof msg?.bodyPreview === 'string' ? msg.bodyPreview.replace(/\s+/g, ' ').trim() : '',
    at: Number.isFinite(at) ? at : 0,
    unread,
    labels: [...new Set(labels)],
  }
}

/** Every message in a `messages` answer, mapped; with `since`, only those received after it. */
export function mapMessages(json, folders = {}, since = undefined) {
  const all = (Array.isArray(json?.value) ? json.value : []).map((m) => mapMessage(m, folders)).filter((m) => m.id !== '')
  return since === undefined ? all : all.filter((m) => m.at >= since)
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

/**
 * **The text of a message**: its body when Graph sent text, stripped when it sent HTML, the
 * preview when there is no body. Capped at {@link READ_MAX} characters.
 */
export function messageText(msg) {
  const content = typeof msg?.body?.content === 'string' ? msg.body.content : ''
  const type = String(msg?.body?.contentType ?? 'text').toLowerCase()
  const body = type === 'html' ? stripHtml(content) : content.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  const text = body === '' ? String(msg?.bodyPreview ?? '').trim() : body
  return text.length > READ_MAX ? `${text.slice(0, READ_MAX)}…` : text
}

/** The headers of a read message a reply needs, in the same shape the Gmail plugin gives. */
export function readHeaders(msg) {
  const replyTo = (Array.isArray(msg?.replyTo) ? msg.replyTo : []).map(addressOf).filter(Boolean).join(', ')
  return {
    from: addressOf(msg?.from),
    to: (Array.isArray(msg?.toRecipients) ? msg.toRecipients : []).map(addressOf).filter(Boolean).join(', '),
    subject: typeof msg?.subject === 'string' ? msg.subject : '',
    threadId: String(msg?.conversationId ?? ''),
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

const toRecipients = (addresses) => addresses.map((address) => ({ emailAddress: { address } }))

/** `POST /me/sendMail`: a new plain-text message, kept in Sent Items, never in Drafts. */
export function sendMailRequest({ to, subject, text }) {
  return {
    url: `${GRAPH}/me/sendMail`,
    method: 'POST',
    body: {
      message: { subject: subjectOf(subject), body: { contentType: 'Text', content: String(text ?? '') }, toRecipients: toRecipients(recipients(to)) },
      saveToSentItems: true,
    },
  }
}

/**
 * `POST /me/messages/<id>/reply`: an answer that threads under the original. Graph writes the
 * subject (`RE: …`) and quotes the original under `comment`, which is the owner's text.
 */
export function replyRequest(id, { to, text }) {
  return {
    url: `${GRAPH}/me/messages/${encodeURIComponent(idOf(id))}/reply`,
    method: 'POST',
    body: { message: { toRecipients: toRecipients(recipients(to)) }, comment: String(text ?? '') },
  }
}
