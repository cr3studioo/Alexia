// SPDX-License-Identifier: AGPL-3.0-only
import type { Model } from './catalog.js'
import type { Usage } from './provider.js'
import { CORE } from './secrets.js'
import type { Store } from './store.js'

/**
 * What it cost, and the ceiling that stops it costing more.
 *
 * Attribution is per session, per model **and per plugin** — the third one matters because
 * "which plugin is quietly costing me money" has no other way to be answered, and a plugin
 * that turns out to be expensive is a thing the user should be able to see and then delete.
 */

/** Prices are per million tokens, so this is the whole of the arithmetic. */
export const costOf = (model: Model, usage: Usage): number =>
  (usage.in / 1_000_000) * model.priceIn + (usage.out / 1_000_000) * model.priceOut

export interface Caps {
  /** Dollars a month. Nothing set means no ceiling, which is the default. */
  monthly?: number
  /** Say something at this much spent. Defaults to four fifths of the cap. */
  warnAt?: number
  /**
   * Stop at the cap rather than only saying so. Off by default: a refusal nobody asked for
   * is also a bad surprise, so this one is turned on deliberately.
   */
  hardStop?: boolean
}

// One kv entry rather than three settings rows: a handful of numbers that are always read
// together is exactly what kv is for (storage.md).
export const caps = (store: Store): Caps => (store.kvGet(CORE, 'caps') as Caps | undefined) ?? {}
export const setCaps = (store: Store, caps: Caps): void => store.kvSet(CORE, 'caps', caps)

export interface Allowance {
  /** Spent this calendar month, in dollars. */
  spent: number
  cap?: number
  /** Worth saying something about. */
  warn: boolean
  /** The hard stop is on and the cap is reached: paid models are off the table. */
  stop: boolean
}

/**
 * Where the month stands. The month is a UTC calendar month, which is off by hours for
 * somebody in Auckland on the first — and being off by hours on a monthly ceiling is not
 * something anybody will ever notice.
 */
export function allowance(store: Store, at: number = Date.now()): Allowance {
  const now = new Date(at)
  const spent = store.spend(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const { monthly, warnAt, hardStop } = caps(store)
  if (monthly === undefined) return { spent, warn: false, stop: false }
  return {
    spent,
    cap: monthly,
    warn: spent >= (warnAt ?? monthly * 0.8),
    stop: hardStop === true && spent >= monthly,
  }
}

/** The line to show when the month is getting expensive. Nothing when it is not. */
export function warning(allowance: Allowance): string | undefined {
  if (allowance.cap === undefined || !allowance.warn) return undefined
  const money = (n: number): string => `$${n.toFixed(2)}`
  return allowance.stop ?
      `${money(allowance.spent)} of your ${money(allowance.cap)} monthly cap is spent — paid models are paused until you raise it.`
    : `${money(allowance.spent)} of your ${money(allowance.cap)} monthly cap is spent.`
}
