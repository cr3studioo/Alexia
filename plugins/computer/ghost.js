// SPDX-License-Identifier: AGPL-3.0-only

/**
 * **Her own cursor: where she is about to act, shown on screen** (PC-02).
 *
 * The owner's pointer stays theirs; what marks the spot Alexia acts on is `cursor.show`, which
 * some other plugin may provide (screen ink, P4-26). This plugin never names that plugin: it asks
 * core whether anything answers the capability (`alexia/answers`) and, when something does, calls
 * it through `alexia/capability/call`. Nothing answers — no call. The owner turned it off — no
 * call.
 *
 * **It is a nicety, and it is timed like one.** Every `show` returns within {@link WAIT_MS},
 * whatever the provider does: an action is never held up by a slow cursor. What the provider is
 * still doing after that is let go, and its answer, late or failed, is dropped. Whether anything
 * answers is asked at most once every {@link ASK_EVERY_MS}, because a provider being installed
 * or removed is a rare event and asking is a round trip.
 */

/** The longest `show` is ever waited for. */
export const WAIT_MS = 200

/** How long an `alexia/answers` reply is believed. */
export const ASK_EVERY_MS = 60_000

/** The capability, as `docs/spec/capabilities.md` names it. */
export const CAP = 'cursor.show'

/**
 * A `show` bound to this plugin's ways of asking.
 *
 * - `answers(cap)` → `{ answers: boolean }` (`alexia.answers`)
 * - `capability(cap, args)` → the provider's result (`alexia.capability`)
 * - `settings()` → this plugin's settings; `show_cursor: false` turns it off (default on)
 *
 * `show(x, y)` resolves to what happened, for logs and tests: `shown`, `off` (setting),
 * `none` (no provider), `slow` (let go at {@link WAIT_MS}), or `failed`. It never rejects.
 */
export function ghost({ answers, capability, settings, now = Date.now, wait = WAIT_MS, every = ASK_EVERY_MS }) {
  let known

  async function provided() {
    const at = now()
    if (known && at - known.at < every) return known.yes
    // Asked, and the answer kept, even while it is in flight: two shows in a row ask once.
    const asking = Promise.resolve()
      .then(() => answers(CAP))
      .then((said) => said?.answers === true)
      .catch(() => false)
    known = { at, yes: asking }
    return asking
  }

  async function attempt(x, y) {
    const s = await Promise.resolve()
      .then(() => settings())
      .catch(() => ({}))
    if (s?.show_cursor === false) return 'off'
    if (!(await provided())) return 'none'
    await capability(CAP, { x: Math.round(x), y: Math.round(y), label: 'Alexia' })
    return 'shown'
  }

  return {
    show(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return Promise.resolve('none')
      let timer
      const late = new Promise((resolve) => {
        timer = setTimeout(() => resolve('slow'), wait)
        timer.unref?.()
      })
      const done = attempt(x, y).catch(() => 'failed')
      return Promise.race([done, late]).finally(() => clearTimeout(timer))
    },
    /** Forget the provider answer, so the next show asks again. */
    forget() {
      known = undefined
    },
  }
}
