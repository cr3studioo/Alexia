// SPDX-License-Identifier: AGPL-3.0-only
import type { Quantized } from './localCatalog.js'

const HUB = 'https://huggingface.co'
const COMMIT = /^[a-f0-9]{40}$/i
const SHA256 = /^[a-f0-9]{64}$/i

export interface HfOptions {
  token?: string
  signal?: AbortSignal
  /** Per request, including its JSON body. Default: 30 seconds. */
  timeoutMs?: number
  fetch?: typeof fetch
}

export interface HfHit {
  repo: string
  downloads: number
  likes: number
  gated: boolean
}

export interface HfRepo {
  repo: string
  revision: string
  licence?: string
  gated: boolean
  /** Billions of parameters, matching LocalEntry.params. */
  params?: number
  quants: Quantized[]
}

export class HfError extends Error {
  constructor(readonly kind: 'invalid' | 'http' | 'aborted' | 'timeout', message: string, readonly status?: number) {
    super(message)
    this.name = 'HfError'
  }
}

function validRepo(id: string): void {
  const segments = id.split('/')
  if (segments.length !== 2 || segments.some((s) => s.length > 96 || !/^[\w](?:[\w.-]*[\w])?$/.test(s) || /\.\.|--|\.git$/i.test(s))) {
    throw new HfError('invalid', 'Use a Hugging Face repository name in the form owner/model.')
  }
}

function validPath(path: string): void {
  // These names also become local paths. Reject both POSIX and Windows traversal/aliases,
  // including escaped separators; encoding a malicious path into a URL is not validation.
  const control = [...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  if (!path || control || /[\\%<>:"|?*]/.test(path) || path.split('/').some((s) =>
    !s || s === '.' || s === '..' || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))) {
    throw new HfError('invalid', 'The repository contains an unsafe file path.')
  }
}

function validRevision(revision: string): void {
  if (!/^[\w][\w./-]*$/.test(revision) || revision.includes('..') || revision.split('/').some((s) => !s || s === '.')) {
    throw new HfError('invalid', 'Invalid Hugging Face revision.')
  }
}

/** Only immutable commits are allowed in download URLs. Encode each filename segment. */
export function resolveUrl(repo: string, revision: string, path: string): string {
  validRepo(repo)
  if (!COMMIT.test(revision)) throw new HfError('invalid', 'A download must be pinned to a full commit hash.')
  validPath(path)
  return `${HUB}/${repo}/resolve/${revision.toLowerCase()}/${path.split('/').map(encodeURIComponent).join('/')}`
}

const object = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

function gated(value: unknown): boolean { return value === true || value === 'auto' || value === 'manual' }
const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0

async function json(url: string, options: HfOptions): Promise<{ body: unknown; link: string | null }> {
  const { timeoutMs = 30_000, signal } = options
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new HfError('invalid', 'Invalid Hugging Face timeout.')
  if (signal?.aborted) throw new HfError('aborted', 'The Hugging Face request was cancelled.')
  const controller = new AbortController()
  let fail!: (reason: unknown) => void
  const stopped = new Promise<never>((_, reject) => { fail = reject })
  const stop = (reason: HfError) => {
    if (controller.signal.aborted) return
    controller.abort(reason)
    fail(reason)
  }
  const abort = () => stop(new HfError('aborted', 'The Hugging Face request was cancelled.'))
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => stop(new HfError('timeout', 'Hugging Face stopped responding. Please try again.')), timeoutMs)
  let response: Response | undefined
  const cancel = (res: Response) => { if (!res.body?.locked) void res.body?.cancel().catch(() => {}) }
  try {
    const request = (options.fetch ?? fetch)(url, {
      signal: controller.signal,
      // API pages should never redirect an authenticated request to an arbitrary host.
      redirect: 'error',
      headers: { accept: 'application/json', ...(options.token !== undefined && { authorization: `Bearer ${options.token}` }) },
    })
    void request.then((late) => { if (controller.signal.aborted) cancel(late) }, () => {})
    response = await Promise.race([request, stopped])
    if (!response.ok) {
      const access = response.status === 401 || response.status === 403
      throw new HfError('http', access
        ? 'Hugging Face requires access to this repository. Add a token and accept its access terms on Hugging Face.'
        : `Hugging Face answered ${response.status}. Please try again.`, response.status)
    }
    const body: unknown = await Promise.race([response.json(), stopped])
    return { body, link: response.headers.get('link') }
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason
    if (error instanceof HfError) throw error
    // Do not repeat transport errors: they can contain URLs, headers, or a caller's token.
    throw new HfError('http', 'Could not read the Hugging Face response. Please try again.')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    if (response) cancel(response)
  }
}

