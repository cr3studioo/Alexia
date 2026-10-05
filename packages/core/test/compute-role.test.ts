// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, test, vi } from 'vitest'
import { readRole, ROLE_KEY, RoleSwitcher } from '../src/compute/role.js'
import { CORE } from '../src/secrets.js'
import { Store } from '../src/store.js'

const stores: Store[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
const fixture = () => {
  const store = new Store(':memory:')
  stores.push(store)
  const active = vi.fn(() => 0)
  const cancelActive = vi.fn(async () => {})
  const stop = vi.fn(async () => {})
  const restart = vi.fn()
  const switcher = new RoleSwitcher({ store, active, cancelActive, stop, restart })
  return { store, active, cancelActive, stop, restart, switcher }
}

test('the persisted role defaults to interaction without rewriting the store', () => {
  const { store } = fixture()
  const write = vi.spyOn(store, 'kvSet')
  expect(readRole(store)).toBe('interaction')
  expect(write).not.toHaveBeenCalled()
  store.kvSet(CORE, ROLE_KEY, 'compute')
  expect(readRole(store)).toBe('compute')
  store.kvSet(CORE, ROLE_KEY, 'unknown')
  expect(readRole(store)).toBe('interaction')
})

test('switching waits for zero active work and saves the role only after stop, preserving chats and pins', async () => {
  const f = fixture()
  const session = f.store.createSession('Keep this conversation')
  f.store.append(session, { role: 'user', content: 'A message from before the switch.' })
  f.store.kvSet(CORE, 'pins', { model: 'llama/x', order: ['llama/x'], spend: 'free' })
  const history = f.store.history(session)
  const sessions = f.store.sessions()
  const pin = f.store.kvGet(CORE, 'pins')
  let count = 2
  f.active.mockImplementation(() => count)
  const order: string[] = []
  let stopped!: () => void
  const stopping = new Promise<void>((resolve) => { stopped = resolve })
  f.stop.mockImplementation(async () => { order.push('stop'); await stopping; order.push('stopped') })
  const write = f.store.kvSet.bind(f.store)
  vi.spyOn(f.store, 'kvSet').mockImplementation((ns, key, value) => { order.push(`write:${key}`); write(ns, key, value) })
  f.restart.mockImplementation(() => { order.push('restart'); expect(readRole(f.store)).toBe('compute') })

  expect(f.switcher.status()).toBeUndefined()
  expect(f.switcher.request('compute').ok).toBe(true)
  expect(f.switcher.status()).toMatchObject({ target: 'compute', phase: 'waiting', active: 2 })
  expect(f.switcher.request('compute').ok).toBe(false)
  expect(f.switcher.request('interaction').ok).toBe(false)
  expect(f.stop).not.toHaveBeenCalled()
  expect(readRole(f.store)).toBe('interaction')
  const snapshot = f.switcher.status()!
  snapshot.phase = 'failed'
  expect(f.switcher.status()?.phase).toBe('waiting')

  count = 1
  await vi.waitFor(() => expect(f.switcher.status()?.active).toBe(1))
  expect(f.stop).not.toHaveBeenCalled()
  count = 0
  await vi.waitFor(() => expect(f.stop).toHaveBeenCalledOnce())
  expect(f.switcher.status()).toMatchObject({ phase: 'stopping' })
  expect(f.switcher.status()?.active).toBeUndefined()
  expect(readRole(f.store)).toBe('interaction')
  expect(order).toEqual(['stop'])
  stopped()
  await vi.waitFor(() => expect(f.switcher.status()?.phase).toBe('restarting'))
  expect(order).toEqual(['stop', 'stopped', `write:${ROLE_KEY}`, 'restart'])
  expect(f.cancelActive).not.toHaveBeenCalled()
  expect(f.store.history(session)).toEqual(history)
  expect(f.store.sessions()).toEqual(sessions)
  expect(f.store.kvGet(CORE, 'pins')).toEqual(pin)
})

test('explicit cancellation is awaited and still waits for active work to drain', async () => {
  const f = fixture()
  let count = 1
  f.active.mockImplementation(() => count)
  let cancelled!: () => void
  f.cancelActive.mockImplementation(() => new Promise<void>((resolve) => { cancelled = resolve }))
  expect(f.switcher.request('compute', { cancel: true }).ok).toBe(true)
  expect(f.cancelActive).toHaveBeenCalledOnce()
  expect(f.stop).not.toHaveBeenCalled()
  cancelled()
  await vi.waitFor(() => expect(f.switcher.status()?.active).toBe(1))
  expect(f.stop).not.toHaveBeenCalled()
  count = 0
  await vi.waitFor(() => expect(f.restart).toHaveBeenCalledOnce())
  expect(readRole(f.store)).toBe('compute')
})

test('the current role is refused without cancellation or shutdown', () => {
  const f = fixture()
  expect(f.switcher.request('interaction', { cancel: true }).ok).toBe(false)
  expect(f.switcher.status()).toBeUndefined()
  expect(f.cancelActive).not.toHaveBeenCalled()
  expect(f.stop).not.toHaveBeenCalled()
  expect(f.restart).not.toHaveBeenCalled()
})

test('a failed stop retains the old role and permits an explicit retry', async () => {
  const f = fixture()
  f.store.kvSet(CORE, ROLE_KEY, 'compute')
  f.stop.mockRejectedValueOnce(new Error('A worker could not stop.'))
  f.switcher.request('interaction')
  await vi.waitFor(() => expect(f.switcher.status()).toMatchObject({ phase: 'failed', message: 'A worker could not stop.' }))
  expect(readRole(f.store)).toBe('compute')
  expect(f.restart).not.toHaveBeenCalled()
  expect(f.switcher.request('interaction').ok).toBe(true)
  await vi.waitFor(() => expect(f.restart).toHaveBeenCalledOnce())
  expect(readRole(f.store)).toBe('interaction')
})

test('failed cancellation or persistence never restarts', async () => {
  const cancelled = fixture()
  cancelled.cancelActive.mockRejectedValueOnce(new Error('Cancellation failed.'))
  cancelled.switcher.request('compute', { cancel: true })
  await vi.waitFor(() => expect(cancelled.switcher.status()?.phase).toBe('failed'))
  expect(cancelled.stop).not.toHaveBeenCalled()
  expect(cancelled.restart).not.toHaveBeenCalled()
  expect(readRole(cancelled.store)).toBe('interaction')

  const saved = fixture()
  vi.spyOn(saved.store, 'kvSet').mockImplementation(() => { throw new Error('Storage failed.') })
  saved.switcher.request('compute')
  await vi.waitFor(() => expect(saved.switcher.status()).toMatchObject({ phase: 'failed', message: 'Storage failed.' }))
  expect(saved.stop).toHaveBeenCalledOnce()
  expect(saved.restart).not.toHaveBeenCalled()
  expect(readRole(saved.store)).toBe('interaction')
})
