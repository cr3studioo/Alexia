// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { download, sha256Of, type DownloadProgress } from './download.js'
import { extractRuntimeArchive } from './llama.js'
import { MLX_PYTHON_DOWNLOADS, MLX_WHEEL_LOCK } from './mlxRuntimeLock.js'
import { MLX_BRIDGE } from './mlxBridge.js'
import { assertMlxConfig, mlxSafeFile } from './mlxHf.js'
import { readInstalled } from './installed.js'
import { memoryPressure } from './system.js'
import type { Provider } from './provider.js'

const exec = promisify(execFile)
export const MLX_VERSION = 'mlx-lm-0.31.3'
const asset = MLX_PYTHON_DOWNLOADS['cpython-3.12.14-darwin-aarch64-none']!
const lockHash = createHash('sha256').update(MLX_WHEEL_LOCK).digest('hex')
const base = (dir: string): string => join(existsSync(dir) ? realpathSync(dir) : resolve(dir), 'runtime', 'mlx', MLX_VERSION)
const pythonRelative = 'python/bin/python3.12'
export const mlxSupported = (os: string = process.platform, cpu: string = process.arch): boolean => os === 'darwin' && cpu === 'arm64'
export interface MlxOptions { download?: boolean; signal?: AbortSignal; fetch?: typeof fetch; onProgress?: (p: DownloadProgress) => void }
export interface MlxRuntime { version: string; executable: string }
interface Receipt { version: string; pythonSha256: string; lock: string; files: Record<string, string> }
const installs = new Map<string, Promise<MlxRuntime>>()

function receipt(dir: string): Receipt | undefined {
  try {
    const root = base(dir), path = join(root, 'receipt.json')
    if (lstatSync(root).isSymbolicLink() || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) return undefined
    const r = JSON.parse(readFileSync(path, 'utf8')) as Receipt
    if (r.version !== MLX_VERSION || r.pythonSha256 !== asset.sha256 || r.lock !== lockHash || !r.files?.[pythonRelative]) return undefined
    return r
  } catch { return undefined }
}
/** Lightweight display check; ensureMlxRuntime verifies the complete receipt before execution. */
export function mlxRuntimeReady(dir: string): MlxRuntime | undefined {
  if (!mlxSupported() || !receipt(dir) || !existsSync(join(base(dir), pythonRelative))) return undefined
  return { version: MLX_VERSION, executable: join(base(dir), pythonRelative) }
}
function inventory(root: string): string[] {
  const paths: string[] = []
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === '__pycache__') continue
      const path = join(folder, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) { if (relative(root, path) !== 'receipt.json') paths.push(relative(root, path)) }
      else throw new Error('MLX runtime contains a symbolic link or special file.')
    }
  }
  walk(root)
  return paths.sort()
}
async function verifyRuntime(dir: string, signal?: AbortSignal): Promise<MlxRuntime | undefined> {
  const r = receipt(dir)
  if (!r) return undefined
  const root = base(dir), files = inventory(root)
  if (files.length !== Object.keys(r.files).length) throw new Error('MLX runtime files changed. Reinstall the runtime before using it.')
  for (const file of files) if (await sha256Of(join(root, file), signal) !== r.files[file]) throw new Error('MLX runtime checksum changed. Reinstall the runtime before using it.')
  return { version: MLX_VERSION, executable: join(root, pythonRelative) }
}