function nextPage(link: string | null, current: string, expectedPath: string): string | undefined {
  if (!link) return undefined
  let next: string | undefined
  for (const entry of link.split(/,(?=\s*<)/)) {
    const target = /^\s*<([^>]+)>/.exec(entry)?.[1]
    const relation = /;\s*rel\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(entry)
    if (!relation || !(relation[1] ?? relation[2] ?? '').split(/\s+/).includes('next')) continue
    if (!target || next !== undefined) throw new HfError('http', 'Invalid Hugging Face pagination.')
    let url: URL
    try { url = new URL(target, current) } catch { throw new HfError('http', 'Invalid Hugging Face pagination URL.') }
    if (url.origin !== HUB || url.username || url.password || url.hash || url.pathname !== expectedPath) {
      throw new HfError('http', 'Hugging Face returned an unsafe pagination link.')
    }
    next = url.href
  }
  return next
}

async function pages(url: string, options: HfOptions): Promise<unknown[]> {
  const path = new URL(url).pathname
  const visited = new Set<string>()
  const rows: unknown[] = []
  let next: string | undefined = url
  while (next !== undefined) {
    if (visited.has(next) || visited.size >= 10_000) throw new HfError('http', 'Hugging Face pagination did not finish.')
    visited.add(next)
    const { body, link } = await json(next, options)
    if (!Array.isArray(body)) throw new HfError('http', 'Hugging Face returned an invalid listing.')
    rows.push(...body)
    next = nextPage(link, next, path)
  }
  return rows
}

/** GGUF model weights only; projection weights are installed separately. */
export function quantOf(path: string): string | undefined {
  const base = path.split('/').at(-1) ?? ''
  if (!/\.gguf$/i.test(base) || /mmproj|projector/i.test(base)) return undefined
  const stem = base.replace(/(?:-\d+-of-\d+)?\.gguf$/i, '')
  // Take the entire token, so Q6_K_L and UD-Q4_K_XL never collapse into Q6_K/Q4_K.
  return /(?:^|[-._])((?:UD-)?(?:IQ\d|Q\d)(?:_[A-Z0-9]+)*|BF16|F16|F32|FP16|FP32)(?=$|[-.])/i.exec(stem)?.[1]?.toUpperCase()
}

