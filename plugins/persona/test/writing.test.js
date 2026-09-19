// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { brief, clean, LONGEST, nameFrom, nameSaid, SECTIONS, shapeFor, SHAPE, unique, usable } from '../writing.js'

/**
 * Adapting (M4-4), minus the model.
 *
 * Everything here is a shape the model's answer can arrive in, and the reason each check
 * exists is that the answer is the *only* thing between rough notes and a document that
 * goes into the system prompt. What a model returns is not a promise.
 */

test('the brief carries the description and forbids inventing around it', () => {
  const said = brief('blunt, calls me Vacen, no emojis')
  expect(said).toContain('blunt, calls me Vacen, no emojis')
  expect(said).toContain(SHAPE)
  expect(said).toMatch(/Invent nothing/)
  // A personality goes into the system prompt now, so the one thing it must never be
  // allowed to write is a rule that turns the gate off.
  expect(said).toMatch(/skip asking permission/)
})

test('the shape is a skeleton, because a worked example is a thing a model copies', () => {
  // 2026-08-29, live: SHAPE was a complete chief-of-staff personality. Asked for a Victorian
  // butler, a free model returned that example's headline, its role sentence and both of its
  // bullets, with only *How you talk* replaced — so the name it was told never to invent
  // reached the document from the instructions. Every personality would have been the same
  // person wearing a different voice.
  //
  // The check is that the shape names nobody: no person, no role, no habit. Only headings
  // and a bracket saying what belongs under each.
  const body = SHAPE.split('\n').filter((line) => !line.startsWith('#'))
  for (const line of body) {
    expect(line === '' || line.startsWith('<'), line).toBe(true)
  }
  // And the instruction that goes with a skeleton rather than an example: fill it in.
  expect(brief('anything')).toMatch(/replace each/)
})

test('code fences come off, because a model told not to use them still does', () => {
  expect(clean('```markdown\n# Chief of staff\n\nBe blunt.\n```')).toBe('# Chief of staff\n\nBe blunt.')
  expect(clean('```\n# Chief of staff\n```')).toBe('# Chief of staff')
  expect(clean('  # Chief of staff  ')).toBe('# Chief of staff')
  expect(clean(undefined)).toBe('')
})

test('a model talking about the document is not the document', () => {
  expect(usable(SHAPE)).toBe(true)
  // No heading: a chatty paragraph, which is what a small model returns when it decides to
  // be helpful instead of doing as it was told.
  expect(usable('Sure! Here is a personality for Alexia that is blunt and to the point.')).toBe(false)
  expect(usable('# Hi')).toBe(false)
  expect(usable(`# Long\n${'word '.repeat(LONGEST)}`)).toBe(false)
})

/** A whole personality, built from the shape's own headings so it cannot drift from them. */
const whole = (override = {}) =>
  [
    '# Butler',
    ...SECTIONS.flatMap((name) => ['', `## ${name}`, override[name] ?? 'Be formal.']),
  ].join('\n')

test('half a personality is not a personality, which is what the shallow check let through', () => {
  // 2026-09-15, live: the answer ran out of room and this was saved and put in use. It has a
  // heading and more than forty characters, which was the whole of the old check.
  const cut = '# Butler\n\n## Who you are\nYou are a formal, attentive household butler for the user.\n\n## How'
  expect(usable(cut)).toBe(false)

  expect(usable(whole())).toBe(true)
  // A section with nothing under it is as missing as one that is not there.
  expect(usable(whole({ 'Hard rules': '' }))).toBe(false)
  // `Nothing.` is an answer, and the brief tells the model to use it.
  expect(usable(whole({ 'What you do without being asked': 'Nothing.' }))).toBe(true)
  // What a model does to headings when left alone, and none of it is a missing section.
  expect(usable(whole().replace('## Hard rules', '### HARD RULES:'))).toBe(true)
  expect(usable(whole({ 'How you talk': '### Register\n- blunt' }))).toBe(true)
})

test('an untyped name comes from the user’s own words, never the model’s', () => {
  expect(nameFrom('Chief of staff', 'blunt, no emojis')).toBe('Chief of staff')
  expect(nameFrom('   ', 'blunt, calls me Vacen, chases my dates')).toBe('Blunt calls me Vacen')
  expect(nameFrom('', '# **heading noise**')).toBe('Heading noise')
  expect(nameFrom('', '   ')).toBe('Personality')
  expect(nameFrom('x'.repeat(80), 'anything')).toHaveLength(40)
})

