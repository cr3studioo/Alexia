// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { asked, inert, inertNote, lineOf, MEANS, wants } from '../promises.js'

/**
 * **Lines she cannot act on** (`plan-personality.md` improvement 4).
 *
 * D103's lesson a second time: *What you do without being asked* is the section that actually
 * changes behaviour, so a line in it with nothing behind it is **inert** — she does not do it,
 * nothing says why, and the person reads it as *she ignores me*.
 *
 * The rule every one of these encodes: **silence about a line means nothing was checked, never
 * that the line is fine.** Core can answer one question — *would anything answer this
 * capability?* — about a fixed list of names, so a line asking for something no capability has
 * a name for is left alone and said to be left alone.
 */

const section = `- Remember what I tell you about my projects.
- Chase the dates he set himself.
- Read my PDFs out loud.`

test('a line is read for what it asks for, and a line that asks for nothing nameable is left alone', () => {
  expect(wants(section).map((one) => one.line)).toEqual([
    'Remember what I tell you about my projects.',
    'Read my PDFs out loud.',
  ])
  // *Chase the dates he set himself* is the most important line in that personality and no
  // capability has a name for it. It is not checked, and it is not claimed to be fine.
  expect(wants(section).some((one) => one.line.startsWith('Chase'))).toBe(false)
  // A line may ask for two things, and either one missing makes it inert.
  expect(wants(section)[1]?.caps).toEqual(['voice.speak', 'document.extract'])
  expect(asked(section)).toEqual(['memory.remember', 'voice.speak', 'document.extract'])
})

test('the bullet comes off and nothing else does, because the line is quoted back', () => {
  expect(lineOf('- Chase the dates.')).toBe('Chase the dates.')
  expect(lineOf('  * Chase the dates.')).toBe('Chase the dates.')
  expect(lineOf('1. Chase the dates.')).toBe('Chase the dates.')
  expect(lineOf('2) Chase the dates.')).toBe('Chase the dates.')
  expect(lineOf('Chase the dates.')).toBe('Chase the dates.')
})

test('`Nothing.` is an answer the brief allows, so it is not a line to check', () => {
  expect(wants('Nothing.')).toEqual([])
  expect(wants('nothing')).toEqual([])
  expect(wants('')).toEqual([])
  expect(wants(undefined)).toEqual([])
})

test('matching is on whole words, so a word inside another word is not a promise', () => {
  // The failure a substring match makes, and it makes it silently: a line flagged for a word
  // it does not contain is a finding somebody cannot argue with because it is not there.
  expect(wants('- Keep a remembrance of nothing.')).toEqual([])
  expect(wants('- Be voiceless about it.')).toEqual([])
  expect(wants('- Remember it.')).toHaveLength(1)
})

test('a line whose capability is answered is not flagged, and one whose is not is', () => {
  const all = (answers) => Object.fromEntries(MEANS.map((one) => [one.cap, { answers, here: false }]))
  expect(inert(section, all(true))).toEqual([])
  expect(inert(section, all(false)).map((one) => one.line)).toEqual([
    'Remember what I tell you about my projects.',
    'Read my PDFs out loud.',
  ])
  // A capability core said nothing about reads as *not answered*: money is the only axis in
  // this codebase where forgetting fails open, and this one is a sentence on a screen.
  expect(inert(section, {}).map((one) => one.line)).toHaveLength(2)
})

test('switched off and not installed are different sentences, because they are different afternoons', () => {
  const off = { 'memory.remember': { answers: false, here: true } }
  const gone = { 'memory.remember': { answers: false, here: false } }
  expect(inert('- Remember my projects.', off)[0]?.why).toContain('switched off')
  expect(inert('- Remember my projects.', gone)[0]?.why).not.toContain('switched off')
  // One is a switch two inches away; the other is a search through a library.
  expect(inert('- Remember my projects.', gone)[0]?.why).toContain('remembers things between conversations')
})

test('the note says what was looked at, not only what failed', () => {
  const all = (answers) => Object.fromEntries(MEANS.map((one) => [one.cap, { answers, here: false }]))
  // A check that reports only failures reads as a guarantee about everything it did not
  // mention — and this one looks at a line only when the line's own words name something.
  expect(inertNote(inert(section, all(true)), wants(section).length)).toMatch(/Checked 2 of her unasked behaviours/)
  const bad = inertNote(inert(section, all(false)), wants(section).length)
  expect(bad).toMatch(/2 lines here have nothing behind them/)
  expect(bad).toContain('“Read my PDFs out loud.”')
  // Flagged, never removed. `safety.js` removes, because a line telling her to skip asking must
  // not reach a model; a line she cannot act on is disappointing rather than dangerous, and
  // deciding it is worthless is the person's call.
  expect(bad).toMatch(/kept exactly as written/)
  // Nothing nameable in the section at all: nothing is said, rather than a clean bill of health.
  expect(inertNote([], 0)).toBe('')
})

test('every capability this file names is one a shipped plugin actually provides', () => {
  // A name invented locally is a name that matches nothing forever, silently — and it fails
  // in the quietest possible way, as a check that always says *nothing here does that*. Held
  // against what the plugins in this repo declare, which is the thing that decides it, and
  // against the register in `docs/spec/capabilities.md`, which is where an author looks.
  const here = join(import.meta.dirname, '..', '..')
  const provided = new Set(
    readdirSync(here, { withFileTypes: true })
      .filter((one) => one.isDirectory())
      .flatMap((one) => {
        const manifest = join(here, one.name, 'plugin.json')
        if (!existsSync(manifest)) return []
        return (JSON.parse(readFileSync(manifest, 'utf8')).provides ?? [])
      }),
  )
  const register = readFileSync(join(here, '..', 'docs', 'spec', 'capabilities.md'), 'utf8')
  for (const one of MEANS) {
    expect(provided, one.cap).toContain(one.cap)
    expect(register, one.cap).toContain(`\`${one.cap}\``)
  }
})

test('the plugin asks core one capability at a time, and fails silent', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'index.js'), 'utf8')
  expect(source).toMatch(/await alexia\.answers\(cap\)/)
  // A core too old to know the method, a method that throws, a name nobody recognises: the
  // line is simply not checked. Reading a failure as *missing* would put a finding on screen
  // about a plugin that is sitting there working.
  expect(source).toMatch(/\.catch\(\(\) => \(\{ answers: true, here: false \}\)\)/)
  // And it is asked again when a row is opened rather than stored with it: what is installed
  // changes, and a finding saved in September is a finding about September.
  expect(source).toMatch(/await inertLines\(String\(row\.doc\)\)/)
})
