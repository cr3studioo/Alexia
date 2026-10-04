// SPDX-License-Identifier: AGPL-3.0-only
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { basename, dirname, join, posix, resolve } from 'node:path'
import { promisify } from 'node:util'
import { gunzipSync, inflateRawSync } from 'node:zlib'
import { download, type DownloadProgress } from './download.js'
import { readGguf } from './gguf.js'
import { readInstalled, LLAMA_ID, type Installed } from './installed.js'
import type { Provider } from './provider.js'
import { memoryPressure } from './system.js'
import { runnerBackendProfile, type BackendOptions, type BackendPreference, type BackendProfile, type RunnerBackend } from './runnerBackend.js'

/** Digests copied from https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/b11146.
 * Source commit: 7fe450e19305b828c199d602c23a8337aaa1f03b. Never resolve "latest" at runtime.
 * Flags: https://github.com/ggml-org/llama.cpp/blob/b11146/tools/server/README.md.
 */
export const RUNTIME_VERSION = 'b11146'
export const RUNTIME_ASSETS = Object.freeze({
  'darwin-arm64': { name: 'llama-b11146-bin-macos-arm64.tar.gz', bytes: 11189714, sha256: '1ad3f9eff80edb9dbef4259ad564d1720612ef7eea48fa4afed0e54f5f3d5711' },
  'darwin-x64': { name: 'llama-b11146-bin-macos-x64.tar.gz', bytes: 11237237, sha256: '305f0e3a17d2c01eb205cd0a62128357f1ec3b55329cb084d94e5ec0115d7a3b' },
  'linux-x64': { name: 'llama-b11146-bin-ubuntu-x64.tar.gz', bytes: 16998357, sha256: 'c150306eb16b5ab696f76a8bdf810c35fd98a24e82158742e6fa28f420ff8410' },
  'win32-x64': { name: 'llama-b11146-bin-win-cpu-x64.zip', bytes: 18560055, sha256: '14cf1303ca9ac3abd94816850532f9f9a69ac66fbaca3776fc6f9061c2fac1d1' },
})
/** Accelerated assets and their mandatory CUDA libraries from the same official release API. */
export const ACCELERATOR_ASSETS = Object.freeze({
  'linux-x64-cuda': {
    name: 'llama-b11146-bin-ubuntu-cuda-12.8-x64.tar.gz', bytes: 168920581, sha256: 'c2ab9e19838513ff69d1af8d999ad717dd3c7ee4714ac04c7ed5ab9077c50e4e',
    companion: { name: 'cudart-llama-b11146-bin-ubuntu-cuda-12.8-x64.tar.gz', bytes: 594373356, sha256: '1466daea60aad1144819e151b2bae19d54556cf1da6c129c4f55a5ded2637c25' },
  },
  'win32-x64-cuda': {
    name: 'llama-b11146-bin-win-cuda-12.4-x64.zip', bytes: 253869799, sha256: '3c806a6ceccc3dae1c743ceb1a1fb2cce5b76f40bfbd4c6b7b8afb6ef45a5807',
    companion: { name: 'cudart-llama-bin-win-cuda-12.4-x64.zip', bytes: 391443627, sha256: '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6' },
  },
  'linux-x64-vulkan': { name: 'llama-b11146-bin-ubuntu-vulkan-x64.tar.gz', bytes: 30598492, sha256: 'd3ce40fce7403cc93bcf5718fc46c6efb61ed9709f8e5d9f10c86bf0e30e8fb3' },
  'win32-x64-vulkan': { name: 'llama-b11146-bin-win-vulkan-x64.zip', bytes: 32127004, sha256: '55a378aa095b466979d85075234f66d7655c7a7483222af0c006c0e55b4d7bd6' },
})
interface Asset { name: string; bytes: number; sha256: string; companion?: { name: string; bytes: number; sha256: string } }
type Platform = keyof typeof RUNTIME_ASSETS
export const runtimeSupported = (os: string = process.platform, arch: string = process.arch): boolean => `${os}-${arch}` in RUNTIME_ASSETS
/** Development accepts existing upstream signatures, including ad hoc; it never signs binaries.
 * Distribution additionally requires Gatekeeper acceptance. Neither policy alters quarantine,
 * disables Gatekeeper, or substitutes an invented Developer ID / notarization claim.
 * A notarized, Developer ID signed distribution must be supplied by the release owner.
 * Default development policy relies on normal OS execution enforcement after signature checks.
 */
export type MacPolicy = 'development' | 'distribution'
export interface RuntimeOptions {
  download?: boolean
  backend?: RunnerBackend
  signal?: AbortSignal
  onProgress?: (progress: DownloadProgress) => void
  macPolicy?: MacPolicy
  fetch?: typeof fetch
}
export interface Runtime {
  backend?: RunnerBackend
  companionSha256?: string
  version: string
  platform: Platform
  executable: string
  sha256: string
  macPolicy: MacPolicy
}
interface Receipt extends Runtime { files: Record<string, string> }
/** Each pin installs beside previous versions; upgrades never replace a loaded binary. */
const root = (dataDir: string, backend: RunnerBackend = defaultBackend()): string => join(existsSync(dataDir) ? realpathSync(dataDir) : resolve(dataDir), 'runtime', 'llama.cpp', backend === defaultBackend() ? RUNTIME_VERSION : `${RUNTIME_VERSION}-${backend}`)
const defaultBackend = (): RunnerBackend => process.platform === 'darwin' && process.arch === 'arm64' ? 'metal' : 'cpu'
function runtimeAsset(backend: RunnerBackend): Asset {
  const host = platform()
  if (backend === 'cpu' || backend === 'metal' && host === 'darwin-arm64') return RUNTIME_ASSETS[host]
  const asset = ACCELERATOR_ASSETS[`${host}-${backend}` as keyof typeof ACCELERATOR_ASSETS]
  if (!asset) throw new Error(`No pinned ${backend} runtime for ${host}.`)
  return asset
}
const platform = (): Platform => {
  const key = `${process.platform}-${process.arch}`
  if (!(key in RUNTIME_ASSETS)) throw new Error(`No pinned llama.cpp runtime for ${key}.`)
  return key as Platform
}
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
const aborted = (signal?: AbortSignal): void => signal?.throwIfAborted()
const runFile = promisify(execFile)
// CUDA runtime libraries plus broad kernel binaries are large; bounded at 2 GiB.
const MAX_EXPANDED = 2 * 1024 * 1024 * 1024
const hasControl = (text: string): boolean => [...text].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)

