// SPDX-License-Identifier: AGPL-3.0-only
import { ArgumentError } from './calendar.js'

/**
 * Google Contacts (the People API), read only: request builders and mappers, pure.
 *
 * `people:searchContacts` answers from a cache Google warms on the first search of a session;
 * the People API documentation asks for one search with an empty query first, which is
 * {@link warmupRequest}.
 */

export const API = 'https://people.googleapis.com/v1'

const MASK = 'names,emailAddresses,phoneNumbers,birthdays'

/** `GET` contacts matching a name, email or phone. */
export function findRequest(query, pageSize = 10) {
  const text = String(query ?? '').trim()
  if (text === '') throw new ArgumentError('Say who to look for: a name, an email or a phone number.')
  const url = new URL(`${API}/people:searchContacts`)
  url.search = new URLSearchParams({ query: text, readMask: MASK, pageSize: String(pageSize) }).toString()
  return { url: url.toString(), method: 'GET' }
}

/** The empty search that warms Google's contact cache. */
export function warmupRequest() {
  const url = new URL(`${API}/people:searchContacts`)
  url.search = new URLSearchParams({ query: '', readMask: MASK }).toString()
  return { url: url.toString(), method: 'GET' }
}

const pad = (n) => String(n).padStart(2, '0')

/**
 * A People API birthday as text: `YYYY-MM-DD`, or `--MM-DD` (ISO 8601's form for a day with no
 * year) when the year is not known; the free-text form when that is all there is.
 */
export function birthdayOf(birthdays) {
  const list = Array.isArray(birthdays) ? birthdays : []
  const pick = list.find((b) => b?.metadata?.primary && b?.date) ?? list.find((b) => b?.date) ?? list.find((b) => b?.text)
  if (!pick) return undefined
  const d = pick.date
  if (d && Number(d.month) >= 1 && Number(d.month) <= 12 && Number(d.day) >= 1 && Number(d.day) <= 31) {
    return Number(d.year) > 0 ? `${String(d.year).padStart(4, '0')}-${pad(d.month)}-${pad(d.day)}` : `--${pad(d.month)}-${pad(d.day)}`
  }
  return typeof pick.text === 'string' && pick.text.trim() !== '' ? pick.text.trim() : undefined
}

const values = (list) => [
  ...new Set((Array.isArray(list) ? list : []).map((x) => (typeof x?.value === 'string' ? x.value.trim() : '')).filter(Boolean)),
]

/** One person in the INTERFACES shape. */
export function mapPerson(person) {
  const names = Array.isArray(person?.names) ? person.names : []
  const name = (names.find((n) => n?.metadata?.primary) ?? names[0])?.displayName
  const emails = values(person?.emailAddresses)
  const birthday = birthdayOf(person?.birthdays)
  return {
    name: typeof name === 'string' && name.trim() !== '' ? name.trim() : (emails[0] ?? '(no name)'),
    emails,
    phones: values(person?.phoneNumbers),
    ...(birthday !== undefined && { birthday }),
  }
}

/** Every person in a `searchContacts` answer. */
export const mapResults = (json) =>
  (Array.isArray(json?.results) ? json.results : []).map((r) => r?.person).filter(Boolean).map(mapPerson)

/** One readable line per contact. */
export const contactLine = (c) =>
  `- ${c.name}${c.emails.length ? ` <${c.emails.join(', ')}>` : ''}${c.phones.length ? ` ${c.phones.join(', ')}` : ''}${c.birthday ? ` (birthday ${c.birthday})` : ''}`
