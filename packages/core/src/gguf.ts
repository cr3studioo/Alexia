// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, type Hash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** Limits apply before allocation or iteration, including metadata we do not retain. */
const MAX_HEADER = 128 * 1024 * 1024
const MAX_FILE = 2 * 1024 ** 4
const MAX_TENSORS = 200_000
const MAX_ARRAY = 1_000_000
const MAX_PARTS = 128
const utf8 = new TextDecoder('utf-8', { fatal: true })
export class GgufError extends Error {
  constructor(message: string) { super(message); this.name = 'GgufError' }
}
export interface GgufProgress { done: number; total: number; phase: 'read' | 'copy' | 'verify' }
export interface GgufOptions { signal?: AbortSignal; onProgress?: (progress: GgufProgress) => void }
export interface GgufFingerprint {
  dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint
}
export interface GgufPart {
  path: string; bytes: number; sha256: string; fingerprint: GgufFingerprint
}
export interface GgufMetadata {
  name: string; quant: string; contextMax?: number; kvBytesPerToken?: number; params: number
  architecture: string; files: string[]; bytes: number; sha256: string; parts: GgufPart[]
  version: number; tensorCount: number; tokenizerFingerprint?: string
}
export function checkGgufSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Model import cancelled.', 'AbortError')
}
const bad = (message: string): never => { throw new GgufError(message) }
export function sameGgufFile(a: GgufFingerprint, b: GgufFingerprint): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}
async function fingerprint(handle: FileHandle): Promise<GgufFingerprint> {
  const s = await handle.stat({ bigint: true })
  if (!s.isFile() || s.size <= 0n || s.size > BigInt(MAX_FILE)) bad('GGUF source must be a bounded, nonempty regular file.')
  return { dev: s.dev, ino: s.ino, size: s.size, mtimeNs: s.mtimeNs, ctimeNs: s.ctimeNs }
}
export async function assertGgufUnchanged(path: string, expected: GgufFingerprint): Promise<void> {
  if (await realpath(path) !== path) bad('GGUF source path changed during import.')
  const s = await stat(path, { bigint: true })
  if (!s.isFile() || !sameGgufFile(s, expected)) bad('GGUF source changed during import.')
}
async function source(path: string): Promise<{ path: string; handle: FileHandle; fingerprint: GgufFingerprint }> {
  const canonical = await realpath(path)
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK)
  try {
    const snapshot = await fingerprint(handle)
    await assertGgufUnchanged(canonical, snapshot)
    return { path: canonical, handle, fingerprint: snapshot }
  } catch (error) { await handle.close(); throw error }
}

