// SPDX-License-Identifier: AGPL-3.0-only
import { isOpen, keyOf } from './lists.js'

/**
 * Place and person matching: pure, given what the caller read from the capabilities.
 * A task with a place or a person fires when that place or person is in the news; this file
 * never knows who told it.
 */

export const PLACE_WINDOW_MS = 15 * 60_000
export const PERSON_WINDOW_MS = 10 * 60_000

const norm = (value) => String(value ?? '').trim().toLowerCase()

/**
 * The place event inside a `context.current` reply: `{ place, at }` for an arrival, or
 * `undefined`. The reply's text carries the observation as JSON; `structuredContent` is taken
 * first when a provider sends it.
 */
export function placeEvent(reply) {
  let data = reply?.structuredContent
  if (!data) {
    const text = (reply?.content ?? []).map((block) => (block?.type === 'text' ? String(block.text) : '')).join('\n')
    const start = text.indexOf('{')
    if (start >= 0) {
      try {
        data = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1))
      } catch {
        data = undefined
      }
    }
  }
  const place = data?.place
  if (!place || typeof place !== 'object' || place.type === 'place.left') return undefined
  const at = Date.parse(String(place.occurredAt ?? ''))
  const name = String(place.place ?? '').trim()
  return name === '' || Number.isNaN(at) ? undefined : { place: name, at }
}

/**
 * Open place items whose place matches an arrival within the last 15 minutes. `event` is
 * what {@link placeEvent} returned, or `undefined` when nothing could say (no provider, no
 * event): then place items simply wait.
 */
export function placeFires(rows, event, now) {
  if (!event || Math.abs(now - event.at) > PLACE_WINDOW_MS) return []
  return rows
    .filter((row) => isOpen(row) && row.place && norm(row.place) !== '' && norm(row.place) === norm(event.place))
    .map((row) => fire(row, `You're at ${String(row.place)}.`))
}

/**
 * Whether a `memory.recall` reply says the person was named at or after `since`. Only a
 * provider that reports `structuredContent.mentions` (each with an `at`, epoch ms or ISO)
 * can say so; plain text carries no times, so it never counts.
 */
export function mentionedSince(reply, since) {
  const mentions = reply?.structuredContent?.mentions
  if (!Array.isArray(mentions)) return false
  return mentions.some((m) => {
    const at = typeof m?.at === 'number' ? m.at : Date.parse(String(m?.at ?? ''))
    return Number.isFinite(at) && at >= since
  })
}

/** Open person items for the people in `named` (lower-case names). */
export function personFires(rows, named) {
  const set = new Set(named.map(norm))
  return rows
    .filter((row) => isOpen(row) && row.person && set.has(norm(row.person)))
    .map((row) => fire(row, `You're talking about ${String(row.person)}.`))
}

const fire = (row, why) => ({ key: keyOf(row), text: String(row.text), why, urgency: 'normal' })