function safeName(raw: string): string {
  const name = raw.replace(/^\.\//, '').replace(/\/$/, '')
  if (!name || name.startsWith('/') || /[\\:]/.test(name) || hasControl(name) || name.split('/').some((p) => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p) || ['__proto__', 'constructor', 'prototype'].includes(p))) {
    throw new Error(`Unsafe runtime archive path: ${JSON.stringify(raw)}`)
  }
  return name
}
interface Entry { name: string; data?: Buffer; link?: string; directory?: boolean }
const field = (b: Buffer, start: number, len: number): string => b.subarray(start, start + len).toString('utf8').split('\0')[0]!
function octal(b: Buffer, start: number, len: number): number {
  const s = field(b, start, len).trim()
  if (!/^[0-7]+$/.test(s)) throw new Error('Invalid tar numeric field.')
  const n = parseInt(s, 8)
  if (!Number.isSafeInteger(n)) throw new Error('Oversized tar field.')
  return n
}
function tarEntries(archive: Buffer): Entry[] {
  const b = gunzipSync(archive, { maxOutputLength: MAX_EXPANDED })
  const entries: Entry[] = []
  let next: Record<string, string> = {}
  for (let at = 0; at + 512 <= b.length;) {
    const h = b.subarray(at, at + 512)
    if (h.every((x) => x === 0)) return entries
    let checksum = 0
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : h[i]!
    if (checksum !== octal(h, 148, 8)) throw new Error('Invalid tar checksum.')
    const size = octal(h, 124, 12)
    const end = at + 512 + size
    if (end > b.length) throw new Error('Truncated tar archive.')
    const data = b.subarray(at + 512, end)
    at += 512 + Math.ceil(size / 512) * 512
    const type = field(h, 156, 1)
    if (type === 'x') {
      for (let p = 0; p < data.length;) {
        const space = data.indexOf(32, p)
        const length = Number(data.subarray(p, space).toString())
        if (space < p || !Number.isSafeInteger(length) || length <= space - p + 1 || p + length > data.length) throw new Error('Invalid PAX record.')
        const value = data.subarray(space + 1, p + length - 1).toString()
        const eq = value.indexOf('=')
        const key = value.slice(0, eq)
        // Do not silently discard archive security metadata (including quarantine).
        if (!['path', 'linkpath', 'mtime', 'atime', 'ctime'].includes(key)) throw new Error(`Unsupported PAX metadata: ${key}`)
        next[key] = value.slice(eq + 1)
        p += length
      }
      continue
    }
    const prefix = field(h, 345, 155)
    const name = safeName(next.path ?? `${prefix ? prefix + '/' : ''}${field(h, 0, 100)}`)
    const link = next.linkpath ?? field(h, 157, 100)
    next = {}
    if (type === '5') entries.push({ name, directory: true })
    else if (type === '2') {
      if (link.startsWith('/') || /[\\:]/.test(link) || hasControl(link)) throw new Error('Unsafe runtime archive link.')
      entries.push({ name, link: safeName(posix.join(posix.dirname(name), link)) })
    }
    else if (type === '1') entries.push({ name, link: safeName(link) })
    else if (type === '0' || type === '') entries.push({ name, data })
    else throw new Error(`Unsupported tar entry type ${type}.`)
    if (entries.length > 4096) throw new Error('Too many runtime archive entries.')
  }
  throw new Error('Missing tar end marker.')
}
function crc32(b: Buffer): number {
  let crc = 0xffffffff
  for (const byte of b) {
    crc ^= byte
    crc = (crc >>> 8) ^ CRC_TABLE[crc & 255]!
  }
  return (crc ^ 0xffffffff) >>> 0
}
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let crc = n
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  return crc >>> 0
})
function zipEntries(b: Buffer): Entry[] {
  if (b.length < 22) throw new Error('Invalid ZIP end record.')
  let end = b.length - 22
  const lower = Math.max(0, b.length - 65557)
  while (end >= lower && b.readUInt32LE(end) !== 0x06054b50) end--
  if (end < lower || b.readUInt32LE(end) !== 0x06054b50 || end + 22 + b.readUInt16LE(end + 20) !== b.length) throw new Error('Invalid ZIP end record.')
  const count = b.readUInt16LE(end + 10)
  let at = b.readUInt32LE(end + 16)
  if (b.readUInt16LE(end + 4) || b.readUInt16LE(end + 6) || count !== b.readUInt16LE(end + 8) || count > 4096 || at + b.readUInt32LE(end + 12) !== end) throw new Error('Unsupported ZIP layout.')
  const entries: Entry[] = []
  let expanded = 0
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || b.readUInt32LE(at) !== 0x02014b50) throw new Error('Invalid ZIP directory.')
    const flags = b.readUInt16LE(at + 8), method = b.readUInt16LE(at + 10)
    const compressed = b.readUInt32LE(at + 20), size = b.readUInt32LE(at + 24)
    const nl = b.readUInt16LE(at + 28), extra = b.readUInt16LE(at + 30), comment = b.readUInt16LE(at + 32)
    const offset = b.readUInt32LE(at + 42), mode = b.readUInt32LE(at + 38) >>> 16
    const raw = b.subarray(at + 46, at + 46 + nl).toString('utf8')
    const name = safeName(raw)
    if (flags & ~(8 | 2048) || ![0, 8].includes(method) || ((mode & 0xf000) !== 0 && ![0x8000, 0x4000].includes(mode & 0xf000))) throw new Error('Unsupported ZIP encryption, compression or special file.')
    if (offset + 30 > at || b.readUInt32LE(offset) !== 0x04034b50) throw new Error('Invalid ZIP local header.')
    const localNameLen = b.readUInt16LE(offset + 26)
    if (b.subarray(offset + 30, offset + 30 + localNameLen).toString('utf8') !== raw || b.readUInt16LE(offset + 8) !== method || b.readUInt16LE(offset + 6) !== flags) throw new Error('Mismatched ZIP headers.')
    const start = offset + 30 + localNameLen + b.readUInt16LE(offset + 28)
    if (start + compressed > b.readUInt32LE(end + 16) || (expanded += size) > MAX_EXPANDED) throw new Error('Oversized ZIP entry.')
    const data = method === 0 ? b.subarray(start, start + compressed) : inflateRawSync(b.subarray(start, start + compressed), { maxOutputLength: Math.max(1, size) })
    if (data.length !== size || crc32(data) !== b.readUInt32LE(at + 16)) throw new Error('Invalid ZIP file checksum or length.')
    entries.push(raw.endsWith('/') ? { name, directory: true } : { name, data })
    at += 46 + nl + extra + comment
  }
  if (at !== end) throw new Error('Invalid ZIP directory length.')
  return entries
}

