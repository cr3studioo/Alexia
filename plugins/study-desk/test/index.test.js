// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, expect, test } from 'vitest'
import { createStudy } from '../tools.js'
import { memoryStore } from './store.js'

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const base = mkdtempSync(join(tmpdir(), 'study-desk-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const NOW = Date.parse('2026-12-01T10:00:00Z')

function setup({ transcribes = true, folder, transcript = 'We talked about cells.' } = {}) {
  const inside = mkdtempSync(join(base, 'in-'))
  mkdirSync(join(inside, 'notes'), { recursive: true })
  writeFileSync(join(inside, 'talk.mp3'), 'x')
  const calls = { sample: [], capability: [] }
  const store = memoryStore()
  const study = createStudy({
    storage: store,
    capability: async (cap, args) => {
      calls.capability.push([cap, args])
      return { content: [{ type: 'text', text: transcript }] }
    },
    answers: async () => ({ answers: transcribes, here: true }),
    settings: async () => ({ notes_folder: folder ?? join(inside, 'notes') }),
    roots: async () => [{ uri: pathToFileURL(inside).href }],
    sample: async (_text, system) => {
      calls.sample.push(system)
      return /study questions/.test(system)
        ? 'Q: What are cells? | A: Units of life.'
        : '## Key points\n- cells\n\n## Terms\n- cell: unit\n\n## Open questions\n- none'
    },
    now: () => NOW,
  })
  return { study, inside, calls, store }
}

test('no_transcribe_provider_says_so', async () => {
  const { study, inside, calls } = setup({ transcribes: false })
  const result = await study.lectureNotes({ path: join(inside, 'talk.mp3') })
  expect(result.isError).toBe(true)
  expect(result.content[0].text).toMatch(/turn a recording into words/)
  expect(calls.capability).toEqual([])
  expect(readdirSync(join(inside, 'notes'))).toEqual([])
})

test('exam_becomes_dated_item', async () => {
  const { study } = setup()
  const soon = (await study.exam({ course: 'Biology', day: '2026-12-10' })).structuredContent.id
  await study.exam({ course: 'Chemistry', day: '2027-02-01' }) // beyond 14 days
  await study.exam({ course: 'History', day: '2026-11-01' }) // already past
  expect((await study.exam({ course: 'Maths', day: 'next friday' })).isError).toBe(true)
  const { items } = (await study.noticeItems({ now: NOW, tz_offset_min: 60 })).structuredContent
  expect(items).toEqual([expect.objectContaining({ key: `study:exam:${soon}`, dueAt: Date.parse('2026-12-10T07:00:00Z') })])
  expect((await study.noticeDone({ key: 'tasks:1' })).structuredContent).toEqual({ closed: false })
  expect((await study.noticeDone({ key: `study:exam:${soon}` })).structuredContent).toEqual({ closed: true })
  expect((await study.noticeDone({ key: `study:exam:${soon}` })).structuredContent).toEqual({ closed: false })
  expect((await study.noticeItems({ now: NOW })).structuredContent.items).toEqual([])
})

test('notes_folder_outside_roots_refused', async () => {
  const outside = mkdtempSync(join(base, 'outside-'))
  const { study, inside, calls } = setup({ folder: outside })
  const result = await study.lectureNotes({ path: join(inside, 'talk.mp3') })
  expect(result.isError).toBe(true)
  expect(result.content[0].text).toMatch(/outside the folders you opened/)
  expect(readdirSync(outside)).toEqual([])
  expect(calls.capability).toEqual([])
})

test('lecture notes are saved, never overwritten, and feed a study session', async () => {
  const { study, inside, calls } = setup()
  const first = await study.lectureNotes({ path: join(inside, 'talk.mp3'), title: 'Cells', course: 'Biology' })
  const second = await study.lectureNotes({ path: join(inside, 'talk.mp3'), title: 'Cells', course: 'Biology' })
  expect(readdirSync(join(inside, 'notes')).sort()).toEqual(['Cells (2).md', 'Cells.md'])
  expect(first.structuredContent.path).not.toBe(second.structuredContent.path)
  expect(readFileSync(first.structuredContent.path, 'utf8')).toContain('<summary>Transcript</summary>')
  expect(calls.capability[0]).toEqual(['voice.transcribe', { file: join(inside, 'talk.mp3') }])

  // Notes exist, no cards yet: the session makes them, and they are due today.
  const session = (await study.study({ course: 'biology', minutes: 5 })).structuredContent.cards
  expect(session.length).toBeGreaterThan(0)
  expect(session[0]).toMatchObject({ q: 'What are cells?', a: 'Units of life.', box: 1 })
  const right = (await study.answerCard({ id: session[0].id, right: true })).structuredContent
  expect(right).toEqual({ id: session[0].id, box: 2, due: '2026-12-03' })
  const wrong = (await study.answerCard({ id: session[0].id, right: false })).structuredContent
  expect(wrong).toEqual({ id: session[0].id, box: 1, due: '2026-12-02' })
  expect((await study.answerCard({ id: '999', right: true })).isError).toBe(true)
})

test('the manifest and tools are shaped as the spec says', async () => {
  process.env.ALEXIA_PLUGIN_DIR = pluginDir
  const { default: alexia } = await import('../index.js')
  const tools = alexia.server._registeredTools
  expect(Object.keys(tools)).toEqual(expect.arrayContaining(['lecture_notes', 'study', 'answer_card', 'exam', 'exams']))
  expect(tools.study.annotations.readOnlyHint).toBe(false)
  expect(tools.exams.annotations.readOnlyHint).toBe(true)
  expect(tools.lecture_notes.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false })
  expect(tools.notice_done._meta['alexia/provides']).toEqual(['notice.done'])
  expect(alexia.manifest.requires.map((r) => r.cap)).toEqual(['voice.transcribe', 'fs.read_scoped', 'fs.write_scoped'])
})

test('a document is read once, capped, and only if it is text', async () => {
  const { study, inside, calls } = setup()
  const doc = join(inside, 'chapter.txt')
  writeFileSync(doc, 'Cells are the unit of life. '.repeat(20_000)) // ~540 KB, more than the cap
  const sampled = calls.sample
  await study.study({ document: doc })
  await study.study({ document: doc })
  await study.study({ document: doc })
  expect(sampled.filter((s) => /study questions/.test(s))).toHaveLength(1)
  const again = (await study.study({ document: doc, minutes: 30 })).structuredContent.cards
  expect(again).toHaveLength(1)
  const pdf = join(inside, 'paper.pdf')
  writeFileSync(pdf, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x00, 0xff, 0xfe, 0x00, 0x01]))
  const refused = await study.study({ document: pdf })
  expect(refused.isError).toBe(true)
  expect(refused.content[0].text).toMatch(/not plain text/)
  expect(sampled.filter((s) => /study questions/.test(s))).toHaveLength(1)
})

