// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { assert, test } from './harness.js'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'))
const PROVIDES = ['clipboard.get', 'clipboard.set', 'clipboard.history']
const REQUIRES = ['proc.spawn', 'fs.own_dir']

/**
 * The tools of the plugin as the host sees them: started as its entry point and asked over stdio.
 * What the plugin asks the host in return is left unanswered, so it never gets as far as
 * reading its settings and watching this computer’s clipboard.
 */
async function listTools() {
  const child = spawn(process.execPath, ['index.js'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ALEXIA_PLUGIN_DIR: dir } })
  let said = ''
  child.stderr.on('data', (chunk) => (said += String(chunk)))
  const waiting = new Map()
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    // A request from the plugin has its own ids, so only answers are matched to ours.
    if (message.method === undefined) waiting.get(message.id)?.resolve(message)
  })
  child.on('exit', () => {
    for (const { reject } of waiting.values()) reject(new Error(`the plugin stopped: ${said}`))
  })
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  const ask = (id, method, params) =>
    new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject })
      send({ id, method, params })
    })
  try {
    await ask(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    send({ method: 'notifications/initialized' })
    return (await ask(2, 'tools/list', {})).result.tools
  } finally {
    child.kill()
  }
}

test('the manifest parses, and its id is the folder name', () => {
  assert.equal(manifest.id, basename(dir))
  assert.equal(manifest.id, 'device-clipboard')
  assert.equal(manifest.manifest_version, 1)
  assert.equal(manifest.alexia_protocol, 7)
  assert.equal(manifest.version, '0.1.0')
})

test('provides and requires match the plan, and every requirement says why', () => {
  assert.deepEqual(manifest.provides, PROVIDES)
  assert.deepEqual(
    manifest.requires.map((r) => r.cap),
    REQUIRES,
  )
  for (const r of manifest.requires) assert.ok(r.why.length > 0)
  assert.ok(manifest.requires.every((r) => r.why.length <= 120))
})

test('settings and storage are what the spec says', () => {
  const history = manifest.settings.find((s) => s.key === 'history')
  assert.equal(history.type, 'toggle')
  assert.equal(history.default, true)
  const days = manifest.settings.find((s) => s.key === 'keep_days')
  assert.equal(days.default, '7')
  assert.deepEqual(
    days.options.map((o) => o.value),
    ['1', '7', '30'],
  )
  assert.deepEqual(manifest.storage, { namespace: 'device-clipboard', tables: ['clips'] })
})

test('index.js imports without throwing and says who it is', async () => {
  process.env.ALEXIA_PLUGIN_DIR = dir
  const { default: alexia } = await import('../index.js')
  assert.equal(alexia.manifest.id, manifest.id)
})

test('every_declared_capability_is_bound_once', { timeout: 60_000 }, async () => {
  const tools = await listTools()
  const bound = tools.flatMap((tool) => (tool._meta?.['alexia/provides'] ?? []).map((cap) => ({ cap, tool })))
  for (const { cap } of bound) assert.ok(manifest.provides.includes(cap), `${cap} is bound but not declared`)
  // Without a clipboard there is nothing to bind, so only the check above applies there.
  if (process.platform !== 'win32' && process.platform !== 'darwin') return
  // Sorted lists rather than sets, so a capability bound twice fails too.
  assert.deepEqual(bound.map(({ cap }) => cap).sort(), [...manifest.provides].sort())
  for (const { cap, tool } of bound) {
    assert.equal(tool.name, cap.replace('.', '_'))
    assert.deepEqual(tool._meta['alexia/provides'], [cap])
  }
})
