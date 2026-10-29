// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'
import type { ResearchUpdate } from '@alexia/protocol'
import { ResearchRuns } from '../src/research.js'
import { serve } from '../src/serve.js'
import { memorySecrets } from '../src/secrets.js'
import { noPolling } from './staged.js'

const root = mkdtempSync(join(tmpdir(), 'alexia-research-files-'))
noPolling(root)
const extension = join(root, 'extensions', 'provider')
const own = join(root, 'plugins', 'provider')
mkdirSync(extension, { recursive: true }); mkdirSync(own, { recursive: true })
writeFileSync(join(extension, 'plugin.json'), JSON.stringify({ manifest_version: 1, id: 'provider', name: 'Provider', summary: 'Research file access fixture', version: '1.0.0', license: 'MIT', entry: { run: 'node', args: ['index.js'] }, alexia_protocol: 15, mcp_protocol: '2025-11-25', panel: { label: 'Research', widgets: [{ type: 'research', key: 'viewer', label: 'Research' }] } }))
const preview = join(own, 'source.png'); const report = join(own, 'report.md')
writeFileSync(preview, Buffer.from([137, 80, 78, 71]))
writeFileSync(report, '# Sourced report\n')
const server = await serve({ dataDir: root, local: false, providers: [], secrets: memorySecrets() })
const get = (path: string, init?: RequestInit): Promise<Response> => fetch(new URL(path, server.url), { ...init, headers: { 'x-alexia-token': server.token, ...init?.headers } })
const state = await (await get('/api/state')).json() as { editor: { conversationId: string } }
const conversation = state.editor.conversationId
const snapshot: ResearchUpdate = { runId: 'r1', conversationId: conversation, sequence: 1, topic: 'Question', startedAt: 1, elapsedMs: 1, stage: 'finished', completion: 'complete', sources: [{ id: 'S1', title: 'Page', url: 'https://example.org/', state: 'complete', preview, passages: [] }], currentSourceId: 'S1', counters: { read: 1, inProgress: 0, failed: 0 }, gaps: [], report: { path: report, name: 'report.md' } }
const spy = vi.spyOn(ResearchRuns.prototype, 'get').mockImplementation((id, conv) => id === 'provider' && conv === conversation ? snapshot : undefined)
afterAll(async () => { spy.mockRestore(); await server.close(); rmSync(root, { recursive: true, force: true }) })

test('research reconnect reads the host conversation, and files require authenticated run/source references', async () => {
  const seen = await get('/api/research', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plugin: 'provider', conversationId: 'foreign' }) })
  expect((await seen.json() as { snapshot: ResearchUpdate }).snapshot.conversationId).toBe(conversation)
  expect((await get('/api/research-file?plugin=provider&run=r1&source=S1')).status).toBe(200)
  const downloaded = await get('/api/research-file?plugin=provider&run=r1&kind=report')
  expect(downloaded.headers.get('content-type')).toContain('text/markdown')
  expect(await downloaded.text()).toBe('# Sourced report\n')
  expect((await get('/api/research-file?plugin=provider&run=other&source=S1')).status).toBe(404)
  expect((await get('/api/research-file?plugin=provider&run=r1&source=other')).status).toBe(404)
  expect((await fetch(new URL('/api/research-file?plugin=provider&run=r1&source=S1', server.url))).status).toBe(403)
})

test('even referenced files cannot escape provider scope through paths or symlinks', async () => {
  const outside = join(root, 'outside.png'); writeFileSync(outside, 'private')
  snapshot.sources[0]!.preview = outside
  expect((await get('/api/research-file?plugin=provider&run=r1&source=S1')).status).toBe(404)
  const linked = join(own, 'linked.png'); symlinkSync(outside, linked)
  snapshot.sources[0]!.preview = linked
  expect((await get('/api/research-file?plugin=provider&run=r1&source=S1')).status).toBe(404)
  snapshot.sources[0]!.preview = preview
})
