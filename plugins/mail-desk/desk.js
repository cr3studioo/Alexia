// SPDX-License-Identifier: AGPL-3.0-only
import { billPrompt, looksLikeBill, parseBill } from './bills.js'
import { furtherAlong, parseParcels } from './parcels.js'
import { nameOf, triage } from './triage.js'

/**
 * The desk itself, with every outside thing handed in: `capability` (the only door to mail, and
 * only `mail.list` and `mail.read` go through it), `sample` (one model call), `storage` and
 * `settings`. Nothing here marks, moves or deletes mail, and nothing here logs a subject, a
 * sender or any text — the tables keep ids, classes, a sender's display name and a short reason.
 */

const DAY = 86_400_000
const FIRST_LOOK_BACK = 3 * DAY
const LIST_LIMIT = 50
const MAX_PAGES = 20

/** Local `YYYY-MM-DD` for epoch ms and minutes east of UTC. */
export const localDay = (ms, tz = 0) => new Date(ms + tz * 60_000).toISOString().slice(0, 10)

/** Whole days from one `YYYY-MM-DD` to another. */
export const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY)

/** 09:00 local on that day, as epoch ms. */
const morningOf = (day, tz) => Date.parse(`${day}T09:00:00Z`) - tz * 60_000

const num = (v, fallback) => (v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : fallback)

/** What a capability result carries: the structured part, else nothing. */
const structured = (result) => (result && typeof result === 'object' ? result.structuredContent : undefined)

const bodyOf = (result) => {
  const s = structured(result)
  if (typeof s?.text === 'string') return s.text
  const block = Array.isArray(result?.content) ? result.content.find((c) => c?.type === 'text') : undefined
  return typeof block?.text === 'string' ? block.text : ''
}

