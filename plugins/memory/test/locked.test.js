// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest'

/**
 * Locked facts, the profile file and the nightly tidy-up (P3-15). These drive the real
 * `index.js` against a stand-in SDK: an in-memory store, vectors that point one of two ways, a
 * sampler that answers what the test scripts, and a real folder on disk for the profile file.
 */
const host = vi.hoisted(() => {
  const state = {
    tables: new Map(),
    kv: new Map(),
    tools: new Map(),
    settings: { capture: false, recall_limit: 6, interval: 12, every: 50, skip: '', profile_file: '' },
    status: '',
    embeds: false,
    roots: [],
    own: '',
    prompts: [],
    sampler: () => {
      throw new Error('no model')
    },
    log: [],
  }
  const rows = (table) => {
    if (!state.tables.has(table)) state.tables.set(table, [])
    return state.tables.get(table)
  }
  const matches = (row, where = {}) => Object.entries(where).every(([key, value]) => row[key] === value)
  const storage = {
    insert: async (table, row) => {
      const all = rows(table)
      const rowid = all.reduce((most, one) => Math.max(most, one.rowid), 0) + 1
      all.push({ ...row, rowid })
      return rowid
    },
    select: async (table, query = {}) => {
      let found = rows(table).filter((row) => matches(row, query.where))
      for (const [key, way] of [...(query.order ?? [])].reverse()) {
        found = [...found].sort((a, b) => (way === 'desc' ? 1 : -1) * (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0))
      }
      return found.slice(0, query.limit ?? 1000).map((row) => ({ ...row }))
    },
    update: async (table, set, where) => {
      let changed = 0
      for (const row of rows(table)) {
        if (matches(row, where)) {
          Object.assign(row, set)
          changed += 1
        }
      }
      return changed
    },
    delete: async (table, where) => {
      const all = rows(table)
      const keep = 'all' in where ? [] : all.filter((row) => !matches(row, where))
      state.tables.set(table, keep)
      return all.length - keep.length
    },
    count: async (table, where) => rows(table).filter((row) => matches(row, where)).length,
    get: async (key) => state.kv.get(key),
    set: async (key, value) => void state.kv.set(key, value),
    remove: async (key) => void state.kv.delete(key),
  }
  // Two numbers say which way a sentence points: toward "Brno and the sister" or away from it.
  const embedded = (text) => (/brno|eva|sister/i.test(text) ? [1, 0.1] : /asthma/i.test(text) ? [0.7, -0.7] : [0, 1])
  const alexia = {
    manifest: { name: 'Long-term memory' },
    start: async () => {},
    onSettingsChanged: () => {},
    settings: async () => state.settings,
    status: async (_key, text) => void (state.status = text),
    storage,
    tool: (name, definition, handler) => {
      state.tools.set(name, handler)
      return { update: () => {} }
    },
    answers: async () => ({ answers: state.embeds, here: state.embeds }),
    capability: async (cap, args) => {
      if (cap !== 'text.embed' || !state.embeds) throw new Error('nothing answers')
      return { content: [{ type: 'text', text: '{}' }], structuredContent: { vectors: args.texts.map(embedded) } }
    },
    host: async () => ({ paths: { ownDir: state.own } }),
    server: {
      server: {
        listRoots: async () => ({ roots: state.roots }),
        createMessage: async (params) => {
          const text = params.messages[0].content.text
          state.prompts.push(text)
          return { content: { type: 'text', text: await state.sampler(text) } }
        },
      },
    },
  }
  return { state, alexia }
})

vi.mock('@alexia/sdk', () => ({
  plugin: () => host.alexia,
  fromJsonSchema: (schema) => schema,
  log: { info: (line) => host.state.log.push(String(line)) },
}))

const { state } = host
await import('../index.js')

const base = mkdtempSync(join(tmpdir(), 'alexia-locked-'))
const chosen = join(base, 'chosen')
mkdirSync(chosen)
afterAll(() => rmSync(base, { recursive: true, force: true }))

