// SPDX-License-Identifier: AGPL-3.0-only
import { keyOf, PROVIDERS, type Provider } from './provider.js'
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

/** A provider the user has connected, and how much of its free tier is left right now. */
export interface Rung {
  provider: Provider
  /** Requests left in the current minute and day. `Infinity` where nothing is published. */
  minute: number
  day: number
}

/** Whether a provider has anything left to give at this instant. */
export function remaining(store: Store, provider: Provider, at: number = Date.now()): Rung {
  const used = store.requests(provider.id, at)
  return {
    provider,
    minute: provider.rpm === undefined ? Infinity : Math.max(0, provider.rpm - used.minute),
    day: provider.rpd === undefined ? Infinity : Math.max(0, provider.rpd - used.day),
  }
}

export const spent = (rung: Rung): boolean => rung.minute <= 0 || rung.day <= 0

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
  const connected = await Promise.all(
    providers.map(async (provider) => {
      if (provider.keyless) return provider
      // Nothing is pooled without a key the user added themselves. No key, not in the pool.
      const key = await secrets.get(CORE, keyOf(provider)).catch(() => undefined)
      return key ? provider : undefined
    }),
  )

  return connected
    .filter((provider) => provider !== undefined)
    .map((provider) => remaining(store, provider, at))
    .sort((a, b) => b.day - a.day || b.minute - a.minute)
}

/**
 * Count a request against a provider's quota. Called when one is *sent*, not when one
 * succeeds: a request that failed still counted against the tier that refused it.
 */
export function sent(store: Store, provider: Provider, at: number = Date.now()): void {
  store.recordRequest(provider.id, at)
}
