// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { billPrompt, looksLikeBill, parseBill, realAmount } from '../bills.js'

test('invoice_due_and_amount', () => {
  const answer =
    'Here you go: {"bill":true,"payee":"Water Works","amount":"1 234,50","currency":"czk","due":"2026-09-15","recurring":false}'
  expect(parseBill(answer)).toEqual({
    payee: 'Water Works',
    amount: 1234.5,
    currency: 'CZK',
    due: '2026-09-15',
    recurring: false,
  })
  expect(
    parseBill('{"bill":true,"payee":"Streamly","amount":9.99,"currency":"EUR","due":"2026-10-01","recurring":true}'),
  ).toMatchObject({ amount: 9.99, recurring: true })
})

test('bad_date_rejected', () => {
  const make = (due) => `{"bill":true,"payee":"X","amount":10,"currency":"CZK","due":"${due}"}`
  expect(parseBill(make('2026-02-31'))).toBeUndefined()
  expect(parseBill(make('next Friday'))).toBeUndefined()
  expect(parseBill(make('15.9.2026'))).toBeUndefined()
  expect(parseBill(make(''))).toBeUndefined()
})

test('a bad amount, a "no", and non-JSON are rejected', () => {
  const make = (amount) => `{"bill":true,"payee":"X","amount":${amount},"currency":"CZK","due":"2026-09-15"}`
  expect(parseBill(make('"a lot"'))).toBeUndefined()
  expect(parseBill(make('-5'))).toBeUndefined()
  expect(parseBill(make('0'))).toBeUndefined()
  expect(parseBill('{"bill":false}')).toBeUndefined()
  expect(parseBill('I could not tell.')).toBeUndefined()
  expect(parseBill('{"bill":true,"payee":"X","amount":5,"currency":"koruny","due":"2026-09-15"}')).toBeUndefined()
})

test('amounts in the common spellings', () => {
  expect(realAmount('1,234.50')).toBe(1234.5)
  expect(realAmount('1.234,50')).toBe(1234.5)
  expect(realAmount('250')).toBe(250)
  expect(realAmount('12 abc')).toBeUndefined()
})

test('the pre-filter and the prompt', () => {
  expect(looksLikeBill('Faktura č. 20260012', '')).toBe(true)
  expect(looksLikeBill('Your subscription renews soon', '')).toBe(true)
  expect(looksLikeBill('Lunch on Friday?', 'See you there')).toBe(false)
  expect(billPrompt('x'.repeat(9000), 's').length).toBeLessThan(5000)
})
