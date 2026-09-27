// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { rule, type Scope } from '../src/permissions.js'
import { CORE } from '../src/secrets.js'
import { addServer, home, markReviewed, offered, startFailure, unreviewed } from '../src/servers.js'
import { Store } from '../src/store.js'

// M3-6. The payoff from choosing MCP as the wire: any MCP server is a tool source. The
// thing that must not go wrong is the trust boundary — a server nobody reviewed does not
// get to talk core out of asking, whatever its own annotations say.

const root = mkdtempSync(join(tmpdir(), 'alexia-servers-'))
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))

/** A server that has never heard of Alexia, which is the shape this mode exists for. */
const plain = join(import.meta.dirname, 'fixtures', 'plain-mcp-server.mjs')

test('adding one probes it, then writes the smallest honest manifest', async () => {
  const store = new Store(':memory:')
  const pluginsDir = mkdtempSync(join(root, 'ext-'))
  const done = await addServer(
    { id: 'outside', run: process.execPath, args: [plain] },
    { store, pluginsDir },
  )
  expect(done, JSON.stringify(done)).not.toHaveProperty('why')
  expect(done).toMatchObject({ id: 'outside', tools: 1 })

  const manifest = JSON.parse(readFileSync(join(pluginsDir, 'outside', 'plugin.json'), 'utf8')) as Record<string, unknown>
  // The sentence travels with the folder, so every screen that reads a manifest says it.
  expect(manifest.summary).toBe('MCP server. Not an Alexia plugin. Not reviewed by us.')
  // No settings, no storage, no capabilities. It is a tool source and nothing else.
  expect(manifest).not.toHaveProperty('settings')
  expect(manifest).not.toHaveProperty('storage')
  expect(manifest).not.toHaveProperty('provides')
  // And the revision it actually spoke, not one core hoped for.
  expect(manifest.mcp_protocol).toBe('2025-11-25')

  expect(unreviewed(store).has('outside')).toBe(true)
}, 40_000)

test('a command that does not start leaves no folder behind', async () => {
  const store = new Store(':memory:')
  const pluginsDir = mkdtempSync(join(root, 'ext-'))
  const done = await addServer(
    { id: 'nonsense', run: process.execPath, args: ['--eval', 'process.exit(3)'] },
    { store, pluginsDir },
  )
  expect(done).toHaveProperty('why')
  // Validated where it stands, written second — the same rule folder installs follow.
  expect(existsSync(join(pluginsDir, 'nonsense'))).toBe(false)
  expect(unreviewed(store).has('nonsense')).toBe(false)
}, 40_000)

test('an unreviewed server’s own annotations do not talk core out of asking', () => {
  const scope: Scope = { mode: 'risky', roots: [], dataDir: root }
  // The tool insists it only reads. From a reviewed plugin that is enough to run unasked.
  const readOnly = { readOnlyHint: true, destructiveHint: false }
  expect(rule({ tool: 'mine__read', annotations: readOnly, reviewed: true }, scope).verdict).toBe('run')
  // From a server nobody reviewed, the same claim buys nothing — MCP's own guidance.
  expect(rule({ tool: 'outside__read', annotations: readOnly, reviewed: false }, scope).verdict).toBe('ask')

  // Watch-and-warn runs things; it does not stop being true that this one is destructive.
  const watching: Scope = { ...scope, mode: 'watch' }
  expect(rule({ tool: 'outside__read', annotations: readOnly, reviewed: false }, watching).verdict).toBe('run')
})

test('trusting one is a decision with a name on it, and it sticks', () => {
  const store = new Store(':memory:')
  store.kvSet(CORE, 'mcp_servers', ['outside', 'another'])
  expect(unreviewed(store)).toEqual(new Set(['outside', 'another']))
  markReviewed(store, 'outside')
  expect(unreviewed(store)).toEqual(new Set(['another']))
  // Read back from the store rather than from memory: the answer outlives a restart.
  expect(unreviewed(new Store(':memory:')).size).toBe(0)
})

test('a program that is not on this Mac is said in words, not as the operating system’s code', async () => {
  const store = new Store(':memory:')
  const pluginsDir = mkdtempSync(join(root, 'ext-'))
  const done = await addServer({ id: 'missing', run: 'no-such-program-anywhere-4821' }, { store, pluginsDir })
  expect(done).toHaveProperty('why')
  const why = (done as { why: string }).why
  expect(why).toContain("isn't installed on this Mac")
  expect(why).not.toContain('ENOENT')
}, 40_000)

test('why a server did not start: missing, closed on us, or its own words', () => {
  const missing = Object.assign(new Error('spawn uvx ENOENT'), { code: 'ENOENT' })
  expect(startFailure('uvx', missing)).toContain('“uvx” isn\'t installed on this Mac')
  expect(startFailure('node', new Error('MCP error -32000: Connection closed'))).toBe(
    "It started but didn't answer like an MCP server. Check the command — it may need other arguments.",
  )
  expect(startFailure('node', new Error('something else'))).toBe('It said: something else')
})

test('a name left empty is asked for, and ~ is the home folder', async () => {
  const store = new Store(':memory:')
  const pluginsDir = mkdtempSync(join(root, 'ext-'))
  expect(await addServer({ id: ' ', run: 'x' }, { store, pluginsDir })).toEqual({
    why: 'Give it a name first — lowercase letters, digits and hyphens.',
  })
  expect(home('~/bin/server')).toBe(join(homedir(), 'bin', 'server'))
  expect(home('~')).toBe(homedir())
  expect(home('/usr/bin/env')).toBe('/usr/bin/env')
})

test('what a server offered when it was added is kept for its page', async () => {
  const store = new Store(':memory:')
  const pluginsDir = mkdtempSync(join(root, 'ext-'))
  await addServer({ id: 'kept', run: process.execPath, args: [plain] }, { store, pluginsDir })
  expect(offered(store).kept?.length).toBe(1)
  expect(offered(store).kept?.[0]?.name).toBeTruthy()
}, 40_000)
