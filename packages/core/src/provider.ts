// SPDX-License-Identifier: AGPL-3.0-only
import { CORE, keychain, type SecretStore } from './secrets.js'
import type { Message } from './store.js'

/**
 * One OpenAI-compatible client, and providers as rows rather than files.
 *
 * This is Alexia.md's own mitigation for the exception that lets a model provider live in
 * core at all: **adding a provider must never mean adding code.** Base URL, the keychain
 * entry holding the key, where the model list lives — everything that differs between
 * OpenAI-compatible endpoints, which by now is all of the ones worth having. Skip it and
 * core accretes a vendor integration a month.
 */

export interface Provider {
  id: string
  name: string
  /**
   * Everything before `/chat/completions`.
   *
   * May carry a **`{account}`** placeholder, for the endpoints that put an account id in the
   * path rather than in a header. Where it does, the stored key is a composite —
   * `account_id:api_token` — and {@link reaching} splits it into the two halves the request
   * needs. That is a template rather than a branch on purpose: the alternative is one
   * provider's name written into the URL-building code, and this table's whole premise is
   * that adding a provider never means adding code.
   */
  baseUrl: string
  /** Where its model list lives, relative to `baseUrl`. Not every provider has one. */
  models?: string
  /**
   * Where this provider publishes **how much the world is using each of its models** — an
   * absolute URL, because it need not sit under `baseUrl` and on the one provider that has
   * it, it does not.
   *
   * A row rather than a branch, so the day a second provider publishes one it is a line in
   * this table and not a change to the catalog. Today exactly one does, which is the fact the
   * Models screen states out loud rather than hiding behind an empty column.
   *
   * **Undocumented, and treated as such.** This is the endpoint openrouter.ai's own models
   * page calls; it is not in their published API, which carries no usage figures at all and
   * accepts `?order=top-weekly` while ignoring it. So it may change shape or vanish without
   * notice, and everything downstream of it is optional: the catalog refresh that reads this
   * succeeds when it fails, and the column simply has nothing in it.
   */
  usage?: string
  /** Sent with every request. A provider that wants attribution headers says so here. */
  headers?: Record<string, string>
  /**
   * Not every provider is key-or-no-key. OVHcloud answers anonymously at 2 rpm and
   * at 400 rpm with a key — and a *wrong* key 403s instead of degrading, so a blank
   * field must send no header at all rather than an empty one.
   *
   * Replaces the binary `keyless?: boolean`, which cannot say "better with a key".
   */
  auth?: 'none' | 'optional' | 'required'
  /** AI Horde's documented anonymous key is a literal (`0000000000`), not an absence. */
  anonymousKey?: string
  /**
   * A volunteer queue answers in minutes; the default timeout calls that dead.
   * AI Horde 120s · Ollama Cloud 120s · Cloudflare 60s (200s for glm-4.7-flash)
   * · Agnes 60s · Z.ai longer.
   */
  timeoutMs?: number
  /**
   * Raw text-completion backends 500 on a `tools` field. Provider-wide fallback for
   * models with no per-model answer. AI Horde is the case that forces this.
   */
  tools?: false
  /**
   * What its terms say about training on what you send it (D51). `unknown` until somebody
   * has actually read them and written the date down — never inferred from the price,
   * however strongly a free tier hints.
   */
  trainsOnYourData?: 'yes' | 'no' | 'unknown'
  /** Where the limits and the data policy are written down, for the person checking. */
  terms?: string
  /**
   * The date somebody last confirmed this row against the provider's own docs.
   * These endpoints die monthly; a copied table goes stale silently.
   */
  verified?: string
  /** The published free-tier limits: requests per minute, and per day. */
  rpm?: number
  rpd?: number
  /**
   * **What it costs you to get in, in the currency that is not money** (§6.6, §12.2).
   *
   * Not every free tier is free of trouble: one of these wants a Telegram channel joined and
   * verified before it will mint a key, and that is a real question about trust as well as a
   * minute of somebody's evening. Discovering it three clicks into a signup is the version of
   * this that wastes both, so it belongs on the tile face where the key is asked for.
   *
   * Only what cannot be read off the rest of the row. Cloudflare's account id is not here,
   * because `{account}` in its `baseUrl` already says it — a second copy of a fact is a
   * second thing that can drift.
   */
  friction?: string

