// SPDX-License-Identifier: AGPL-3.0-only
import { ArgumentError, toMs } from './calendar.js'
import { GRAPH } from './oauth.js'

/**
 * Outlook mail through Microsoft Graph, **read only**: request builders and response mappers,
 * pure.
 *
 * **Nothing here can change a message.** Every request is a `GET` with a `$select`; there is no
 * builder for `PATCH` (which is how Graph marks mail read), `move`, `copy` or `DELETE`, and a
 * `GET` never changes `isRead`. A read asks for the body as plain text
 * (`Prefer: outlook.body-content-type="text"`) and strips HTML itself if Graph sends HTML anyway.
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

/**
 * `GET` recent messages. `since` becomes `$filter=receivedDateTime ge …`, newest first. A
 * `query` is Graph's `$search` (KQL: `from:school`, `subject:invoice`, plain words) — Graph
 * will not combine `$search` with `$filter` or `$orderby` on mail, so with both, `since` is
 * applied to the answer instead (the returned `since`).
 */
export function listRequest({ since, query, limit } = {}) {
  let sinceMs
  if (since !== undefined && since !== null && since !== '') {
    sinceMs = toMs(since)
    if (sinceMs === undefined) throw new ArgumentError('`since` is not a date or time Alexia understands.')
  }
  const n = Math.min(50, Math.max(1, Math.floor(Number(limit) || 20)))
  const search = typeof query === 'string' ? query.trim().replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim() : ''
  const url = new URL(`${GRAPH}/me/messages`)
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

/** `GET` one message's body, as text. */
export function readRequest(id) {
  const url = new URL(`${GRAPH}/me/messages/${encodeURIComponent(idOf(id))}`)
  url.searchParams.set('$select', 'body,bodyPreview')
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
