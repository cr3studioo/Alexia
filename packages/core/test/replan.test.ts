// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { run } from '../src/agent.js'
import type { Model } from '../src/catalog.js'
import { Plugins } from '../src/plugins.js'
import { keyOf, type Provider } from '../src/provider.js'
import { MODES } from '../src/router.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { Store } from '../src/store.js'
import { PluginTooling } from '../src/tooling.js'
import { stage } from './staged.js'

// M15-8. Invariant 4 said core *notices* a folder deleted mid-call; at M0 there was no loop
// to do anything about it. This is the other half: a real loop, real plugins, a folder
// deleted while a call against it is in flight, and a task that finishes anyway.
//
// Nothing here is mocked except the model, and the model is scripted rather than mocked —
// what it asks for is fixed, what happens to those asks is entirely real.

const dir = stage('vanisher', 'hello')
const store = new Store(':memory:')
const dataDir = mkdtempSync(join(tmpdir(), 'alexia-replan-'))

const plugins = new Plugins({
  dir,
  store,
  dataDir,
  secrets: memorySecrets(),
  onToolsChanged: () => tooling.invalidate(),
})
const tooling = new PluginTooling(plugins)
plugins.load()
// Installed is files on disk; enabled is a person having said yes (M2-5). These tests are
// about plugins that run, so they say yes — the same one line the settings screen sends.
for (const id of plugins.ids) plugins.enable(id)
plugins.watch()

// Step one reaches for the plugin that is about to disappear. Step two is the re-plan.
const script = [
  { call: 'vanisher__slow', args: '{"ms":10000}' },
  { call: 'hello__greet', args: '{"who":"Vaclav"}' },
  { say: 'The slow one went away, so I greeted you instead.' },
] as ({ call: string; args: string } | { say: string })[]

let turn = 0
const offered: string[][] = []
const server: Server = createServer((request, response) => {
  let raw = ''
  request.on('data', (chunk: Buffer) => (raw += chunk.toString()))
  request.on('end', () => {
    // What the model was offered on each turn. The re-plan must not be handed a tool that
    // no longer exists, or it will keep choosing it.
    const body = JSON.parse(raw) as { tools?: { function: { name: string } }[] }
    offered.push((body.tools ?? []).map((t) => t.function.name))

    const step = script[turn++] ?? { say: 'done' }
    const delta =
      'call' in step ?
        { tool_calls: [{ index: 0, id: `c${String(turn)}`, function: { name: step.call, arguments: step.args } }] }
      : { content: step.say }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n` +
        `data: ${JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`,
    )
  })
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
const alpha: Provider = { id: 'alpha', name: 'Alpha', baseUrl: at, rpm: 100, rpd: 100 }
const secrets = memorySecrets()
await secrets.set(CORE, keyOf(alpha), 'sk-a')

const model: Model = {
  id: 'm',
  name: 'Scripted',
  provider: 'alpha',
  tier: 'T1',
  priceIn: 0,
  priceOut: 0,
  context: 32_768,
  supportsTools: true,
  modality: ['text'],
  nsfwOk: 'unknown',
  trainsOnYourData: 'unknown',
}

afterAll(async () => {
  server.close()
  await plugins.stop()
  store.close()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
})

test('a plugin deleted mid-task makes the loop re-plan, and the task still finishes', async () => {
  expect((await tooling.list()).map((t) => t.name)).toContain('vanisher__slow')

  const session = store.createSession()
  // Deleted while the first call is in flight — not between steps, not while idle. The
  // call asks for ten seconds; this lands about a fifth of a second into it.
  const deleted = setTimeout(() => rmSync(join(dir, 'vanisher'), { recursive: true, force: true }), 200)

  const result = await run({
    messages: [{ role: 'user', content: 'take your time, then say hello' }],
    tools: tooling,
    pins: { placement: MODES.combined },
    world: () => Promise.resolve({ models: [model], local: [], rungs: [{ provider: alpha, minute: 0, day: 0 }] }),
    store,
    secrets,
    session,
  })
  clearTimeout(deleted)

  // The whole point: it finished. Not crashed, not stopped, not hung until a timeout.
  expect(result.ended).toBe('answered')
  expect(result.messages.at(-1)?.content).toContain('greeted you instead')

  // Two steps: the one that vanished under it, and the one it re-planned to.
  expect(result.steps.map((s) => [s.name, s.outcome?.ok])).toEqual([
    ['vanisher__slow', false],
    ['hello__greet', true],
  ])

  // The failure reached the model as an observation, in words it could act on — that is
  // what makes the next step a re-plan rather than a repeat.
  const failure = store.history(session).find((m) => m.role === 'tool')
  expect(failure?.content.length).toBeGreaterThan(0)

  // And the re-plan was not offered the tool that no longer exists. Being handed a dead
  // tool is how a model ends up choosing it again, forever.
  expect(offered[0]).toContain('vanisher__slow')
  expect(offered[1]).not.toContain('vanisher__slow')
  expect(offered[1]).toContain('hello__greet')

  // Core dropped it by itself. Nothing in this test told it to look.
  expect(plugins.ids).toEqual(['hello'])
}, 60_000)
