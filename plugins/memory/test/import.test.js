// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeEach, expect, test, vi } from 'vitest'
import { insideRoots, MESSAGES_MOST, parseExport } from '../import.js'

/**
 * Importing from another assistant's export (P3-15, ME-18). The parsers are argued with as pure
 * functions; the tool is driven through the real `index.js` against a stand-in SDK, a real
 * folder on disk and a scripted sampler, so what is tested is what runs.
 */
const host = vi.hoisted(() => {
  const state = {
    tables: new Map(),
    kv: new Map(),
    tools: new Map(),
    settings: { capture: false, recall_limit: 6, interval: 12, every: 50, skip: '', profile_file: '' },
    roots: [],
    own: '',
    prompts: [],
    sampler: () => '[]',
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
  const alexia = {
    manifest: { name: 'Long-term memory' },
    start: async () => {},
    onSettingsChanged: () => {},
    settings: async () => state.settings,
    status: async () => {},
    storage,
    tool: (name, definition, handler) => {
      state.tools.set(name, handler)
      return { update: () => {} }
    },
    answers: async () => ({ answers: false, here: false }),
    capability: async () => {
      throw new Error('nothing answers')
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

const base = mkdtempSync(join(tmpdir(), 'alexia-import-'))
const chosen = join(base, 'chosen')
const elsewhere = join(base, 'elsewhere')
mkdirSync(chosen)
mkdirSync(elsewhere)
afterAll(() => rmSync(base, { recursive: true, force: true }))

const text = (result) => result.content.map((part) => part.text).join('\n')
const run = (name, args = {}, ctx) => state.tools.get(name)(args, ctx)
const facts = () => state.tables.get('facts') ?? []
const put = (dir, name, body) => {
  const path = join(dir, name)
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body))
  return path
}

beforeEach(() => {
  state.tables.clear()
  state.kv.clear()
  state.prompts.length = 0
  state.roots = [{ uri: pathToFileURL(chosen).href, name: 'chosen' }]
  state.own = join(base, 'own')
  state.sampler = () => '[]'
})

/** One ChatGPT conversation as its export writes it: a `mapping` of nodes with messages in them. */
const conversation = (said, extra = {}) => ({
  title: 'A chat',
  create_time: 1_700_000_000,
  mapping: Object.fromEntries(
    said.flatMap((line, i) => [
      [`u${i}`, { message: { author: { role: 'user' }, create_time: 1_700_000_000 + i * 2, content: { parts: [line] } } }],
      [`a${i}`, { message: { author: { role: 'assistant' }, create_time: 1_700_000_001 + i * 2, content: { parts: [`Answer to ${line}`] } } }],
    ]),
  ),
  ...extra,
})

test('chatgpt_memory_entries', async () => {
  // Memory entries win over messages when the export has them, wherever it keeps them.
  const body = [conversation(['I ride a green bike every day to school'], { memory: ['Lives in Brno', { content: 'Likes strong tea' }] })]
  const parsed = parseExport('conversations.json', JSON.stringify(body))
  expect(parsed).toEqual({ assistant: 'ChatGPT', kind: 'memories', items: ['Lives in Brno', 'Likes strong tea'] })
  expect(parseExport('memory.json', JSON.stringify({ memory: ['Has a sister called Eva'] })).items).toEqual(['Has a sister called Eva'])

  // Through the tool, from the folder the zip was unpacked to: nothing is sorted by a model.
  const folder = join(chosen, 'chatgpt-export')
  mkdirSync(folder)
  put(folder, 'conversations.json', body)
  put(folder, 'user.json', { id: 'not read' })
  const done = await run('import_memories', { path: folder })
  expect(done.isError).not.toBe(true)
  expect(text(done)).toContain('Imported 2 memories from ChatGPT')
  expect(facts().map((row) => row.text).sort()).toEqual(['Likes strong tea', 'Lives in Brno'])
  expect(state.prompts).toHaveLength(0)
  // Run again: what is held is not written twice.
  expect(text(await run('import_memories', { path: folder }))).toContain('0 memories')
  expect(facts()).toHaveLength(2)
})

test('chatgpt_falls_back_to_user_messages_capped', async () => {
  const many = Array.from({ length: MESSAGES_MOST + 100 }, (_, i) => `Message number ${i} about my day at work`)
  const parsed = parseExport('conversations.json', JSON.stringify([conversation(many)]))
  expect(parsed.kind).toBe('messages')
  expect(parsed.items).toHaveLength(MESSAGES_MOST)
  // Only the owner's own words, the newest of them, oldest first. Nothing the assistant said.
  expect(parsed.items.every((line) => line.startsWith('Message number'))).toBe(true)
  expect(parsed.items.at(-1)).toBe(many.at(-1))
  expect(parsed.items[0]).toBe(many[100])

  // Through the tool: 45 messages go to the sorting pass in three batches, and what it writes
  // is stated and says where it came from, not "worked out".
  const file = put(chosen, 'conversations.json', [conversation(Array.from({ length: 45 }, (_, i) => `I walked the dog number ${i} around the park`))])
  let call = 0
  state.sampler = () => {
    call += 1
    return JSON.stringify([{ name: `walk ${call}`, text: `The owner took walk number ${call} to a park.`, kind: 'fact' }])
  }
  const done = await run('import_memories', { path: file }, undefined)
  expect(done.isError).not.toBe(true)
  // Three batches of at most twenty; the filing that follows asks its own questions after them.
  expect(state.prompts.filter((one) => one.includes('Exchanges:'))).toHaveLength(3)
  expect(state.prompts[0]).toContain('I walked the dog number 0 ')
  expect(state.prompts[0]).not.toContain('Answer to')
  expect(facts()).toHaveLength(3)
  for (const row of facts()) expect(row).toMatchObject({ source: 'stated', src_doc: 'Imported from ChatGPT' })
  expect(done.structuredContent).toMatchObject({ read: 45, written: 3, kind: 'messages' })

  // No model reachable: it stops and says so, and nothing half-written is left behind.
  state.tables.clear()
  state.sampler = () => {
    throw new Error('no model')
  }
  const stopped = await run('import_memories', { path: file })
  expect(text(stopped)).toContain('stopped')
  expect(facts()).toHaveLength(0)
})

test('claude_markdown_list', async () => {
  const markdown = [
    '# Memories',
    '',
    '## Work',
    '- Works on a grant application for the university',
    '- **Prefers** short answers in Czech',
    '',
    '## Home',
    '* Has a cat called Misa',
    '1. Lives in Brno',
    '- Works on a grant application for the university',
    '---',
  ].join('\n')
  const parsed = parseExport('claude-memory.md', markdown)
  expect(parsed.assistant).toBe('Claude')
  expect(parsed.items).toEqual([
    'Works on a grant application for the university',
    'Prefers short answers in Czech',
    'Has a cat called Misa',
    'Lives in Brno',
  ])
  // The JSON form: strings, or objects carrying the text.
  const json = parseExport('memories.json', JSON.stringify([{ text: 'Likes tea' }, 'Likes coffee too', { memory: 'Owns a bike' }]))
  expect(json).toEqual({ assistant: 'Claude', kind: 'memories', items: ['Likes tea', 'Likes coffee too', 'Owns a bike'] })

  const file = put(chosen, 'claude-memory.md', markdown)
  expect(text(await run('import_memories', { path: file }))).toContain('Imported 4 memories from Claude')
  expect(facts().map((row) => row.src_doc)).toEqual(Array(4).fill('Imported from Claude'))
})

test('plain_lines', async () => {
  const body = 'Likes oat milk\r\n\r\n  \r\nHas two brothers\nlikes oat milk\nok\n'
  const parsed = parseExport('notes.txt', body)
  expect(parsed).toEqual({ assistant: 'a text file', kind: 'memories', items: ['Likes oat milk', 'Has two brothers'] })
  // The owner may say where it came from; the facts then say so.
  const file = put(chosen, 'notes.txt', body)
  expect(text(await run('import_memories', { path: file, assistant: 'Gemini' }))).toContain('Imported 2 memories from Gemini')
  expect(facts().every((row) => row.src_doc === 'Imported from Gemini')).toBe(true)
  // A file with nothing in it, and one that is not a list at all, are refused rather than guessed at.
  expect(parseExport('empty.txt', '  \n\n')).toBeNull()
  expect(parseExport('broken.json', '{"memory": [')).toBeNull()
})

test('outside_roots_refused', async () => {
  const outside = put(elsewhere, 'memories.txt', 'Likes oat milk\nHas two brothers')
  const refused = await run('import_memories', { path: outside })
  expect(refused.isError).toBe(true)
  expect(text(refused)).toContain('not inside a folder you chose')
  expect(facts()).toHaveLength(0)
  // `..` does not walk out of a folder that was chosen.
  const sneaky = join(chosen, '..', 'elsewhere', 'memories.txt')
  expect((await run('import_memories', { path: sneaky })).isError).toBe(true)
  // No folders chosen at all: nothing may be read.
  state.roots = []
  const inside = put(chosen, 'memories.txt', 'Likes oat milk')
  expect((await run('import_memories', { path: inside })).isError).toBe(true)
  // And a relative path is not a place.
  state.roots = [{ uri: pathToFileURL(chosen).href }]
  expect((await run('import_memories', { path: 'memories.txt' })).isError).toBe(true)
  expect(facts()).toHaveLength(0)

  expect(insideRoots(join(chosen, 'a', 'b.txt'), [pathToFileURL(chosen).href])).toBe(true)
  expect(insideRoots(chosen, [pathToFileURL(chosen).href])).toBe(true)
  expect(insideRoots(`${chosen}-other`, [pathToFileURL(chosen).href])).toBe(false)
  expect(insideRoots(outside, [{ uri: pathToFileURL(chosen).href }])).toBe(false)
})

test('imported_facts_show_source', async () => {
  const file = put(chosen, 'memory.json', { memory: ['Her sister Eva lives in Brno'] })
  await run('import_memories', { path: file })
  expect(facts()[0]).toMatchObject({ text: 'Her sister Eva lives in Brno', source: 'stated', src_doc: 'Imported from ChatGPT' })
  const shown = text(await run('recall', { about: 'sister Eva Brno' }))
  expect(shown).toContain('Her sister Eva lives in Brno')
  expect(shown).toContain('from “Imported from ChatGPT”')
  const listed = text(await run('remembered'))
  expect(listed).toContain('Imported from ChatGPT')
})

test('binary_and_html_files_are_refused_not_imported_as_lines', async () => {
  // A ChatGPT zip read as text: a PK header and a NUL byte, with lines of junk after them.
  const junk = Array.from({ length: 50 }, (_, i) => `junk line number ${i} of the archive`).join('\n')
  const zip = put(chosen, 'export.txt', `PK\u0003\u0004\u0014\u0000\u0000\u0000${junk}`)
  const refusedZip = await run('import_memories', { path: zip })
  expect(refusedZip.isError).toBe(true)
  expect(text(refusedZip)).toContain('not text')
  // A Gemini Takeout page.
  const html = put(chosen, 'MyActivity.html', `<!DOCTYPE html><html><body>${junk}</body></html>`)
  expect((await run('import_memories', { path: html })).isError).toBe(true)
  // The same page under a text name: caught by what is in it, not what it is called.
  const sneaky = put(chosen, 'memories.txt', `<html lang="en"><head></head><body>${junk}</body></html>`)
  expect((await run('import_memories', { path: sneaky })).isError).toBe(true)
  // A zip's name is refused before it is read at all.
  const named = put(chosen, 'data.zip', 'one memory\nanother memory')
  expect((await run('import_memories', { path: named })).isError).toBe(true)
  expect(facts()).toHaveLength(0)
  expect(parseExport('x.txt', 'a\u0000b\nc')).toBeNull()
  expect(parseExport('x.txt', 'a plain memory\nanother one')).not.toBeNull()
})

test('huge_files_are_refused_before_they_are_read', async () => {
  // A sparse 65 MB file: over the cap, so it is refused on its size and never read into a string.
  const path = join(chosen, 'huge.json')
  writeFileSync(path, '')
  truncateSync(path, 65 * 1024 * 1024)
  const result = await run('import_memories', { path })
  expect(result.isError).toBe(true)
  expect(text(result)).toContain('too big')
  expect(facts()).toHaveLength(0)
})
