// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'
import { pins, setPin } from '../src/commands.js'
import { remember, type Installed } from '../src/installed.js'
import { LLAMA } from '../src/llama.js'
import { LocalRunners, type ManagedRunner } from '../src/localRunners.js'
import type { ModeTransition } from '../src/modeTransition.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { serve } from '../src/serve.js'
import { noPolling } from './staged.js'

const root = mkdtempSync(join(tmpdir(), 'alexia-mode-api-'))
noPolling(root)
const file = join(root, 'model.gguf')
writeFileSync(file, 'GGUF')
const one: Installed = { id: 'llama/api-model', name: 'API Model', repo: 'test/model', revision: 'a'.repeat(40), quant: 'Q4', files: [file], bytes: 4, context: 4096, kvBytesPerToken: 1024, ready: true, tools: true, vision: false, abliterated: false, nsfwOk: 'unknown', vetted: false, installedAt: 1 }
remember(root, one)
let response: ServerResponse | undefined
const modelServer = createServer((request, answer) => {
  request.resume()
  request.on('end', () => {
    expect(request.headers.authorization).toBe('Bearer test-runner-key')
    answer.writeHead(200, { 'content-type': 'text/event-stream' })
    answer.write('data: {"choices":[{"delta":{"content":"Still answering"}}]}\n\n')
    response = answer
  })
})
await new Promise<void>((resolve) => modelServer.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`
let loaded: string | undefined
let ready: (() => void) | undefined
let hold = false
let fail = false
const runner: ManagedRunner = {
  ensure: vi.fn(async (id, signal) => {
    if (hold) await new Promise<void>((resolve) => { ready = resolve })
    signal?.throwIfAborted()
    if (fail) throw new Error('Authenticated readiness failed.')
    loaded = id
    return baseUrl
  }),
  acquire: async (id) => { loaded = id; return { baseUrl, key: 'test-runner-key', release: () => undefined } },
  loaded: () => loaded ? { model: loaded, baseUrl, since: 1 } : undefined,
  stop: vi.fn(async () => { loaded = undefined }),
}
const runners = new LocalRunners(root, [{ id: 'llama', server: runner, provider: LLAMA }])
const alexia = await serve({ dataDir: root, local: true, providers: [], secrets: memorySecrets(), pluginsDir: join(root, 'extensions'), localRunners: runners, modeTransitions: {
  available: () => true,
  machine: async () => ({ platform: 'darwin', arch: 'arm64', appleSilicon: true, chip: 'Test', ramBytes: 32 * 1024 ** 3, freeDiskBytes: 32 * 1024 ** 3, budgetBytes: 16 * 1024 ** 3 }),
} })
const request = (path: string, body?: unknown) => fetch(new URL(path, alexia.url), { method: body === undefined ? 'GET' : 'POST', headers: { 'x-alexia-token': alexia.token, 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) })
const state = async () => await (await request('/api/state')).json() as { setup: { mode: string }; pins: { model?: string; order?: string[] }; modeTransition: ModeTransition }
const settled = async () => { await vi.waitFor(async () => expect(['ready', 'failed']).toContain((await state()).modeTransition.phase)); return state() }
afterAll(async () => { ready?.(); response?.end(); await alexia.close(); modelServer.closeAllConnections(); await new Promise<void>((resolve) => modelServer.close(() => resolve())); rmSync(root, { recursive: true, force: true }) })

test('command, model picker, setup, and state use one transition with chat blocked until authenticated readiness', async () => {
  alexia.store.kvSet(CORE, 'mode', 'cloud')
  setPin(alexia.store, { model: one.id, order: ['previous'] })
  setPin(alexia.store, { model: undefined })
  hold = true
  const command = await (await request('/api/command', { input: '/local' })).json() as { data: { transitionId: string }; setup: { mode: string } }
  expect(command.setup.mode).toBe('cloud')
  await vi.waitFor(() => expect(ready).toBeDefined())
  expect((await state()).modeTransition).toMatchObject({ id: command.data.transitionId, targetMode: 'local', phase: 'loading', selectedModel: { id: one.id } })
  expect((await request('/api/chat', { text: 'Do not start yet' })).status).toBe(423)
  expect((await request('/api/local-models/benchmark', { id: one.id })).status).toBe(409)
  ready!()
  hold = false
  expect(await settled()).toMatchObject({ setup: { mode: 'local' }, pins: { model: one.id }, modeTransition: { phase: 'ready' } })
  expect(pins(alexia.store).order).toBeUndefined()
  await request('/api/setup', { mode: 'cloud' })
  expect(await settled()).toMatchObject({ setup: { mode: 'cloud' }, pins: {} })
  expect(runners.loaded()).toBeUndefined()
  await request('/api/local-models/use', { id: one.id, mode: 'local' })
  expect(await settled()).toMatchObject({ setup: { mode: 'local' }, pins: { model: one.id } })
  expect(alexia.store.kvGet(CORE, 'last_local_model')).toBe(one.id)
})

test('active answers finish before unloading, new submissions are blocked, and latest mode wins', async () => {
  const answer = await request('/api/chat', { text: 'Answer this on the local model' })
  expect(answer.status).toBe(200)
  const words = answer.text()
  await vi.waitFor(() => expect(response).toBeDefined())
  const stops = vi.mocked(runner.stop).mock.calls.length
  await request('/api/command', { input: '/cloud' })
  expect((await state()).modeTransition).toMatchObject({ phase: 'waiting', message: 'Switching after the current operation finishes.' })
  expect((await request('/api/chat', { text: 'Wait for the switch' })).status).toBe(423)
  expect(vi.mocked(runner.stop).mock.calls.length).toBe(stops)
  expect(runners.loaded()?.model).toBe(one.id)
  await request('/api/command', { input: '/combined' })
  response!.end('data: {"usage":{"prompt_tokens":5,"completion_tokens":5}}\n\ndata: [DONE]\n\n')
  expect(await words).toContain('Still answering')
  expect(await settled()).toMatchObject({ setup: { mode: 'combined' }, modeTransition: { phase: 'ready', targetMode: 'combined' } })
  expect(runners.loaded()).toBeUndefined()
  expect(pins(alexia.store).model).toBeUndefined()
})

test('API load errors preserve mode and pins; no usable model asks for the picker', async () => {
  setPin(alexia.store, { model: 'previous', order: ['previous'] })
  fail = true
  await request('/api/command', { input: '/local' })
  expect(await settled()).toMatchObject({ setup: { mode: 'combined' }, pins: { model: 'previous', order: ['previous'] }, modeTransition: { phase: 'failed', message: 'Authenticated readiness failed.' } })
  fail = false
  remember(root, { ...one, ready: false })
  await request('/api/command', { input: '/local' })
  expect(await settled()).toMatchObject({ setup: { mode: 'combined' }, pins: { model: 'previous' }, modeTransition: { phase: 'failed', picker: true } })
})
