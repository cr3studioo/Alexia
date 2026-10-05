// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Where the numbers in `packages/core/src/localCatalog.ts` come from, and how to tell when they
 * have gone stale.
 *
 *   node scripts/local-catalog.mjs <repo> [<repo> …]   print a pinned revision and the quants
 *   node scripts/local-catalog.mjs --json <repo> …    JSON with pinned config/KV provenance
 *   node scripts/local-catalog.mjs --json --base <upstream> <repo>
 *     Explicitly curated upstream when the quantizer's API card omits base_model.
 *   node scripts/local-catalog.mjs                     the same, for every repo in the catalog
 *   node scripts/local-catalog.mjs --check             check every file the catalog names
 *
 * **Nobody types a hash.** A sha256 copied by hand is a download that fails its check on
 * somebody's machine, weeks later, with a message that blames them. Every hash, size and
 * revision in the catalog is this script's output pasted in, and `--check` is how to find out
 * whether a repository moved underneath it.
 *
 * Hugging Face answers both questions without a download. The model endpoint gives the current
 * commit and the licence; the tree at that commit gives every LFS file with its sha256
 * (`lfs.oid`) and size. --check compares every catalog file to the official tree at
 * that exact commit, and verifies config-derived FP16 KV sizes at the upstream pin.
 * API reference: https://huggingface.co/docs/hub/api
 *
 * No dependency: Node 24 fetches, and it strips the types off the catalog to import it.
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HF = 'https://huggingface.co'
const here = dirname(fileURLToPath(import.meta.url))
const catalogPath = join(here, '..', 'packages', 'core', 'src', 'localCatalog.ts')

/**
 * The quants the catalog offers, smallest first. Policy: offer three-bit variants only
 * above 20B. This is a storage/precision tradeoff, not a model quality benchmark.
 */
const WANTED = ['IQ3_M', 'Q3_K_M', 'Q4_K_M', 'Q5_K_M', 'Q6_K', 'Q8_0']

/** Billions of parameters from which the three-bit quants are offered at all. */
const BIG = 20

/**
 * The quant a filename is, or undefined. The name has to stand alone between separators, so
 * `Q6_K_L` (bartowski's Q6_K with an eight-bit embedding) is not read as `Q6_K`, and the
 * `mmproj` vision projector that sits beside the weights is never read as weights.
 */
export function quantOf(path) {
  const base = path.split('/').pop() ?? path
  if (/mmproj|mtp|draft/i.test(base) || !/\.gguf$/i.test(base)) return undefined
  const found = /(?:^|[-._])(IQ3_M|Q3_K_M|Q4_K_M|Q5_K_M|Q6_K|Q8_0)(?=[-.])/i.exec(base)
  return found?.[1]?.toUpperCase()
}

/** `-00002-of-00003.gguf`: the part and the count, or undefined for a single file. */
const partOf = (path) => {
  const found = /-(\d{5})-of-(\d{5})\.gguf$/i.exec(path)
  return found ? { part: Number(found[1]), of: Number(found[2]), stem: path.replace(/-\d{5}-of-\d{5}\.gguf$/i, '') } : undefined
}

async function json(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return { body: await res.json(), link: res.headers.get('link') }
}

export async function info(repo, revision) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`Invalid repo: ${repo}`)
  return (await json(`${HF}/api/models/${repo}${revision ? `/revision/${encodeURIComponent(revision)}` : ''}`)).body
}

/** Every file at a commit. The tree endpoint pages big repos through a `Link: …; rel="next"`. */
export async function tree(repo, revision) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error(`Not an immutable revision: ${revision}`)
  const files = []
  const seen = new Set()
  let url = `${HF}/api/models/${repo}/tree/${revision}?recursive=true`
  while (url) {
    if (seen.has(url) || new URL(url).origin !== HF) throw new Error(`Invalid pagination link: ${url}`)
    seen.add(url)
    const { body, link } = await json(url)
    if (!Array.isArray(body)) throw new Error(`Invalid tree response: ${url}`)
    files.push(...body.filter((f) => f.type === 'file'))
    url = /<([^>]+)>;\s*rel="?next"?/.exec(link ?? '')?.[1]
  }
  return files
}

/**
 * The wanted quants in a tree, each with its files — parts in order, first part first, because
 * `llama-server -m` is given the first and finds the rest beside it. A split quant with a part
 * missing is left out: half a model is not a smaller model.
 */