/** Pinned CPython and hash-locked wheels; nothing is installed in the user's Python. */
export async function ensureMlxRuntime(dir: string, options: MlxOptions = {}): Promise<MlxRuntime> {
  if (!mlxSupported()) throw new Error('The MLX runtime currently supports Apple Silicon Macs only.')
  options.signal?.throwIfAborted()
  const target = base(dir)
  const existing = installs.get(target)
  if (existing) return signalWait(existing, options.signal)
  const job = (async () => {
    const ready = await verifyRuntime(dir, options.signal)
    if (ready) return ready
    if (options.download === false) throw new Error('The MLX runtime is not installed. Retry its installation in Local models.')
    return installMlx(dir, options)
  })()
  installs.set(target, job)
  try { return await job } finally { if (installs.get(target) === job) installs.delete(target) }
}
async function installMlx(dir: string, options: MlxOptions): Promise<MlxRuntime> {
  const target = base(dir), parent = dirname(target)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  if (existsSync(target)) throw new Error('An incomplete MLX runtime exists. Move it aside before retrying.')
  const stage = mkdtempSync(join(parent, '.mlx-'))
  try {
    const archive = join(stage, 'python.tar.gz')
    await download(asset.url, archive, { sha256: asset.sha256, minFreeBytes: 2 * 1024 ** 3, ...options })
    options.signal?.throwIfAborted()
    const payload = join(stage, 'payload')
    const files = extractRuntimeArchive(readFileSync(archive), 'tar.gz', payload, options.signal)
    if (!files[pythonRelative]) throw new Error('The pinned Python archive did not contain its expected interpreter.')
    const executable = join(payload, pythonRelative)
    chmodSync(executable, 0o700)
    await exec('/usr/bin/codesign', ['--verify', '--strict', executable], { timeout: 15_000, signal: options.signal })
    const requirements = join(stage, 'requirements.txt')
    writeFileSync(requirements, MLX_WHEEL_LOCK, { mode: 0o600, flag: 'wx' })
    // Installation reports a named step and an elapsed counter in the UI while pip verifies
    // each package. Disable bytecode so the installed source inventory remains stable.
    await exec(executable, ['-I', '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--no-compile', '--no-cache-dir', '--require-hashes', '--only-binary=:all:', '--index-url', 'https://pypi.org/simple', '-r', requirements], {
      timeout: 20 * 60_000, signal: options.signal, maxBuffer: 16 * 1024 * 1024,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: stage, PIP_CONFIG_FILE: '/dev/null' },
    })
    options.signal?.throwIfAborted()
    const hashes: Record<string, string> = {}
    for (const file of inventory(payload)) hashes[file] = await sha256Of(join(payload, file), options.signal)
    writeFileSync(join(payload, 'receipt.json'), JSON.stringify({ version: MLX_VERSION, lock: lockHash, pythonSha256: asset.sha256, files: hashes } satisfies Receipt), { mode: 0o600, flag: 'wx' })
    if (existsSync(target)) throw new Error('Another process installed the MLX runtime. Retry to use it.')
    renameSync(payload, target)
    return { version: MLX_VERSION, executable: join(target, pythonRelative) }
  } finally { rmSync(stage, { recursive: true, force: true }) }
}

