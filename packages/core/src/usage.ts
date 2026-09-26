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
  /**
   * **The paid switch** (D160, D161, §4 H): on *free then paid*, whether Automatic moves to a paid
   * model by itself once the free ones are done. On, it does, within {@link daily}; off — the
   * default — the work pauses and *Allow switching to a paid model* is the one place money is
   * asked about. Turning it on asks for the daily amount, so there is still one money setting.
   */
  cross?: boolean
  /**
   * **Every money limit lifted until this moment** (D206), as epoch milliseconds: the next local
   * midnight, set by *No limit today* on a limit pause. Never a permanent change — past it the
   * monthly budget and the daily amount are what they were, and nothing has to remember to put
   * them back.
   */
  liftedUntil?: number
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

/**
 * **The monthly budget, as Settings > Safety sets it.** The one place it is written.
 *
 * It used to be saved with the step limit (`preview.ts`'s ceilings) while {@link allowance}
 * read it from here, so a budget somebody typed in was shown back to them and then never
 * enforced. A budget set on purpose is a stop and not only a warning — that is what the word
 * means to the person typing it — so setting one turns the hard stop on, and clearing it
 * (`undefined`) takes both away.
 */
export function setMonthly(store: Store, monthly: number | undefined): void {
  const next: Caps = { ...caps(store) }
  if (monthly === undefined) {
    delete next.monthly
    delete next.hardStop
  } else {
    next.monthly = Math.round(monthly * 100) / 100
    next.hardStop = true
  }
  setCaps(store, next)
}

export interface Allowance {
  /** Spent this calendar month, in dollars. */
  spent: number
  cap?: number
  /** Worth saying something about. */
  warn: boolean
  /** The hard stop is on and the cap is reached: paid models are off the table. */
  stop: boolean
  /**
   * **Dollars left before the hard stop** (D206), when one is on and not lifted for today. `send()`
   * holds each paid rung's worst case to it as it does the day's (D186), so the budget is a limit
   * and not a line found crossed after the reply.
   */
  room?: number
}

/**
 * **When this Mac's own day began**, as epoch milliseconds.
 *
 * Local rather than UTC, and one pair of functions for everything that counts money. They
 * used to be UTC calendar days, which in Prague meant *today* started at two in the morning:
 * the Price page said *today* over a number that still held last night, and the daily
 * allowance came back at an hour nobody would guess. The router's check and the number on
 * screen both read {@link today}, so the day they mean is the same day by construction.
 *
 * A provider's own free-tier day (`store.ts`, `router.ts`) stays UTC on purpose: that is a
 * clock somebody else keeps, and this one is the person's.
 */
export const dayStart = (at: number): number => {
  const now = new Date(at)
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

/** The first moment of this Mac's calendar month. See {@link dayStart}. */
export const monthStart = (at: number): number => {
  const now = new Date(at)
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime()
}

/**
 * The first moment of this Mac's next day — local midnight, which is not always 24 hours away:
 * the day the clocks change is 23 or 25. See {@link dayStart}.
 */
export const nextDay = (at: number): number => {
  const now = new Date(at)
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()
}

/** Whether *No limit today* is in force (D206). Read against the clock, so midnight ends it by itself. */
export const lifted = (store: Store, at: number = Date.now()): boolean => (caps(store).liftedUntil ?? 0) > at

/** ***No limit today*** (D206): the monthly budget and the daily amount, lifted until local midnight. */
export const liftToday = (store: Store, at: number = Date.now()): void => setCaps(store, { ...caps(store), liftedUntil: nextDay(at) })

/** Settings > Safety's *Undo*: the limits back now rather than at midnight. */
export function unlift(store: Store): void {
  const next: Caps = { ...caps(store) }
  delete next.liftedUntil
  setCaps(store, next)
}

/** Where the month stands: this Mac's calendar month, on the same clock as the day. */
export function allowance(store: Store, at: number = Date.now()): Allowance {
  const spent = store.spend(monthStart(at))
  const { monthly, warnAt, hardStop } = caps(store)
  if (monthly === undefined) return { spent, warn: false, stop: false }
  // Lifted for today, the budget still warns and no longer stops (D206).
  const holds = hardStop === true && !lifted(store, at)
  return {
    spent,
    cap: monthly,
    warn: spent >= (warnAt ?? monthly * 0.8),
    stop: holds && spent >= monthly,
    ...(holds && { room: Math.max(0, monthly - spent) }),
  }
}

/** Today's spending against today's allowance. Both in dollars. */
export interface Today {
  spent: number
  allowance: number
  /** *No limit today* is in force (D206): the allowance is shown as it is and does not stop anything. */
  lifted?: true
}

/**
 * Where the day stands: this Mac's calendar day ({@link dayStart}). It is what the router asks
 * before it may spend and what the Price page shows, so the two cannot mean different days.
 */
export function today(store: Store, at: number = Date.now()): Today {
  return {
    spent: store.spend(dayStart(at)),
    allowance: caps(store).daily ?? DAILY_DEFAULT,
    ...(lifted(store, at) && { lifted: true as const }),
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
  today !== undefined && (today.lifted === true || today.spent < today.allowance)

/** Money, as it is written everywhere it is shown. One place, so two screens cannot disagree. */
export const dollars = (n: number): string => `$${n.toFixed(2)}`

/** **A spending limit, reached** (D206): which one, and the amount it was set to. */
export interface Limit {
  kind: 'monthly' | 'daily'
  amount: number
}

/** The one sentence a limit pause says, beside its three choices. */
export const limitSays = ({ kind, amount }: Limit): string =>
  kind === 'monthly' ?
    `You've reached your ${dollars(amount)} monthly budget, so Alexia stopped before spending more.`
  : `You've reached today's ${dollars(amount)} for paid models, so Alexia stopped before spending more.`

/** What *Raise the limit* offers first: double, and at least a dollar more — a step, not a blank cheque. */
export const raiseTo = (amount: number): number => Math.round(Math.max(amount * 2, amount + 1) * 100) / 100

/** The line to show when the month is getting expensive. Nothing when it is not. */
export function warning(allowance: Allowance): string | undefined {
  if (allowance.cap === undefined || !allowance.warn) return undefined
  const money = dollars
  return allowance.stop ?
      `${money(allowance.spent)} of your ${money(allowance.cap)} monthly cap is spent — paid models are paused until you raise it.`
    : `${money(allowance.spent)} of your ${money(allowance.cap)} monthly cap is spent.`
}
