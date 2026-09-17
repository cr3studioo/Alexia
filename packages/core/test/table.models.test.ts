// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { noPolling } from './staged.js'
import { Catalog } from '../src/catalog.js'
import { judge } from '../src/health.js'
import { CORE_TABS, MODEL_GROUPS } from '../src/panels.js'
import { usable } from '../src/pool.js'
import { keyOf, type Provider } from '../src/provider.js'
import { MODES, ranking, route, type World } from '../src/router.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { serve, type Serving } from '../src/serve.js'

/**
 * `model_plan.md` §4 C's acceptance: **the table is the ranking.**
 *
 * The Automatic group is `route()`'s plan for a plain request, row for row, and the sentence
 * under every row is `explain()` on the row above. The same was checked on a copy of this Mac's
 * catalog (125 rows with an OpenRouter key, every why-line equal); this is the shape of it, cut
 * to what decides the order — Kilo's free list and OpenRouter's rows for the same models.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-table-'))

const kilo: Provider = { id: 'kilo-gateway', name: 'Kilo Gateway', baseUrl: 'http://127.0.0.1:9/v1', auth: 'optional' }
const openrouter: Provider = { id: 'openrouter', name: 'OpenRouter', baseUrl: 'http://127.0.0.1:9/v1' }

const row = (id: string, name: string, provider: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  name,
  provider,
  tier: 'T1',
  priceIn: 0,
  priceOut: 0,
  context: 262_144,
  supportsTools: true,
  modality: ['text'],
  nsfwOk: 'unknown',
  trainsOnYourData: 'unknown',
  ...over,
})
noPolling(root, [
  row('kilo-auto/free', 'Auto Free', 'kilo-gateway'),
  row('nvidia/nemotron-3-ultra-550b-a55b:free', 'Nemotron 3 Ultra', 'kilo-gateway'),
  row('nvidia/nemotron-3-super-120b-a12b:free', 'Nemotron 3 Super', 'kilo-gateway'),
  row('liquid/lfm-2.5-2.6b:free', 'LFM2.5-2.6B', 'kilo-gateway'),
  row('google/gemma-4-31b-it:free', 'Gemma 4 31B', 'openrouter', { weekly: 391_965_209_752, modality: ['text', 'image'] }),
  row('nvidia/nemotron-3-ultra-550b-a55b:free', 'Nemotron 3 Ultra', 'openrouter', { weekly: 31_889_512_209 }),
  row('nvidia/nemotron-3-super-120b-a12b:free', 'Nemotron 3 Super', 'openrouter', { weekly: 10_043_068_411 }),
  row('liquid/lfm-2.5-2.6b:free', 'LFM2.5-2.6B', 'openrouter', { weekly: 2_056_029 }),
  row('vendor/talker:free', 'Talker', 'openrouter', { supportsTools: false, weekly: 900 }),
  row('vendor/frontier', 'Frontier', 'openrouter', { tier: 'T3', priceIn: 5, priceOut: 15 }),
])

const secrets = memorySecrets()
await secrets.set(CORE, keyOf(openrouter), 'sk-or')
const alexia: Serving = await serve({
  dataDir: root,
  uiDir: join(import.meta.dirname, '..', '..', 'ui'),
  pluginsDir: join(root, 'extensions'),
  secrets,
  providers: [kilo, openrouter],
  local: false,
})

afterAll(async () => {
  await alexia.close()
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const post = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
  (await (
    await fetch(new URL(path, alexia.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alexia-token': alexia.token },
      body: JSON.stringify(body),
    })
  ).json()) as Record<string, unknown>

const rows = async (): Promise<Record<string, string>[]> =>
  ((await post('/api/rows', { key: 'models' })).rows ?? []) as Record<string, string>[]

/** The world `serve()` gathers, built again here from the same files and the same record. */
const gathered = async (): Promise<World> => {
  const catalog = new Catalog(join(root, 'cache', 'models.json'))
  const rungs = await usable(alexia.store, secrets, [kilo, openrouter])
  return {
    models: catalog.models,
    local: [],
    rungs,
    today: { spent: 0, allowance: 0 },
    strikes: alexia.store.strikes(),
    health: judge(
      alexia.store.tries(),
      alexia.store.seen(),
      catalog.models,
      new Set(rungs.filter((rung) => rung.keyed === true).map((rung) => rung.provider.id)),
    ),
  }
}

