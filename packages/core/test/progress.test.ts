// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { run, type Step } from '../src/agent.js'
import type { Model } from '../src/catalog.js'
import { Plugins } from '../src/plugins.js'
import { keyOf, type Provider } from '../src/provider.js'
import { MODES } from '../src/router.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import type { Progress } from '../src/settings.js'
import { Store } from '../src/store.js'
import { PluginTooling } from '../src/tooling.js'
import { stage } from './staged.js'

/**
 * `notifications/progress`, from a plugin to the screen (M2-6).
 *
 * **Silence is what kills a first run, not time.** A tool that will take four minutes and
 * says nothing is indistinguishable from one that has hung, and the person watching has no
 * way to tell them apart except by waiting or by giving up. M2-1 carried progress to the
 * settings screen; this is the other route — through the agent loop, where the work a person
 * actually waits on happens.
 *
 * Nothing is mocked but the model, and the model is scripted rather than mocked: what it
 * asks for is fixed, and everything that happens to those asks is real.
 */

const dir = stage('hello')
const store = new Store(':memory:')
const dataDir = mkdtempSync(join(tmpdir(), 'alexia-progress-'))

const plugins = new Plugins({
  dir,
  store,
  dataDir,
  secrets: memorySecrets(),
  onToolsChanged: () => tooling.invalidate(),
})
const tooling = new PluginTooling(plugins)
plugins.load()
// Installed is files on disk; enabled is a person having said yes (M2-5).
for (const id of plugins.ids) plugins.enable(id)

const script = [{ call: 'hello__warm_up', args: '{}' }, { say: 'Warm.' }] as (
  | { call: string; args: string }
  | { say: string }
)[]

let turn = 0
const server: Server = createServer((request, response) => {
  request.on('data', () => {})
  request.on('end', () => {
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
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

test('a plugin reporting progress reaches whoever called the tool', async () => {
  const seen: Progress[] = []
  const outcome = await tooling.call('hello__warm_up', {}, undefined, (update) => seen.push(update))

  expect(outcome.ok).toBe(true)
  // Real frames from a real plugin over a real pipe. The count is the plugin's business —
  // what matters is that there were several and that they moved.
  expect(seen.length).toBeGreaterThan(1)
  expect(seen.at(0)!.progress).toBeLessThan(seen.at(-1)!.progress)
  expect(seen.at(-1)).toMatchObject({ total: expect.any(Number), message: expect.any(String) })
}, 30_000)

test('a tool that says nothing about progress simply never reports any', async () => {
  const seen: Progress[] = []
  // The optional half of the contract, and the ordinary case: most tools finish before there
  // is anything to say. A caller must not have to distinguish *no progress* from *no tool*.
  const outcome = await tooling.call('hello__greeted', {}, undefined, (update) => seen.push(update))
  expect(outcome.ok).toBe(true)
  expect(seen).toEqual([])
}, 30_000)

test('the loop turns it into events on the step, while the step is still running', async () => {
  const moved: { n: number; progress: Progress }[] = []
  const order: string[] = []
  const session = store.createSession()

  const result = await run({
    messages: [{ role: 'user', content: 'warm up' }],
    tools: tooling,
    pins: { placement: MODES.combined },
    world: () => Promise.resolve({ models: [model], local: [], rungs: [{ provider: alpha, minute: 0, day: 0, month: 0 }] }),
    store,
    secrets,
    session,
    on: {
      step: (step: Step) => order.push(`step ${String(step.n)}`),
      progress: (step: Step) => {
        order.push(`progress ${String(step.n)}`)
        if (step.progress) moved.push({ n: step.n, progress: { ...step.progress } })
      },
      done: (step: Step) => order.push(`done ${String(step.n)}`),
    },
  })

  expect(result.ended).toBe('answered')
  expect(moved.length).toBeGreaterThan(1)
  expect(moved.every((m) => m.n === 1)).toBe(true)

  // The whole of M2-6 in one assertion: every report arrives **between** the step starting
  // and the step finishing. A bar that only ever appears at rest is a spinner with extra
  // steps, and this is what makes the difference a fact rather than an intention.
  expect(order.at(0)).toBe('step 1')
  expect(order.at(-1)).toBe('done 1')
  expect(order.slice(1, -1).every((line) => line === 'progress 1')).toBe(true)

  // And the step carries the last thing it said, so anything drawing the trace from the
  // step rather than from the event sees the same number.
  expect(result.steps[0]?.progress?.progress).toBe(moved.at(-1)?.progress.progress)
}, 30_000)
