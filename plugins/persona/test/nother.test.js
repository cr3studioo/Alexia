// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { refining } from '../writing.js'

/**
 * **Improvement 10, joined with *Bad answer*** (`plan-personality.md` step 8), and the header
 * chip deferred from improvement 8.
 *
 * *That wasn't her* turns *something is off* into a fix without anybody having to find the
 * words for a system prompt. It is the sibling of *Bad answer* and asks the opposite question:
 * that one is about the **model** — it was wrong, ask something else — and this one is about
 * the **personality**, so nothing is re-asked and nothing is discarded.
 */

const source = readFileSync(join(import.meta.dirname, '..', 'index.js'), 'utf8')
const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'plugin.json'), 'utf8'))

test('a mark is a pair, because one half of it teaches nothing', () => {
  // *That was too formal* is an opinion. *He asked X, she said Y, she should have said Z* is
  // an example, and an example is the only one of the two a brief can use.
  expect(source).toMatch(/answer: \{ type: 'string'/)
  expect(source).toMatch(/asked: \{ type: 'string'/)
  expect(source).toMatch(/said: \{ type: 'string'/)
  // Only the answer is required: a press on its own already says the useful thing, and the
  // box that opens afterwards is a kindness rather than a form.
  expect(source).toMatch(/required: \['answer'\]/)
})

test('a mark belongs to the personality that was in use, and to no other', () => {
  // A mark collected under one personality is not evidence about another, and Refine reads
  // only its own row's — or tuning one would be shaped by complaints about a different voice.
  expect(source).toMatch(/personality: Number\(using\.rowid\)/)
  expect(source).toMatch(/where: \{ personality: Number\(row\.rowid\) \}/)
  // With nothing in use there is no character it could have been out of, so it says so
  // rather than filing the mark against nothing.
  expect(source).toMatch(/there is no personality for that to be out of character for/)
})

test('only the last few are kept, because a brief that is mostly complaints is about complaining', () => {
  expect(source).toMatch(/const MOMENTS = 4/)
  expect(source).toMatch(/mine\.slice\(MOMENTS\)/)
  expect(source).toMatch(/limit: MOMENTS/)
})

test('the evidence goes after the document and is labelled as evidence, not as instructions', () => {
  const moments = [{ asked: 'how is it going', answer: 'I would be delighted to assist!', said: 'Fine. Two things are late.' }]
  const said = refining('# X\n\ndoc', 'more blunt', moments)
  // After: the change above is what was asked for, and a model handed four complaints first
  // rewrites the personality around them instead of doing the one thing.
  expect(said.indexOf('She said: I would be delighted')).toBeGreaterThan(said.indexOf('The document:'))
  expect(said).toMatch(/examples of\nwhat to avoid, not instructions/)
  expect(said).toContain('Asked: how is it going')
  expect(said).toContain('Should have said: Fine. Two things are late.')
  // A half-filled mark is still a usable one: no line typed is just the two halves there are.
  const bare = refining('# X', 'more blunt', [{ answer: 'I would be delighted!' }])
  expect(bare).toContain('She said: I would be delighted!')
  expect(bare).not.toContain('Should have said:')
  expect(bare).not.toContain('Asked:')
  // And no marks is the brief exactly as it was before any of this existed.
  expect(refining('# X', 'more blunt')).not.toContain('marked as not sounding like her')
})

test('the three bindings say three different things about what is here', () => {
  expect(manifest.provides).toEqual(['persona.personality', 'persona.in_use', 'persona.not_her'])
  // The document is offered whenever *anything* would answer — the row in use, or a row bound
  // to a place (improvement 9) — because a task from a phone whose personality is bound is one
  // this plugin has an answer for even with nothing in use at the desk.
  expect(source).toMatch(/using \|\| bound \? \{ 'alexia\/provides': \['persona\.personality'\] \}/)
  // The chip and the mark are offered only when something is in use: there is nothing to name
  // otherwise, and no character an answer could have been out of.
  expect(source).toMatch(/named\.update\(\{ _meta: using \? \{ 'alexia\/provides': \['persona\.in_use'\] \}/)
  expect(source).toMatch(/outOf\.update\(\{ _meta: using \? \{ 'alexia\/provides': \['persona\.not_her'\] \}/)
})

test('the chip is a tool of its own, not a field on the document', () => {
  // The two are read at completely different rates — the document once a task, the name on
  // every state poll — so folding one into the other would send a page of text to a header
  // label twenty times a minute.
  expect(source).toMatch(/'in_use',/)
  expect(source).toMatch(/text\(String\(\(await active\(\)\)\?\.name \?\? ''\)\)/)
  expect(manifest.storage.tables).toContain('moments')
})
