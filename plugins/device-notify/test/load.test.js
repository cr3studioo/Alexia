// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'))
const PROVIDES = ["notify.show"]
const REQUIRES = ["proc.spawn"]

test('the manifest parses, and its id is the folder name', () => {
  expect(manifest.id).toBe(basename(dir))
  expect(manifest.id).toBe('device-notify')
  expect(manifest.manifest_version).toBe(1)
  expect(manifest.alexia_protocol).toBe(3)
  expect(manifest.version).toBe('0.1.0')
})

test('provides and requires match the plan, and every requirement says why', () => {
  expect(manifest.provides).toEqual(PROVIDES)
  expect(manifest.requires.map((r) => r.cap)).toEqual(REQUIRES)
  for (const r of manifest.requires) expect(r.why.length).toBeGreaterThan(0)
  expect(manifest.requires.every((r) => r.why.length <= 120)).toBe(true)
})

test('index.js imports without throwing and says who it is', async () => {
  process.env.ALEXIA_PLUGIN_DIR = dir
  const { default: alexia } = await import('../index.js')
  expect(alexia.manifest.id).toBe(manifest.id)
})
