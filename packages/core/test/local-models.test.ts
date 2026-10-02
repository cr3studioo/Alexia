// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'
import { LocalModels } from '../src/localModels.js'
import { readInstalled } from '../src/installed.js'
import type { LlamaServer } from '../src/llama.js'
import type { Machine } from '../src/machine.js'
import { Store } from '../src/store.js'
import { CORE } from '../src/secrets.js'
import { pins } from '../src/commands.js'

const root = mkdtempSync(join(tmpdir(), 'alexia-local-flow-'))
const store = new Store(':memory:')
let loaded: { model: string } | undefined
const stop = vi.fn(async () => { loaded = undefined })
const server = { ensure: vi.fn(async (model: string) => { loaded = { model }; return 'http://127.0.0.1:1/v1' }), loaded: () => loaded, stop } as unknown as LlamaServer
const content = Buffer.from('fake GGUF data')
const revision = 'a'.repeat(40)
const sha256 = createHash('sha256').update(content).digest('hex')
const fetcher = vi.fn(async (url: string | URL | Request) => {
  const path = String(url)
  if (path.includes('/tree/')) return Response.json([{ type: 'file', path: 'Test-Q4_K_M.gguf', size: content.length, lfs: { size: content.length, oid: sha256 } }])
  if (path.includes('/api/models/')) return Response.json({ sha: revision, gated: false, cardData: { license: 'apache-2.0' }, gguf: { total: 8e9 } })
  return new Response(content)
}) as unknown as typeof fetch
const here = async () => ({ platform: 'darwin', arch: 'arm64', appleSilicon: true, chip: 'Test', ramBytes: 128 * 1024 ** 3, freeDiskBytes: 128 * 1024 ** 3, budgetBytes: 64 * 1024 ** 3, gpu: { backend: 'metal', vramBytes: null } }) as Machine
let failSmoke = false
const manager = new LocalModels({ dataDir: root, store, server, machine: here, fetch: fetcher, ensureRuntime: vi.fn(async () => ({ version: 'test' })) as never, smoke: async () => { if (failSmoke) throw new Error('chat template failed'); return { tokensPerSecond: 10 } } })
afterAll(async () => { await manager.close(); store.close(); rmSync(root, { recursive: true, force: true }) })
async function settled(id: string) {
  await vi.waitFor(() => expect(['done', 'failed', 'cancelled']).toContain(manager.job(id)?.step))
  return manager.job(id)!
}