/** Deliberately small archive subset, no external extraction command. Links become copies of
 * verified regular entries inside this archive, never filesystem links. Destination must be new.
 * Exported for focused hostile-archive tests; callers install through ensureRuntime.
 */
export function extractRuntimeArchive(archive: Buffer, format: 'tar.gz' | 'zip', destination: string, signal?: AbortSignal): Record<string, string> {
  aborted(signal)
  const entries = format === 'zip' ? zipEntries(archive) : tarEntries(archive)
  const all = new Map<string, Entry>()
  const folded = new Set<string>()
  for (const e of entries) {
    if (folded.has(e.name.toLowerCase()) || all.size > 4096) throw new Error('Duplicate runtime archive entry.')
    folded.add(e.name.toLowerCase())
    all.set(e.name, e)
  }
  const bytes = (e: Entry, seen = new Set<string>()): Buffer => {
    if (seen.has(e.name) || seen.size > 32) throw new Error('Cyclic runtime archive link.')
    seen.add(e.name)
    if (e.data !== undefined) return e.data
    const target = e.link && all.get(e.link)
    if (!target || target.directory) throw new Error('Runtime archive link has no regular target.')
    return bytes(target, seen)
  }
  mkdirSync(destination, { mode: 0o700 })
  const files: Record<string, string> = Object.create(null) as Record<string, string>
  let total = 0
  for (const e of entries) {
    aborted(signal)
    const to = join(destination, ...e.name.split('/'))
    if (e.directory) { mkdirSync(to, { recursive: true, mode: 0o700 }); continue }
    const data = bytes(e)
    if ((total += data.length) > MAX_EXPANDED) throw new Error('Expanded runtime is too large.')
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
    writeFileSync(to, data, { flag: 'wx', mode: 0o700 })
    files[e.name] = sha(data)
  }
  return files
}

