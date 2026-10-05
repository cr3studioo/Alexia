// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { LocalModels } from '../src/localModels.js'
import { Store } from '../src/store.js'
import { readInstalled, remember, type Installed } from '../src/installed.js'
import type { LlamaServer } from '../src/llama.js'
import type { LocalRunners } from '../src/localRunners.js'
import type { Machine } from '../src/machine.js'
import { importGguf } from '../src/importModel.js'
import { repo } from '../src/mlxHf.js'
import { LOCAL_CATALOG } from '../src/localCatalog.js'
vi.mock('../src/importModel.js', () => ({ importGguf: vi.fn() }))
vi.mock('../src/mlxHf.js', () => ({ repo: vi.fn(), search: vi.fn() }))
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.clearAllMocks() })
const machine = { platform: 'darwin', arch: 'arm64', appleSilicon: true, chip: 'Test', ramBytes: 32 * 1024 ** 3, freeDiskBytes: 64 * 1024 ** 3, budgetBytes: 16 * 1024 ** 3, gpu: { backend: 'metal', vramBytes: null } } as Machine
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'alexia-phase2-'))
  const store = new Store(':memory:')
  const file = join(root, 'model.gguf')
  writeFileSync(file, 'GGUF')
  const one: Installed = { id: 'llama/import-test:q4', format: 'gguf', name: 'Import', repo: 'local/import', revision: 'a'.repeat(40), quant: 'Q4', files: [file], owned: false, imported: true, bytes: 4, params: 1, context: 8192, contextMax: 16384, kvBytesPerToken: 1024, tools: false, vision: false, abliterated: false, nsfwOk: 'unknown', vetted: false, installedAt: 1 }
  const runner = { ensure: vi.fn(async () => 'http://localhost/v1'), loaded: () => undefined, stop: vi.fn(async () => {}) } as unknown as LlamaServer
  const manager = new LocalModels({ dataDir: root, store, server: runner, machine: async () => machine, ensureRuntime: vi.fn(async () => ({})) as never, smoke: async () => { throw new Error('smoke failed') } })
  cleanups.push(async () => { await manager.close(); store.close(); rmSync(root, { recursive: true, force: true }) })
  return { root, store, file, one, runner, manager }
}

test('legacy pinned installations regain context controls and persist metadata when configured', async () => {
  const { root, one, manager } = fixture()
  const entry = LOCAL_CATALOG.find((entry) => entry.id === 'qwen3-4b-instruct-2507')!
  const quant = entry.quants.find((quant) => quant.quant === 'Q4_K_M')!
  const legacy = { ...one, entry: entry.id, repo: entry.repo, revision: entry.revision,
    quant: quant.quant, bytes: quant.bytes, params: entry.params, imported: false, owned: true }
  delete legacy.contextMax
  delete legacy.kvBytesPerToken
  remember(root, legacy)
  expect(await manager.context(legacy.id, 16384, 'q4_0')).toMatchObject({ contextMax: entry.contextMax, context: 16384 })
  expect((await manager.overview()).installed[0]?.contextMax).toBe(entry.contextMax)
  expect(readInstalled(root)[0]?.contextMax).toBeUndefined()
  await manager.configure(legacy.id, 16384, 'q4_0')
  expect(readInstalled(root)[0]).toMatchObject({ context: 16384, contextMax: entry.contextMax, kvBytesPerToken: entry.kvBytesPerToken, kvCache: 'q4_0' })

  remember(root, { ...legacy, revision: 'b'.repeat(40) })
  await expect(manager.context(legacy.id, 16384, 'q4_0')).rejects.toMatchObject({ status: 400 })
  expect((await manager.overview()).installed[0]?.contextMax).toBe(legacy.context)
})

test('a failed new import forgets the unchecked record; a failed replacement restores the old one', async () => {
  const { root, one, manager } = fixture()
  vi.mocked(importGguf).mockResolvedValue({ ...one, ready: false })
  const job = manager.import(one.files[0]!, 'reference')
  await vi.waitFor(() => expect(job.step).toBe('failed'))
  expect(readInstalled(root)).toEqual([])
  remember(root, { ...one, ready: true, lastUsedAt: 123 })
  const replacement = manager.import(one.files[0]!, 'reference')
  await vi.waitFor(() => expect(replacement.step).toBe('failed'))
  expect(readInstalled(root)).toEqual([{ ...one, ready: true, lastUsedAt: 123 }])
})

test('configuration holds an operation lock across awaits and releases it on success and validation errors', async () => {
  const { root, one, manager } = fixture()
  remember(root, one)
  const configured = manager.configure(one.id, 4096, 'f16', null)
  expect(manager.busy()).toBe(true)
  const removal = manager.remove(one.id)
  expect(() => manager.install({ repo: 'test/other', quant: 'Q4' })).toThrow('operation')
  expect(() => manager.use(one.id)).toThrow('operation')
  await expect(removal).rejects.toMatchObject({ status: 409 })
  await configured
  expect(manager.busy()).toBe(false)
  expect(readInstalled(root)[0]?.context).toBe(4096)
  await expect(manager.configure(one.id, 100000, 'f16')).rejects.toMatchObject({ status: 400 })
  expect(manager.busy()).toBe(false)
  rmSync(one.files[0]!)
  await expect(manager.context(one.id)).rejects.toMatchObject({ status: 404 })
})

test('MLX repo fit and installation context use metadata instead of the unknown-layout allowance', async () => {
  const { root, store, runner } = fixture()
  const content = Buffer.from('fixture')
  const { createHash } = await import('node:crypto')
  vi.mocked(repo).mockResolvedValue({ repo: 'test/mlx', revision: 'b'.repeat(40), params: 8, contextMax: 4096, kvBytesPerToken: 4096, architecture: 'qwen3', tokenizerFingerprint: 'tokenizer', gated: false, quants: [{ quant: 'MLX_4BIT', bytes: content.length, files: [{ name: 'model.safetensors', bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') }] }] })
  const manager = new LocalModels({ dataDir: root, store, server: runner, runners: runner as unknown as LocalRunners, machine: async () => machine, ensureMlxRuntime: vi.fn(async () => ({})) as never, fetch: vi.fn(async () => new Response(content)), smoke: async () => ({}) })
  try {
    const preview = await manager.hf('test/mlx', 'mlx')
    expect(preview.quants[0]?.verdict).toBe('fits')
    expect(preview.quants[0]?.note ?? '').not.toContain('unknown')
    const job = manager.install({ repo: 'test/mlx', quant: 'MLX_4BIT', format: 'mlx' })
    await vi.waitFor(() => expect(job.step).toBe('done'))
    expect(readInstalled(root)[0]).toMatchObject({ format: 'mlx', context: 4096, contextMax: 4096, kvBytesPerToken: 4096, architecture: 'qwen3', tokenizerFingerprint: 'tokenizer', ready: true })
    expect(readInstalled(root)[0]?.lastUsedAt).toBeGreaterThan(1)
  } finally { await manager.close() }
})
