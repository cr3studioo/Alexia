// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { Acks } from '../acks.js'

/**
 * The offset that survives a restart (D194).
 *
 * The rule is one sentence — *the oldest update that has not finished, or one past the newest
 * that has* — and every way it goes wrong is a real failure a person would see: too high and a
 * message is silently dropped, too low and an answer (and every tool it ran) happens twice.
 * Since messages finish out of order — the loop deals with a button press on the spot while
 * the answer ahead of it is still being written — that is the case worth pinning down.
 */

test('nothing has arrived, so there is nothing to say', () => {
  const acks = new Acks()
  expect(acks.mark).toBeUndefined()
  expect(acks.open).toBe(0)
})

test('one update, finished, marks the next one', () => {
  const acks = new Acks()
  acks.received(7)
  // While it is in flight, the restart point is the update itself: a crash now has not
  // answered it, so it must come back.
  expect(acks.mark).toBe(7)
  expect(acks.done(7)).toBe(8)
})

test('the oldest unfinished update holds the mark back', () => {
  const acks = new Acks()
  acks.received(10)
  acks.received(11)
  acks.received(12)
  // 11 and 12 are done, 10 is still being answered. Restarting at 13 would lose 10.
  expect(acks.done(11)).toBe(10)
  expect(acks.done(12)).toBe(10)
  expect(acks.done(10)).toBe(13)
})

test('a batch finished in order walks the mark forward one at a time', () => {
  const acks = new Acks()
  for (const id of [1, 2, 3]) acks.received(id)
  expect(acks.done(1)).toBe(2)
  expect(acks.done(2)).toBe(3)
  expect(acks.done(3)).toBe(4)
})

test('the mark never goes backwards when a later batch arrives', () => {
  const acks = new Acks()
  acks.received(5)
  expect(acks.done(5)).toBe(6)
  acks.received(9)
  expect(acks.mark).toBe(9)
  expect(acks.done(9)).toBe(10)
})

test('finishing something twice is harmless', () => {
  const acks = new Acks()
  acks.received(3)
  expect(acks.done(3)).toBe(4)
  expect(acks.done(3)).toBe(4)
  // And one that was never received, which is what a dropped job could look like.
  expect(acks.done(99)).toBe(4)
})

test('open counts what is still in flight', () => {
  const acks = new Acks()
  acks.received(1)
  acks.received(2)
  expect(acks.open).toBe(2)
  acks.done(1)
  expect(acks.open).toBe(1)
})

test('anything that is not an update id is ignored rather than stored', () => {
  const acks = new Acks()
  acks.received(undefined)
  acks.received('4')
  acks.received(1.5)
  expect(acks.mark).toBeUndefined()
  expect(acks.open).toBe(0)
})
