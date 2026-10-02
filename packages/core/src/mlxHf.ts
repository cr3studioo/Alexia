// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { HfError, resolveUrl, type HfHit, type HfOptions } from './hf.js'
import type { Quantized } from './localCatalog.js'

export interface MlxRepo {
  repo: string
  revision: string
  params?: number
  contextMax?: number
  kvBytesPerToken?: number
  architecture: string
  tokenizerFingerprint: string
  licence?: string
  gated: boolean
  quants: Quantized[]
}
const HUB = 'https://huggingface.co'
const hash = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex')
const obj = (x: unknown): Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x) ? x as Record<string, unknown> : {}
const positive = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x > 0
const access = (x: unknown): boolean => x === true || x === 'auto' || x === 'manual'
/** The bridge currently supports the audited dense Qwen3 architecture only. */
export const MLX_ARCHITECTURES = ['qwen3'] as const
export function mlxSafeFile(name: string): boolean {
  return /^(?:model(?:-\d{5}-of-\d{5})?\.safetensors|model\.safetensors\.index\.json|config\.json|generation_config\.json|tokenizer\.json|tokenizer_config\.json|special_tokens_map\.json|added_tokens\.json|vocab\.json|merges\.txt|chat_template\.jinja)$/.test(name)
}
/** Refuse the custom Python model escape hatch present in older mlx-lm loaders. */
export function assertMlxConfig(config: unknown): Record<string, unknown> {
  const c = obj(config)
  const scan = (x: unknown): void => {
    if (Array.isArray(x)) { x.forEach(scan); return }
    if (typeof x !== 'object' || x === null) return
    for (const [key, value] of Object.entries(x)) {
      if (['model_file', 'auto_map', 'custom_pipelines'].includes(key)) throw new HfError('invalid', 'MLX custom model or tokenizer code is not supported.')
      scan(value)
    }
  }
  scan(c)
  if (!MLX_ARCHITECTURES.some((a) => a === c.model_type)) throw new HfError('invalid', 'This MLX architecture is not supported by the pinned runner.')
  if (!positive(c.max_position_embeddings) || !positive(c.num_hidden_layers) || !positive(c.num_key_value_heads) || !positive(c.head_dim)) {
    throw new HfError('invalid', 'MLX configuration is missing context or attention dimensions.')
  }
  return c
}
async function bytes(url: string, options: HfOptions, limit = 32 * 1024 * 1024): Promise<{ data: Buffer; link: string | null }> {
  const timeout = options.timeoutMs ?? 30_000
  if (!positive(timeout)) throw new HfError('invalid', 'Invalid Hugging Face timeout.')
  const signal = AbortSignal.any([AbortSignal.timeout(timeout), ...(options.signal ? [options.signal] : [])])
  signal.throwIfAborted()
  const response = await (options.fetch ?? fetch)(url, { signal, redirect: new URL(url).pathname.includes('/resolve/') ? 'follow' : 'error', headers: options.token ? { authorization: `Bearer ${options.token}` } : {} })
  if (!response.ok) { await response.body?.cancel(); throw new HfError('http', `Hugging Face answered ${response.status}.`, response.status) }
  if (!response.body) throw new HfError('http', 'Hugging Face returned an empty response.')
  const reader = response.body.getReader()
  let total = 0
  const parts: Buffer[] = []
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > limit) throw new HfError('invalid', 'MLX metadata is too large.')
      parts.push(Buffer.from(value))
    }
    return { data: Buffer.concat(parts), link: response.headers.get('link') }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}
