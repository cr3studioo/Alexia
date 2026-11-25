// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'))

test('the manifest parses, and its id is the folder name', () => {
  expect(manifest.id).toBe(basename(dir))
  expect(manifest.manifest_version).toBe(1)
  expect(manifest.alexia_protocol).toBe(7)
  expect(Array.isArray(manifest.provides)).toBe(true)
})

test('index.js imports without throwing and says who it is', async () => {
  process.env.ALEXIA_PLUGIN_DIR = dir
  const { default: alexia } = await import('../index.js')
  expect(alexia.manifest.id).toBe(manifest.id)
})