const text = (result) => result.content.map((part) => part.text).join('\n')
const run = (name, args = {}, ctx) => state.tools.get(name)(args, ctx)
const table = (name) => state.tables.get(name) ?? (state.tables.set(name, []), state.tables.get(name))
const facts = () => table('facts')
const idOf = (words) => String(facts().find((row) => row.text.includes(words)).rowid)

beforeEach(() => {
  state.tables.clear()
  state.kv.clear()
  state.prompts.length = 0
  state.status = ''
  state.embeds = false
  state.settings = { capture: false, recall_limit: 6, interval: 12, every: 50, skip: '', profile_file: '' }
  state.roots = [{ uri: pathToFileURL(chosen).href, name: 'chosen' }]
  state.own = join(base, 'own')
  state.sampler = () => {
    throw new Error('no model')
  }
})
afterEach(() => {
  vi.useRealTimers()
})

test('locked_absent_from_recall_by_default', async () => {
  await run('remember', { text: 'The owner takes medication for thyroid problems.' })
  await run('remember', { text: 'The owner takes the tram to work.' })
  await run('remember', { text: 'The owner’s name is Vaclav.', pin: true })
  await run('remember', { text: 'The owner takes a secret holiday in June.', pin: true })
  expect(text(await run('lock', { id: idOf('thyroid') }))).toContain('Locked')
  await run('lock', { id: idOf('secret holiday') })

  // Left out entirely: not the sentence, not a hint that there was one, not a branch header over it.
  const found = text(await run('recall', { about: 'owner takes medication thyroid' }))
  expect(found).not.toMatch(/thyroid|medication/i)
  expect(found).toContain('tram')
  expect(text(await run('recall', { about: 'thyroid medication' }))).toBe('Nothing was written down about that.')
  expect(text(await run('recall', { about: 'secret holiday' }))).toBe('Nothing was written down about that.')
  // The same for what is always known: a pinned note that is locked is not in the profile.
  const profile = text(await run('profile'))
  expect(profile).toContain('Vaclav')
  expect(profile).not.toMatch(/holiday/i)
  expect(text(await run('profile', { unlocked: false }))).not.toMatch(/holiday/i)
  // The owner's own lists still show it, as locked, so there is something to unlock.
  const listed = await run('memories', { unlocked: true })
  expect(listed.structuredContent.rows.find((row) => row.text.includes('thyroid')).tags).toEqual([{ says: '🔒 locked', tone: 'quiet' }])
  // Nothing that is said about it comes from a summary either: it is blanked when it is locked.
  for (const row of table('branches')) expect(String(row.summary ?? '')).not.toMatch(/thyroid|holiday/i)
  expect(text(await run('lock', { id: '999' }))).toContain('no remembered thing')
})

test('present_when_unlocked', async () => {
  await run('remember', { text: 'The owner takes medication for thyroid problems.' })
  await run('remember', { text: 'The owner takes a secret holiday in June.', pin: true })
  await run('lock', { id: idOf('thyroid') })
  await run('lock', { id: idOf('secret holiday') })

  // Core says it is the owner's own chat: the same calls now see them.
  expect(text(await run('recall', { about: 'thyroid medication', unlocked: true }))).toContain('thyroid problems')
  expect(text(await run('profile', { unlocked: true }))).toContain('secret holiday')
  // Unlocking is the other way back, and the lock is a column, not a copy: nothing was lost.
  expect(text(await run('unlock', { id: idOf('thyroid'), unlocked: true }))).toContain('Unlocked')
  expect(text(await run('recall', { about: 'thyroid medication' }))).toContain('thyroid problems')
  expect(facts().filter((row) => row.text.includes('thyroid'))).toHaveLength(1)
  // A replacement of a locked note is locked too; changing the words does not open it.
  const old = idOf('secret holiday')
  await run('remember', { text: 'The owner takes a secret holiday in July.', replaces: old, unlocked: true })
  expect(text(await run('recall', { about: 'secret holiday July' }))).toBe('Nothing was written down about that.')
  expect(text(await run('profile', { unlocked: true }))).toContain('July')
})

