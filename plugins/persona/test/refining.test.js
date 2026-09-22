// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { changed, LINES, marks, sizeOf } from '../diff.js'
import {
  HEAR,
  HEAR_UNASKED,
  HEARD,
  HEARING,
  HEARING_AT_LEAST,
  PRESS,
  refining,
  ROOM,
  SECTIONS,
  sectionOf,
  unasked,
  usable,
  WAIT,
} from '../writing.js'

/**
 * **Refine and Edit** (`plan-personality.md` improvement 2, step 7).
 *
 * *More blunt* should be a sentence, not a rewrite of the description and a hope that the
 * second draft keeps what was good about the first. Two halves: a brief whose whole job is
 * **change nothing else**, and a diff, because a press that returns four hundred words is a
 * press whose effect nobody can see.
 */

const doc = `# Chief of staff

## Who you are
You are his chief of staff.

## How you talk
- Be warm, and soften bad news.
- Keep answers short.

## What you do without being asked
- Chase the dates he set himself.

## Hard rules
1. Ask before anything with an external consequence.`

// ---- the brief ------------------------------------------------------------------------------

test('the refine brief carries the document, the change, and *nothing else* twice over', () => {
  const said = refining(doc, 'more blunt')
  expect(said).toContain(doc)
  expect(said).toContain('more blunt')
  // The failure mode here is not a bad rewrite, it is a helpful one: the hard rules reworded,
  // the name changed, a section she never had. Both guards are sentences in the brief.
  expect(said).toMatch(/change nothing else/i)
  expect(said).toMatch(/Every other line comes back word for word/i)
  expect(said).toMatch(/Keep the first line exactly as it stands/i)
  // Whole document back, not a patch: there is no format here for applying one.
  expect(said).toMatch(/Return the whole document/i)
  // And the gate is not negotiable, on this path as on Adapt's (improvement 6).
  expect(said).toMatch(/skip asking permission/i)
})

test('the refine brief is far smaller than the one Adapt sends, which is the point of it', () => {
  // D157's measurement: the description on this machine was 5,825 characters and a reasoning
  // model spent its whole budget before writing. A document and a sentence is a fraction of it.
  const description = 'x'.repeat(5_825)
  expect(refining(doc, 'more blunt').length).toBeLessThan(description.length / 2)
})

test('an empty change or an empty document still produces a well-formed brief', () => {
  // Neither is reachable from the button — index.js refuses both — but a brief that threw on
  // one would turn a sentence on screen into a crash.
  expect(() => refining(doc, '')).not.toThrow()
  expect(() => refining('', 'more blunt')).not.toThrow()
  expect(refining(undefined, undefined)).toContain('Return the whole document')
})

// ---- reading one section out of a document ----------------------------------------------------

test('a section comes back by name, and a missing one is empty rather than a throw', () => {
  expect(sectionOf(doc, 'What you do without being asked')).toBe('- Chase the dates he set himself.')
  expect(sectionOf(doc, 'WHAT YOU DO WITHOUT BEING ASKED')).toContain('Chase the dates')
  expect(sectionOf(doc, 'Something she never had')).toBe('')
  expect(sectionOf('', 'Hard rules')).toBe('')
  expect(sectionOf(undefined, 'Hard rules')).toBe('')
})

test('usable still reads the same four sections after the parse was shared', () => {
  // One parse, two readers. A second parser is a parser that drifts, and the one that drifts
  // is the one nobody tested, because whatever reaches it has already passed `usable`.
  expect(usable(doc)).toBe(true)
  for (const name of SECTIONS) expect(sectionOf(doc, name)).not.toBe('')
  expect(usable(doc.replace('## Hard rules\n1. Ask before anything with an external consequence.', '## Hard rules'))).toBe(false)
})

// ---- the diff ---------------------------------------------------------------------------------

test('one changed line is shown as one out and one in, with the lines around it for bearings', () => {
  const now = doc.replace('- Be warm, and soften bad news.', '- Be blunt. Never soften bad news.')
  const said = changed(doc, now)
  expect(said).toContain('- - Be warm, and soften bad news.')
  expect(said).toContain('+ - Be blunt. Never soften bad news.')
  expect(said).toContain('  ## How you talk')
  expect(sizeOf(doc, now)).toBe('1 line out, 1 line in')
})

test('the untouched part collapses, because a diff that reprints the document is the document', () => {
  const now = doc.replace('1. Ask before anything with an external consequence.', '1. Ask first. Always.')
  const said = changed(doc, now)
  // The one section it touched, and not the three it did not.
  expect(said).not.toContain('You are his chief of staff.')
  expect(said).not.toContain('Chase the dates')
  expect(said).toContain('+ 1. Ask first. Always.')
  // And it opens with the marker, because a change to the last section that started at the
  // last section would read as the whole document having been replaced by two lines.
  expect(said.split('\n')[0]).toBe('  …')
})

