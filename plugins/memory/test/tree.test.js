// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import {
  bare,
  browse,
  build,
  counts,
  destination,
  fallback,
  find,
  group,
  nodes,
  outline,
  parseArray,
  pathOf,
  placement,
  placePrompt,
  plan,
  PLACE_MOST,
  readSummaries,
  SECTIONS,
  summaryOk,
  summaryPrompt,
  touched,
} from '../tree.js'

/**
 * The tree: where a note lives, and what code does with a model's opinion about that. Every
 * rule the placer's answer is held to is here, because a placer that can wander files notes
 * where nobody will look for them — which is the same as not having written them down.
 */

/** The seed, as storage would hand it back: root 1, sections 2–9, then a Niki bubble. */
const seedRows = () => [
  { rowid: 1, parent: null, name: 'You', summary: 'Everything about Vacen.', seed: 1 },
  ...SECTIONS.map((name, i) => ({ rowid: i + 2, parent: 1, name, summary: '', seed: 1 })),
  { rowid: 20, parent: 3, name: 'Niki', summary: 'His girlfriend Niki.', seed: 0 },
]
const PEOPLE = 3
const NIKI = 20
const tree = () => build(seedRows())

test('paths read the way the owner draws them, and are found however a model writes them', () => {
  const t = tree()
  expect(pathOf(t, NIKI)).toBe('You/People/Niki')
  expect(find(t, 'You/People/Niki')).toBe(NIKI)
  // Without the root, lower-cased, spaced, quoted: a small model writes all of these.
  expect(find(t, 'people/niki')).toBe(NIKI)
  expect(find(t, ' "People" / Niki ')).toBe(NIKI)
  expect(find(t, 'You')).toBe(1)
  expect(find(t, 'You/Nobody')).toBeUndefined()
})

test('a broken table still reads as a tree: orphans and loops hang off the root', () => {
  const t = build([
    { rowid: 1, name: 'You' },
    { rowid: 2, parent: 99, name: 'Orphan' },
    { rowid: 3, parent: 4, name: 'A' },
    { rowid: 4, parent: 3, name: 'B' },
    // Storage hands numbers back as strings from a TEXT column.
    { rowid: 5, parent: '1', name: 'Stringy' },
  ])
  expect(t.root).toBe(1)
  expect(pathOf(t, 2)).toBe('You/Orphan')
  expect(pathOf(t, 5)).toBe('You/Stringy')
  // One of the loop is re-hung on the root, and the other stays under it.
  expect([pathOf(t, 3), pathOf(t, 4)].sort()).toEqual(['You/A', 'You/A/B'])
  expect(build([]).root).toBeNull()
})

test('the placer sees branch names and summaries, never the notes', () => {
  const t = tree()
  const text = outline(t)
  expect(text.split('\n')[0]).toBe('You — Everything about Vacen.')
  expect(text).toContain('You/People/Niki — His girlfriend Niki.')
  expect(text).toContain('You/Projects & code')
  const asked = placePrompt(t, [{ rowid: 7, text: 'Vacen likes his girlfriend Niki.' }])
  expect(asked).toContain('id 7: Vacen likes his girlfriend Niki.')
  expect(asked).toContain('JSON')
})

test('placement: an existing path, or exactly one new bubble under one', () => {
  const t = tree()
  expect(placement(t, 'You/People/Niki')).toEqual({ branch: NIKI })
  expect(placement(t, 'You/Hobbies/Anime')).toEqual({ branch: 6, create: 'Anime' })
  // Two new levels at once: the area was right, the detail was not. The nearest real branch.
  expect(placement(t, 'You/Hobbies/Anime/Frieren')).toEqual({ branch: 6 })
  // A name that is a sentence is not a branch; again the nearest real one.
  expect(placement(t, 'You/People/his girlfriend from the anime club')).toEqual({ branch: PEOPLE })
  expect(placement(t, 'You/People/a/b')).toEqual({ branch: PEOPLE })
})

test('placement: the root is not an answer, so a path that only reaches it is null', () => {
  const t = tree()
  expect(placement(t, 'You')).toBeNull()
  expect(placement(t, '')).toBeNull()
  expect(placement(t, 'You/Family/Mum')).toBeNull()
  // One new section is fine while there is room for it…
  expect(placement(t, 'You/Health')).toEqual({ branch: 1, create: 'Health' })
})

test('placement: at most twelve sections, and at most four levels below the root', () => {
  const wide = build([
    ...seedRows(),
    ...[30, 31, 32, 33].map((rowid) => ({ rowid, parent: 1, name: `Extra ${rowid}` })),
  ])
  // Twelve sections already: a thirteenth falls back to its nearest parent, the root — so null.
  expect(placement(wide, 'You/Health')).toBeNull()

  const deep = build([
    ...seedRows(),
    { rowid: 40, parent: 5, name: 'Alexia' },
    { rowid: 41, parent: 40, name: 'Plugins' },
    { rowid: 42, parent: 41, name: 'Memory' },
  ])
  expect(pathOf(deep, 42)).toBe('You/Projects & code/Alexia/Plugins/Memory')
  // Memory is at depth 4; a child of it would be 5.
  expect(placement(deep, 'You/Projects & code/Alexia/Plugins/Memory/Tree')).toEqual({ branch: 42 })
  expect(placement(deep, 'You/Projects & code/Alexia/Plugins/Search')).toEqual({ branch: 41, create: 'Search' })
})

