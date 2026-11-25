// SPDX-License-Identifier: AGPL-3.0-only
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { birthdayOf, findRequest, mapContact, phoneDigits } from '../contacts.js'
import { fakeMicrosoft, settingsOf } from './fake.js'

process.env.ALEXIA_PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const { service } = await import('../index.js')

/** `/me/contacts`, written by hand. */
const answer = {
  value: [
    {
      id: 'c1',
      displayName: 'Jana Nováková',
      givenName: 'Jana',
      surname: 'Nováková',
      emailAddresses: [{ name: 'Jana', address: 'jana@example.com' }, { address: 'jana@example.com' }, { address: 'j@example.org' }],
      mobilePhone: '+420 600 000 000',
      businessPhones: ['+420 222 111 000'],
      homePhones: [],
      birthday: '1990-04-07T11:59:00Z',
    },
    { id: 'c2', displayName: '', givenName: 'Petr', surname: 'Svoboda', emailAddresses: [], businessPhones: [], homePhones: ['777 123 456'], birthday: '1604-12-24T00:00:00Z' },
    { id: 'c3', emailAddresses: [{ address: 'nobody@example.com' }], businessPhones: [], homePhones: [], birthday: null },
  ],
}

describe('contacts', () => {
  test('birthday_mapped', async () => {
    expect(birthdayOf('1990-04-07T00:00:00Z')).toBe('1990-04-07')
    expect(birthdayOf('1990-04-07T11:00:00Z')).toBe('1990-04-07')
    // Local midnight in Prague, saved as the evening before in UTC.
    expect(birthdayOf('1990-04-06T22:00:00Z')).toBe('1990-04-07')
    expect(birthdayOf('1990-12-31T23:00:00Z')).toBe('1991-01-01')
    // No year: Outlook files it in 1604.
    expect(birthdayOf('1604-12-24T00:00:00Z')).toBe('--12-24')
    expect(birthdayOf('1990-13-01T00:00:00Z')).toBeUndefined()
    expect(birthdayOf(null)).toBeUndefined()
    expect(mapContact({ displayName: 'No birthday' })).toEqual({ name: 'No birthday', emails: [], phones: [] })

    const ms = fakeMicrosoft((url) => (new URL(url).pathname === '/v1.0/me/contacts' ? { status: 200, json: answer } : undefined))
    const svc = service({ ...settingsOf(ms), keep: async () => {}, fetch: ms.fetch })
    const result = await svc.contactsFind({ query: 'Jana' })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent.contacts).toEqual([
      { name: 'Jana Nováková', emails: ['jana@example.com', 'j@example.org'], phones: ['+420 600 000 000', '+420 222 111 000'], birthday: '1990-04-07' },
      { name: 'Petr Svoboda', emails: [], phones: ['777 123 456'], birthday: '--12-24' },
      { name: 'nobody@example.com', emails: ['nobody@example.com'], phones: [] },
    ])
    expect(result.content[0].text).toContain('(birthday 1990-04-07)')

    const asked = new URL(ms.calls.find((c) => c.url.startsWith('https://graph.microsoft.com')).url)
    expect(asked.searchParams.get('$filter')).toBe("startswith(displayName,'Jana') or startswith(givenName,'Jana') or startswith(surname,'Jana')")
    expect(asked.searchParams.get('$select')).toContain('birthday')
    expect(ms.calls.filter((c) => c.url.startsWith('https://graph.microsoft.com')).every((c) => c.method === 'GET')).toBe(true)
    expect((await svc.contactsFind({ query: ' ' })).isError).toBe(true)
  })

  test('an email is matched exactly, a quote is escaped, a phone is scanned', async () => {
    expect(new URL(findRequest('Jana@Example.com').url).searchParams.get('$filter')).toBe("emailAddresses/any(a:a/address eq 'jana@example.com')")
    expect(new URL(findRequest("O'Brien").url).searchParams.get('$filter')).toContain("startswith(surname,'O''Brien')")
    expect(phoneDigits('+420 777-123')).toBe('420777123')
    expect(phoneDigits('12')).toBeUndefined()
    expect(phoneDigits('Jana 777')).toBeUndefined()

    // Graph cannot filter by phone: pages are read and the digits matched here.
    const ms = fakeMicrosoft((url) => {
      const u = new URL(url)
      if (u.pathname !== '/v1.0/me/contacts') return undefined
      if (u.searchParams.get('$skip') === '100') return { status: 200, json: { value: [answer.value[1]] } }
      return { status: 200, json: { value: [answer.value[0], answer.value[2]], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/contacts?$skip=100' } }
    })
    const svc = service({ ...settingsOf(ms), keep: async () => {}, fetch: ms.fetch })
    const found = await svc.contactsFind({ query: '777 123' })
    expect(found.structuredContent.contacts.map((c) => c.name)).toEqual(['Petr Svoboda'])
    const pages = ms.calls.filter((c) => c.url.startsWith('https://graph.microsoft.com'))
    expect(pages).toHaveLength(2)
    expect(new URL(pages[0].url).searchParams.has('$filter')).toBe(false)
  })
})
