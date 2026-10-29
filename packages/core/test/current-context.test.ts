// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { currentContext } from '../src/current-context.js'
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
