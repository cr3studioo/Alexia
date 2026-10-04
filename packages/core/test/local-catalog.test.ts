// SPDX-License-Identifier: AGPL-3.0-only
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, test, vi } from 'vitest'
import { entry, LOCAL_CATALOG, QUANT_NOTES } from '../src/localCatalog.js'

const script = await import(pathToFileURL(join(import.meta.dirname, '../../../scripts/local-catalog.mjs')).href)
const { group, kvFromConfig, quantOf, tree, checkEntries } = script
const hash = 'a'.repeat(64)
const revision = 'a'.repeat(40)
const file = (path: string, bytes = 10) => ({ type: 'file', path, size: bytes, lfs: { size: bytes, oid: hash } })
afterEach(() => vi.unstubAllGlobals())

test('curated entries have unique identities, immutable pins, provenance, and actual content hash metadata', () => {
  expect(LOCAL_CATALOG.length).toBeGreaterThanOrEqual(9)
  expect(new Set(LOCAL_CATALOG.map((e) => e.id)).size).toBe(LOCAL_CATALOG.length)
  for (const e of LOCAL_CATALOG) {
    expect(entry(e.id)).toBe(e)
    expect(e.revision).toMatch(/^[a-f0-9]{40}$/)
    expect(e.source?.revision).toMatch(/^[a-f0-9]{40}$/)
    expect(e.source?.configUrl).toContain(e.source!.revision)
    expect(e.licence.url).toMatch(/^https:\/\/huggingface\.co\//)
    expect(e.licence.name).toBe('apache-2.0')
    expect(e.licence.restrictive).toBe(false)
    expect(e.params).toBeGreaterThan(0)
    expect(e.kvBytesPerToken).toBeGreaterThan(0)
    expect(e.quants.length).toBeGreaterThanOrEqual(3)
    expect(new Set(e.quants.map((q) => q.quant)).size).toBe(e.quants.length)
    for (const q of e.quants) {
      expect(QUANT_NOTES[q.quant]).toBeTruthy()
      expect(q.bytes).toBe(q.files.reduce((sum, f) => sum + f.bytes, 0))
      for (const f of q.files) {
        expect(f.sha256).toMatch(/^[a-f0-9]{64}$/)
        expect(Number.isSafeInteger(f.bytes) && f.bytes > 0).toBe(true)
        expect(f.name).toMatch(/\.gguf$/)
        expect(f.name).not.toMatch(/^\/|\.\.|\\/)
      }
    }
  }
  expect(entry('not-a-model')).toBeUndefined()
})

test('abliterated builds are separate opted-in entries; text plans never advertise missing projectors', () => {
  const modified = LOCAL_CATALOG.filter((e) => e.abliterated)
  expect(modified.length).toBeGreaterThanOrEqual(2)
  for (const e of modified) {
    expect(e.repo).toMatch(/abliterated/)
    expect(e.nsfwOk).toBe('yes')
    expect(e.tools).toBe(false)
  }
  // Vision is exactly the entries that bring a pinned projector; the rest are text only.
  for (const e of LOCAL_CATALOG) {
    expect(e.vision).toBe(e.projector !== undefined)
    if (e.projector) {
      expect(e.projector.name).toMatch(/mmproj.*\.gguf$/)
      expect(e.projector.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(e.projector.bytes).toBeGreaterThan(0)
    }
  }
  expect(LOCAL_CATALOG.filter((e) => !e.abliterated).every((e) => e.nsfwOk === 'no')).toBe(true)
  expect(QUANT_NOTES).not.toHaveProperty('tokensPerSecond')
})

test('quant matching excludes projectors, draft heads, extra suffixes and non-GGUF files', () => {
  expect(quantOf('Q4_K_M/model.Q4_K_M.gguf')).toBe('Q4_K_M')
  expect(quantOf('model-Q6_K.gguf')).toBe('Q6_K')
  for (const name of ['mmproj-Q8_0.gguf', 'draft-Q4_K_M.gguf', 'mtp-Q8_0.gguf', 'model-Q6_K_L.gguf', 'model-Q4_K_M.txt', 'model-Q4_K_M_foo.gguf']) expect(quantOf(name)).toBeUndefined()
})

test('split quants require a full ordered set, no duplicates, no missing numbers and no mixed stems', () => {
  const a1 = file('a-Q4_K_M-00001-of-00002.gguf', 10)
  const a2 = file('a-Q4_K_M-00002-of-00002.gguf', 20)
  const b2 = file('b-Q4_K_M-00002-of-00002.gguf', 30)
  expect(group([a2, a1])[0]).toMatchObject({ quant: 'Q4_K_M', bytes: 30, files: [{ name: a1.path }, { name: a2.path }] })
  expect(group([a1, b2])).toEqual([])
  expect(group([a1, a1])).toEqual([])
  expect(group([file('a-Q4_K_M-00000-of-00002.gguf'), a2])).toEqual([])
  expect(group([a1, file('a-Q4_K_M-00002-of-00003.gguf')])).toEqual([])
  const whole = file('m-Q4_K_M.gguf', 40)
  expect(group([a1, a2, whole])[0].files).toHaveLength(1)
  expect(group([a1, a2, whole])[0].files[0].name).toBe(whole.path)
})

test('invalid paths, blob oids, missing LFS content hashes and invalid sizes cannot enter the catalog', () => {
  expect(group([file('../m-Q4_K_M.gguf'), file('/m-Q4_K_M.gguf'), file('m-Q4_K_M.gguf', 0),
    { ...file('m-Q4_K_M.gguf'), lfs: { size: 10, oid: revision } },
    { path: 'm-Q4_K_M.gguf', size: 10, oid: hash },
  ])).toEqual([])
  const a = file('z-Q4_K_M.gguf')
  const b = file('a-Q4_K_M.gguf')
  expect(group([a, b])).toEqual(group([b, a]))
})

test('config-derived FP16 KV uses key/value heads rather than query heads and covers dense and MoE models', () => {
  expect(kvFromConfig({ model_type: 'qwen3', num_hidden_layers: 36, num_key_value_heads: 8, head_dim: 128 })).toBe(147456)
  expect(kvFromConfig({ model_type: 'qwen3_moe', num_hidden_layers: 48, num_key_value_heads: 4, head_dim: 128 })).toBe(98304)
  expect(kvFromConfig({ model_type: 'mistral', num_hidden_layers: 32, num_key_value_heads: 8, num_attention_heads: 32, hidden_size: 4096 })).toBe(131072)
  expect(kvFromConfig({ model_type: 'unknown', num_hidden_layers: 32, num_key_value_heads: 8, head_dim: 128 })).toBeUndefined()
  expect(kvFromConfig({ model_type: 'qwen3', num_hidden_layers: 0, num_key_value_heads: 8, head_dim: 128 })).toBeUndefined()
})

test('official tree pagination is followed at the immutable pin, and foreign/repeating links are rejected', async () => {
  const first = `https://huggingface.co/api/models/test/model/tree/${revision}?recursive=true`
  const next = `${first}&cursor=two`
  const fetcher = vi.fn(async (url: string) => url === first
    ? Response.json([file('m-Q4_K_M.gguf')], { headers: { link: `<${next}>; rel="next"` } })
    : Response.json([file('m-Q5_K_M.gguf')]))
  vi.stubGlobal('fetch', fetcher)
  expect(await tree('test/model', revision)).toHaveLength(2)
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([first, next])
  vi.stubGlobal('fetch', async () => Response.json([], { headers: { link: '<https://example.com/token>; rel="next"' } }))
  await expect(tree('test/model', revision)).rejects.toThrow('pagination')
  vi.stubGlobal('fetch', async () => Response.json([], { headers: { link: `<${first}>; rel="next"` } }))
  await expect(tree('test/model', revision)).rejects.toThrow('pagination')
  await expect(tree('test/model', 'main')).rejects.toThrow('immutable')
})

test('check reports a bad file without a false success, continues other entries and permits main to advance', async () => {
  vi.stubGlobal('fetch', async (url: string) => url.includes('/tree/') ? Response.json([file('m-Q4_K_M.gguf')]) : Response.json({ sha: 'b'.repeat(40) }))
  const seed = { id: 'good', repo: 'test/model', revision, quants: [{ quant: 'Q4_K_M', bytes: 10, files: [{ name: 'm-Q4_K_M.gguf', bytes: 10, sha256: hash }] }] }
  const bad = { ...seed, id: 'bad', quants: [{ ...seed.quants[0]!, bytes: 11, files: [{ ...seed.quants[0]!.files[0]!, bytes: 11 }] }] }
  const log = vi.fn()
  expect(await checkEntries([bad, seed], log)).toBe(1)
  expect(log.mock.calls.flat().join('\n')).toContain('✓ good')
  expect(log.mock.calls.flat().join('\n')).not.toContain('✓ bad')
  expect(log.mock.calls.flat().join('\n')).toContain('pin remains')
})

test('check rejects changed KV config metadata and contains HTTP errors per entry', async () => {
  const seed = { ...entry('qwen3-8b')!, quants: [] }
  vi.stubGlobal('fetch', async (url: string) => url.includes('/tree/') ? Response.json([]) : Response.json({ model_type: 'unknown' }))
  expect(await checkEntries([seed], () => {})).toBe(1)
  vi.stubGlobal('fetch', async () => new Response('', { status: 403 }))
  expect(await checkEntries([seed, seed], () => {})).toBe(2)
})
