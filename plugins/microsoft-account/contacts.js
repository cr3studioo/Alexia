// SPDX-License-Identifier: AGPL-3.0-only
import { ArgumentError } from './calendar.js'
import { GRAPH } from './oauth.js'

/**
 * Outlook contacts through Microsoft Graph (`/me/contacts`), read only: request builders and
 * mappers, pure.
 *
 * Graph filters contacts by the start of a name (`startswith` on the display, given and family
 * names) and by an exact email address; it cannot filter by phone. So a query that is a phone
 * number reads the contact list page by page ({@link SCAN_PAGES} at most) and matches the
 * digits here.
 */

const SELECT = 'displayName,givenName,surname,emailAddresses,mobilePhone,businessPhones,homePhones,birthday'

/** Pages of 100 read for a phone-number search, at most. */
export const SCAN_PAGES = 10

const quote = (text) => `'${text.replace(/'/g, "''")}'`

/** The digits of a phone-number query, or `undefined` when the query is not one. */
export function phoneDigits(query) {
  const text = String(query ?? '').trim()
  if (!/^\+?[\d\s().-]+$/.test(text)) return undefined
  const digits = text.replace(/\D/g, '')
  return digits.length >= 3 ? digits : undefined
}

/**
 * `GET` contacts matching a name, an email or a phone. Returns the request and, for a phone
 * search, the `digits` to match the answer against.
 */
export function findRequest(query, top = 10) {
  const text = String(query ?? '').trim()
  if (text === '') throw new ArgumentError('Say who to look for: a name, an email or a phone number.')
  if (text.length > 200) throw new ArgumentError('That is too long to look for.')
  const url = new URL(`${GRAPH}/me/contacts`)
  url.searchParams.set('$select', SELECT)
  const digits = phoneDigits(text)
  if (digits !== undefined) {
    url.searchParams.set('$top', '100')
    return { url: url.toString(), method: 'GET', digits }
  }
  const q = quote(text)
  url.searchParams.set(
    '$filter',
    text.includes('@') ?
      `emailAddresses/any(a:a/address eq ${quote(text.toLowerCase())})`
    : `startswith(displayName,${q}) or startswith(givenName,${q}) or startswith(surname,${q})`,
  )
  url.searchParams.set('$top', String(top))
  return { url: url.toString(), method: 'GET' }
}

const pad = (n) => String(n).padStart(2, '0')

/**
 * A Graph contact birthday as text: `YYYY-MM-DD`, or `--MM-DD` (ISO 8601's form for a day with
 * no year) when the year is not known — Outlook files a birthday with no year in 1604.
 *
 * Graph keeps a birthday as an instant. A client that saved local midnight east of UTC leaves
 * it on the evening before (`1990-04-06T22:00:00Z` for 7 April in Prague), so an instant at
 * 13:00 UTC or later is read as the next day; one before is the day it names.
 */
export function birthdayOf(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}))?/.exec(value.trim())
  if (!m) return undefined
  let year = Number(m[1])
  let month = Number(m[2])
  let day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined
  if (m[4] !== undefined && Number(m[4]) >= 13) {
    const next = new Date(Date.UTC(year, month - 1, day) + 24 * 60 * 60 * 1000)
    year = next.getUTCFullYear()
    month = next.getUTCMonth() + 1
    day = next.getUTCDate()
  }
  return year > 1604 ? `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}` : `--${pad(month)}-${pad(day)}`
}

const unique = (list) => [...new Set(list.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean))]

/** One contact in the INTERFACES shape. */
export function mapContact(c) {
  const emails = unique((Array.isArray(c?.emailAddresses) ? c.emailAddresses : []).map((e) => e?.address))
  const phones = unique([
    c?.mobilePhone,
    ...(Array.isArray(c?.businessPhones) ? c.businessPhones : []),
    ...(Array.isArray(c?.homePhones) ? c.homePhones : []),
  ])
  const joined = [c?.givenName, c?.surname].filter((x) => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()).join(' ')
  const display = typeof c?.displayName === 'string' ? c.displayName.trim() : ''
  const birthday = birthdayOf(c?.birthday)
  return {
    name: display || joined || emails[0] || '(no name)',
    emails,
    phones,
    ...(birthday !== undefined && { birthday }),
  }
}

/** Every contact in a `contacts` answer; for a phone search, only those whose number holds the digits. */
export function mapContacts(json, digits = undefined) {
  const all = (Array.isArray(json?.value) ? json.value : []).filter((c) => c && typeof c === 'object').map(mapContact)
  if (digits === undefined) return all
  return all.filter((c) => c.phones.some((p) => p.replace(/\D/g, '').includes(digits)))
}

/** One readable line per contact. */
export const contactLine = (c) =>
  `- ${c.name}${c.emails.length ? ` <${c.emails.join(', ')}>` : ''}${c.phones.length ? ` ${c.phones.join(', ')}` : ''}${c.birthday ? ` (birthday ${c.birthday})` : ''}`
