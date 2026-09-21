// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { costLine, costOf } from '../cost.js'
import {
  asRow,
  brief,
  CEILING,
  LONGEST,
  MARK,
  refining,
  ROOM,
  shorterOf,
  sizesFrom,
  sizesIn,
  sizesLine,
  usable,
  versionOf,
} from '../writing.js'

/**
 * **`plan-personality.md` §2: three sizes, written in one call** (D160).
 *
 * A personality is sent on every step. Six hundred words across a fifteen-step task is 7–8k
 * tokens re-sent — money on a paid model, and on a free one it is context, rate limit and
 * instructions followed halfway. The plugin's half of the fix is writing three lengths at once
 * and saving them beside each other; core's half (`packages/core/test/sizes.test.ts`) is
 * choosing between them per step.
 */

const long = `# Chief of staff

## Who you are
You are his chief of staff.

## How you talk
- Be blunt.
- Keep answers short.

## What you do without being asked
- Chase the dates he set himself.

## Hard rules
1. Ask before anything with an external consequence.`

const three = [long, MARK.medium, '# Chief of staff\n\nBlunt. Short answers. Chases his dates.', MARK.small, '# Chief of staff\n\nBlunt. Ask first.'].join('\n')

// ---- splitting one answer into three ----------------------------------------------------------

test('one answer becomes three, longest first, split on the markers', () => {
  const got = sizesFrom(three)
  expect(got.high).toBe(long)
  expect(got.medium).toContain('Chases his dates')
  expect(got.small).toBe('# Chief of staff\n\nBlunt. Ask first.')
  // The long one is the personality: it is the one `usable()` is asked about.
  expect(usable(got.high)).toBe(true)
})

test('the facts after the last document are never part of a document', () => {
  // With a memory plugin on, Adapt asks for facts after the three. They used to be read as the
  // tail of the short one, which then went to every weak model with the marker in it.
  const facts = [MARK.facts, '- His name is Vacen.', '- His grant deadline is in March.'].join('\n')
  const got = sizesFrom(`${three}\n${facts}`)
  expect(got.small).toBe('# Chief of staff\n\nBlunt. Ask first.')
  for (const size of [got.high, got.medium, got.small]) {
    expect(size).not.toContain(MARK.facts)
    expect(size).not.toContain('grant deadline')
  }
  // And a model that skipped the size markers does not carry them into the long one either.
  const only = sizesFrom(`${long}\n${facts}`)
  expect(only.high).toBe(long)
  expect(usable(only.high)).toBe(true)
})

test('the markers are nothing a personality would contain on its own', () => {
  // A separator a model might plausibly have written — `---`, `##`, a blank line — is a
  // separator that splits somebody's document in half one day. Both appear in neither the
  // shape the writer is given nor anything a person would type.
  for (const mark of Object.values(MARK)) expect(long).not.toContain(mark)
  // Each marker appears exactly once in the brief that asks for what it separates. The facts
  // marker is only there when something is going to remember them (improvement 5), which is
  // what keeps a machine with no memory plugin paying nothing for a feature it cannot use.
  const asking = brief('blunt', 'Chief of staff', true)
  for (const mark of Object.values(MARK)) expect(asking.split(mark), mark).toHaveLength(2)
  expect(brief('blunt', 'Chief of staff')).not.toContain(MARK.facts)
})

test('a marker a model repeated is still one boundary, not three documents', () => {
  const twice = [long, MARK.medium, 'the middle one', MARK.medium, 'oops', MARK.small, 'the short one'].join('\n')
  const got = sizesFrom(twice)
  expect(got.high).toBe(long)
  // Split on the first occurrence, so a stray repeat lands inside a size rather than losing one.
  expect(got.medium).toContain('the middle one')
  expect(got.small).toBe('the short one')
})

test('a missing shorter size is simply absent, and the long one still stands', () => {
  // Between a model that ignored the markers and one that ignored the lengths there is nothing
  // to salvage — and falling back to the long document is exactly what every model got before
  // sizes existed, so an answer with no markers is not a failed press.
  const got = sizesFrom(long)
  expect(got.high).toBe(long)
  expect(got.small).toBeUndefined()
  expect(got.medium).toBeUndefined()
  expect(sizesIn(got)).toEqual([])
})

test('a short one that ran long is thrown away rather than trimmed', () => {
  // §2's own instruction, and the reason matters: the hard rules are at the end of a
  // personality, so trimming to a length cuts exactly the lines that were least negotiable.
  const over = [long, MARK.medium, 'fine', MARK.small, 'x'.repeat(CEILING.small + 1)].join('\n')
  const got = sizesFrom(over)
  expect(got.small).toBeUndefined()
  expect(got.medium).toBe('fine')
  // One under the ceiling is kept, so this is a ceiling rather than a ban.
  const under = [long, MARK.medium, 'fine', MARK.small, 'y'.repeat(CEILING.small)].join('\n')
  expect(sizesFrom(under).small).toHaveLength(CEILING.small)
})