  /**
   * A free tier rationed in **calls a month** rather than in tokens or in requests a day.
   *
   * `rpm` and `rpd` cannot say this. A thousand calls a month is not forty a day — it is a
   * thousand calls whenever they happen, and approximating it with `rpd` either strands most
   * of the budget or overruns it in the first week. Two providers in this table would be
   * described wrongly by anything else, so it is a third number rather than a fudge.
   */
  callsPerMonth?: number
}

/**
 * The table. Limits are the published free-tier numbers from the plan's *Verified facts*,
 * measured 2026-08-27 — which is what each row's `verified` now says, so the date travels
 * with the row rather than living in a paragraph above it.
 *
 * **Every row here is `auth: 'required'`.** These are the hosted tiers that predate the
 * keyless floor, and every one of them wants a key before it will answer — which is exactly
 * what the `keyless?: boolean` this replaced was saying by omission.
 *
 * **Every `trainsOnYourData` says `unknown` on purpose.** The terms URL is recorded so the
 * answer is one read away, and the flag stays honest until somebody has actually done that
 * read — which the plan makes a condition of any public release, not of this table
 * existing. Guessing here would break the one promise the whole project rests on.
 */
export const PROVIDERS: Provider[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: '/models',
    // OpenRouter attributes traffic to whatever sends these. Being identifiable costs
    // nothing and is the polite half of using somebody's free tier.
    headers: { 'HTTP-Referer': 'https://github.com/cr3studioo/Alexia', 'X-Title': 'Alexia' },
    auth: 'required',
    terms: 'https://openrouter.ai/terms',
    // Keyed by `canonical_slug`, which is what the public list calls the same model — 377 of
    // the 396 rows join, and the ones that do not are models nobody has used yet.
    usage: 'https://openrouter.ai/api/frontend/v1/models/find?order=top-weekly',
    verified: '2026-08-27',
    trainsOnYourData: 'unknown',
    rpm: 20,
    rpd: 50, //                                 1,000 after a one-off $10 of credit
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: '/models',
    auth: 'required',
    terms: 'https://groq.com/terms-of-use/',
    verified: '2026-08-27',
    trainsOnYourData: 'unknown',
    rpm: 30,
    rpd: 14_400,
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    models: '/models',
    auth: 'required',
    terms: 'https://www.cerebras.ai/terms-of-service',
    verified: '2026-08-27',
    trainsOnYourData: 'unknown',
    rpm: 30,
    rpd: 14_400,
  },
  {
    id: 'google',
    name: 'Google AI Studio',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: '/models',
    auth: 'required',
    terms: 'https://ai.google.dev/gemini-api/terms',
    verified: '2026-08-27',
    trainsOnYourData: 'unknown',
    rpm: 15,
    rpd: 1_500,
  },
  {
    id: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    models: '/models',
    auth: 'required',
    terms: 'https://mistral.ai/terms',
    verified: '2026-08-27',
    trainsOnYourData: 'unknown',
    rpm: 60, //                                 published as one request per second
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    models: '/models',
    auth: 'required',
    terms: 'https://build.nvidia.com/terms',
    verified: '2026-08-27',
    trainsOnYourData: 'unknown',
    rpm: 40,
  },
  {
    id: 'github',
    name: 'GitHub Models',
    baseUrl: 'https://models.inference.ai.azure.com',
    // No model list endpoint recorded. Left off rather than guessed: the catalog asks the
    // provider row where to look, and a wrong path is a daily failed fetch.
    auth: 'required',
    terms: 'https://docs.github.com/site-policy/github-terms/github-terms-of-service',
    verified: '2026-08-27',
    trainsOnYourData: 'unknown',
    rpm: 10,
    rpd: 50,
  },
  /**
   * ---- The keyless floor. No key, no signup, no card. ----
   *
   * These four are what makes *free* mean free on the first evening, before anybody has
   * pasted anything. Every one of them was reached from this machine with no credential in
   * the keychain on the date each row records.
   */
  {
    id: 'ovhcloud',
    name: 'OVHcloud AI Endpoints',
    // Source: models_plan.md §6.2, §6.6 "OVHcloud". The anonymous host is unguessable and is
    // not the one their docs lead with.
    baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    /**
     * **No `models` path on purpose**, though the endpoint exists and answers.
     *
     * Its published list is right about neither of the two things the catalog would read it
     * for. It mixes speech, image and embedding models in with the chat ones — and it prices
     * every model at OVHcloud's list rate, which is what a *keyed* account pays. Read
     * literally, the free floor of this whole product would arrive tiered as paid and
     * carrying a text router pointed at Stable Diffusion. The five chat models are known, so
     * they are written down in `catalog.ts` instead, priced as the anonymous tier actually
     * is: zero.
     */
    /**
     * **Better with a key, and worse with a wrong one.** Anonymous is 2 req/min; a key is
     * 400. But a *bad* key 403s rather than falling back, so the header is omitted entirely
     * when there is nothing to put in it — never sent empty.
     */
    auth: 'optional',
    // 2 req/min is per IP **per model**, so spreading across the five is ~10/min in
    // practice. The ledger counts per provider, which cannot say that — so this is the
    // conservative reading of it, and the cost of being conservative is a slower floor
    // rather than a 429.
    rpm: 2,
    trainsOnYourData: 'unknown',
    verified: '2026-08-30',
  },
  {
    id: 'aihorde',
    name: 'AI Horde',
    // Source: models_plan.md §6.2, §6.6 "AI Horde", §17.3.
    baseUrl: 'https://oai.aihorde.net/v1',
    models: '/models',
    // A volunteer queue: anonymous is lowest priority, and a real account key buys queue
    // priority with kudos rather than access.
    auth: 'optional',
    /**
     * **An absence is not enough here.** The anonymous credential is a literal that AI Horde
     * publishes for everyone to use, so it is sent rather than omitted — the opposite of the
     * row above, which is why this is a value on the row and not a rule in the code.
     */
    anonymousKey: '0000000000',
    // Latency is minutes, not seconds. The default patience calls a working queue dead.
    timeoutMs: 120_000,
    /**
     * **No tool calling, provider-wide.** Its workers run raw text-completion backends that
     * 500 on a `tools` field, and its roster is discovered live — so a per-model flag cannot
     * cover a worker that appeared five seconds ago.
     */
    tools: false,
    trainsOnYourData: 'unknown',
    verified: '2026-08-30',
  },
  {
    id: 'uncloseai',
    name: 'UncloseAI',
    // Source: models_plan.md §6.2, §6.6 "UncloseAI".
    baseUrl: 'https://hermes.ai.unturf.com/v1',
    models: '/models',
    auth: 'optional',
    /**
     * Any non-empty string is accepted; it is used for identification and nothing else. So
     * the value is a name rather than a secret, and being identifiable costs nothing and is
     * the polite half of using somebody's free tier — the same argument as OpenRouter's
     * attribution headers above.
     */
    anonymousKey: 'alexia',
    trainsOnYourData: 'unknown',
    verified: '2026-08-30',
  },
  {
    id: 'kilo-gateway',
    name: 'Kilo Gateway',
    // Source: models_plan.md §6.2, §6.3, §6.6 "Kilo Gateway", §17.3.
    baseUrl: 'https://api.kilo.ai/api/gateway/v1',
    /**
     * **Not under the version prefix.** The list lives at `/api/gateway/models`, one level up
     * from where every other provider keeps it — expressed as a relative step rather than a
     * second URL field, because a URL normalises this on its way out.
     */
    models: '/../models',
    // In Tier A because it answers with no header at all, and in §6.3 because a key raises
    // the ceiling. One row says both.
    auth: 'optional',
    // Published as 200 req/hr per IP, which is a window this schema does not have. Three a
    // minute is the conservative reading that never overruns the hour it is really counted
    // in; the cost of being wrong this way is a slower rung, not a refusal.
    rpm: 3,
    /**
     * **The one row in this table where this is known, and the answer is yes.** Free prompts
     * and outputs are logged for training. It is on the row so the key wall can say so on the
     * tile face, rather than somebody finding out from a changelog.
     */
    trainsOnYourData: 'yes',
    verified: '2026-08-30',
  },
  /**
   * ---- Free tiers with a published budget. A key, always free, never a card. ----
   *
   * Kilo Gateway belongs here too and is already above: the only difference this tier makes
   * to it is that a key raises the ceiling, which `auth: 'optional'` already says.
   */
  {
    id: 'llm7',
    name: 'LLM7',
    // Source: models_plan.md §6.3, §6.6 "LLM7", §17.3. The key question §6.6 records as
    // unresolved was settled by probing this endpoint three ways from this machine on the
    // date below — see models_plan_final.md MP-11 for the table.
    baseUrl: 'https://api.llm7.io/v1',
    models: '/models',
    /**
     * **Keyless, and a placeholder is worse than nothing.** Four of its six free models
     * answered with no header at all. On one that does want a key, the literal `unused` that
     * one source recommends comes back `invalid_api_key` where sending nothing comes back
     * `missing_api_key` — it is rejected as a bad key rather than accepted as a pass. So
     * there is deliberately no `anonymousKey` here.
     */
    auth: 'optional',
    // Published as 20 rpm inside 100 requests an hour. The minute is the one this schema can
    // hold; the hour is left to a 429, which the cascade already reads as *next rung*.
    rpm: 20,
    trainsOnYourData: 'unknown',
    verified: '2026-08-30',
  },
  {
    id: 'nara',
    name: 'NaraRouter',
    // §6.6: "no card, but Telegram channel/link verification. That is real onboarding
    // friction and a trust question — flag it on the key tile."
    friction: 'Free key needs Telegram verification, not a card',
    // Source: models_plan.md §6.3, §6.6 "NaraRouter".
    baseUrl: 'https://router.bynara.id/v1',
    /**
     * **No list on purpose.** Probed on a zero-balance account, only three ids answered; the
     * rest of `/v1/models` was credit- or plan-gated and would arrive looking free. The three
     * that work are written down in `catalog.ts` instead.
     */
    auth: 'required',
    // The free tier is a **shared** 5M tokens a day across everybody, not a per-user
    // allowance — so what is left is not something this machine can know.
    trainsOnYourData: 'unknown',
    verified: '2026-08-30',
  },
  {
    id: 'cloudflare-ai',
    name: 'Cloudflare Workers AI',
    /**
     * Source: models_plan.md §6.3, §6.6 "Cloudflare Workers AI", §17.3.
     *
     * **The account id is in the path**, which is what `{account}` and the composite
     * `account_id:api_token` key exist for — the one provider here that would otherwise need
     * code of its own.
     */
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1',
    auth: 'required',
    /**
     * 60s. One model wants 200s — a live sweep aborted it repeatedly at 15 — and a timeout
     * is a property of the row rather than of the model, so the row cannot say that. The
     * cost of being wrong is one 504 and the next rung, which is the behaviour a per-model
     * exception would be buying its way out of.
     */
    timeoutMs: 60_000,
    // 10,000 Neurons a day, which is about 150 answers.
    rpd: 150,
    trainsOnYourData: 'unknown',
    verified: '2026-08-30',
  },
  {
    id: 'ollama-cloud',
    name: 'Ollama Cloud',
    // Source: models_plan.md §6.3, §6.6 "Ollama Cloud", §4.3.
    baseUrl: 'https://ollama.com/v1',
    /**
     * **Ollama's own path, not the OpenAI one.** One level up and a different envelope —
     * `{ models: [...] }` rather than `{ data: [...] }` — which the catalog reads as a second
     * shape rather than as a second provider.
     */
    models: '/../api/tags',
    /**
     * **Not keyless.** An extraction error briefly said it was, and that correction is on the
     * record: the cost of getting this one wrong is a rung the ladder counts on that is not
     * there.
     */
    auth: 'required',
    timeoutMs: 120_000,
    trainsOnYourData: 'unknown',
    verified: '2026-08-30',
  },
  {
    id: 'zai',
    // **The console is part of the name**, and that is the whole fix for the gotcha.
    // Two consoles mint keys into separate namespaces, and a key from the other one is a 401
    // here — indistinguishable from a bad key unless the sentence says which door it came
    // from. `Z.ai said 401` does not; this does. (The other host is
    // `https://open.bigmodel.cn/api/paas/v4`.)
    name: 'Z.ai (global console)',
    /**
     * Source: models_plan.md §6.3, §6.6 "Z.ai / Zhipu".
     *
     * **The OpenAI-compatible `paas/v4` path.** OmniRoute's entry for this provider uses the
     * *Anthropic* wire format at `api.z.ai/api/anthropic/v1/messages` with an `x-api-key`
     * header. Copying that would have meant a second wire format in a file whose entire
     * premise is that there is one.
     */
    baseUrl: 'https://api.z.ai/api/paas/v4',
    models: '/models',
    auth: 'required',
    /**
     * **No `timeoutMs` on purpose**, which is what *needs a longer timeout* means here. These
     * are reasoning models and no number was ever published for them; a row that declares
     * nothing gets the platform's own patience, which is longer than any figure that would
     * have been invented to put here.
     */
    trainsOnYourData: 'unknown',
    verified: '2026-08-30',
  },
  {
    id: 'cohere',
    name: 'Cohere',
    /**
     * Source: models_plan.md §6.3, §6.6 "Cohere", §17.3.
     *
     * **`/compatibility/v1`, never the native `/v2/chat`.** The native endpoint answers in a
     * proprietary shape — content as an array of typed parts — that no OpenAI-compatible
     * client can read, so the wrong path here is not a slower answer, it is an empty one.
     */
    baseUrl: 'https://api.cohere.com/compatibility/v1',
    models: '/models',
    auth: 'required',
    /**
     * **A thousand calls a month, not a token budget.** This is the row the field exists for:
     * `rpd` would either strand most of it or overrun it in the first week, because a call is
     * a call whether it carries four words or forty thousand.
     */
    callsPerMonth: 1_000,
    trainsOnYourData: 'unknown',
    verified: '2026-08-30',
  },
  /**
   * ---- The clean-terms cluster. ----
   *
   * Nearly everything in this space audits as *caution*; these five audit as **ok**, which is
   * the only reason they are here — the tiers are small and the terms are not. Breadth chosen
   * deliberately, and every extra row is more surface to keep verified.
   */
  {
    id: 'aion',
    name: 'Aion Labs',
    // Source: models_plan.md §6.4, §17.2. Uncapped free tier, clean terms.
    baseUrl: 'https://api.aionlabs.ai/v1',
    models: '/models',
    auth: 'required',
    trainsOnYourData: 'unknown',
    verified: '2026-08-30',
  },
  {
    id: 'agnes',
    name: 'Agnes AI',
    // Source: models_plan.md §6.4 — $0/token promotional, live-probed 2026-06-15 with cost
    // headers returning zero. About 30 concurrent before it starts saying 429.
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    models: '/models',
    auth: 'required',
    // Its flash model reasons before it answers — 20s to the first token on a one-word
    // completion — so the default patience calls a working provider dead.
    timeoutMs: 60_000,
    trainsOnYourData: 'unknown',
    verified: '2026-08-30',
  },
  {
    id: 'requesty',
    name: 'Requesty',
    // Source: models_plan.md §6.4 — free-forever GPT-OSS 120B and Nemotron.
    baseUrl: 'https://router.requesty.ai/v1',
    models: '/models',
    auth: 'required',
    trainsOnYourData: 'unknown',
    verified: '2026-08-30',
  },
  {
    id: 'sealion',
    name: 'SEA-LION',
    // Source: models_plan.md §6.4, §17.2. Uncapped, clean terms.
    baseUrl: 'https://api.sea-lion.ai/v1',
    models: '/models',
    auth: 'required',
    trainsOnYourData: 'unknown',
    verified: '2026-08-30',
  },
  {
    id: 'navy',
    name: 'Navy',
    // Source: models_plan.md §6.4 — about 4M tokens a month.
    baseUrl: 'https://api.navy/v1',
    models: '/models',
    auth: 'required',
    /**
     * **It wants to know who is calling.** The same argument as OpenRouter's attribution
     * headers at the top of this table: being identifiable costs nothing and is the polite
     * half of using somebody's free tier — except that here it is a condition rather than a
     * courtesy.
     */
    headers: { 'User-Agent': 'Alexia (+https://github.com/cr3studioo/Alexia)' },
    trainsOnYourData: 'unknown',
    verified: '2026-08-30',
  },
]

