// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, expect, test, vi } from 'vitest'
import { chat, ProviderError, type Provider } from '../src/provider.js'
import { MODES, route } from '../src/router.js'
import type { Model } from '../src/catalog.js'

let authorization: string | undefined
const http = createServer((request, response) => {
  authorization = request.headers.authorization
  request.resume()
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end('data: {"choices":[{"delta":{"content":"ready"}}]}\n\ndata: [DONE]\n\n')
})
await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
afterAll(() => http.close())
const baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1`
const local: Provider = { id: 'llama', name: 'llama.cpp', baseUrl: '', auth: 'none' }
const model: Model = { id: 'llama/test:q4_k_m', name: 'Test', provider: 'llama', tier: 'T0', priceIn: 0, priceOut: 0, context: 8192, params: 8, supportsTools: true, modality: ['text'], nsfwOk: 'unknown', trainsOnYourData: 'no' }

test('an on-demand runner authenticates with its launch key and releases the inference lease', async () => {
  const release = vi.fn()
  const prepare = vi.fn(async () => ({ baseUrl, key: 'per-launch-test-key', release }))
  const answer = await chat({ ...local, prepare }, { model: model.id, messages: [{ role: 'user', content: 'Ready?' }] })
  expect(answer.message.content).toBe('ready')
  expect(authorization).toBe('Bearer per-launch-test-key')
  expect(prepare).toHaveBeenCalledWith(model.id, undefined)
  expect(release).toHaveBeenCalledOnce()
})

test('a failed runtime preparation reaches the router as an unreachable provider', async () => {
  await expect(chat({ ...local, prepare: async () => { throw new Error('model load failed') } }, { model: model.id, messages: [] })).rejects.toMatchObject({ trouble: 'unreachable' } satisfies Partial<ProviderError>)
})

test('routing selects the installed model’s runner and never sends an unknown runner to Ollama', () => {
  const result = route({ messages: [{ role: 'user', content: 'hello' }] }, { placement: MODES.local, model: model.id }, { models: [], local: [model], runners: [local], rungs: [] })
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.choices[0]?.provider.id).toBe('llama')
  const missing = route({ messages: [] }, { placement: MODES.local }, { models: [], local: [model], rungs: [] })
  expect(missing.ok).toBe(false)
})
