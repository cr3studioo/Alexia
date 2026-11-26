// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assert, memoryStorage, test } from './harness.js'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'))
const searches = process.platform === 'win32' || process.platform === 'darwin'

/**
 * The plugin as the host runs it: started as its entry point and spoken to over stdio, with this
 * test answering the two things it asks of the host, its roots and its storage.
 */
async function host(roots = []) {
  const storage = memoryStorage()
  const child = spawn(process.execPath, ['index.js'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ALEXIA_PLUGIN_DIR: dir } })
  let said = ''
  child.stderr.on('data', (chunk) => (said += String(chunk)))
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  const waiting = new Map()

  const answer = async ({ method, params }) => {
    if (method === 'ping') return {}
    if (method === 'roots/list') return { roots: roots.map((one) => ({ uri: pathToFileURL(one).href })) }
    if (method === 'alexia/storage/insert') return { rowid: await storage.insert(params.table, params.row) }
    if (method === 'alexia/storage/select') return { rows: await storage.select(params.table, params) }
    if (method === 'alexia/storage/update') return { changed: await storage.update(params.table, params.set, params.where) }
    if (method === 'alexia/storage/delete') return { deleted: await storage.delete(params.table, params.where) }
    throw new Error(`the test host has no ${method}`)
  }

  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    // A request from the plugin has its own ids, so only answers are matched to ours.
    if (message.method === undefined) return waiting.get(message.id)?.resolve(message)
    if (message.id === undefined) return
    answer(message).then(
      (result) => send({ id: message.id, result }),
      (error) => send({ id: message.id, error: { code: -32603, message: error.message } }),
    )
  })
  child.on('exit', () => {
    for (const { reject } of waiting.values()) reject(new Error(`the plugin stopped: ${said}`))
  })
  let id = 0
  const ask = (method, params) =>
    new Promise((resolve, reject) => {
      id += 1
      waiting.set(id, { resolve, reject })
      send({ id, method, params })
    })
  await ask('initialize', { protocolVersion: '2025-11-25', capabilities: { roots: {} }, clientInfo: { name: 'test', version: '1' } })
  send({ method: 'notifications/initialized' })
  return {
    storage,
    log: () => said,
    tools: async () => (await ask('tools/list', {})).result.tools,
    call: async (name, args) => (await ask('tools/call', { name, arguments: args })).result,
    stop: () => child.kill(),
  }
}

/** Make a file two days old. Windows keeps a creation time that only it can move back. */
async function backdate(file) {
  const before = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
  await utimes(file, before, before)
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Item -LiteralPath $env:FINDER_FILE).CreationTimeUtc = [DateTime]::UtcNow.AddDays(-2)'], {
      env: { ...process.env, FINDER_FILE: file },
    })
  }
}

test('every_declared_capability_is_bound_once', { timeout: 60_000 }, async () => {
  const plugin = await host()
  try {
    const tools = await plugin.tools()
    const bound = tools.flatMap((tool) => (tool._meta?.['alexia/provides'] ?? []).map((cap) => ({ cap, tool })))
    // Search is bound only where there is an index to ask.
    const expected = manifest.provides.filter((cap) => searches || cap !== 'file.search')
    // Sorted lists rather than sets, so a capability bound twice fails too.
    assert.deepEqual(bound.map(({ cap }) => cap).sort(), expected.sort())
    for (const { cap, tool } of bound) {
      assert.equal(tool.name, cap)
      assert.deepEqual(tool._meta['alexia/provides'], [cap])
    }
    const annotations = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]))
    assert.deepEqual(annotations['file.search'], { readOnlyHint: true, openWorldHint: false })
    for (const name of ['folder.tidy', 'folder.tidy_undo']) {
      assert.deepEqual(annotations[name], { readOnlyHint: false, destructiveHint: true, openWorldHint: false })
    }
  } finally {
    plugin.stop()
  }
})

// Windows and macOS let a test move a file's creation time back; elsewhere every new file is young.
test('the tools propose, apply and undo a plan over the wire', { timeout: 120_000, skip: !searches }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'finder-wire-')))
  const folder = join(root, 'Downloads')
  await mkdir(folder)
  const file = join(folder, 'lease.pdf')
  await writeFile(file, 'the lease')
  await backdate(file)
  const plugin = await host([root])
  try {
    const proposed = await plugin.call('folder.tidy', { folder })
    assert.notEqual(proposed.isError, true, proposed.content[0].text)
    const { plan_id: planId, moves } = proposed.structuredContent
    assert.deepEqual(moves, [{ from: file, to: join(folder, 'Documents', 'lease.pdf'), why: 'A document' }])
    assert.ok(existsSync(file), 'proposing moves nothing')
    assert.equal(plugin.storage.tables.plans.length, 1)

    const applied = await plugin.call('folder.tidy', { folder, apply: planId })
    assert.deepEqual(applied.structuredContent, { moved: 1, skipped: 0 })
    assert.ok(!existsSync(file) && existsSync(moves[0].to))

    const again = await plugin.call('folder.tidy', { folder, apply: planId })
    assert.equal(again.isError, true)
    assert.match(again.content[0].text, /already carried out/)

    const unknown = await plugin.call('folder.tidy', { folder, apply: 'not-a-plan' })
    assert.equal(unknown.isError, true)
    assert.match(unknown.content[0].text, /no such plan/)

    const undone = await plugin.call('folder.tidy_undo', { plan_id: planId })
    assert.deepEqual(undone.structuredContent, { moved: 1, skipped: 0 })
    assert.equal(readFileSync(file, 'utf8'), 'the lease')
    assert.ok(!existsSync(moves[0].to))

    const outside = await plugin.call('folder.tidy', { folder: dirname(root) })
    assert.equal(outside.isError, true)
    assert.match(outside.content[0].text, /outside the folders opened/)
    // Neither a file name nor a folder is ever logged.
    assert.doesNotMatch(plugin.log(), /lease|finder-wire/)
  } finally {
    plugin.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('a search without an opened folder is refused in a sentence', { timeout: 60_000, skip: !searches }, async () => {
  const plugin = await host([])
  try {
    const out = await plugin.call('file.search', { query: 'lease' })
    assert.equal(out.isError, true)
    assert.match(out.content[0].text, /No folder has been opened/)
  } finally {
    plugin.stop()
  }
})
