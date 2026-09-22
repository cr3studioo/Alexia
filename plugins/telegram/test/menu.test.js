// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { commandsFrom, helpLines, menu, OWN } from '../menu.js'

// The "/" menu is built from core's own command list rather than kept in step by hand, so
// what is worth pinning down is the two ways core's answer can arrive (the `_meta` key, or
// the older plain-text `/help` reply) and the rules Telegram itself enforces on the result.

test('commandsFrom prefers the _meta key when it is there', () => {
  const result = {
    _meta: { 'alexia/command': [{ name: 'new', summary: 'Start a new chat.' }] },
    content: { type: 'text', text: 'ignored, because _meta was present' },
  }
  expect(commandsFrom(result)).toEqual([{ name: 'new', summary: 'Start a new chat.' }])
})

test('commandsFrom falls back to parsing the /help text', () => {
  const result = {
    content: {
      type: 'text',
      text: 'Here is what I can do:\n/new — Start a new chat.\n/cheap - Prefer cheap models.\nnot a command line',
    },
  }
  expect(commandsFrom(result)).toEqual([
    { name: 'new', summary: 'Start a new chat.' },
    { name: 'cheap', summary: 'Prefer cheap models.' },
  ])
})

test('commandsFrom is empty for a result that says nothing usable', () => {
  expect(commandsFrom({})).toEqual([])
  expect(commandsFrom(undefined)).toEqual([])
  expect(commandsFrom({ content: { type: 'text', text: 'no commands here' } })).toEqual([])
})

test('menu drops namespaced and hyphenated names, and anything not Telegram-shaped', () => {
  const list = [
    { name: 'commitments.due', summary: 'not a valid Telegram command' },
    { name: 'do-thing', summary: 'not a valid Telegram command either' },
    { name: 'New', summary: 'uppercase is not allowed' },
    { name: 'cheap', summary: 'Prefer cheap models.' },
  ]
  expect(menu(list)).toEqual([{ command: 'cheap', description: 'Prefer cheap models.' }, ...menuOfOwn()])
})

test('menu de-duplicates, first wins', () => {
  const list = [
    { name: 'cheap', summary: 'first one' },
    { name: 'cheap', summary: 'second one, dropped' },
  ]
  expect(menu(list)).toEqual([{ command: 'cheap', description: 'first one' }, ...menuOfOwn()])
})

test('menu appends OWN, and does not duplicate it if core already sent it', () => {
  const withoutOwn = menu([{ name: 'cheap', summary: 'Prefer cheap models.' }])
  expect(withoutOwn.map((c) => c.command)).toEqual(['cheap', 'stop', 'panel'])

  const withOwn = menu([{ name: 'stop', summary: "core's own version" }])
  expect(withOwn).toEqual([{ command: 'stop', description: "core's own version" }, { command: 'panel', description: OWN[1].summary }])
})

test('menu falls back to the name when the description is empty, after trimming', () => {
  expect(menu([{ name: 'new', summary: '   ' }])).toEqual([{ command: 'new', description: 'new' }, ...menuOfOwn()])
})

test('menu trims an overlong description to 256 characters', () => {
  const long = 'x'.repeat(300)
  const [first] = menu([{ name: 'new', summary: long }])
  expect(first.description).toHaveLength(256)
})

test('menu never exceeds 100 entries', () => {
  const list = Array.from({ length: 150 }, (_, i) => ({ name: `cmd${i}`, summary: `command ${i}` }))
  expect(menu(list)).toHaveLength(100)
})

test('helpLines is OWN as /name — summary lines', () => {
  expect(helpLines()).toBe(OWN.map((c) => `/${c.name} — ${c.summary}`).join('\n'))
})

/** OWN, in the shape `menu()` would have produced it, for tests that just want it appended. */
function menuOfOwn() {
  return OWN.map((c) => ({ command: c.name, description: c.summary }))
}
