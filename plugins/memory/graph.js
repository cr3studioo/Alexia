// SPDX-License-Identifier: AGPL-3.0-only
import { content } from './search.js'

/**
 * The life graph (P3-14): people, dated things and goals, and what is worth saying about them.
 *
 * Everything here is pure — rows and numbers in, rows and numbers out — so it can be argued
 * with and tested without a database, a clock or a model. `index.js` owns the storage.
 *
 * Facts about the owner's own life are logged nowhere from here: no text goes into a log line.
 */

const DAY = 86_400_000
const MINUTE = 60_000

/** Birthdays this many days ahead, today included, are worth a word. */
export const BIRTHDAY_DAYS = 7
/** A follow-up older than this has been waiting long enough to be mentioned. */
export const FOLLOW_UP_DAYS = 3
/** A goal untouched this long is mentioned, and then left alone for as long again. */
export const GOAL_QUIET_DAYS = 14

/** Letters without their marks, lower case, single spaces: how two spellings are compared. */
export const fold = (text) =>
  String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/**
 * Endings a Czech name takes in the cases it is not spoken in first: *Petr*, *Petře*, *Petrovi*,
 * *Petrem*, *Petru*. Deliberately not `a`: *Petra* is somebody else. A bare `e` is the vocative
 * only after `r` (*Petr*, *Petře*; *Viktor*, *Viktore*): after anything else it would make
 * *Louis* and *Louise*, *Jan* and *Jane*, *Ann* and *Anne* one person. Those need an alias.
 */
const ENDINGS = new Set(['u', 'ovi', 'em', 'ou'])

/** Is `b` the name `a` in another case? Both folded, the shorter one at least three letters. */
function inflected(a, b) {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  if (short.length < 3 || short === long || !long.startsWith(short)) return false
  const ending = long.slice(short.length)
  return ENDINGS.has(ending) || (ending === 'e' && short.endsWith('r'))
}

/** Do these two spellings name the same one? Diacritics folded, a Czech case ending forgiven. */
export function sameName(a, b) {
  const x = fold(a)
  const y = fold(b)
  if (x === '' || y === '') return false
  if (x === y) return true
  // A first name against a full name is the same person only when the first word agrees.
  return inflected(x, y)
}

const namesOf = (person) => [String(person?.name ?? ''), ...aliasesOf(person)]

/** The aliases of a row, which are stored as a JSON array. */
export function aliasesOf(person) {
  const raw = person?.aliases
  if (Array.isArray(raw)) return raw.map(String)
  try {
    const parsed = JSON.parse(String(raw ?? '[]'))
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

/** The ids stored in a JSON-array column, as numbers. */
export function idsOf(value) {
  let raw = value
  if (!Array.isArray(raw)) {
    try {
      raw = JSON.parse(String(raw ?? '[]'))
    } catch {
      raw = []
    }
  }
  return Array.isArray(raw) ? raw.map(Number).filter(Number.isFinite) : []
}

/** The person a name belongs to, by name or alias, or `undefined`. First hit wins. */
export function findPerson(people, name) {
  const asked = String(name ?? '')
  if (fold(asked) === '') return undefined
  // An exact spelling beats a declined one, so *Petra* is never taken for *Petr*.
  return (
    people.find((person) => namesOf(person).some((one) => fold(one) === fold(asked))) ??
    people.find((person) => namesOf(person).some((one) => sameName(one, asked)))
  )
}

/**
 * The owner's offset from UTC at this instant, in minutes east, for `zone` (an IANA name) or,
 * with none, the zone this process runs in. Daylight saving is the instant's own.
 */
export function offsetAt(ms, zone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value]),
  )
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second))
  return Math.round((asUtc - Math.floor(Number(ms) / 1000) * 1000) / MINUTE)
}

// ---- dates -------------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0')
const dayString = (ms) => new Date(ms).toISOString().slice(0, 10)

/** Midnight UTC of the owner's local day for this instant, as a number of days. */
const localDay = (ms, tz = 0) => Math.floor((Number(ms) + tz * MINUTE) / DAY)
const dayToString = (day) => dayString(day * DAY)
const dayFromString = (text) => Date.parse(`${text}T00:00:00Z`) / DAY

const WEEKDAYS = [
  ['sunday', 'sun', 'nedele', 'nedeli'],
  ['monday', 'mon', 'pondeli'],
  ['tuesday', 'tue', 'utery'],
  ['wednesday', 'wed', 'streda', 'stredu', 'stredy'],
  ['thursday', 'thu', 'ctvrtek'],
  ['friday', 'fri', 'patek'],
  ['saturday', 'sat', 'sobota', 'sobotu', 'soboty'],
]
const weekdayOf = (word) => WEEKDAYS.findIndex((names) => names.includes(word))

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/
const MONTH_DAY = /^\d{2}-\d{2}$/