test('the Automatic group is route()’s plan row for row, and each why-line is explain() on the row above', async () => {
  const world = await gathered()
  const plan = route({ messages: [] }, { placement: MODES.combined, spend: 'free' }, world)
  expect(plan.ok).toBe(true)
  const choices = plan.ok ? plan.choices : []
  const automatic = (await rows()).filter((one) => one.group === MODEL_GROUPS.automatic)

  expect(automatic.map((one) => one.id)).toEqual(choices.map((choice) => `${choice.provider.id}\n${choice.model.id}`))
  const order = ranking(world)
  for (const [at, choice] of choices.entries()) {
    if (at === 0) continue
    expect(automatic[at]?.note, automatic[at]?.id).toBe(order.explain(choice, choices[at - 1]!))
  }
  expect(automatic.map((one) => one.rank)).toEqual(choices.map((_, at) => (at === 0 ? '★ 1' : String(at + 1))))

  // What a person reads, for the shape D159 measured: your key first, the keyless floor after,
  // a 2.6B after the models known to be bigger, a router last, and the talker after hands.
  expect(automatic.map((one) => `${one.name} · ${one.via}`)).toEqual([
    'Gemma 4 31B · OpenRouter · your key',
    'Nemotron 3 Ultra · OpenRouter · your key',
    'Nemotron 3 Super · OpenRouter · your key',
    'LFM2.5-2.6B · OpenRouter · your key',
    'Nemotron 3 Ultra · Kilo Gateway · no key',
    'Nemotron 3 Super · Kilo Gateway · no key',
    'LFM2.5-2.6B · Kilo Gateway · no key',
    'Auto Free · Kilo Gateway · no key',
    'Talker · OpenRouter · your key',
  ])
  expect(automatic[0]?.note).toBe('First choice: the free model Alexia would ask first — on your OpenRouter key, can use tools, 31B.')
  expect(automatic[4]?.note).toBe('No key needed, so shared and rationed for everyone. After models on your key.')
  expect(automatic[0]).toMatchObject({ size: '31B, from its name', can: 'tools · pictures · reads 262k', week: '392.0B', price: 'free' })
  expect(automatic[4]?.week).toBe('31.9B via OpenRouter')

  // And the groups are declared in the order core names them, so the page draws them that way.
  const declared = CORE_TABS.flatMap((tab) => tab.widgets ?? []).find((one) => one.type === 'table' && one.key === 'models')
  expect(declared?.type === 'table' && declared.groupOrder).toEqual(Object.values(MODEL_GROUPS))
  expect((await rows()).filter((one) => one.group === MODEL_GROUPS.paid).map((one) => one.name)).toEqual(['Frontier'])
})

test('one model on two providers is two rows, with two details, and a model set aside moves to its own group', async () => {
  const both = (await rows()).filter((one) => String(one.id).endsWith('\nnvidia/nemotron-3-super-120b-a12b:free'))
  expect(both.map((one) => String(one.id).split('\n')[0])).toEqual(['openrouter', 'kilo-gateway'])
  const details = await Promise.all(both.map(async (one) => String((await post('/api/detail', { key: 'models', row: one.id })).text)))
  expect(details.map((text) => text.split('\n')[0])).toEqual(['Nemotron 3 Super on OpenRouter', 'Nemotron 3 Super on Kilo Gateway'])

  // A whole day of refusals from OpenRouter's copy: it leaves Automatic and is set aside, with
  // what Alexia saw of it in the detail. Kilo's copy of the same model is untouched.
  const at = Date.now() - 3 * 60 * 60 * 1000
  for (const later of [0, 60, 150]) {
    alexia.store.recordTry({
      provider: 'openrouter',
      model: 'nvidia/nemotron-3-super-120b-a12b:free',
      outcome: 'busy',
      status: 429,
      source: 'chat',
      at: at + later * 60_000,
    })
  }
  const after = await rows()
  const aside = after.filter((one) => one.group === MODEL_GROUPS.aside)
  expect(aside.map((one) => one.id)).toEqual(['openrouter\nnvidia/nemotron-3-super-120b-a12b:free'])
  expect(aside[0]).toMatchObject({
    note: 'Set aside: too busy every time for a whole day. One good reply brings it back.',
    state: '■ set aside · always busy for you',
  })
  expect(aside[0]?.tags).toEqual([{ says: 'always busy for you', tone: 'danger' }])
  expect(after.filter((one) => one.group === MODEL_GROUPS.automatic).map((one) => one.id)).toContain(
    'kilo-gateway\nnvidia/nemotron-3-super-120b-a12b:free',
  )
  const seen = String((await post('/api/detail', { key: 'models', row: aside[0]!.id })).text)
  expect(seen).toContain('Said it was too busy 3 times, from ')
  expect(seen).toContain('What Alexia thinks: always busy for you.')
})
