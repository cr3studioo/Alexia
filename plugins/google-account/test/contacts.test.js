// SPDX-License-Identifier: AGPL-3.0-only
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { birthdayOf, findRequest, mapPerson } from '../contacts.js'
import { fakeGoogle, settingsOf } from './fake.js'

process.env.ALEXIA_PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const { service } = await import('../index.js')

/** `people:searchContacts`, written by hand. */
const answer = {
  results: [
    {
      person: {
        resourceName: 'people/c1',
        names: [{ displayName: 'Jana Nováková', metadata: { primary: true } }],
        emailAddresses: [{ value: 'jana@example.com' }, { value: 'jana@example.com' }, { value: 'j@example.org' }],
        phoneNumbers: [{ value: '+420 600 000 000' }],
        birthdays: [{ metadata: { primary: true }, date: { year: 1990, month: 4, day: 7 } }],
      },
    },
    { person: { resourceName: 'people/c2', names: [{ displayName: 'Petr' }], birthdays: [{ date: { month: 12, day: 24 } }] } },
    { person: { resourceName: 'people/c3', emailAddresses: [{ value: 'nobody@example.com' }], birthdays: [{ text: 'early May' }] } },
  ],
}

describe('contacts', () => {
  test('birthday_mapped', async () => {
    expect(birthdayOf([{ date: { year: 1990, month: 4, day: 7 } }])).toBe('1990-04-07')
    expect(birthdayOf([{ date: { month: 12, day: 24 } }])).toBe('--12-24')
    expect(birthdayOf([{ text: 'early May' }])).toBe('early May')
    expect(birthdayOf([{ date: { month: 13, day: 1 } }])).toBeUndefined()
    expect(birthdayOf(undefined)).toBeUndefined()
    expect(mapPerson({ names: [{ displayName: 'No birthday' }] })).toEqual({ name: 'No birthday', emails: [], phones: [] })

    const google = fakeGoogle((url) => (url.includes('people:searchContacts') ? { status: 200, json: new URL(url).searchParams.get('query') === '' ? {} : answer } : undefined))
    const svc = service({ ...settingsOf(google), keep: async () => {}, fetch: google.fetch })
    const result = await svc.contactsFind({ query: 'Jana' })
    expect(result.structuredContent.contacts).toEqual([
      { name: 'Jana Nováková', emails: ['jana@example.com', 'j@example.org'], phones: ['+420 600 000 000'], birthday: '1990-04-07' },
      { name: 'Petr', emails: [], phones: [], birthday: '--12-24' },
      { name: 'nobody@example.com', emails: ['nobody@example.com'], phones: [], birthday: 'early May' },
    ])
    expect(result.content[0].text).toContain('(birthday 1990-04-07)')

    // The cache is warmed once, with an empty search, and every call is a read.
    await svc.contactsFind({ query: 'Petr' })
    const people = google.calls.filter((c) => c.url.includes('people.googleapis.com'))
    expect(people.map((c) => new URL(c.url).searchParams.get('query'))).toEqual(['', 'Jana', 'Petr'])
    expect(people.every((c) => c.method === 'GET')).toBe(true)
    expect(new URL(findRequest('x').url).searchParams.get('readMask')).toContain('birthdays')
    expect((await svc.contactsFind({ query: ' ' })).isError).toBe(true)
  })
})