export function group(files) {
  const byQuant = new Map()
  for (const f of files) {
    if (typeof f.path !== 'string' || f.path.startsWith('/') || f.path.includes('\\') || f.path.split('/').some((p) => !p || p === '.' || p === '..')) continue
    const quant = quantOf(f.path)
    const hash = f.lfs?.oid?.replace(/^sha256:/, '')
    const bytes = f.lfs?.size ?? f.size
    if (!quant || !/^[a-f0-9]{64}$/.test(hash ?? '') || !Number.isSafeInteger(bytes) || bytes <= 0) continue
    const list = byQuant.get(quant) ?? []
    list.push({ name: f.path, bytes, sha256: hash })
    byQuant.set(quant, list)
  }
  const out = []
  for (const quant of WANTED) {
    const files = byQuant.get(quant) ?? []
    const candidates = files.filter((f) => !partOf(f.name)).map((f) => [f])
    const sets = new Map()
    for (const f of files) {
      const part = partOf(f.name)
      if (!part) continue
      const set = sets.get(part.stem) ?? []
      set.push(f)
      sets.set(part.stem, set)
    }
    for (const set of sets.values()) {
      set.sort((a, b) => partOf(a.name).part - partOf(b.name).part)
      const count = partOf(set[0].name).of
      if (count > 0 && set.length === count && set.every((f, i) => partOf(f.name).part === i + 1 && partOf(f.name).of === count)) candidates.push(set)
    }
    candidates.sort((a, b) => a.length - b.length || a[0].name.length - b[0].name.length || a[0].name.localeCompare(b[0].name))
    const list = candidates[0]
    if (!list) continue
    out.push({ quant, bytes: list.reduce((sum, f) => sum + f.bytes, 0), files: list })
  }
  return out
}

/** Full-attention FP16 K + V; no sliding-window or quantized cache savings. */
export function kvFromConfig(config) {
  if (!['qwen3', 'qwen3_moe', 'llama', 'mistral'].includes(config.model_type)) return undefined
  const dim = config.head_dim ?? config.hidden_size / config.num_attention_heads
  const heads = config.num_key_value_heads ?? config.num_attention_heads
  const layers = config.num_hidden_layers
  if (![dim, heads, layers].every((n) => Number.isSafeInteger(n) && n > 0)) return undefined
  return 2 * 2 * layers * heads * dim
}

export async function snapshot(repo, curatedBase) {
  const latest = await info(repo)
  const model = await info(repo, latest.sha)
  const params = (model.gguf?.total ?? 0) / 1e9
  const quants = group(await tree(repo, latest.sha)).filter((q) => params >= BIG || !q.quant.includes('3'))
  if (!quants.length) throw new Error(`No complete supported quants: ${repo}`)
  const card = model.cardData ?? {}
  const declaredBase = typeof card.base_model === 'string' ? card.base_model : card.base_model?.[0]
  if (declaredBase && curatedBase && declaredBase !== curatedBase) throw new Error('Curated upstream differs from the quantizer model card')
  const baseRepo = declaredBase ?? curatedBase
  let source, config, upstreamLicence
  if (baseRepo) {
    const base = await info(baseRepo)
    if (!/^[a-f0-9]{40}$/.test(base.sha)) throw new Error(`No upstream pin: ${baseRepo}`)
    const pinned = await info(baseRepo, base.sha)
    source = { repo: baseRepo, revision: base.sha, configUrl: `${HF}/${baseRepo}/raw/${base.sha}/config.json` }
    config = (await json(source.configUrl)).body
    upstreamLicence = pinned.cardData?.license
  }
  return {
    repo, revision: model.sha, params, contextMax: model.gguf?.context_length ?? 0,
    licence: card.license ?? upstreamLicence ?? 'unknown',
    licenceSource: card.license ? `${HF}/${repo}/blob/${model.sha}/README.md` : source ? `${HF}/${source.repo}/blob/${source.revision}/README.md` : undefined,
    gated: model.gated !== false, architecture: model.gguf?.architecture,
    source, config, kvBytesPerToken: config ? kvFromConfig(config) : undefined, quants,
  }
}

const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

