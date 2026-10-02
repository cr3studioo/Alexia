// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { contextPreview, installedEntry, maintenance } from '../src/localSettings.js'
import type { Installed } from '../src/installed.js'
import type { Machine } from '../src/machine.js'
const model: Installed = { id: 'llama/main', name: 'Main', repo: 'test/main', revision: 'a'.repeat(40), entry: 'main', quant: 'Q4', files: [import.meta.filename], bytes: 1024 ** 3, params: 8, context: 8192, contextMax: 32768, kvBytesPerToken: 65536, tokenizerFingerprint: 'same', tools: false, vision: false, abliterated: false, nsfwOk: 'unknown', vetted: true, installedAt: 1 }
const machine = { budgetBytes: 16 * 1024 ** 3, freeDiskBytes: 64 * 1024 ** 3 } as Machine

test('context accounts for precision and draft memory, and null explicitly clears an existing draft', () => {
  const draft = { ...model, id: 'llama/draft', params: 1, bytes: 256 * 1024 ** 2 }
  const parent = { ...model, draftModelId: draft.id }
  const base = contextPreview(machine, parent, [parent, draft], 8192, 'f16', null)
  const withDraft = contextPreview(machine, parent, [parent, draft])
  expect(withDraft.needBytes).toBeGreaterThan(base.needBytes)
  expect(contextPreview(machine, model, [], 8192, 'q4_0').needBytes).toBeLessThan(base.needBytes)
  expect(() => contextPreview(machine, model, [], 32769)).toThrow('context')
  expect(() => contextPreview(machine, model, [], 8192, 'f16', 'missing')).toThrow('draft')
  expect(contextPreview(machine, parent, [], 8192, 'f16', null).drafts).toEqual([])
})

test('draft candidates require existing compatible files; MLX does not offer speculative drafts', () => {
  const missing = { ...model, id: 'llama/missing', params: 1, files: ['/no/such/model.gguf'] }
  expect(contextPreview(machine, model, [missing]).drafts).toEqual([])
  expect(contextPreview(machine, { ...model, format: 'mlx' }, [missing]).drafts).toEqual([])
})

test('maintenance suggests changed catalog revisions without claiming chronological upgrades or larger is newer', () => {
  const exact = { ...installedEntry(model), id: 'main', revision: 'b'.repeat(40) }
  const larger = { ...exact, id: 'larger', params: 70 }
  const result = maintenance(machine, [model], [exact, larger], model.id)
  expect(result.updates).toHaveLength(1)
  expect(result.updates[0]?.reason).toContain('different pinned revision')
  expect(result.updates[0]?.reason).not.toContain('newer')
  expect(result.cleanup).toEqual([])
  expect(maintenance(machine, [model], [larger]).updates).toEqual([])
})
