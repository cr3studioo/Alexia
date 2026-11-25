// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The reindex timer. `arm` can be called again and again (every settings change does); only the
 * latest call may leave a timer running, and the old one is cleared only once the new one is
 * ready, so two calls in quick succession can never leave a second timer behind.
 *
 * `every()` resolves to `'hourly'` or `'daily'`; the timers are handed in so a test can fake them.
 */
export function createTimer({ every, run, set = setInterval, clear = clearInterval }) {
  let timer
  let generation = 0
  return {
    async arm() {
      const mine = (generation += 1)
      const choice = await every().catch(() => undefined)
      if (mine !== generation) return // a later arm() is already on its way
      clear(timer)
      timer = set(() => void run(), choice === 'daily' ? 24 * 60 * 60_000 : 60 * 60_000)
      // Nothing waits on it: a timer that holds the process open would keep the plugin resident.
      timer.unref?.()
    },
    stop() {
      generation += 1
      clear(timer)
      timer = undefined
    },
  }
}
