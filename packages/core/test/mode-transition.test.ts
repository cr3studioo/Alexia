// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { pins, run, setPin } from '../src/commands.js'
import { readInstalled, remember, type Installed } from '../src/installed.js'
import { ModeTransitions } from '../src/modeTransition.js'
import type { Machine } from '../src/machine.js'
import { CORE } from '../src/secrets.js'
import { Store } from '../src/store.js'

const GB = 1024 ** 3
const here = (): Machine => ({ platform: 'darwin', arch: 'arm64', appleSilicon: true, chip: 'Test', ramBytes: 32 * GB, freeDiskBytes: 20 * GB, budgetBytes: 16 * GB })
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'alexia-mode-'))
  const store = new Store(join(root, 'alexia.db'))
  store.kvSet(CORE, 'mode', 'cloud')
  store.kvSet(CORE, 'pins', { model: 'cloud/previous', order: ['cloud/previous'], prefer: 'best', spend: 'free', uncensored: true, noTrain: true })
  let loaded: { model: string; baseUrl: string; since: number } | undefined
  let busy = false
  const runners = {
    loaded: () => loaded,
    stop: vi.fn(async () => { loaded = undefined }),
    ensure: vi.fn(async (model: string, signal?: AbortSignal) => { signal?.throwIfAborted(); loaded = { model, baseUrl: 'http://127.0.0.1:1/v1', since: Date.now() }; return loaded.baseUrl }),
  }
  const machine = vi.fn(async () => here())
  const available = vi.fn((one: Installed) => !one.id.includes('unsupported'))
  const controller = new ModeTransitions({ store, dataDir: root, runners, busy: () => busy, machine, available })
  cleanups.push(async () => { await controller.close(); store.close(); rmSync(root, { recursive: true, force: true }) })
  const install = (name: string, changes: Partial<Installed> = {}): Installed => {
    const file = join(root, `${name}.gguf`)
    writeFileSync(file, 'GGUF')
    const one: Installed = { id: `llama/${name}`, name, repo: 'test/model', revision: 'a'.repeat(40), quant: 'Q4', files: [file], bytes: GB, context: 4096, contextMax: 8192, kvBytesPerToken: 1024, ready: true, tools: false, vision: false, abliterated: false, nsfwOk: 'unknown', vetted: false, installedAt: Date.now(), ...changes }
    remember(root, one)
    return one
  }
  return { root, store, runners, machine, available, controller, install, busy: (value: boolean) => { busy = value }, load: (model: string) => { loaded = { model, baseUrl: 'http://127.0.0.1:1/v1', since: Date.now() } } }
}
const settle = async (controller: ModeTransitions) => {
  await vi.waitFor(() => expect(controller.pending()).toBe(false))
  return controller.status()!
}

test('Local eagerly loads the remembered model, waits for readiness, and persists it through Automatic and restart', async () => {
  const f = fixture()
  const old = f.install('remembered')
  f.install('tools', { tools: true, lastUsedAt: Date.now() })
  setPin(f.store, { model: old.id })
  setPin(f.store, { model: undefined })
  let ready!: () => void
  f.runners.ensure.mockImplementationOnce(async (model) => { await new Promise<void>((resolve) => { ready = resolve }); f.load(model); return 'ready' })
  const before = pins(f.store)
  const ran = await run('/local', { store: f.store, changeMode: async (mode) => f.controller.request(mode) })
  expect(ran.data).toEqual({ transitionId: f.controller.status()?.id })
  await vi.waitFor(() => expect(f.controller.status()?.message).toBe('Loading remembered…'))
  expect(f.store.kvGet(CORE, 'mode')).toBe('cloud')
  expect(pins(f.store)).toEqual(before)
  ready()
  expect(await settle(f.controller)).toMatchObject({ phase: 'ready', selectedModel: { id: old.id }, message: 'Local · remembered' })
  expect(pins(f.store).model).toBe(old.id)
  expect(readInstalled(f.root).find((one) => one.id === old.id)?.lastUsedAt).toBeGreaterThan(0)
  f.controller.request('cloud')
  await settle(f.controller)
  expect(pins(f.store).model).toBeUndefined()
  expect(f.store.kvGet(CORE, 'last_local_model')).toBe(old.id)
  const reopened = new Store(join(f.root, 'alexia.db'))
  const restarted = new ModeTransitions({ store: reopened, dataDir: f.root, runners: f.runners, busy: () => false, machine: f.machine, available: f.available })
  try {
    restarted.request('local')
    expect((await settle(restarted)).selectedModel?.id).toBe(old.id)
  } finally { await restarted.close(); reopened.close() }
})

