// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { LocalRunners, type ManagedRunner, type RunnerLease } from '../src/localRunners.js'
import { readInstalled, remember, type Installed } from '../src/installed.js'
import { LLAMA } from '../src/llama.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'alexia-coordinator-'))
  roots.push(root)
  const file = join(root, 'weights')
  writeFileSync(file, 'weights')
  for (const format of ['gguf', 'mlx'] as const) remember(root, {
    id: `${format === 'gguf' ? 'llama' : 'mlx'}/test`, format, name: 'Test', repo: 'test/model', revision: 'a'.repeat(40), quant: 'Q4', files: [file], bytes: 7,
    context: 8192, tools: false, vision: false, abliterated: false, nsfwOk: 'unknown', vetted: false, ready: false, installedAt: 1,
  })
  const runner = () => {
    let model: string | undefined
    const release = vi.fn()
    const server = {
      ensure: vi.fn(async (id: string) => { model = id; return 'http://localhost/v1' }),
      acquire: vi.fn(async (id: string) => { model = id; return { baseUrl: 'http://localhost/v1', key: 'test', release } }),
      loaded: () => model ? { model, baseUrl: 'http://localhost/v1', since: 1 } : undefined,
      // Deliberately ignores leases: only the broker protects the active response.
      stop: vi.fn(async () => { model = undefined }),
    } satisfies ManagedRunner
    return { server, release }
  }
  const llama = runner(), mlx = runner()
  const broker = new LocalRunners(root, [
    { id: 'llama', server: llama.server, provider: LLAMA },
    { id: 'mlx', server: mlx.server, provider: { ...LLAMA, id: 'mlx' } },
  ])
  return { root, broker, llama, mlx }
}

test('cross-backend switching waits for every provider lease, with idempotent release', async () => {
  const { root, broker, llama, mlx } = fixture()
  const provider = broker.provider('llama/test')
  const first = await provider.prepare!('llama/test') as RunnerLease
  const second = await provider.prepare!('llama/test') as RunnerLease
  expect(readInstalled(root).find((m) => m.id === 'llama/test')?.lastUsedAt).toBeGreaterThan(1)
  const switching = broker.ensure('mlx/test')
  await new Promise((resolve) => setImmediate(resolve))
  expect(llama.server.stop).not.toHaveBeenCalled()
  first.release()
  first.release()
  await new Promise((resolve) => setImmediate(resolve))
  expect(mlx.server.ensure).not.toHaveBeenCalled()
  second.release()
  await switching
  expect(llama.release).toHaveBeenCalledTimes(2)
  expect(llama.server.stop).toHaveBeenCalledTimes(1)
  expect(broker.loaded()?.model).toBe('mlx/test')
  await broker.stop()
})

test('aborting a waiting switch keeps the leased backend alive and permits another request', async () => {
  const { broker, llama, mlx } = fixture()
  const lease = await broker.provider('llama/test').prepare!('llama/test') as RunnerLease
  const abort = new AbortController()
  const switching = broker.ensure('mlx/test', abort.signal)
  await new Promise((resolve) => setImmediate(resolve))
  abort.abort(new Error('cancel switch'))
  await expect(switching).rejects.toThrow('cancel switch')
  await broker.ensure('llama/test')
  expect(llama.server.stop).not.toHaveBeenCalled()
  expect(mlx.server.ensure).not.toHaveBeenCalled()
  lease.release()
  await broker.stop()
})

test('wrong-provider preparation has no backend side effects; stop drains leases and is shared', async () => {
  const { broker, llama, mlx } = fixture()
  await expect(broker.providers()[0]!.prepare!('mlx/test')).rejects.toThrow('another local runner')
  expect(llama.server.stop).not.toHaveBeenCalled()
  expect(mlx.server.stop).not.toHaveBeenCalled()
  const lease = await broker.provider('mlx/test').prepare!('mlx/test') as RunnerLease
  const stop = broker.stop()
  expect(broker.stop()).toBe(stop)
  await new Promise((resolve) => setImmediate(resolve))
  expect(mlx.server.stop).not.toHaveBeenCalled()
  lease.release()
  await stop
  expect(mlx.server.stop).toHaveBeenCalledTimes(1)
  await broker.ensure('llama/test')
  await broker.stop()
})

test('missing model files are rejected before starting or stopping any backend', async () => {
  const { root, broker, llama, mlx } = fixture()
  const one = readInstalled(root)[0] as Installed
  rmSync(one.files[0]!)
  await expect(broker.ensure(one.id)).rejects.toThrow('missing')
  expect(llama.server.stop).not.toHaveBeenCalled()
  expect(mlx.server.ensure).not.toHaveBeenCalled()
})
