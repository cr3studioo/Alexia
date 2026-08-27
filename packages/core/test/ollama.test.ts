// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, expect, test } from 'vitest'
import { installed, pull, running, type Progress } from '../src/ollama.js'

// A stand-in for Ollama, so this runs on a machine that has never installed it — including
// every CI runner. What is being tested is the mapping and the progress, not Ollama.

const tags = {
  models: [
    { name: 'qwen3:8b', model: 'qwen3:8b', size: 5_200_000_000, details: { family: 'qwen3' } },
    { name: 'llava:7b', model: 'llava:7b', size: 4_700_000_000, details: { family: 'llama' } },
  ],
}

const shows: Record<string, unknown> = {
  'qwen3:8b': { capabilities: ['completion', 'tools'], model_info: { 'qwen3.context_length': 32_768 } },
  // No capabilities, no model_info: a model that will not describe itself.
  'llava:7b': { capabilities: ['completion', 'vision'], model_info: {} },
}

const steps = [
  { status: 'pulling manifest' },
  { status: 'downloading', digest: 'sha256:1', total: 1000, completed: 250 },
  { status: 'downloading', digest: 'sha256:1', total: 1000, completed: 1000 },
  { status: 'success' },
]

const body = async (request: IncomingMessage): Promise<Record<string, string>> => {
  let raw = ''
  for await (const chunk of request) raw += String(chunk)
  return raw ? (JSON.parse(raw) as Record<string, string>) : {}
}

const server: Server = createServer((request, response) => {
  void (async () => {
    const asked = await body(request)
    if (request.url === '/api/tags') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(tags))
      return
    }
    if (request.url === '/api/show') {
      const shown = shows[asked.model ?? '']
      response.writeHead(shown ? 200 : 404, { 'content-type': 'application/json' })
      response.end(JSON.stringify(shown ?? { error: 'no such model' }))
      return
    }
    if (request.url === '/api/pull') {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' })
      // One JSON object per line, and the line split across writes — which is what a real
      // download does, and the reason the reader cannot assume a chunk is a message.
      const wire = steps.map((s) => `${JSON.stringify(s)}\n`).join('')
      for (let at = 0; at < wire.length; at += 13) response.write(wire.slice(at, at + 13))
      response.end()
      return
    }
    response.writeHead(404)
    response.end()
  })()
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
afterAll(() => void server.close())

const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

test('what is installed, as catalog entries priced at zero', async () => {
  const models = await installed(host)

  expect(models[0]).toEqual({
    id: 'qwen3:8b',
    name: 'qwen3:8b',
    provider: 'ollama',
    tier: 'T0',
    priceIn: 0,
    priceOut: 0,
    context: 32_768,
    supportsTools: true,
    modality: ['text'],
    nsfwOk: 'unknown',
    // The one provider where this is a fact and not a reading of somebody's terms.
    trainsOnYourData: 'no',
  })

  // A vision model that named no context length: reported as it is, not guessed at.
  expect(models[1]).toMatchObject({ modality: ['text', 'image'], supportsTools: false, context: 0 })
})

test('a pull reports every step, and knows when it cannot say how far along it is', async () => {
  const seen: Progress[] = []
  await pull('qwen3:8b', (progress) => seen.push(progress), host)

  expect(seen.map((p) => p.status)).toEqual(['pulling manifest', 'downloading', 'downloading', 'success'])
  // Before the size is known there is no fraction, rather than a zero that looks like a
  // stalled download.
  expect(seen[0]?.fraction).toBeUndefined()
  expect(seen[1]?.fraction).toBeCloseTo(0.25)
  expect(seen[2]?.fraction).toBe(1)
})

test('no Ollama is an answer, not a crash', async () => {
  expect(await running(host)).toBe(true)
  expect(await running('http://127.0.0.1:1')).toBe(false)
  expect(await installed('http://127.0.0.1:1')).toEqual([])
})