/**
 * The keychain entry a provider's key lives in. Core's own scope, which no plugin id can be.
 *
 * **An underscore, not a slash.** `account()` in `secrets.ts` refuses anything outside
 * `[A-Za-z0-9._@-]`, and this was building `provider/openrouter` — so `_core.provider/openrouter`
 * threw on every read and every write, and the key somebody pasted into Settings went nowhere
 * while the screen went on saying *no key yet*. The separator fix in `secrets.ts` did not reach
 * here because the test that guards it hard-coded a key instead of asking this function for one.
 */
export const keyOf = (provider: Provider): string => `provider_${provider.id}`

/**
 * Will this provider answer without a key? Both halves of `auth` that are not `required` —
 * a local runner that never wanted one, and a hosted tier that answers anonymously at a
 * worse rate limit.
 *
 * The reason this is a function and not `!provider.key` is that `optional` has to be in the
 * pool *and* use a key when one exists, which a boolean could not say.
 */
export const anonymous = (provider: Provider): boolean =>
  provider.auth === 'none' || provider.auth === 'optional'

/**
 * Where a request actually goes, and what credential goes with it.
 *
 * For nearly every row this is the base URL unchanged and the key unchanged. For a row whose
 * `baseUrl` carries an `{account}` placeholder it is the interesting case: the stored key is
 * `account_id:api_token`, the id fills the placeholder and the token is what gets sent.
 *
 * **Split once, on the first colon**, because a token may contain one and an account id may
 * not. A key that does not split is a mistake worth naming rather than a 404 twenty minutes
 * later — somebody pasted the token on its own, and no error from the far end will ever say
 * so, because the request never arrives anywhere real.
 */
