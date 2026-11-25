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
const SECOND = 1000
const LIST_LIMIT = 50
/** `mail.list` calls one look may make; what it does not reach waits for the next look. */
const MAX_CALLS = 20
/** Looks on which `mail.read` may fail for one mail before the desk gives up on it. */
const READ_TRIES = 3
/** The `seen` class of mail the desk gave up reading: shown in `inbox`, never a notice. */
export const UNREADABLE = 'unreadable'

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
   * Everything newer than `since` that can be proven listed. `mail.list` has no cursor and its
   * contract says nothing about order, so a full page says nothing about what was left out: the
   * provider may have kept the newest, the oldest or any of them. So the walk never trusts order.
   * It asks for windows from `since` upward (`since` plus `before:<whole seconds>`) and counts a
   * window as reached only when it came back short of a full page and nothing in it was at or past
   * the window's end — a provider that ignores `before:` is caught there and the walk stops. A full
   * window is halved and asked again; a short one moves `reached` up and the next window grows.
   * Returns every message seen (some may lie above `reached`) and `reached`: all mail newer than
   * `since` up to and including `reached` was listed (`Infinity`: all of it).
   */
  async function listSince(since) {
    const found = new Map()
    let reached = since
    let width = Infinity // the next window's width in ms; Infinity asks with no upper end
    let newestKnown = -Infinity
    // A guess only, so a window holds about half a page of the mail already seen; whether a window
    // was complete is still proven by its own answer, never by this.
    const hinted = (cap) => {
      const above = [...found.values()].map((m) => num(m?.at, undefined)).filter((at) => at !== undefined && at > reached)
      above.sort((x, y) => x - y)
      const mark = above[LIST_LIMIT / 2]
      return mark === undefined ? cap : Math.min(cap, mark - reached)
    }
    for (let call = 0; call < MAX_CALLS; call += 1) {
      const floor = Math.floor(reached / SECOND) + 1 // the smallest end that is past `reached`
      const end = width === Infinity ? undefined : Math.max(floor, Math.ceil((reached + width) / SECOND))
      const args = { since: reached, limit: LIST_LIMIT, ...(end !== undefined && { query: `before:${end}` }) }
      const got = structured(await capability('mail.list', args))?.messages
      const list = Array.isArray(got) ? got : []
      const ats = []
      for (const m of list) {
        const id = String(m?.id ?? '')
        if (id !== '' && !found.has(id)) found.set(id, m)
        const at = num(m?.at, undefined)
        if (at !== undefined) ats.push(at)
      }
      newestKnown = Math.max(newestKnown, ...ats)
      // `before:` not honoured: no window can be proven, so nothing past `reached` is claimed.
      if (end !== undefined && ats.some((at) => at >= end * SECOND)) break
      if (list.length < LIST_LIMIT) {
        if (end === undefined) return { messages: [...found.values()], reached: Infinity }
        const was = end * SECOND - 1 - reached
        reached = end * SECOND - 1
        width = hinted(list.length === 0 ? was * 4 : list.length < LIST_LIMIT / 2 ? was * 2 : was)
        if (reached + width >= newestKnown) width = Infinity // past the newest seen: ask open-ended
        continue
      }
      // Full: something in this window may have been left out. Ask for half of it.
      if (end === undefined) {
        if (ats.length === 0 || newestKnown <= reached) break // nothing dated to narrow by
        width = hinted((newestKnown - reached) / 2)
      } else {
        if (end === floor) break // a full page within one second: it cannot be narrowed
        width = hinted((end * SECOND - 1 - reached) / 2)
      }
    }
    return { messages: [...found.values()], reached }
  }

  /**
   * One look at the inbox. Returns counts only, never anything from a message. `newest` only ever
   * moves past mail that was listed and filed (or given up on): never past mail the walk did not
   * reach, mail it could not read yet, or mail the model did not sort.
   */
  async function poll() {
    const at = now()
    const { important } = await settings()
    const stored = Number(await storage.get('newest'))
    const since = Number.isFinite(stored) && stored > 0 ? stored : at - FIRST_LOOK_BACK
    const { messages, reached } = await listSince(since)
    let held = Infinity // the oldest mail that is still to be filed
    const hold = (m) => {
      held = Math.min(held, num(m.at, -Infinity)) // undated: hold everything
    }
    const fresh = []
    for (const m of messages) {
      const id = String(m?.id ?? '')
      if (id === '' || (m.labels ?? []).includes('SENT')) continue
      if ((await storage.count('seen', { id })) > 0) continue
      fresh.push({ message: { ...m, id }, text: '' })
    }

    const before = await storage.get('read_tries')
    const tries = before && typeof before === 'object' && !Array.isArray(before) ? before : {}
    const triesNow = {} // only mail that failed this time; the rest is forgotten
    const entries = []
    let gaveUp = 0
    for (const entry of fresh) {
      const { id } = entry.message
      try {
        entry.text = bodyOf(await capability('mail.read', { id }))
      } catch {
        const n = num(tries[id], 0) + 1
        if (n < READ_TRIES) {
          triesNow[id] = n
          hold(entry.message) // tried again next time
        } else {
          // It failed on every look: give up, so it cannot hold `newest` back for ever.
          await storage.insert('seen', { id, at: num(entry.message.at, at), class: UNREADABLE, reason: '', sender: nameOf(entry.message.from) })
          gaveUp += 1
        }
        continue
      }
      entries.push(entry)
    }
    if (Object.keys(tries).length > 0 || Object.keys(triesNow).length > 0) await storage.set('read_tries', triesNow)

    let filed = 0
    if (entries.length > 0) {
      let threads = new Set()
      try {
        threads = await ownThreads(Math.min(since, at - 14 * DAY))
      } catch {
        // Without the sent list nothing is a "reply"; the model still sorts everything else.
      }
      const sorted = await triage(entries, { important, ownThreads: threads }, sample)
      for (const entry of entries) {
        const verdict = sorted.get(entry.message.id)
        if (!verdict) {
          hold(entry.message)
          continue
        }
        await storage.insert('seen', {
          id: entry.message.id,
          at: num(entry.message.at, at),
          class: verdict.class,
          reason: verdict.reason,
          sender: nameOf(entry.message.from),
        })
        filed += 1
        await recordParcels(entry.message, entry.text)
        await recordBill(entry.message, entry.text)
      }
    }
    const top = reached === Infinity ? Math.max(since, ...messages.map((m) => num(m?.at, -Infinity))) : reached
    const next = Math.min(top, held - 1)
    if (next > since) await storage.set('newest', next)
    return { fresh: fresh.length, filed, ...(gaveUp > 0 && { gaveUp }) }
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
