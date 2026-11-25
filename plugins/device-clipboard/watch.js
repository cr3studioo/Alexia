// SPDX-License-Identifier: AGPL-3.0-only
import { keepDays, sha256 } from './history.js'

/**
 * Watches the clipboard and hands new text to the history.
 *
 * `tick()` is one look and is what the tests call. `start()` repeats it every `intervalMs`,
 * one look at a time (a slow helper never piles up a second one behind it). With the `history`
 * setting off a tick does nothing at all: it does not even ask the OS what is on the clipboard.
 */

export const POLL_MS = 2000
const PRUNE_EVERY_MS = 60 * 60 * 1000

export function createWatcher({ clip, history, settings, now = Date.now, intervalMs = POLL_MS }) {
  let last = null
  let prunedAt = 0
  let timer
  let running = false
  let stopped = true

  async function tick() {
    const s = await settings()
    if (s.history === false) {
      last = null
      return 'off'
    }
    const days = keepDays(s.keep_days)
    if (now() - prunedAt > PRUNE_EVERY_MS) {
      prunedAt = now()
      await history.prune(days)
    }
    const seen = await clip.read()
    if (seen.sensitive || seen.kind !== 'text' || typeof seen.text !== 'string') {
      last = null
      return seen.sensitive ? 'sensitive' : 'not-text'
    }
    const hash = sha256(seen.text)
    if (hash === last) return 'same'
    last = hash
    return (await history.record(seen.text, days)) ? 'stored' : 'skipped'
  }

  function schedule() {
    if (stopped) return
    timer = setTimeout(async () => {
      if (running) return schedule()
      running = true
      try {
        await tick()
      } catch {
        // A failed look is a missed copy, not a reason to stop watching. Nothing is logged:
        // the only thing that could be in the message is the clipboard's content.
      } finally {
        running = false
        schedule()
      }
    }, intervalMs)
    timer.unref?.()
  }

  return {
    tick,
    start() {
      if (!stopped) return
      stopped = false
      schedule()
    },
    stop() {
      stopped = true
      clearTimeout(timer)
    },
    get running() {
      return !stopped
    },
  }
}
