// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { CALLBACK_LIMIT } from '../api.js'
import { Asking } from '../asking.js'

/**
 * The button, and the 64 bytes it has to fit in (M7-5).
 *
 * Telegram caps `callback_data`, and the decision worth holding still is what was done about
 * it: **the action never travels.** Shortening one to fit is a length check somebody has to
 * remember, and a permission question is exactly where a forgotten one turns into a silently
 * truncated answer. So the button carries an opaque token of a fixed size and the action is
 * looked up on this side — which makes the limit a property of the shape rather than
 * something a reviewer has to keep checking.
 */

test('a token is opaque and fits, whatever the action says', () => {
  const asking = new Asking()
  const enormous = 'x'.repeat(5000)
  const { buttons } = asking.ask([`Yes, ${enormous}`, `No, ${enormous}`])

  for (const button of buttons) {
    expect(Buffer.byteLength(button.data, 'utf8')).toBeLessThan(CALLBACK_LIMIT)
    // Opaque: nothing about the action is recoverable from what crossed the wire.
    expect(button.data).not.toContain('x')
  }
  // And the label is the action, which is the half that does have room.
  expect(buttons[0].label).toContain(enormous)
})

test('a press answers the question that was waiting', async () => {
  const asking = new Asking()
  const { buttons, answer } = asking.ask(['Yes', 'No'])
  expect(asking.waiting).toBe(1)

  expect(asking.press(buttons[1].data)).toBe('No')
  await expect(answer).resolves.toBe('No')
  // Spent. A message somebody scrolls back to cannot answer the same question twice.
  expect(asking.press(buttons[1].data)).toBeUndefined()
  expect(asking.waiting).toBe(0)
})

test('two questions do not answer each other', async () => {
  const asking = new Asking()
  const one = asking.ask(['A', 'B'])
  const two = asking.ask(['A', 'B'])
  expect(one.buttons[0].data).not.toBe(two.buttons[0].data)

  asking.press(two.buttons[0].data)
  await expect(two.answer).resolves.toBe('A')
  expect(asking.waiting).toBe(1)
})

test('a token nobody is waiting on answers nothing, and a restart settles them all', async () => {
  const asking = new Asking()
  expect(asking.press('deadbeef.0')).toBeUndefined()
  expect(asking.press(undefined)).toBeUndefined()

  const { answer } = asking.ask(['Yes', 'No'])
  // The loop that was listening is gone, so nothing will ever press it. Left open, the task
  // waiting on the other end waits forever; settled, core reads *no answer* as no.
  asking.close()
  await expect(answer).resolves.toBeUndefined()
})