test.each(['missing', 'unchecked', 'unsupported', 'oversized', 'invalid-draft'])('an %s remembered model falls back to verified tools, recent use, then stable ID', async (bad) => {
  const f = fixture()
  const invalid = f.install('unsupported', { ready: bad !== 'unchecked', bytes: bad === 'oversized' ? 100 * GB : GB, draftModelId: bad === 'invalid-draft' ? 'llama/absent' : undefined })
  if (bad !== 'unsupported') { f.available.mockReturnValue(true); invalid.id = 'llama/invalid'; remember(f.root, invalid) }
  if (bad === 'missing') rmSync(invalid.files[0]!)
  setPin(f.store, { model: invalid.id })
  f.install('recent-chat', { lastUsedAt: 10000 })
  f.install('older-tools', { tools: true, lastUsedAt: 5 })
  f.install('z-tools', { tools: true, lastUsedAt: 10 })
  const selected = f.install('a-tools', { tools: true, lastUsedAt: 10 })
  f.controller.request('local')
  expect((await settle(f.controller)).selectedModel?.id).toBe(selected.id)
})

test('a missing usable model opens the picker and preserves the confirmed mode and preferences', async () => {
  const f = fixture()
  f.install('unchecked', { ready: false })
  const before = pins(f.store)
  f.controller.request('local')
  expect(await settle(f.controller)).toMatchObject({ phase: 'failed', picker: true })
  expect(f.store.kvGet(CORE, 'mode')).toBe('cloud')
  expect(pins(f.store)).toEqual(before)
  expect(f.runners.ensure).not.toHaveBeenCalled()
})

test('switching never fetches a missing runtime', async () => {
  const f = fixture()
  f.install('model')
  const c = new ModeTransitions({ store: f.store, dataDir: f.root, runners: f.runners, busy: () => false, machine: f.machine })
  try { c.request('local'); expect(await settle(c)).toMatchObject({ phase: 'failed', picker: true }); expect(f.runners.ensure).not.toHaveBeenCalled() }
  finally { await c.close() }
})

test('a loaded target is reused even when free RAM excludes its existing allocation', async () => {
  const f = fixture()
  const one = f.install('model')
  setPin(f.store, { model: one.id })
  f.load(one.id)
  f.machine.mockResolvedValue({ ...here(), budgetBytes: 0 })
  f.controller.request('local')
  expect((await settle(f.controller)).phase).toBe('ready')
  expect(f.runners.stop).not.toHaveBeenCalled()
})

test('a previous target is stopped before the replacement probes available memory', async () => {
  const f = fixture()
  f.load('llama/old')
  const one = f.install('next')
  setPin(f.store, { model: one.id })
  f.machine.mockImplementation(async () => ({ ...here(), budgetBytes: f.runners.loaded() ? 0 : 16 * GB }))
  f.controller.request('local')
  expect((await settle(f.controller)).selectedModel?.id).toBe(one.id)
  expect(f.runners.stop).toHaveBeenCalledOnce()
  expect(f.machine).toHaveBeenCalledTimes(2)
})

test('configured context, cache, and draft allocation must fit after the old target unloads', async () => {
  const f = fixture()
  const one = f.install('big-cache', { kvBytesPerToken: GB, context: 8192 })
  setPin(f.store, { model: one.id })
  f.controller.request('local')
  expect(await settle(f.controller)).toMatchObject({ phase: 'failed', picker: true })
  expect(f.runners.ensure).not.toHaveBeenCalled()
})