export function reaching(provider: Provider, key: string | undefined): { baseUrl: string; key?: string } {
  if (!provider.baseUrl.includes('{account}')) return { baseUrl: provider.baseUrl, ...(key !== undefined && { key }) }
  const at = key?.indexOf(':') ?? -1
  if (key === undefined || at <= 0 || at === key.length - 1) {
    throw new ProviderError(
      401,
      `${provider.name} puts an account id in its address, so its key is two things joined by a colon — account_id:api_token.`,
    )
  }
  return { baseUrl: provider.baseUrl.replace('{account}', key.slice(0, at)), key: key.slice(at + 1) }
}

/**
 * What one row looked like when it was last pinged, and how old its written date is.
 *
 * Four states, because they want four different things done about them. *Answered* is
 * nothing. *Needs a key* is the row working exactly as designed. *Failed* is somebody's
 * homework. *No list* is a row that was never going to answer this question.
 */
export interface Checked {
  provider: Provider
  state: 'answered' | 'needs a key' | 'failed' | 'no list'
  /** The status or the error, for the row that wants chasing. */
  detail?: string
  /** Whole days since somebody last confirmed this row against the provider's own docs. */
  age?: number
}

const DAY = 24 * 60 * 60 * 1000

/**
 * Ping every row's model list and say what happened.
 *
 * **Free tiers die monthly.** A copied table goes stale in silence, and the failure it
 * produces looks like a bug in Alexia rather than like a provider that moved — which is the
 * expensive kind of wrong, because it is chased in the wrong file.
 *
 * **A command, never a build step.** It needs the network, so wiring it into CI would make
 * somebody's pull request fail because a third party was rebooting. And it reports rather
 * than acts: nothing here disables a row, and nothing here quietly writes today's date over
 * a `verified` that a human has not looked at.
 */
