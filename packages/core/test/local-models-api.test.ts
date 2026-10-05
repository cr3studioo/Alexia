// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'
import { serve } from '../src/serve.js'
import { memorySecrets, CORE } from '../src/secrets.js'
import { noPolling } from './staged.js'
import { asModel, modelsDir, remember, type Installed } from '../src/installed.js'

const root = mkdtempSync(join(tmpdir(), 'alexia-local-api-'))
noPolling(root)
const secrets = memorySecrets()
const server = await serve({ dataDir: root, providers: [], local: true, secrets, pluginsDir: join(root, 'extensions') })
afterAll(async () => { await server.close(); rmSync(root, { recursive: true, force: true }) })
const request = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => fetch(new URL(path, server.url), { method, headers: { 'x-alexia-token': server.token, 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) })

test('local-model installation API rejects unauthenticated calls and malformed targets', async () => {
  expect((await fetch(new URL('/api/local-models', server.url))).status).toBe(403)
  const malformed = await request('/api/local-models/install', { repo: '../outside', quant: 'Q4_K_M' })
  expect(malformed.status).toBe(400)
  expect(await malformed.json()).toMatchObject({ ok: false })
  expect((await request('/api/local-models/progress?job=missing')).status).toBe(404)
})

test('Hugging Face token is stored only in the keychain and can be removed', async () => {
  const response = await request('/api/local-models/token', { token: 'test-only-hf-token' })
  expect(response.ok).toBe(true)
  expect(await secrets.get(CORE, 'huggingface_token')).toBe('test-only-hf-token')
  expect(server.store.kvGet(CORE, 'huggingface_token')).toBeUndefined()
  expect(JSON.stringify(await (await request('/api/local-models')).json())).not.toContain('test-only-hf-token')
  await request('/api/local-models/token', { token: '' })
  expect(await secrets.get(CORE, 'huggingface_token')).toBeUndefined()
})

test('an installed llama model appears in the existing Models table and encoded DELETE removes it', async () => {
  const file = join(modelsDir(root), 'test', 'api.gguf')
  mkdirSync(join(modelsDir(root), 'test'), { recursive: true })
  writeFileSync(file, 'GGUF')
  const model: Installed = { id: 'llama/api-test:q4_k_m', name: 'API Test', repo: 'test/api', revision: 'b'.repeat(40), quant: 'Q4_K_M', files: [file], bytes: 4, context: 8192, tools: true, vision: false, params: 8, abliterated: false, nsfwOk: 'unknown', vetted: true, installedAt: Date.now() }
  remember(root, model)
  const result = await request('/api/rows', { key: 'models' })
  expect(JSON.stringify(await result.json())).toContain(asModel(model).id)
  expect((await request('/api/local-models/use', { id: model.id, mode: 'local' })).ok).toBe(true)
  await vi.waitFor(async () => {
    const state = await (await request('/api/state')).json() as { modeTransition?: { phase: string } }
    expect(['ready', 'failed']).toContain(state.modeTransition?.phase)
  }, { timeout: 10_000 })
  const gone = await request(`/api/local-models/${encodeURIComponent(model.id)}`, {}, 'DELETE')
  expect(gone.status).toBe(200)
  expect(await gone.json()).toMatchObject({ ok: true })
})

test('context GET defaults and UI POST payload preserve or explicitly clear a draft', async () => {
  const file = join(root, 'context.gguf')
  writeFileSync(file, 'GGUF')
  const parent: Installed = { id: 'llama/context-test', name: 'Context', repo: 'test/context', revision: 'a'.repeat(40), quant: 'Q4', files: [file], owned: false, bytes: 4, params: 8, context: 512, contextMax: 8192, kvBytesPerToken: 128, kvCache: 'q8_0', tokenizerFingerprint: 'same', draftModelId: 'llama/context-draft', tools: false, vision: false, abliterated: false, nsfwOk: 'unknown', vetted: false, installedAt: Date.now() }
  const draft = { ...parent, id: 'llama/context-draft', params: 1, draftModelId: undefined }
  remember(root, parent)
  remember(root, draft)
  const get = await request(`/api/local-models/context?id=${parent.id}`)
  expect(get.status).toBe(200)
  const preview = await get.json() as { needBytes: number; context: number }
  expect(preview.context).toBe(512)
  const cleared = await request(`/api/local-models/context?id=${parent.id}&draftModelId=`)
  expect((await cleared.json() as { needBytes: number }).needBytes).toBeLessThan(preview.needBytes)
  const post = await request('/api/local-models/context', { id: parent.id, context: 1024, kvCache: 'q4_0', draftModelId: null })
  expect(post.status).toBe(200)
  expect(await post.json()).toMatchObject({ ok: true })
  const { readInstalled } = await import('../src/installed.js')
  expect(readInstalled(root).find((m) => m.id === parent.id)).toMatchObject({ context: 1024, kvCache: 'q4_0' })
  expect(readInstalled(root).find((m) => m.id === parent.id)?.draftModelId).toBeUndefined()
  await request('/api/local-models/remove', { id: parent.id })
  await request('/api/local-models/remove', { id: draft.id })
})

test('phase2 validation errors return 400 before any runtime work', async () => {
  const file = join(root, 'validation.gguf')
  writeFileSync(file, 'GGUF')
  const model: Installed = { id: 'llama/validation', name: 'Validation', repo: 'test/context', revision: 'a'.repeat(40), quant: 'Q4', files: [file], owned: false, bytes: 4, context: 512, contextMax: 8192, tools: false, vision: false, abliterated: false, nsfwOk: 'unknown', vetted: false, installedAt: Date.now() }
  remember(root, model)
  for (const query of ['context=NaN', 'context=-1', 'context=8193', 'kvCache=bad', 'draftModelId=unknown']) {
    expect((await request(`/api/local-models/context?id=${model.id}&${query}`)).status, query).toBe(400)
  }
  expect((await request('/api/local-models/context', { id: model.id, context: 512, kvCache: 'f16', draftModelId: 42 })).status).toBe(400)
  expect((await request('/api/local-models/import-preview?path=relative.gguf')).status).toBe(400)
  expect((await request('/api/local-models/import-preview?path=/no/such/model.gguf')).status).toBe(400)
  expect((await request('/api/local-models/import', { path: file, storage: 'delete' })).status).toBe(400)
  expect((await request('/api/local-models/import', { path: '/no/such/model.gguf' })).status).toBe(400)
  expect((await request('/api/local-models/search?format=bad')).status).toBe(400)
  expect((await request('/api/local-models/repo?repo=bad')).status).toBe(400)
  expect((await request('/api/local-models/install', { repo: 'test/model', quant: 'Q4', format: 'bad' })).status).toBe(400)
  expect((await request('/api/local-models/install', { repo: 'test/model', quant: 'Q4', revision: 42 })).status).toBe(400)
  await request('/api/local-models/remove', { id: model.id })
})

test('local stats expose both managed runtimes and maintenance is read only', async () => {
  const stats = await request('/api/local-stats')
  expect(await stats.json()).toMatchObject({ runners: { llama: false, mlx: false } })
  const result = await request('/api/local-models/maintenance')
  expect(result.status).toBe(200)
  expect(await result.json()).toMatchObject({ updates: [], cleanup: [], reclaimableBytes: 0 })
})
