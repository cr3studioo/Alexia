// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, test } from './harness.js'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'))
const PROVIDES = ['file.search', 'folder.tidy']
const REQUIRES = ['proc.spawn', 'fs.read_scoped', 'fs.write_scoped', 'fs.own_dir']

test('the manifest parses, and its id is the folder name', () => {
  assert.equal(manifest.id, basename(dir))
  assert.equal(manifest.id, 'file-finder')
  assert.equal(manifest.manifest_version, 1)
  assert.equal(manifest.alexia_protocol, 3)
  assert.equal(manifest.version, '0.1.0')
})

test('provides and requires match the plan, and every requirement says why', () => {
  assert.deepEqual(manifest.provides, PROVIDES)
  assert.deepEqual(
    manifest.requires.map((r) => r.cap),
    REQUIRES,
  )
  for (const r of manifest.requires) assert.ok(r.why.length > 0)
  assert.ok(manifest.requires.every((r) => r.why.length <= 120))
})

test('the manifest declares the tables the plugin keeps', () => {
  assert.deepEqual(manifest.storage, { namespace: manifest.id, tables: ['plans', 'moves'] })
})

test('index.js imports without throwing and says who it is', async () => {
  process.env.ALEXIA_PLUGIN_DIR = dir
  const { default: alexia } = await import('../index.js')
  assert.equal(alexia.manifest.id, manifest.id)
})
