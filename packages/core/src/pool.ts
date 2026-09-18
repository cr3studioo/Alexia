// SPDX-License-Identifier: AGPL-3.0-only
import { anonymous, keyOf, PROVIDERS, type Provider } from './provider.js'
import { CORE, type SecretStore } from './secrets.js'
import type { Store } from './store.js'

/**
 * The free tiers, pooled — which is what makes *free* mean free rather than free-until-you
 * hit fifty-requests-a-day (D51).
 *
 * Two rules, from Alexia.md, that do not bend:
 *
 * - **Self-hosted only.** The key is the user's, in their keychain, and the request goes
 *   from this machine to the provider. A hosted proxy pooling everyone's free tiers would
 *   see every prompt, and routing to one quietly would be the same betrayal as breaking a
 *   Local-mode pin.
 * - **Nothing is pooled without a key the user added themselves.** There is no shared key,
 *   no key shipped in the binary, and no provider enabled on somebody's behalf.
 *
 * The ledger is why this is here rather than in the router: knowing a tier is spent has to
 * happen *before* the request, or the way you find out is a 429 and a slower answer.
 */

/**
 * **The keyless floor's switch** (D154, `model_plan.md` §1 step 2).
 *
 * Whether providers that answer without a key count as reachable at all. **On by default**,
 * because hiding them would hide the only thing a fresh install has — the switch exists for
 * somebody who would rather nothing left this machine for a provider they never signed up to,
 * which is a real preference and not the one to make everybody state first.
 *
 * Off, they leave `available()`, the Models tab and every plan at once. A provider somebody
 * pasted a key into is **keyed rather than the floor** (D159) and stays either way: the switch
 * is about asking a stranger, not about that provider.
 */
const FLOOR = 'keyless.on'

/** Whether the keyless floor may answer. Absent is on. */
export const keylessOn = (store: Store): boolean => (store.kvGet(CORE, FLOOR) as boolean | undefined) ?? true

export const setKeylessOn = (store: Store, on: boolean): void => {
  store.kvSet(CORE, FLOOR, on)
}

/** A provider the user has connected, and how much of its free tier is left right now. */
export interface Rung {
  provider: Provider
  /**
   * Requests left in the current minute, day and month. `Infinity` where nothing is
   * published, which is most rows for most of these.
   */
  minute: number
  day: number
  month: number
  /**
   * **A key of the person's own is stored for it** (D159). Always true of a provider that needs
   * one, since it is not a rung without it; for one that answers without a key, true only when
   * somebody pasted one in — a paid-up Kilo account is not the keyless floor.
   *
   * Absent on a rung built by hand, which reads the provider's `auth` as it always did.
   */
  keyed?: boolean
  /**
   * **Whether the account can pay for this provider's paid models** (§4 D, §1's *Funded*), as the
   * provider itself last said. Absent is unknown, which is read as yes: most providers say nothing,
   * and a 402 on asking is a refusal the router already handles.
   */
  funded?: boolean
  /**
   * **The day's free requests, and the month's calls, where the row rations by either** (§4 F):
   * what makes a provider *day-limited*, whose second half of the day is kept for the chat. A
   * per-minute limit alone is not a daily one. Absent is not rationed that way.
   */
  dayLimit?: number
  monthLimit?: number
}

/** What a provider's key endpoint said about the account, as core keeps it (§4 D). */
export interface Account {
  /** Never bought credit: free models only, at the free tier's daily limit. */
  freeTier: boolean
  /** How much of the key's own credit limit is left, in dollars; null for a key with no limit. */
  limitRemaining: number | null
  at: number
}

/** Where an account is kept: the store's core namespace, one entry per provider. */
export const accountKey = (provider: string): string => `account.${provider}`

/** Whether an account can pay, from what its provider said. Unknown is yes. */
export const fundedBy = (account: Account | undefined): boolean | undefined =>
  account === undefined ? undefined : !account.freeTier && (account.limitRemaining === null || account.limitRemaining > 0)