test('two rows never share a name, which is what makes a list readable a week later', () => {
  expect(unique('Chief of staff', [])).toBe('Chief of staff')
  expect(unique('Chief of staff', ['Chief of staff'])).toBe('Chief of staff 2')
  expect(unique('Chief of staff', ['Chief of staff', 'Chief of staff 2'])).toBe('Chief of staff 3')
})

/**
 * 2026-09-18, live: the brief said *write a real name of your own on the first line*, two lines
 * above a rule forbidding it to invent a name. A description headed `Name: Alexia` came back
 * titled `# Jordan` and saved into a row called *Alexia*.
 */
test('the title is given to the model, not chosen by it', () => {
  const said = brief('blunt, no emojis', 'Alexia')
  expect(said).toContain('# Alexia')
  // The instruction that caused it must be gone, not merely contradicted somewhere below.
  expect(said).not.toMatch(/write a real name of your own/i)
  expect(said).toMatch(/never invent a name of your own/i)
  // A caller with no name still gets the skeleton, so the bare shape stays usable on its own.
  expect(brief('blunt')).toContain(SHAPE)
})

test('a name is copied whole, and a name that looks like a backreference survives it', () => {
  expect(shapeFor('Alexia')).toMatch(/^# Alexia$/m)
  expect(shapeFor('  Chief of staff  ')).toMatch(/^# Chief of staff$/m)
  expect(shapeFor('')).toBe(SHAPE)
  expect(shapeFor(undefined)).toBe(SHAPE)
  // `$&` in a replacement string means "the whole match" — a name is text, not a pattern.
  expect(shapeFor('$& and $1')).toMatch(/^# \$& and \$1$/m)
})

/**
 * 2026-09-18, live: `<bullets: register, length, what to call them, what is banned>` came back
 * as `Register: casual` / `Length: concise` / `What to call them: "you"` / `Banned: rushing`.
 * The note was filled in rather than written from.
 */
test('the notes are instructions to the writer, and may not surface as labels', () => {
  expect(brief('anything')).toMatch(/never let a note’s own words appear in the document as a label/i)
  // A note that reads as a list of field names is a note a model will hand back as fields.
  const notes = SHAPE.split('\n').filter((line) => line.startsWith('<'))
  expect(notes.length).toBeGreaterThan(0)
  for (const note of notes) {
    expect(/^<[a-z]+:/.test(note), `reads as a field list: ${note}`).toBe(false)
  }
})

test('a description that states its own name is believed before its opening words', () => {
  // The real paste that started this: one long line, fields run together, no newlines at all.
  const pasted = 'Alexia — AI Agent Personality Document Core Identity Name: Alexia Role: Top-level orchestrator'
  expect(nameSaid(pasted)).toBe('Alexia')
  // Without it, the name would have been the first four words of the heading.
  expect(nameFrom('', pasted)).toBe('Alexia')
  // What they typed in the box still wins over anything the description says.
  expect(nameFrom('Butler', pasted)).toBe('Butler')
  expect(nameSaid('blunt, no emojis')).toBe('')
  expect(nameSaid(undefined)).toBe('')
})

/**
 * A cross-file assumption: the title can only match the row if the caller knows the name before
 * it asks. Naming after the answer came back is what let the two disagree.
 */
test('both buttons decide the name before the model writes anything', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  // Adapt: unique(nameFrom(...)) has to come first, then the write that is handed it.
  const adapt = source.indexOf('const name = unique(')
  const writes = source.indexOf('await write(ctx, description, name)')
  expect(adapt, 'Adapt no longer computes a name').toBeGreaterThan(-1)
  expect(writes, 'Adapt no longer hands the name to write()').toBeGreaterThan(adapt)
  // Re-adapt keeps the row's own name rather than retitling it.
  expect(source).toMatch(/await write\(ctx, was\.described, String\(row\.name\)\)/)
  // And nothing calls write() without one.
  expect(source).not.toMatch(/await write\(ctx, [a-z.]+\)/)
})