function print(repo, model, quants) {
  const card = model.cardData ?? {}
  const gguf = model.gguf ?? {}
  const params = gguf.total ? Math.round(gguf.total / 1e8) / 10 : undefined
  const tools = typeof gguf.chat_template === 'string' ? /\btools\b/.test(gguf.chat_template) : undefined
  console.log(`  // ${repo}`)
  console.log(
    `  // licence ${card.license ?? '?'}${card.license_name ? ` (${card.license_name})` : ''} · gated ${model.gated} · base ${JSON.stringify(card.base_model ?? '?')}` +
      ` · arch ${gguf.architecture ?? '?'} · params ${params ?? '?'}B · context ${gguf.context_length ?? '?'} · template mentions tools: ${tools ?? '?'}`,
  )
  console.log(`  repo: ${q(repo)},`)
  console.log(`  revision: ${q(model.sha)},`)
  console.log('  quants: [')
  for (const one of quants) {
    console.log(`    {\n      quant: ${q(one.quant)},\n      bytes: ${one.bytes},\n      files: [`)
    for (const f of one.files) console.log(`        { name: ${q(f.name)}, bytes: ${f.bytes}, sha256: ${q(f.sha256)} },`)
    console.log('      ],\n    },')
  }
  console.log('  ],\n')
}

async function catalog() {
  const mod = await import(pathToFileURL(catalogPath).href)
  return mod.LOCAL_CATALOG
}

/**
 * Every file at its pinned commit must have the recorded size and content SHA-256.
 * A later main commit is news rather than a failure: it does not change a pinned download.
 */
export async function checkEntries(entries, log = console.log) {
  let drift = 0
  for (const entry of entries) {
    let problems = 0
    try {
      const files = new Map((await tree(entry.repo, entry.revision)).map((f) => [f.path, f]))
      for (const quant of entry.quants) {
        if (!quant.files.length || quant.bytes !== quant.files.reduce((sum, f) => sum + f.bytes, 0)) throw new Error(`Invalid total for ${quant.quant}`)
        for (const f of quant.files) {
          const actual = files.get(f.name)
          if (!/^[a-f0-9]{64}$/.test(f.sha256) || !Number.isSafeInteger(f.bytes) || f.bytes <= 0 || actual?.lfs?.oid?.replace(/^sha256:/, '') !== f.sha256 || (actual?.lfs?.size ?? actual?.size) !== f.bytes) {
            problems++
            log(`✗ ${entry.id} ${quant.quant} ${f.name}: pinned API metadata differs`)
          }
        }
      }
      if (entry.source) {
        const source = entry.source
        if (!/^[a-f0-9]{40}$/.test(source.revision) || source.configUrl !== `${HF}/${source.repo}/raw/${source.revision}/config.json`) throw new Error('Config source is not pinned')
        const config = (await json(source.configUrl)).body
        if (kvFromConfig(config) !== entry.kvBytesPerToken) throw new Error('Config-derived KV estimate differs')
      }
      const now = await info(entry.repo)
      if (now.sha !== entry.revision) log(`· ${entry.id}: main is ${now.sha}; pin remains ${entry.revision}`)
    } catch (error) {
      problems++
      log(`✗ ${entry.id}: ${String(error)}`)
    }
    drift += problems
    if (!problems) log(`✓ ${entry.id}`)
  }
  return drift
}

async function check() {
  const problems = await checkEntries(await catalog())
  console.log(problems ? `${problems} problem(s).` : 'All pinned files match the official API.')
  process.exitCode = problems ? 1 : 0
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--check')) return check()
  let curatedBase
  const baseIndex = args.indexOf('--base')
  if (baseIndex >= 0) {
    curatedBase = args[baseIndex + 1]
    if (!curatedBase || curatedBase.startsWith('--')) throw new Error('--base requires an upstream repository')
    args.splice(baseIndex, 2)
  }
  const explicit = args.filter((arg) => arg !== '--json')
  if (explicit.some((arg) => arg.startsWith('--'))) throw new Error('Usage: local-catalog.mjs [--json] [owner/repo ...] | --check')
  const repos = explicit.length > 0 ? explicit : [...new Set((await catalog()).map((e) => e.repo))]
  if (curatedBase && repos.length !== 1) throw new Error('--base requires exactly one GGUF repository')
  if (args.includes('--json')) {
    const results = []
    for (const repo of repos) results.push(await snapshot(repo, curatedBase ?? (explicit.length ? undefined : (await catalog()).find((e) => e.repo === repo)?.source?.repo)))
    console.log(JSON.stringify(results, null, 2))
    return
  }
  for (const repo of repos) {
    const latest = await info(repo)
    const model = await info(repo, latest.sha)
    const billions = (model.gguf?.total ?? 0) / 1e9
    const quants = group(await tree(repo, model.sha)).filter((one) => billions >= BIG || !one.quant.includes('3'))
    print(repo, model, quants)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
