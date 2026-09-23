// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { due, line } from '../ledger.js'

/**
 * `commitments.due` — what a morning summary should say, for another plugin to send.
 *
 * The choosing is here, without a wire, a host or a process, the same trade `ledger.test.js`
 * makes. What is left over is the promise itself — that the manifest says it, a tool binds it
 * and the register lists it — because a capability name spelled one way at one end and another
 * at the other fails silently: a summary that never arrives, and nothing saying why.
 */

const TODAY = '2026-08-29'
const open = { text: 'Send the grant draft', by: '2026-08-25', mine: 1, state: 'open', nudges: 0 }

test('due is open and today or late, oldest first — and nothing without a day', () => {
  const rows = [
    { ...open, text: 'late', by: '2026-08-25' },
    { ...open, text: 'today', by: TODAY },
    { ...open, text: 'next month', by: '2026-09-30' },
    // Outstanding, and `promised` says so — but not due, and a morning that repeats it forever
    // is a morning somebody stops reading.
    { ...open, text: 'someday', by: undefined },
    { ...open, text: 'someday too', by: '' },
    { ...open, text: 'done', by: '2026-08-01', state: 'kept' },
    { ...open, text: 'dropped', by: '2026-08-01', state: 'dropped' },
    { ...open, text: 'oldest', by: '2026-08-01' },
  ]
  expect(due(rows, TODAY).map((row) => row.text)).toEqual(['oldest', 'late', 'today'])
})

test('nothing due is nothing, so the caller’s rule is *send it if it says anything*', () => {
  expect(due([], TODAY)).toEqual([])
  expect(due([{ ...open, by: '2026-09-30' }], TODAY)).toEqual([])
})

test('the lines say which were late and which are today, in the tense each is in', () => {
  const [late, today] = due([{ ...open, by: TODAY }, open], TODAY)
  expect(line(late, TODAY)).toContain('was due 2026-08-25')
  expect(line(today, TODAY)).toContain(`by ${TODAY}`)
})

test('the manifest promises it, a tool binds it, and the register lists it', () => {
  const here = join(import.meta.dirname, '..')
  const manifest = JSON.parse(readFileSync(join(here, 'plugin.json'), 'utf8'))
  expect(manifest.provides).toContain('commitments.due')

  const source = readFileSync(join(here, 'index.js'), 'utf8')
  expect(source).toContain(`_meta: { 'alexia/provides': ['commitments.due'] }`)
  // Read-only, so the default permission mode never stops a morning summary to ask.
  expect(source).toMatch(/'due',[\s\S]*?readOnlyHint: true[\s\S]*?'alexia\/provides': \['commitments\.due'\]/)

  const register = readFileSync(join(here, '..', '..', 'docs', 'spec', 'capabilities.md'), 'utf8')
  expect(register).toContain('`commitments.due`')
})