/** Positioned reads with a small cache: never buffer tensor weights or whole headers. */
class Header {
  position = 0
  capture?: Hash
  private cache = Buffer.alloc(0)
  private start = -1
  constructor(private handle: FileHandle, private size: number, private signal?: AbortSignal) {}
  private bounds(n: number): void {
    checkGgufSignal(this.signal)
    if (!Number.isSafeInteger(n) || n < 0 || this.position + n > Math.min(this.size, MAX_HEADER)) bad('Truncated or oversized GGUF header.')
  }
  async skip(n: number): Promise<void> {
    this.bounds(n)
    if (!this.capture) { this.position += n; return }
    while (n > 0) { const take = Math.min(n, 64 * 1024); await this.read(take); n -= take }
  }
  async read(n: number): Promise<Buffer> {
    this.bounds(n)
    if (this.position < this.start || this.position + n > this.start + this.cache.length) {
      this.start = this.position
      const buffer = Buffer.alloc(Math.min(Math.max(n, 64 * 1024), this.size - this.position, MAX_HEADER - this.position))
      let got = 0
      while (got < buffer.length) {
        const result = await this.handle.read(buffer, got, buffer.length - got, this.position + got)
        if (!result.bytesRead) bad('Truncated GGUF header.')
        got += result.bytesRead
        checkGgufSignal(this.signal)
      }
      this.cache = buffer
    }
    const b = this.cache.subarray(this.position - this.start, this.position - this.start + n)
    this.position += n
    this.capture?.update(b)
    return b
  }
  async uint32(): Promise<number> { return (await this.read(4)).readUInt32LE() }
  async uint64(): Promise<number> {
    const value = (await this.read(8)).readBigUInt64LE()
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) bad('GGUF integer exceeds safe bounds.')
    return Number(value)
  }
  async string(keep = true, max = 8 * 1024 * 1024): Promise<string> {
    const length = await this.uint64()
    if (length > max) bad('GGUF string exceeds import limits.')
    if (!keep) { await this.skip(length); return '' }
    const bytes = await this.read(length)
    try { return utf8.decode(bytes) } catch { return bad('Invalid UTF-8 in GGUF metadata.') }
  }
  async value(type: number, keep: boolean, vocabulary = false): Promise<string | number | boolean | undefined> {
    if (type === 8) return this.string(keep, keep ? 4096 : 8 * 1024 * 1024)
    if (type === 9) {
      const element = await this.uint32(), count = await this.uint64()
      if (count > MAX_ARRAY || element === 9 || element > 12) bad('Unsupported or oversized GGUF array.')
      if (vocabulary && (element !== 8 || count === 0)) bad('GGUF tokenizer vocabulary must be a nonempty string array.')
      if (keep) bad('Required GGUF metadata must be a scalar.')
      if (element === 8) { for (let i = 0; i < count; i++) await this.string(false) }
      else {
        const width = widths[element]
        if (width === undefined) throw new GgufError('Invalid GGUF array element type.')
        await this.skip(count * width)
      }
      return undefined
    }
    const width = widths[type]
    if (width === undefined) throw new GgufError('Invalid GGUF metadata type.')
    if (!keep) { await this.skip(width); return undefined }
    const b = await this.read(width)
    switch (type) {
      case 0: return b.readUInt8()
      case 1: return b.readInt8()
      case 2: return b.readUInt16LE()
      case 3: return b.readInt16LE()
      case 4: return b.readUInt32LE()
      case 5: return b.readInt32LE()
      case 6: return b.readFloatLE()
      case 7: if (b[0] !== 0 && b[0] !== 1) bad('Invalid GGUF boolean.'); return b[0] === 1
      case 10: case 11: {
        const n = type === 10 ? b.readBigUInt64LE() : b.readBigInt64LE()
        if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER)) bad('GGUF integer exceeds safe bounds.')
        return Number(n)
      }
      case 12: return b.readDoubleLE()
    }
  }
}
const widths: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 }
// Block element count and storage size from ggml's GGML_QUANT_SIZES, not filename guesses.
const blocks: Record<number, [number, number]> = {
  0: [1, 4], 1: [1, 2], 2: [32, 18], 3: [32, 20], 6: [32, 22], 7: [32, 24], 8: [32, 34], 9: [32, 36],
  10: [256, 84], 11: [256, 110], 12: [256, 144], 13: [256, 176], 14: [256, 210], 15: [256, 292],
  16: [256, 66], 17: [256, 74], 18: [256, 98], 19: [256, 50], 20: [32, 18], 21: [256, 110], 22: [256, 82],
  23: [256, 136], 24: [1, 1], 25: [1, 2], 26: [1, 4], 27: [1, 8], 28: [1, 8], 29: [256, 56], 30: [1, 2],
  34: [256, 54], 35: [256, 66], 39: [32, 17], 40: [64, 36], 41: [128, 18], 42: [64, 18],
}
const quants: Record<number, string> = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 7: 'Q8_0', 8: 'Q5_0', 9: 'Q5_1', 10: 'Q2_K',
  11: 'Q3_K_S', 12: 'Q3_K_M', 13: 'Q3_K_L', 14: 'Q4_K_S', 15: 'Q4_K_M', 16: 'Q5_K_S', 17: 'Q5_K_M', 18: 'Q6_K',
  19: 'IQ2_XXS', 20: 'IQ2_XS', 21: 'Q2_K_S', 22: 'IQ3_XS', 23: 'IQ3_XXS', 24: 'IQ1_S', 25: 'IQ4_NL',
  26: 'IQ3_S', 27: 'IQ3_M', 28: 'IQ2_S', 29: 'IQ2_M', 30: 'IQ4_XS', 31: 'IQ1_M', 32: 'BF16',
  36: 'TQ1_0', 37: 'TQ2_0', 38: 'MXFP4_MOE', 39: 'NVFP4', 40: 'Q1_0', 41: 'Q2_0',
}
type Scalar = string | number | boolean | undefined
interface Parsed { tokenizerFingerprint?: string; version: number; metadata: Map<string, Scalar>; names: Set<string>; elements: number; tensorCount: number }
const required = (key: string): boolean => /^(general\.(architecture|name|alignment|file_type|type)|split\.(no|count|tensors\.count))$/.test(key) || /\.(context_length|block_count|embedding_length|attention\.(head_count|head_count_kv|key_length|value_length))$/.test(key)
const integer = (n: Scalar, max = Number.MAX_SAFE_INTEGER): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n <= max
async function parse(handle: FileHandle, size: number, signal?: AbortSignal): Promise<Parsed> {
  const h = new Header(handle, size, signal)
  if ((await h.read(4)).toString('ascii') !== 'GGUF') bad('Not a little-endian GGUF file.')
  const version = await h.uint32()
  if (version !== 2 && version !== 3) bad('Only GGUF versions 2 and 3 are supported.')
  const tensorCount = await h.uint64(), count = await h.uint64()
  if (!integer(tensorCount, MAX_TENSORS) || count > 100_000) bad('Invalid or excessive GGUF tensor/metadata count.')
  const metadata = new Map<string, Scalar>(), keys = new Set<string>(), tokenizer = new Map<string, string>()
  for (let i = 0; i < count; i++) {
    const key = await h.string(true, 1024)
    if (!/^[a-zA-Z0-9_.-]+$/.test(key) || keys.has(key)) bad('Invalid or duplicate GGUF metadata key.')
    keys.add(key)
    const keep = required(key), type = await h.uint32()
    if (key === 'tokenizer.ggml.tokens' && type !== 9 || key === 'tokenizer.ggml.model' && type !== 8) bad('Invalid GGUF tokenizer metadata type.')
    if (key.startsWith('tokenizer.')) {
      h.capture = createHash('sha256')
      const tag = Buffer.alloc(4); tag.writeUInt32LE(type); h.capture.update(tag)
    }
    const value = await h.value(type, keep, key === 'tokenizer.ggml.tokens')
    if (h.capture) { tokenizer.set(key, h.capture.digest('hex')); h.capture = undefined }
    if (keep) metadata.set(key, value)
  }
  const rawAlignment = metadata.get('general.alignment') ?? 32
  if (typeof rawAlignment !== 'number' || !integer(rawAlignment, 4096) || (rawAlignment & (rawAlignment - 1)) !== 0) bad('Invalid GGUF alignment.')
  const alignment: number = rawAlignment as number
  const names = new Set<string>(), ranges: [number, number][] = []
  let elements = 0
  for (let i = 0; i < tensorCount; i++) {
    const name = await h.string(true, 256), dimensions = await h.uint32()
    if (!name || names.has(name) || dimensions < 1 || dimensions > 4) bad('Invalid or duplicate GGUF tensor descriptor.')
    names.add(name)
    let n = 1, first = 0
    for (let d = 0; d < dimensions; d++) {
      const dimension = await h.uint64()
      if (!integer(dimension, 1_000_000_000)) bad('Invalid GGUF tensor dimension.')
      if (!d) first = dimension
      n *= dimension
      if (!integer(n, 2_000_000_000_000)) bad('Oversized GGUF tensor.')
    }
    const type = await h.uint32(), rawOffset = await h.uint64(), block = blocks[type]
    if (typeof rawOffset !== 'number') bad('GGUF tensor offset is too large.')
    const offset = rawOffset
    if (block === undefined) throw new GgufError('Unsupported GGUF tensor type, shape or offset.')
    if (first % block[0] !== 0 || offset % alignment !== 0) bad('Unsupported GGUF tensor shape or offset.')
    const bytes = n / block[0] * block[1]
    if (!Number.isSafeInteger(offset + bytes) || offset + bytes > size) bad('Truncated GGUF tensor data.')
    ranges.push([offset, offset + bytes]); elements += n
    if (!integer(elements, 2_000_000_000_000)) bad('Excessive GGUF parameter count.')
  }
  const dataStart = Math.ceil(h.position / alignment) * alignment
  ranges.sort((a, b) => a[0] - b[0])
  let end = 0
  for (const [start, next] of ranges) {
    if (start < end || dataStart + next > size) bad('Overlapping or truncated GGUF tensors.')
    end = next
  }
  // Key order is irrelevant; array order, value types, vocabulary bytes and all
  // tokenizer.* fields are significant. Neither model name nor quant affects this.
  const tokenizerHash = createHash('sha256').update('alexia-gguf-tokenizer-v1\0')
  for (const key of [...tokenizer.keys()].sort()) tokenizerHash.update(`${key}\0${tokenizer.get(key)}\0`)
  return { version, metadata, names, elements, tensorCount, tokenizerFingerprint: tokenizer.has('tokenizer.ggml.model') && tokenizer.has('tokenizer.ggml.tokens') ? tokenizerHash.digest('hex') : undefined }
}

