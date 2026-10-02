// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { asModel, forget, modelsDir, readInstalled, remember, type Installed } from '../src/installed.js'
import { LOCAL_CATALOG } from '../src/localCatalog.js'
const root = mkdtempSync(join(tmpdir(), 'alexia-installed-test-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const record: Installed = { id: 'llama/test:q4_k_m', name: 'Test Q4_K_M', repo: 'test/model', revision: 'a'.repeat(40), quant: 'Q4_K_M', files: [join(modelsDir(root), 'test.gguf')], bytes: 100, context: 8192, tools: false, vision: false, abliterated: false, nsfwOk: 'unknown', vetted: false, installedAt: Date.now() }
test('legacy curated installs regain context and KV metadata only for the exact pinned artifact', () => {
  const entry = LOCAL_CATALOG.find((entry) => entry.id === 'qwen3-4b-instruct-2507')!
  const quant = entry.quants.find((quant) => quant.quant === 'Q4_K_M')!
  const legacy = { ...record, entry: entry.id, repo: entry.repo, revision: entry.revision, quant: quant.quant, bytes: quant.bytes, vetted: true }
  remember(root, legacy)
  expect(readInstalled(root)[0]).toMatchObject({ context: 8192, contextMax: entry.contextMax, kvBytesPerToken: entry.kvBytesPerToken, tools: false })
  for (const changed of [{ revision: 'b'.repeat(40) }, { bytes: quant.bytes + 1 }, { vetted: false }, { imported: true }]) {
    remember(root, { ...legacy, ...changed })
    expect(readInstalled(root)[0]?.contextMax).toBeUndefined()
  }
  forget(root, legacy.id)
})
test('an install survives reopening and replacing metadata preserves one installed row', () => {
  remember(root, record)
  remember(root, { ...record, tools: true })
  expect(readInstalled(root)).toEqual([{ ...record, tools: true }])
  expect(asModel(record)).toMatchObject({ provider: 'llama', tier: 'T0', quant: 'Q4_K_M', diskBytes: 100, supportsTools: false, modality: ['text'] })
  expect(forget(root, record.id)?.id).toBe(record.id)
  expect(readInstalled(root)).toEqual([])
})
test('corrupt or incomplete registry rows do not become runnable models', () => {
  mkdirSync(modelsDir(root), { recursive: true })
  const manifest = join(modelsDir(root), 'installed.json')
  writeFileSync(manifest, JSON.stringify([{ id: 'broken', files: ['/tmp/arbitrary'], context: 8000 }, record]))
  expect(readInstalled(root)).toEqual([record])
  writeFileSync(manifest, '{')
  expect(readInstalled(root)).toEqual([])
})

test('invalid format and runtime settings are not admitted as runnable registry rows', () => {
  const invalid = [
    { ...record, format: 'other' },
    { ...record, format: 'mlx' },
    { ...record, kvCache: 'bad' },
    { ...record, contextMax: 256 },
    { ...record, ready: 'yes' },
    { ...record, lastUsedAt: -1 },
  ]
  writeFileSync(join(modelsDir(root), 'installed.json'), JSON.stringify([...invalid, record]))
  expect(readInstalled(root)).toEqual([record])
})
