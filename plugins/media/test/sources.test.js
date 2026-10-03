// SPDX-License-Identifier: AGPL-3.0-only
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createSources, sources } from '../sources/index.js'
import { civitai } from '../sources/civitai.js'
import { COLLECTIONS, github } from '../sources/github.js'
import { bytes, WORKFLOW_MAX } from '../sources/http.js'
import { modelsOf } from '../sources/workflow.js'
import { workflowsInZip } from '../sources/zip.js'

const fixture = (name) => readFileSync(join(import.meta.dirname, 'fixtures', 'sources', name))
const parsed = (name) => JSON.parse(fixture(name).toString('utf8'))
const response = (value, status = 200, headers = {}) => new globalThis.Response(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value), { status, headers })

// A missing stub is an error, so even a newly added request cannot accidentally use the network.
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is forbidden in source tests.') })))
afterEach(() => vi.unstubAllGlobals())

test('every exported source has the common library interface', () => {
  expect(sources.map((source) => source.id)).toEqual(['civitai', 'github-community'])
  expect(createSources({ fetch: vi.fn() }).map((source) => source.id)).toEqual(sources.map((source) => source.id))
  for (const source of sources) {
    expect(source.name).toBeTruthy()
    expect(source.homepage).toMatch(/^https:/)
    expect(typeof source.search).toBe('function')
    expect(typeof source.fetch).toBe('function')
  }
})

test('Civitai searches its public Workflow catalogue without a key', async () => {
  const fetch = vi.fn(async () => response(parsed('civitai-search.json')))
  const entries = await civitai({ fetch }).search('Flux')
  expect(entries[0]).toMatchObject({ id: '617060:819999:733789', source: 'civitai', author: 'maitruclam' })
  expect(entries[0].license).toContain('allowDerivatives')
  expect(entries[0].description).not.toMatch(/<[^>]+>/)
  const [url, options] = fetch.mock.calls[0]
  expect(new URL(url).searchParams.get('types')).toBe('Workflows')
  expect(new URL(url).searchParams.get('query')).toBe('Flux')
  expect(new URL(url).searchParams.get('nsfw')).toBe('false')
  expect(options.headers.authorization).toBeUndefined()
  expect(new URL(url).searchParams.has('page')).toBe(false)
})

test('Civitai fetches the exact file and reads the real workflow ZIP anonymously', async () => {
  const fetch = vi.fn(async (url) => {
    if (url.endsWith('/api/v1/models/617060')) return response(parsed('civitai-model.json'))
    if (url === 'https://civitai.com/api/download/models/819999?fileId=733789') return response(fixture('civitai-workflow.zip'))
    throw new Error(`Unexpected request: ${url}`)
  })
  const result = await civitai({ fetch }).fetch('617060:819999:733789')
  expect(result.format).toBe('editor')
  expect(result.workflow.nodes.some((node) => node.type === 'LoraLoader')).toBe(true)
  expect(result.models.some((model) => model.name === 'flux1-dev.safetensors')).toBe(true)
  expect(result.nodes).toEqual([])
  expect(result.url).toBe('https://civitai.com/models/617060?modelVersionId=819999')
})

test('a Civitai key stays on Civitai when a file redirects to its CDN', async () => {
  const fetch = vi.fn(async (url) => {
    if (url.includes('/api/v1/models/')) return response(parsed('civitai-model.json'))
    if (url.includes('/api/download/models/')) return response('', 302, { location: 'https://cdn.civitai.com/workflow.zip' })
    return response(fixture('civitai-workflow.zip'))
  })
  await civitai({ fetch, apiKey: 'test-key' }).fetch('617060:819999:733789')
  expect(fetch.mock.calls[0][1].headers.authorization).toBe('Bearer test-key')
  expect(fetch.mock.calls[1][1].headers.authorization).toBe('Bearer test-key')
  expect(fetch.mock.calls[2][1].headers.authorization).toBeUndefined()
  expect(fetch.mock.calls.map(([url]) => url).join(' ')).not.toContain('test-key')
})