function plainFile(base: string, relative: string): boolean {
  const parts = safeName(relative).split('/')
  let path = base
  if (!lstatSync(base).isDirectory() || lstatSync(base).isSymbolicLink()) return false
  for (const [i, part] of parts.entries()) {
    path = join(path, part)
    const st = lstatSync(path)
    if (st.isSymbolicLink() || (i === parts.length - 1 ? !st.isFile() : !st.isDirectory())) return false
  }
  return true
}
export function runtimeReady(dataDir: string, options: Pick<RuntimeOptions, 'backend'> = {}): Runtime | undefined {
  try {
    const backend = options.backend ?? defaultBackend()
    const base = root(dataDir, backend)
    if (!plainFile(base, 'receipt.json')) return undefined
    const r = JSON.parse(readFileSync(join(base, 'receipt.json'), 'utf8')) as Receipt
    const asset = runtimeAsset(backend)
    if ((r.backend ?? defaultBackend()) !== backend || r.companionSha256 !== asset.companion?.sha256) return undefined
    if (r.version !== RUNTIME_VERSION || r.platform !== platform() || r.sha256 !== asset.sha256 || !['development', 'distribution'].includes(r.macPolicy) || !r.files || typeof r.files !== 'object') return undefined
    const executable = safeName(r.executable)
    if (basename(executable) !== (process.platform === 'win32' ? 'llama-server.exe' : 'llama-server') || !r.files[executable]) return undefined
    if (Object.keys(r.files).length > 4096) return undefined
    const inventory = (folder: string, prefix = ''): boolean => readdirSync(folder, { withFileTypes: true }).every((entry) => {
      const name = prefix + entry.name
      return entry.isDirectory() ? inventory(join(folder, entry.name), name + '/') : entry.isFile() && (name === 'receipt.json' || Object.hasOwn(r.files, name))
    })
    if (!inventory(base)) return undefined
    for (const [name, digest] of Object.entries(r.files)) {
      if (!plainFile(base, name) || sha(readFileSync(join(base, name))) !== digest) return undefined
    }
    if (process.platform !== 'win32' && !(lstatSync(join(base, executable)).mode & 0o111)) return undefined
    return { version: r.version, platform: r.platform, sha256: r.sha256, backend, companionSha256: r.companionSha256, macPolicy: r.macPolicy, executable: join(base, executable) }
  } catch { return undefined }
}
async function macCheck(base: string, executable: string, policy: MacPolicy, signal?: AbortSignal): Promise<void> {
  if (process.platform !== 'darwin') return
  const paths: string[] = []
  const walk = (folder: string): void => {
    for (const e of readdirSync(folder, { withFileTypes: true })) {
      const file = join(folder, e.name)
      if (e.isDirectory()) walk(file)
      else if (e.isFile() && (file === executable || e.name.endsWith('.dylib'))) paths.push(file)
    }
  }
  walk(base)
  try {
    for (const file of paths) await runFile('/usr/bin/codesign', ['--verify', '--strict', '--all-architectures', file], { signal, timeout: 15_000 })
    if (policy === 'distribution') await runFile('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', executable], { signal, timeout: 15_000 })
  } catch (error) {
    aborted(signal)
    throw new Error(`macOS rejected the llama.cpp runtime (${policy} policy). Quarantine and Gatekeeper are preserved. ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}
const installs = new Map<string, Promise<Runtime>>()
/** macPolicy defaults to development; distribution adds an explicit Gatekeeper assessment. */
export async function ensureRuntime(dataDir: string, options: RuntimeOptions = {}): Promise<Runtime> {
  aborted(options.signal)
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const base = root(dataDir, options.backend)
  const ready = runtimeReady(dataDir, options)
  if (ready) {
    await macCheck(base, ready.executable, options.macPolicy ?? 'development', options.signal)
    return ready
  }
  if (options.download === false) throw new Error('The selected local runtime is not installed. Retry its installation in Local models.')
  const existing = installs.get(base)
  if (existing) {
    await withSignal(existing, options.signal)
    return ensureRuntime(dataDir, options)
  }
  const install = installRuntime(dataDir, options)
  installs.set(base, install)
  try { return await install } finally { if (installs.get(base) === install) installs.delete(base) }
}
async function installRuntime(dataDir: string, options: RuntimeOptions): Promise<Runtime> {
  const backend = options.backend ?? defaultBackend()
  const base = root(dataDir, backend), host = platform(), asset = runtimeAsset(backend)
  mkdirSync(dirname(base), { recursive: true, mode: 0o700 })
  const lock = await coordination(base, 'install')
  let stage: string | undefined
  try {
    stage = mkdtempSync(join(dirname(base), '.llama-'))
    const archive = join(stage, asset.name)
    await download(`https://github.com/ggml-org/llama.cpp/releases/download/${RUNTIME_VERSION}/${asset.name}`, archive, {
      bytes: asset.bytes, sha256: asset.sha256, minFreeBytes: MAX_EXPANDED,
      ...options, signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(300_000)]),
    })
    aborted(options.signal)
    const payload = join(stage, 'payload')
    const files = extractRuntimeArchive(readFileSync(archive), asset.name.endsWith('.zip') ? 'zip' : 'tar.gz', payload, options.signal)
    const executables = Object.keys(files).filter((p) => basename(p) === (host.startsWith('win32') ? 'llama-server.exe' : 'llama-server'))
    if (executables.length !== 1) throw new Error('Archive must contain exactly one llama-server.')
    const executable = executables[0]!
    chmodSync(join(payload, executable), 0o700)
    const macPolicy = options.macPolicy ?? 'development'
    await macCheck(payload, join(payload, executable), macPolicy, options.signal)
    if (asset.companion) {
      const companion = asset.companion
      const archive = join(stage, companion.name)
      await download(`https://github.com/ggml-org/llama.cpp/releases/download/${RUNTIME_VERSION}/${companion.name}`, archive, {
        bytes: companion.bytes, sha256: companion.sha256, minFreeBytes: MAX_EXPANDED,
        ...options, signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(600_000)]),
      })
      const libraries = join(stage, 'libraries')
      const checked = extractRuntimeArchive(readFileSync(archive), companion.name.endsWith('.zip') ? 'zip' : 'tar.gz', libraries, options.signal)
      const expected = host === 'linux-x64' ? /^lib(?:cudart|cublas|cublasLt)\.so\.12$/ : /^(?:cudart64_12|cublas64_12|cublasLt64_12)\.dll$/
      const names = new Set<string>()
      for (const name of Object.keys(checked)) {
        const leaf = basename(name)
        if (!expected.test(leaf) || names.has(leaf)) throw new Error(`Unexpected CUDA runtime library: ${name}`)
        names.add(leaf)
        const relative = posix.join(posix.dirname(executable), leaf)
        if (files[relative]) throw new Error('CUDA library collides with runner archive.')
        writeFileSync(join(payload, relative), readFileSync(join(libraries, name)), { flag: 'wx', mode: 0o700 })
        files[relative] = checked[name]!
      }
      if (names.size !== 3) throw new Error('CUDA runtime archive must contain all three pinned libraries.')
    }
    const receipt: Receipt = { version: RUNTIME_VERSION, platform: host, backend, companionSha256: asset.companion?.sha256, sha256: asset.sha256, executable, macPolicy, files }
    writeFileSync(join(payload, 'receipt.json'), JSON.stringify(receipt), { mode: 0o600, flag: 'wx' })
    aborted(options.signal)
    if (existsSync(base)) throw new Error('Existing runtime is invalid. Move it aside before reinstalling; no existing files were deleted.')
    renameSync(payload, base)
    return { version: receipt.version, platform: host, backend, companionSha256: receipt.companionSha256, sha256: asset.sha256, macPolicy, executable: join(base, executable) }
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true })
    await new Promise<void>((resolve) => lock.close(() => resolve()))
  }
}