export async function verify(
  providers: readonly Provider[] = PROVIDERS,
  at: number = Date.now(),
): Promise<Checked[]> {
  return Promise.all(
    providers.map(async (provider): Promise<Checked> => {
      const age =
        provider.verified === undefined ? undefined : Math.floor((at - Date.parse(provider.verified)) / DAY)
      const said = (state: Checked['state'], detail?: string): Checked => ({
        provider,
        state,
        ...(detail !== undefined && { detail }),
        ...(age !== undefined && Number.isFinite(age) && { age }),
      })
      if (provider.models === undefined) return said('no list')
      // A row whose address contains an account id cannot be reached without one. That is the
      // row working, not the row broken, so it is reported as the same state a 401 is.
      if (provider.baseUrl.includes('{account}')) return said('needs a key', 'its address contains an account id')
      try {
        const response = await fetch(`${provider.baseUrl}${provider.models}`, {
          headers: { accept: 'application/json', ...provider.headers },
          signal: AbortSignal.timeout(provider.timeoutMs ?? 20_000),
        })
        if (response.ok) return said('answered')
        // A 401 proves the endpoint is where the row says it is, which is the whole question.
        if (response.status === 401 || response.status === 403) return said('needs a key', String(response.status))
        return said('failed', String(response.status))
      } catch (error) {
        return said('failed', error instanceof Error ? error.message : String(error))
      }
    }),
  )
}

