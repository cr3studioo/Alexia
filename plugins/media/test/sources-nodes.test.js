// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { api as starter } from '../starter.js'
import { BUILTINS, customNodeTypes, MAPPING, resolveNodes } from '../sources/nodes.js'

const fixture = (name) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'sources', name), 'utf8'))
const response = (body, status = 200) => new globalThis.Response(JSON.stringify(body), { status })
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is forbidden in node resolver tests.') })))
afterEach(() => vi.unstubAllGlobals())

function registryFetch() {
  return vi.fn(async (url) => {
    if (url.startsWith('https://api.comfy.org/comfy-nodes/') && url.endsWith('/node')) return response(fixture('registry-ipadapter.json'))
    if (url === 'https://api.comfy.org/nodes/comfyui_ipadapter_plus/versions/2.0.0') return response(fixture('registry-ipadapter-version.json'))
    throw new Error(`Unexpected request: ${url}`)
  })
}

test('built-in graphs have no custom nodes and resolving them costs no network request', async () => {
  const fetch = vi.fn()
  expect(customNodeTypes(starter())).toEqual([])
  expect(await resolveNodes(starter(), { fetch })).toEqual({ nodes: [], packs: [], unresolved: [] })
  expect(fetch).not.toHaveBeenCalled()
  expect(MAPPING.commit).toBe('855a0f50ecc842adacab08aa24d8655a742fae40')
  expect(BUILTINS).toContain('UNETLoader')
})

test('a recorded IPAdapter workflow resolves its three classes to one exact Registry release', async () => {
  const workflow = fixture('ipadapter-workflow.json')
  expect(customNodeTypes(workflow)).toEqual(['IPAdapterAdvanced', 'IPAdapterModelLoader', 'PrepImageForClipVision'])
  const result = await resolveNodes(workflow, { fetch: registryFetch() })
  expect(result.unresolved).toEqual([])
  expect(result.packs).toHaveLength(1)
  expect(result.packs[0]).toMatchObject({
    id: 'comfyui_ipadapter_plus', registryId: 'comfyui_ipadapter_plus', repository: 'https://github.com/cubiq/ComfyUI_IPAdapter_plus',
    version: '2.0.0', downloadUrl: 'https://cdn.comfy.org/matteo/comfyui_ipadapter_plus/2.0.0/node.tar.gz',
    nodeTypes: ['IPAdapterAdvanced', 'IPAdapterModelLoader', 'PrepImageForClipVision'], mapping: 'comfy-registry',
  })
})

test('API workflows deduplicate custom classes and editor-only furniture is ignored', () => {
  expect(customNodeTypes({ 1: { class_type: 'IPAdapterAdvanced' }, 2: { class_type: 'IPAdapterAdvanced' }, 3: { class_type: 'KSampler' } })).toEqual(['IPAdapterAdvanced'])
  expect(customNodeTypes({ nodes: ['Note', 'MarkdownNote', 'PrimitiveNode', 'Reroute'].map((type) => ({ type })) })).toEqual([])
  expect(customNodeTypes({ 1: { class_type: 'NewComfyCoreNode' } }, { builtins: [...BUILTINS, 'NewComfyCoreNode'] })).toEqual([])
})

test('nested frontend subgraphs contribute their classes, never their container UUID', () => {
  const workflow = { nodes: [{ type: 'subgraph-1' }], definitions: { subgraphs: [
    { id: 'subgraph-1', nodes: [{ type: 'subgraph-2' }, { type: 'KSampler' }] },
    { id: 'subgraph-2', nodes: [{ type: 'subgraph-1' }, { type: 'IPAdapterAdvanced' }] },
    { id: 'unused', nodes: [{ type: 'UnusedCustomNode' }] },
  ] } }
  expect(customNodeTypes(workflow)).toEqual(['IPAdapterAdvanced'])
})

test('the Registry release in editor metadata wins over a newer latest version', async () => {
  const fetch = registryFetch()
  const record = fixture('registry-ipadapter.json')
  record.latest_version.version = '3.0.0'
  fetch.mockImplementation(async (url) => url.includes('/comfy-nodes/') ? response(record) : response(fixture('registry-ipadapter-version.json')))
  const workflow = { nodes: [{ type: 'IPAdapterAdvanced', properties: { cnr_id: 'comfyui_ipadapter_plus', ver: '2.0.0' } }] }
  expect((await resolveNodes(workflow, { fetch })).packs[0].version).toBe('2.0.0')
  expect(fetch.mock.calls[1][0]).toMatch(/\/versions\/2\.0\.0$/)
})

