// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { noPolling } from './staged.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { serve, type Serving } from '../src/serve.js'

/**
 * `table`, the eleventh widget (D83, M6-3) — core's half of it.
 *
 * What the ten could not express is **a list of things with actions on each one**, and the
 * two claims worth a test are the ones that made granting it cheap:
 *
 * - **A row action is an `action`.** Same lookup, same permission gate, same two steps. If
 *   this file needed a second gate, the widget was a bigger idea than it was sold as.
 * - **Drawing a panel spawns nothing; opening one calls a tool.** The rows arrive from the
 *   tool the author named, through MCP's own `structuredContent`, when a person asks for
 *   them.
 *
 * The plugin here is written for this test rather than staged from `plugins/`, because what
 * is being held still is the contract's side: a well-behaved lister, a destructive row
 * action, and the three ways an author can get the answer wrong.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-table-'))
mkdirSync(join(root, 'cache'), { recursive: true })
noPolling(root)

const extensions = mkdtempSync(join(tmpdir(), 'alexia-table-ext-'))
const folder = join(extensions, 'shelf')
mkdirSync(folder)

writeFileSync(
  join(folder, 'plugin.json'),
  JSON.stringify({
    manifest_version: 1,
    id: 'shelf',
    name: 'Shelf',
    summary: 'A list of things, with actions on each one.',
    version: '0.1.0',
    license: 'AGPL-3.0-only',
    entry: { run: 'node', args: [join(folder, 'index.js')] },
    alexia_protocol: 11,
    mcp_protocol: '2025-11-25',
    panel: {
      label: 'Shelf',
      widgets: [
        {
          key: 'things',
          type: 'table',
          label: 'Things',
          rows: 'list_things',
          columns: [
            { key: 'name', label: 'Name' },
            { key: 'uses', label: 'Uses', align: 'right', hideNarrow: true },
          ],
          rowActions: [{ key: 'remove', label: 'Remove', tool: 'remove_thing', confirm: 'Remove {name}?' }],
          detail: 'explain_thing',
          filter: true,
          groupBy: 'category',
        },
        { key: 'broken', type: 'table', label: 'Broken', rows: 'bad_rows', columns: [{ key: 'name', label: 'Name' }] },
        { key: 'idless', type: 'table', label: 'No ids', rows: 'rows_without_ids', columns: [{ key: 'name', label: 'Name' }] },
        {
          key: 'shelves',
          type: 'tree',
          label: 'Shelves',
          rows: 'list_tree',
          detail: 'explain_thing',
          rowActions: [{ key: 'remove_loose', label: 'Remove', tool: 'remove_thing', when: { tag: 'loose' } }],
        },
        { key: 'misfiled', type: 'tree', label: 'Misfiled', rows: 'list_things' },
      ],
    },
  }),
)

/**
 * A plugin with no SDK, speaking the wire directly.
 *
 * Deliberately hand-written: what is being tested is what core does with an answer, and a
 * fixture that used the SDK would be testing the SDK's idea of `structuredContent` instead
 * of the protocol's.
 */