export function createDesk({ capability, sample, storage, settings, now = Date.now }) {
  const seenRows = (opts = {}) => storage.select('seen', { order: [['at', 'desc']], limit: 500, ...opts })
  const allBills = () => storage.select('bills', { order: [['due', 'asc']], limit: 500 })
  const allParcels = () => storage.select('parcels', { order: [['at', 'desc']], limit: 500 })

  async function recordParcels(message, text) {
    const at = now()
    for (const found of parseParcels(`${message.subject ?? ''}\n${text}`)) {
      const [row] = await storage.select('parcels', { where: { carrier: found.carrier, number: found.number }, limit: 1 })
      if (!row) {
        await storage.insert('parcels', {
          carrier: found.carrier,
          number: found.number,
          what: nameOf(message.from),
          state: found.state,
          eta: found.eta ?? '',
          mail_id: message.id,
          at,
        })
      } else if (furtherAlong(found.state, row.state)) {
        await storage.update(
          'parcels',
          { state: found.state, at, ...(found.eta !== undefined && { eta: found.eta }), notified: 0 },
          { rowid: row.rowid },
        )
      }
    }
  }

  async function recordBill(message, text) {
    if (!looksLikeBill(message.subject, text)) return
    const [existing] = await storage.select('bills', { where: { mail_id: message.id }, limit: 1 })
    if (existing) return
    let answer
    try {
      answer = await sample(billPrompt(text, message.subject), 'You read mail and answer with one JSON object only.')
    } catch {
      return
    }
    const bill = parseBill(answer)
    if (!bill) return
    await storage.insert('bills', { ...bill, recurring: bill.recurring ? 1 : 0, mail_id: message.id, state: 'open' })
  }

  /** The thread ids the owner has written in lately — what makes a message a reply. */
  async function ownThreads(since) {
    const listed = await capability('mail.list', { since, query: 'in:sent', limit: LIST_LIMIT })
    const messages = structured(listed)?.messages
    return new Set((Array.isArray(messages) ? messages : []).map((m) => String(m.threadId ?? '')).filter(Boolean))
  }

  /**
   * Everything newer than `since`, page by page: `mail.list` has no cursor, so each further page asks
   * for mail older than the oldest one seen (Gmail's `before:`, whole seconds, newest first) until
   * fewer than a full page comes back. Returns the messages and the oldest `at` if it stopped early.
   */
  async function listSince(since) {
    const messages = []
    const ids = new Set()
    let before
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const args = { since, limit: LIST_LIMIT, ...(before !== undefined && { query: `before:${before}` }) }
      const got = structured(await capability('mail.list', args))?.messages
      const list = Array.isArray(got) ? got : []
      let added = 0
      let oldest = Infinity
      for (const m of list) {
        const id = String(m?.id ?? '')
        const at = num(m?.at, undefined)
        if (at !== undefined) oldest = Math.min(oldest, at)
        if (id === '' || ids.has(id)) continue
        ids.add(id)
        messages.push(m)
        added += 1
      }
      if (list.length < LIST_LIMIT) return { messages, stoppedAt: undefined }
      if (added === 0 || oldest === Infinity || (before !== undefined && Math.floor(oldest / 1000) + 1 >= before)) return { messages, stoppedAt: oldest === Infinity ? undefined : oldest }
      before = Math.floor(oldest / 1000) + 1
      if (page === MAX_PAGES - 1) return { messages, stoppedAt: oldest }
    }
    return { messages, stoppedAt: undefined }
  }

  /** One look at the inbox. Returns counts only, never anything from a message. */
  async function poll() {
    const at = now()
    const { important } = await settings()
    const stored = Number(await storage.get('newest'))
    const since = Number.isFinite(stored) && stored > 0 ? stored : at - FIRST_LOOK_BACK
    const { messages, stoppedAt } = await listSince(since)
    let held = stoppedAt ?? Infinity // mail older than where paging stopped was not reached
    const fresh = []
    for (const m of messages) {
      const id = String(m?.id ?? '')
      if (id === '' || (m.labels ?? []).includes('SENT')) continue
      if ((await storage.count('seen', { id })) > 0) continue
      fresh.push({ message: { ...m, id }, text: '' })
    }
    if (fresh.length === 0) {
      if (held !== Infinity && held - 1 >= since) await storage.set('newest', held - 1)
      return { fresh: 0, filed: 0 }
    }

    const entries = []
    for (const entry of fresh) {
      try {
        entry.text = bodyOf(await capability('mail.read', { id: entry.message.id }))
      } catch {
        held = Math.min(held, num(entry.message.at, at)) // tried again next time
        continue
      }
      entries.push(entry)
    }
    let threads = new Set()
    try {
      threads = await ownThreads(Math.min(since, at - 14 * DAY))
    } catch {
      // Without the sent list nothing is a "reply"; the model still sorts everything else.
    }
    const sorted = await triage(entries, { important, ownThreads: threads }, sample)

    let filed = 0
    for (const entry of entries) {
      const verdict = sorted.get(entry.message.id)
      const sentAt = num(entry.message.at, at)
      if (!verdict) {
        held = Math.min(held, sentAt)
        continue
      }
      await storage.insert('seen', {
        id: entry.message.id,
        at: sentAt,
        class: verdict.class,
        reason: verdict.reason,
        sender: nameOf(entry.message.from),
      })
      filed += 1
      await recordParcels(entry.message, entry.text)
      await recordBill(entry.message, entry.text)
    }
    const newest = Math.max(0, ...fresh.map((f) => num(f.message.at, 0)))
    const next = held === Infinity ? newest : Math.min(newest, held - 1)
    if (next > 0 && next >= since) await storage.set('newest', next)
    return { fresh: fresh.length, filed }
  }

  /** Notices: mail that needs the owner, parcels on the doorstep, bills and renewals. */
  async function noticeItems({ now: nowMs, tz_offset_min, horizon_days } = {}) {
    const at = num(nowMs, now())
    const tz = num(tz_offset_min, 0)
    const horizon = num(horizon_days, 7)
    const today = localDay(at, tz)
    const out = []

    const needing = [...(await seenRows({ where: { class: 'act' } })), ...(await seenRows({ where: { class: 'reply' } }))]
    for (const row of needing) {
      if (row.done === 1 || num(row.at, 0) < at - 3 * DAY) continue
      const sender = String(row.sender ?? 'someone')
      const reason = String(row.reason ?? '')
      out.push({
        key: `mail:${String(row.id)}`,
        text: `Mail from ${sender}`,
        why: reason === '' ? `From ${sender}.` : `From ${sender}: ${reason}`,
        urgency: 'normal',
      })
    }

    for (const row of await allParcels()) {
      const label = `${String(row.carrier)} parcel${row.what ? ` from ${String(row.what)}` : ''}`
      if (row.state === 'out_for_delivery' && localDay(num(row.at, 0), tz) === today) {
        out.push({ key: `parcel:${String(row.rowid)}`, text: `${label} is out for delivery today`, why: 'Out for delivery.', urgency: 'low' })
      } else if (row.state === 'delivered' && row.notified !== 1 && num(row.at, 0) >= at - 2 * DAY) {
        out.push({ key: `parcel:${String(row.rowid)}`, text: `${label} was delivered`, why: 'Delivered.', urgency: 'low' })
      }
    }

    for (const row of await allBills()) {
      if (row.state !== 'open') continue
      const ahead = daysBetween(today, String(row.due))
      const money = `${String(row.amount)} ${String(row.currency)}`
      if (row.recurring === 1) {
        if (ahead >= 0 && ahead <= 3) {
          out.push({
            key: `bill:${String(row.rowid)}`,
            text: `${String(row.payee)} renews ${String(row.due)} (${money})`,
            why: ahead === 0 ? 'Renews today.' : `Renews in ${ahead} day${ahead === 1 ? '' : 's'}.`,
            urgency: 'low',
          })
        }
      } else if (ahead <= horizon && ahead >= -14) {
        out.push({
          key: `bill:${String(row.rowid)}`,
          text: `${String(row.payee)}: ${money} due ${String(row.due)}`,
          why: ahead < 0 ? 'Past its due day.' : 'A bill is coming due.',
          dueAt: morningOf(String(row.due), tz),
        })
      }
    }
    return out
  }

  /** The owner said Done to a mail or parcel notice: it stops coming up. Any other key does nothing. */
  async function noticeDone(key) {
    const parcel = /^parcel:(\d+)$/.exec(String(key ?? ''))
    if (parcel) {
      const changed = await storage.update('parcels', { notified: 1 }, { rowid: Number(parcel[1]) })
      return { closed: changed > 0 }
    }
    const m = /^mail:(.+)$/.exec(String(key ?? ''))
    if (!m) return { closed: false }
    const changed = await storage.update('seen', { done: 1 }, { id: m[1] })
    return { closed: changed > 0 }
  }

  /** One section of a brief; an empty string when there is nothing to say. */
  async function briefSection({ kind, now: nowMs, tz_offset_min } = {}) {
    const at = num(nowMs, now())
    const tz = num(tz_offset_min, 0)
    if (kind === 'morning') {
      const rows = (await seenRows()).filter((r) => num(r.at, 0) >= at - DAY)
      if (rows.length === 0) return ''
      const count = (c) => rows.filter((r) => r.class === c).length
      const head = `Mail since yesterday: ${count('act')} to act on, ${count('reply')} to reply to, ${count('wait')} waiting, ${count('read_later')} to read later, ${count('noise')} noise.`
      const lines = rows.filter((r) => r.class === 'act' && r.done !== 1).map((r) => `- ${String(r.sender)}: ${String(r.reason)}`.replace(/: $/, ''))
      return [head, ...lines].join('\n')
    }
    if (kind === 'evening') {
      const rows = (await seenRows()).filter((r) => r.class === 'reply' && r.done !== 1 && num(r.at, 0) >= at - 3 * DAY)
      if (rows.length === 0) return ''
      return ['Still needs a reply:', ...rows.map((r) => `- ${String(r.sender)}: ${String(r.reason)}`.replace(/: $/, ''))].join('\n')
    }
    if (kind === 'weekly') {
      const today = localDay(at, tz)
      const rows = (await allBills()).filter((r) => r.state === 'open' && daysBetween(today, String(r.due)) >= 0 && daysBetween(today, String(r.due)) <= 7)
      if (rows.length === 0) return ''
      return [
        'Bills and renewals this week:',
        ...rows.map((r) => `- ${String(r.payee)}: ${String(r.amount)} ${String(r.currency)}, ${r.recurring === 1 ? 'renews' : 'due'} ${String(r.due)}`),
      ].join('\n')
    }
    return ''
  }

  /** The `inbox` tool: what was sorted, newest first, optionally one class. */
  async function inbox(klass) {
    const rows = await seenRows(klass ? { where: { class: klass } } : {})
    return rows.map((r) => ({ id: String(r.id), class: String(r.class), sender: String(r.sender ?? ''), reason: String(r.reason ?? ''), at: num(r.at, 0), done: r.done === 1 }))
  }

  async function parcels() {
    return (await allParcels()).map((r) => ({
      id: String(r.rowid),
      carrier: String(r.carrier),
      number: String(r.number),
      what: String(r.what ?? ''),
      state: String(r.state),
      eta: String(r.eta ?? ''),
    }))
  }

  async function bills() {
    return (await allBills()).map((r) => ({
      id: String(r.rowid),
      payee: String(r.payee),
      amount: num(r.amount, 0),
      currency: String(r.currency),
      due: String(r.due),
      recurring: r.recurring === 1,
      state: String(r.state),
    }))
  }

  async function billPaid(id) {
    const rowid = Number(id)
    const [row] = await storage.select('bills', { where: { rowid }, limit: 1 })
    if (!row) return { found: false }
    await storage.update('bills', { state: 'paid' }, { rowid })
    return { found: true, payee: String(row.payee), already: row.state === 'paid' }
  }

  async function counts() {
    const rows = await seenRows()
    const open = rows.filter((r) => (r.class === 'act' || r.class === 'reply') && r.done !== 1 && num(r.at, 0) >= now() - 3 * DAY).length
    return { sorted: rows.length, open }
  }

  return { poll, noticeItems, noticeDone, briefSection, inbox, parcels, bills, billPaid, counts }
}
