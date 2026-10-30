// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { cachedContext, currentContext } from '../src/current-context.js'
test('context absence, failure, errors and slow providers never stop conversations', async () => {
  expect(await currentContext({ answers: () => false, capability: async () => { throw new Error('must not call') } })).toBe('')
  expect(await currentContext({ answers: () => true, capability: async () => { throw new Error('secret') } })).toBe('')
  expect(await currentContext({ answers: () => true, capability: async () => ({ isError: true, content: [{ type: 'text', text: 'secret' }] }) })).toBe('')
  expect(await currentContext({ answers: () => true, capability: () => new Promise(() => {}) }, 5)).toBe('')
})
test('only bounded text reaches the prompt', async () => {
  const text = await currentContext({ answers: () => true, capability: async () => ({ content: [{ type: 'image', data: 'secret' }, { type: 'text', text: 'a'.repeat(2000) }] }) })
  expect(text).toHaveLength(1500); expect(text).not.toContain('secret')
})

test('after the first turn, context comes from the cache and a stale one refreshes behind the turn', async () => {
  let clock = 0; let asked = 0; let on = true; let said = 'one'
  const read = cachedContext({ answers: () => on, capability: async () => { asked++; return { content: [{ type: 'text', text: said }] } } }, { now: () => clock, fresh: 100 })
  expect(await read()).toBe('one')
  said = 'two'
  expect(await read()).toBe('one'); expect(asked).toBe(1)
  clock = 100
  expect(await read()).toBe('one'); expect(asked).toBe(2)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(await read()).toBe('two')
  on = false
  expect(await read()).toBe('')
})
test('a provider slower than the wait still fills the cache for the next turn', async () => {
  let release!: () => void
  const read = cachedContext({ answers: () => true, capability: () => new Promise((resolve) => { release = () => resolve({ content: [{ type: 'text', text: 'late' }] }) }) }, { timeout: 5 })
  expect(await read()).toBe('')
  release(); await new Promise((resolve) => setTimeout(resolve, 0))
  expect(await read()).toBe('late')
})
