// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, expect, test, vi } from 'vitest'

/**
 * Where a fact came from, corrections, and forgetting (P3-13).
 *
 * These drive the real `index.js` against a stand-in for the SDK: an in-memory store, a
 * sampler that answers what the test scripts, and a `text.embed` that is there or is not.
 * Nothing is mocked inside the plugin itself, so what is tested is what runs.
 */
const host = vi.hoisted(() => {
  const state = {
    tables: new Map(),
    kv: new Map(),
    tools: new Map(),
    settings: { capture: true, recall_limit: 6, interval: 12, every: 50, skip: '' },
    status: '',
    embeds: true,
    calls: [],
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
      state.calls.push(['delete', table])
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
  // Two numbers say which way a sentence points: toward "where she lives" or away from it.
  const embedded = (text) => (/brno|prague|lives|live|sibling|sister/i.test(text) ? [1, 0.1] : [0, 1])
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
      state.calls.push(['capability', cap])
      if (cap !== 'text.embed' || !state.embeds) throw new Error('nothing answers')
      const vectors = args.texts.map(embedded)
      return { content: [{ type: 'text', text: '{}' }], structuredContent: { vectors } }
    },
    server: {
      server: {
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

const text = (result) => result.content.map((part) => part.text).join('\n')
const run = (name, args = {}, ctx) => state.tools.get(name)(args, ctx)
const within = (channel, session) => ({ mcpReq: { _meta: { 'alexia/privateContext': { channel, session } } } })
const facts = () => state.tables.get('facts') ?? []
const live = () => facts().filter((row) => row.invalid_at === undefined || row.invalid_at === null)

beforeEach(() => {
  state.tables.clear()
  state.kv.clear()
  state.calls.length = 0
  state.prompts.length = 0
  state.embeds = false
  state.settings = { capture: true, recall_limit: 6, interval: 12, every: 50, skip: '' }
  state.sampler = (prompt) => {
    // Only the sorting prompt is scripted; filing and summaries are not what these test.
    if (!prompt.includes('Exchanges:')) throw new Error('no model for that')
    return '[]'
  }
})

test('fact_remembers_where_it_came_from', async () => {
  await run('remember', { text: 'Her sister Eva lives in Brno.' }, within('telegram', 7))
  await run('remember', { text: 'The thesis plan is due in May.', doc: 'Thesis plan.docx' })
  await run('remember', { text: 'She likes tea.' })
  const [said, doc, bare] = facts()
  expect(said).toMatchObject({ source: 'stated', src_channel: 'telegram', src_session: 7 })
  expect(doc).toMatchObject({ src_doc: 'Thesis plan.docx' })
  // No origin from the host: the columns are not written at all, rather than written null.
  expect('src_channel' in bare).toBe(false)
  expect('src_session' in bare).toBe(false)

  // A fact the sorting pass writes carries where the exchange it came from was said.
  state.sampler = () => '[{"name":"her bike","text":"She rides a green bike.","kind":"fact"}]'
  await run('capture', { said: 'I ride my green bike every day', answered: 'Nice, a green bike.', channel: 'window', session: 3 })
  await run('sort_now')
  const worked = facts().find((row) => /green bike/.test(row.text))
  expect(worked).toMatchObject({ source: 'inferred', src_channel: 'window', src_session: 3 })
})

test('recall_line_shows_source', async () => {
  await run('remember', { text: 'Her sister Eva lives in Brno.' }, within('telegram', 7))
  await run('remember', { text: 'The thesis plan lives in a shared folder.', doc: 'Thesis plan.docx' })
  facts()[0].at = Date.UTC(new Date().getUTCFullYear(), 10, 12)
  state.sampler = () => '[{"name":"her cat","text":"Her cat is called Misa.","kind":"fact"}]'
  await run('capture', { said: 'my cat Misa sleeps all day', answered: 'Cats do.', channel: 'telegram' })
  await run('sort_now')

  const sister = text(await run('recall', { about: 'sister Eva' }))
  expect(sister).toContain('(you said it on Telegram, 12 Nov')
  const plan = text(await run('recall', { about: 'thesis plan folder' }))
  expect(plan).toContain('(from “Thesis plan.docx”')
  const cat = text(await run('recall', { about: 'cat Misa' }))
  expect(cat).toMatch(/\(worked out rather than said, from a Telegram chat on \d{1,2} [A-Z][a-z]{2}/)
  // A fact written before any of this has no channel and says only what is true.
  delete facts()[0].src_channel
  expect(text(await run('recall', { about: 'sister Eva' }))).toMatch(/\(you said it, 12 Nov/)
})

test('by words only when nothing can embed, and found by meaning when something can', async () => {
  await run('remember', { text: 'Her sister Eva lives in Brno.' })
  expect(state.status).toBe('● 1 thing remembered, by words only: nothing here can embed text, writing things down by itself')
  expect('vec' in facts()[0]).toBe(false)
  // Nothing matches by words; without a vector that is nothing.
  expect(text(await run('recall', { about: 'where does my sibling live' }))).toMatch(/Nothing was written down/)

  // Something starts answering: the next backfill embeds what was waiting.
  state.embeds = true
  await run('sort_now')
  expect(JSON.parse(facts()[0].vec)).toEqual([1, 0.1])
  expect(state.status).toContain('found by meaning')
  expect(text(await run('recall', { about: 'where does my sibling live' }))).toContain('Eva lives in Brno')
  // A new fact is embedded as it is written.
  await run('remember', { text: 'She likes tea.' })
  expect(JSON.parse(facts()[1].vec)).toEqual([0, 1])
})

test('correction_replaces_not_duplicates', async () => {
  await run('remember', { text: 'The user lives in Prague.' })
  const [old] = facts()
  state.sampler = (prompt) => {
    // The facts handed over carry their ids, and the rule about corrections is in the prompt.
    expect(prompt).toContain(`#${old.rowid} `)
    expect(prompt).toMatch(/correction replaces/i)
    return JSON.stringify([
      { name: 'where she lives', text: 'The user lives in Brno, not Prague.', kind: 'fact', replaces: String(old.rowid) },
    ])
  }
  await run('capture', { said: "no, it's Brno, not Prague", answered: 'Got it, Brno.' })
  await run('sort_now')
  expect(facts()).toHaveLength(2)
  expect(live().map((row) => row.text)).toEqual(['The user lives in Brno, not Prague.'])
  const closed = facts().find((row) => row.rowid === old.rowid)
  expect(closed.replaced_by).toBe(facts().find((row) => /Brno/.test(row.text)).rowid)
  expect(text(await run('recall', { about: 'where does the user live Brno' }))).not.toContain('lives in Prague.')
})

test('forget_clears_buffer_first', async () => {
  await run('remember', { text: 'Her sister Eva lives in Brno.' })
  await run('capture', { said: 'my sister Eva moved to Brno last year', answered: 'Noted, Eva is in Brno.' })
  expect(state.tables.get('buffer')).toHaveLength(1)
  state.calls.length = 0

  await run('forget', { about: 'Eva' })
  // The buffer is emptied before the fact is deleted, so no pass can write it back in between.
  const order = state.calls
    .filter(([kind, table]) => kind === 'delete' && (table === 'buffer' || table === 'facts'))
    .map(([, table]) => table)
  expect(order[0]).toBe('buffer')
  expect(order).toContain('facts')
  expect(state.tables.get('buffer')).toHaveLength(0)

  // And the sorting pass that would have restored it finds nothing waiting and asks no model.
  state.sampler = () => '[{"name":"eva","text":"Her sister Eva lives in Brno.","kind":"person"}]'
  await run('sort_now')
  expect(facts()).toHaveLength(0)
  expect(state.prompts.some((prompt) => prompt.includes('Exchanges:'))).toBe(false)
})