test('a line added and a line removed are each shown alone, since a change need not pair up', () => {
  // A model asked to make her blunter turns one sentence into two, or two into one. Pretending
  // every change pairs one-to-one would draw that wrong.
  const added = doc.replace('- Keep answers short.', '- Keep answers short.\n- Never apologise twice.')
  expect(changed(doc, added)).toContain('+ - Never apologise twice.')
  expect(sizeOf(doc, added)).toBe('1 line in')

  const gone = doc.replace('- Chase the dates he set himself.', 'Nothing.')
  expect(sizeOf(gone, doc)).toBe('1 line out, 1 line in')
})

test('a document that came back unchanged says so, rather than showing an empty diff', () => {
  // The real case: a small model handed *more blunt* returns exactly what it was given. An
  // empty diff under a cheerful *Changed it* would be the worst of both.
  expect(changed(doc, doc)).toMatch(/Nothing changed/)
  expect(sizeOf(doc, doc)).toBe('nothing')
})

test('something far too long to be a personality is not diffed line by line', () => {
  // `usable` caps a document at 4,000 characters, so anything reaching this got past a check.
  // The table is quadratic; saying *the whole thing changed* is honest and cheap.
  const huge = Array.from({ length: LINES + 1 }, (_, n) => `line ${String(n)}`).join('\n')
  expect(marks(doc, huge)).toBeUndefined()
  expect(changed(doc, huge)).toBe('The whole document was rewritten.')
  expect(sizeOf(doc, huge)).toBe('every line')
})

test('the diff marks every line exactly once, in order, whichever way it is handed them', () => {
  const now = doc.replace('- Keep answers short.', '- Say it in one line.')
  const all = marks(doc, now)
  expect(all.filter((one) => one.kind !== 'in').map((one) => one.text)).toEqual(doc.split('\n'))
  expect(all.filter((one) => one.kind !== 'out').map((one) => one.text)).toEqual(now.split('\n'))
})

// ---- the two buttons ---------------------------------------------------------------------------

const source = readFileSync(join(import.meta.dirname, '..', 'index.js'), 'utf8').replace(/\r\n/g, '\n')
const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'plugin.json'), 'utf8'))

test('Refine and Edit are row actions, each with a tool behind it and a box to read', () => {
  const table = manifest.settings.find((one) => one.key === 'saved')
  const actions = Object.fromEntries(table.rowActions.map((one) => [one.key, one.tool]))
  expect(actions.refine).toBe('refine')
  expect(actions.edit).toBe('edit')
  // A row action with no tool behind it renders disabled, so the pair has to hold.
  for (const tool of Object.values(actions)) expect(source).toContain(`alexia.tool(\n  '${tool}'`)
  // The boxes they read. Edit's is `multiline`, which is what took the manifest to revision 7.
  const boxes = Object.fromEntries(manifest.settings.filter((one) => one.type === 'text').map((one) => [one.key, one]))
  expect(boxes.refine_with).toBeDefined()
  expect(boxes.edit_doc.multiline).toBe(true)
  // The hint has to say where the text comes from: a plugin may write only its own `status`
  // settings, and core offers no elicitation, so there is no way to prefill this box for
  // somebody. Open the row, copy, paste, change — and the screen says so rather than leaving
  // it to be discovered.
  expect(boxes.edit_doc.hint).toMatch(/open a row/i)
})

test('a hand-written document is recorded as hand-written, not as one a model wrote', () => {
  // The table's other column is *Written by*. A document with no model behind it reading as
  // one a model wrote is a provenance line that is simply false.
  expect(source).toMatch(/wrote: 'you'/)
})

test('Refine and Edit both say when the personality they changed is the one in use', () => {
  // Neither switches anything, but changing the active row changes how she behaves from the
  // next message — which is the one thing a person needs told, and the reason Undo is named
  // in the same breath.
  expect(source.match(/const using = row\.active === 1/g)).toHaveLength(2)
  expect(source.match(/She is using it from your next message\./g)).toHaveLength(2)
  expect(source.match(/Undo brings the previous one back\./g)).toHaveLength(3)
})

// ---- hearing her before she goes live (improvement 3) -------------------------------------------