/** Streaming SHA, with descriptor and path identity checks before and after every pass. */
export async function hashGgufFile(path: string, expected: GgufFingerprint, options: GgufOptions = {}, aggregate?: Hash): Promise<string> {
  checkGgufSignal(options.signal)
  const s = await source(path)
  try {
    if (s.path !== path || !sameGgufFile(s.fingerprint, expected)) bad('GGUF source changed before hashing.')
    const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024), size = Number(expected.size)
    let done = 0
    while (done < size) {
      checkGgufSignal(options.signal)
      const { bytesRead } = await s.handle.read(buffer, 0, Math.min(buffer.length, size - done), done)
      if (!bytesRead) bad('GGUF source was truncated while hashing.')
      const bytes = buffer.subarray(0, bytesRead)
      hash.update(bytes); aggregate?.update(bytes); done += bytesRead
      options.onProgress?.({ done, total: size, phase: 'read' })
    }
    if (!sameGgufFile(await fingerprint(s.handle), expected)) bad('GGUF source changed while hashing.')
    await assertGgufUnchanged(path, expected)
    checkGgufSignal(options.signal)
    return hash.digest('hex')
  } finally { await s.handle.close() }
}

/** SHA of the entire ordered group (plain file SHA for a single GGUF). No scripts are evaluated. */
export async function readGguf(path: string, options: GgufOptions = {}): Promise<GgufMetadata> {
  checkGgufSignal(options.signal)
  const firstSource = await source(path)
  let first: Parsed
  try { first = await parse(firstSource.handle, Number(firstSource.fingerprint.size), options.signal); await assertGgufUnchanged(firstSource.path, firstSource.fingerprint) }
  finally { await firstSource.handle.close() }
  const firstPath = firstSource.path, split = first.metadata.get('split.count'), no = first.metadata.get('split.no'), totalTensors = first.metadata.get('split.tensors.count')
  const match = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i.exec(basename(firstPath))
  let files = [firstPath]
  const hasSplit = split !== undefined || no !== undefined || totalTensors !== undefined
  if (hasSplit) {
    if (typeof split !== 'number' || !Number.isSafeInteger(split) || split < 1 || split > MAX_PARTS || typeof no !== 'number' || !Number.isInteger(no) || no < 0 || no >= split || !integer(totalTensors, MAX_TENSORS)) throw new GgufError('Incomplete or invalid GGUF split metadata.')
    const count = split, partNo = no
    if (count > 1) {
      if (!match || Number(match[2]) !== partNo + 1 || Number(match[3]) !== count) bad('GGUF split filename disagrees with metadata.')
      files = Array.from({ length: count }, (_, i) => join(dirname(firstPath), `${match![1]}-${String(i + 1).padStart(5, '0')}-of-${String(count).padStart(5, '0')}.gguf`))
    } else if (match && (Number(match[2]) !== 1 || Number(match[3]) !== 1)) bad('Deceptive GGUF split filename.')
  } else if (match) bad('Split GGUF is missing split metadata.')
  const parsed: Parsed[] = [], parts: GgufPart[] = [], identities = new Set<string>(), names = new Set<string>()
  let bytes = 0, elements = 0, tensors = 0
  for (let i = 0; i < files.length; i++) {
    checkGgufSignal(options.signal)
    const s = await source(files[i]!)
    try {
      if (files.length > 1 && s.path !== files[i]) bad('Split GGUF parts must be distinct regular files in the same directory.')
      const identity = `${s.fingerprint.dev}:${s.fingerprint.ino}`
      if (identities.has(identity)) bad('Split GGUF aliases the same file more than once.')
      identities.add(identity)
      const p = await parse(s.handle, Number(s.fingerprint.size), options.signal)
      if (hasSplit && (p.metadata.get('split.count') !== split || p.metadata.get('split.no') !== i || p.metadata.get('split.tensors.count') !== totalTensors)) bad('Mismatched GGUF split group.')
      if (p.version !== first.version) bad('Mismatched GGUF split versions.')
      for (const name of p.names) { if (names.has(name)) bad('Duplicate tensor across GGUF split parts.'); names.add(name) }
      tensors += p.tensorCount; elements += p.elements; bytes += Number(s.fingerprint.size)
      if (tensors > MAX_TENSORS || elements > 2_000_000_000_000) bad('GGUF group exceeds import limits.')
      parsed.push(p); parts.push({ path: s.path, bytes: Number(s.fingerprint.size), sha256: '', fingerprint: s.fingerprint })
      await assertGgufUnchanged(s.path, s.fingerprint)
    } finally { await s.handle.close() }
  }
  if (hasSplit && tensors !== totalTensors) bad('GGUF split tensor total does not match its parts.')
  const metadata = parsed[0]!.metadata
  for (const p of [first, ...parsed.slice(1)]) {
    if (p.tokenizerFingerprint && parsed[0]!.tokenizerFingerprint && p.tokenizerFingerprint !== parsed[0]!.tokenizerFingerprint) bad('Conflicting split tokenizer metadata.')
    for (const [key, value] of p.metadata) {
      if (key.startsWith('split.') || key === 'general.alignment') continue
      if (metadata.has(key) && value !== metadata.get(key)) bad('Conflicting metadata in GGUF split group.')
    }
  }
  const architecture = metadata.get('general.architecture')
  if (typeof architecture !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(architecture)) throw new GgufError('GGUF model architecture is missing or invalid.')
  if (metadata.get('general.type') !== undefined && metadata.get('general.type') !== 'model') bad('GGUF adapters are not standalone text models.')
  const context = metadata.get(`${architecture}.context_length`)
  if (context !== undefined && !integer(context, 100_000_000)) bad('Invalid GGUF context length.')
  const fileType = metadata.get('general.file_type')
  if (fileType !== undefined && (typeof fileType !== 'number' || !Number.isSafeInteger(fileType) || fileType < 0)) bad('Invalid GGUF quantization metadata.')
  const quant = typeof fileType === 'number' ? quants[fileType] ?? 'UNKNOWN' : 'UNKNOWN'
  const rawName = metadata.get('general.name')
  const name = typeof rawName === 'string' && rawName.trim() ? [...rawName].filter(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127).join('').trim().slice(0, 512) : 'Imported GGUF'
  let kvBytesPerToken: number | undefined
  if (['llama', 'qwen2', 'qwen3', 'mistral'].includes(architecture)) {
    const get = (suffix: string): Scalar => metadata.get(`${architecture}.${suffix}`)
    const layers = get('block_count'), embedding = get('embedding_length'), heads = get('attention.head_count'), kvHeads = get('attention.head_count_kv')
    if (integer(layers, 10_000) && integer(embedding, 1_000_000) && integer(heads, 100_000) && integer(kvHeads, heads) && embedding % heads === 0) {
      const key = get('attention.key_length') ?? embedding / heads, value = get('attention.value_length') ?? embedding / heads
      if (integer(key, 1_000_000) && integer(value, 1_000_000)) kvBytesPerToken = 2 * layers * kvHeads * (key + value)
    }
  }
  const groupHash = createHash('sha256')
  let done = 0
  for (const part of parts) {
    part.sha256 = await hashGgufFile(part.path, part.fingerprint, { signal: options.signal, onProgress: p => options.onProgress?.({ done: done + p.done, total: bytes, phase: 'read' }) }, groupHash)
    done += part.bytes
  }
  for (const part of parts) await assertGgufUnchanged(part.path, part.fingerprint)
  checkGgufSignal(options.signal)
  return { name, quant, architecture, contextMax: context as number | undefined, kvBytesPerToken, params: elements / 1e9, files: parts.map(p => p.path), bytes, sha256: groupHash.digest('hex'), parts, version: parsed[0]!.version, tensorCount: tensors, tokenizerFingerprint: parsed[0]!.tokenizerFingerprint }
}