/** The report, as the person running it reads it. Oldest and most broken first. */
export function report(checked: readonly Checked[]): string {
  const rank = { failed: 0, 'no list': 1, 'needs a key': 2, answered: 3 }
  const days = (age: number | undefined): string =>
    age === undefined ? 'never checked'
    : age === 0 ? 'checked today'
    : `checked ${String(age)} day${age === 1 ? '' : 's'} ago`
  const lines = [...checked]
    .sort((a, b) => rank[a.state] - rank[b.state] || (b.age ?? Infinity) - (a.age ?? Infinity))
    .map((one) => `${one.provider.name} — ${one.state}${one.detail ? ` (${one.detail})` : ''} · ${days(one.age)}`)
  const broken = checked.filter((one) => one.state === 'failed').length
  return [
    `${String(checked.length)} providers checked, ${String(broken)} not answering.`,
    ...lines,
    // Said rather than done: a date written by a successful ping is a date nobody read.
    'Dates are not updated by this — change `verified` by hand once you have read the docs again.',
  ].join('\n')
}

/** A tool as the model is told about it. The agent loop (M15-2) builds these from `tools/list`. */
export interface ToolSpec {
  name: string
  description?: string
  /** JSON Schema. MCP hands one over already, so nothing here rewrites it. */
  parameters?: Record<string, unknown>
}