/** Validated flags for the pinned b11146 parser. Never accept arbitrary runner arguments. */
export function llamaOptimizationArgs(model: Installed, all: readonly Installed[]): string[] {
  if (model.format && model.format !== 'gguf') throw new Error('llama.cpp supports GGUF models only; use the MLX runner for this format.')
  const cache = model.kvCache ?? 'f16'
  if (!['f16', 'q8_0', 'q4_0'].includes(cache)) throw new Error('Unsupported KV-cache type; choose f16, q8_0 or q4_0.')
  const args = ['--cache-type-k', cache, '--cache-type-v', cache]
  // Quantized V requires flash attention. Unsupported model/backend combinations fail clearly,
  // instead of silently using a larger cache than the memory recommendation allowed.
  if (cache !== 'f16') args.push('--flash-attn', 'on')
  if (!model.draftModelId) return args
  const draft = all.find((m) => m.id === model.draftModelId)
  if (!draft || draft.id === model.id || draft.ready === false || (draft.format ?? 'gguf') !== 'gguf' ||
    !model.tokenizerFingerprint || model.tokenizerFingerprint !== draft.tokenizerFingerprint ||
    !Number.isFinite(model.params) || !Number.isFinite(draft.params) || draft.params! <= 0 || draft.params! >= model.params! ||
    !model.architecture || model.architecture !== draft.architecture ||
    !Number.isSafeInteger(draft.contextMax ?? draft.context) || (draft.contextMax ?? draft.context) < model.context ||
    !draft.files.length || !draft.files.every((f) => existsSync(f) && lstatSync(f).isFile()) ||
    draft.draftModelId) throw new Error('Unsupported draft model: choose a smaller installed GGUF with the same tokenizer fingerprint and architecture, without a nested draft.')
  // b11146 common/arg.cpp: these are the canonical server flags. Keep the draft
  // on CPU and its KV cache at f16, matching the separate draft memory estimate.
  args.push('--spec-type', 'draft-simple', '--spec-draft-model', draft.files[0]!, '--spec-draft-ngl', '0', '--spec-draft-device', 'none', '--spec-draft-type-k', 'f16', '--spec-draft-type-v', 'f16')
  return args
}
async function verifyImportedModel(model: Installed, signal: AbortSignal): Promise<void> {
  if (!model.imported && model.owned !== false) return
  if (!model.files.length || !/^[a-f0-9]{64}$/i.test(model.sha256 ?? '')) throw new Error('Imported GGUF has no verifiable SHA-256 identity; import it again.')
  // Use the same bounded parser and ordered, whole-group hash as import. A single
  // file uses its ordinary SHA; a split uses all shards, including later tensors.
  const actual = await readGguf(model.files[0]!, { signal })
  if (actual.sha256 !== model.sha256!.toLowerCase() || actual.bytes !== model.bytes ||
    actual.files.length !== model.files.length || actual.files.some((file, i) => file !== model.files[i]) ||
    model.architecture !== undefined && model.architecture !== actual.architecture ||
    model.tokenizerFingerprint !== undefined && model.tokenizerFingerprint !== actual.tokenizerFingerprint) {
    throw new Error('Imported GGUF changed after import. Import it again before running it.')
  }
}
async function verifiedBackendArgs(runtime: Runtime, profile: BackendProfile, signal: AbortSignal): Promise<string[]> {
  if (profile.backend === 'cpu') return ['--n-gpu-layers', '0', '--device', 'none', '--no-kv-offload']
  // A test seam never executes a downloaded binary for capability probing.
  if (runtime.version === RUNTIME_VERSION) {
    const env: NodeJS.ProcessEnv = {}
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key]
    if (profile.backend === 'cuda' && profile.gpu?.uuid) env.CUDA_VISIBLE_DEVICES = profile.gpu.uuid
    const version = await runFile(runtime.executable, ['--version'], { signal, timeout: 10_000, maxBuffer: 65536, env, cwd: dirname(runtime.executable), windowsHide: true })
    if (!new RegExp(`(?:build|version):?\\s*(?:b)?11146\\b`, 'i').test(version.stdout + version.stderr)) throw new Error('Pinned runtime build does not report b11146.')
    const result = await runFile(runtime.executable, ['--list-devices'], { signal, timeout: 10_000, maxBuffer: 65536, env, cwd: dirname(runtime.executable), windowsHide: true })
    const name = profile.backend === 'metal' ? 'MTL0' : profile.backend === 'cuda' ? 'CUDA0' : `Vulkan${profile.gpu?.index ?? 0}`
    if (!new RegExp(`^\\s*${name}:`, 'm').test(result.stdout + result.stderr)) throw new Error(`Pinned ${profile.backend} runtime did not establish device ${name}; driver/backend may be unsupported.`)
  }
  return ['--n-gpu-layers', 'auto', '--device', profile.backend === 'metal' ? 'MTL0' : profile.backend === 'cuda' ? 'CUDA0' : `Vulkan${profile.gpu?.index ?? 0}`]
}

function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  aborted(signal)
  return new Promise<T>((resolve, reject) => {
    const cancel = (): void => reject(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel))
  })
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  aborted(signal)
  return new Promise((resolve, reject) => {
    const done = (): void => { signal?.removeEventListener('abort', cancel); resolve() }
    const timer = setTimeout(done, ms)
    const cancel = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(signal?.reason) }
    signal?.addEventListener('abort', cancel, { once: true })
  })
}
async function freePort(signal: AbortSignal): Promise<number> {
  aborted(signal)
  const server = createServer()
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') reject(new Error('No loopback port.'))
      else resolve(address.port)
    })
  })
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  aborted(signal)
  return port
}
/** A kernel-owned coordination socket has no stale file or persisted PID to recover. Hash
 * collisions / unrelated listeners fail closed; no existing process is adopted or signalled.
 * Canonicalize the existing parent to make data-directory symlink aliases agree.
 */