const validDay = (text) => ISO_DAY.test(text) && dayToString(dayFromString(text)) === text

/**
 * A day or a day and time, written the way `dates.due` is stored, from whatever the model gave,
 * resolved against **the message's own time** (`at`, ms) and never against the model's idea of
 * today. `null` when it cannot be read.
 *
 * Understood: `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM`, `MM-DD` (the next such day), *today*, *tomorrow*,
 * *in N days*, *next week*, *friday* / *next friday* (the first one after the message's day),
 * and the same in Czech. A time of day (`at 14:00`, `v 14:00`) is kept when there is one.
 */
export function resolveDue(text, at, tz = 0) {
  const said = String(text ?? '').trim()
  if (said === '') return null
  if (ISO_TIME.test(said)) return validDay(said.slice(0, 10)) ? said : null
  if (validDay(said)) return said
  const today = localDay(at, tz)
  if (MONTH_DAY.test(said)) return nextMonthDay(said, dayToString(today))

  const clock = /\b(\d{1,2})[:.](\d{2})\b/.exec(said)
  const time = clock && Number(clock[1]) < 24 && Number(clock[2]) < 60 ? `T${pad(Number(clock[1]))}:${clock[2]}` : ''
  const rest = fold(said.replace(clock?.[0] ?? '', ' '))
  const day = relativeDay(rest, today)
  return day === null ? null : `${dayToString(day)}${time}`
}

function relativeDay(rest, today) {
  if (/\b(today|dnes)\b/.test(rest)) return today
  if (/\b(tomorrow|zitra)\b/.test(rest)) return today + 1
  const inDays = /\b(?:in|za) (\d{1,3}) (?:days?|dni|dny|den)\b/.exec(rest)
  if (inDays) return today + Number(inDays[1])
  if (/\b(next week|pristi tyden)\b/.test(rest)) return today + 7
  for (const word of rest.split(' ')) {
    const weekday = weekdayOf(word)
    if (weekday === -1) continue
    const now = new Date(today * DAY).getUTCDay()
    // The first such day *after* today: said on a Tuesday, "next Friday" is three days on and
    // "Tuesday" is a week on. Never today, which nobody means by naming it.
    return today + (((weekday - now + 6) % 7) + 1)
  }
  return null
}

/** The next `MM-DD` on or after `from` (a `YYYY-MM-DD`), as a `YYYY-MM-DD`; 29 Feb falls on the 28th in other years. */
export function nextMonthDay(monthDay, from) {
  const [month, day] = monthDay.split('-').map(Number)
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null
  const startYear = Number(from.slice(0, 4))
  for (let year = startYear; year <= startYear + 8; year += 1) {
    const exact = `${year}-${pad(month)}-${pad(day)}`
    const made = validDay(exact) ? exact : month === 2 && day === 29 ? `${year}-02-28` : null
    if (made !== null && made >= from) return made
  }
  return null
}

/** The next time a stored birthday (`MM-DD` or `YYYY-MM-DD`) comes round, on or after `from`. */
export function nextBirthday(birthday, from) {
  const text = String(birthday ?? '').trim()
  if (ISO_DAY.test(text)) return nextMonthDay(text.slice(5), from)
  if (MONTH_DAY.test(text)) return nextMonthDay(text, from)
  return null
}

/** A birthday as it is stored: `YYYY-MM-DD`, `MM-DD` (also `--MM-DD`), or `null` if it is neither. */
export function normalBirthday(value) {
  const text = String(value ?? '').trim().replace(/^--/, '')
  if (ISO_DAY.test(text)) return validDay(text) ? text : null
  if (MONTH_DAY.test(text)) return nextMonthDay(text, '2024-01-01') === null ? null : text
  return null
}

/** The instant a local day and clock time fall on, in ms. */
const atLocal = (dayText, hour, minute, tz) =>
  Date.parse(`${dayText}T${pad(hour)}:${pad(minute)}:00Z`) - tz * MINUTE

/** When a stored `dates.due` is due: its time if it has one, else 09:00 that day, local. */
export function dueMs(due, tz = 0) {
  const text = String(due ?? '')
  if (ISO_TIME.test(text)) return atLocal(text.slice(0, 10), Number(text.slice(11, 13)), Number(text.slice(14, 16)), tz)
  if (validDay(text)) return atLocal(text, 9, 0, tz)
  return null
}

// ---- the notice items --------------------------------------------------------------------

