// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { Catalog, type Model } from '../src/catalog.js'
import { pins } from '../src/commands.js'
import { Store } from '../src/store.js'
import { actions, type SurfaceOptions } from '../src/surface.js'

/**
 * **A model on this Mac is a row on the Models table, and *Use this* pins it** — it lists what is
 * installed beside what providers serve, and a press on one of those rows used to answer *That
 * model is not in the catalog any more*, because the catalog is only the providers' lists.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-pin-local-'))
const store = new Store(':memory:')
afterAll(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

const here: Model = {
  id: 'qwen3:8b',
  name: 'qwen3:8b',
  provider: 'ollama',
  tier: 'T0',
  priceIn: 0,
  priceOut: 0,
  context: 32_768,
  supportsTools: true,
  modality: ['text'],
  nsfwOk: 'unknown',
  trainsOnYourData: 'no',
}

// Only what *Use this* reads: the catalog, the keys, and what the router can see.
const act = actions({
  store,
  catalog: new Catalog(join(root, 'models.json')),
  connected: () => Promise.resolve(new Set<string>()),
  world: () => Promise.resolve({ models: [], local: [here], rungs: [] }),
} as unknown as SurfaceOptions)

test('Use this on a model on this Mac pins it, and wants no key', async () => {
  const said = await act.use_model!('ollama\nqwen3:8b')
  expect(said.ok).toBe(true)
  expect(pins(store).model).toBe('qwen3:8b')
  // Something neither installed nor listed is still the sentence it always was.
  expect((await act.use_model!('ollama\nnot-installed')).said).toBe('That model is not in the catalog any more.')
})
