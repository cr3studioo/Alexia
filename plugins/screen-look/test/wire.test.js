// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { assert, test } from './harness.js'
import { picture, wordsIn } from './world.js'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORDS = [{ text: 'Secretword', x: 200, y: 100, w: 90, h: 20 }]
const nothing = (cap) => ({ error: { code: -32050, message: `nothing provides ${cap}` } })

/**
 * The plugin as the host runs it: started as its entry point and spoken to over stdio, with this
 * test answering what it asks of the host: capabilities, `alexia/answers` and sampling.
 */
async function host(capability) {
  const child = spawn(process.execPath, ['index.js'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ALEXIA_PLUGIN_DIR: dir } })
  let log = ''
  child.stderr.on('data', (chunk) => (log += String(chunk)))
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  const waiting = new Map()
  const asked = []

  const answer = async ({ method, params }) => {
    asked.push({ method, params })
    if (method === 'ping') return { result: {} }
    if (method === 'alexia/answers') return { result: { answers: true, here: true } }
    if (method === 'alexia/capability/call') return capability(params)
    if (method === 'sampling/createMessage') {
      const text = '{"answer":"Press it.","steps":["Press it."],"control":"Secretword"}'
      return { result: { role: 'assistant', model: 'fake', content: { type: 'text', text } } }
    }
    return { error: { code: -32601, message: `the test host has no ${method}` } }
  }

  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    // A request from the plugin has its own ids, so only answers are matched to ours.
    if (message.method === undefined) return waiting.get(message.id)?.resolve(message)
    if (message.id === undefined) return
    answer(message).then(
      (reply) => send({ id: message.id, ...reply }),
      (error) => send({ id: message.id, error: { code: -32603, message: error.message } }),
    )
  })
  child.on('exit', () => {
    for (const { reject } of waiting.values()) reject(new Error(`the plugin stopped: ${log}`))
  })
  let id = 0
  const ask = (method, params) =>
    new Promise((resolve, reject) => {
      id += 1
      waiting.set(id, { resolve, reject })
      send({ id, method, params })
    })
  await ask('initialize', { protocolVersion: '2025-11-25', capabilities: { sampling: {} }, clientInfo: { name: 'test', version: '1' } })
  send({ method: 'notifications/initialized' })
  return {
    asked,
    log: () => log,
    call: async (name, args) => (await ask('tools/call', { name, arguments: args })).result,
    stop: () => child.kill(),
  }
}

test('over stdio the tools help, point and read, and log nothing they saw', { timeout: 120_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'screen-look-wire-'))
  const path = join(folder, 'screen-wire.png')
  const shot = picture(640, 360)
  const plugin = await host(async ({ cap, arguments: args }) => {
    if (cap === 'computer.screenshot') {
      await writeFile(path, shot)
      const front = { app: 'notepad', title: 'Diary entry', fullscreen: false, titleBar: true }
      return { result: { content: [], structuredContent: { path, width: 640, height: 360, locked: false, front } } }
    }
    if (cap === 'image.ocr') {
      const text = wordsIn(Buffer.from(args.bytes, 'base64'), WORDS)
      return { result: { content: [{ type: 'text', text: text || 'no text' }], isError: text === '' } }
    }
    if (cap === 'screen.draw') return { result: { content: [], structuredContent: { drawn: 1 } } }
    // Nothing provides eyes: the host's own answer for that.
    return nothing(cap)
  })
  try {
    const helped = await plugin.call('help', { question: 'what do I press', draw: true })
    assert.notEqual(helped.isError, true, helped.content[0].text)
    assert.deepEqual(helped.structuredContent.steps, ['Press it.'])
    assert.match(helped.content[0].text, /only the text read from it/)
    assert.match(helped.content[0].text, /drew a box/)
    assert.equal(plugin.asked.filter((one) => one.method === 'sampling/createMessage').length, 1)
    assert.ok(plugin.asked.some((one) => one.params?.cap === 'screen.draw'))
    assert.ok(!existsSync(path))

    const read = await plugin.call('text', { region: { x: 150, y: 80, w: 200, h: 80 } })
    assert.deepEqual(read.structuredContent, { text: 'Secretword' })
    assert.ok(!existsSync(path))
    assert.doesNotMatch(plugin.log(), /Secretword|Diary/)
  } finally {
    plugin.stop()
    await rm(folder, { recursive: true, force: true })
  }
})

test('over stdio a missing capability is the contract’s sentence', { timeout: 60_000 }, async () => {
  const plugin = await host(async ({ cap }) => nothing(cap))
  try {
    const look = await plugin.call('look', {})
    assert.equal(look.isError, true)
    assert.equal(look.content[0].text, "I can't look at that screen.")
    const text = await plugin.call('text', {})
    assert.equal(text.content[0].text, "I can't read text off that screen.")
  } finally {
    plugin.stop()
  }
})
