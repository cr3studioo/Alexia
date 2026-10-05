// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { HOSTS_KEY, Hosts, mintHostId } from '../src/compute/hosts.js'
import { rememberTarget, selectedTarget, TARGET_KEY } from '../src/compute/target.js'
import { ComputeError, type PairedHost } from '../src/compute/types.js'
import { CORE } from '../src/secrets.js'
import { Store } from '../src/store.js'

const stores: Store[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
const fixture = () => { const store = new Store(':memory:'); stores.push(store); return store }
const peer: Omit<PairedHost, 'id' | 'pairedAt'> = { name: 'Compute computer', endpointId: 'public-endpoint', peerRole: 'compute' }

test('host ids contain twelve lower-case letters or digits and can use injected randomness', () => {
  const random = vi.fn((bytes: number) => Uint8Array.from({ length: bytes }, (_, i) => i + 24))
  expect(mintHostId(random)).toBe('yz0123456789')
  expect(random).toHaveBeenCalledExactlyOnceWith(12)
  const ids = Array.from({ length: 100 }, () => mintHostId())
  expect(ids.every((id) => /^[a-z0-9]{12}$/.test(id))).toBe(true)
  expect(new Set(ids).size).toBe(ids.length)
})

test('public host records survive reopening and expose only paired endpoint identities', () => {
  const root = mkdtempSync(join(tmpdir(), 'alexia-hosts-'))
  const file = join(root, 'alexia.db')
  let store = new Store(file)
  try {
    const hosts = new Hosts(store, 'interaction')
    const first = hosts.add({ ...peer, platform: 'win32', appVersion: '1.0.0' }, 100)
    const second = hosts.add({ ...peer, name: 'Second computer', endpointId: 'second-public-endpoint' }, 200)
    expect(first).toMatchObject({ ...peer, pairedAt: 100, platform: 'win32', appVersion: '1.0.0' })
    expect(hosts.get(first.id)).toEqual(first)
    expect(hosts.byEndpoint(peer.endpointId)).toEqual(first)
    expect(hosts.allowlist()).toEqual([peer.endpointId, second.endpointId])
    store.close()
    store = new Store(file)
    expect(new Hosts(store, 'interaction').list()).toEqual([first, second])
    expect(store.kvGet(CORE, HOSTS_KEY)).toEqual([first, second])
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('the compute role refuses a second controller until the first is explicitly unpaired', () => {
  const store = fixture()
  const hosts = new Hosts(store, 'compute')
  const controller = { ...peer, name: 'Interaction computer', peerRole: 'interaction' as const }
  const first = hosts.add(controller, 100)
  const changed = vi.fn()
  hosts.onChange(changed)
  const write = vi.spyOn(store, 'kvSet')
  for (const endpointId of ['second-controller', first.endpointId]) {
    expect(() => new Hosts(store, 'compute').add({ ...controller, endpointId })).toThrow(ComputeError)
    try { hosts.add({ ...controller, endpointId }) } catch (error) {
      expect((error as ComputeError).failure()).toEqual({ code: 'refused', message: 'Unpair the current computer first.' })
    }
  }
  expect(hosts.list()).toEqual([first])
  expect(write).not.toHaveBeenCalled()
  expect(changed).not.toHaveBeenCalled()
  expect(hosts.remove(first.id)).toEqual(first)
  const second = hosts.add({ ...controller, endpointId: 'second-controller' }, 200)
  expect(hosts.list()).toEqual([second])
})

test('touch and remove persist before notifying, and returned records cannot mutate trust', () => {
  const store = fixture()
  const hosts = new Hosts(store, 'interaction')
  const seen: PairedHost[][] = []
  const unsubscribe = hosts.onChange(() => { seen.push(new Hosts(store, 'interaction').list()) })
  const first = hosts.add(peer, 100)
  const original = { ...first }
  first.endpointId = 'untrusted-endpoint'
  hosts.list()[0]!.endpointId = 'also-untrusted'
  expect(hosts.allowlist()).toEqual([peer.endpointId])
  hosts.touch(first.id, { name: 'Renamed computer', lastSeenAt: 200, platform: 'win32', appVersion: '2.0.0' })
  expect(hosts.get(first.id)).toEqual({ ...original, name: 'Renamed computer', lastSeenAt: 200, platform: 'win32', appVersion: '2.0.0' })
  expect(seen).toHaveLength(2)
  expect(seen[1]).toEqual(hosts.list())
  hosts.touch('missing0host', { name: 'Missing' })
  hosts.touch(first.id, { lastSeenAt: 200 })
  expect(hosts.remove('missing0host')).toBeUndefined()
  expect(seen).toHaveLength(2)
  unsubscribe()
  expect(hosts.remove(first.id)?.id).toBe(first.id)
  expect(hosts.allowlist()).toEqual([])
  expect(seen).toHaveLength(2)
})

test('unpairing the selected host clears the target and model pins without resurrecting an old choice', () => {
  const store = fixture()
  const hosts = new Hosts(store, 'interaction')
  const selected = hosts.add(peer)
  const other = hosts.add({ ...peer, endpointId: 'other-public-endpoint' })
  rememberTarget(store, { hostId: 'this', modelId: 'llama/old' })
  rememberTarget(store, { hostId: selected.id, modelId: 'llama/x' })
  const pins = { model: `@${selected.id}/llama/x`, order: [`@${selected.id}/llama/x`], prefer: 'best', spend: 'free', noTrain: true }
  store.kvSet(CORE, 'mode', 'local')
  store.kvSet(CORE, 'pins', pins)
  hosts.remove(other.id)
  expect(selectedTarget(store)).toEqual({ hostId: selected.id, modelId: 'llama/x' })
  expect(store.kvGet(CORE, 'pins')).toEqual(pins)
  const changed = vi.fn(() => expect(selectedTarget(store)).toBeUndefined())
  hosts.onChange(changed)
  hosts.remove(selected.id)
  expect(changed).toHaveBeenCalledOnce()
  expect(store.kvGet(CORE, TARGET_KEY)).toBeNull()
  expect(selectedTarget(store)).toBeUndefined()
  expect(store.kvGet(CORE, 'pins')).toEqual({ prefer: 'best', spend: 'free', noTrain: true })
  expect(store.kvGet(CORE, 'mode')).toBe('local')
  expect(store.kvGet(CORE, 'last_local_model')).toBe('llama/old')
})

test('interaction pairing is idempotent by endpoint and persists only the public record fields', () => {
  const store = fixture()
  const hosts = new Hosts(store, 'interaction')
  const extra = { ...peer, unrelated: 'discard this field' }
  const first = hosts.add(extra, 100)
  expect(store.kvGet(CORE, HOSTS_KEY)).toEqual([{ ...peer, id: first.id, pairedAt: 100 }])
  expect(hosts.add(peer, 200)).toEqual(first)
  expect(hosts.list()).toHaveLength(1)
})

test('damaged persisted records cannot become allowlisted endpoints', () => {
  const store = fixture()
  const hosts = new Hosts(store, 'interaction')
  store.kvSet(CORE, HOSTS_KEY, { endpointId: 'not-paired' })
  expect(hosts.list()).toEqual([])
  store.kvSet(CORE, HOSTS_KEY, [null, { ...peer, id: 'invalid', pairedAt: 100 }, { ...peer, id: 'abcdefgh1234' }])
  expect(hosts.allowlist()).toEqual([])
})