writeFileSync(
  join(folder, 'index.js'),
  `const things = [
  { id: 'a', name: 'Anvil', uses: 3, category: 'Heavy' },
  { id: 'b', name: 'Bellows', uses: 11, category: 'Heavy' },
  { id: 'c', name: 'Chisel', uses: 2, category: 'Light' },
]

const TOOLS = [
  { name: 'list_things', description: 'List the things.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: 'explain_thing', description: 'Say more about one.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: 'remove_thing', description: 'Take one off the shelf.', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
  { name: 'bad_rows', description: 'Answers with no structuredContent.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: 'list_tree', description: 'The things, on shelves.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: 'rows_without_ids', description: 'Answers with rows that have no id.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, destructiveHint: false } },
]

const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })

let rest = ''
process.stdin.on('data', (chunk) => {
  rest += chunk
  const lines = rest.split('\\n')
  rest = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    const message = JSON.parse(line)
    const { id, method, params } = message
    if (method === 'initialize') {
      reply(id, { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'shelf', version: '0.1.0' } })
    } else if (method === 'tools/list') {
      reply(id, { tools: TOOLS })
    } else if (method === 'tools/call') {
      const called = params.name
      const which = params.arguments?.id
      if (called === 'list_things') {
        reply(id, { content: [{ type: 'text', text: 'ok' }], structuredContent: { rows: things } })
      } else if (called === 'explain_thing') {
        const found = things.find((t) => t.id === which)
        reply(id, { content: [{ type: 'text', text: found ? found.name + ' has been used ' + found.uses + ' times.' : 'no such thing' }] })
      } else if (called === 'remove_thing') {
        const at = things.findIndex((t) => t.id === which)
        if (at !== -1) things.splice(at, 1)
        reply(id, { content: [{ type: 'text', text: at === -1 ? 'nothing to remove' : 'Removed.' }], isError: at === -1 })
      } else if (called === 'list_tree') {
        const nodes = [
          { id: 'b1', parent: null, kind: 'branch', label: 'Workshop' },
          { id: 'b2', parent: 'b1', kind: 'branch', label: 'Heavy', summary: 'What needs two hands.' },
          ...things.map((t) => ({ id: t.id, parent: 'b2', kind: 'note', label: t.name, tags: t.uses > 10 ? ['worn'] : ['loose'] })),
        ]
        reply(id, { content: [{ type: 'text', text: 'ok' }], structuredContent: { nodes } })
      } else if (called === 'bad_rows') {
        reply(id, { content: [{ type: 'text', text: '[]' }] })
      } else if (called === 'rows_without_ids') {
        reply(id, { content: [{ type: 'text', text: 'ok' }], structuredContent: { rows: [{ name: 'nameless' }] } })
      } else {
        reply(id, { content: [{ type: 'text', text: 'no such tool' }], isError: true })
      }
    } else if (id !== undefined) {
      reply(id, {})
    }
  }
})
console.error('shelf ready')
`,
)

const alexia: Serving = await serve({
  dataDir: root,
  uiDir: join(import.meta.dirname, '..', '..', 'ui'),
  pluginsDir: extensions,
  secrets: memorySecrets(),
})

