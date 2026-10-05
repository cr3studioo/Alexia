// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { bestQuant, DEFAULT_CONTEXT, fit, kvBytesPerToken, recommend } from '../src/fit.js'
import { entry, type LocalEntry, type Quantized } from '../src/localCatalog.js'
import type { Machine } from '../src/machine.js'
import { PLANNER } from '../src/catalog.js'

const GB = 1024 ** 3
const model = entry('qwen3-8b')!
const quant = model.quants.find((q) => q.quant === 'Q4_K_M')!
const here: Machine = { platform: 'darwin', arch: 'arm64', appleSilicon: true, chip: 'Test', ramBytes: 16 * GB, budgetBytes: 12 * GB, freeDiskBytes: 100 * GB }
const copy = (over: Partial<LocalEntry>): LocalEntry => ({ ...model, ...over })

test('weights, FP16 cache with padding, and explicit runtime headroom all count', () => {
  const f = fit(here, model, quant)
  expect(f.context).toBe(DEFAULT_CONTEXT)
  expect(kvBytesPerToken(model)).toBe(36 * 8 * 128 * 4)
  expect(f.kvBytes).toBe(Math.ceil(8192 * 147456 * 1.1))
  expect(f.overheadBytes).toBe(Math.max(GB, Math.ceil(quant.bytes * 0.15)))
  expect(f.needBytes).toBe(quant.bytes + f.kvBytes + f.overheadBytes)
  expect(f.verdict).toBe('fits')
  expect(f.tokensPerSecond).toBeUndefined()
})

test('context changes KV memory independently of weight quantization and respects the pinned limit', () => {
  const q8 = model.quants.find((q) => q.quant === 'Q8_0')!
  expect(fit(here, model, quant, 16384).kvBytes).toBeGreaterThan(fit(here, model, quant).kvBytes)
  expect(fit(here, model, quant).kvBytes).toBe(fit(here, model, q8).kvBytes)
  expect(fit(here, model, quant, 999999).context).toBe(model.contextMax)
  expect(fit(here, model, quant, -1).context).toBe(DEFAULT_CONTEXT)
  expect(fit(here, model, quant, NaN).context).toBe(DEFAULT_CONTEXT)
})

test('comfortable, tight and oversized thresholds do not spend the OS reserve', () => {
  const need = fit(here, model, quant).needBytes
  expect(fit({ ...here, budgetBytes: need / 0.9 }, model, quant).verdict).toBe('fits')
  expect(fit({ ...here, budgetBytes: need }, model, quant).verdict).toBe('tight')
  expect(fit({ ...here, budgetBytes: need - 1 }, model, quant).verdict).toBe('too-big')
  expect(fit({ ...here, budgetBytes: NaN }, model, quant).verdict).toBe('too-big')
})

test('disk uses actual download size, leaves a GiB reserve, and treats unknown space as blocked', () => {
  expect(fit({ ...here, freeDiskBytes: quant.bytes + GB }, model, quant).verdict).toBe('fits')
  expect(fit({ ...here, freeDiskBytes: quant.bytes + GB - 1 }, model, quant).verdict).toBe('disk')
  expect(fit({ ...here, freeDiskBytes: NaN }, model, quant).verdict).toBe('disk')
  expect(fit({ ...here, diskKnown: false }, model, quant).verdict).toBe('disk')
})

test('unknown layouts have a scaled allowance and cannot be called a comfortable fit', () => {
  const small = copy({ params: 0.6, kvBytesPerToken: undefined })
  const tinyQuant: Quantized = { quant: 'Q4_K_M', bytes: 500_000_000, files: [] }
  const f = fit(here, small, tinyQuant)
  expect(kvBytesPerToken(small)).toBe(64 * 1024)
  expect(f.verdict).toBe('tight')
  expect(f.needBytes).toBeLessThan(3 * GB)
  expect(f.note).toContain('unknown')
  expect(kvBytesPerToken(copy({ params: 0, kvBytesPerToken: undefined }))).toBe(1024 ** 2)
  expect(kvBytesPerToken(copy({ params: Infinity, kvBytesPerToken: NaN }))).toBe(1024 ** 2)
})

test('known KV does not excuse invalid model byte sizes', () => {
  for (const bytes of [0, -1, NaN, Infinity]) expect(fit(here, model, { ...quant, bytes }).verdict).not.toBe('fits')
})

test('all expert weights count even when the model has fewer active parameters', () => {
  const coder = entry('qwen3-coder-30b-a3b-instruct')!
  const q = coder.quants.find((q) => q.quant === 'Q4_K_M')!
  expect(fit(here, coder, q).needBytes).toBeGreaterThan(q.bytes)
  expect(fit(here, coder, q).verdict).toBe('too-big')
})

test('initial quant preference is Q4; a comfortable alternative outranks a tight Q4', () => {
  expect(bestQuant(here, model)?.quant.quant).toBe('Q4_K_M')
  const q4 = { ...quant, bytes: 10 * GB }
  const q3 = { ...quant, quant: 'Q3_K_M', bytes: 3 * GB }
  const e = copy({ quants: [q4, q3] })
  expect(bestQuant(here, e)?.quant.quant).toBe('Q3_K_M')
  expect(bestQuant(here, copy({ quants: [] }))).toBeUndefined()
})

test('picks exclude abliterated, gated, restrictive, unknown licence, tight, and disk-blocked entries', () => {
  const invalid = [copy({ id: 'modified', abliterated: true }), copy({ id: 'gated', gated: true }),
    copy({ id: 'restricted', licence: { ...model.licence, restrictive: true } }),
    copy({ id: 'unknown-licence', licence: { ...model.licence, name: 'unknown' } }),
    copy({ id: 'unknown-kv', kvBytesPerToken: undefined })]
  const picks = recommend(here, [...invalid, model])
  expect(picks.best?.entry.id).toBe(model.id)
  expect(picks.fast?.entry.id).toBe(model.id)
  expect(picks.tools?.entry.id).toBe(model.id)
  expect(picks.all).toHaveLength(5)
  expect(picks.uncensored.map((f) => f.entry.id)).toEqual(['modified'])
  expect(recommend({ ...here, freeDiskBytes: 0 }, [model]).best).toBeUndefined()
  expect(recommend({ ...here, budgetBytes: fit(here, model, quant).needBytes }, [copy({ quants: [quant] })]).best).toBeUndefined()
})

test('tool picks obey the shared PLANNER floor, while smaller capable models remain visible', () => {
  const small = copy({ id: 'small-tools', params: PLANNER - 1 })
  const atFloor = copy({ id: 'planner-tools', params: PLANNER })
  expect(recommend(here, [small]).tools).toBeUndefined()
  expect(recommend(here, [small]).all).toHaveLength(1)
  expect(recommend(here, [small, atFloor]).tools?.entry.id).toBe('planner-tools')
})

test('selection is deterministic and never mutates catalog or quant arrays', () => {
  const quants = [...model.quants].reverse()
  const catalog = [copy({ id: 'b', quants }), copy({ id: 'a', quants })]
  const before = JSON.stringify(catalog)
  expect(recommend(here, catalog).best?.entry.id).toBe('a')
  expect(JSON.stringify(catalog)).toBe(before)
})