test('the second question comes from her own *What you do without being asked*', () => {
  expect(unasked(doc)).toBe('Chase the dates he set himself.')
  // The marker goes, whichever kind it is, because the line is quoted back on screen.
  expect(unasked(doc.replace('- Chase the dates', '* Chase the dates'))).toBe('Chase the dates he set himself.')
  expect(unasked(doc.replace('- Chase the dates', '1. Chase the dates'))).toBe('Chase the dates he set himself.')
})

test('a personality that does nothing unasked is asked one question, not two', () => {
  // `Nothing.` is an answer the brief explicitly allows, so it is the common case rather than a
  // broken document — and a sample proving she does nothing is a model call spent on a
  // foregone conclusion.
  const quiet = doc.replace('- Chase the dates he set himself.', 'Nothing.')
  expect(usable(quiet)).toBe(true)
  expect(unasked(quiet)).toBe('')
  expect(unasked(doc.replace('## What you do without being asked\n- Chase the dates he set himself.\n', ''))).toBe('')
  expect(unasked('')).toBe('')
})

test('the questions are a fixed one and a plain moment, never a scene somebody made up', () => {
  // The obvious alternative — asking a model to invent a situation from the section — is a
  // third call *and* puts invented facts about this person's life on screen, which is the one
  // thing every brief in this plugin forbids. So the moment is real and empty.
  expect(HEAR).toBe('who are you?')
  expect(HEAR_UNASKED.length).toBeLessThan(60)
  // Short replies and a short wait: two of these run after the document is already saved.
  expect(HEARD).toBeLessThan(ROOM)
  expect(HEARING).toBeLessThan(WAIT)
})

test('Adapt saves without switching, and the toggle is what switches that off', () => {
  // D160's Skip, from the very first time: one toggle, on by default, and off is exactly what
  // this button always did. The checks that refuse a cut-off document run either way.
  expect(source).toMatch(/const hearFirst = listen !== false/)
  expect(source).toMatch(/active: hearFirst \? 0 : 1/)
  expect(source).toMatch(/if \(!hearFirst\) await alexia\.storage\.update\('personalities', \{ active: 0 \}, \{ active: 1 \}\)/)
  const toggle = manifest.settings.find((one) => one.key === 'hear_first')
  expect(toggle.type).toBe('toggle')
  expect(toggle.default).toBe(true)
  // The label is a statement that is true when it is on (ui-schema.md).
  expect(toggle.label).toBe('Hear her before switching')
})

test('a sample that fails is a sentence about the sample, never a document lost', () => {
  // The row is already saved when the samples run, which is what makes *Skip* free: the
  // automatic checks ran whether or not anybody listens.
  const at = source.indexOf('async function hearing')
  const body = source.slice(at, source.indexOf('\n}', at))
  expect(body).toMatch(/catch \(error\)/)
  expect(body).toMatch(/failed:/)
  // And it never writes to storage — it reads a document it was handed.
  expect(body).not.toContain('alexia.storage')
})

test('writing and hearing fit into one press, because core gives a button two minutes in total', () => {
  // Adapt wrote for up to WAIT and then asked two samples of up to HEARING each — 230 seconds,
  // so the press timed out after the row was saved, said it had failed, and the retry made a
  // second row. The press has one clock now, and every sample is fitted into what is left of it.
  expect(PRESS).toBeLessThan(120_000)
  expect(WAIT).toBeLessThan(PRESS)
  expect(HEARING_AT_LEAST).toBeLessThan(HEARING)
  const at = source.indexOf('async function hearing')
  const body = source.slice(at, source.indexOf('\n}', at))
  expect(body).toMatch(/async function hearing\(docs, until = Date\.now\(\) \+ PRESS, want = 'chat'\)/)
  expect(body).toMatch(/if \(left < HEARING_AT_LEAST\)/)
  expect(body).toMatch(/timeout: Math\.min\(HEARING, left\)/)
  // Adapt starts the clock when the press arrives, not when writing is done.
  expect(source).toMatch(/const until = Date\.now\(\) \+ PRESS\n/)
  expect(source).toMatch(/await hearing\(\{ high: written\.doc, medium: written\.medium, small: written\.small \}, until, /)
})

test('Hear her is a row action of its own, so it works after Refine and Edit too', () => {
  const table = manifest.settings.find((one) => one.key === 'saved')
  const actions = table.rowActions.map((one) => one.key)
  expect(actions).toContain('hear')
  // Beside Use, which is the press it is a second opinion on.
  expect(actions.indexOf('hear')).toBe(actions.indexOf('use') + 1)
  // Read-only: it changes nothing and switches nothing, so the gate has no reason to ask.
  const at = source.indexOf("  'hear',")
  expect(at).toBeGreaterThan(-1)
  expect(source.slice(at, at + 700)).toContain('readOnlyHint: true')
})