test('a person is refused rather than second-guessed', () => {
  const t = tree()
  expect(destination(t, 'You')).toEqual({ branch: 1 })
  expect(destination(t, 'People/Mum')).toEqual({ branch: PEOPLE, create: 'Mum' })
  expect(destination(t, 'People/Mum/Garden').error).toMatch(/one level at a time/)
  expect(destination(t, 'People/my mum who lives in Brno').error).toMatch(/not a branch name/)
})

test('fallback by kind, and the root when a section has been renamed away', () => {
  const t = tree()
  const at = (kind) => pathOf(t, fallback(t, kind))
  expect(at('person')).toBe('You/People')
  expect(at('preference')).toBe('You/Preferences')
  expect(at('task')).toBe('You/Goals & plans')
  expect(at('place')).toBe('You/Identity & how to talk to me')
  expect(at('fact')).toBe('You')
  expect(at('other')).toBe('You')
  expect(at(undefined)).toBe('You')
  const renamed = build(seedRows().map((row) => (row.name === 'People' ? { ...row, name: 'Friends' } : row)))
  expect(pathOf(renamed, fallback(renamed, 'person'))).toBe('You')
})

test('plan: the model is checked item by item, and whatever it missed is filed by kind', () => {
  const t = tree()
  const notes = [
    { rowid: 7, text: 'Vacen likes his girlfriend Niki.', kind: 'person' },
    { rowid: 8, text: 'Niki watches Frieren.', kind: 'fact' },
    { rowid: 9, text: 'He prefers Rust.', kind: 'preference' },
    { rowid: 10, text: 'Call mum on Sunday.', kind: 'task' },
  ]
  const answer = parseArray(`Sure! ${JSON.stringify([
    { id: 7, path: 'You/People/Niki', also: [] },
    { id: 8, path: 'You/Hobbies/Anime', also: ['You/People/Niki', 'You/People/Niki', 'You', 'You/Nowhere'] },
    { id: 8, path: 'You/Studies' }, // a second answer for the same note is ignored
    { id: 9, path: 'You/Projects & code/Languages/Rust' }, // two new levels: nearest real branch
    { id: 999, path: 'You/People' }, // a note it was not shown
    // 10 missing entirely
  ])}`)
  const { create, place } = plan(t, notes, answer)
  expect(create).toEqual([{ id: -1, parent: 6, name: 'Anime' }])
  expect(place).toEqual([
    { id: 7, branch: NIKI, also: [], by: 'model' },
    { id: 8, branch: -1, also: [NIKI], by: 'model' },
    { id: 9, branch: 5, also: [], by: 'model' },
    { id: 10, branch: 8, also: [], by: 'kind' },
  ])
  // The tree it was handed is untouched.
  expect(t.nodes.has(-1)).toBe(false)
})

test('plan: two notes about one new thing make one bubble, and a new bubble can take a link', () => {
  const t = tree()
  const notes = [
    { rowid: 1, text: 'a', kind: 'fact' },
    { rowid: 2, text: 'b', kind: 'fact' },
  ]
  const { create, place } = plan(t, notes, [
    { id: 1, path: 'You/Hobbies/Anime' },
    { id: 2, path: 'You/People/Niki', also: ['you/hobbies/anime'] },
  ])
  expect(create).toHaveLength(1)
  expect(place[1]).toEqual({ id: 2, branch: NIKI, also: [-1], by: 'model' })
})

test('plan: no answer at all files everything by kind, and at most thirty a run', () => {
  const t = tree()
  const many = Array.from({ length: 40 }, (_, i) => ({ rowid: i + 1, text: `note ${i}`, kind: 'person' }))
  const { create, place } = plan(t, many, null)
  expect(create).toEqual([])
  expect(place).toHaveLength(PLACE_MOST)
  expect(place.every((one) => one.branch === PEOPLE && one.by === 'kind')).toBe(true)
  expect(parseArray('I could not decide.')).toBeNull()
  expect(parseArray('[{"id": 1}, "junk", null]')).toEqual([{ id: 1 }])
})

test('counts: valid notes at or below each branch, each note once per branch', () => {
  const t = tree()
  const notes = [
    { rowid: 1, branch: NIKI, also: JSON.stringify([6]) },
    { rowid: 2, branch: NIKI, also: JSON.stringify([PEOPLE]) },
    { rowid: 3, branch: NIKI, invalid_at: 5 },
    { rowid: 4 }, // not filed yet: counts under the root
  ]
  const n = counts(t, notes)
  expect(n.get(NIKI)).toBe(2)
  expect(n.get(PEOPLE)).toBe(2)
  expect(n.get(6)).toBe(1)
  expect(n.get(1)).toBe(3)
  expect(n.get(9)).toBe(0)
})

