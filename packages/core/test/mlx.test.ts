// SPDX-License-Identifier: AGPL-3.0-only
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { readInstalled, remember, type Installed } from '../src/installed.js'
import { MLX_VERSION, MlxServer, mlxProvider, type MlxServerOptions } from '../src/mlx.js'

const fixtures: { dir: string; server: MlxServer; children: ChildProcess[] }[] = []
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const exited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null
const config = { model_type: 'qwen3', max_position_embeddings: 32768, num_hidden_layers: 28, num_key_value_heads: 8, head_dim: 128, quantization: { bits: 4, group_size: 64 } }

function record(dir: string, name: string, changes: Partial<Installed> = {}): Installed {
  const folder = join(dir, 'models', name)
  mkdirSync(folder, { recursive: true })
  const contents = { 'config.json': JSON.stringify(config), 'tokenizer_config.json': JSON.stringify({ tokenizer_class: 'PreTrainedTokenizerFast' }), 'tokenizer.json': '{}', 'model.safetensors': 'fixture weights' }
  for (const [file, body] of Object.entries(contents)) writeFileSync(join(folder, file), body)
  const model: Installed = {
    id: `mlx/test/${name}:mlx_4bit`, name, format: 'mlx', repo: `test/${name}`, revision: 'a'.repeat(40),
    quant: 'MLX_4BIT', files: Object.keys(contents).map((file) => join(folder, file)), bytes: 100,
    context: 8192, tools: false, vision: false, abliterated: false, nsfwOk: 'no', vetted: true,
    ready: false, installedAt: Date.now(), ...changes,
  }
  remember(dir, model)
  return model
}