async function json(url: string, options: HfOptions): Promise<{ value: unknown; link: string | null }> {
  const result = await bytes(url, options)
  try { return { value: JSON.parse(result.data.toString()) as unknown, link: result.link } }
  catch { throw new HfError('http', 'Hugging Face returned invalid JSON.') }
}
async function pages(url: string, options: HfOptions): Promise<unknown[]> {
  const path = new URL(url).pathname
  const seen = new Set<string>()
  const rows: unknown[] = []
  let next: string | undefined = url
  while (next) {
    if (seen.has(next) || seen.size >= 100) throw new HfError('http', 'Invalid Hugging Face pagination.')
    seen.add(next)
    const { value, link } = await json(next, options)
    if (!Array.isArray(value)) throw new HfError('http', 'Invalid Hugging Face listing.')
    rows.push(...value)
    const raw = link?.split(/,(?=\s*<)/).find((part) => /;\s*rel="?next"?/.test(part))?.match(/<([^>]+)>/)?.[1]
    next = undefined
    if (raw) {
      const candidate = new URL(raw, url)
      if (candidate.origin !== HUB || candidate.pathname !== path || candidate.username || candidate.password || candidate.hash) throw new HfError('http', 'Unsafe Hugging Face pagination.')
      next = candidate.href
    }
  }
  return rows
}
export async function repo(id: string, options: HfOptions & { revision?: string } = {}): Promise<MlxRepo> {
  // Reuse the GGUF client's strict repository and immutable path validation.
  resolveUrl(id, '0'.repeat(40), 'config.json')
  if (options.revision && !/^[a-f0-9]{40}$/i.test(options.revision)) throw new HfError('invalid', 'MLX revisions must be full commits.')
  const suffix = options.revision ? `/revision/${options.revision}` : ''
  const metadata = obj((await json(`${HUB}/api/models/${id}${suffix}`, options)).value)
  if (typeof metadata.sha !== 'string' || !/^[a-f0-9]{40}$/i.test(metadata.sha) || (options.revision && metadata.sha.toLowerCase() !== options.revision.toLowerCase())) throw new HfError('http', 'Invalid pinned Hugging Face revision.')
  const revision = metadata.sha.toLowerCase()
  const rows = await pages(`${HUB}/api/models/${id}/tree/${revision}?recursive=true`, options)
  const files: Quantized['files'] = []
  const contents = new Map<string, Buffer>()
  const seen = new Set<string>()
  for (const row of rows) {
    const f = obj(row)
    if (f.type !== 'file' || typeof f.path !== 'string' || !mlxSafeFile(f.path)) continue
    if (seen.has(f.path)) throw new HfError('http', 'Duplicate MLX file metadata.')
    seen.add(f.path)
    const lfs = obj(f.lfs)
    const size = lfs.size ?? f.size
    if (!positive(size) || (f.size !== undefined && f.size !== size)) throw new HfError('http', 'Invalid MLX file size.')
    let sha256: string
    if (typeof lfs.oid === 'string' && /^[a-f0-9]{64}$/i.test(lfs.oid)) sha256 = lfs.oid.toLowerCase()
    else {
      if (f.path.endsWith('.safetensors')) throw new HfError('invalid', 'MLX weights need a published SHA-256 checksum.')
      const data = (await bytes(resolveUrl(id, revision, f.path), options)).data
      if (data.length !== size) throw new HfError('http', 'MLX metadata length mismatch.')
      contents.set(f.path, data)
      sha256 = hash(data)
    }
    files.push({ name: f.path, bytes: size, sha256 })
  }
  for (const name of ['config.json', 'tokenizer.json', 'tokenizer_config.json']) if (!seen.has(name)) throw new HfError('invalid', `MLX repository is missing ${name}.`)
  const readJson = async (name: string): Promise<Record<string, unknown>> => {
    const data = contents.get(name) ?? (await bytes(resolveUrl(id, revision, name), options)).data
    const file = files.find((f) => f.name === name)!
    if (hash(data) !== file.sha256 || data.length !== file.bytes) throw new HfError('http', 'MLX metadata checksum mismatch.')
    try { return obj(JSON.parse(data.toString())) } catch { throw new HfError('invalid', 'Invalid MLX configuration JSON.') }
  }
  const config = assertMlxConfig(await readJson('config.json'))
  const tokenizerConfig = await readJson('tokenizer_config.json')
  if (tokenizerConfig.auto_map || tokenizerConfig.model_file) throw new HfError('invalid', 'Custom tokenizer code is not supported.')
  const weights = files.filter((f) => f.name.endsWith('.safetensors'))
  if (!weights.length) throw new HfError('invalid', 'MLX repository has no safetensors weights.')
  if (seen.has('model.safetensors.index.json')) {
    const index = await readJson('model.safetensors.index.json')
    const shards = new Set(Object.values(obj(index.weight_map)))
    if (!shards.size || [...shards].some((s) => typeof s !== 'string' || !weights.some((f) => f.name === s)) || weights.some((f) => !shards.has(f.name))) throw new HfError('invalid', 'MLX weight shards are incomplete.')
  } else if (weights.length !== 1 || weights[0]!.name !== 'model.safetensors') throw new HfError('invalid', 'Sharded MLX weights require an index.')
  const quantization = obj(config.quantization ?? config.quantization_config)
  if (![4, 8].includes(Number(quantization.bits))) throw new HfError('invalid', 'Only audited 4-bit and 8-bit MLX quantizations are supported.')
  const kvBytesPerToken = 4 * Number(config.num_hidden_layers) * Number(config.num_key_value_heads) * Number(config.head_dim)
  if (!positive(kvBytesPerToken)) throw new HfError('invalid', 'Invalid MLX memory dimensions.')
  const total = obj(metadata.safetensors).total
  const licence = obj(metadata.cardData).license
  const fingerprint = hash(JSON.stringify([files.find((f) => f.name === 'tokenizer.json')!.sha256, config.bos_token_id ?? null, config.eos_token_id ?? null, config.vocab_size ?? null]))
  files.sort((a, b) => a.name.localeCompare(b.name))
  return { repo: id, revision, gated: access(metadata.gated), architecture: String(config.model_type), tokenizerFingerprint: fingerprint,
    ...(positive(total) && { params: total / 1e9 }), contextMax: Number(config.max_position_embeddings), kvBytesPerToken,
    ...(typeof licence === 'string' && { licence }), quants: [{ quant: `MLX_${quantization.bits}BIT`, bytes: files.reduce((n, f) => n + f.bytes, 0), files }] }
}
export async function search(query: string, options: HfOptions = {}): Promise<HfHit[]> {
  if (!query.trim()) return []
  const args = new URLSearchParams({ search: query.trim(), filter: 'mlx', pipeline_tag: 'text-generation', sort: 'downloads', direction: '-1', limit: '30' })
  const result: HfHit[] = []
  for (const row of await pages(`${HUB}/api/models?${args}`, options)) {
    const m = obj(row)
    const id = m.id ?? m.modelId
    if (typeof id !== 'string') continue
    try { resolveUrl(id, '0'.repeat(40), 'config.json') } catch { continue }
    if (!result.some((r) => r.repo === id)) result.push({ repo: id, gated: access(m.gated), downloads: positive(m.downloads) ? m.downloads : 0, likes: positive(m.likes) ? m.likes : 0 })
  }
  return result
}
