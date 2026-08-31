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
  /**
   * **Dollars a day the router may spend on its own.** The permission that turns automatic
   * spending on, and it starts at nothing.
   *
   * Not a second monthly cap. `monthly` is a ceiling on a total somebody is already choosing
   * to run up; this is the difference between a router that may reach for a paid model
   * without being asked and one that may not. With it at zero the app behaves exactly as
   * *free only* does, and the first thing anyone does with it is set it to the price of a
   * coffee — which is how people think about this, rather than in dollars per million
   * tokens.
   *
   * **Daily rather than monthly**, for two reasons that are both about blast radius: the
   * free tiers this bridges reset daily, so the thing it stands in for has the same period —
   * and an agent loop can burn a month's budget in an hour, where a day's is a day's.
   */
  daily?: number
}

/**
 * What the allowance is until somebody sets one: **nothing**.
 *
 * The whole of the fix. `mixed` has always been the default and `mixed` filtered nothing, so
 * the moment free was filtered out — no tools, an `above` pin, a spent tier — a paid model
 * was chosen and billed with no cap, no confirmation and no budget, and the free-tier
 * exhaustion path led straight into it. Zero here means that path now ends where the free
 * tiers do, and money starts being spent on the day the user says so and not before.
 */
export const DAILY_DEFAULT = 0

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

/** Today's spending against today's allowance. Both in dollars. */
export interface Today {
  spent: number
  allowance: number
}

/**
 * Where the day stands. A UTC calendar day, for the same reason the month is one: being off
 * by hours on a spending boundary is not something anybody will notice, and two different
 * definitions of *today* in one file would be.
 */
export function today(store: Store, at: number = Date.now()): Today {
  const now = new Date(at)
  return {
    spent: store.spend(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
    allowance: caps(store).daily ?? DAILY_DEFAULT,
  }
}

/**
 * Is there room left in today's allowance?
 *
 * **Absent is no.** A caller that did not gather the day's figures does not thereby get to
 * spend money — money is the one axis where forgetting has to fail closed, because every
 * other rung failure is free and this is the only step that cannot be taken back.
 */
export const affordable = (today: Today | undefined): boolean =>
  today !== undefined && today.spent < today.allowance

/** Money, as it is written everywhere it is shown. One place, so two screens cannot disagree. */
export const dollars = (n: number): string => `$${n.toFixed(2)}`

/** The line to show when the month is getting expensive. Nothing when it is not. */
export function warning(allowance: Allowance): string | undefined {
  if (allowance.cap === undefined || !allowance.warn) return undefined
  const money = dollars
  return allowance.stop ?
      `${money(allowance.spent)} of your ${money(allowance.cap)} monthly cap is spent — paid models are paused until you raise it.`
    : `${money(allowance.spent)} of your ${money(allowance.cap)} monthly cap is spent.`
}
