// SPDX-License-Identifier: AGPL-3.0-only
import { CORE_CAPABILITIES } from '@alexia/protocol'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { exchange } from '../src/serve.js'

/**
 * Core's half of M7-3: it hands over what was just said, and then it is not core's business.
 *
 * The plugin's half — the buffer, the tick, the duplicate overrule, the quarantine — is in
 * `plugins/memory/test/capture.test.js`, because none of it is core's and none of it may
 * become core's. What is here is the boundary: what crosses it, what does not, and the fact
 * that nothing waits on the answer.
 */

test('a credential does not reach a memory, and a street does', () => {
  // The two doors, and the asymmetry between them. What may be *written down* is not what
  // may be *sent*: an address is worth remembering and only dangerous when it leaves, while
  // a key is the one thing that must be in neither.
  const said = exchange(
    'put OPENROUTER_API_KEY=sk-or-v1-9f2a8c7b6d5e4f3a2b1c0d9e in .env — I am at 12 Baker Street today',
    'Done. Anything else?',
    1000,
  )
  expect(said.said).not.toContain('sk-or-v1-9f2a8c7b6d5e4f3a2b1c0d9e')
  expect(said.said).toContain('12 Baker Street')
  expect(said).toMatchObject({ answered: 'Done. Anything else?', at: 1000 })

  // Both halves are scanned. The answer is a model's words, and a model that has just read a
  // file back to somebody is a model that has just put its contents in the answer.
  expect(exchange('what is in .env', 'It says AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCY').answered).not.toContain(
    'wJalrXUtnFEMIK7MDENGbPxRfiCY',
  )
})

test('core hands it over and does not wait, and does not care if nobody is listening', () => {
  // Read out of the source, because what matters is the shape of the call rather than a
  // value it returns. A memory that could delay an answer is a memory people turn off, and
  // one that could throw would break a conversation over a flourish.
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'serve.ts'), 'utf8')
  const [handoff] = source.split('\n').filter((line) => line.includes('CORE_CAPABILITIES.capture'))

  // `void` and `.catch` are the whole of the promise. Awaiting it would put a plugin between
  // somebody and their answer; not catching it would let a plugin having a bad day end a
  // conversation that had already finished.
  expect(handoff, 'the hand-off went missing').toBeDefined()
  expect(handoff).toContain('void plugins.capability')
  expect(handoff).toContain('.catch(')

  // And the payload comes from `exchange`, not from an argument list assembled here — which
  // is how the scan would go missing on the day somebody adds a third field.
  expect(handoff).toContain('exchange(')
})

test('the name core knows is a capability, not a plugin', () => {
  // Invariant 1, in the one place M7-3 could have broken it. Core asks for *whatever
  // remembers things* and never learns who answered — the capability registry holds the
  // name, `packages/protocol` holds the constant, and core holds neither.
  expect(CORE_CAPABILITIES.capture).toBe('memory.capture')
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'serve.ts'), 'utf8')
  expect(source).not.toContain(CORE_CAPABILITIES.capture)
})