test('restricted Civitai downloads explain authentication, and absent files are never guessed', async () => {
  const fetch = vi.fn(async (url) => url.includes('/api/v1/models/') ? response(parsed('civitai-model.json')) : response({}, 401))
  await expect(civitai({ fetch }).fetch('617060:819999:733789')).rejects.toThrow('requires your own API key')
  await expect(civitai({ fetch }).fetch('617060:819999:1')).rejects.toThrow('missing')
  await expect(civitai({ fetch }).fetch('https://example.com')).rejects.toThrow('attachment id')
})

test('Civitai also accepts API JSON attachments and filters task tags without inventing metadata', async () => {
  const model = parsed('civitai-model.json')
  model.modelVersions[0].files[0].name = 'workflow.json'
  const graph = { 1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } } }
  const fetch = vi.fn(async (url) => url.includes('/models?') ? response({ items: [model] }) : url.includes('/api/v1/models/') ? response(model) : response(graph))
  const source = civitai({ fetch })
  expect((await source.search('', { task: model.tags[0] })).length).toBe(1)
  expect(await source.search('', { task: 'not-a-tag' })).toEqual([])
  const result = await source.fetch('617060:819999:733789')
  expect(result.format).toBe('api')
  expect(result.models).toEqual([{ name: 'model.safetensors', folder: 'checkpoints' }])
})

test('GitHub searches a licensed pinned tree, caches it, and fetches the recorded workflow', async () => {
  const fetch = vi.fn(async (url) => url.includes('api.github.com') ? response(parsed('github-tree.json')) : response(parsed('github-workflow.json')))
  const source = github({ fetch, collections: [COLLECTIONS[0]] })
  const entries = await source.search('clothing')
  expect(entries).toHaveLength(1)
  expect(entries[0]).toMatchObject({ source: 'github-community', title: 'sal vton clothing swap', author: 'diffustar', license: 'MIT' })
  expect(entries[0].id).toContain(COLLECTIONS[0].commit)
  expect(await source.search('clothing', { task: 'ella' })).toEqual([])
  const result = await source.fetch(entries[0].id)
  expect(result.format).toBe('editor')
  expect(result.nodes).toContain('SALVTON_Apply')
  expect(result.models.length).toBeGreaterThan(0)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(fetch.mock.calls[1][0]).toContain(`/diffustar/comfyui-workflow-collection/${COLLECTIONS[0].commit}/`)
  expect(result.license).toBe('MIT')
})

test('GitHub refuses incomplete catalogues and arbitrary repository/file ids', async () => {
  const fetch = vi.fn(async () => response({ ...parsed('github-tree.json'), truncated: true }))
  const source = github({ fetch, collections: [COLLECTIONS[0]] })
  await expect(source.search('')).rejects.toThrow('incomplete')
  await expect(source.fetch(`someone/else@${COLLECTIONS[0].commit}:workflow.json`)).rejects.toThrow('licensed')
  fetch.mockImplementation(async () => response(parsed('github-tree.json')))
  await expect(source.fetch(`diffustar/comfyui-workflow-collection@${COLLECTIONS[0].commit}:LICENSE`)).rejects.toThrow('catalogue')
})

test('upstream JSON examples keep their actual permissive licence without inventing an SPDX id', async () => {
  const fetch = vi.fn(async (url) => url.includes('api.github.com') ? response(parsed('github-examples-tree.json')) : response(parsed('github-examples-workflow.json')))
  const source = github({ fetch, collections: [COLLECTIONS[2]] })
  const entries = await source.search('text_to_video_wan22_5B')
  expect(entries).toHaveLength(1)
  expect(entries[0].author).toBe('comfyanonymous')
  expect(entries[0].license).toContain('permission grant')
  const result = await source.fetch(entries[0].id)
  expect(result.format).toBe('editor')
  expect(result.license).toBe(entries[0].license)
  expect(result.models.length).toBeGreaterThan(0)
})

