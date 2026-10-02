// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { rememberTarget, remoteModel, remoteModels, selectedHost, selectedTarget, TARGET_KEY } from '../src/compute/target.js'
import { parseCatalogId, type HostModel, type HostView } from '../src/compute/types.js'
import { CORE } from '../src/secrets.js'
import { Store } from '../src/store.js'

const HOST = 'k3x9q2m7vd4p'
const stores: Store[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
const fixture = () => { const store = new Store(':memory:'); stores.push(store); return store }
const model: HostModel = {
  id: 'llama/x', name: 'Model X', engine: 'llama', context: 8192, supportsTools: true,
  modality: ['text', 'image'], params: 8, quant: 'Q4_K_M', diskBytes: 4000, abliterated: true, loaded: false,
}
const view = (id: string, known = true): HostView => ({
  host: { id, name: 'Other computer', endpointId: `endpoint-${id}`, peerRole: 'compute', pairedAt: 1 },
  connection: 'offline',
  ...(known && { inventory: {
    name: 'Other computer', appVersion: '0.0.0', revision: 1, models: [model], capabilities: [], setup: [],
    machine: { platform: 'win32', arch: 'x64', chip: 'Test', appleSilicon: false, ramBytes: 32e9, freeDiskBytes: 10e9, budgetBytes: 16e9 },
  } }),
})

test('last_local_model migrates to this computer, survives reopening, and leaves every pin unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'alexia-target-'))
  const file = join(root, 'alexia.db')
  let store = new Store(file)
  try {
    const pin = { model: 'llama/pinned', order: ['llama/pinned', 'qwen3:8b'], prefer: 'best', spend: 'free', uncensored: true }
    store.kvSet(CORE, 'last_local_model', 'llama/x')
    store.kvSet(CORE, 'pins', pin)
    const write = vi.spyOn(store, 'kvSet')
    expect(selectedTarget(store)).toEqual({ hostId: 'this', modelId: 'llama/x' })
    expect(store.kvGet(CORE, TARGET_KEY)).toEqual({ hostId: 'this', modelId: 'llama/x' })
    expect(store.kvGet(CORE, 'pins')).toEqual(pin)
    expect(store.kvGet(CORE, 'last_local_model')).toBe('llama/x')
    expect(write).toHaveBeenCalledExactlyOnceWith(CORE, TARGET_KEY, { hostId: 'this', modelId: 'llama/x' })
    expect(parseCatalogId(pin.model)).toEqual({ hostId: 'this', modelId: 'llama/pinned' })
    selectedTarget(store)
    expect(write).toHaveBeenCalledOnce()
    store.close()
    store = new Store(file)
    expect(selectedTarget(store)).toEqual({ hostId: 'this', modelId: 'llama/x' })
    expect(store.kvGet(CORE, 'pins')).toEqual(pin)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('Local can migrate its pin when no usable remembered choice exists', () => {
  const store = fixture()
  store.kvSet(CORE, 'mode', 'local')
  store.kvSet(CORE, 'last_local_model', '')
  const pin = { model: 'qwen3:8b', order: ['qwen3:8b'], noTrain: true }
  store.kvSet(CORE, 'pins', pin)
  expect(selectedTarget(store)).toEqual({ hostId: 'this', modelId: 'qwen3:8b' })
  expect(store.kvGet(CORE, 'pins')).toEqual(pin)
  expect(store.kvGet(CORE, 'last_local_model')).toBe('')
})

test.each(['cloud', 'combined', undefined])('a pin in %s mode is not a saved local target', (mode) => {
  const store = fixture()
  if (mode) store.kvSet(CORE, 'mode', mode)
  store.kvSet(CORE, 'pins', { model: 'hosted/model' })
  const write = vi.spyOn(store, 'kvSet')
  expect(selectedTarget(store)).toBeUndefined()
  expect(selectedHost(store)).toBe('this')
  expect(write).not.toHaveBeenCalled()
})

test('the saved target takes precedence, and selecting a remote host retains the local downgrade choice', () => {
  const store = fixture()
  rememberTarget(store, { hostId: 'this', modelId: 'llama/x' })
  expect(store.kvGet(CORE, 'last_local_model')).toBe('llama/x')
  rememberTarget(store, { hostId: HOST, modelId: 'llama/x' })
  expect(selectedTarget(store)).toEqual({ hostId: HOST, modelId: 'llama/x' })
  expect(selectedHost(store)).toBe(HOST)
  expect(store.kvGet(CORE, 'last_local_model')).toBe('llama/x')
})

test.each([null, '', {}, { hostId: 'wrong', modelId: 'x' }])('a cleared or damaged target %j never falls back to an older selection', (saved) => {
  const store = fixture()
  store.kvSet(CORE, TARGET_KEY, saved)
  store.kvSet(CORE, 'last_local_model', 'llama/x')
  store.kvSet(CORE, 'mode', 'local')
  store.kvSet(CORE, 'pins', { model: 'llama/old' })
  const write = vi.spyOn(store, 'kvSet')
  expect(selectedTarget(store)).toBeUndefined()
  expect(write).not.toHaveBeenCalled()
})

test('remembering an invalid target fails before writing either selection', () => {
  const store = fixture()
  const write = vi.spyOn(store, 'kvSet')
  expect(() => rememberTarget(store, { hostId: 'bad', modelId: 'x' })).toThrow()
  expect(write).not.toHaveBeenCalled()
})

test('remote rows qualify the native model id and retain the model name and capabilities', () => {
  const row = remoteModel(HOST, model)
  expect(row).toEqual({
    id: `@${HOST}/llama/x`, name: 'Model X', provider: 'remote', tier: 'T0', host: HOST,
    priceIn: 0, priceOut: 0, context: 8192, supportsTools: true, modality: ['text', 'image'],
    nsfwOk: 'yes', trainsOnYourData: 'no', params: 8, quant: 'Q4_K_M', diskBytes: 4000, abliterated: true,
  })
  expect(remoteModel('another0host', model).id).not.toBe(row.id)
  row.modality.push('audio')
  expect(model.modality).toEqual(['text', 'image'])
})

test('remote rows belong only to the selected host with known inventory, including its offline cache', () => {
  const views = [view(HOST), view('another0host'), view('unknown0host', false)]
  expect(remoteModels(views, HOST).map((row) => row.id)).toEqual([`@${HOST}/llama/x`])
  expect(remoteModels(views, 'another0host').map((row) => row.id)).toEqual(['@another0host/llama/x'])
  for (const selected of ['this', 'unknown0host', 'missing0host']) expect(remoteModels(views, selected)).toEqual([])
})
