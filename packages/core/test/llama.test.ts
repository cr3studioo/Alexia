// SPDX-License-Identifier: AGPL-3.0-only
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, test } from 'vitest'
import { remember, type Installed } from '../src/installed.js'
import { ensureRuntime, extractRuntimeArchive, LlamaServer, llamaOptimizationArgs, llamaProvider, RUNTIME_ASSETS, RUNTIME_VERSION, runtimeReady, type LlamaServerOptions, type Runtime } from '../src/llama.js'
import { importGguf } from '../src/importModel.js'
import { gguf, splitFiles } from './fixtures/gguf.js'
import { chat } from '../src/provider.js'
import { memorySecrets } from '../src/secrets.js'

const dirs: string[] = []
const owned: LlamaServer[] = []
const children: ReturnType<typeof spawn>[] = []
const releases: (() => void)[] = []
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check: () => boolean | Promise<boolean>, ms = 15000): Promise<void> {
  const end = Date.now() + ms
  while (!await check()) {
    if (Date.now() > end) throw new Error('Condition did not arrive before its deadline.')
    await pause(10)
  }
}
const temp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'alexia-llama-test-')))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await until(() => child.exitCode !== null || child.signalCode !== null)
  }
  for (const server of owned.splice(0)) await server.stop()
  for (const dir of dirs.splice(0)) {
    const folder = join(dir, 'runtime')
    await until(() => !existsSync(folder) || readdirSync(folder).every((name) => !name.startsWith('.llama-session')))
    rmSync(dir, { recursive: true, force: true })
  }
})
interface TarItem { name: string; body?: string; type?: string; link?: string }
function tar(items: TarItem[]): Buffer {
  const blocks: Buffer[] = []
  for (const item of items) {
    const h = Buffer.alloc(512)
    h.write(item.name, 0, 100)
    h.write('0000700\0', 100)
    h.write('0000000\0', 108)
    h.write('0000000\0', 116)
    const data = Buffer.from(item.body ?? '')
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124)
    h.write('00000000000\0', 136)
    h.fill(32, 148, 156)
    h.write(item.type ?? '0', 156)
    if (item.link) h.write(item.link, 157, 100)
    h.write('ustar\0', 257)
    const checksum = h.reduce((total, byte) => total + byte, 0)
    h.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(h, data, Buffer.alloc((512 - data.length % 512) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}
const hash = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
function zip(name: string, mode = 0o100700): Buffer {
  // Standard CRC32 check vector, stored without compression.
  const data = Buffer.from('123456789'), filename = Buffer.from(name)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4)
  local.writeUInt32LE(0xcbf43926, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(filename.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6)
  central.writeUInt32LE(0xcbf43926, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(filename.length, 28); central.writeUInt32LE((mode << 16) >>> 0, 38)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + filename.length, 12); end.writeUInt32LE(local.length + filename.length + data.length, 16)
  return Buffer.concat([local, filename, data, central, filename, end])
}
function receipt(dir: string, version = RUNTIME_VERSION): string {
  const folder = join(dir, 'runtime', 'llama.cpp', version)
  mkdirSync(folder, { recursive: true })
  const name = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  const bin = Buffer.from('fixture bytes, never executed')
  writeFileSync(join(folder, name), bin, { mode: 0o700 })
  const host = `${process.platform}-${process.arch}` as keyof typeof RUNTIME_ASSETS
  writeFileSync(join(folder, 'receipt.json'), JSON.stringify({ version, platform: host, sha256: RUNTIME_ASSETS[host].sha256, executable: name, macPolicy: 'development', files: { [name]: hash(bin) } }))
  return folder
}

describe('pinned runtime and extraction', () => {
  test('runtime readiness selects the current version and leaves older installations intact', () => {
    const dir = temp(), old = receipt(dir, 'b11145')
    expect(runtimeReady(dir)).toBeUndefined()
    const current = receipt(dir)
    expect(runtimeReady(dir)?.executable.startsWith(current)).toBe(true)
    expect(existsSync(join(old, 'receipt.json'))).toBe(true)
    expect(readdirSync(join(dir, 'runtime', 'llama.cpp')).sort()).toEqual(['b11145', RUNTIME_VERSION].sort())
  })
  test('missing, corrupt, changed, symlinked, or extra runtime files are not ready', () => {
    const dir = temp()
    expect(runtimeReady(dir)).toBeUndefined()
    const folder = receipt(dir)
    expect(runtimeReady(dir)).toMatchObject({ version: RUNTIME_VERSION, macPolicy: 'development' })
    writeFileSync(join(folder, 'unexpected-library'), 'not in the verified archive')
    expect(runtimeReady(dir)).toBeUndefined()
    rmSync(join(folder, 'unexpected-library'))
    const executable = runtimeReady(dir)!.executable
    writeFileSync(executable, 'changed')
    expect(runtimeReady(dir)).toBeUndefined()
    rmSync(folder, { recursive: true })
    receipt(dir)
    if (process.platform !== 'win32') {
      rmSync(executable)
      const outside = join(dir, 'outside')
      writeFileSync(outside, 'fixture bytes, never executed', { mode: 0o700 })
      symlinkSync(outside, executable)
      expect(runtimeReady(dir)).toBeUndefined()
    }
  })
  test('tar libraries retain bytes through safe internal link chains', () => {
    const dir = temp(), to = join(dir, 'payload')
    const files = extractRuntimeArchive(tar([
      { name: 'runner/', type: '5' }, { name: 'runner/llama-server', body: 'server' },
      { name: 'runner/lib.1.dylib', body: 'library' },
      { name: 'runner/lib.0.dylib', type: '2', link: 'lib.1.dylib' },
      { name: 'runner/lib.dylib', type: '2', link: 'lib.0.dylib' },
    ]), 'tar.gz', to)
    expect(readFileSync(join(to, 'runner/lib.dylib'), 'utf8')).toBe('library')
    expect(statSync(join(to, 'runner/lib.dylib')).isFile()).toBe(true)
    expect(files['runner/lib.dylib']).toBe(hash(Buffer.from('library')))
  })
  test.each(['../outside', '/outside', 'C:/outside', 'runner/../outside', 'runner\\outside', 'CON', 'runner/file.', '__proto__'])('rejects archive path %s', (name) => {
    const dir = temp()
    expect(() => extractRuntimeArchive(tar([{ name, body: 'bad' }]), 'tar.gz', join(dir, 'payload'))).toThrow(/Unsafe/)
    expect(existsSync(join(dir, 'payload'))).toBe(false)
  })
  test.each(['/absolute', '../../escape'])('rejects escaping link %s', (link) => {
    const dir = temp()
    expect(() => extractRuntimeArchive(tar([{ name: 'runner/link', type: '2', link }]), 'tar.gz', join(dir, 'payload'))).toThrow(/Unsafe/)
  })
  test('rejects duplicate entries, case collisions, devices and cyclic links', () => {
    for (const items of [
      [{ name: 'x', body: 'a' }, { name: 'x', body: 'b' }],
      [{ name: 'X', body: 'a' }, { name: 'x', body: 'b' }],
      [{ name: 'device', type: '3' }],
      [{ name: 'a', type: '2', link: 'b' }, { name: 'b', type: '2', link: 'a' }],
    ]) expect(() => extractRuntimeArchive(tar(items), 'tar.gz', join(temp(), 'payload'))).toThrow()
  })
  test('rejects corrupt/truncated archives and canceled extraction', () => {
    expect(() => extractRuntimeArchive(Buffer.from('bad'), 'zip', join(temp(), 'payload'))).toThrow()
    expect(() => extractRuntimeArchive(Buffer.alloc(70000), 'zip', join(temp(), 'payload'))).toThrow()
    expect(() => extractRuntimeArchive(gzipSync(Buffer.alloc(10)), 'tar.gz', join(temp(), 'payload'))).toThrow()
    expect(() => extractRuntimeArchive(tar([{ name: 'x' }]), 'tar.gz', join(temp(), 'payload'), AbortSignal.abort())).toThrow()
  })
  test('ZIP validates central/local headers, regular files and CRC before writing', () => {
    const to = join(temp(), 'payload')
    extractRuntimeArchive(zip('runner/llama-server.exe'), 'zip', to)
    expect(readFileSync(join(to, 'runner/llama-server.exe'), 'utf8')).toBe('123456789')
    expect(() => extractRuntimeArchive(zip('../outside'), 'zip', join(temp(), 'payload'))).toThrow(/Unsafe/)
    expect(() => extractRuntimeArchive(zip('link', 0o120700), 'zip', join(temp(), 'payload'))).toThrow(/special file/)
    const corrupted = zip('file')
    corrupted[34] = 0
    expect(() => extractRuntimeArchive(corrupted, 'zip', join(temp(), 'payload'))).toThrow(/checksum/)
    const encrypted = zip('file')
    encrypted.writeUInt16LE(1, 6)
    expect(() => extractRuntimeArchive(encrypted, 'zip', join(temp(), 'payload'))).toThrow(/headers/)
  })
  test('download failure/cancellation never commits a runtime; retry can run', async () => {
    const dir = temp()
    let attempts = 0
    const fakeFetch: typeof fetch = async () => { attempts++; return new Response('missing', { status: 404 }) }
    for (let i = 0; i < 2; i++) await expect(ensureRuntime(dir, { fetch: fakeFetch })).rejects.toThrow()
    expect(attempts).toBe(2)
    expect(runtimeReady(dir)).toBeUndefined()
    expect(readdirSync(join(dir, 'runtime', 'llama.cpp'))).toEqual([])
    await expect(ensureRuntime(dir, { signal: AbortSignal.abort(), fetch: fakeFetch })).rejects.toThrow()
    expect(attempts).toBe(2)
  })
  const upstream = process.env.ALEXIA_LLAMA_ARCHIVE
  test.skipIf(!upstream)('installs real pinned upstream archive with default policy, checks signature, and reuses it', async () => {
    const archive = readFileSync(upstream!)
    const dir = temp()
    const old = receipt(dir, 'b11145')
    const host = `${process.platform}-${process.arch}` as keyof typeof RUNTIME_ASSETS
    expect(hash(archive)).toBe(RUNTIME_ASSETS[host].sha256)
    let calls = 0
    const fakeFetch: typeof fetch = async (url) => {
      expect(String(url)).toBe(`https://github.com/ggml-org/llama.cpp/releases/download/${RUNTIME_VERSION}/${RUNTIME_ASSETS[host].name}`)
      calls++
      return new Response(archive, { headers: { 'content-length': String(archive.length) } })
    }
    const progress: number[] = []
    const ready = await ensureRuntime(dir, { fetch: fakeFetch, onProgress: (p) => progress.push(p.done) })
    expect(existsSync(join(old, 'receipt.json'))).toBe(true)
    expect(ready.executable).toContain(join('runtime', 'llama.cpp', RUNTIME_VERSION))
    expect(ready.macPolicy).toBe('development')
    expect(runtimeReady(dir)).toEqual(ready)
    // First execution of a freshly extracted macOS binary can include an OS trust check.
    const version = spawnSync(ready.executable, ['--version'], { timeout: 60000, encoding: 'utf8' })
    expect(version.status, version.stderr).toBe(0)
    expect(version.stdout + version.stderr).toMatch(/11146/)
    expect(progress.at(-1)).toBe(archive.length)
    expect((await ensureRuntime(dir, { fetch: fakeFetch })).executable).toBe(ready.executable)
    expect(calls).toBe(1)
  }, 90000)
})

function record(dir: string, id: string): Installed {
  const file = join(dir, `${basename(id)}.gguf`)
  writeFileSync(file, 'fixture')
  const model: Installed = { id, name: id, repo: 'test/model', revision: 'pinned', quant: 'Q4_K_M', files: [file], bytes: 7, context: 4096, tools: true, vision: false, abliterated: false, nsfwOk: 'no', vetted: true, installedAt: Date.now() }
  remember(dir, model)
  return model
}
function runner(dir: string, mode = 'normal'): string {
  const file = join(dir, 'fixture-runner.cjs')
  writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs'), http = require('node:http');
const args = process.argv.slice(2), arg = name => args[args.indexOf(name) + 1];
const folder = ${JSON.stringify(dir)}, mode = ${JSON.stringify(mode)};
const key = fs.readFileSync(arg('--api-key-file'), 'utf8').trim(), model = arg('--alias');
fs.appendFileSync(folder + '/starts', JSON.stringify({pid:process.pid,model,args,keyMode:fs.statSync(arg('--api-key-file')).mode & 511}) + '\\n');
if (mode === 'exit') { process.stderr.write('x'.repeat(12000) + ' missing library Bearer ' + key); process.exit(7); }
const server = http.createServer((req,res) => {
  if (mode === 'hang') return;
  res.setHeader('content-type','application/json');
  if (req.url === '/v1/health') { res.end(JSON.stringify({status:'ok'})); return; }
  if(req.headers.authorization !== 'Bearer ' + key) { res.statusCode=401;res.end('{}');return; }
  if(req.url === '/v1/models') { res.end(JSON.stringify({data:[{id:mode==='wrong'?'somebody-else':model}]}));return; }
  if(req.url === '/v1/chat/completions') {
    fs.writeFileSync(folder + '/chat', 'active');
    req.resume();
    res.setHeader('content-type','text/event-stream');
    res.write('data: ' + JSON.stringify({choices:[{delta:{role:'assistant',content:'ready'},finish_reason:null}]}) + '\\n\\n');
    setTimeout(() => res.end('data: ' + JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}}) + '\\n\\ndata: [DONE]\\n\\n'),150);
    return;
  }
  res.statusCode=404;res.end('{}');
});
server.listen(Number(arg('--port')),arg('--host'));
process.on('SIGTERM',()=> { fs.appendFileSync(folder + '/exits',model+'\\n');server.closeAllConnections();server.close(()=>process.exit(0)); });
`)
  chmodSync(file, 0o700)
  return file
}
function setup(mode = 'normal', options: Partial<LlamaServerOptions> = {}): { dir: string; server: LlamaServer; executable: string } {
  const dir = temp()
  record(dir, 'llama/one'); record(dir, 'llama/two')
  const executable = runner(dir, mode)
  const server = new LlamaServer({ dataDir: dir, runtime: async () => ({ version: 'fixture', platform: `${process.platform}-${process.arch}`, executable, sha256: '', macPolicy: 'development' } as Runtime), pressure: async () => 'normal', healthMs: 10000, pollMs: 10, stopMs: 100, ...options })
  owned.push(server)
  return { dir, server, executable }
}
function starts(dir: string): { pid: number; model: string; args: string[]; keyMode: number }[] {
  return existsSync(join(dir, 'starts')) ? readFileSync(join(dir, 'starts'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
}
// The executable fixture uses a native shebang; Windows still exercises archive validation.
describe.skipIf(process.platform === 'win32')('owned guardian lifecycle', () => {
  test.each(['copy', 'reference'] as const)('launches single and split %s imports using their full identity; rejects later-shard tampering', async (mode) => {
    const { dir, server } = setup()
    for (const split of [false, true]) {
      const input = temp(), single = join(input, 'single.gguf')
      writeFileSync(single, gguf())
      const paths = split ? splitFiles(input) : [single]
      const model = await importGguf(paths.at(-1)!, dir, { mode })
      remember(dir, model)
      await server.ensure(model.id)
      expect(starts(dir).at(-1)?.args).toContain(model.files[0])
      await server.stop()
      const path = model.files.at(-1)!, bytes = readFileSync(path)
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1
      writeFileSync(path, bytes)
      const count = starts(dir).length
      await expect(server.ensure(model.id)).rejects.toThrow(/changed after import/)
      expect(starts(dir)).toHaveLength(count)
    }
  })
  test('rejects incomplete, reordered and malformed imported groups before spawning', async () => {
    const { dir, server } = setup(), paths = splitFiles(temp())
    const model = await importGguf(paths[0]!, dir, { mode: 'reference' })
    for (const files of [[paths[0]!], [...paths].reverse()]) {
      remember(dir, { ...model, files })
      await expect(server.ensure(model.id)).rejects.toThrow(/changed after import/)
    }
    remember(dir, model)
    writeFileSync(paths[0]!, 'malformed')
    await expect(server.ensure(model.id)).rejects.toThrow(/GGUF/)
    expect(starts(dir)).toHaveLength(0)
  })
  test('a model with its projector on disk is started able to see; without it, as text only', async () => {
    const { dir, server } = setup(), projector = join(temp(), 'mmproj.gguf')
    writeFileSync(projector, gguf())
    const model = { ...record(dir, 'llama/seeing'), projector }
    remember(dir, model)
    await server.ensure(model.id)
    expect(starts(dir)[0]?.args).toEqual(expect.arrayContaining(['--mmproj', projector]))
    await server.stop()
  })
  test('verifies imported draft bytes before launching the target', async () => {
    const { dir, server } = setup(), path = join(temp(), 'draft.gguf')
    writeFileSync(path, gguf())
    const draft = { ...await importGguf(path, dir, { mode: 'reference' }), ready: true }
    remember(dir, draft)
    const model = { ...record(dir, 'llama/target'), params: 1, architecture: draft.architecture, tokenizerFingerprint: draft.tokenizerFingerprint, draftModelId: draft.id }
    remember(dir, model)
    await server.ensure(model.id)
    expect(starts(dir)[0]?.args).toEqual(expect.arrayContaining(['--spec-type', 'draft-simple', '--spec-draft-model', path]))
    await server.stop()
    const bytes = readFileSync(path); bytes[bytes.length - 1] = 99; writeFileSync(path, bytes)
    await expect(server.ensure(model.id)).rejects.toThrow(/changed after import/)
    expect(starts(dir)).toHaveLength(1)
  })
  test('constructor reuse and concurrent ensure start exactly one authenticated loopback runner', async () => {
    const { dir, server } = setup()
    expect(new LlamaServer({ dataDir: dir })).toBe(server)
    expect(server.loaded()).toBeUndefined()
    const [a, b] = await Promise.all([server.ensure('llama/one'), server.ensure('llama/one')])
    expect(a).toBe(b)
    expect(starts(dir)).toHaveLength(1)
    expect(a).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
    expect((await fetch(`${a}/models`)).status).toBe(401)
    const lease = await server.acquire('llama/one')
    releases.push(lease.release)
    expect((await fetch(`${a}/models`, { headers: { authorization: `Bearer ${lease.key}` } })).status).toBe(200)
    expect(starts(dir)[0]!.keyMode).toBe(0o600)
    expect(starts(dir)[0]!.args).toContain('--api-key-file')
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      const args = starts(dir)[0]!.args
      expect(args[args.indexOf('--device') + 1]).toBe('MTL0')
    }
    expect(llamaProvider(server).idleMs).toBe(180_000)
    expect(starts(dir)[0]!.args).not.toContain(lease.key)
    expect(server.loaded()?.pid).toBe(starts(dir)[0]!.pid)
    lease.release(); lease.release()
    await server.stop(); await server.stop()
    expect(server.loaded()).toBeUndefined()
    expect(readFileSync(join(dir, 'exits'), 'utf8')).toBe('llama/one\n')
    expect(readdirSync(join(dir, 'runtime')).filter((n) => n.startsWith('.llama-session'))).toEqual([])
  })
  test('model swap and idle unload wait for all leases; canceled waiter does not release another lease', async () => {
    const { dir, server } = setup('normal', { idleMs: 20 })
    const first = await server.acquire('llama/one')
    releases.push(first.release)
    const second = await server.acquire('llama/one')
    releases.push(second.release)
    const cancel = new AbortController()
    const pending = server.ensure('llama/two', cancel.signal)
    void pending.catch(() => undefined)
    cancel.abort(new Error('canceled waiter'))
    await expect(pending).rejects.toThrow('canceled waiter')
    const swap = server.ensure('llama/two')
    void swap.catch(() => undefined)
    await pause(50)
    expect(starts(dir)).toHaveLength(1)
    first.release(); first.release()
    await pause(30)
    expect(starts(dir)).toHaveLength(1)
    second.release()
    await swap
    expect(starts(dir).map((s) => s.model)).toEqual(['llama/one', 'llama/two'])
    await until(() => server.loaded() === undefined)
  })
  test('stop waits for active generation and prepare releases the authenticated lease in chat finally', async () => {
    const { dir, server } = setup('normal', { idleMs: 20 })
    const cancel = new AbortController()
    const result = chat(llamaProvider(server), { model: 'llama/one', messages: [{ role: 'user', content: 'hello' }], signal: cancel.signal }, undefined, memorySecrets())
    void result.catch(() => undefined)
    try {
      await until(() => existsSync(join(dir, 'chat')))
      const stopped = server.stop()
      void stopped.catch(() => undefined)
      await pause(40)
      expect(server.loaded()?.model).toBe('llama/one')
      expect((await result).message.content).toBe('ready')
      await stopped
      expect(server.loaded()).toBeUndefined()
    } finally {
      cancel.abort()
      await result.catch(() => undefined)
      await server.stop()
    }
  })
  test('pre-abort and unknown model never launch; health deadline and wrong alias clean up', async () => {
    const { dir, server } = setup()
    await expect(server.ensure('llama/one', AbortSignal.abort(new Error('cancel')))).rejects.toThrow('cancel')
    await expect(server.ensure('missing')).rejects.toThrow('missing')
    expect(starts(dir)).toHaveLength(0)
    for (const mode of ['hang', 'wrong']) {
      const made = setup(mode, { healthMs: 10000 })
      await expect(made.server.ensure('llama/one')).rejects.toThrow()
      await made.server.stop()
      expect(made.server.loaded()).toBeUndefined()
      expect(starts(made.dir)).toHaveLength(1)
      expect(readdirSync(join(made.dir, 'runtime')).filter((n) => n.startsWith('.llama-session'))).toEqual([])
    }
  })
  test('early crash retries twice and includes bounded, redacted diagnostics', async () => {
    const { dir, server } = setup('exit')
    const failure = await server.ensure('llama/one').catch((error: unknown) => error as Error)
    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toContain('missing library Bearer [redacted]')
    expect(message.length).toBeLessThan(9000)
    expect(starts(dir)).toHaveLength(2)
    expect(server.loaded()).toBeUndefined()
  })
  test('cancellation during model startup closes the guardian, cleans secrets, and allows a new start', async () => {
    const { dir, server } = setup('hang', { healthMs: 10000 })
    const cancel = new AbortController()
    const pending = server.ensure('llama/one', cancel.signal)
    void pending.catch(() => undefined)
    try {
      await until(() => starts(dir).length === 1)
      cancel.abort(new Error('startup canceled'))
      await expect(pending).rejects.toThrow('startup canceled')
    } finally {
      cancel.abort()
      await pending.catch(() => undefined)
      await server.stop()
    }
    expect(readdirSync(join(dir, 'runtime')).filter((name) => name.startsWith('.llama-session'))).toEqual([])
    runner(dir)
    await server.ensure('llama/one')
    expect(starts(dir)).toHaveLength(2)
  })
  test('critical pressure interrupts owned generation once and blocks automatic reload of that model', async () => {
    let critical = false, reads = 0
    const { dir, server } = setup('normal', { pressureMs: 20, pressure: async () => { reads++; return critical ? 'critical' : 'normal' } })
    const lease = await server.acquire('llama/one')
    releases.push(lease.release)
    critical = true
    await until(() => server.loaded() === undefined)
    lease.release()
    for (let i = 0; i < 3; i++) await expect(server.ensure('llama/one')).rejects.toThrow(/smaller model/)
    expect(starts(dir)).toHaveLength(1)
    await expect(server.ensure('llama/two')).rejects.toThrow(/still critical/)
    const atStop = reads
    await pause(60)
    expect(reads).toBe(atStop)
    critical = false
    await server.ensure('llama/two')
    expect(starts(dir).map((s) => s.model)).toEqual(['llama/one', 'llama/two'])
  })
  test('SIGKILL of core makes guardian stop its real child; next owner starts without PID recovery', async () => {
    const { dir, executable } = setup()
    const source = pathToFileURL(resolve('packages/core/src/llama.ts')).href
    const script = `import {LlamaServer} from ${JSON.stringify(source)};const s=new LlamaServer({dataDir:${JSON.stringify(dir)},runtime:async()=>({version:'fixture',executable:${JSON.stringify(executable)}}),healthMs:10000,stopMs:100,pollMs:10});await s.ensure('llama/one');console.log('READY');setInterval(()=>{},1000);`
    const parent = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(parent)
    let output = '', errors = ''
    parent.stdout.on('data', (b: Buffer) => { output += b.toString() })
    parent.stderr.on('data', (b: Buffer) => { errors += b.toString() })
    await until(() => { if (parent.exitCode !== null) throw new Error(errors); return output.includes('READY') })
    const initial = starts(dir)[0]!
    // An unrelated process is alive throughout: no persisted PID is adopted or killed.
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
    children.push(unrelated)
    parent.kill('SIGKILL')
    await until(() => existsSync(join(dir, 'exits')))
    await until(() => readdirSync(join(dir, 'runtime')).every((name) => !name.startsWith('.llama-session')))
    expect(unrelated.exitCode).toBeNull()
    const next = new LlamaServer({ dataDir: dir })
    await next.ensure('llama/two')
    expect(starts(dir)).toHaveLength(2)
    expect(starts(dir)[1]!.pid).not.toBe(initial.pid)
    await next.stop()
  })
  test('crashed installer leaves no persistent lock; next installer retries', async () => {
    const dir = temp(), source = pathToFileURL(resolve('packages/core/src/llama.ts')).href
    const script = `import {ensureRuntime} from ${JSON.stringify(source)};await ensureRuntime(${JSON.stringify(dir)},{fetch:async()=>{console.log('DOWNLOADING');return await new Promise(()=>{})}});`
    const parent = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(parent)
    let output = ''
    parent.stdout.on('data', (b: Buffer) => { output += b.toString() })
    await until(() => output.includes('DOWNLOADING'))
    const exit = new Promise<void>((resolve) => parent.once('exit', () => resolve()))
    parent.kill('SIGKILL'); await exit
    let fetched = false
    await expect(ensureRuntime(dir, { fetch: async () => { fetched = true; return new Response('missing', { status: 404 }) } })).rejects.toThrow()
    expect(fetched).toBe(true)
    expect(runtimeReady(dir)).toBeUndefined()
  })
})

describe('pinned b11146 optimization flags', () => {
  test.each(['f16', 'q8_0', 'q4_0'] as const)('sets both %s caches and flash attention for quantized V', (kvCache) => {
    const model = { ...record(temp(), 'llama/target'), kvCache }
    expect(llamaOptimizationArgs(model, [])).toEqual(['--cache-type-k', kvCache, '--cache-type-v', kvCache, ...(kvCache === 'f16' ? [] : ['--flash-attn', 'on'])])
  })
  test('rejects unsupported formats and arbitrary KV arguments', () => {
    const model = record(temp(), 'llama/target')
    expect(() => llamaOptimizationArgs({ ...model, format: 'mlx' }, [])).toThrow(/GGUF/)
    expect(() => llamaOptimizationArgs({ ...model, kvCache: 'q2_k' as 'f16' }, [])).toThrow(/KV-cache/)
  })
  function pair(): [Installed, Installed] {
    const dir = temp(), shared = { architecture: 'llama', tokenizerFingerprint: 'a'.repeat(64), contextMax: 8192 }
    return [{ ...record(dir, 'llama/target'), ...shared, params: 8, draftModelId: 'llama/draft', kvCache: 'q4_0' }, { ...record(dir, 'llama/draft'), ...shared, params: 1 }]
  }
  test('uses canonical draft-simple flags with CPU draft and explicit f16 draft cache', () => {
    const [model, draft] = pair()
    expect(llamaOptimizationArgs(model, [model, draft])).toEqual([
      '--cache-type-k', 'q4_0', '--cache-type-v', 'q4_0', '--flash-attn', 'on',
      '--spec-type', 'draft-simple', '--spec-draft-model', draft.files[0], '--spec-draft-ngl', '0',
      '--spec-draft-device', 'none', '--spec-draft-type-k', 'f16', '--spec-draft-type-v', 'f16',
    ])
  })
  test.each<Partial<Installed>>([
    { ready: false }, { format: 'mlx' }, { architecture: undefined }, { architecture: 'qwen2' },
    { tokenizerFingerprint: undefined }, { tokenizerFingerprint: 'b'.repeat(64) },
    { params: 8 }, { params: 0 }, { params: NaN }, { params: undefined },
    { draftModelId: 'nested' }, { files: [] }, { files: ['/nonexistent-draft.gguf'] },
    { contextMax: 1024 }, { contextMax: NaN },
  ])('rejects incompatible draft %j', (changes) => {
    const [model, draft] = pair()
    expect(() => llamaOptimizationArgs(model, [{ ...draft, ...changes }])).toThrow(/Unsupported draft/)
  })
  test('rejects missing/self drafts and targets without architecture/tokenizer evidence', () => {
    const [model, draft] = pair()
    expect(() => llamaOptimizationArgs(model, [])).toThrow(/Unsupported draft/)
    expect(() => llamaOptimizationArgs({ ...model, draftModelId: model.id }, [model])).toThrow(/Unsupported draft/)
    for (const changes of [{ architecture: undefined }, { tokenizerFingerprint: undefined }, { params: undefined }]) {
      expect(() => llamaOptimizationArgs({ ...model, ...changes }, [draft])).toThrow(/Unsupported draft/)
    }
  })
})