test('never_in_notice_items', async () => {
  const now = Date.UTC(2026, 10, 25, 8, 0)
  await run('remember', { text: 'The owner has a hospital appointment on 27 November.' })
  await run('remember', { text: 'The owner’s brother Petr has a birthday on 29 November.' })
  await run('remember', { text: 'The owner is learning to swim at the pool.' })
  const hospital = Number(idOf('hospital'))
  const brother = Number(idOf('brother'))
  table('dates').push({ rowid: 1, what: 'Hospital appointment', due: '2026-11-27', kind: 'event', fact_id: hospital, state: 'open' })
  table('dates').push({ rowid: 2, what: 'Pool day', due: '2026-11-27', kind: 'event', fact_id: Number(idOf('swim')), state: 'open' })
  table('people').push({ rowid: 1, name: 'Petr', aliases: '[]', relation: 'brother', birthday: '11-29', notes_ids: JSON.stringify([brother]), last_seen: now })
  const keys = async () => (await run('notice_items', { now, horizon_days: 7 })).structuredContent.items.map((item) => item.key)

  expect(await keys()).toEqual(expect.arrayContaining(['memory:date:1', 'memory:date:2']))
  expect((await keys()).some((key) => key.includes('birthday') || key.startsWith('memory:person'))).toBe(true)
  await run('lock', { id: String(hospital) })
  await run('lock', { id: String(brother) })
  const left = await keys()
  expect(left).toEqual(['memory:date:2'])
  const spoken = text(await run('notice_items', { now, horizon_days: 7 }))
  expect(spoken).not.toMatch(/hospital|petr/i)
  await run('unlock', { id: String(hospital), unlocked: true })
  expect(await keys()).toContain('memory:date:1')
})

test('profile_file_round_trip_pins_and_unpins', async () => {
  const file = join(chosen, 'profile.md')
  state.settings.profile_file = file
  await run('remember', { text: 'The owner’s name is Vaclav.', pin: true })
  await run('remember', { text: 'The owner lives in Brno.', pin: true })
  await run('remember', { text: 'The owner’s locked secret is a pin code.', pin: true })
  await run('lock', { id: idOf('secret') })
  await run('remember', { text: 'The owner likes tea.' })

  await run('sort_now')
  const written = readFileSync(file, 'utf8')
  expect(written).toContain('Edits to this file are read back')
  expect(written).toMatch(/^- The owner’s name is Vaclav\.$/m)
  expect(written).toMatch(/^- The owner lives in Brno\.$/m)
  // Only pinned notes, and never a locked one.
  expect(written).not.toContain('likes tea')
  expect(written).not.toContain('pin code')
  // Nothing changed: a second sort leaves the file alone, byte for byte.
  await run('sort_now')
  expect(readFileSync(file, 'utf8')).toBe(written)

  // The owner edits it: a line added, a line taken away.
  writeFileSync(file, `${written.replace(/^- The owner lives in Brno\.\r?\n/m, '')}- Prefers answers in Czech.\n`)
  await run('sort_now')
  const czech = facts().find((row) => row.text === 'Prefers answers in Czech.')
  expect(czech).toMatchObject({ pinned: true, source: 'stated' })
  const brno = facts().find((row) => row.text === 'The owner lives in Brno.')
  // Unpinned, and not forgotten: it is still a true fact that recall finds.
  expect(brno.pinned).toBe(false)
  expect(brno.invalid_at ?? null).toBeNull()
  expect(text(await run('recall', { about: 'owner lives Brno' }))).toContain('lives in Brno')
  const profile = text(await run('profile'))
  expect(profile).toContain('Czech')
  expect(profile).not.toContain('Brno')
  // The locked pinned note stayed out of the file and was not unpinned by being missing from it.
  expect(facts().find((row) => row.text.includes('pin code')).pinned).toBe(true)
  // And what the file says now is what is pinned.
  expect(readFileSync(file, 'utf8')).toContain('- Prefers answers in Czech.')

  // A path outside the folders chosen and the plugin's own: a sentence, and nothing written.
  const outside = join(base, 'elsewhere', 'profile.md')
  state.settings.profile_file = outside
  await run('sort_now')
  expect(existsSync(outside)).toBe(false)
  expect(state.status).toContain('outside the folders you chose')
  expect(state.status).not.toContain(base)
  // Switched off again: the sentence goes.
  state.settings.profile_file = ''
  await run('sort_now')
  expect(state.status).not.toContain('outside the folders')
})

