// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, expect, test } from 'vitest'
import { installed, local, pull, running, type Progress } from '../src/ollama.js'

// A stand-in for Ollama, so this runs on a machine that has never installed it — including
// every CI runner. What is being tested is the mapping and the progress, not Ollama.

const tags = {
  models: [
    { name: 'qwen3:8b', model: 'qwen3:8b', size: 5_200_000_000, details: { family: 'qwen3' } },
    { name: 'llava:7b', model: 'llava:7b', size: 4_700_000_000, details: { family: 'llama' } },
    { name: 'bge-m3:latest', model: 'bge-m3:latest', size: 1_200_000_000, details: { family: 'bert' } },
  ],
}

const shows: Record<string, unknown> = {
  'qwen3:8b': { capabilities: ['completion', 'tools'], model_info: { 'qwen3.context_length': 32_768 } },
  // No capabilities, no model_info: a model that will not describe itself.
  'llava:7b': { capabilities: ['completion', 'vision'], model_info: {} },
  'bge-m3:latest': { capabilities: ['embedding'], model_info: { 'bert.context_length': 8192 } },
}

const ps = {
  models: [
    {
      name: 'qwen3:8b',
      model: 'qwen3:8b',
      size: 6_100_000_000,
      size_vram: 4_000_000_000,
      expires_at: '2026-09-24T10:05:00.000Z',
      details: { family: 'qwen3' },
    },
  ],
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
    if (request.url === '/api/ps') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(ps))
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

  // And the embedding model is not a model you can talk to. Found the hard way: the router
  // picked one, and Ollama answered the chat request with a 400.
  expect(models.map((m) => m.id)).not.toContain('bge-m3:latest')
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

test('local stats: what is on the disk and what is in memory, in bytes (D199)', async () => {
  expect(await local(host)).toEqual({
    running: true,
    installed: [
      { name: 'qwen3:8b', size: 5_200_000_000 },
      { name: 'llava:7b', size: 4_700_000_000 },
      { name: 'bge-m3:latest', size: 1_200_000_000 },
    ],
    loaded: [{ name: 'qwen3:8b', size: 6_100_000_000, vram: 4_000_000_000, until: '2026-09-24T10:05:00.000Z' }],
  })
})

test('local stats with no Ollama is an answer, not an error', async () => {
  // A port nothing listens on: the one closed a moment ago.
  const gone = createServer()
  await new Promise<void>((resolve) => gone.listen(0, '127.0.0.1', resolve))
  const port = (gone.address() as AddressInfo).port
  await new Promise<void>((resolve) => gone.close(() => resolve()))
  expect(await local(`http://127.0.0.1:${String(port)}`)).toEqual({ running: false, installed: [], loaded: [] })
})

test('local stats from something on the port that is not a readable Ollama is not running, not a throw', async () => {
  // Three ways to be wrong: a list with no `models`, a list whose rows have no names, and an
  // Ollama too old to have `/api/ps` (a 404). None of them may take the Local stats page down.
  let tagsBody: unknown = {}
  const odd = createServer((request, response) => {
    if (request.url === '/api/tags') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(tagsBody))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise<void>((resolve) => odd.listen(0, '127.0.0.1', resolve))
  const at = `http://127.0.0.1:${String((odd.address() as AddressInfo).port)}`
  try {
    expect(await local(at)).toEqual({ running: false, installed: [], loaded: [] })
    tagsBody = { models: [{ size: 5 }, null, { name: 'qwen3:8b', size: 'lots' }] }
    // Answered with a list: running, the nameless rows dropped, a size that is not a number is 0,
    // and no `ps` is nothing in memory rather than an error.
    expect(await local(at)).toEqual({ running: true, installed: [{ name: 'qwen3:8b', size: 0 }], loaded: [] })
  } finally {
    await new Promise<void>((resolve) => odd.close(() => resolve()))
  }
})