test('touched: the branches and everything above them', () => {
  const t = tree()
  expect([...touched(t, [NIKI])].sort((a, b) => a - b)).toEqual([1, PEOPLE, NIKI])
})

test('summaries: one sentence, at most 160 characters, else the old one stays', () => {
  expect(summaryOk('"Niki is his girlfriend, who likes anime."')).toBe('Niki is his girlfriend, who likes anime.')
  expect(summaryOk('Niki is his girlfriend. She likes anime.')).toBeNull()
  expect(summaryOk('x'.repeat(161))).toBeNull()
  expect(summaryOk('')).toBeNull()
  expect(summaryOk('one\ntwo')).toBeNull()
  const t = tree()
  const notes = [{ rowid: 1, branch: NIKI, text: 'Vacen likes his girlfriend Niki.', at: 1 }]
  const asked = summaryPrompt(t, [1, PEOPLE, NIKI], notes)
  // Deepest first, with what is directly under each.
  expect(asked.indexOf('You/People/Niki\n')).toBeLessThan(asked.indexOf('You/People\n'))
  expect(asked).toContain('note: Vacen likes his girlfriend Niki.')
  expect(asked).toContain('branch Niki: His girlfriend Niki.')
  const read = readSummaries(t, [PEOPLE, NIKI], [
    { path: 'You/People/Niki', summary: 'Niki, his girlfriend.' },
    { path: 'You/People', summary: 'Too long. Two sentences.' },
    { path: 'You/Studies', summary: 'Not asked about.' },
  ])
  expect([...read]).toEqual([[NIKI, 'Niki, his girlfriend.']])
})

test('recall hits are grouped under their branch, in the order the ranking reached them', () => {
  const t = tree()
  const hits = [
    { rowid: 1, branch: NIKI, text: 'a' },
    { rowid: 2, branch: 6, text: 'b' },
    { rowid: 3, branch: NIKI, text: 'c' },
    { rowid: 4, text: 'd' },
  ]
  const groups = group(t, hits)
  expect(groups.map((one) => one.path)).toEqual(['You/People/Niki', 'You/Hobbies', 'You'])
  expect(groups[0].rows.map((row) => row.rowid)).toEqual([1, 3])
  expect(groups[0].summary).toBe('His girlfriend Niki.')
})

test('browse: the sections with counts, then one branch with its notes', () => {
  const t = tree()
  const notes = [
    { rowid: 1, branch: NIKI, text: 'Vacen likes his girlfriend Niki.', at: 2 },
    { rowid: 2, branch: 6, also: JSON.stringify([NIKI]), text: 'Niki watches Frieren.', at: 1 },
    { rowid: 3, branch: NIKI, text: 'Closed.', invalid_at: 3 },
  ]
  const top = browse(t, notes, undefined)
  expect(top).toContain('You — Everything about Vacen.')
  expect(top).toContain('- People (2 notes)')
  expect(top).toContain('- Hobbies (1 note)')
  expect(top).toContain('- Studies (empty)')
  const niki = browse(t, notes, 'People/Niki')
  expect(niki).toBe(
    ['You/People/Niki — His girlfriend Niki.', '', 'Notes:', '- Vacen likes his girlfriend Niki.', '- Niki watches Frieren. (also filed here)'].join('\n'),
  )
  expect(browse(t, notes, 'You/Nowhere')).toBeNull()
})

test('forgetting prunes a bubble left with nothing in it, never a section or a closed note’s home', () => {
  const t = build([...seedRows(), { rowid: 21, parent: NIKI, name: 'Her family' }, { rowid: 22, parent: 6, name: 'Chess' }])
  // Nothing filed anywhere: Niki's family goes, then Niki, and Chess; sections stay.
  expect(bare(t, []).sort((a, b) => a - b)).toEqual([NIKI, 21, 22])
  // A closed note still holds its branch: closing is not forgetting.
  expect(bare(t, [{ rowid: 1, branch: 22, invalid_at: 5 }]).sort((a, b) => a - b)).toEqual([NIKI, 21])
  // A link holds a branch too.
  expect(bare(t, [{ rowid: 1, branch: 22, also: JSON.stringify([21]) }])).toEqual([])
})

test('memory_tree: the fixed shape the panel is built against', () => {
  const t = tree()
  const notes = [{ rowid: 7, branch: NIKI, also: JSON.stringify([6, 999]), text: 'Vacen likes his girlfriend Niki.' }]
  const out = nodes(t, notes, () => ['worked out'])
  expect(out[0]).toEqual({ id: 'b1', parent: null, kind: 'branch', label: 'You', summary: 'Everything about Vacen.', count: 1 })
  expect(out.find((one) => one.id === 'b2')).toEqual({ id: 'b2', parent: 'b1', kind: 'branch', label: SECTIONS[0], count: 0 })
  expect(out.find((one) => one.id === '7')).toEqual({
    id: '7',
    parent: 'b20',
    kind: 'note',
    label: 'Vacen likes his girlfriend Niki.',
    tags: ['worked out'],
    // A link to a branch that is gone is left out.
    also: ['b6'],
  })
})
