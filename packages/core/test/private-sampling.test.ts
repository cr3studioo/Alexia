// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, describe, expect, test } from 'vitest'
import type { ModelResponse } from 'ollama'
import type { Model } from '../src/catalog.js'
import { relayed } from '../src/ollama.js'
import { remaining } from '../src/pool.js'
import { keyOf, type Provider } from '../src/provider.js'
import { run, type Tooling } from '../src/agent.js'
import { MODES, onDevice, route, send, type Pins, type World } from '../src/router.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { Store } from '../src/store.js'

/**
 * Private sampling (A03): a request marked `alexia/local` is answered on this computer or not at
 * all. The proof that matters is captured traffic — two real HTTP servers, one standing in for a
 * hosted provider and one for a runner on this machine — and the hosted one must see **zero**
 * requests whatever happens to the local one.
 */

function recorder(answer: () => { status: number; body: string }): { server: Server; hits: Record<string, unknown>[]; url: () => string } {
  const hits: Record<string, unknown>[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (c: Buffer) => (body += c.toString()))
    request.on('end', () => {
      hits.push(JSON.parse(body || '{}') as Record<string, unknown>)
      const { status, body: out } = answer()
      response.writeHead(status, { 'content-type': status === 200 ? 'text/event-stream' : 'text/plain' })
      response.end(out)
    })
  })
  return { server, hits, url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` }
}

let localStatus = 200
const job = '{"ok":true}'
const local = recorder(() => (localStatus === 200 ? {
  status: 200,
  body: [JSON.stringify({ choices: [{ delta: { content: job } }] }), JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }), '[DONE]'].map((f) => `data: ${f}\n\n`).join(''),
} : { status: 500, body: 'model crashed' }))
const hosted = recorder(() => ({ status: 200, body: `data: ${JSON.stringify({ choices: [{ delta: { content: 'from the cloud' } }] })}\n\ndata: [DONE]\n\n` }))
await Promise.all([local, hosted].map((r) => new Promise<void>((resolve) => r.server.listen(0, '127.0.0.1', resolve))))
afterAll(() => {
  local.server.close()
  hosted.server.close()
})

const model = (over: Partial<Model> & Pick<Model, 'id' | 'provider'>): Model => ({
  name: over.id, tier: 'T0', priceIn: 0, priceOut: 0, context: 32_768, supportsTools: false,
  modality: ['text'], nsfwOk: 'unknown', trainsOnYourData: 'no', ...over,
})

const runner: Provider = { id: 'llama', name: 'llama.cpp', baseUrl: local.url(), auth: 'none' }
const cloud: Provider = { id: 'cloudy', name: 'Cloudy', baseUrl: hosted.url(), rpm: 100, rpd: 100 }
const store = new Store(':memory:')
const secrets = memorySecrets()
await secrets.set(CORE, keyOf(cloud), 'sk-test')

const seeingHere = model({ id: 'qwen2.5vl:7b', provider: 'llama', modality: ['text', 'image'] })
const blindHere = model({ id: 'qwen3:8b', provider: 'llama' })
const seeingMlx = model({ id: 'mlx-vl', provider: 'mlx', modality: ['text', 'image'] })
const relayedCloud = model({ id: 'gpt-oss:120b-cloud', provider: 'ollama', modality: ['text', 'image'], remote: true })
const paired = model({ id: 'llava:34b', provider: 'llama', modality: ['text', 'image'], host: 'studio-pc' })
const hostedVision = model({ id: 'cloud/vision', provider: 'cloudy', tier: 'T1', modality: ['text', 'image'] })

const world = (over: Partial<World> = {}): World => ({
  models: [hostedVision],
  local: [seeingHere, blindHere, seeingMlx, relayedCloud, paired],
  runners: [runner],
  rungs: [remaining(store, cloud)],
  today: { spent: 0, allowance: 100 },
  cross: true,
  ...over,
})
const pins = (over: Partial<Pins> = {}): Pins => ({ placement: MODES.cloud, ...over })
const picture = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'plan this edit' }, { type: 'image' as const, url: 'data:image/png;base64,AAAA' }] }]
const ask = { messages: picture, placement: 'interaction' as const, structured: true, modality: ['image'] }
const ids = (v: ReturnType<typeof route>): string[] => (v.ok ? v.choices.map((c) => c.model.id) : [v.why])

describe('routing', () => {
  test('only a model executing on this computer, that can see, behind a schema-enforcing runner', () => {
    expect(ids(route(ask, pins(), world()))).toEqual(['qwen2.5vl:7b'])
  })

  test('placement settings and the cloud cascade cannot widen it', () => {
    for (const placement of [MODES.cloud, MODES.combined, MODES.local]) {
      expect(ids(route(ask, pins({ placement }), world()))).toEqual(['qwen2.5vl:7b'])
    }
  })

  test('a pin elsewhere is refused by name, never overridden', () => {
    const v = route(ask, pins({ model: 'cloud/vision' }), world())
    expect(v.ok).toBe(false)
    expect(ids(v)[0]).toMatch(/cloud\/vision.*answered only by a model running on this computer/)
    expect(ids(route(ask, pins({ model: 'gpt-oss:120b-cloud' }), world()))[0]).toMatch(/does not run on this computer/)
    expect(ids(route(ask, pins({ model: 'qwen3:8b' }), world()))[0]).toMatch(/cannot be given a picture/)
    expect(ids(route(ask, pins({ model: 'qwen2.5vl:7b' }), world()))).toEqual(['qwen2.5vl:7b'])
  })

  test('with nothing eligible it stops with setup guidance, and suggests no hosted model', () => {
    const v = route(ask, pins(), world({ local: [blindHere, relayedCloud, paired] }))
    expect(v.ok).toBe(false)
    expect(ids(v)[0]).toMatch(/needs a model on this computer that can see pictures/)
  })

  test('on-device means where it executes, not how it is reached', () => {
    expect(onDevice(seeingHere)).toBe(true)
    expect(onDevice(relayedCloud)).toBe(false)
    expect(onDevice(paired)).toBe(false)
    expect(onDevice(hostedVision)).toBe(false)
    const tag = (over: object): ModelResponse => ({ name: 'x', model: 'x', ...over }) as unknown as ModelResponse
    expect(relayed(tag({ model: 'gpt-oss:20b-cloud' }))).toBe(true)
    expect(relayed(tag({ remote_host: 'https://ollama.com:443' }))).toBe(true)
    expect(relayed(tag({ model: 'qwen2.5vl:7b' }))).toBe(false)
  })
})

describe('captured traffic', () => {
  const format = { name: 'AlexiaImageJob', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, strict: true as const }

  test('the schema goes out as response_format, and the answer comes from here', async () => {
    local.hits.length = 0
    hosted.hits.length = 0
    const v = route(ask, pins(), world())
    if (!v.ok) throw new Error(v.why)
    const answer = await send(v.choices, { messages: picture, format, maxTokens: 256 }, store, secrets, { plugin: 'media', paidAllowed: false })
    expect(answer.model.id).toBe('qwen2.5vl:7b')
    expect(local.hits[0]).toMatchObject({ response_format: { type: 'json_schema', json_schema: { name: 'AlexiaImageJob', strict: true, schema: format.schema } } })
    expect(local.hits[0]).not.toHaveProperty('format')
    expect(local.hits[0]).not.toHaveProperty('tools')
    expect(hosted.hits).toHaveLength(0)
  })

  test('when the local model fails, nothing falls back to a hosted one', async () => {
    local.hits.length = 0
    hosted.hits.length = 0
    localStatus = 500
    try {
      const v = route(ask, pins(), world())
      if (!v.ok) throw new Error(v.why)
      await expect(send(v.choices, { messages: picture, format }, store, secrets, { plugin: 'media', paidAllowed: true })).rejects.toBeDefined()
      expect(local.hits.length).toBeGreaterThan(0)
      expect(hosted.hits).toHaveLength(0)
    } finally {
      localStatus = 200
    }
  })

  test('an ordinary request without a schema is unchanged', async () => {
    hosted.hits.length = 0
    const v = route({ messages: [{ role: 'user', content: 'hello' }] }, pins({ placement: MODES.cloud }), world({ local: [] }))
    if (!v.ok) throw new Error(v.why)
    await send(v.choices, { messages: [{ role: 'user', content: 'hello' }] }, store, secrets, { paidAllowed: true })
    expect(hosted.hits[0]).not.toHaveProperty('response_format')
  })
})

describe('the outer chat', () => {
  const tools: Tooling = { list: async () => [], call: async () => ({ ok: true, text: '' }) }

  test('a conversation held to this computer is answered here, every step', async () => {
    local.hits.length = 0
    hosted.hits.length = 0
    const db = new Store(':memory:')
    const session = db.createSession()
    const result = await run({ messages: picture, tools, pins: pins(), world: async () => world(), store: db, secrets, session, placement: 'interaction' })
    expect(result.ended).toBe('answered')
    expect(local.hits.length).toBeGreaterThan(0)
    expect(hosted.hits).toHaveLength(0)
  })

  test('with nothing here able to see, it stops — it never asks a hosted model instead', async () => {
    hosted.hits.length = 0
    const db = new Store(':memory:')
    const session = db.createSession()
    const result = await run({ messages: picture, tools, pins: pins(), world: async () => world({ local: [blindHere, relayedCloud, paired] }), store: db, secrets, session, placement: 'interaction' })
    expect(result.ended).not.toBe('answered')
    expect(hosted.hits).toHaveLength(0)
  })
})