function coordinationPort(path: string, purpose: 'install' | 'server'): number {
  const canonical = existsSync(path) ? realpathSync(path) : join(realpathSync(dirname(path)), basename(path))
  return (purpose === 'install' ? 20000 : 40000) + createHash('sha256').update(canonical).digest().readUInt32LE(0) % 20000
}
async function coordination(path: string, purpose: 'install' | 'server'): Promise<ReturnType<typeof createServer>> {
  const lock = createServer((socket) => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    lock.once('error', (error) => reject(new Error(`Runtime coordination socket could not open: ${error.message}. Another owner or local listener may hold it.`, { cause: error })))
    lock.listen({ host: '127.0.0.1', port: coordinationPort(path, purpose), exclusive: true }, resolve)
  })
  return lock
}
/** The guardian is core-owned Node code, executed by the SAME Node binary as this core.
 * stdin EOF is the parent-death notification (also works after SIGKILL). Only this guardian's
 * ChildProcess handle is ever signalled. Its socket is held until the actual runner exits.
 * No worker PID is read from disk, no unsigned code is substituted for llama.cpp, no shell.
 */
const GUARDIAN = String.raw`
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { rmSync } = require('node:fs');
let input = '', config, runner, lock, stopping = false, timer;
function cleanup() {
  clearTimeout(timer);
  if (config) { try { rmSync(config.folder, { recursive: true, force: true }); } catch {} }
  if (lock && lock.listening) lock.close(() => process.exit(0));
  else process.exit(0);
}
function stop() {
  if (stopping) return;
  stopping = true;
  if (!runner) { cleanup(); return; }
  if (runner.exitCode !== null || runner.signalCode !== null) { cleanup(); return; }
  runner.kill('SIGTERM');
  timer = setTimeout(() => {
    if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL');
  }, config.stopMs);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdin.on('end', stop);
process.stdin.on('error', stop);
process.stdin.on('data', chunk => {
  if (config || stopping) return;
  input += chunk;
  if (input.length > 65536) { process.stderr.write('Invalid guardian configuration.'); stop(); return; }
  if (!input.includes('\n')) return;
  try { config = JSON.parse(input.split('\n')[0]); }
  catch { stop(); return; }
  lock = createServer(socket => socket.destroy());
  lock.once('error', () => { process.stderr.write('Another runtime owner or local listener holds the coordination port.'); stop(); });
  lock.listen({ host: '127.0.0.1', port: config.lockPort, exclusive: true }, () => {
    if (stopping) { cleanup(); return; }
    runner = spawn(config.executable, config.args, { cwd: config.cwd, env: process.env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    runner.once('spawn', () => { process.stdout.write(JSON.stringify({ pid: runner.pid }) + '\n'); });
    runner.stderr.on('data', chunk => { process.stderr.write(chunk); });
    runner.once('error', error => { process.stderr.write(error.message); cleanup(); });
    runner.once('exit', cleanup);
  });
});
process.stdout.on('error', stop);
process.stderr.on('error', stop);
`
export interface LlamaServerOptions {
  dataDir: string
  backend?: BackendPreference
  backendProbe?: BackendOptions['probe']
  macPolicy?: MacPolicy
  idleMs?: number
  healthMs?: number
  pollMs?: number
  stopMs?: number
  pressure?: typeof memoryPressure
  pressureMs?: number
  /** Test seams; production uses the pinned runtime and a real child. */
  runtime?: typeof ensureRuntime
  spawn?: typeof spawn
  fetch?: typeof fetch
  port?: (signal: AbortSignal) => Promise<number>
}
export interface Loaded { backend?: RunnerBackend; fallbackReason?: string; model: string; baseUrl: string; pid?: number; since: number }
export interface LlamaLease { baseUrl: string; key: string; release: () => void }
interface Session {
  child: ChildProcess
  exited: Promise<void>
  dead: boolean
  key: string
  folder: string
  stderr: string
  loaded: Loaded
  ready: boolean
  leases: number
  drained?: () => void
  terminating?: Promise<void>
}
const servers = new Map<string, LlamaServer>()
/** Constructor: new LlamaServer({ dataDir, macPolicy?, idleMs?, healthMs? }).
 * One owner per canonical data directory in this process; a coordination socket prevents another
 * core from spawning a second runner. Never discover, adopt, or kill a PID from disk.
 */