test('one install verifies bytes, registers the model, starts it, and only then changes the pin', async () => {
  store.kvSet(CORE, 'mode', 'local')
  const job = manager.install({ repo: 'test/model', quant: 'Q4_K_M' })
  expect(() => manager.install({ repo: 'test/other', quant: 'Q4_K_M' })).toThrow('still being installed')
  expect((await settled(job.id)).step).toBe('done')
  const installed = readInstalled(root)[0]!
  expect(installed.id).toMatch(/^llama\//)
  expect(installed.tools).toBe(false)
  expect(installed.nsfwOk).toBe('unknown')
  expect(installed.tokensPerSecond).toBe(10)
  expect(existsSync(installed.files[0]!)).toBe(true)
  expect(pins(store).model).toBe(installed.id)
  expect(await manager.remove(installed.id)).toMatchObject({ ok: true })
  expect(existsSync(installed.files[0]!)).toBe(false)
  expect(pins(store).model).toBeUndefined()
})

test('a failed smoke test preserves the earlier model choice and mode', async () => {
  store.kvSet(CORE, 'mode', 'cloud')
  store.kvSet(CORE, 'pins', { model: 'previous-working-model' })
  failSmoke = true
  expect(() => manager.install({ repo: 'test/model', quant: 'Q4_K_M' })).toThrow('Choose Local or Combined')
  const job = manager.install({ repo: 'test/model', quant: 'Q4_K_M', mode: 'local' })
  expect((await settled(job.id)).step).toBe('failed')
  expect(manager.job(job.id)?.error).toContain('chat template failed')
  expect(pins(store).model).toBe('previous-working-model')
  expect(store.kvGet(CORE, 'mode')).toBe('cloud')
  expect(loaded).toBeUndefined()
  const unfinished = readInstalled(root)[0]!
  expect(unfinished.ready).toBe(false)
  expect(manager.use(unfinished.id, 'local')).toMatchObject({ ok: false })
})

test('malformed paths are rejected before a job or download starts', () => {
  expect(() => manager.install({ repo: '../outside', quant: 'Q4_K_M', mode: 'local' })).toThrow('Hugging Face')
  expect(() => manager.install({ repo: 'test/model', quant: '../../file', mode: 'local' })).toThrow('quantization')
})

test('a failed reinstall restores the previously checked installation', async () => {
  store.kvSet(CORE, 'mode', 'local')
  failSmoke = false
  const first = manager.install({ repo: 'test/model', quant: 'Q4_K_M' })
  expect((await settled(first.id)).step).toBe('done')
  const previous = readInstalled(root)[0]!
  expect(previous.ready).toBe(true)
  failSmoke = true
  const retry = manager.install({ repo: 'test/model', quant: 'Q4_K_M' })
  expect((await settled(retry.id)).step).toBe('failed')
  expect(readInstalled(root)[0]).toEqual(previous)
  expect(pins(store).model).toBe(previous.id)
  expect(manager.use(previous.id)).toMatchObject({ ok: true })
})

test('the actual chat and tool checks run through accounting before a model becomes routable', async () => {
  const { createServer } = await import('node:http')
  const checked = new Store(':memory:')
  const directory = mkdtempSync(join(tmpdir(), 'alexia-local-check-'))
  const release = vi.fn()
  const http = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += String(chunk) })
    request.on('end', () => {
      expect(request.headers.authorization).toBe('Bearer local-check-key')
      const asked = JSON.parse(body) as { tools?: unknown[] }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const delta = asked.tools ? { tool_calls: [{ index: 0, id: 'check-1', function: { name: 'readiness_check', arguments: '{"value":"ready"}' } }] } : { content: 'The model is ready.' }
      response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`)
      setTimeout(() => response.end('data: {"usage":{"prompt_tokens":10,"completion_tokens":7},"choices":[]}\n\ndata: [DONE]\n\n'), 30)
    })
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const port = (http.address() as import('node:net').AddressInfo).port
  let current: { model: string } | undefined
  const runner = {
    ensure: async (model: string) => { current = { model }; return `http://127.0.0.1:${port}/v1` },
    acquire: async () => ({ baseUrl: `http://127.0.0.1:${port}/v1`, key: 'local-check-key', release }),
    loaded: () => current,
    stop: async () => { current = undefined },
  } as unknown as LlamaServer
  const local = new LocalModels({
    dataDir: directory, store: checked, server: runner, machine: here, fetch: fetcher,
    ensureRuntime: vi.fn(async () => ({ version: 'test' })) as never,
    catalog: [{ id: 'tiny-fixture', name: 'Tiny fixture', publisher: 'Test', repo: 'test/check', revision, params: 8, contextMax: 8192, kvBytesPerToken: 65536, tools: true, vision: false, abliterated: false, nsfwOk: 'no', gated: false, licence: { name: 'apache-2.0', url: 'https://huggingface.co/test/check', restrictive: false }, blurb: '', quants: [{ quant: 'Q4_K_M', bytes: content.length, files: [{ name: 'Check-Q4_K_M.gguf', bytes: content.length, sha256 }] }] }],
  })
  try {
    const job = local.install({ entry: 'tiny-fixture', quant: 'Q4_K_M' })
    await vi.waitFor(() => expect(local.job(job.id)?.step).toBe('done'))
    const one = readInstalled(directory)[0]!
    expect(one.ready).toBe(true)
    expect(one.tools).toBe(true)
    expect(one.tokensPerSecond).toBeGreaterThan(0)
    expect(checked.tries()).toHaveLength(2)
    expect(checked.tries().every((attempt) => attempt.source === 'test')).toBe(true)
    expect(release).toHaveBeenCalledTimes(2)
  } finally {
    await local.close()
    await new Promise<void>((resolve) => http.close(() => resolve()))
    checked.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('selecting Cloud during a long installation is respected when the model finishes', async () => {
  store.kvSet(CORE, 'mode', 'combined')
  store.kvSet(CORE, 'pins', { model: 'before-download' })
  const changed = new LocalModels({ dataDir: root, store, server, machine: here, fetch: fetcher, ensureRuntime: vi.fn(async () => ({ version: 'test' })) as never, smoke: async () => { store.kvSet(CORE, 'mode', 'cloud'); return {} } })
  const job = changed.install({ repo: 'test/model', quant: 'Q4_K_M' })
  await vi.waitFor(() => expect(changed.job(job.id)?.step).toBe('done'))
  expect(store.kvGet(CORE, 'mode')).toBe('cloud')
  expect(pins(store).model).toBe('before-download')
  expect(changed.job(job.id)?.message).toContain('Cloud was selected')
  await changed.close()
})
