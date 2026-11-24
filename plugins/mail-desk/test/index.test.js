// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { createDesk } from '../desk.js'

const NOW = Date.parse('2026-09-10T08:00:00Z')
const HOUR = 3_600_000

/** An in-memory stand-in for the plugin's storage: just the calls the desk makes. */
function memoryStorage() {
  const tables = new Map()
  const kv = new Map()
  const rows = (t) => tables.get(t) ?? tables.set(t, []).get(t)
  const match = (row, where = {}) => Object.entries(where).every(([k, v]) => row[k] === v)
  return {
    insert: async (t, row) => {
      const r = rows(t)
      r.push({ rowid: r.length + 1, ...row })
      return r.length
    },
    select: async (t, { where, order, limit } = {}) => {
      let found = rows(t).filter((r) => match(r, where))
      if (order) {
        const [[col, dir]] = order
        found = [...found].sort((a, b) => (dir === 'desc' ? 1 : -1) * (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0))
      }
      return found.slice(0, limit ?? 100)
    },
    update: async (t, set, where) => {
      const hit = rows(t).filter((r) => match(r, where))
      for (const r of hit) Object.assign(r, set)
      return hit.length
    },
    count: async (t, where) => rows(t).filter((r) => match(r, where)).length,
    get: async (k) => kv.get(k),
    set: async (k, v) => void kv.set(k, v),
  }
}

const mail = (id, over = {}) => ({
  id,
  threadId: `t-${id}`,
  from: 'Shop <orders@shop.example>',
  subject: 'Hello',
  snippet: 'hi',
  at: NOW - HOUR,
  labels: [],
  ...over,
})

/** A desk over fake mail. `texts` maps id → body; the capability log is returned. */
function setup({ inbox = [], sent = [], texts = {}, answers = [], important = '' } = {}) {
  const calls = []
  const prompts = []
  const storage = memoryStorage()
  const capability = async (cap, args) => {
    calls.push({ cap, args })
    if (cap === 'mail.list') {
      const messages = args.query === 'in:sent' ? sent : inbox
      return { content: [{ type: 'text', text: '' }], structuredContent: { messages } }
    }
    if (cap === 'mail.read') return { content: [{ type: 'text', text: texts[args.id] ?? '' }], structuredContent: { text: texts[args.id] ?? '' } }
    throw new Error(`unexpected capability ${cap}`)
  }
  const sample = async (text) => {
    prompts.push(text)
    const next = answers.shift()
    return typeof next === 'function' ? next(text) : (next ?? '[]')
  }
  const desk = createDesk({ capability, sample, storage, settings: async () => ({ important }), now: () => NOW })
  return { desk, calls, prompts, storage }
}