// Exercise the real pipes, readiness polling, HTTP authentication and process lifecycle.
// Python arguments are intentionally ignored; real MLX installation is covered by Mac E2E.
function setup(mode = 'normal', options: Partial<MlxServerOptions> = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'alexia-mlx-test-')))
  mkdirSync(join(dir, 'runtime', 'mlx', MLX_VERSION), { recursive: true })
  const one = record(dir, 'one'), two = record(dir, 'two')
  const children: ChildProcess[] = []
  const script = `
    const http = require('node:http'), fs = require('node:fs'), readline = require('node:readline');
    const mode = ${JSON.stringify(mode)}, folder = ${JSON.stringify(dir)};
    let server;
    const input = readline.createInterface({ input: process.stdin });
    input.once('line', line => {
      const settings = JSON.parse(line);
      fs.appendFileSync(folder + '/starts', JSON.stringify({ ...settings, pid: process.pid }) + '\\n');
      if (mode === 'exit') { process.stderr.write('fixture load failed'); process.exit(7); }
      if (mode === 'hang') return;
      server = http.createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.headers.authorization !== 'Bearer ' + settings.key) { res.writeHead(401); res.end('{}'); return; }
        if (req.url === '/health') { res.end(JSON.stringify({ status: 'ok', model: mode === 'wrong' ? 'wrong-model' : settings.id })); return; }
        if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: settings.id }] })); return; }
        res.writeHead(404); res.end('{}');
      });
      server.listen(0, '127.0.0.1', () => {
        process.stdout.write('library startup notice\\n');
        process.stdout.write(JSON.stringify({ ready: true, port: server.address().port }) + '\\n');
      });
    });
    input.once('close', () => {
      fs.appendFileSync(folder + '/exits', process.pid + '\\n');
      if (server) { server.closeAllConnections(); server.close(() => process.exit(0)); }
      else process.exit(0);
    });
  `
  const launch = vi.fn((...args: Parameters<typeof spawn>) => {
    const child = spawn(process.execPath, ['-e', script], args[2])
    children.push(child)
    return child
  })
  const runtime = vi.fn(async () => ({ version: 'fixture', executable: '/unused/python' }))
  const server = new MlxServer({ dataDir: dir, runtime, spawn: launch as unknown as typeof spawn, pressure: async () => 'normal', startTimeoutMs: 5000, stopMs: 100, ...options })
  fixtures.push({ dir, server, children })
  const starts = (): { id: string; key: string; path: string; context: number; kvBits: number | null; pid: number }[] => existsSync(join(dir, 'starts')) ? readFileSync(join(dir, 'starts'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []
  return { dir, server, one, two, launch, runtime, children, starts }
}

afterEach(async () => {
  for (const { dir, server, children } of fixtures.splice(0)) {
    const emergency = setTimeout(() => { for (const child of children) if (!exited(child)) child.kill('SIGKILL') }, 3000)
    try {
      await server.stop()
      await vi.waitFor(() => expect(children.every(exited)).toBe(true), { timeout: 5000 })
    } finally { clearTimeout(emergency); rmSync(dir, { recursive: true, force: true }) }
  }
})

test('pending models start for smoke checks; provider preparation returns an authenticated loopback lease', async () => {
  const { dir, server, one, starts, launch } = setup()
  remember(dir, { ...one, kvCache: 'q8_0' })
  const prepared = await mlxProvider(server).prepare!(one.id)
  expect(typeof prepared).toBe('object')
  if (typeof prepared === 'string') throw new Error('Expected an MLX lease')
  const url = new URL(prepared.baseUrl)
  expect(url.hostname).toBe('127.0.0.1')
  expect(url.pathname).toBe('/v1')
  expect(url.username).toBe('')
  expect(prepared.key).toMatch(/^[a-f0-9]{48}$/)
  expect((await fetch(`${prepared.baseUrl}/models`)).status).toBe(401)
  expect((await fetch(`${prepared.baseUrl}/models`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
  const response = await fetch(`${prepared.baseUrl}/models`, { headers: { authorization: `Bearer ${prepared.key}` } })
  expect(await response.json()).toEqual({ data: [{ id: one.id }] })
  expect(starts()).toEqual([expect.objectContaining({ id: one.id, path: join(dir, 'models', 'one'), context: 8192, kvBits: 8, key: prepared.key })])
  expect(JSON.stringify(launch.mock.calls[0]![1])).not.toContain(prepared.key)
  expect(server.loaded()).toMatchObject({ model: one.id, baseUrl: prepared.baseUrl, pid: starts()[0]!.pid })
  expect(readInstalled(dir).find((model) => model.id === one.id)?.ready).toBe(false)
  prepared.release!()
})

test('same-model leases share a process, prevent idle unload, and release idempotently', async () => {
  const { server, one, launch, children } = setup('normal', { idleMs: 40 })
  const [first, second] = await Promise.all([server.acquire(one.id), server.acquire(one.id)])
  expect(first.baseUrl).toBe(second.baseUrl)
  expect(first.key).toBe(second.key)
  expect(launch).toHaveBeenCalledTimes(1)
  first.release(); first.release()
  await pause(100)
  expect(server.loaded()?.model).toBe(one.id)
  second.release()
  await vi.waitFor(() => { expect(server.loaded()).toBeUndefined(); expect(exited(children[0]!)).toBe(true) })
})

test('switching models waits for the old lease, closes its process, and rotates authentication', async () => {
  const { server, one, two, launch, children } = setup()
  const first = await server.acquire(one.id)
  let switched = false
  const next = server.acquire(two.id).then((lease) => { switched = true; return lease })
  await pause(50)
  expect(switched).toBe(false)
  expect(launch).toHaveBeenCalledTimes(1)
  first.release()
  const second = await next
  expect(exited(children[0]!)).toBe(true)
  expect(server.loaded()?.model).toBe(two.id)
  expect(second.key).not.toBe(first.key)
  expect((await fetch(`${second.baseUrl}/models`, { headers: { authorization: `Bearer ${first.key}` } })).status).toBe(401)
  second.release()
})

test('aborting a waiting model switch preserves the active lease and leaves the queue usable', async () => {
  const { server, one, two, launch } = setup()
  const first = await server.acquire(one.id)
  const controller = new AbortController()
  const next = server.acquire(two.id, controller.signal)
  const rejected = expect(next).rejects.toThrow('cancel switch')
  await pause(20)
  controller.abort(new Error('cancel switch'))
  await rejected
  expect(server.loaded()?.model).toBe(one.id)
  expect(launch).toHaveBeenCalledTimes(1)
  first.release()
  const second = await server.acquire(two.id)
  second.release()
})

test('pre-aborted requests skip runtime preparation; abort during startup closes the child', async () => {
  const { server, one, runtime, children, starts } = setup('hang')
  await expect(server.ensure(one.id, AbortSignal.abort(new Error('already cancelled')))).rejects.toThrow('already cancelled')
  expect(runtime).not.toHaveBeenCalled()
  const controller = new AbortController()
  const pending = server.ensure(one.id, controller.signal)
  const rejected = expect(pending).rejects.toThrow('cancel startup')
  await vi.waitFor(() => expect(starts()).toHaveLength(1))
  controller.abort(new Error('cancel startup'))
  await rejected
  expect(server.loaded()).toBeUndefined()
  expect(exited(children[0]!)).toBe(true)
})

test.each([['exit', /fixture load failed/], ['wrong', /identity check failed/], ['hang', /timeout/i]] as const)('startup %s fails without leaving a loaded process', async (mode, message) => {
  const { server, one, children } = setup(mode, { startTimeoutMs: mode === 'hang' ? 500 : 5000 })
  await expect(server.ensure(one.id)).rejects.toThrow(message)
  expect(server.loaded()).toBeUndefined()
  expect(children).toHaveLength(1)
  expect(exited(children[0]!)).toBe(true)
})

test('runtime preparation failure can be retried', async () => {
  const { server, one, runtime, launch } = setup()
  runtime.mockRejectedValueOnce(new Error('runtime unavailable'))
  await expect(server.ensure(one.id)).rejects.toThrow('runtime unavailable')
  expect(launch).not.toHaveBeenCalled()
  expect(server.loaded()).toBeUndefined()
  await server.ensure(one.id)
  expect(server.loaded()?.model).toBe(one.id)
})

test('shutdown cancels a queued switch, closes stdin despite active leases, and supports restart', async () => {
  const { dir, server, one, two, children } = setup()
  const lease = await server.acquire(one.id)
  const next = server.acquire(two.id)
  const rejected = expect(next).rejects.toThrow('runner stopped')
  await Promise.all([server.stop(), server.stop(), rejected])
  expect(server.loaded()).toBeUndefined()
  expect(exited(children[0]!)).toBe(true)
  expect(children[0]!.exitCode).toBe(0)
  expect(readFileSync(join(dir, 'exits'), 'utf8')).toContain(String(children[0]!.pid))
  lease.release()
  await server.ensure(two.id)
  expect(server.loaded()?.model).toBe(two.id)
})

test('shutdown interrupts a bridge still waiting to become ready', async () => {
  const { server, one, starts, children } = setup('hang')
  const pending = server.ensure(one.id)
  const rejected = expect(pending).rejects.toThrow('runner stopped')
  await vi.waitFor(() => expect(starts()).toHaveLength(1))
  await Promise.all([server.stop(), rejected])
  expect(server.loaded()).toBeUndefined()
  expect(exited(children[0]!)).toBe(true)
})

test('unexpected model code is rejected before a child starts', async () => {
  const { dir, server, one, launch } = setup()
  writeFileSync(join(dir, 'models', 'one', 'custom_model.py'), 'raise Exception("must not execute")')
  await expect(server.ensure(one.id)).rejects.toThrow('Unexpected file')
  expect(launch).not.toHaveBeenCalled()
})