afterAll(async () => {
  await alexia.close()
  for (const path of [extensions, root]) rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const post = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
  (await (
    await fetch(new URL(path, alexia.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alexia-token': alexia.token },
      body: JSON.stringify(body),
    })
  ).json()) as Record<string, unknown>

interface Row {
  id: string
  [field: string]: unknown
}

await post('/api/plugin', { id: 'shelf', action: 'enable' })

test('a table declares its shape in the manifest, and the panel draws without a process', async () => {
  const { panes } = (await (
    await fetch(new URL('/api/plugins', alexia.url), { headers: { 'x-alexia-token': alexia.token } })
  ).json()) as { panes: { id: string; running?: boolean; panel?: { widgets: Record<string, unknown>[] } }[] }

  const mine = panes.find((pane) => pane.id === 'shelf')
  const table = mine?.panel?.widgets.find((w) => w.key === 'things')
  expect(table?.type).toBe('table')
  // The whole shape, so the shell has everything it needs before a single row arrives.
  expect((table?.columns as { key: string }[]).map((c) => c.key)).toEqual(['name', 'uses'])
  expect((table?.rowActions as { key: string; confirm?: string }[])[0]?.confirm).toBe('Remove {name}?')
  expect(table?.filter).toBe(true)
  expect(table?.groupBy).toBe('category')

  // And drawing it started nothing. That is the reason the shape lives in the manifest.
  expect(mine?.running).toBe(false)
}, 20_000)

test('opening it calls the tool the author named, and the rows come back', async () => {
  const answer = await post('/api/rows', { plugin: 'shelf', key: 'things' })
  expect(answer.ok).toBe(true)
  expect((answer.rows as Row[]).map((row) => row.name)).toEqual(['Anvil', 'Bellows', 'Chisel'])
  // Every row carries an id, because a row action and a detail are both *this row*.
  expect((answer.rows as Row[]).every((row) => typeof row.id === 'string')).toBe(true)
}, 20_000)

test('a detail is the same call about one row', async () => {
  const answer = await post('/api/detail', { plugin: 'shelf', key: 'things', row: 'b' })
  expect(answer.ok).toBe(true)
  expect(answer.text).toBe('Bellows has been used 11 times.')
})

test('a row action is an action: same gate, same two steps, and it carries the row', async () => {
  // `remove_thing` declares `destructiveHint`, so the default mode asks — through exactly
  // the ruling a button on the settings screen goes through. No second gate (D83).
  const asked = await post('/api/action', { plugin: 'shelf', key: 'remove', row: 'c' })
  expect(asked.ok).toBe(false)
  expect(asked.ask).toContain('remove_thing')

  const done = await post('/api/action', { plugin: 'shelf', key: 'remove', row: 'c', approved: true })
  expect(done.ok).toBe(true)
  expect(done.said).toBe('Removed.')

  // And it acted on the row it was given, not on the first one it found.
  const after = await post('/api/rows', { plugin: 'shelf', key: 'things' })
  expect((after.rows as Row[]).map((row) => row.id)).toEqual(['a', 'b'])
})

test('a row action pressed with no row is refused before the plugin hears about it', async () => {
  const answer = await post('/api/action', { plugin: 'shelf', key: 'remove', approved: true })
  expect(answer.ok).toBe(false)
  expect(answer.said).toContain('acts on a row')
})

test('the three ways an author gets the answer wrong are three sentences, not a blank list', async () => {
  // No `structuredContent` at all. A tool that prints JSON into its text is a tool core
  // could have guessed at, and guessing is how a list silently shows the wrong thing.
  const noStructure = await post('/api/rows', { plugin: 'shelf', key: 'broken' })
  expect(noStructure.ok).toBe(false)
  expect(noStructure.said).toContain('structuredContent.rows')

  // Rows, but nothing to act on. Named with the row number, because a list of forty is a
  // list nobody finds the bad one in.
  const noIds = await post('/api/rows', { plugin: 'shelf', key: 'idless' })
  expect(noIds.ok).toBe(false)
  expect(noIds.said).toContain('no id (row 1)')

  // And a table nobody declared.
  const missing = await post('/api/rows', { plugin: 'shelf', key: 'imaginary' })
  expect(missing.ok).toBe(false)
  expect(missing.said).toContain('no list called')
})

test('a tree answers with nodes, and core hands them to the shell the way it hands rows', async () => {
  const answer = await post('/api/rows', { plugin: 'shelf', key: 'shelves' })
  expect(answer.ok).toBe(true)
  const nodes = answer.rows as Row[]
  expect(nodes.filter((node) => node.kind === 'branch').map((node) => node.label)).toEqual(['Workshop', 'Heavy'])
  expect(nodes.find((node) => node.id === 'b2')?.summary).toBe('What needs two hands.')

  // A note's detail and its row actions are a table row's, by the note's own id.
  const detail = await post('/api/detail', { plugin: 'shelf', key: 'shelves', row: 'b' })
  expect(detail.text).toBe('Bellows has been used 11 times.')
  const asked = await post('/api/action', { plugin: 'shelf', key: 'remove_loose', row: 'a' })
  expect(asked.ask).toContain('remove_thing')

  // A tree whose tool answers with `rows` is told which word it was supposed to use.
  const misfiled = await post('/api/rows', { plugin: 'shelf', key: 'misfiled' })
  expect(misfiled.ok).toBe(false)
  expect(misfiled.said).toContain('structuredContent.nodes')
})

test('a boundary the person spoke stops a table filling itself in, and says whose words did it', async () => {
  alexia.store.kvSet(CORE, 'boundaries', [{ said: 'don’t change anything', blocks: 'everything', at: Date.now() }])

  const answer = await post('/api/rows', { plugin: 'shelf', key: 'things' })
  expect(answer.ok).toBe(false)
  expect(answer.said).toContain('don’t change anything')
  // Blocked, so there is nothing to approve — the difference between a question and a floor.
  expect(answer.ask).toBeUndefined()

  alexia.store.kvSet(CORE, 'boundaries', [])
})