test('unknown classes, ambiguous Manager mappings and inactive Registry releases remain unresolved', async () => {
  const absent = vi.fn(async () => response(fixture('registry-missing.json'), 404))
  const workflow = { 1: { class_type: 'AlexiaNonexistentFixtureClass' } }
  expect((await resolveNodes(workflow, { fetch: absent })).unresolved[0].reason).toContain('No custom node pack')
  const mapping = { 'https://github.com/a/one': [['SharedClass'], {}], 'https://github.com/b/two': [['SharedClass'], {}] }
  expect((await resolveNodes({ 1: { class_type: 'SharedClass' } }, { fetch: absent, mapping })).unresolved[0].reason).toContain('More than one')
  const fetch = registryFetch()
  const release = fixture('registry-ipadapter-version.json')
  release.status = 'NodeVersionStatusFlagged'
  fetch.mockImplementation(async (url) => url.includes('/comfy-nodes/') ? response(fixture('registry-ipadapter.json')) : response(release))
  const result = await resolveNodes({ 1: { class_type: 'IPAdapterAdvanced' } }, { fetch })
  expect(result.packs).toEqual([])
  expect(result.unresolved[0].reason).toContain('not active')
})

test('Manager preemptions and patterns are resolved to Registry releases when available', async () => {
  const fetch = vi.fn(async (url) => {
    if (url.includes('/comfy-nodes/')) return response(fixture('registry-missing.json'), 404)
    if (url.includes('/nodes/search?')) return response({ nodes: [fixture('registry-rgthree.json')] })
    if (url.includes('/versions/')) return response(fixture('registry-rgthree-version.json'))
    throw new Error(`Unexpected request: ${url}`)
  })
  const result = await resolveNodes({ 1: { class_type: 'Power Lora Loader (rgthree)' } }, { fetch })
  expect(result.unresolved).toEqual([])
  expect(result.packs[0]).toMatchObject({ registryId: 'rgthree-comfy', version: '1.0.2608210019' })
  const ipFetch = vi.fn(async (url) => {
    if (url.includes('/comfy-nodes/')) return response(fixture('registry-missing.json'), 404)
    if (url.includes('/nodes/search?')) return response({ nodes: [fixture('registry-ipadapter.json')] })
    return response(fixture('registry-ipadapter-version.json'))
  })
  expect((await resolveNodes({ 1: { class_type: 'IPAdapterAdvanced' } }, { fetch: ipFetch })).packs[0].registryId).toBe('comfyui_ipadapter_plus')
})

test('an unregistered Manager pack gets a full immutable GitHub commit', async () => {
  const fetch = vi.fn(async (url) => {
    if (url.includes('/comfy-nodes/')) return response(fixture('registry-missing.json'), 404)
    if (url.includes('/nodes/search?')) return response(fixture('registry-empty-search.json'))
    if (url === 'https://api.github.com/repos/kijai/ComfyUI-ELLA-wrapper/commits/HEAD') return response(fixture('github-fallback-commit.json'))
    throw new Error(`Unexpected request: ${url}`)
  })
  const result = await resolveNodes({ 1: { class_type: 'ella_model_loader' } }, { fetch })
  expect(result.unresolved).toEqual([])
  expect(result.packs[0]).toMatchObject({ repository: 'https://github.com/kijai/ComfyUI-ELLA-wrapper', commit: fixture('github-fallback-commit.json').sha, mapping: `comfyui-manager@${MAPPING.commit}` })
  expect(result.packs[0].commit).toMatch(/^[a-f0-9]{40}$/)
})

test('rate limits do not change node ownership and cancellation is propagated', async () => {
  const fetch = vi.fn(async () => response({}, 429))
  const result = await resolveNodes({ 1: { class_type: 'IPAdapterAdvanced' } }, { fetch })
  expect(result.packs).toEqual([])
  expect(result.unresolved[0].reason).toContain('rate limited')
  expect(fetch).toHaveBeenCalledTimes(1)
  const controller = new AbortController()
  controller.abort()
  await expect(resolveNodes({ 1: { class_type: 'IPAdapterAdvanced' } }, { fetch, signal: controller.signal })).rejects.toThrow()
})