export class LlamaServer {
  private queue: Promise<unknown> = Promise.resolve()
  private session?: Session
  private idle?: ReturnType<typeof setTimeout>
  private stopping = new AbortController()
  private stopPromise?: Promise<void>
  private pressureTimer?: ReturnType<typeof setInterval>
  private readingPressure = false
  private readonly pressureBlocked = new Set<string>()
  constructor(private readonly options: LlamaServerOptions) {
    const key = existsSync(options.dataDir) ? realpathSync(options.dataDir) : resolve(options.dataDir)
    const old = servers.get(key)
    if (old) return old
    servers.set(key, this)
  }
  profile(preference: BackendPreference = this.options.backend ?? 'auto', signal?: AbortSignal): Promise<BackendProfile> {
    return runnerBackendProfile({ preference, signal, probe: this.options.backendProbe })
  }
  loaded(): Loaded | undefined {
    const s = this.session
    return s?.ready && !s.dead ? { ...s.loaded } : undefined
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action)
    this.queue = result.catch(() => undefined)
    return result
  }
  ensure(id: string, signal?: AbortSignal, options?: { download?: boolean }): Promise<string> {
    return this.request(id, false, signal, options?.download).then((s) => s.loaded.baseUrl)
  }
  acquire(id: string, signal?: AbortSignal): Promise<LlamaLease> {
    return this.request(id, true, signal).then((s) => {
      let released = false
      return { baseUrl: s.loaded.baseUrl, key: s.key, release: () => {
        if (released) return
        released = true
        s.leases--
        if (s.leases === 0) { s.drained?.(); s.drained = undefined; this.armIdle(s) }
      } }
    })
  }
  private async request(id: string, lease: boolean, signal?: AbortSignal, download?: boolean): Promise<Session> {
    const combined = AbortSignal.any([this.stopping.signal, ...(signal ? [signal] : [])])
    return withSignal(this.serial(async () => {
      aborted(combined)
      if (this.pressureBlocked.has(id)) throw new Error('This model was unloaded because memory pressure became critical. Choose a smaller model before trying again.')
      let s = this.session
      if (s && (s.dead || s.loaded.model !== id)) {
        if (s.leases > 0 && !s.dead) await withSignal(new Promise<void>((resolve) => { s!.drained = resolve }), combined)
        await this.terminate(s)
        s = undefined
      }
      if (!s) {
        if (this.pressureBlocked.size && await (this.options.pressure ?? memoryPressure)() === 'critical') throw new Error('Memory pressure is still critical. Close other applications and choose a smaller model.')
        aborted(combined)
        s = await this.start(id, combined, download)
      }
      aborted(combined)
      clearTimeout(this.idle)
      if (lease) s.leases++
      else this.armIdle(s)
      return s
    }), combined)
  }
  private armIdle(s: Session): void {
    clearTimeout(this.idle)
    if (s.dead || s.leases || this.session !== s) return
    this.idle = setTimeout(() => {
      void this.serial(async () => { if (this.session === s && !s.leases) await this.terminate(s) }).catch(() => undefined)
    }, this.options.idleMs ?? 300_000)
    this.idle.unref()
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    clearTimeout(this.idle)
    this.stopping.abort(new Error('llama-server stopped.'))
    const stopped = this.serial(async () => {
      const s = this.session
      if (!s) return
      if (s.leases > 0 && !s.dead) await new Promise<void>((resolve) => { s.drained = resolve })
      await this.terminate(s)
    })
    this.stopPromise = stopped.finally(() => { this.stopping = new AbortController(); this.stopPromise = undefined })
    return this.stopPromise
  }
  private async start(id: string, signal: AbortSignal, download?: boolean): Promise<Session> {
    const model = readInstalled(this.options.dataDir).find((m) => m.id === id)
    if (!model || !model.files.length || !model.files.every((f) => existsSync(f) && lstatSync(f).isFile()) || !Number.isSafeInteger(model.context) || model.context <= 0 || id.includes(',') || hasControl(id)) throw new Error(`Installed model is missing or invalid: ${id}`)
    const all = readInstalled(this.options.dataDir)
    const optimization = llamaOptimizationArgs(model, all)
    await verifyImportedModel(model, signal)
    const draft = model.draftModelId && all.find((m) => m.id === model.draftModelId)
    if (draft) await verifyImportedModel(draft, signal)
    let profile = await this.profile(model.backend ?? this.options.backend ?? 'auto', signal)
    if (download === false && !this.options.runtime && profile.accelerated && !runtimeReady(this.options.dataDir, { backend: profile.backend }) && runtimeReady(this.options.dataDir, { backend: 'cpu' })) {
      profile = { ...profile, backend: 'cpu', accelerated: false, gpu: undefined, memoryBudgetBytes: undefined, reason: 'The accelerated runtime is not installed; using the installed CPU runtime.' }
    }
    let runtime = await (this.options.runtime ?? ensureRuntime)(this.options.dataDir, { signal, macPolicy: this.options.macPolicy, backend: profile.backend, ...(download !== undefined && { download }) })
    // A legacy injected/default runtime is never treated as CUDA just because hardware exists.
    if (!runtime.backend) { profile = { ...profile, backend: defaultBackend(), accelerated: defaultBackend() === 'metal', gpu: undefined, memoryBudgetBytes: undefined, reason: 'Runtime has no backend receipt; using its legacy platform policy.' } }
    else if (runtime.backend !== profile.backend) throw new Error('Installed runtime backend does not match the selected hardware profile.')
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.options.healthMs ?? 180_000)])
    const parent = join(realpathSync(this.options.dataDir), 'runtime')
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    let last: unknown
    // Port reservation cannot be passed to llama-server. Retry that race / early exit at most twice.
    for (let attempt = 0; attempt < 2; attempt++) {
      aborted(deadline)
      const port = await (this.options.port ?? freePort)(deadline)
      let folder: string | undefined
      let s: Session | undefined
      try {
        folder = mkdtempSync(join(parent, '.llama-session-'))
        const key = randomBytes(32).toString('hex')
        const keyFile = join(folder, 'api-key')
        writeFileSync(keyFile, key + '\n', { mode: 0o600, flag: 'wx' })
        // Exclude inherited LLAMA_* controls, loader injection and cloud credentials.
        const env: NodeJS.ProcessEnv = {}
        for (const name of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'SystemRoot', 'WINDIR']) if (process.env[name]) env[name] = process.env[name]
        const backendArgs = await verifiedBackendArgs(runtime, profile, deadline)
        if (profile.backend === 'cuda' && profile.gpu?.uuid) env.CUDA_VISIBLE_DEVICES = profile.gpu.uuid
        const args = [
          '--model', model.files[0]!, '--alias', id, '--ctx-size', String(model.context),
          '--host', '127.0.0.1', '--port', String(port), '--parallel', '1', '--jinja',
          '--api-key-file', keyFile, '--no-webui', '--no-slots', ...backendArgs, ...optimization,
          // The projector is what makes the pictures in a request readable to the model.
          ...(model.projector !== undefined && existsSync(model.projector) ? ['--mmproj', model.projector] : []),
        ]
        const child = (this.options.spawn ?? spawn)(process.execPath, ['-e', GUARDIAN], {
          env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        })
        let exited!: () => void
        const exit = new Promise<void>((resolve) => { exited = resolve })
        s = { child, exited: exit, dead: false, key, folder, stderr: '', loaded: { backend: profile.backend, ...(profile.backend === 'cpu' && profile.requested !== 'cpu' ? { fallbackReason: profile.reason } : {}), model: id, baseUrl: `http://127.0.0.1:${port}/v1`, since: Date.now() }, ready: false, leases: 0 }
        const owned = s
        const ended = (): void => {
          owned.dead = true; owned.ready = false; owned.drained?.(); exited()
          void this.serial(async () => { if (this.session === owned) await this.terminate(owned) }).catch(() => undefined)
        }
        let output = ''
        child.stdout?.on('data', (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-4096)
          const line = output.split('\n')[0]
          if (!output.includes('\n')) return
          try {
            const message = JSON.parse(line!) as { pid?: number }
            if (Number.isSafeInteger(message.pid) && message.pid! > 0) owned.loaded.pid = message.pid
          } catch { /* No runtime output is interpreted as a command. */ }
        })
        child.stderr?.on('data', (chunk: Buffer) => { owned.stderr = (owned.stderr + chunk.toString()).slice(-8192) })
        child.once('exit', ended)
        child.once('error', (error) => { owned.stderr = error.message; ended() })
        child.stdin?.on('error', () => { /* Exit / health deadline reports failed guardian. */ })
        this.session = s
        if (!child.stdin) throw new Error('Guardian stdin pipe was not created.')
        child.stdin.write(JSON.stringify({
          executable: runtime.executable, args, cwd: dirname(runtime.executable), folder,
          // Ownership is data-directory scoped, deliberately independent of the runtime pin.
          lockPort: coordinationPort(this.options.dataDir, 'server'), stopMs: this.options.stopMs ?? 3000,
        }) + '\n')
        while (!s.dead) {
          aborted(deadline)
          if (await this.healthy(s, deadline)) {
            aborted(deadline)
            if (s.dead) break
            s.ready = true
            this.watchPressure(s)
            return s
          }
          await delay(this.options.pollMs ?? 200, deadline)
        }
        throw new Error('llama-server exited before it became ready (or was rejected by the OS).')
      } catch (error) {
        if (s) await this.terminate(s)
        else if (folder) rmSync(folder, { recursive: true, force: true })
        // Strip the credential even if an upstream error echoed its key file contents.
        const tail = s && [...s.stderr.replaceAll(s.key, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')].filter((c) => !hasControl(c) || c === '\n' || c === '\t').join('').trim()
        last = new Error(`${error instanceof Error ? error.message : String(error)}${tail ? `\nRunner: ${tail}` : ''}`, { cause: error })
        aborted(signal)
        if (deadline.aborted) throw last
        if (attempt === 0 && profile.accelerated && runtime.version === RUNTIME_VERSION && !model.draftModelId && (!model.kvCache || model.kvCache === 'f16')) {
          const reason = `Accelerated runtime failed to start: ${last instanceof Error ? last.message : String(last)}. Retrying on CPU.`
          profile = { ...profile, backend: 'cpu', accelerated: false, gpu: undefined, memoryBudgetBytes: undefined, reason }
          runtime = await (this.options.runtime ?? ensureRuntime)(this.options.dataDir, { signal: deadline, macPolicy: this.options.macPolicy, backend: 'cpu', ...(download !== undefined && { download }) })
        }
      }
    }
    throw last
  }
  private async healthy(s: Session, deadline: AbortSignal): Promise<boolean> {
    const request = this.options.fetch ?? fetch
    const signal = AbortSignal.any([deadline, AbortSignal.timeout(2000)])
    try {
      const health = await request(`${s.loaded.baseUrl}/health`, { signal, redirect: 'error' })
      if (!health.ok || (await health.json() as { status?: string }).status !== 'ok') return false
      // /health is PUBLIC upstream: authenticate and verify the alias on /v1/models too.
      const models = await request(`${s.loaded.baseUrl}/models`, { signal, redirect: 'error', headers: { authorization: `Bearer ${s.key}` } })
      if (!models.ok) return false
      const body = await models.json() as { data?: { id: string }[] }
      return Array.isArray(body.data) && body.data.some((m) => m.id === s.loaded.model)
    } catch { aborted(deadline); return false }
  }
  private async terminate(s: Session): Promise<void> {
    s.terminating ??= this.finish(s).catch((error: unknown) => { s.terminating = undefined; throw error })
    return s.terminating
  }
  private watchPressure(s: Session): void {
    clearInterval(this.pressureTimer)
    this.pressureTimer = setInterval(() => {
      if (this.readingPressure || this.session !== s || s.dead || !s.ready) return
      this.readingPressure = true
      void (this.options.pressure ?? memoryPressure)().then(async (pressure) => {
        if (pressure !== 'critical' || this.session !== s || s.dead || !s.ready) return
        this.pressureBlocked.add(s.loaded.model)
        // Critical pressure is the one safety intervention that interrupts an active lease.
        // Do not queue behind a model switch waiting for that same lease to drain.
        await this.terminate(s)
      }).catch(() => undefined).finally(() => { this.readingPressure = false })
    }, this.options.pressureMs ?? 30_000)
    this.pressureTimer.unref()
  }
  private async finish(s: Session): Promise<void> {
    clearTimeout(this.idle)
    if (this.session === s) clearInterval(this.pressureTimer)
    s.ready = false
    // Close the ownership pipe. The guardian terminates its actual child and releases its
    // kernel socket. Never SIGKILL the guardian: doing so would defeat orphan prevention.
    if (!s.dead) {
      s.child.stdin?.end()
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, (this.options.stopMs ?? 3000) + 3000)
        void s.exited.then(() => { clearTimeout(timer); resolve() })
      })
      if (!s.dead) throw new Error('llama-server did not exit; ownership lock retained.')
    }
    if (this.session === s) this.session = undefined
    rmSync(s.folder, { recursive: true, force: true })
  }
}
// llama-server can send its role frame before processing a large tool prompt. The gap
// after that frame must allow local prefill, rather than inheriting a cloud's 20s timeout.
export const LLAMA: Provider = { id: LLAMA_ID, name: 'llama.cpp', baseUrl: '', auth: 'none', timeoutMs: 180_000, idleMs: 180_000, trainsOnYourData: 'no' }
/** Provider.prepare must accept string | {baseUrl,key?,release?}; chat calls release in finally. */
export function llamaProvider(server: LlamaServer): Provider {
  return { ...LLAMA, prepare: (model, signal) => server.acquire(model, signal) }
}