test('nightly_merges_duplicates_keeping_history', async () => {
  state.embeds = true
  const at = new Date(2026, 10, 25, 10, 0).getTime()
  const yesterday = new Date(2026, 10, 24, 12, 0).getTime()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 24, 12, 0))

  await run('remember', { text: 'Her sister Eva lives in Brno.', pin: true })
  await run('remember', { text: 'Eva, her sister, lives in Brno these days.' })
  await run('remember', { text: 'The owner takes the tram to work.' })
  await run('remember', { text: 'The owner’s private diagnosis is asthma.' })
  await run('lock', { id: idOf('asthma') })
  table('dates').push({ rowid: 1, what: 'Old deadline', due: '2026-11-01', kind: 'deadline', fact_id: 3, state: 'open' })
  table('dates').push({ rowid: 2, what: 'Next deadline', due: '2026-12-01', kind: 'deadline', fact_id: 3, state: 'open' })
  const older = facts()[0]
  const newer = facts()[1]
  expect(older.vec).toBeDefined()
  expect(newer.vec).toBeDefined()

  // 02:00 has not come: the tidy-up waits for the first sort after it. (Until then it is still
  // the night of the 24th, which was tidied already.)
  state.kv.set('tidied', { night: '2026-11-24', at: yesterday })
  vi.setSystemTime(new Date(2026, 10, 25, 1, 30))
  await run('sort_now')
  expect(facts().every((row) => row.invalid_at === undefined)).toBe(true)

  state.sampler = (prompt) => {
    if (prompt.includes('diary entry') || prompt.includes('one person')) return 'Eva was in Brno. The owner took the tram.'
    throw new Error('no model for that')
  }
  vi.setSystemTime(at)
  facts().forEach((row) => {
    row.at = yesterday
  })
  await run('sort_now')

  // The older of the two is closed, never deleted: still in the table, pointing at the one that stays.
  expect(facts().filter((row) => row.text.includes('Eva'))).toHaveLength(2)
  const closed = facts().find((row) => row.rowid === older.rowid)
  expect(closed.invalid_at).toBe(at)
  expect(closed.replaced_by).toBe(newer.rowid)
  const kept = facts().find((row) => row.rowid === newer.rowid)
  expect(kept.invalid_at).toBeUndefined()
  // What the old one was is not lost by closing it: its pin goes to the one that stays.
  expect(kept.pinned).toBe(true)
  expect(closed.pinned).toBe(false)
  expect(text(await run('history', { id: String(newer.rowid) }))).toContain('Her sister Eva lives in Brno.')
  // Unrelated facts are untouched, and a past date is closed while a future one stays open.
  expect(facts().find((row) => row.text.includes('tram')).invalid_at).toBeUndefined()
  expect(table('dates').map((row) => [row.what, row.state])).toEqual([['Old deadline', 'closed'], ['Next deadline', 'open']])
  expect(state.status).toMatch(/Tidied at \d\d:\d\d: merged 1, closed 1\./)

  // Yesterday has its line, one row, and the locked note is nowhere near it or the prompt.
  const days = table('days')
  expect(days).toHaveLength(1)
  expect(days[0].date).toBe('2026-11-24')
  expect(days[0].text).toBe('Eva was in Brno. The owner took the tram.')
  expect(state.prompts.filter((prompt) => prompt.includes('2026-11-24')).join('\n')).not.toContain('asthma')
  expect(text(await run('timeline', { from: '2026-11-24', to: '2026-11-24' }))).toContain('2026-11-24: Eva was in Brno.')
  const weekly = await run('brief_section', { kind: 'weekly', now: at, tz_offset_min: -new Date(at).getTimezoneOffset() })
  expect(weekly.structuredContent.text).toContain('2026-11-24: Eva was in Brno.')
  expect(text(await run('brief_section', { kind: 'morning', now: at }))).toBe('')

  // Once a night: a second sort the same night does nothing, and the day is still one row.
  const before = JSON.stringify(facts())
  await run('sort_now')
  expect(JSON.stringify(facts())).toBe(before)
  expect(table('days')).toHaveLength(1)

  // Forgetting what a day's line was made from takes the line with it.
  await run('forget', { about: 'tram to work' })
  expect(table('days')).toHaveLength(0)
})