const asNumber = (value, fallback = 0) => (value !== undefined && value !== null && Number.isFinite(Number(value)) ? Number(value) : fallback)
const upcoming = (days) => (days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`)

/**
 * What might be worth saying now (§3.6 `notice.items`), keys prefixed `memory:`.
 *
 * - a birthday within `BIRTHDAY_DAYS`: Low, due that day at 09:00 local;
 * - an open date within `horizonDays`: a `dueAt`, and no urgency — the scheduler's radar decides;
 * - a follow-up older than `FOLLOW_UP_DAYS`: Low;
 * - an active goal untouched for `GOAL_QUIET_DAYS`, and not raised in that long: Low.
 *
 * `urgency` is lower case and `dueAt` camelCase, which is what the scheduler reads.
 */
export function noticeItems({ people = [], dates = [], goals = [] }, now, tz = 0, horizonDays = 7) {
  const items = []
  const today = dayToString(localDay(now, tz))
  const todayNumber = dayFromString(today)

  for (const person of people) {
    const name = String(person.name ?? '')
    const next = nextBirthday(person.birthday, today)
    if (next !== null) {
      const days = dayFromString(next) - todayNumber
      if (days >= 0 && days <= BIRTHDAY_DAYS) {
        const born = ISO_DAY.test(String(person.birthday)) ? Number(next.slice(0, 4)) - Number(String(person.birthday).slice(0, 4)) : 0
        items.push({
          key: `memory:birthday:${String(person.rowid)}:${next}`,
          text: `${name}'s birthday is ${upcoming(days)}${born > 0 ? ` (${born})` : ''}.`,
          why: 'You told me when it is.',
          urgency: 'low',
          dueAt: atLocal(next, 9, 0, tz),
        })
      }
    }
    const followUp = String(person.follow_up ?? '').trim()
    if (followUp !== '' && now - asNumber(person.follow_up_at, asNumber(person.last_seen, now)) > FOLLOW_UP_DAYS * DAY) {
      items.push({
        key: `memory:follow:${String(person.rowid)}`,
        text: `${name}: ${followUp}`,
        why: "You said you'd get back to them.",
        urgency: 'low',
      })
    }
  }

  const horizon = Math.max(0, asNumber(horizonDays, 7))
  for (const row of dates) {
    if (row.state !== 'open') continue
    const at = dueMs(row.due, tz)
    if (at === null) continue
    const days = dayFromString(String(row.due).slice(0, 10)) - todayNumber
    if (days < 0 || days > horizon) continue
    items.push({
      key: `memory:date:${String(row.rowid)}`,
      text: `${String(row.what)} — ${upcoming(days)}.`,
      why: 'You mentioned it.',
      dueAt: at,
    })
  }

  for (const goal of goals) {
    if (goal.state !== 'active') continue
    const touched = asNumber(goal.last_touched, asNumber(goal.since, now))
    if (now - touched < GOAL_QUIET_DAYS * DAY) continue
    if (goal.raised_at !== undefined && goal.raised_at !== null && now - asNumber(goal.raised_at) < GOAL_QUIET_DAYS * DAY) continue
    items.push({
      key: `memory:goal:${String(goal.rowid)}`,
      text: `Still working on it? ${String(goal.text)}`,
      why: `You haven't mentioned it in ${Math.floor((now - touched) / DAY)} days.`,
      urgency: 'low',
    })
  }
  return items
}

/**
 * What "Done" on a notice changes, as `{table, rowid, set}` or `null` for a key that is not ours.
 * `memory:follow:<id>` clears that person's follow-up; `memory:date:<id>` marks an open date done.
 * Birthdays and goals have nothing to close: they stop on their own.
 */
export function doneChange(key) {
  const match = /^memory:(follow|date):(\d+)$/.exec(String(key ?? ''))
  if (match === null) return null
  const rowid = Number(match[2])
  return match[1] === 'follow'
    ? { table: 'people', rowid, set: { follow_up: null, follow_up_at: null } }
    : { table: 'dates', rowid, set: { state: 'done' } }
}

/**
 * What forgetting or correcting facts leaves behind in the life graph, as a plan: dates that came
 * from them go, a person only they mentioned goes, a person they and others mentioned loses the
 * link (and the follow-up, when the forgotten fact was the latest mention), a goal only they
 * raised goes. Rows with no link (older ones) are never touched.
 * Returns `{ dates: [rowid], people: [{rowid, remove?, set?}], goals: [{rowid, remove?, set?}] }`.
 */