/** Whether a provider has anything left to give at this instant. */
export function remaining(store: Store, provider: Provider, at: number = Date.now()): Rung {
  const used = store.requests(provider.id, at)
  /**
   * **And what the provider itself last said** (§4 D): the lower of the two, so a header can only
   * ever take the ledger down — a row stays the ceiling, and a provider that says nothing changes
   * nothing. Groq says the day's requests on every answer; OVHcloud the minute's.
   */
  const told = store.heard(provider.id, at)
  const lower = (counted: number, said: number | undefined): number => Math.max(0, Math.min(counted, said ?? Infinity))
  /** The real day's allowance once the provider has said the account bought credit (§4 D). */
  const account = store.kvGet(CORE, accountKey(provider.id)) as Account | undefined
  const perDay = account !== undefined && !account.freeTier ? (provider.rpdFunded ?? provider.rpd) : provider.rpd
  const funded = fundedBy(account)
  return {
    provider,
    ...(funded !== undefined && { funded }),
    ...(perDay !== undefined && { dayLimit: perDay }),
    ...(provider.callsPerMonth !== undefined && { monthLimit: provider.callsPerMonth }),
    minute: lower(provider.rpm === undefined ? Infinity : provider.rpm - used.minute, told.minute),
    day: lower(perDay === undefined ? Infinity : perDay - used.day, told.day),
    // Counted in calls, because that is the unit the budget is written in. A long request
    // and a one-word one spend exactly the same amount of it.
    month:
      provider.callsPerMonth === undefined ? Infinity : Math.max(0, provider.callsPerMonth - used.month),
  }
}

export const spent = (rung: Rung): boolean => rung.minute <= 0 || rung.day <= 0 || rung.month <= 0

/**
 * Every provider that can be asked: the user has added a key for it. Ordered by what has
 * most of its day left, so the pool spreads rather than exhausting one provider and then
 * discovering the next.
 *
 * **A spent tier is still a row here**, and that is the fix for the bug that said *no
 * provider is connected* to somebody whose key was sitting in the keychain the whole time.
 * This used to drop a spent provider entirely, which the router reads as *not connected* —
 * so one free tier reaching its daily fifty took that provider's paid models with it, and
 * the sentence on screen named the one thing the person had already done.
 *
 * What is spent is the **free tier**, not the key. {@link spent} says which, and the router
 * decides what that costs: the free models, not the provider.
 *
 * ponytail: the ordering is a sort, not a scheduler. If spreading turns out to matter more
 * than latency, the fix is a weight on the row, not a component.
 */
export async function usable(
  store: Store,
  secrets: SecretStore,
  providers: Provider[] = PROVIDERS,
  at: number = Date.now(),
): Promise<Rung[]> {
  // The floor's switch (D154), read once rather than per provider. Off, the keyless rungs are
  // not built at all, so `route()` and the Models tab lose them together and cannot disagree.
  const floor = keylessOn(store)
  const connected = await Promise.all(
    providers.map(async (provider) => {
      // Asked of the keyless providers too: a key pasted into one moves it off the floor.
      const keyed = Boolean(await secrets.get(CORE, keyOf(provider)).catch(() => undefined))
      // Nothing is pooled without a key the user added themselves. No key, not in the pool.
      return keyed || (anonymous(provider) && floor) ? { provider, keyed } : undefined
    }),
  )

  return connected
    .filter((found) => found !== undefined)
    .map(({ provider, keyed }) => ({ ...remaining(store, provider, at), keyed }))
    .sort((a, b) => b.day - a.day || b.minute - a.minute)
}

/**
 * Count a request against a provider's quota. Called when one is *sent*, not when one
 * succeeds: a request that failed still counted against the tier that refused it.
 */
export function sent(store: Store, provider: Provider, at: number = Date.now()): void {
  store.recordRequest(provider.id, at)
}

/**
 * **Whether a background request may still use this provider's free requests** (§4 F): a provider
 * with no daily or monthly ration always, and one with a ration only while more than half of it is
 * left — by the ledger or by what the provider said, whichever is lower, which is what `day` and
 * `month` already are. The second half is the chat's.
 */
export const underHalf = (rung: Rung): boolean =>
  (rung.dayLimit === undefined || rung.day > rung.dayLimit / 2) && (rung.monthLimit === undefined || rung.month > rung.monthLimit / 2)