test('silence is not turned into notes', async () => {
  const { study, inside, calls } = setup({ transcript: 'There was nothing to hear in that file.' })
  const result = await study.lectureNotes({ path: join(inside, 'talk.mp3') })
  expect(result.isError).toBe(true)
  expect(result.content[0].text).toMatch(/nothing to hear/)
  expect(calls.sample).toEqual([])
  expect(readdirSync(join(inside, 'notes'))).toEqual([])
})

test('a reserved Windows name still makes a file', async () => {
  const { study, inside } = setup()
  const result = await study.lectureNotes({ path: join(inside, 'talk.mp3'), title: 'con' })
  expect(result.isError).toBeUndefined()
  expect(readdirSync(join(inside, 'notes'))).toEqual(['_con.md'])
})

test('an exam near makes later-boxed cards due; one far off does not', async () => {
  const { study, inside, store } = setup()
  await study.lectureNotes({ path: join(inside, 'talk.mp3'), title: 'Cells', course: 'Biology' })
  const rowid = Number((await study.study({ course: 'Biology' })).structuredContent.cards[0].id)
  // Box 3, last asked 2 days ago (2026-11-29), so not due until 2026-12-03.
  Object.assign(store.table('cards').find((r) => r.rowid === rowid), { box: 3, due: '2026-12-03' })
  expect((await study.study({ course: 'Biology' })).content[0].text).toBe('No cards are due.')
  await study.exam({ course: 'biology', day: '2026-12-20' }) // 19 days off: still nothing
  expect((await study.study({ course: 'Biology' })).content[0].text).toBe('No cards are due.')
  await study.exam({ course: 'Biology', day: '2026-12-05' }) // 4 days off
  expect((await study.study({ course: 'Biology' })).structuredContent.cards.map((c) => c.id)).toEqual([String(rowid)])
  expect((await study.study({ course: 'Chemistry' })).content[0].text).toBe('No cards are due.')
  // Once answered today it is not asked again today.
  await study.answerCard({ id: String(rowid), right: true })
  expect((await study.study({ course: 'Biology' })).content[0].text).toBe('No cards are due.')
})

test('notice items use the local time zone when none is given', async () => {
  const late = Date.parse('2026-12-01T23:30:00Z')
  const zoned = createStudy({
    storage: memoryStore(), capability: async () => ({}), answers: async () => ({}), settings: async () => ({}), roots: async () => [],
    sample: async () => '', now: () => late, tz: () => 120, // 01:30 on 2 December locally
  })
  await zoned.exam({ course: 'Maths', day: '2026-12-16' }) // 14 days after the 2nd, 15 after the 1st
  const { items } = (await zoned.noticeItems({})).structuredContent
  expect(items.map((i) => i.text)).toEqual(['Maths exam on 2026-12-16'])
})