test('the ceilings are the budgets, with room for a document that lands near one', () => {
  // About 100, 300 and 600 words (D160), at roughly six and a half characters a word — the
  // figure `cost.js` already estimates in — with about a third again on top, so a document
  // that aimed at its budget is accepted and one that ignored it is not.
  expect(CEILING.small).toBeGreaterThan(100 * 6.5)
  expect(CEILING.small).toBeLessThan(100 * 6.5 * 1.5)
  expect(CEILING.medium).toBeGreaterThan(300 * 6.5)
  expect(CEILING.medium).toBeLessThan(300 * 6.5 * 1.5)
  expect(CEILING.high).toBe(LONGEST)
  // And the reply budget covers writing all three, which is about a thousand words rather than
  // six hundred — the room went up with the job rather than the three arriving cut off.
  expect(ROOM).toBeGreaterThan((CEILING.small + CEILING.medium + CEILING.high) / 4)
})

// ---- both briefs ask for three -----------------------------------------------------------------

test('Adapt and Refine both ask for the three, in the same words', () => {
  for (const said of [brief('blunt chief of staff', 'Chief of staff'), refining(long, 'more blunt')]) {
    expect(said).toContain(MARK.medium)
    expect(said).toContain(MARK.small)
    expect(said).toMatch(/longest first/i)
    // The two sentences carrying the weight: the failure here is not a bad summary, it is a
    // second personality that only a small model ever meets.
    expect(said).toMatch(/All three are the same person/i)
    expect(said).toMatch(/drop detail; they never change her/i)
    expect(said).toMatch(/starts with the same first line/i)
  }
})

// ---- what a row holds ---------------------------------------------------------------------------

test('a version carries all three, and a row written before them reads back empty rather than missing', () => {
  const row = { doc: long, doc_small: 'short', doc_medium: 'middle', described: 'blunt', wrote: 'a/model', at: 5 }
  expect(versionOf(row)).toEqual({ doc: long, docSmall: 'short', docMedium: 'middle', described: 'blunt', wrote: 'a/model', removed: '[]', at: 5 })
  // Empty, not absent: Undo writes a version back onto the row whole, and a missing key would
  // leave the *old* short one beside the restored long one — a person two versions apart.
  expect(versionOf({ doc: long, at: 5 })).toMatchObject({ docSmall: '', docMedium: '' })
  expect(asRow(versionOf({ doc: long, at: 5 }))).toMatchObject({ doc_small: '', doc_medium: '' })
  expect(asRow(versionOf(row))).toMatchObject({ doc: long, doc_small: 'short', doc_medium: 'middle' })
})

test('shorterOf reads a row into the shape everything else here speaks', () => {
  expect(shorterOf({ doc_small: 'a', doc_medium: 'b' })).toEqual({ small: 'a', medium: 'b' })
  expect(shorterOf({})).toEqual({ small: '', medium: '' })
  expect(shorterOf(undefined)).toEqual({ small: '', medium: '' })
})

test('the screen says which of the three came back, because two is not three', () => {
  expect(sizesLine({ small: 'a', medium: 'b' })).toMatch(/Three lengths saved/)
  expect(sizesLine({ medium: 'b' })).toMatch(/small one did not come back usable/)
  expect(sizesLine({ small: 'a' })).toMatch(/medium one did not come back usable/)
  expect(sizesLine({})).toMatch(/Only the long one came back/)
})

// ---- what it costs -------------------------------------------------------------------------------

test('the cost line names all three, which is what makes the sizes visible at all', () => {
  const said = costLine(long, { small: 'short', medium: 'the middle one' })
  expect(said).toContain(String(costOf(long).perTask))
  expect(said).toContain('on the medium one')
  expect(said).toContain('on the small one')
  // Still hedged. An estimate presented as a fact is a lie, whether there are one or three.
  expect(said).toMatch(/An estimate/)
})

test('with one document the cost line reads exactly as it did before there were three', () => {
  expect(costLine(long)).not.toContain('on the')
  expect(costLine(long, { small: '', medium: '' })).toBe(costLine(long))
})

// ---- the capability, and the one place the three leave this plugin ---------------------------------

const source = readFileSync(join(import.meta.dirname, '..', 'index.js'), 'utf8').replace(/\r\n/g, '\n')

test('the capability answers with the long one as text and all three beside it', () => {
  // `text` is the whole contract for a core that knows nothing about sizes, so it stays the
  // long document; `structuredContent` is MCP's own field, so nothing in the plugin contract
  // moved for this.
  expect(source).toMatch(/structuredContent: \{ high, \.\.\.\(small !== '' && \{ small \}\), \.\.\.\(medium !== '' && \{ medium \}\) \}/)
  expect(source).toMatch(/const high = String\(using\?\.doc \?\? ''\)/)
})

test('every save writes both shorter columns, so a stale short one cannot survive a new long one', () => {
  // The one failure mode three lengths have that one does not. `keep()` and Adapt's insert are
  // the only two places a document reaches storage, and both write the pair unconditionally.
  expect(source.match(/doc_small: written\.small \?\? ''/g)).toHaveLength(2)
  expect(source.match(/doc_medium: written\.medium \?\? ''/g)).toHaveLength(2)
  // Edit hands `keep()` a version with neither, which is what clears them — and it says so.
  expect(source).toMatch(/await keep\(row, was, \{ doc, wrote: 'you', removed \}\)/)
  expect(source).toMatch(/The shorter lengths went with the version you replaced/)
})