test('never_calls_anything_but_list_and_read', async () => {
  const { desk, calls } = setup({
    inbox: [mail('a'), mail('b', { threadId: 't-own' })],
    sent: [mail('s', { threadId: 't-own', labels: ['SENT'] })],
    texts: { a: 'Your invoice is due 2026-09-20', b: 'Re: lunch' },
    answers: ['[{"id":"a","class":"read_later","reason":"x"}]', '{"bill":false}'],
  })
  await desk.poll()
  await desk.noticeItems({ now: NOW })
  await desk.briefSection({ kind: 'morning', now: NOW })
  expect(calls.length).toBeGreaterThan(0)
  expect([...new Set(calls.map((c) => c.cap))].sort()).toEqual(['mail.list', 'mail.read'])
  // And nothing in the source reaches for any other capability.
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js'), 'utf8')
  const used = [...src.matchAll(/capability\(\s*['"]([\w.]+)['"]/g)].map((m) => m[1])
  expect(used).toEqual([])
  const desks = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'desk.js'), 'utf8')
  const wired = [...desks.matchAll(/capability\(\s*['"]([\w.]+)['"]/g)].map((m) => m[1])
  expect(wired.every((c) => c === 'mail.list' || c === 'mail.read')).toBe(true)
})

test('poll sorts new mail, files parcels and bills, and does not look at the same mail twice', async () => {
  const inbox = [
    mail('a', { from: 'Ms Novak <novak@school.example>', subject: 'Trip money' }),
    mail('b', { from: 'Carrier <no-reply@ppl.example>', subject: 'Your parcel' }),
    mail('c', { from: 'Water Works <billing@water.example>', subject: 'Invoice 7' }),
    mail('d', { from: 'Friend <f@x.example>', threadId: 't-own', subject: 'Re: plan' }),
  ]
  const { desk, storage, prompts, calls } = setup({
    inbox,
    sent: [mail('s', { threadId: 't-own', labels: ['SENT'] })],
    important: 'school.example',
    texts: {
      a: 'Please bring the money.',
      b: 'PPL tracking number 40012345678 is out for delivery. Expected 2026-09-10.',
      c: 'Invoice 7. Pay 1 234,50 CZK by 2026-09-20.',
      d: 'Sounds good',
    },
    answers: [
      '[{"id":"b","class":"read_later","reason":"parcel mail"},{"id":"c","class":"act","reason":"pay the water bill"}]',
      '{"bill":true,"payee":"Water Works","amount":"1 234,50","currency":"CZK","due":"2026-09-20","recurring":false}',
    ],
  })
  expect(await desk.poll()).toEqual({ fresh: 4, filed: 4 })
  const classes = Object.fromEntries((await desk.inbox()).map((r) => [r.id, r.class]))
  expect(classes).toEqual({ a: 'act', b: 'read_later', c: 'act', d: 'reply' })
  expect(prompts[0]).not.toContain('Please bring the money') // the important one never went to the model
  expect(await desk.parcels()).toMatchObject([{ carrier: 'PPL', number: '40012345678', state: 'out_for_delivery', eta: '2026-09-10' }])
  expect(await desk.bills()).toMatchObject([{ payee: 'Water Works', amount: 1234.5, currency: 'CZK', due: '2026-09-20', state: 'open' }])
  // The tables keep ids and classes, never the mail's text.
  const stored = JSON.stringify(await storage.select('seen'))
  expect(stored).not.toContain('money')
  expect(stored).not.toContain('Trip')
  // Second poll: the newest-seen cursor moved on, so the list is asked for newer mail only.
  const lists = calls.filter((c) => c.cap === 'mail.list' && c.args.query === undefined)
  expect(lists[0].args.since).toBe(NOW - 3 * 24 * HOUR)
  await desk.poll()
  const again = calls.filter((c) => c.cap === 'mail.list' && c.args.query === undefined)
  expect(again[1].args.since).toBe(NOW - HOUR)
  expect((await desk.inbox()).length).toBe(4)
})

test('mail the model failed on is tried again, not filed', async () => {
  const { desk } = setup({ inbox: [mail('a')], texts: { a: 'hi' }, answers: [() => { throw new Error('down') }] })
  expect(await desk.poll()).toEqual({ fresh: 1, filed: 0 })
  expect(await desk.inbox()).toEqual([])
})

test('notice_items_shape', async () => {
  const { desk, storage } = setup()
  const day = (n) => new Date(NOW + n * 86_400_000).toISOString().slice(0, 10)
  await storage.insert('seen', { id: 'm1', at: NOW - HOUR, class: 'act', reason: 'pay the school trip', sender: 'Ms Novak' })
  await storage.insert('seen', { id: 'm2', at: NOW - HOUR, class: 'reply', reason: '', sender: 'Friend' })
  await storage.insert('seen', { id: 'm3', at: NOW - HOUR, class: 'noise', reason: 'ad', sender: 'Shop' })
  await storage.insert('seen', { id: 'm4', at: NOW - 5 * 86_400_000, class: 'act', reason: 'old', sender: 'Old' })
  await storage.insert('parcels', { carrier: 'PPL', number: '1', what: 'Shop', state: 'out_for_delivery', at: NOW - HOUR })
  await storage.insert('parcels', { carrier: 'DPD', number: '2', what: 'Eshop', state: 'delivered', at: NOW - HOUR })
  await storage.insert('bills', { payee: 'Water Works', amount: 1234.5, currency: 'CZK', due: day(3), recurring: 0, mail_id: 'c', state: 'open' })
  await storage.insert('bills', { payee: 'Streamly', amount: 9.99, currency: 'EUR', due: day(2), recurring: 1, mail_id: 'e', state: 'open' })
  await storage.insert('bills', { payee: 'Far Away', amount: 5, currency: 'EUR', due: day(60), recurring: 0, mail_id: 'f', state: 'open' })
  await storage.insert('bills', { payee: 'Paid Co', amount: 5, currency: 'EUR', due: day(1), recurring: 0, mail_id: 'g', state: 'paid' })

  const items = await desk.noticeItems({ now: NOW, tz_offset_min: 0 })
  const byKey = Object.fromEntries(items.map((i) => [i.key, i]))
  expect(Object.keys(byKey).sort()).toEqual(['bill:1', 'bill:2', 'mail:m1', 'mail:m2', 'parcel:1', 'parcel:2'])
  expect(byKey['mail:m1']).toMatchObject({ urgency: 'normal', why: 'From Ms Novak: pay the school trip' })
  expect(byKey['mail:m2'].why).toBe('From Friend.')
  expect(byKey['parcel:1']).toMatchObject({ urgency: 'low' })
  expect(byKey['parcel:2']).toMatchObject({ urgency: 'low', why: 'Delivered.' })
  expect(byKey['bill:1']).toMatchObject({ dueAt: Date.parse(`${day(3)}T09:00:00Z`) })
  expect(byKey['bill:1'].urgency).toBeUndefined()
  expect(byKey['bill:2']).toMatchObject({ urgency: 'low' }) // a renewal 2 days ahead
  for (const item of items) {
    expect(typeof item.key).toBe('string')
    expect(typeof item.text).toBe('string')
    expect(typeof item.why).toBe('string')
  }
  // Delivered is said once; Done on a mail notice stops it.
  const second = await desk.noticeItems({ now: NOW })
  expect(second.map((i) => i.key)).not.toContain('parcel:2')
  expect(await desk.noticeDone('mail:m1')).toEqual({ closed: true })
  expect(await desk.noticeDone('bill:1')).toEqual({ closed: false })
  expect((await desk.noticeItems({ now: NOW })).map((i) => i.key)).not.toContain('mail:m1')
})

test('brief sections: morning, evening, weekly; bill_paid', async () => {
  const { desk, storage } = setup()
  await storage.insert('seen', { id: 'm1', at: NOW - HOUR, class: 'act', reason: 'pay the trip', sender: 'Ms Novak' })
  await storage.insert('seen', { id: 'm2', at: NOW - HOUR, class: 'reply', reason: 'asks about Friday', sender: 'Friend' })
  await storage.insert('seen', { id: 'm3', at: NOW - HOUR, class: 'noise', reason: '', sender: 'Shop' })
  const morning = await desk.briefSection({ kind: 'morning', now: NOW })
  expect(morning).toContain('1 to act on, 1 to reply to')
  expect(morning).toContain('- Ms Novak: pay the trip')
  expect(await desk.briefSection({ kind: 'evening', now: NOW })).toContain('- Friend: asks about Friday')
  await storage.insert('bills', { payee: 'Water Works', amount: 100, currency: 'CZK', due: '2026-09-14', recurring: 0, mail_id: 'c', state: 'open' })
  const weekly = await desk.briefSection({ kind: 'weekly', now: NOW })
  expect(weekly).toContain('Water Works: 100 CZK, due 2026-09-14')
  expect(await desk.briefSection({ kind: 'bogus', now: NOW })).toBe('')
  expect(await desk.billPaid('1')).toMatchObject({ found: true, payee: 'Water Works' })
  expect(await desk.briefSection({ kind: 'weekly', now: NOW })).toBe('')
  expect(await desk.billPaid('99')).toEqual({ found: false })
})
