// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdirSync, realpathSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Honestly, Model } from './catalog.js'
import { LOCAL_CATALOG } from './localCatalog.js'

/**
 * **The text models Alexia downloaded itself**, and what is known about each one.
 *
 * One small JSON file beside the model files, written only once a download has been checked.
 * A GGUF on the disk says nothing about whether it can use tools or what licence it came under,
 * and guessing either at chat time is how a chat-only model ends up pinned for a task that needs
 * tools. What the catalog, or the Hugging Face page, said at install time is written down here and
 * read back.
 *
 * Ollama's models are not in here; Ollama keeps its own list (`ollama.ts`).
 */

/** Where the model files and this list live: `<dataDir>/models/text`. */
export const modelsDir = (dataDir: string): string => join(existsSync(dataDir) ? realpathSync(dataDir) : dataDir, 'models', 'text')

const listFile = (dataDir: string): string => join(modelsDir(dataDir), 'installed.json')

export interface Installed {
  /** Older records are GGUF; MLX bundles contain safetensors and tokenizer/config data. */
  format?: 'gguf' | 'mlx'
  /** Imported references are never deleted when their registry entry is removed. */
  owned?: boolean
  imported?: boolean
  contextMax?: number
  kvBytesPerToken?: number
  lastUsedAt?: number
  kvCache?: 'f16' | 'q8_0' | 'q4_0'
  draftModelId?: string
  sha256?: string
  tokenizerFingerprint?: string
  architecture?: string
  backend?: 'cpu' | 'metal' | 'cuda' | 'vulkan'
  /**
   * The id the router, the pin and the Models table use: `<entry>:<quant>`, lower case —
   * `qwen3-8b:q4_k_m`. Shaped like an Ollama tag on purpose, so it reads as the same kind of thing.
   */
  id: string
  name: string
  /** The vetted catalog entry it came from, or absent for a Hugging Face search result. */
  entry?: string
  repo: string
  /** The commit the files were fetched at. */
  revision: string
  quant: string
  /** Absolute paths. More than one for a split GGUF; the first is what `llama-server -m` is given. */
  files: string[]
  bytes: number
  params?: number
  /** The context the server is started with, not the most the model could take. */
  context: number
  tools: boolean
  vision: boolean
  abliterated: boolean
  nsfwOk: Honestly
  licence?: string
  /** False for anything found through Hugging Face search rather than the vetted list. */
  vetted: boolean
  /** False until the post-install chat check succeeds. Absent on older registries. */
  ready?: boolean
  installedAt: number
  /** Tokens a second measured on this machine after install, when the speed test ran. */
  tokensPerSecond?: number
}

/** Everything installed, in the order it was installed. An unreadable list is an empty one. */
export function readInstalled(dataDir: string): Installed[] {
  const file = listFile(dataDir)
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return Array.isArray(parsed) ? parsed.filter(isInstalled).map(withCatalogLimits) : []
  } catch {
    return []
  }
}

/** Phase-one records stored the configured window, but not the model's actual limit. */
function withCatalogLimits(one: Installed): Installed {
  if (!one.vetted || one.imported || one.format === 'mlx') return one
  const entry = LOCAL_CATALOG.find((entry) => entry.id === one.entry && entry.repo === one.repo && entry.revision === one.revision &&
    entry.quants.some((quant) => quant.quant === one.quant && quant.bytes === one.bytes))
  if (!entry) return one
  return { ...one,
    ...(one.contextMax === undefined && entry.contextMax >= one.context && { contextMax: entry.contextMax }),
    ...(one.kvBytesPerToken === undefined && entry.kvBytesPerToken !== undefined && { kvBytesPerToken: entry.kvBytesPerToken }),
  }
}

/** Written to a temporary file and renamed into place after the full list is saved. */
export function writeInstalled(dataDir: string, all: readonly Installed[]): void {
  mkdirSync(modelsDir(dataDir), { recursive: true })
  const file = listFile(dataDir)
  writeFileSync(`${file}.tmp`, JSON.stringify(all, null, 2))
  renameSync(`${file}.tmp`, file)
}

/** Add one, replacing any earlier install under the same id. */
export function remember(dataDir: string, one: Installed): void {
  writeInstalled(dataDir, [...readInstalled(dataDir).filter((i) => i.id !== one.id), one])
}

/** Take one off the list. The files are the caller's to delete. */
export function forget(dataDir: string, id: string): Installed | undefined {
  const all = readInstalled(dataDir)
  const gone = all.find((i) => i.id === id)
  if (gone) writeInstalled(dataDir, all.filter((i) => i.id !== id))
  return gone
}

/** The provider id every model here is served by (`llama.ts` `LLAMA`). */
export const LLAMA_ID = 'llama'
export const MLX_ID = 'mlx'

/** An installed model as a catalog row: `T0`, free, and on this machine. */
export function asModel(one: Installed): Model {
  return {
    id: one.id,
    name: one.name,
    provider: one.format === 'mlx' ? MLX_ID : LLAMA_ID,
    tier: 'T0',
    priceIn: 0,
    priceOut: 0,
    context: one.context,
    supportsTools: one.tools,
    modality: ['text', ...(one.vision ? ['image'] : [])],
    nsfwOk: one.nsfwOk,
    trainsOnYourData: 'no',
    quant: one.quant,
    diskBytes: one.bytes,
    abliterated: one.abliterated,
    ...(one.params !== undefined && { params: one.params }),
  }
}

const isInstalled = (x: unknown): x is Installed => {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  return ['id', 'name', 'repo', 'revision', 'quant'].every((key) => typeof o[key] === 'string' && o[key] !== '') &&
    (o.format === undefined || ['gguf', 'mlx'].includes(String(o.format))) &&
    (o.format === 'mlx' ? String(o.id).startsWith('mlx/') : String(o.id).startsWith('llama/')) &&
    (o.kvCache === undefined || ['f16', 'q8_0', 'q4_0'].includes(String(o.kvCache))) &&
    (o.contextMax === undefined || typeof o.contextMax === 'number' && Number.isSafeInteger(o.contextMax) && o.contextMax >= Number(o.context)) &&
    (o.kvBytesPerToken === undefined || typeof o.kvBytesPerToken === 'number' && Number.isSafeInteger(o.kvBytesPerToken) && o.kvBytesPerToken > 0) &&
    ['owned', 'imported', 'ready'].every((key) => o[key] === undefined || typeof o[key] === 'boolean') &&
    (o.lastUsedAt === undefined || typeof o.lastUsedAt === 'number' && Number.isFinite(o.lastUsedAt) && o.lastUsedAt >= 0) &&
    (o.draftModelId === undefined || typeof o.draftModelId === 'string' && o.draftModelId.length > 0) &&
    Array.isArray(o.files) && o.files.length > 0 && o.files.every((file) => typeof file === 'string' && isAbsolute(file)) &&
    typeof o.context === 'number' && Number.isSafeInteger(o.context) && o.context > 0 &&
    typeof o.bytes === 'number' && Number.isSafeInteger(o.bytes) && o.bytes > 0 &&
    ['tools', 'vision', 'abliterated', 'vetted'].every((key) => typeof o[key] === 'boolean') &&
    ['yes', 'no', 'unknown'].includes(String(o.nsfwOk)) &&
    typeof o.installedAt === 'number' && Number.isFinite(o.installedAt)
}
