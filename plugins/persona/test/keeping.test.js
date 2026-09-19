// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { priorOf, provenance, versionOf } from '../writing.js'

/**
 * Keeping the words with the personality (plan-personality.md step 4a, improvement 1).
 *
 * The rule every one of these encodes: **a row written before any of this existed is the
 * normal case, not an error.** A plugin table grows a column the first time a key appears, so
 * every personality already saved on this machine reads back `undefined` for all of it, and
 * each reader has to say something true rather than throw or invent.
 */

const row = {
  rowid: 1,
  name: 'Chief of staff',
  doc: '# Chief of staff\n\nBe blunt.',
  described: 'blunt, calls me Vacen, no emojis',
  wrote: 'anthropic/claude-opus-4',
  at: Date.parse('2026-09-18T10:00:00Z'),
}

test('a row carries the words it was adapted from, who wrote it, and when', () => {
  expect(versionOf(row)).toEqual({
    doc: '# Chief of staff\n\nBe blunt.',
    described: 'blunt, calls me Vacen, no emojis',
    wrote: 'anthropic/claude-opus-4',
    at: Date.parse('2026-09-18T10:00:00Z'),
  })
  const said = provenance(row)
  expect(said).toContain('blunt, calls me Vacen, no emojis')
  expect(said).toContain('anthropic/claude-opus-4')
  expect(said).toContain('2026-09-18')
})

test('a personality saved before any of this was kept still reads back', () => {
  // Exactly what is in the database on this Mac today: a name, a document, a date, nothing else.
  const old = { rowid: 2, name: 'Old one', doc: '# Old one\n\nBe kind.', at: Date.parse('2026-08-01T10:00:00Z') }
  expect(versionOf(old)).toEqual({ doc: '# Old one\n\nBe kind.', described: '', wrote: '', at: Date.parse('2026-08-01T10:00:00Z') })
  // No invented description and no invented writer — only the one thing that is actually known.
  const said = provenance(old)
  expect(said).toBe('Written on 2026-08-01')
  expect(said).not.toContain('Adapted from')
  // And nothing to undo, which is what stops Undo offering to restore a version that never was.
  expect(priorOf(old)).toBeUndefined()
})

test('the previous version comes back off the row as JSON text, the way storage returns it', () => {
  const was = { doc: '# Chief of staff\n\nBe terse.', described: 'terse', wrote: 'meta/llama', at: 1 }
  // storage.md: objects are stored as JSON text and come back as text. A reader that assumed
  // an object would work in a unit test and fail against the real database.
  expect(priorOf({ ...row, previous: JSON.stringify(was) })).toEqual(was)
  expect(priorOf({ ...row, previous: was })).toEqual(was)
})

test('a previous version that cannot be read is no previous version, not a crash', () => {
  expect(priorOf({ ...row, previous: 'not json{' })).toBeUndefined()
  expect(priorOf({ ...row, previous: '' })).toBeUndefined()
  expect(priorOf({ ...row, previous: null })).toBeUndefined()
})

test('provenance says a previous version is kept, so Undo is discoverable before it is pressed', () => {
  const said = provenance({ ...row, previous: JSON.stringify({ doc: '#x', described: 'y', wrote: 'z', at: Date.parse('2026-09-01T10:00:00Z') }) })
  expect(said).toContain('2026-09-01')
  expect(said).toMatch(/Undo/)
  // And says nothing about one when there is none.
  expect(provenance(row)).not.toMatch(/Undo/)
})

/**
 * D157's clamps, checked against the source rather than a running plugin — and the reason
 * that is worth doing.
 *
 * Adding Re-adapt meant pulling Adapt's model call out into a shared `write()`, and an
 * extraction is exactly how these get lost: the clamps are four unrelated-looking lines in
 * the middle of a call, and a refactor that keeps the call keeps working without them. It
 * fails later, on a slow reasoning model, as a personality that saved half-written — which
 * is D157's original bug (2026-09-15), and it reads as chosen, so nobody notices.
 *
 * This cannot be a behaviour test: `write()` is module-private and index.js starts a plugin
 * on import. So it reads the file. A structural check is weaker than a behaviour one, and it
 * is the strongest thing available here that fails if the clamps go missing.
 */
const source = readFileSync(join(import.meta.dirname, '..', 'index.js'), 'utf8')

test('the model call is made once, so Adapt, Re-adapt and Refine cannot drift apart', () => {
  // Two calls in the file, and they are two different jobs. The document is written by one
  // helper that every button goes through; the samples are asked by another, and the samples
  // must **not** carry `modelPreferences` — a sample written by a better model than the one
  // that will actually read her is a sample that lies in the one direction that matters.
  expect(source.match(/createMessage\(/g)).toHaveLength(2)
  // One of the two asks for a capable model; the other must not, so it is the only `:` form —
  // and it is not the one inside `hearing()`, whose body is read out here and checked.
  expect(source.match(/modelPreferences: /g)).toHaveLength(1)
  const from = source.indexOf('async function hearing')
  expect(from).toBeGreaterThan(-1)
  const body = source.slice(from, source.indexOf('\n}', from))
  expect(body).toContain('createMessage(')
  expect(body).not.toContain('modelPreferences')
  // All three buttons reach it through the one helper rather than calling a model themselves,
  // handing in a brief rather than a description — which is what lets Refine send a document
  // and a sentence instead of the 1,300-token description that ran a model out of room.
  expect(source).toMatch(/const written = await write\(ctx, brief\(description, name\)\)/)
  expect(source).toMatch(/const written = await write\(ctx, brief\(was\.described, String\(row\.name\)\)\)/)
  expect(source).toMatch(/const written = await write\(ctx, refining\(was\.doc, change\), STEPS\.refine\)/)
  // And the previous version is kept by one function, not by each of them remembering to.
  // *The version it replaces is kept* is printed on three row-action labels.
  expect(source.match(/await keep\(row, was, /g)).toHaveLength(3)
})

test('D157 survives the extraction: room to think, time to answer, and a cut answer refused', () => {
  // The budget, by name. A literal here would be the 1,200 that caused the bug.
  expect(source).toMatch(/maxTokens: ROOM/)
  expect(source).not.toMatch(/maxTokens: \d/)
  // The timeout, which the SDK defaults to 60 s without.
  expect(source).toMatch(/timeout: WAIT/)
  // A rung that can actually write.
  expect(source).toMatch(/intelligencePriority: 0\.8/)
  // And the guard that stops half a personality being saved as if it were whole.
  expect(source).toMatch(/stopReason === 'maxTokens'/)
  // Plus the four-section check, which catches an Alexia too old to report a stop reason.
  expect(source).toMatch(/!usable\(doc\)/)
})
