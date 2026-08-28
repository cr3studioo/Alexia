// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { rule, type Scope } from '../src/permissions.js'
import { CORE } from '../src/secrets.js'
import { addServer, markReviewed, unreviewed } from '../src/servers.js'
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