/** Group by filename stem and directory first; never join shards from different builds. */
export function group(rows: unknown[]): Quantized[] {
  type File = Quantized['files'][number]
  type Build = { quant: string; files: Map<number, File>; of: number; invalid: boolean; key: string }
  const builds = new Map<string, Build>()
  const seen = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const row of rows) {
    const f = object(row)
    if (f.type !== 'file' || typeof f.path !== 'string' || !/\.gguf$/i.test(f.path)) continue
    validPath(f.path)
    const quant = quantOf(f.path)
    if (!quant) continue
    const lfs = object(f.lfs)
    const bytes = lfs.size ?? f.size
    if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0) continue
    if (lfs.size !== undefined && f.size !== undefined && lfs.size !== f.size) continue
    // Git blob OIDs and Xet hashes are not SHA-256 content checksums.
    const sha256 = typeof lfs.oid === 'string' && SHA256.test(lfs.oid) ? lfs.oid.toLowerCase() : ''
    const file: File = { name: f.path, bytes, sha256 }
    const fingerprint = JSON.stringify(file)
    if (seen.has(f.path)) {
      if (seen.get(f.path) !== fingerprint) ambiguous.add(f.path)
      continue
    }
    seen.set(f.path, fingerprint)
    const split = /-(\d+)-of-(\d+)\.gguf$/i.exec(f.path)
    const index = split ? Number(split[1]) : 1
    const of = split ? Number(split[2]) : 1
    // A shard-looking name that failed the split parser must not become a whole model.
    if (!split && /-of-/i.test(f.path)) continue
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(of) || index < 1 || of < 1 || index > of) continue
    const key = split ? f.path.slice(0, split.index) : f.path
    const build = builds.get(key) ?? { quant, files: new Map<number, File>(), of, invalid: false, key }
    if (build.of !== of || build.files.has(index)) build.invalid = true
    build.files.set(index, file)
    builds.set(key, build)
  }
  const candidates = [...builds.values()].filter((b) => !b.invalid && b.files.size === b.of &&
    [...b.files.values()].every((f) => !ambiguous.has(f.name)))
  // A quant must select one complete build. Prefer a whole file, then a shorter path.
  candidates.sort((a, b) => Number(a.of > 1) - Number(b.of > 1) || a.key.length - b.key.length || a.key.localeCompare(b.key))
  const result = new Map<string, Quantized>()
  for (const b of candidates) {
    if (result.has(b.quant)) continue
    const files = [...b.files.entries()].sort(([a], [b]) => a - b).map(([, file]) => file)
    const bytes = files.reduce((sum, f) => sum + f.bytes, 0)
    if (Number.isSafeInteger(bytes)) result.set(b.quant, { quant: b.quant, bytes, files })
  }
  return [...result.values()].sort((a, b) => a.bytes - b.bytes || a.quant.localeCompare(b.quant))
}

export async function repo(id: string, options: HfOptions & { revision?: string } = {}): Promise<HfRepo> {
  validRepo(id)
  if (options.revision !== undefined) validRevision(options.revision)
  const suffix = options.revision === undefined ? '' : `/revision/${encodeURIComponent(options.revision)}`
  const metadata = object((await json(`${HUB}/api/models/${id}${suffix}`, options)).body)
  if (typeof metadata.sha !== 'string' || !COMMIT.test(metadata.sha)) throw new HfError('http', 'Hugging Face did not provide a full commit hash.')
  const revision = metadata.sha.toLowerCase()
  if (options.revision !== undefined && COMMIT.test(options.revision) && options.revision.toLowerCase() !== revision) {
    throw new HfError('http', 'Hugging Face returned a different commit than requested.')
  }
  const rows = await pages(`${HUB}/api/models/${id}/tree/${revision}?recursive=true`, options)
  const card = object(metadata.cardData)
  const tags = Array.isArray(metadata.tags) ? metadata.tags : []
  const licence = typeof card.license === 'string' ? card.license : tags.find((tag): tag is string => typeof tag === 'string' && tag.startsWith('license:'))?.slice(8)
  const gguf = object(metadata.gguf)
  const safetensors = object(metadata.safetensors)
  const params = count(gguf.total ?? safetensors.total) / 1e9
  return {
    repo: id, revision, gated: gated(metadata.gated),
    ...(licence && { licence }), ...(params > 0 && { params }), quants: group(rows),
  }
}

export async function search(query: string, options: HfOptions = {}): Promise<HfHit[]> {
  if (options.signal?.aborted) throw new HfError('aborted', 'The Hugging Face request was cancelled.')
  if (!query.trim()) return []
  const params = new URLSearchParams({ search: query.trim(), filter: 'gguf', sort: 'downloads', direction: '-1', limit: '30' })
  const rows = await pages(`${HUB}/api/models?${params}`, options)
  const found = new Map<string, HfHit>()
  for (const row of rows) {
    const f = object(row)
    const id = f.id ?? f.modelId
    if (typeof id !== 'string') continue
    try { validRepo(id) } catch { continue }
    if (!found.has(id)) found.set(id, { repo: id, downloads: count(f.downloads), likes: count(f.likes), gated: gated(f.gated) })
  }
  return [...found.values()]
}
