// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { createTimer } from '../timer.js'

test('two quick arm() calls leave exactly one timer running', async () => {
  const live = new Set()
  let next = 1
  const releases = []
  const timer = createTimer({
    every: () => new Promise((resolve) => releases.push(resolve)), // settings() answers later
    run: async () => {},
    set: () => {
      const id = next++
      live.add(id)
      return id
    },
    clear: (id) => live.delete(id),
  })
  const one = timer.arm()
  const two = timer.arm() // both started before either settings() has answered
  releases[0]('hourly')
  releases[1]('daily')
  await Promise.all([one, two])
  expect(live.size).toBe(1)
  timer.stop()
  expect(live.size).toBe(0)
})