const FIRST_NOTE = 'The owner has a hospital appointment on 27 November.'

/** A locked fact, a person and a goal that hang off it, and an open note beside them. */
async function lockedWorld() {
  await run('remember', { text: FIRST_NOTE })
  await run('remember', { text: 'The owner’s brother Petr has a birthday on 29 November.' })
  await run('remember', { text: 'The owner is learning to swim at the pool.' })
  const hospital = Number(idOf('hospital'))
  const brother = Number(idOf('brother'))
  const swim = Number(idOf('swim'))
  table('people').push({ rowid: 1, name: 'Petr', aliases: '[]', relation: 'brother', notes_ids: JSON.stringify([brother]), last_seen: 1 })
  table('people').push({ rowid: 2, name: 'Eva', aliases: '[]', relation: 'sister', notes_ids: JSON.stringify([swim]), last_seen: 1 })
  table('goals').push({ rowid: 1, text: 'Get through the hospital stay', since: 1, last_touched: 1, state: 'active', fact_ids: JSON.stringify([hospital]) })
  table('goals').push({ rowid: 2, text: 'Swim a kilometre', since: 1, last_touched: 1, state: 'active', fact_ids: JSON.stringify([swim]) })
  await run('lock', { id: String(hospital) })
  await run('lock', { id: String(brother) })
  return { hospital, brother }
}

test('locked_absent_from_every_read_tool_by_default', async () => {
  const { hospital, brother } = await lockedWorld()
  const readers = [
    ['remembered', {}],
    ['browse', {}],
    ['browse', { path: 'You' }],
    ['memory_graph', {}],
    ['about_person', { name: 'Petr' }],
    ['history', { id: String(hospital) }],
    ['about_memory', { id: String(hospital) }],
    ['about_memory', { id: String(brother) }],
    ['people', {}],
    ['goals', {}],
  ]
  for (const [name, args] of readers) {
    const everything = JSON.stringify(await run(name, args))
    expect(everything, name).not.toMatch(/hospital|petr|brother/i)
  }
  // The rest is still there.
  expect(text(await run('remembered'))).toContain('swim')
  expect(text(await run('people'))).toContain('Eva')
  expect(text(await run('goals'))).toContain('Swim a kilometre')
  // And in the owner's own chat, where core says `unlocked`, everything is.
  expect(text(await run('remembered', { unlocked: true }))).toContain('hospital')
  expect(text(await run('history', { id: String(hospital), unlocked: true }))).toContain('hospital')
  expect(text(await run('about_memory', { id: String(hospital), unlocked: true }))).toContain('hospital')
  expect(text(await run('about_person', { name: 'Petr', unlocked: true }))).toContain('Petr')
  expect(text(await run('people', { unlocked: true }))).toContain('Petr')
  expect(text(await run('goals', { unlocked: true }))).toContain('hospital')
  expect(JSON.stringify(await run('memory_graph', { unlocked: true }))).toContain('hospital')
})

