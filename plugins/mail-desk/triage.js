// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sorting mail. Rules first (they are free and they never get it wrong in a surprising way), then
 * one model call for a batch of whatever the rules left. The model is shown the sender, the
 * subject and the first 500 characters; the rest of a message is not put in the prompt.
 */

export const CLASSES = ['act', 'reply', 'wait', 'read_later', 'noise']

/** The most messages in one model call. */
export const BATCH = 20

/** How much of a message the model may see. */
export const PEEK = 500

/** The lower-cased address inside `Name <a@b.c>` (or the bare text). */
export function addressOf(from) {
  const s = String(from ?? '')
  const angled = /<([^<>]+)>/.exec(s)
  return (angled ? angled[1] : s).trim().toLowerCase()
}

/** The name part of a sender, or the address when there is none. */
export function nameOf(from) {
  const s = String(from ?? '').trim()
  const name = s.replace(/<[^<>]*>/, '').replace(/^["'\s]+|["'\s]+$/g, '')
  return (name !== '' ? name : addressOf(s)).slice(0, 60)
}

/** The `important` setting as a list: addresses and domains, split on commas, spaces and lines. */
export const importantList = (setting) =>
  String(setting ?? '')
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase().replace(/^@/, ''))
    .filter((s) => s !== '')

/** An address matches an entry that is the whole address, or the domain (or a parent of it). */
export function isImportant(from, list) {
  const address = addressOf(from)
  const domain = address.slice(address.lastIndexOf('@') + 1)
  return list.some((entry) =>
    entry.includes('@') ? entry === address : domain === entry || domain.endsWith(`.${entry}`),
  )
}

/** A message carries `List-Unsubscribe` as a field, a header map, or a line of its text. */
export function hasListUnsubscribe(message, text = '') {
  if (message?.listUnsubscribe) return true
  const headers = message?.headers
  if (headers && typeof headers === 'object' && Object.keys(headers).some((k) => k.toLowerCase() === 'list-unsubscribe')) {
    return true
  }
  return /^list-unsubscribe:/im.test(String(text ?? '').slice(0, 4000))
}

/** Gmail files bulk mail under these itself; it is the same signal as the header. */
const BULK_LABELS = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS']

/**
 * The class a rule decides, or `undefined` to leave it for the model.
 * `context`: `important` (the setting), `ownThreads` (a Set of thread ids the owner wrote in).
 * Returns `{ class, reason }`.
 */
export function ruleClass(message, text, context = {}) {
  if (isImportant(message.from, importantList(context.important))) {
    return { class: 'act', reason: 'From someone on your important list.' }
  }
  if (message.threadId && context.ownThreads?.has?.(message.threadId)) {
    return { class: 'reply', reason: 'Answers something you wrote.' }
  }
  if (hasListUnsubscribe(message, text) || (message.labels ?? []).some((l) => BULK_LABELS.includes(l))) {
    return { class: 'noise', reason: 'A newsletter or bulk mail.' }
  }
  return undefined
}

/** One item as the model sees it: sender, subject and the first 500 characters. */
export function peek(message, text) {
  const body = String(text ?? message.snippet ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PEEK)
  return `id: ${message.id}\nfrom: ${String(message.from ?? '').slice(0, 120)}\nsubject: ${String(message.subject ?? '').slice(0, 200)}\ntext: ${body}`
}

export const SYSTEM =
  'You sort the owner’s incoming mail. For each message choose one class: ' +
  '"act" (needs the owner to do or decide something), "reply" (someone is waiting for an answer), ' +
  '"wait" (the owner is waiting on someone else), "read_later" (worth reading, no hurry), ' +
  '"noise" (ads, notifications, receipts nobody needs to read). ' +
  'Answer with a JSON array only: [{"id":"…","class":"…","reason":"at most 15 words"}], one entry per message.'

/** The prompt for up to 20 messages, `[{ message, text }]`. */
export const batchPrompt = (entries) =>
  entries
    .slice(0, BATCH)
    .map((e) => peek(e.message, e.text))
    .join('\n---\n')

const cut = (reason) => String(reason ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 15).join(' ')

/** The model's answer as `Map<id, { class, reason }>`; anything malformed is simply absent. */
export function parseBatch(answer, ids) {
  const out = new Map()
  const raw = String(answer ?? '')
  const start = raw.indexOf('['),
    end = raw.lastIndexOf(']')
  if (start < 0 || end < start) return out
  let list
  try {
    list = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return out
  }
  if (!Array.isArray(list)) return out
  const wanted = new Set(ids)
  for (const entry of list) {
    const id = String(entry?.id ?? '')
    if (wanted.has(id) && CLASSES.includes(entry?.class) && !out.has(id)) {
      out.set(id, { class: entry.class, reason: cut(entry.reason) })
    }
  }
  return out
}

/**
 * Sort a batch: rules first, then the model for the rest, 20 at a time. `sample(text, system)`
 * returns the model's text. A batch the model fails on is left out of the result, so those
 * messages are tried again next time rather than filed wrongly. A message the model did not
 * mention is `read_later`.
 * Returns `Map<id, { class, reason }>`.
 */
export async function triage(entries, context, sample) {
  const result = new Map()
  const open = []
  for (const entry of entries) {
    const ruled = ruleClass(entry.message, entry.text, context)
    if (ruled) result.set(entry.message.id, ruled)
    else open.push(entry)
  }
  for (let i = 0; i < open.length; i += BATCH) {
    const batch = open.slice(i, i + BATCH)
    let answer
    try {
      answer = await sample(batchPrompt(batch), SYSTEM)
    } catch {
      continue
    }
    const parsed = parseBatch(answer, batch.map((e) => e.message.id))
    for (const e of batch) {
      result.set(e.message.id, parsed.get(e.message.id) ?? { class: 'read_later', reason: '' })
    }
  }
  return result
}