test('model requirements preserve embedded URLs and omit folders that cannot be derived', () => {
  expect(modelsOf({ nodes: [{ properties: { models: [{ name: 'model.safetensors', url: 'https://example.com/model', directory: 'checkpoints', bytes: 123 }] }, widgets_values: ['model.safetensors', 'adapter.gguf', 'not a model'] }] }))
    .toEqual([{ name: 'model.safetensors', url: 'https://example.com/model', folder: 'checkpoints', bytes: 123 }, { name: 'adapter.gguf' }])
})

test('bounded downloads stop on oversized headers, oversized streams, redirects, rate limits and cancellation', async () => {
  await expect(bytes('https://example.com', { fetch: async () => response('x', 200, { 'content-length': String(WORKFLOW_MAX + 1) }) })).rejects.toThrow('byte limit')
  await expect(bytes('https://example.com', { max: 2, fetch: async () => response('long') })).rejects.toThrow('byte limit')
  await expect(bytes('https://example.com', { fetch: async () => response('', 302, { location: 'http://example.com' }) })).rejects.toThrow('https')
  await expect(bytes('https://example.com', { fetch: async () => response('', 429, { 'retry-after': '10' }) })).rejects.toThrow('retry after 10')
  const controller = new AbortController()
  controller.abort()
  const fetch = vi.fn()
  await expect(bytes('https://example.com', { fetch, signal: controller.signal })).rejects.toThrow()
  expect(fetch).not.toHaveBeenCalled()
})

// Tiny uncompressed ZIPs let failure cases exercise the same central-directory reader as the real fixture.
function archive(members) {
  const local = [], directory = []
  let offset = 0
  for (const [name, text] of members) {
    const filename = Buffer.from(name), body = Buffer.from(text)
    const head = Buffer.alloc(30), central = Buffer.alloc(46)
    head.writeUInt32LE(0x04034b50)
    head.writeUInt32LE(crc32(body), 14)
    head.writeUInt32LE(body.length, 18)
    head.writeUInt32LE(body.length, 22)
    head.writeUInt16LE(filename.length, 26)
    central.writeUInt32LE(0x02014b50)
    central.writeUInt32LE(crc32(body), 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(body.length, 24)
    central.writeUInt16LE(filename.length, 28)
    central.writeUInt32LE(offset, 42)
    local.push(head, filename, body)
    directory.push(central, filename)
    offset += head.length + filename.length + body.length
  }
  const dirs = Buffer.concat(directory), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(members.length, 8)
  end.writeUInt16LE(members.length, 10)
  end.writeUInt32LE(dirs.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, dirs, end])
}

test('ZIPs ignore non-workflow files, reject corruption and bound uncompressed bytes', () => {
  const graph = JSON.stringify({ 1: { class_type: 'SaveImage', inputs: {} } })
  expect(workflowsInZip(archive([['settings.json', '{}'], ['script.py', 'print(1)'], ['workflow.json', graph]]))).toHaveLength(1)
  expect(() => workflowsInZip(Buffer.from('not a zip'))).toThrow('corrupt')
  const corrupt = Buffer.from(fixture('civitai-workflow.zip'))
  corrupt[120] ^= 1
  expect(() => workflowsInZip(corrupt)).toThrow()
  const oversized = archive([['workflow.json', graph]])
  const central = oversized.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  oversized.writeUInt32LE(WORKFLOW_MAX + 1, central + 24)
  expect(() => workflowsInZip(oversized)).toThrow('expands')
})

test('multi-workflow Civitai archives require an explicit member id', async () => {
  const graph = JSON.stringify({ 1: { class_type: 'SaveImage', inputs: {} } })
  const zip = archive([['first.json', graph], ['second.json', graph]])
  const fetch = vi.fn(async (url) => url.includes('/api/v1/models/') ? response(parsed('civitai-model.json')) : response(zip))
  const source = civitai({ fetch })
  await expect(source.fetch('617060:819999:733789')).rejects.toThrow('Choose a workflow')
  expect((await source.fetch('617060:819999:733789:second.json')).format).toBe('api')
})
