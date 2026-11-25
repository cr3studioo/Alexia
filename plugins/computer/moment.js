// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One screenshot's state, from a probe taken just before it and one just after (P3-34).
 *
 * The picture takes a moment to grab, and a window can come to the front, or the session can
 * lock, while it does. So the window is only named when both probes name the same one, and the
 * session counts as locked when either probe — or a missing one — says it might have been.
 * Imports nothing: pure.
 */

/** The keys of `front` that have to agree, each compared with `===`. */
const KEYS = ['app', 'title', 'fullscreen', 'titleBar']

const same = (a, b) =>
  a !== null && typeof a === 'object' && b !== null && typeof b === 'object' && KEYS.every((key) => a[key] === b[key])

/** `{ locked, front? }` for one screenshot, from the probe before and the probe after it. */
export function sameMoment(before, after) {
  if (!before || typeof before !== 'object' || !after || typeof after !== 'object') return { locked: true }
  if (before.locked !== false || after.locked !== false) return { locked: true }
  if (!same(before.front, after.front)) return { locked: false }
  const front = {}
  for (const key of KEYS) if (before.front[key] !== undefined) front[key] = before.front[key]
  return { locked: false, front }
}
