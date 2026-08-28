// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import type { Step } from '../src/agent.js'
import { forget, learnable, outline, parse, save } from '../src/learned.js'

// M4-5. Two things have to be right, and they fail in opposite directions: offering to
// learn from a task where nothing was worked out is noise, and refusing to learn from one
// where something was is the whole feature not happening.

const root = mkdtempSync(join(tmpdir(), 'alexia-learned-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const step = (n: number, name: string, ok = true): Step => ({
  n,
  name,
  args: {},
  outcome: { ok, text: ok ? 'done' : 'no such file' },
})

const episode = (steps: Step[]) => ({ task: 'sort my downloads', steps, answer: 'Done.' })

test('a task where nothing was worked out is not offered', () => {
  expect(learnable(episode([]))).toBe(false)
  expect(learnable(episode([step(1, 'fs__list')]))).toBe(false)
  // Two calls to the same tool is a loop, not a procedure.
  expect(learnable(episode([step(1, 'fs__list'), step(2, 'fs__list')]))).toBe(false)
})

test('a task where something was worked out is offered', () => {
  // Three different tools: the order of them was a decision somebody made.
  expect(learnable(episode([step(1, 'fs__list'), step(2, 'fs__stat'), step(3, 'fs__move')]))).toBe(true)
  // Or a failure that was recovered from, which is the shape worth keeping even when it
  // is short: the recovery is the transferable part.
  expect(learnable(episode([step(1, 'fs__move', false), step(2, 'fs__mkdir'), step(3, 'fs__move')]))).toBe(true)
})

test('a task that ended still broken is not a lesson', () => {
  expect(learnable(episode([step(1, 'a', false), step(2, 'b', false), step(3, 'c', false)]))).toBe(false)
})

test('the offer says what it would be remembering', () => {
  // "Want me to remember how to do this?" is unanswerable without this half.
  expect(outline(episode([step(1, 'fs__list'), step(2, 'fs__stat'), step(3, 'fs__move')]))).toBe(
    '3 steps, using fs__list, fs__stat, fs__move',
  )
  expect(outline(episode([1, 2, 3, 4, 5].map((n) => step(n, `t${String(n)}`))))).toMatch(/and 2 more/)
})

test('what the model writes is held to the rules a downloaded skill is held to', () => {
  const good = parse(
    '---\nname: sorting-downloads\ndescription: How to tidy a downloads folder. Use when the user asks about downloads.\n---\n\n1. List it.\n',
  )
  expect(good).toMatchObject({ name: 'sorting-downloads' })
  expect('description' in good && good.description).toMatch(/Use when/)

  // The failures that would otherwise produce a skill that silently never fires.
  expect(parse('Sure! Here is a skill:\n\n1. List it.')).toHaveProperty('why')
  expect(parse('---\nname: Sorting Downloads\ndescription: x\n---\nbody')).toHaveProperty('why')
  expect(parse('---\nname: ok-name\n---\nbody')).toHaveProperty('why')
  // The model declining is a real answer, and the commonest one.
  expect(parse('NOTHING TO LEARN')).toHaveProperty('why')
})

test('a fenced answer is unwrapped rather than rejected', () => {
  // Models wrap things in code fences. Refusing over that would throw away a good skill
  // for a formatting habit.
  const parsed = parse('```markdown\n---\nname: a-name\ndescription: What and when.\n---\n\nBody.\n```')
  expect(parsed).toMatchObject({ name: 'a-name' })
})

test('saving marks it as learned, and forgetting is deleting the folder', () => {
  const dir = save(root, { name: 'sorting-downloads', description: 'x', document: '---\nname: sorting-downloads\ndescription: x\n---\n\nBody.' })
  const written = readFileSync(join(dir, 'SKILL.md'), 'utf8')
  // The mark rides in `metadata`, which the skills spec says to ignore — so the skill stays
  // portable and the flag means nothing anywhere else.
  expect(written).toMatch(/metadata:\n {2}learned: true/)
  // And the frontmatter still starts at byte 0, which is the rule that makes it load at all.
  expect(written.startsWith('---\n')).toBe(true)

  expect(forget(root, 'sorting-downloads')).toBe(true)
  expect(existsSync(dir)).toBe(false)
  // A name that is not a folder name never reaches the filesystem.
  expect(forget(root, '../../etc')).toBe(false)
})