test('authenticated readiness failure preserves mode, active pin, order, and remembered selection', async () => {
  const f = fixture()
  const one = f.install('model')
  f.store.kvSet(CORE, 'last_local_model', one.id)
  f.runners.ensure.mockRejectedValueOnce(new Error('Runner authentication failed.'))
  const before = pins(f.store)
  f.controller.request('local')
  expect(await settle(f.controller)).toMatchObject({ phase: 'failed', message: 'Runner authentication failed.' })
  expect(pins(f.store)).toEqual(before)
  expect(f.store.kvGet(CORE, 'mode')).toBe('cloud')
  expect(f.store.kvGet(CORE, 'last_local_model')).toBe(one.id)
})

test.each(['cloud', 'combined'] as const)('%s waits for active operations, clears model and order, and preserves other preferences', async (target) => {
  const f = fixture()
  const one = f.install('model')
  setPin(f.store, { model: one.id })
  f.store.kvSet(CORE, 'mode', 'local')
  f.load(one.id)
  f.busy(true)
  f.controller.request(target)
  expect(f.controller.status()).toMatchObject({ phase: 'waiting', message: 'Switching after the current operation finishes.' })
  await new Promise((resolve) => setTimeout(resolve, 120))
  expect(f.runners.stop).not.toHaveBeenCalled()
  expect(f.store.kvGet(CORE, 'mode')).toBe('local')
  f.busy(false)
  expect((await settle(f.controller)).message).toContain('Automatic')
  expect(pins(f.store)).toMatchObject({ prefer: 'best', spend: 'free', uncensored: true, noTrain: true })
  expect(pins(f.store).model).toBeUndefined()
  expect(pins(f.store).order).toBeUndefined()
  expect(f.store.kvGet(CORE, 'last_local_model')).toBe(one.id)
  expect(f.runners.loaded()).toBeUndefined()
})

test('rapid waiting selections replace the pending target', async () => {
  const f = fixture()
  f.install('model')
  f.busy(true)
  f.controller.request('local')
  f.controller.request('cloud')
  f.controller.request('combined')
  f.busy(false)
  expect(await settle(f.controller)).toMatchObject({ targetMode: 'combined', phase: 'ready' })
  expect(f.store.kvGet(CORE, 'mode')).toBe('combined')
  expect(f.runners.ensure).not.toHaveBeenCalled()
})

test('an obsolete load that ignores cancellation cannot commit later or leave a runner loaded', async () => {
  const f = fixture()
  f.install('model')
  let finish!: () => void
  let signal: AbortSignal | undefined
  f.runners.ensure.mockImplementationOnce(async (id, s) => { signal = s; await new Promise<void>((resolve) => { finish = resolve }); f.load(id); return 'ready' })
  f.controller.request('local')
  await vi.waitFor(() => expect(finish).toBeDefined())
  f.controller.request('combined')
  expect(signal?.aborted).toBe(true)
  finish()
  expect(await settle(f.controller)).toMatchObject({ targetMode: 'combined', phase: 'ready' })
  expect(f.store.kvGet(CORE, 'mode')).toBe('combined')
  expect(pins(f.store).model).toBeUndefined()
  expect(f.runners.loaded()).toBeUndefined()
})

test('the remembered explicit Ollama choice preserves first-run selection under its external lifecycle', async () => {
  const f = fixture()
  f.store.kvSet(CORE, 'last_local_model', 'qwen3:8b')
  const external = vi.fn(async () => ({ id: 'qwen3:8b', name: 'Qwen3' }))
  const c = new ModeTransitions({ store: f.store, dataDir: f.root, runners: f.runners, busy: () => false, machine: f.machine, external })
  try {
    c.request('local')
    expect(await settle(c)).toMatchObject({ phase: 'ready', selectedModel: { id: 'qwen3:8b' } })
    expect(pins(f.store).model).toBe('qwen3:8b')
    expect(f.runners.ensure).not.toHaveBeenCalled()
    c.request('cloud')
    await settle(c)
    expect(f.store.kvGet(CORE, 'last_local_model')).toBe('qwen3:8b')
  } finally { await c.close() }
})