test('locking_removes_the_diary_line_of_the_due_day', async () => {
  await run('remember', { text: FIRST_NOTE })
  const hospital = Number(idOf('hospital'))
  // The date falls due on the 27th; the line for that day quoted it while the fact was open.
  table('dates').push({ rowid: 1, what: 'Hospital appointment', due: '2026-11-27', kind: 'event', fact_id: hospital, state: 'open' })
  table('days').push({ rowid: 1, date: '2026-11-27', text: 'The hospital appointment (2026-11-27) was today.', at: 1 })
  table('days').push({ rowid: 2, date: '2026-11-26', text: 'A quiet day.', at: 1 })
  await run('lock', { id: String(hospital) })
  expect(table('days').map((row) => row.date)).toEqual(['2026-11-26'])
  const weekly = await run('brief_section', { kind: 'weekly', now: Date.UTC(2026, 10, 28, 12), tz_offset_min: 0 })
  expect(weekly.structuredContent.text).not.toMatch(/hospital/i)
})

test('nightly_merge_into_a_locked_fact_drops_its_diary_lines', async () => {
  state.embeds = true
  const now = new Date(2026, 10, 25, 10, 0).getTime()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 24, 12, 0))
  await run('remember', { text: 'Her sister Eva lives in Brno.' })
  await run('remember', { text: 'Eva, her sister, lives in Brno these days.' })
  const older = facts()[0]
  const newer = facts()[1]
  // The older is locked, the newer is not: the merge hands the lock to the one that stays.
  await run('lock', { id: String(older.rowid) })
  table('dates').push({ rowid: 1, what: 'Eva visits', due: '2026-12-05', kind: 'event', fact_id: older.rowid, state: 'open' })
  table('days').push({ rowid: 1, date: '2026-12-05', text: 'Eva visits from Brno (2026-12-05).', at: 1 })
  table('days').push({ rowid: 2, date: '2026-11-20', text: 'A quiet day.', at: 1 })
  state.kv.set('tidied', { night: '2026-11-24', at: now - 86_400_000 })
  vi.setSystemTime(now)
  await run('sort_now')
  expect(facts().find((row) => row.rowid === newer.rowid).locked).toBe(true)
  expect(table('days').map((row) => row.date)).not.toContain('2026-12-05')
  expect(table('days').map((row) => row.date)).toContain('2026-11-20')
})

test('profile_file_that_is_not_ours_is_never_overwritten', async () => {
  const file = join(chosen, 'notes.md')
  const mine = '# My notes\n\nSome prose I wrote.\n\n- buy milk\n- call the bank\n'
  writeFileSync(file, mine)
  state.settings.profile_file = file
  await run('remember', { text: 'The owner’s name is Vaclav.', pin: true })
  await run('sort_now')
  // Untouched, nothing read from it, and a sentence saying why.
  expect(readFileSync(file, 'utf8')).toBe(mine)
  expect(facts().some((row) => /milk|bank/.test(row.text))).toBe(false)
  expect(state.status).toContain('did not write')
  // An empty file is fine to adopt.
  const empty = join(chosen, 'empty.md')
  writeFileSync(empty, '')
  state.settings.profile_file = empty
  await run('sort_now')
  expect(readFileSync(empty, 'utf8')).toContain('- The owner’s name is Vaclav.')
  expect(state.status).not.toContain('did not write')
})

test('two_profile_syncs_at_once_add_a_line_only_once', async () => {
  const file = join(chosen, 'profile.md')
  state.settings.profile_file = file
  await run('remember', { text: 'The owner’s name is Vaclav.', pin: true })
  await run('sort_now')
  writeFileSync(file, `${readFileSync(file, 'utf8')}- Prefers answers in Czech.\n`)
  // The sort and the gardener at the same moment.
  await Promise.all([run('sort_now'), run('sort_now'), run('sort_now')])
  expect(facts().filter((row) => row.text === 'Prefers answers in Czech.')).toHaveLength(1)
})

