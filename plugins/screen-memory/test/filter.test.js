// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { DEFAULT_SKIP_APPS, MAX_TEXT, REMOVED, decide, luhn, parseSkipApps, redact } from '../filter.js'

const window = (over = {}) => ({ app: 'chrome.exe', title: 'Flights to Lisbon', fullscreen: false, titleBar: true, ...over })
const moment = (front, text = 'Prague to Lisbon from 2 190 Kč') => ({ front, text })

test('password_window_dropped', () => {
  for (const title of ['Change password – Settings', 'Zadejte HESLO', 'Sign in to your account', 'Přihlášení', 'Prihlaseni – banka']) {
    expect(decide(moment(window({ title }))), title).toEqual({ keep: false, reason: 'sign_in' })
  }
  expect(decide(moment(window())).keep).toBe(true)
})

test('skip_app_dropped', () => {
  const skip = parseSkipApps(DEFAULT_SKIP_APPS)
  for (const app of ['KeePassXC.exe', 'keepassxc.exe', '1Password.exe', 'C:\\Program Files\\Bitwarden\\Bitwarden.exe']) {
    expect(decide(moment(window({ app, title: 'Vault' })), skip), app).toEqual({ keep: false, reason: 'skipped_app' })
  }
  // The owner's own list, with and without the extension.
  const mine = parseSkipApps('Signal.exe, telegram')
  expect(decide(moment(window({ app: 'Signal.exe', title: 'Signal' })), mine).reason).toBe('skipped_app')
  expect(decide(moment(window({ app: 'Telegram.exe', title: 'Telegram' })), mine).reason).toBe('skipped_app')
  expect(decide(moment(window({ app: 'KeePassXC.exe', title: 'Vault' })), mine).keep).toBe(true)
})

test('lock screen, full screen and an unknown window are dropped', () => {
  expect(decide({ ...moment(window()), locked: true }).reason).toBe('locked')
  expect(decide(moment(window({ app: 'LockApp.exe', title: '' }))).reason).toBe('locked')
  expect(decide(moment(window({ fullscreen: true, titleBar: false }))).reason).toBe('full_screen')
  expect(decide(moment(window({ fullscreen: true, titleBar: undefined }))).reason).toBe('full_screen')
  // Maximised with a title bar is an ordinary window.
  expect(decide(moment(window({ fullscreen: true, titleBar: true }))).keep).toBe(true)
  expect(decide(moment(undefined)).reason).toBe('unknown_window')
  expect(decide(moment(window({ app: '' }))).reason).toBe('unknown_window')
  expect(decide(moment(window({ title: undefined }))).reason).toBe('unknown_window')
  expect(decide(moment(window({ fullscreen: undefined }))).reason).toBe('unknown_window')
  expect(decide(moment(window(), '   ')).reason).toBe('no_text')
})

test('card_number_redacted', () => {
  expect(luhn('4111111111111111')).toBe(true)
  expect(luhn('4111111111111112')).toBe(false)
  expect(redact('Card 4111 1111 1111 1111 exp 12/29')).toBe(`Card ${REMOVED} exp 12/29`)
  expect(redact('pay with 5555-5555-5555-4444.')).toBe(`pay with ${REMOVED}.`)
  expect(redact('amex 378282246310005')).toBe(`amex ${REMOVED}`)
  // Not Luhn-valid, or too short: an order number, a phone number.
  expect(redact('Order 4111111111111112')).toBe('Order 4111111111111112')
  expect(redact('call 777 123 456')).toBe('call 777 123 456')
  const kept = decide(moment(window({ title: 'Checkout 4111111111111111' }), 'Card 4111111111111111 saved'))
  expect(kept).toEqual(expect.objectContaining({ keep: true, text: `Card ${REMOVED} saved`, title: `Checkout ${REMOVED}` }))
})

test('token_prefix_redacted', () => {
  // Built from halves so no whole token-shaped literal sits in the source.
  const openai = ['sk', '-proj-', 'A1b2C3d4E5f6G7h8'].join('')
  const github = ['gh', 'p_', 'x'.repeat(36)].join('')
  const slack = ['xo', 'xb-', '1234-5678-abcdEFGH'].join('')
  expect(redact(`key=${openai} ok`)).toBe(`key=${REMOVED} ok`)
  expect(redact(`token: ${github}`)).toBe(`token: ${REMOVED}`)
  expect(redact(`${slack}\nnext line`)).toBe(`${REMOVED}\nnext line`)
  // Inside a word it is not a prefix.
  expect(redact('task-list and desk-lamp')).toBe('task-list and desk-lamp')
})

test('iban_redacted', () => {
  expect(redact('IBAN: CZ65 0800 0000 1920 0014 5399, thanks')).toBe(`IBAN: ${REMOVED}, thanks`)
  expect(redact('to DE89370400440532013000.')).toBe(`to ${REMOVED}.`)
  expect(redact('GB29 NWBK 6016 1331 9268 19')).toBe(REMOVED)
  // Two letters and two digits followed by words is not an account.
  expect(redact('Room AB12 is on the left')).toBe('Room AB12 is on the left')
})

test('text is capped after redaction', () => {
  const kept = decide(moment(window(), 'a'.repeat(MAX_TEXT + 500)))
  expect(kept.text.length).toBe(MAX_TEXT)
})
