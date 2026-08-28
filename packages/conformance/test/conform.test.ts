// SPDX-License-Identifier: Apache-2.0
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { conform } from '../src/conform.js'

// M3-3. The suite has to be right about a real plugin and right about a broken one — a
// checker that has only ever seen good input is a checker nobody can trust to gate a
// registry.

const root = join(import.meta.dirname, '..', '..', '..')
const staging = mkdtempSync(join(tmpdir(), 'alexia-conformance-test-'))
afterAll(() => rmSync(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))

const level = (checks: { name: string; level: string }[], name: string): string | undefined =>
  checks.find((c) => c.name === name)?.level

test('the repo’s own plugin conforms', async () => {
  // `hello` is the plugin M0 wrote to answer, so it is the one this suite has to agree
  // with. If conformance and the reference plugin disagree, one of them is wrong.
  const report = await conform(join(root, 'plugins', 'hello'))
  expect(report.ok, JSON.stringify(report.checks, null, 2)).toBe(true)
  expect(level(report.checks, 'manifest')).toBe('pass')
  expect(level(report.checks, 'boots')).toBe('pass')
  expect(level(report.checks, 'stdout-is-the-wire')).toBe('pass')
  expect(level(report.checks, 'purges-clean')).toBe('pass')
}, 60_000)

test('a plugin whose folder and id disagree does not get a process', async () => {
  const dir = join(staging, 'renamed')
  cpSync(join(root, 'plugins', 'hello'), dir, { recursive: true })
  const report = await conform(dir)
  expect(report.ok).toBe(false)
  expect(report.checks).toHaveLength(1)
  expect(report.checks[0]?.detail).toMatch(/folder is called "renamed"/)
})

test('an invalid manifest fails before anything is spawned', async () => {
  const dir = join(staging, 'broken')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ manifest_version: 1, id: 'broken' }))
  const report = await conform(dir)
  expect(report.ok).toBe(false)
  expect(report.checks[0]?.name).toBe('manifest')
})

test('a folder with no manifest is not a plugin', async () => {
  const dir = join(staging, 'empty')
  mkdirSync(dir, { recursive: true })
  const report = await conform(dir)
  expect(report.ok).toBe(false)
  expect(report.checks[0]?.detail).toMatch(/no readable plugin.json/)
})

test('a plugin that dies on a missing dependency is caught', async () => {
  // vanisher's whole purpose is a dependency that is not there. Under this suite nothing
  // answers `demo.greet`, and the plugin has to keep running and explain itself rather
  // than taking Alexia's tool list with it.
  const report = await conform(join(root, 'plugins', 'vanisher'))
  expect(level(report.checks, 'boots')).toBe('pass')
  expect(level(report.checks, 'degrades')).not.toBe('fail')
}, 60_000)
