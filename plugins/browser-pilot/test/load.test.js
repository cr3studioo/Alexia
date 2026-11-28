// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { assert, test } from './harness.js'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'))
const PROVIDES = ['browser.tabs', 'browser.read', 'browser.click', 'browser.fill', 'browser.open']
const REQUIRES = ['net.listen', 'fs.own_dir']

/**
 * The plugin's tools as the host sees them: started as its entry point and asked over stdio.
 * What the plugin asks the host in return (its token, its pinned id) is left unanswered, so it
 * never gets as far as listening.
 */
async function listTools() {
  const child = spawn(process.execPath, ['index.js'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ALEXIA_PLUGIN_DIR: dir } })
  let said = ''
  child.stderr.on('data', (chunk) => (said += String(chunk)))
  const waiting = new Map()
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
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
  assert.equal(manifest.id, 'browser-pilot')
  assert.equal(manifest.manifest_version, 1)
  assert.equal(manifest.alexia_protocol, 3)
  assert.equal(manifest.version, '0.1.0')
  // It holds a listener open, so it must not be stopped when idle.
  assert.equal(manifest.lifetime, 'resident')
})

test('provides and requires match the plan, and every requirement says why', () => {
  assert.deepEqual(manifest.provides, PROVIDES)
  assert.deepEqual(
    manifest.requires.map((r) => r.cap),
    REQUIRES,
  )
  for (const r of manifest.requires) assert.ok(r.why.length > 0 && r.why.length <= 120)
  assert.match(manifest.requires[0].why, /127\.0\.0\.1/)
})

test('settings: the token and port are status, the new code is an action on browser_new_token', () => {
  const by = Object.fromEntries(manifest.settings.map((s) => [s.key, s]))
  assert.equal(by.token.type, 'status')
  assert.equal(by.port.type, 'status')
  assert.equal(by.new_token.type, 'action')
  assert.equal(by.new_token.tool, 'browser_new_token')
})

test('index.js imports without throwing and says who it is', async () => {
  process.env.ALEXIA_PLUGIN_DIR = dir
  const { default: alexia } = await import('../index.js')
  assert.equal(alexia.manifest.id, manifest.id)
})

test('every_declared_capability_is_bound_once', { timeout: 60_000 }, async () => {
  const tools = await listTools()
  const bound = tools.flatMap((tool) => (tool._meta?.['alexia/provides'] ?? []).map((cap) => ({ cap, tool })))
  // Sorted lists rather than sets, so a capability bound twice fails too.
  assert.deepEqual(bound.map(({ cap }) => cap).sort(), [...manifest.provides].sort())
  for (const { cap, tool } of bound) {
    assert.equal(tool.name, cap.replace('.', '_'))
    assert.deepEqual(tool._meta['alexia/provides'], [cap])
  }
  assert.ok(tools.some((t) => t.name === 'browser_new_token'))
})