export interface ChatRequest {
  model: string
  messages: Message[]
  tools?: ToolSpec[]
  /**
   * The ceiling on the reply, and **mandatory whenever money is involved** — {@link send}
   * refuses to bill without one.
   *
   * This is the whole answer to *how does it know what this will cost?* It cannot. Input
   * tokens are countable before sending; output tokens are not, and there is no version of
   * this where they become countable. So the bound is declared rather than predicted, and
   * that is what turns an unknown cost into a bounded one.
   *
   * Still optional in the type, because it stays optional in fact: a free call does not need
   * one, and requiring it there would be a ceiling on an answer nobody is paying for.
   */
  maxTokens?: number
  /** The stop control (M15-5). Aborting mid-stream is the point of it. */
  signal?: AbortSignal
}

/** Tokens in and out. What M1-9 turns into money, and the only usage core keeps. */
export interface Usage {
  in: number
  out: number
}

/**
 * A provider said no. The status is on it because the router acts on the number: a 429 is
 * the next rung down, and a 401 is a key the user has to fix.
 */
export class ProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

interface Chunk {
  model?: string
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  choices?: {
    delta?: {
      content?: string
      tool_calls?: {
        index: number
        id?: string
        function?: { name?: string; arguments?: string }
      }[]
    }
  }[]
}

/**
 * Ask a model. Always streamed, even when nobody is watching the pieces: one code path is
 * less code than two, and the only caller that does not stream is a test.
 *
 * `onDelta` gets the text as it arrives. What comes back is a `Message` — the same shape
 * the history stores and re-sends, so an answer needs no translation to become the next
 * request's context.
 */
