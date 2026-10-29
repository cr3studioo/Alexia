// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'vitest'
import { Manifest, ResearchUpdate } from '../src/index.js'
const base = { manifest_version: 1, id: 'research-provider', name: 'Research', summary: 'Research provider', version: '1.0.0', license: 'MIT', entry: { run: 'node', args: ['index.js'] }, alexia_protocol: 15, mcp_protocol: '2025-11-25', panel: { label: 'Research', widgets: [{ type: 'research', key: 'viewer', label: 'Research' }] } }
test('research viewers and bundled companions require revision 15; old manifests remain valid', () => {
  expect(Manifest.safeParse(base).success).toBe(true)
  expect(Manifest.safeParse({ ...base, alexia_protocol: 14 }).success).toBe(false)
  for (const asset of ['../outside', '/absolute', 'C:\\private', 'a/../../outside', 'a//b', './local', 'nul\0byte']) expect(Manifest.safeParse({ ...base, assets: [asset] }).success, asset).toBe(false)
  expect(Manifest.safeParse({ ...base, assets: ['worker.py', 'runtime/requirements.txt'] }).success).toBe(true)
})
test('research progress rejects non-web source addresses and unbounded evidence', () => {
  const run = { runId: 'r', conversationId: 'c', sequence: 0, topic: 'topic', startedAt: 1, elapsedMs: 1, stage: 'reading', sources: [], counters: { read: 0, inProgress: 0, failed: 0 }, completion: 'running' }
  expect(ResearchUpdate.safeParse(run).success).toBe(true)
  const source = { id: 's', url: 'file:///etc/passwd', title: 'Bad', state: 'complete' }
  expect(ResearchUpdate.safeParse({ ...run, sources: [source] }).success).toBe(false)
  expect(ResearchUpdate.safeParse({ ...run, sources: [{ ...source, url: 'https://example.org', text: 'x'.repeat(6001) }] }).success).toBe(false)
})