test('write_tools_never_echo_a_locked_note', async () => {
  const { hospital, brother } = await lockedWorld()
  const swim = Number(idOf('swim'))
  // An older wording of the locked note, from before locks covered every version, and an open
  // note that suggests replacing the locked one: neither may be a way round the lock.
  table('facts').push({ rowid: 50, name: 'check-up', text: 'The owner had a hospital check-up in May.', kind: 'event', source: 'stated', at: 1, valid_from: 1, invalid_at: 2, replaced_by: hospital })
  table('facts').push({ rowid: 51, name: 'tea', text: 'The owner drinks green tea.', kind: 'preference', source: 'stated', at: 3, valid_from: 3, suggest_replaces: hospital })
  const sealed = () => JSON.stringify(facts().filter((row) => [hospital, brother, 50].includes(Number(row.rowid))))
  const before = sealed()
  const leaks = /hospital|petr|brother|check-up/i
  const top = Math.max(...facts().map((row) => Number(row.rowid))) + 2
  const writers = [
    ['still_true', (id) => ({ id })],
    ['no_longer_true', (id) => ({ id })],
    ['move', (id) => ({ id, path: 'You/Moved' })],
    ['pin', (id) => ({ id })],
    ['unpin', (id) => ({ id })],
    ['lock', (id) => ({ id })],
    ['unlock', (id) => ({ id })],
    ['accept_suggestion', (id) => ({ id })],
    ['history', (id) => ({ id })],
    ['about_memory', (id) => ({ id })],
    ['remember', (id) => ({ text: `Note number ${id} is plain.`, replaces: id })],
    // Last, because it really removes the open ones.
    ['forget_one', (id) => ({ id })],
  ]
  let calls = 0
  for (const [name, args] of writers) {
    for (let id = 1; id <= top; id += 1) {
      const said = JSON.stringify(await run(name, args(String(id))))
      expect(said, `${name} ${id}`).not.toMatch(leaks)
      calls += 1
    }
  }
  expect(calls).toBe(writers.length * top)
  for (const about of ['hospital appointment', 'brother Petr birthday', 'hospital check-up May']) {
    expect(JSON.stringify(await run('forget', { about })), about).not.toMatch(leaks)
  }
  // The owner's panel lists, asked without `unlocked`, say nothing of it either.
  expect(JSON.stringify(await run('memories'))).not.toMatch(leaks)
  expect(JSON.stringify(await run('memory_tree'))).not.toMatch(leaks)
  // And none of those calls changed the locked notes: not unlocked, unpinned, closed, moved or gone.
  expect(sealed()).toBe(before)
  expect(facts().find((row) => row.rowid === 51)?.suggest_replaces ?? hospital).toBe(hospital)
  // Swim was open, so the tools did work on it: it was closed, then locked (which anyone may do),
  // and from then on it was out of reach too, so forget_one left it.
  const swum = facts().find((row) => Number(row.rowid) === swim)
  expect(swum.locked).toBe(true)
  expect(swum.invalid_at).toBeGreaterThan(0)

  // In the owner's own chat the same tools reach it.
  expect(JSON.stringify(await run('memories', { unlocked: true }))).toMatch(/hospital/)
  expect(JSON.stringify(await run('memory_tree', { unlocked: true }))).toMatch(/hospital/)
  expect(text(await run('still_true', { id: String(hospital), unlocked: true }))).toContain('hospital')
  expect(text(await run('pin', { id: String(hospital), unlocked: true }))).toContain('hospital')
  expect(text(await run('forget_one', { id: String(brother), unlocked: true }))).toContain('brother Petr')
  expect(facts().some((row) => Number(row.rowid) === brother)).toBe(false)
})

test('lock_and_unlock_take_every_version', async () => {
  await run('remember', { text: 'The owner lives in Brno.' })
  const old = idOf('Brno')
  await run('remember', { text: 'The owner lives in Prague.', replaces: old })
  await run('lock', { id: idOf('Prague') })
  expect(facts().every((row) => row.locked === true)).toBe(true)
  expect(JSON.stringify(await run('history', { id: old }))).not.toMatch(/Brno|Prague/)
  // Unlocking is only for a call that may read it, and then opens every version again.
  expect(text(await run('unlock', { id: old }))).toContain('no remembered thing')
  expect(facts().every((row) => row.locked === true)).toBe(true)
  expect(text(await run('unlock', { id: old, unlocked: true }))).toContain('Unlocked')
  expect(facts().every((row) => row.locked === false)).toBe(true)
  expect(text(await run('history', { id: old }))).toMatch(/Brno[\s\S]*Prague/)
})