export async function chat(
  provider: Provider,
  request: ChatRequest,
  onDelta?: (text: string) => void,
  secrets: SecretStore = keychain,
): Promise<{ message: Message; usage: Usage }> {
  // What credential goes on the wire, in three cases — and the difference between the last
  // two is the entire reason `auth` replaced a boolean.
  //
  //   `required`  no key means no request, and a 401 that says so.
  //   `optional`  the user's key if they have one; **otherwise no header at all**. Not an
  //               empty one: a provider that answers anonymously reads a blank credential as
  //               a wrong one and 403s, which is worse than never having claimed to have one.
  //   `none`      never asks, never reads the keychain.
  const stored = provider.auth === 'none' ? undefined : await secrets.get(CORE, keyOf(provider))
  if (!anonymous(provider) && !stored) {
    throw new ProviderError(401, `${provider.name} has no key yet — add one in settings.`)
  }
  // A documented anonymous credential is a literal the provider hands out, not an absence,
  // so it stands in only where the user has supplied nothing of their own. It lives in the
  // row because it is a fact about that provider, not a branch in this function.
  const key = stored ?? provider.anonymousKey

  // This provider's own patience, if the row declared any. A row that declares none gets
  // exactly what it got before — whatever the platform waits — because there is no single
  // number to put here: a volunteer queue answers in minutes, and a fast tier that has gone
  // quiet for thirty seconds is already gone. One default would be wrong for one of them.
  const patience = provider.timeoutMs === undefined ? undefined : AbortSignal.timeout(provider.timeoutMs)
  const signal =
    patience === undefined ? request.signal
    : request.signal === undefined ? patience
    : AbortSignal.any([request.signal, patience])

  /**
   * An abort of *ours* rather than the user's becomes a 504 — the status the cascade reads
   * as *try the next rung*. Keeping the two apart is the whole point: the stop button must
   * stop, not walk down the ladder looking for somebody else to answer a question nobody is
   * waiting for any more.
   */
  const gaveUp = (error: unknown): never => {
    if (patience?.aborted === true && request.signal?.aborted !== true) {
      throw new ProviderError(504, `${provider.name} did not answer inside ${String(provider.timeoutMs)}ms.`)
    }
    throw error
  }

  // The address and the credential, which for one shape of row are two halves of the same
  // stored string.
  const reach = reaching(provider, key)

  const response = await fetch(`${reach.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(reach.key !== undefined && { authorization: `Bearer ${reach.key}` }),
      ...provider.headers,
    },
    body: JSON.stringify({
      model: request.model,
      messages: request.messages.map(toWire),
      // A provider-wide `tools: false` outranks anything the caller asked for. The per-model
      // `supportsTools` flag cannot cover this on its own: a roster discovered live has
      // models the catalog has never seen, and the backends behind one do not decline a
      // `tools` field politely — they 500 on it.
      ...(provider.tools !== false && request.tools && { tools: request.tools.map(asFunction) }),
      ...(request.maxTokens !== undefined && { max_tokens: request.maxTokens }),
      stream: true,
      // The only way to be told what a streamed answer cost. A provider that ignores it
      // leaves usage at zero, which is the honest number to show rather than a guess.
      stream_options: { include_usage: true },
    }),
    signal,
  }).catch(gaveUp)

  if (!response.ok || !response.body) {
    // The body is the provider's own explanation, and it is usually the useful part.
    const said = await response.text().catch(() => '')
    throw new ProviderError(response.status, `${provider.name} said ${response.status}: ${said.slice(0, 200)}`)
  }

  let content = ''
  let model = request.model
  let usage: Usage = { in: 0, out: 0 }
  const calls: ({ id: string; name: string; arguments: string } | undefined)[] = []

  // The stream can stall as easily as the handshake can, and a row's patience has to cover
  // both — a provider that stops mid-sentence has failed exactly as completely as one that
  // never spoke, and the rung below it can still answer.
  try {
    for await (const event of frames(response.body)) {
      if (event === '[DONE]') break
      let chunk: Chunk
      try {
        chunk = JSON.parse(event) as Chunk
      } catch {
        // A frame that is not JSON is a provider having a bad day, not a reason to lose the
        // answer that arrived before it.
        continue
      }
      if (chunk.model) model = chunk.model
      if (chunk.usage) {
        usage = { in: chunk.usage.prompt_tokens ?? 0, out: chunk.usage.completion_tokens ?? 0 }
      }
      const delta = chunk.choices?.[0]?.delta
      if (!delta) continue
      if (delta.content) {
        content += delta.content
        onDelta?.(delta.content)
      }
      for (const call of delta.tool_calls ?? []) {
        // Streamed in pieces and keyed by index: the id and name arrive once, the arguments
        // in fragments that only mean anything concatenated.
        const at = (calls[call.index] ??= { id: '', name: '', arguments: '' })
        if (call.id) at.id = call.id
        if (call.function?.name) at.name = call.function.name
        if (call.function?.arguments) at.arguments += call.function.arguments
      }
    }
  } catch (error) {
    gaveUp(error)
  }

  const asked = calls.filter((c) => c !== undefined)
  return {
    message: { role: 'assistant', content, model, ...(asked.length > 0 && { calls: asked }) },
    usage,
  }
}

/** A stored message, in the shape every OpenAI-compatible endpoint takes. */
function toWire(message: Message): Record<string, unknown> {
  return {
    role: message.role,
    content: message.content,
    ...(message.calls && {
      tool_calls: message.calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      })),
    }),
    ...(message.callId !== undefined && { tool_call_id: message.callId }),
  }
}

const asFunction = (tool: ToolSpec): Record<string, unknown> => ({
  type: 'function',
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters ?? { type: 'object', properties: {} },
  },
})

/**
 * The `data:` payloads of a server-sent event stream, in order. Everything else — comments,
 * event names, the blank lines between frames — is not something any of these endpoints
 * sends anything meaningful in.
 */
async function* frames(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // A chunk boundary lands mid-line often enough that this is the whole reason for the
    // buffer: yield the complete lines, keep the tail for the next read.
    let cut = buffer.indexOf('\n')
    while (cut !== -1) {
      const line = buffer.slice(0, cut).trim()
      buffer = buffer.slice(cut + 1)
      if (line.startsWith('data:')) yield line.slice('data:'.length).trim()
      cut = buffer.indexOf('\n')
    }
  }
}
