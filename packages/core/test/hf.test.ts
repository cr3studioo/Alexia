// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { expect, test, vi } from 'vitest'
import { group, quantOf, repo, resolveUrl, search } from '../src/hf.js'

const commit = '0b69f75b7472688e6808490aa2b85efdb81b5ce7'
const id = 'bartowski/Qwen_Qwen3-8B-GGUF'
const hub = 'https://huggingface.co'
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/hf/${name}.json`, import.meta.url), 'utf8'))
const response = (body: unknown, headers: Record<string, string> = {}, status = 200) => new Response(JSON.stringify(body), { status, headers })
const mockFetch = (fn: (...args: Parameters<typeof fetch>) => Promise<Response>) => vi.fn(fn) as typeof fetch & ReturnType<typeof vi.fn>
const file = (path: string, size = 10, oid = 'a'.repeat(64)) => ({ type: 'file', path, size, lfs: { size, oid } })
const shard = (stem: string, i: number, n: number) => file(`${stem}-${String(i).padStart(5, '0')}-of-${String(n).padStart(5, '0')}.gguf`)

test('returns the expected catalog shape from real HF metadata and tree fixtures', async () => {
  const urls: string[] = []
  const get = mockFetch(async (input) => {
    urls.push(String(input))
    return response(urls.length === 1 ? fixture('model') : fixture('tree'))
  })
  const found = await repo(id, { fetch: get })
  expect(found).toMatchObject({ repo: id, revision: commit, licence: 'apache-2.0', gated: false, params: 8.19073536 })
  expect(found.quants.map((q) => q.quant)).toEqual(['IQ2_M', 'Q4_K_M', 'Q8_0', 'BF16'])
  expect(found.quants.find((q) => q.quant === 'Q4_K_M')).toEqual({ quant: 'Q4_K_M', bytes: 5027784224, files: [{
    name: 'Qwen_Qwen3-8B-Q4_K_M.gguf', bytes: 5027784224, sha256: '54fffa050078e984116639c83dfb64b5aa6d4cd474e018b076777c632bbccccd',
  }] })
  expect(urls[1]).toBe(`${hub}/api/models/${id}/tree/${commit}?recursive=true`)
})

test('resolves branches to a commit before recursively listing every tree page with a token', async () => {
  const urls: string[] = []
  const first = `${hub}/api/models/${id}/tree/${commit}?recursive=true`
  const next = `${first}&cursor=a%2Fb%2Bc`
  const get = mockFetch(async (input, init) => {
    const url = String(input)
    urls.push(url)
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer hf_secret')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(init?.redirect).toBe('error')
    if (urls.length === 1) return response({ sha: commit })
    if (url === first) return response([shard('Q4_K_M/model-Q4_K_M', 2, 3)], { link: `<${first}>; rel="prev", <${next}>; type="application/json"; rel="next"` })
    return response([shard('Q4_K_M/model-Q4_K_M', 3, 3), shard('Q4_K_M/model-Q4_K_M', 1, 3)])
  })
  const found = await repo(id, { revision: 'refs/pr/1', token: 'hf_secret', fetch: get })
  expect(urls).toEqual([`${hub}/api/models/${id}/revision/refs%2Fpr%2F1`, first, next])
  expect(found.quants).toEqual([{ quant: 'Q4_K_M', bytes: 30, files: [1, 2, 3].map((i) => ({
    name: shard('Q4_K_M/model-Q4_K_M', i, 3).path, bytes: 10, sha256: 'a'.repeat(64),
  })) }])
})

test('a gated repository remains visibly gated', async () => {
  let calls = 0
  const found = await repo('google/gemma-2b', { fetch: mockFetch(async () => response(++calls === 1 ? fixture('gated-model') : fixture('gated-tree'))) })
  expect(found).toMatchObject({ licence: 'gemma', gated: true, revision: '9cf48e52b224239de00d483ec8eb84fb8d0f3a3a' })
})

test('search filters for GGUF, encodes user input, and deduplicates fixture results', async () => {
  const get = mockFetch(async (input, init) => {
    const url = new URL(String(input))
    expect(url.pathname).toBe('/api/models')
    expect(url.searchParams.get('search')).toBe('Qwen & coder?')
    expect(url.searchParams.get('filter')).toBe('gguf')
    expect(url.searchParams.get('sort')).toBe('downloads')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret')
    return response(fixture('search'))
  })
  const found = await search(' Qwen & coder? ', { token: 'secret', fetch: get })
  expect(found).toHaveLength(7)
  expect(found[0]).toEqual({ repo: 'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF', gated: false, downloads: 9901942, likes: 1087 })
})

test('search follows relative next links and ignores unsafe or invalid result identifiers', async () => {
  let calls = 0
  const found = await search('model', { fetch: mockFetch(async () => ++calls === 1
    ? response([{ id, downloads: 8 }], { link: '</api/models?cursor=next>; rel=next' })
    : response([{ id }, { id: '../escape' }, { modelId: 'org/second', gated: 'manual', downloads: -1, likes: null }])) })
  expect(found).toEqual([{ repo: id, downloads: 8, likes: 0, gated: false }, { repo: 'org/second', downloads: 0, likes: 0, gated: true }])
})

test('empty queries skip fetching', async () => {
  const get = mockFetch(async () => response([]))
  expect(await search('  ', { fetch: get })).toEqual([])
  expect(get).not.toHaveBeenCalled()
})

test.each(['../model', 'owner/../model', 'owner/model/path', 'https://huggingface.co/owner/model', 'owner\\model', 'owner/model?x=1', 'owner/model#x', 'owner/%2fmodel', '.owner/model', 'owner/model.git', 'owner/model..bad', 'owner/model--bad', 'owner/model.', 'owner/'])('rejects unsafe repository %s without fetching', async (bad) => {
  const get = mockFetch(async () => response({ sha: commit }))
  await expect(repo(bad, { fetch: get })).rejects.toMatchObject({ kind: 'invalid' })
  expect(() => resolveUrl(bad, commit, 'model-Q4_K_M.gguf')).toThrow()
  expect(get).not.toHaveBeenCalled()
})

test.each(['../main', '/main', 'main/../tag', 'main?x', 'main#x', 'main%2fsecret', 'main\\branch', 'main//branch'])('rejects unsafe revision %s', async (revision) => {
  const get = mockFetch(async () => response({ sha: commit }))
  await expect(repo(id, { revision, fetch: get })).rejects.toMatchObject({ kind: 'invalid' })
  expect(get).not.toHaveBeenCalled()
})

test.each(['../model.gguf', '/model.gguf', 'folder/../model.gguf', 'folder//model.gguf', 'folder\\model.gguf', 'a/%2e%2e/model.gguf', 'a/%2Fmodel.gguf', 'C:/model.gguf', 'folder/model.gguf\0', 'folder/NUL.gguf', 'folder/model.gguf.', 'folder/model.gguf ', './model.gguf'])('rejects unsafe path %j in URLs and tree listings', async (bad) => {
  expect(() => resolveUrl(id, commit, bad)).toThrow()
  if (bad.toLowerCase().endsWith('.gguf')) expect(() => group([file(bad)])).toThrow()
})

test('download URLs require full commits and encode filenames once', () => {
  expect(resolveUrl(id, commit.toUpperCase(), 'Q4_K_M/model Q4_K_M.gguf')).toBe(`${hub}/${id}/resolve/${commit}/Q4_K_M/model%20Q4_K_M.gguf`)
  expect(() => resolveUrl(id, 'main', 'model.gguf')).toThrow()
  expect(() => resolveUrl(id, commit.slice(0, 7), 'model.gguf')).toThrow()
})

test.each([{}, { sha: 'main' }, { sha: '1234567' }, { sha: 'f'.repeat(40) }])('rejects missing, mutable or mismatched commit metadata %j', async (metadata) => {
  const get = mockFetch(async () => response(metadata))
  await expect(repo(id, { revision: commit, fetch: get })).rejects.toMatchObject({ kind: 'http' })
  expect(get).toHaveBeenCalledTimes(1)
})

test.each([
  'https://evil.example/api/models?cursor=a', 'http://huggingface.co/api/models?cursor=a',
  'https://huggingface.co@evil.example/api/models?cursor=a', 'https://user:pass@huggingface.co/api/models?cursor=a',
  '/api/other?cursor=a', '/api/models?cursor=a#fragment',
])('does not forward tokens to unsafe pagination %s', async (next) => {
  const get = mockFetch(async () => response([], { link: `<${next}>; rel="next"` }))
  await expect(search('model', { token: 'secret', fetch: get })).rejects.toMatchObject({ kind: 'http' })
  expect(get).toHaveBeenCalledTimes(1)
})

test('tree pagination cannot change commits and repeated pages cannot hang', async () => {
  const get = mockFetch(async (input) => String(input).includes('/tree/')
    ? response([], { link: `<${hub}/api/models/${id}/tree/${'a'.repeat(40)}?cursor=a>; rel="next"` })
    : response({ sha: commit }))
  await expect(repo(id, { fetch: get })).rejects.toMatchObject({ kind: 'http' })
  expect(get).toHaveBeenCalledTimes(2)
  const loop = mockFetch(async (input) => response([], { link: `<${String(input)}>; rel="next"` }))
  await expect(search('model', { fetch: loop })).rejects.toMatchObject({ kind: 'http' })
  expect(loop).toHaveBeenCalledTimes(1)
})

test('groups split fixture builds, keeps quant variants, and excludes projector weights', () => {
  const found = group(fixture('tree-mixed') as unknown[])
  expect(found.map((q) => q.quant)).toEqual(['Q4_K_M', 'UD-Q4_K_XL', 'BF16'])
  expect(found[0]!.files).toHaveLength(1)
  expect(found.some((q) => q.files.some((f) => /mmproj/.test(f.name)))).toBe(false)
})

test.each([
  ['model-Q6_K_L.gguf', 'Q6_K_L'], ['model_Q4_K_M.gguf', 'Q4_K_M'], ['model-IQ3_XXS.gguf', 'IQ3_XXS'],
  ['model-UD-IQ2_XXS-00001-of-00002.gguf', 'UD-IQ2_XXS'], ['model-Q4_0.gguf', 'Q4_0'],
  ['model-bf16.gguf', 'BF16'], ['model-F16.gguf', 'F16'], ['mmproj-Q4_K_M.gguf', undefined],
  ['model-Q4_K_M.imatrix', undefined], ['model.gguf', undefined],
])('parses the exact quant of %s', (path, quant) => { expect(quantOf(path!)).toBe(quant) })

test('never combines incomplete sets from different directories, stems or shard counts', () => {
  expect(group([
    shard('a/model-Q4_K_M', 1, 2), shard('b/model-Q4_K_M', 2, 2),
    shard('model-one-Q5_K_M', 1, 2), shard('model-two-Q5_K_M', 2, 2),
    shard('model-Q6_K', 1, 2), shard('model-Q6_K', 2, 3),
    shard('model-Q8_0', 2, 2), shard('model-Q8_0', 3, 3),
  ])).toEqual([])
})

test('rejects missing, repeated, zero and out-of-range shard indices', () => {
  expect(group([shard('model-Q4_K_M', 0, 2), shard('model-Q4_K_M', 1, 2), shard('model-Q4_K_M', 3, 2)])).toEqual([])
  expect(group([shard('model-Q4_K_M', 1, 3), shard('model-Q4_K_M', 3, 3)])).toEqual([])
  const duplicate = file('model-Q4_K_M-1-of-2.gguf')
  expect(group([shard('model-Q4_K_M', 1, 2), duplicate, shard('model-Q4_K_M', 2, 2)])).toEqual([])
})

test('deduplicates overlapping pages but rejects conflicting metadata for the same path', () => {
  const a = shard('model-Q4_K_M', 1, 2)
  const b = shard('model-Q4_K_M', 2, 2)
  expect(group([a, b, a])[0]!.files).toHaveLength(2)
  expect(group([a, b, file(a.path, 11)])).toEqual([])
})

test('prefers one complete whole build, or one complete split build, over alternatives', () => {
  const rows = [shard('one/model-Q4_K_M', 1, 2), shard('one/model-Q4_K_M', 2, 2), shard('two/model-Q4_K_M', 1, 2)]
  expect(group(rows)[0]!.files.map((f) => f.name)).toEqual(rows.slice(0, 2).map((f) => f.path))
  expect(group([...rows, file('model-Q4_K_M.gguf'), file('copy/model-Q4_K_M.gguf')])[0]!.files.map((f) => f.name)).toEqual(['model-Q4_K_M.gguf'])
})

test('only LFS SHA-256 is a content checksum; Git and Xet OIDs are not', () => {
  const found = group([{ type: 'file', path: 'model-F16.gguf', size: 10, oid: 'a'.repeat(40), xetHash: 'b'.repeat(64) },
    file('model-Q8_0.gguf', 10, 'not-a-checksum')])
  expect(found.map((q) => q.files[0]!.sha256)).toEqual(['', ''])
  expect(group([{ ...file('model-Q4_0.gguf'), size: 11 }])).toEqual([])
})

test('invalid or unsafe sizes cannot become installable quant entries', () => {
  expect(group([file('a-Q4_K_M.gguf', -1), file('b-Q5_K_M.gguf', 1.5), file('c-Q6_K.gguf', 0), file('d-Q8_0.gguf', Number.MAX_SAFE_INTEGER + 1)])).toEqual([])
})

test.each([401, 403, 404, 500])('HTTP %s is a useful structured error without leaking tokens', async (status) => {
  await expect(repo(id, { token: 'secret', fetch: mockFetch(async () => response({ error: 'secret' }, {}, status)) })).rejects.toMatchObject({ kind: 'http', status })
})

test('transport errors do not expose their token-bearing message', async () => {
  await expect(search('model', { fetch: mockFetch(async () => { throw new Error('Bearer secret') }) })).rejects.toThrow('Could not read the Hugging Face response')
})

test('timeouts cover noncooperative fetches and JSON bodies', async () => {
  let signal: AbortSignal | undefined
  await expect(search('model', { timeoutMs: 20, fetch: mockFetch(async (_, init) => {
    signal = init?.signal ?? undefined
    return new Promise<Response>(() => {})
  }) })).rejects.toMatchObject({ kind: 'timeout' })
  expect(signal?.aborted).toBe(true)
  const stalled = new Response(new ReadableStream({ cancel() { return new Promise<void>(() => {}) } }))
  await expect(search('model', { timeoutMs: 20, fetch: mockFetch(async () => stalled) })).rejects.toMatchObject({ kind: 'timeout' })
})

test('cancellation interrupts a pending request, JSON body, and later pagination', async () => {
  for (const body of [false, true]) {
    const controller = new AbortController()
    const task = search('model', { signal: controller.signal, fetch: mockFetch(async () => body
      ? new Response(new ReadableStream()) : new Promise<Response>(() => {})) })
    setTimeout(() => controller.abort(), 20)
    await expect(task).rejects.toMatchObject({ kind: 'aborted' })
  }
  const controller = new AbortController()
  const get = mockFetch(async () => { controller.abort(); return response([], { link: '</api/models?cursor=2>; rel=next' }) })
  await expect(search('model', { signal: controller.signal, fetch: get })).rejects.toMatchObject({ kind: 'aborted' })
  expect(get).toHaveBeenCalledTimes(1)
})

test('pre-aborted signals and invalid listing bodies fail without continuing', async () => {
  const get = mockFetch(async () => response({ not: 'a list' }))
  await expect(search('model', { signal: AbortSignal.abort(), fetch: get })).rejects.toMatchObject({ kind: 'aborted' })
  expect(get).not.toHaveBeenCalled()
  await expect(search('model', { fetch: get })).rejects.toMatchObject({ kind: 'http' })
})