export function unlinkPlan({ people = [], dates = [], goals = [] }, factIds) {
  const gone = new Set(factIds.map(Number))
  const plan = { dates: [], people: [], goals: [] }
  for (const row of dates) if (gone.has(Number(row.fact_id))) plan.dates.push({ rowid: Number(row.rowid), remove: true })
  for (const person of people) {
    const ids = idsOf(person.notes_ids)
    if (!ids.some((id) => gone.has(id))) continue
    const left = ids.filter((id) => !gone.has(id))
    if (left.length === 0) plan.people.push({ rowid: Number(person.rowid), remove: true })
    else {
      const set = { notes_ids: JSON.stringify(left) }
      if (gone.has(ids[ids.length - 1])) Object.assign(set, { follow_up: null, follow_up_at: null })
      plan.people.push({ rowid: Number(person.rowid), set })
    }
  }
  for (const goal of goals) {
    const ids = idsOf(goal.fact_ids)
    if (!ids.some((id) => gone.has(id))) continue
    const left = ids.filter((id) => !gone.has(id))
    plan.goals.push(left.length === 0 ? { rowid: Number(goal.rowid), remove: true } : { rowid: Number(goal.rowid), set: { fact_ids: JSON.stringify(left) } })
  }
  return plan
}

/** The same links moved from fact `from` to its rewrite `to`: same meaning, new row. */
export function relinkPlan({ people = [], dates = [], goals = [] }, from, to) {
  const swap = (ids) => [...new Set(ids.map((id) => (id === Number(from) ? Number(to) : id)))]
  return {
    dates: dates.filter((row) => Number(row.fact_id) === Number(from)).map((row) => ({ rowid: Number(row.rowid), set: { fact_id: Number(to) } })),
    people: people
      .filter((row) => idsOf(row.notes_ids).includes(Number(from)))
      .map((row) => ({ rowid: Number(row.rowid), set: { notes_ids: JSON.stringify(swap(idsOf(row.notes_ids))) } })),
    goals: goals
      .filter((row) => idsOf(row.fact_ids).includes(Number(from)))
      .map((row) => ({ rowid: Number(row.rowid), set: { fact_ids: JSON.stringify(swap(idsOf(row.fact_ids))) } })),
  }
}

// ---- goals -------------------------------------------------------------------------------

/** The goal a sentence is already about, if it is: most of the shorter one's content words shared. */
export function findGoal(goals, text) {
  const mine = content(text)
  if (mine.size === 0) return undefined
  return goals.find((goal) => {
    if (goal.state !== 'active') return false
    const theirs = content(String(goal.text ?? ''))
    if (theirs.size === 0) return false
    let shared = 0
    for (const word of theirs) if (mine.has(word)) shared += 1
    return shared / Math.min(mine.size, theirs.size) >= 0.6
  })
}

// ---- contacts ----------------------------------------------------------------------------

/**
 * What `contacts.find` knows about a person, as a patch for their row.
 *
 * `ask(query)` is the capability call, already wrapped: it answers the tool result or `null`
 * when nothing provides it. **No provider is not a problem and not worth a word**: the patch is
 * empty and nothing is said. A birthday is filled in only when the person has none — what the
 * owner said beats an address book — and the contact line is replaced each time, because that is
 * what the address book says now.
 */
export async function fromContacts(person, ask) {
  let result
  try {
    result = await ask(String(person?.name ?? ''))
  } catch {
    return {}
  }
  if (result === null || result === undefined || result.isError === true) return {}
  let list = result.structuredContent?.contacts
  if (!Array.isArray(list)) {
    try {
      const said = (result.content ?? []).find((part) => part?.type === 'text')?.text
      list = JSON.parse(String(said ?? '{}')).contacts
    } catch {
      list = undefined
    }
  }
  if (!Array.isArray(list)) return {}
  const found = list.find((one) => namesOf(person).some((name) => sameContact(name, String(one?.name ?? ''))))
  if (!found) return {}
  const patch = {}
  const birthday = normalBirthday(found.birthday)
  if (birthday !== null && !normalBirthday(person?.birthday)) patch.birthday = birthday
  const line = [found.emails, found.phones]
    .flatMap((part) => (Array.isArray(part) ? part : []))
    .map((one) => String(one).trim())
    .filter(Boolean)
  if (typeof found.address === 'string' && found.address.trim() !== '') line.push(found.address.trim())
  if (line.length > 0) patch.contact = line.join(', ')
  return patch
}

/** A contact called *Petr Novák* is *Petr*; a contact called *Petra* is not. */
function sameContact(name, contact) {
  if (sameName(name, contact)) return true
  const first = fold(contact).split(' ')[0] ?? ''
  const mine = fold(name)
  return first !== '' && (first === mine || inflected(first, mine) || mine.split(' ').every((part) => fold(contact).split(' ').includes(part)))
}

/** The line `about_person` and `people` show for one person. */
export function personLine(person) {
  const bits = [String(person.relation ?? '').trim(), person.birthday ? `birthday ${String(person.birthday)}` : '']
  return `${String(person.name)}${bits.filter(Boolean).length > 0 ? ` — ${bits.filter(Boolean).join(', ')}` : ''}`
}
