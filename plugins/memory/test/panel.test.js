// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest'

/**
 * The memory screen (P3-17): the manifest's widgets and the row tools they read. These drive the real
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

const base = mkdtempSync(join(tmpdir(), 'alexia-panel-'))
const chosen = join(base, 'chosen')
mkdirSync(chosen)
afterAll(() => rmSync(base, { recursive: true, force: true }))

const text = (result) => result.content.map((part) => part.text).join('\n')
const run = (name, args = {}, ctx) => state.tools.get(name)(args, ctx)
const table = (name) => state.tables.get(name) ?? (state.tables.set(name, []), state.tables.get(name))
const facts = () => table('facts')
const idOf = (words) => String(facts().find((row) => row.text.includes(words)).rowid)

const alexiaInsert = (name, row) => host.alexia.storage.insert(name, row)

beforeEach(() => {
  state.tables.clear()
  state.kv.clear()
  state.prompts.length = 0
  state.status = ''
  state.embeds = false
  state.settings = { capture: false, recall_limit: 6, interval: 12, every: 50, skip: '', profile_file: '' }
  state.roots = [{ uri: pathToFileURL(chosen).href, name: 'chosen' }]
  state.own = join(base, 'own')
})
afterEach(() => {
  vi.useRealTimers()
})

const manifest = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'))
const widgets = manifest.panel.widgets
const widget = (key) => widgets.find((one) => one.key === key)
const rowsOf = async (name, args) => (await run(name, args)).structuredContent.rows

test('manifest_widgets_reference_existing_tools', () => {
  for (const key of ['remembered_tree', 'people', 'goals', 'coming_up', 'your_days']) expect(widget(key), key).toBeDefined()
  // Added after the tree, in the order the screen reads.
  expect(widgets.map((one) => one.key).slice(0, 5)).toEqual(['remembered_tree', 'people', 'goals', 'coming_up', 'your_days'])
  expect(widget('people').rows).toBe('people_rows')
  expect(widget('goals').rows).toBe('goal_rows')
  expect(widget('coming_up').rows).toBe('date_rows')
  expect(widget('your_days').rows).toBe('day_rows')
  expect(widget('people').detail).toBe('about_person')
  expect(widget('goals').rowActions.map((one) => one.tool)).toEqual(['goal_done'])
  // Every tool a widget names — rows, detail, row action — is a tool the plugin registers.
  for (const one of widgets) {
    for (const name of [one.rows, one.detail, ...(one.rowActions ?? []).map((action) => action.tool)].filter(Boolean)) {
      expect(state.tools.has(name), `${one.key} -> ${name}`).toBe(true)
    }
  }
})

test('people_rows_shape', async () => {
  await alexiaInsert('people', { name: 'Petr', aliases: '[]', relation: 'brother', birthday: '1990-03-14', notes_ids: '[]', last_seen: Date.UTC(2026, 4, 2) })
  await alexiaInsert('people', { name: 'Eva', aliases: '[]', relation: '', notes_ids: '[]', last_seen: 0, follow_up: 'send the photos' })
  const rows = await rowsOf('people_rows')
  expect(rows).toEqual([
    { id: '2', name: 'Eva', relation: '', birthday: '', lastSeen: '', note: 'To follow up: send the photos' },
    { id: '1', name: 'Petr', relation: 'brother', birthday: '1990-03-14', lastSeen: '2026-05-02' },
  ])
  // Every column the widget draws is a key of the row.
  for (const column of widget('people').columns) expect(Object.keys(rows[1])).toContain(column.key)
  // The detail call is handed the row's id, and answers for that person.
  expect(text(await run('about_person', { id: rows[1].id }))).toContain('Petr — brother')
  expect(text(await run('about_person', { name: 'petr' }))).toContain('Petr')
})

test('date_rows_next_thirty_days', async () => {
  const now = Date.UTC(2026, 5, 10, 12, 0)
  const add = (what, due, extra = {}) => alexiaInsert('dates', { what, due, kind: 'appointment', fact_id: 0, state: 'open', ...extra })
  await add('Dentist', '2026-06-10T08:00')
  await add('Passport', '2026-07-10')
  await add('Too far', '2026-07-11')
  await add('Yesterday', '2026-06-09')
  await add('Done already', '2026-06-12', { state: 'done' })
  await add('Soon', '2026-06-12')
  const rows = await rowsOf('date_rows', { now })
  expect(rows.map((one) => one.what)).toEqual(['Dentist', 'Soon', 'Passport'])
  expect(rows[0]).toEqual({ id: '1', what: 'Dentist', when: '2026-06-10T08:00', kind: 'appointment' })
  for (const column of widget('coming_up').columns) expect(Object.keys(rows[0])).toContain(column.key)
  // The owner's own clock decides which day it is: 23:30 UTC is already the 11th in Prague.
  const late = Date.UTC(2026, 5, 10, 23, 30)
  expect((await rowsOf('date_rows', { now: late, tz_offset_min: 120 })).map((one) => one.what)).not.toContain('Dentist')
})

test('your_days_newest_first_sixty', async () => {
  for (let n = 0; n < 70; n += 1) {
    const date = new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString().slice(0, 10)
    await alexiaInsert('days', { date, text: `Day ${n}.`, at: n })
  }
  const rows = await rowsOf('day_rows')
  expect(rows).toHaveLength(60)
  expect(rows[0]).toMatchObject({ date: '2026-03-11', text: 'Day 69.' })
  expect(rows[59].date).toBe('2026-01-11')
  expect(widget('your_days').columns.map((one) => one.key)).toEqual(['date', 'text'])
})

test('goal_rows_and_done', async () => {
  await run('goal', { text: 'Run a half marathon' })
  await run('goal', { text: 'Learn Czech' })
  await run('goal_done', { id: '1' })
  const rows = await rowsOf('goal_rows')
  expect(rows.map((one) => [one.goal, one.state])).toEqual([['Learn Czech', 'active'], ['Run a half marathon', 'done']])
  for (const column of widget('goals').columns) expect(Object.keys(rows[0])).toContain(column.key)
})

test('locked_fact_hidden_without_unlocked', async () => {
  await run('remember', { text: 'The owner takes medication for thyroid problems.' })
  await run('remember', { text: 'The owner takes the tram to work.' })
  await run('lock', { id: idOf('thyroid') })
  const sealed = Number(idOf('thyroid'))
  // The life graph rows that hang off a locked fact are as private as the fact.
  await alexiaInsert('people', { name: 'Dr Novak', aliases: '[]', relation: 'doctor', notes_ids: JSON.stringify([sealed]), last_seen: 1 })
  await alexiaInsert('goals', { text: 'Treat the thyroid', since: 1, last_touched: 1, state: 'active', fact_ids: JSON.stringify([sealed]) })
  await alexiaInsert('dates', { what: 'Thyroid scan', due: '2026-06-12', kind: 'appointment', fact_id: sealed, state: 'open' })
  const now = Date.UTC(2026, 5, 10)
  const calls = [['memory_tree'], ['memories'], ['about_memory', { id: String(sealed) }], ['people_rows'], ['goal_rows'], ['date_rows', { now }], ['day_rows']]
  for (const [name, args = {}] of calls) {
    for (const flag of [{}, { unlocked: false }]) {
      expect(JSON.stringify(await run(name, { ...args, ...flag })), name).not.toMatch(/thyroid|medication|Novak/i)
    }
  }
  expect(JSON.stringify(await run('memory_tree'))).toContain('tram')
  // The owner's panel passes the flag, and then the same calls show it.
  expect(JSON.stringify(await run('memory_tree', { unlocked: true }))).toContain('thyroid')
  expect(text(await run('about_memory', { id: String(sealed), unlocked: true }))).toContain('thyroid problems')
  expect((await rowsOf('people_rows', { unlocked: true })).map((one) => one.name)).toEqual(['Dr Novak'])
  expect((await rowsOf('goal_rows', { unlocked: true })).map((one) => one.goal)).toEqual(['Treat the thyroid'])
  expect((await rowsOf('date_rows', { now, unlocked: true })).map((one) => one.what)).toEqual(['Thyroid scan'])
})

test('locked_tag_and_actions_present', async () => {
  await run('remember', { text: 'The owner takes medication for thyroid problems.' })
  await run('remember', { text: 'The owner takes the tram to work.' })
  await run('lock', { id: idOf('thyroid') })

  const notes = (await run('memory_tree', { unlocked: true })).structuredContent.nodes.filter((node) => node.kind === 'note')
  const locked = notes.find((node) => node.label.includes('thyroid'))
  const plain = notes.find((node) => node.label.includes('tram'))
  expect(locked.tags).toContain('🔒 locked')
  expect(plain.tags).not.toContain('🔒 locked')
  // Every fact says where it came from, on the node and in its detail.
  for (const node of notes) expect(node.summary).toMatch(/^you said it/)
  expect(text(await run('about_memory', { id: locked.id, unlocked: true }))).toMatch(/Where it came from: you said it[\s\S]*🔒 locked/)
  expect(text(await run('about_memory', { id: plain.id }))).not.toContain('🔒')

  // The manifest offers Lock on a note that is not locked and Unlock on one that is, in the tree and the list,
  // next to v2's pin actions.
  for (const key of ['remembered_tree', 'remembered_list']) {
    const actions = widget(key).rowActions
    expect(actions.find((one) => one.tool === 'lock').unless).toEqual({ tag: '🔒 locked' })
    expect(actions.find((one) => one.tool === 'unlock').when).toEqual({ tag: '🔒 locked' })
    const tools = actions.map((one) => one.tool)
    expect(tools.indexOf('lock')).toBe(tools.indexOf('unpin') + 1)
  }
  // The list's own rows carry the tag the actions look for, and unlocking from the screen removes it.
  const listed = (await rowsOf('memories', { unlocked: true })).find((row) => row.text.includes('thyroid'))
  expect(listed.tags.map((tag) => tag.says)).toContain('🔒 locked')
  await run('unlock', { id: locked.id, unlocked: true })
  expect((await rowsOf('memories', { unlocked: true })).find((row) => row.text.includes('thyroid')).tags).toEqual([])
})
