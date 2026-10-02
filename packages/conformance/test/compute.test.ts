// SPDX-License-Identifier: Apache-2.0
import { MCP_PINNED } from '@alexia/protocol'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, expect, test } from 'vitest'
import { conform } from '../src/conform.js'

const staging = mkdtempSync(join(tmpdir(), 'alexia-conformance-compute-'))
const sdk = pathToFileURL(join(import.meta.dirname, '..', '..', 'sdk', 'dist', 'src', 'index.js')).href
afterAll(() => rmSync(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))

function fixture(id: string, binding?: unknown, declareCompute = true): string {
  const dir = join(staging, id)
  mkdirSync(dir)
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({
    manifest_version: 1, id, name: 'Compute fixture', summary: 'Checks a compute operation binding.',
    version: '0.1.0', license: 'Apache-2.0', alexia_protocol: 13, mcp_protocol: MCP_PINNED,
    entry: { run: 'node', args: ['index.mjs'] },
    provides: ['demo.render'],
    ...(declareCompute && { compute: {
      operations: [{ cap: 'demo.render', summary: 'Render a fixture file.' }], hooks: ['setup', 'release'],
    } }),
  }))
  const register = binding === undefined ?
    `alexia.computeOperation('demo.render', async () => ({ text: 'Rendered.', files: [] }))
     alexia.computeHooks({ setup: async () => [], release: async () => {} })`
    : `alexia.tool('render', {
        description: 'Render a fixture file.', annotations: { readOnlyHint: false, openWorldHint: false },
        _meta: { 'alexia/compute': ${JSON.stringify(binding)} },
      }, async () => ({ content: [] }))`
  writeFileSync(join(dir, 'index.mjs'), `
import { plugin } from ${JSON.stringify(sdk)}
const alexia = plugin()
${register}
await alexia.start()
`)
  return dir
}

test('an SDK compute operation and its hooks conform without PROVIDES_META or a warning', async () => {
  const report = await conform(fixture('compute-fixture'), { exercise: false })
  expect(report.ok, JSON.stringify(report.checks)).toBe(true)
  expect(report.checks.find((check) => check.name === 'provides')?.level).toBe('pass')
  expect(report.checks.filter((check) => check.level !== 'pass')).toEqual([])
})

test.each([
  ['hook-fixture', { hook: 'setup' }, true],
  ['malformed-fixture', { op: ['demo.render'] }, true],
  ['undeclared-fixture', { op: 'demo.render' }, false],
])('an invalid operation binding still warns about an unbound capability: %s', async (id, binding, declared) => {
  const report = await conform(fixture(id, binding, declared), { exercise: false })
  const provides = report.checks.find((check) => check.name === 'provides')
  expect(provides?.level).toBe('warn')
  expect(provides?.detail).toContain('declared but not bound to any tool right now: demo.render')
})