interface Session { model: string; baseUrl: string; since: number; key: string; process: ChildProcess; leases: number; ready: boolean; dead: boolean; exited: Promise<void>; drained?: () => void }
export interface MlxLease { baseUrl: string; key: string; release(): void }
export interface MlxServerOptions {
  dataDir: string; idleMs?: number; startTimeoutMs?: number; stopMs?: number; pressureMs?: number;
  spawn?: typeof spawn; fetch?: typeof fetch; runtime?: typeof ensureMlxRuntime; pressure?: typeof memoryPressure
}
const servers = new Map<string, MlxServer>()
export class MlxServer {
  private session?: Session
  private queue: Promise<unknown> = Promise.resolve()
  private idle?: ReturnType<typeof setTimeout>
  private pressure?: ReturnType<typeof setInterval>
  private readingPressure = false
  private stopping = new AbortController()
  private stopPromise?: Promise<void>
  constructor(private readonly options: MlxServerOptions) {
    const key = existsSync(options.dataDir) ? realpathSync(options.dataDir) : resolve(options.dataDir)
    const old = servers.get(key)
    if (old) return old
    servers.set(key, this)
  }
  loaded(): { model: string; baseUrl: string; since: number; pid?: number } | undefined {
    const s = this.session
    return s?.ready && !s.dead ? { model: s.model, baseUrl: s.baseUrl, since: s.since, ...(s.process.pid && { pid: s.process.pid }) } : undefined
  }
  ensure(id: string, signal?: AbortSignal, options?: { download?: boolean }): Promise<string> { return this.request(id, false, signal, options?.download).then((s) => s.baseUrl) }
  async acquire(id: string, signal?: AbortSignal): Promise<MlxLease> {
    const s = await this.request(id, true, signal)
    let released = false
    return { baseUrl: s.baseUrl, key: s.key, release: () => { if (released) return; released = true; s.leases--; if (!s.leases) { s.drained?.(); s.drained = undefined; this.arm(s) } } }
  }
  private async request(id: string, lease: boolean, signal?: AbortSignal, download?: boolean): Promise<Session> {
    const combined = AbortSignal.any([this.stopping.signal, ...(signal ? [signal] : [])])
    const task = this.queue.then(async () => {
      combined.throwIfAborted()
      let s = this.session
      if (s && (s.dead || s.model !== id)) {
        if (s.leases && !s.dead) await signalWait(new Promise<void>((resolve) => { s!.drained = resolve }), combined)
        await this.terminate(s)
        s = undefined
      }
      if (!s) s = await this.start(id, combined, download)
      combined.throwIfAborted()
      clearTimeout(this.idle)
      if (lease) s.leases++
      else this.arm(s)
      return s
    })
    this.queue = task.catch(() => undefined)
    // Do not race away an acquired lease: the queued operation observes cancellation before
    // incrementing, and acquire always hands its release callback to the caller.
    return task
  }
  private async start(id: string, signal: AbortSignal, download?: boolean): Promise<Session> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.options.startTimeoutMs ?? 180_000)])
    const runtime = await (this.options.runtime ?? ensureMlxRuntime)(this.options.dataDir, { signal: deadline, ...(download !== undefined && { download }) })
    const model = readInstalled(this.options.dataDir).find((one) => one.id === id && one.format === 'mlx')
    if (!model) throw new Error('This MLX model is not installed.')
    const configPath = model.files.find((file) => basename(file) === 'config.json')
    if (!configPath) throw new Error('The installed MLX model has no configuration.')
    const folder = dirname(configPath)
    for (const file of model.files) if (dirname(file) !== folder || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error('MLX model files changed. Reinstall this model.')
    for (const name of readdirSync(folder)) if (!mlxSafeFile(name) || !model.files.includes(join(folder, name))) throw new Error('Unexpected file in the MLX model folder. Reinstall this model.')
    const config = assertMlxConfig(JSON.parse(readFileSync(configPath, 'utf8')))
    if (!Number.isSafeInteger(model.context) || model.context < 256 || model.context > Number(config.max_position_embeddings)) throw new Error('Invalid MLX context setting.')
    const tokenConfig = JSON.parse(readFileSync(join(folder, 'tokenizer_config.json'), 'utf8')) as Record<string, unknown>
    if (tokenConfig.auto_map || tokenConfig.model_file) throw new Error('Custom MLX tokenizer code is unsupported.')
    if (!['f16', 'q8_0', 'q4_0'].includes(model.kvCache ?? 'f16') || model.draftModelId) throw new Error('Unsupported MLX optimization settings.')
    const key = randomBytes(24).toString('hex')
    const child = (this.options.spawn ?? spawn)(runtime.executable, ['-I', '-B', '-u', '-c', MLX_BRIDGE], {
      cwd: base(this.options.dataDir), stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: this.options.dataDir, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false' },
    })
    let ended!: () => void
    const s: Session = { model: id, baseUrl: '', since: Date.now(), key, process: child, leases: 0, ready: false, dead: false, exited: new Promise<void>((resolve) => { ended = resolve }) }
    let failed: Error | undefined, logs = '', stdout = ''
    const dead = (): void => { s.dead = true; s.ready = false; ended(); s.drained?.() }
    child.once('exit', dead)
    child.once('error', (error) => { failed = error; dead() })
    child.stdin?.on('error', () => undefined)
    child.stderr?.on('data', (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-4000) })
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString()).slice(-8000)
      let at: number
      while ((at = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, at); stdout = stdout.slice(at + 1)
        try {
          const message = JSON.parse(line) as { ready?: boolean; port?: number }
          if (message.ready === true && Number.isInteger(message.port) && message.port! > 0 && message.port! <= 65535) s.baseUrl = `http://127.0.0.1:${message.port}/v1`
        } catch { /* libraries may print startup notices */ }
      }
    })
    this.session = s
    child.stdin?.write(JSON.stringify({ path: folder, id, key, context: model.context, kvBits: model.kvCache === 'q8_0' ? 8 : model.kvCache === 'q4_0' ? 4 : null }) + '\n')
    try {
      while (true) {
        deadline.throwIfAborted()
        if (failed || s.dead) throw new Error(`MLX could not start: ${failed?.message ?? logs.slice(-1200)}`)
        if (s.baseUrl) {
          const response = await (this.options.fetch ?? fetch)(`${s.baseUrl.slice(0, -3)}/health`, { headers: { authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.any([deadline, AbortSignal.timeout(2000)]) })
          const health = await response.json() as { status?: string; model?: string }
          if (!response.ok || health.status !== 'ok' || health.model !== id) throw new Error('MLX readiness identity check failed.')
          s.ready = true
          this.watchPressure(s)
          return s
        }
        await signalWait(new Promise<void>((resolve) => setTimeout(resolve, 100)), deadline)
      }
    } catch (error) { await this.terminate(s); throw error }
  }
  private arm(s: Session): void {
    clearTimeout(this.idle)
    if (s.leases || s.dead || this.session !== s) return
    this.idle = setTimeout(() => { void this.terminate(s).catch(() => undefined) }, this.options.idleMs ?? 10 * 60_000)
    this.idle.unref()
  }
  private watchPressure(s: Session): void {
    clearInterval(this.pressure)
    this.pressure = setInterval(() => {
      if (this.readingPressure || this.session !== s || s.dead) return
      this.readingPressure = true
      void (this.options.pressure ?? memoryPressure)().then(async (value) => { if (value === 'critical' && this.session === s) await this.terminate(s) }).catch(() => undefined).finally(() => { this.readingPressure = false })
    }, this.options.pressureMs ?? 30_000)
    this.pressure.unref()
  }
  private async terminate(s: Session): Promise<void> {
    if (this.session === s) { clearTimeout(this.idle); clearInterval(this.pressure) }
    s.ready = false
    if (!s.dead) {
      s.process.stdin?.end()
      const timer = setTimeout(() => { if (!s.dead) s.process.kill('SIGTERM') }, this.options.stopMs ?? 3000)
      const force = setTimeout(() => { if (!s.dead) s.process.kill('SIGKILL') }, (this.options.stopMs ?? 3000) + 2000)
      try { await s.exited } finally { clearTimeout(timer); clearTimeout(force) }
    }
    if (this.session === s) this.session = undefined
  }
  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopping.abort(new Error('MLX runner stopped.'))
    this.stopPromise = (async () => { await this.queue; if (this.session) await this.terminate(this.session) })()
    try { await this.stopPromise } finally { this.stopping = new AbortController(); this.stopPromise = undefined }
  }
}
export const MLX: Provider = { id: 'mlx', name: 'MLX', baseUrl: '', auth: 'none', tools: false, timeoutMs: 180_000, trainsOnYourData: 'no' }
export function mlxProvider(server: MlxServer): Provider { return { ...MLX, prepare: (model, signal) => server.acquire(model, signal) } }
function signalWait<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then((value) => { signal.removeEventListener('abort', abort); resolve(value) }, (error) => { signal.removeEventListener('abort', abort); reject(error) })
  })
}
