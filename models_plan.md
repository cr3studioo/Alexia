# models_plan.md

**Model routing, provider integration, and the never-without-an-LLM ladder.**

*Written 2026-08-30. Captured from the research session of the same date.*

---

## 0. What this document is — and is not

This is an **information capture**, not a plan. It is the full record of what we
investigated, what we decided, what we rejected, and what we still do not know —
written down so none of it has to be re-derived.

- **It does not schedule anything.** No milestones, no task IDs, no ordering.
  When this becomes work it becomes a `D`-number and tasks in [`plan.md`](./plan.md);
  this file is the input to that, not a substitute for it.
- **It does not authorise anything.** Nothing here has been built. Several
  sections describe bugs that exist in `main` right now; they are findings, not fixes.
- **Every factual claim is sourced.** Where two sources disagree, both are recorded
  and the disagreement is marked with a warning rather than resolved by guessing.
- **Where the research was wrong, the correction is kept**, not silently edited
  out. See §4.3.

> **Read order:** §2 is the goal. §6 is the provider data. §8–§11 are the
> architecture. §13 is what is currently broken. §16 is what still needs a human answer.

---

## 1. Sources, and how these facts were verified

| Source | What it is | Retrieved | Trust |
|---|---|---|---|
| [OmniRoute](https://github.com/diegosouzapw/OmniRoute) | MIT gateway, 352 providers, 58.5k stars | 2026-08-30 | **High** — publishes ToS verdicts against its own defaults, refuses to inflate token maths |
| `open-sse/config/freeModelCatalog.data.ts` | OmniRoute per-model free catalog, 455 rows | 2026-08-30 | **High** — stamped `FREE_CATALOG_CURATED_AT = "2026-08-20"` |
| `open-sse/config/providers/registry/*` | 251 provider entries, 404 KB total | 2026-08-30 | **High** — declarative, with live-probe dates in comments |
| `docs/reference/FREE_TIERS.md` | OmniRoute free-tier doc | 2026-08-30 | **Medium** — it is a **2026-06-05 snapshot**, superseded by the data file above |
| `docs/reference/PROVIDER_REFERENCE.md` | OmniRoute per-provider notes | 2026-08-30 | High |
| [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) | MIT gateway, 34 providers, 22.7k stars | 2026-08-30 | **Medium** — see §3.2; self-describes as "Personal experimentation only" |
| `server/src/providers/index.ts` | FreeLLMAPI provider registry | 2026-08-30 | High — carries live-probe dates |
| OVHcloud + AI Horde official docs | rate limits | 2026-08-30 (web) | High |
| Alexia's own source | `packages/core/src/*` | 2026-08-30 | Ground truth |

**Method.** Every provider claim below is corroborated across **both** gateways
where possible. Where only one lists a provider it is marked *unverified* (§6.5) —
two independent projects cataloguing the same free tier is much stronger evidence
than either alone.

**Staleness warning.** OmniRoute's own docs show free tiers dying monthly
(`chutes` ended 2026-03, `phind` shut down 2026-01, `kluster` sunset 2026-06-09,
Gemini 2.0 Flash shut down 2026-06-01). Any table copied from them **decays
silently**. See §7 (`verified` field) and §13.4.

---

## 2. The goal

> *"That way it would be pretty fucking hard to not have an LLM running."*
> — the owner, 2026-08-30

Stated precisely, as something testable:

**Alexia should reach a working conversation with zero API keys, zero signups and
no account — and should keep working as each layer above it runs out.**

Two sub-goals fall out of it:

1. **Never fully dead.** There is always something below the current rung.
2. **Never silently degraded.** Falling to a worse rung is visible, and falling
   from an agent-capable rung to a chat-only one is *never silent* (§8.5).

This should be enforced by the codebase, not claimed by the README. See §13.5.

---

## 3. Findings: the two gateway projects

### 3.1 OmniRoute

MIT-licensed, self-hosted. **Not a hosted API** — you install it
(`npm i -g omniroute`, Docker, or Electron) and it serves `http://localhost:20128/v1`.

**Does it let you pick models?** Yes. Auto-routing is opt-in, one of three modes:

| Mode | Example | Who decides |
|---|---|---|
| Explicit | `{"model": "cc/claude-opus-4-6"}` | You |
| Auto | `auto`, `auto/coding`, `auto/fast`, `auto/cheap`, `auto/offline`, `auto/smart` | It (15-factor scoring) |
| Combos | a named chain plus one of 19 strategies | You define, it walks |

- `GET /v1/models` returns everything in OpenAI format, combos pinned first.
- **`?prefix=alias` is the one to use** for a model picker. The default `dual` mode
  emits both `cc/claude-sonnet-4-6` *and* `claude/claude-sonnet-4-6` for the same
  model, roughly doubling the list.
- Every response carries `X-OmniRoute-Decision: strategy=...; provider=...; latency_ms=...`.
- Wire compatibility: OpenAI `/v1/chat/completions`, Anthropic `/v1/messages`,
  Gemini `/v1beta`, and `/v1/responses`.

### 3.2 FreeLLMAPI

MIT, 34 providers, self-hosted on `localhost:3001`, unified key, encrypted SQLite.

Two things to know:

1. **Self-flagged risk.** Its own repo description ends *"Personal experimentation
   only."* Take that as seriously as OmniRoute's per-provider ToS verdicts.
2. **Its catalogue is a hosted service, not the repo.** It syncs a signed catalogue
   from `freellmapi.co` twice daily, and the **free tier deliberately lags 30 days**
   behind the live feed (premium gets same-day). The static list in the repo is a
   trailing snapshot — fine to harvest, not something to depend on for currency.

Its per-provider comments are excellent and carry **live-probe dates**. Several
gotchas in §6.6 come from there and nowhere else.

### 3.3 Verdict: take the table, do not run the daemon

**Decision: vendor the provider rows. Do not run either gateway as a sidecar.**

Reasons, in order of force:

**a) There is no "connection code" to take — they are rows.** OmniRoute's registry
entries are declarative config, the same shape as Alexia's `PROVIDERS`:

```ts
// open-sse/config/providers/registry/ovhcloud/index.ts — 964 bytes, in full
export const ovhcloudProvider: RegistryEntry = {
  id: "ovhcloud", alias: "ovh", format: "openai", executor: "default",
  baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions",
  modelsUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models",
  authType: "optional", authHeader: "bearer",
  models: CHAT_OPENAI_COMPAT_MODELS.ovhcloud,
};
```

`uncloseai` is 611 bytes. `aihorde` is 3.2 KB, mostly comments. **Median across all
251 registry entries: 841 bytes.** Total 404 KB. Nearly all are `format: "openai"`,
`executor: "default"`.

**b) The RAM cost is absurd for a tray assistant.** OmniRoute's own Docker guidance:

| Workload | Heap | Container |
|---|---|---|
| Dashboard / light chat | 1024 MB (image default) | at least 2 GB |
| **One coding agent** | **8192 MB** | **at least 10 GB** |
| Two concurrent long `/v1/responses` | 10240–12288 MB | 12–16 GB |

The repo is 483 MB across 14,892 files. Running that to obtain a table you could
paste in is indefensible.

**c) Two routers would fight.** OmniRoute *is* a router — 19 strategies, its own
quota ledger, its own circuit breakers. Alexia is a router (§5). If Alexia asked
OmniRoute for `auto`, Alexia would lose the routing decision and its cost ledger
would go blind.

> **Rule, should a gateway ever be used anyway:** always call it with an **explicit
> model id, never `auto`.** Treat it as dumb transport so Alexia's router stays the
> only router — one ledger, one order, one explanation to the user.
> `X-OmniRoute-Decision` can then *confirm* what served, as a check.

**d) It contradicts Alexia's own rule.** `provider.ts` header: *"adding a provider
must never mean adding code."* A daemon dependency is the largest possible version
of adding code.

### 3.4 Licence: clean

| Project | Licence |
|---|---|
| OmniRoute | **MIT** |
| FreeLLMAPI | **MIT** |
| Alexia | **AGPL-3.0-only** |

MIT into AGPL is one-way compatible; both can be absorbed. **Retain the MIT
copyright notice** on anything copied verbatim. In practice what is copied is
*facts* (URLs, limits, quirks), so a `Source:` plus retrieval-date comment per row
is both the licence courtesy and the staleness marker wanted anyway (§7).

---

## 4. The free-token reality

This section exists because the marketing and the truth diverge sharply, and the
product promise in §2 depends on knowing which is which.

### 4.1 The headline is entirely signup-gated

OmniRoute advertises **~1.51B free tokens/month**. Every row contributing to that
number requires you to create a free account and paste your own key.

| Provider | Steady tokens/mo | Your key needed? |
|---|---|---|
| `mistral` | ~1.00B | yes |
| `llm7` | ~150M | yes |
| `nara` | ~150M | yes |
| `gemini` | ~60M | yes |
| `cerebras` | ~30M | yes |
| `cloudflare-ai` | ~30M | yes |
| `api-airforce` | ~24M | yes |
| `ollama-cloud` | ~20M | yes |
| `groq` | ~15M | yes |

**Mistral alone is about two-thirds of the entire headline.** The gateway does not
give you tokens; it catalogues other people's free tiers and stacks them.

To OmniRoute's credit, they are unusually honest about this: they refuse to
multiply RPM by 24/7/30 to inflate numbers, they publish ToS flags against their
own defaults, and they explicitly call out competitors' inflated multi-billion
claims. That is why these figures are trusted here.

### 4.2 What keyless actually gives you

**15 providers, 80 models, zero signup.** In OmniRoute's catalogue every keyless
entry is literally `monthlyTokens: 0` — not because it gives nothing, but because
those providers publish **no token cap**. They cap on *rate* instead. The catalogue
legend: `—` = *"credit-only / keyless / not token-quantifiable"*, explicitly **not
summed into the headline**.

So both statements are true and are the same fact from two sides:
**you get models with no account; you do not get a token budget.**

| Provider | Models | Limit | ToS |
|---|---|---|---|
| `ovhcloud` | 5 | **2 req/min per IP per model** | **ok** |
| `aihorde` | 3 | volunteer queue, anonymous = lowest priority | **ok** |
| `uncloseai` | 3 | IP-throttled, undocumented | caution |
| `kilo-gateway` | 6+ | **200 req/hr per IP** | caution |
| `pollinations` | 24 | **currently broken** | caution |
| `avoid` bucket | 42 | varies | **avoid** |

**The `avoid` bucket is the trap.** It contains the models you would actually want —
`agy` alone lists Claude Opus 4.6 Thinking, Claude Sonnet 4.6, Gemini 3.1 Pro,
Gemini 3.7 Flash. They are keyless because they are **reverse-engineered browser
sessions** against Antigravity, DuckDuckGo Chat, Qwen Chat, T3 Chat, Blackbox and
Felo. Those ToS ban exactly this use, and the endpoints break whenever the upstream
site changes.

Full `avoid` list: `agy` (9), `opencode` (7), `blackbox` (6), `duckduckgo-web` (6),
`felo-web` (5), `qwen-web` (4), `muse-spark-web` (3), `friendliai` (2), `iflytek` (1).

**Note the two providers OmniRoute pre-wires into `auto` on a fresh install —
OpenCode Free and Felo — are both in that bucket.** Their out-of-box zero-config
experience runs on the shakiest endpoints in their own catalogue. Alexia must not
copy that choice.

### 4.3 Corrections made during this research

Kept deliberately, because each was a wrong claim that shaped a decision.

| Claim made | Correction | Why it mattered |
|---|---|---|
| "There is nothing free without signup" | **Wrong.** 15 keyless providers, 80 models, and OVHcloud/AI Horde are ToS-`ok` | Would have killed the §2 goal outright |
| "Only 1 of 25 keyless providers is ToS-`ok` (`stepfun`)" | Read from the **stale 2026-06-05** `FREE_TIERS.md`. The live data file (curated 2026-08-20) has **`ovhcloud` and `aihorde` as `ok`**; `stepfun` and `nvidia` are no longer keyless at all | Two clean keyless providers were nearly discarded |
| "AI Horde needs queue-polling code" | **Wrong for chat.** It has an OpenAI-compatible facade at `oai.aihorde.net`. Only *image* models use the native `/v2/generate/async` API | Would have justified a code exception that is not needed |
| "Ollama Cloud is keyless" | **Wrong — extraction error.** A regex block-split absorbed Kilo's comment into Ollama's entry. Both catalogues agree Ollama Cloud needs an API key | Would have put a keyed provider on the keyless floor |
| "The bottom rung can chat but cannot run the agent loop" | **Too broad.** AI Horde has no tool calling, but **OVHcloud keyless does** — live-probed 2026-06-10 with structured `tool_calls` on `gpt-oss-120b` and `Llama-3.3-70B` | Changes §8: the keyless floor is *partly* agent-capable |

---

## 5. What Alexia already has

Inventory taken 2026-08-30 against `main`. **Most of the architecture described in
§8–§11 already exists.** This is the single most important finding in the document.

| Capability | Where | State |
|---|---|---|
| Providers as **data, not code** | `packages/core/src/provider.ts` | `PROVIDERS` table, 7 rows |
| Provider fields: `baseUrl`, `models`, `headers`, `keyless`, `terms`, `rpm`, `rpd`, `trainsOnYourData`, `usage` | `provider.ts:15–52` | Done |
| Key storage | `keyOf()` = `provider_<id>`, via `secrets.ts` | Done |
| The routing ladder | `packages/core/src/router.ts` | Done |
| Tiers `T0`–`T3` | `router.ts:28` | Done |
| Placement modes (local / combined / cloud) | `router.ts:43` `MODES` | Done |
| Spend axis (`free` / `mixed` / `paid`) | `router.ts:61`, `:72` | Done |
| **429 falls to the next rung** | `router.ts:21–22` — declared non-negotiable | Done |
| **Tool-capability filter** | `router.ts:203` `!needsTools \|\| c.model.supportsTools` | Done |
| Escalation pin ("try again with a smarter model") | `router.ts:99` `above?: Tier` | Done, **manual only** |
| User's own running order | `router.ts:` `Pins.order` | Done |
| Planner floor by parameter count | `router.ts:155` `PLANNER = 7` | Done |
| Per-model `context` and `supportsTools` | `catalog.ts:28–29` | Present, **`context` unused by router** |
| Agent loop, **re-asking the router every step** | `agent.ts:24–26` | Done |
| Step ceiling | `agent.ts:133` `maxSteps` | Done |
| Continuous trace compaction | `packages/core/src/trim.ts` (174 lines) | Done |
| Cost calculation | `usage.ts` `costOf` | Done |
| `maxTokens` on a request | `provider.ts` `ChatRequest.maxTokens` | Present, optional |
| First-run screen | `packages/ui/src/main.ts:123`, gated at `:295` | Done, single-provider |
| Local models | `ollama.ts` | Done |
| Claude Code plugin | `plugins/claude-code/index.js` | **Built, ships disabled** (§14.1) |

Current `PROVIDERS` rows: `openrouter`, `groq`, `cerebras`, `google`, `mistral`,
`nvidia`, `github` (`provider.ts:66–130`).

---

## 6. Providers to integrate

### 6.1 Already in the table (7)

`openrouter`, `groq`, `cerebras`, `google` (AI Studio), `mistral`, `nvidia`,
`github`. No change needed beyond re-verification (§13.4).

### 6.2 Tier A — the keyless floor (no key, no signup, no card)

This is what makes §2 true. **Add all of these.**

| id | Name | Base URL | Models | Limit | ToS | Tools? |
|---|---|---|---|---|---|---|
| `ovhcloud` | OVHcloud AI Endpoints | `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1` | 5 | **2 req/min per IP per model** (400/min with a key) | **ok** | **yes** |
| `aihorde` | AI Horde | `https://oai.aihorde.net/v1` | 3 | volunteer queue; anonymous = lowest priority | **ok** | **no** |
| `uncloseai` | UncloseAI | `https://hermes.ai.unturf.com/v1` | 3 | IP-throttled, undocumented | caution | unknown |
| `kilo-gateway` | Kilo Gateway | `https://api.kilo.ai/api/gateway/v1` | 6+ | **200 req/hr per IP** | caution | unknown |

**Models:**

- **OVHcloud** — GPT-OSS 120B, GPT-OSS 20B, Qwen3.6 27B, Mistral Small 3.2 24B,
  Qwen2.5 VL 72B (vision).
- **AI Horde** — Cydonia 24B, Skyfall 31B, Gemma 4 31B (all 32k context, no tools).
- **UncloseAI** — Hermes 3 Llama 3.1 8B, Qwen3 Coder 27B, Gemma 4 31B.
- **Kilo** — `kilo-auto/free`, Nemotron 3 Super 120B, MiniMax M2.5,
  Trinity Large Preview, plus `passthroughModels` discovery.

### 6.3 Tier B — the seven added from FreeLLMAPI

Free tiers with real published budgets. All need a free key; none need a card
unless noted.

| id | Name | Base URL | Free/month | ToS | Notes |
|---|---|---|---|---|---|
| `llm7` | LLM7 | `https://api.llm7.io/v1` | **~150M** | caution | 2nd-largest tier in OmniRoute's entire catalogue after Mistral. 100 req/hr. See §6.6 for a key-requirement conflict |
| `nara` | NaraRouter | `https://router.bynara.id/v1` | **~150M** | caution | Shared 5M tokens/day pool. **Free key issued via their Telegram channel** — see §6.6 |
| `cloudflare-ai` | Cloudflare Workers AI | dynamic — see §6.6 | ~30M | caution | 10k Neurons/day. **Needs Account ID + API Token** |
| `ollama-cloud` | Ollama Cloud | `https://ollama.com/v1` | ~20M | ambiguous | *Not keyless* (§4.3). Models list at `/api/tags`, not `/v1/models` |
| `kilo-gateway` | Kilo Gateway | `https://api.kilo.ai/api/gateway/v1` | uncapped | caution | Also in Tier A — the key is optional, not required |
| `zai` / `zhipu` | Z.ai (Zhipu GLM) | `https://api.z.ai/api/paas/v4` | uncapped + ~20M signup | **ok** | GLM-4.7-Flash permanently free. **Two consoles, separate key namespaces** — see §6.6 |
| `cohere` | Cohere | `https://api.cohere.com/compatibility/v1` | 1,000 calls/mo | caution | **Calls, not tokens.** Must use the `/compatibility/v1` path |

**Why these seven.** The two 150M rows (LLM7, NaraRouter) are each roughly
**2.5x Alexia's entire current free capacity outside Mistral**. Cloudflare matches
Cerebras, which is already in the table. Z.ai is one of very few ToS-`ok` verdicts
in the whole space. Ollama Cloud is a familiar client shape (Alexia already speaks
Ollama locally). Kilo and Cohere are smaller but clean.

### 6.4 The ToS-`ok` cluster (optional, small, clean)

Nearly everything in this space audits as `caution`, so these stand out:
**`aion`, `agnes`, `requesty`, `sealion`, `navy`** — plus `ovhcloud`, `aihorde` and
`zai` already listed. Small tiers, but clean terms. Worth adding if the appetite
is for breadth.

- `agnes` — Agnes AI, `https://apihub.agnes-ai.com/v1`, $0/token promotional
  (live-probed 2026-06-15, LiteLLM cost headers return 0.0). ~30 concurrent before
  429s. **Needs a 60s timeout** — `agnes-2.0-flash` reasons before answering
  (20s TTFB on a one-word completion).
- `requesty` — `https://router.requesty.ai/v1`, free-forever GPT-OSS 120B + Nemotron.
- `navy` — `https://api.navy/v1`, ~4M/mo. Requires a `User-Agent` header.
- `aion` — Aion Labs, `https://api.aionlabs.ai/v1`, uncapped.
- `sealion` — SEA-LION, `https://api.sea-lion.ai/v1`, uncapped.

### 6.5 Rejected, with reasons

| Provider | Why not |
|---|---|
| `agy` (Antigravity) | **`avoid`.** Reverse-engineered OAuth; ToS explicitly prohibits third-party tools/proxies. Tempting because it lists Claude Opus 4.6 and Gemini 3.1 Pro — that is exactly why it is dangerous |
| `opencode` (OpenCode Free) | **`avoid`.** ToS restricts to *"your own internal use, and not on behalf of or for the benefit of any third party"* |
| `felo-web` | **`avoid`.** Reverse-engineered web session |
| `duckduckgo-web` | **`avoid`.** ToS prohibits *"automated querying and developing or offering AI services"* |
| `qwen-web`, `t3-web`, `muse-spark-web`, `blackbox` | **`avoid`.** Scraped chat UIs; ToS bans automated access; break on upstream change |
| `iflytek` / `xfyun` | **`avoid`.** ToS §2.4(3) prohibits automated/programmatic extraction |
| `pollinations` | **Broken.** OmniRoute's own probe (2026-07-31) got 401 via the gateway and Cloudflare 1010 direct. FreeLLMAPI adds that chat now needs a real publishable key and free capacity accrues at *one pollen per IP per hour* |
| `kiro` | **`avoid`.** FAQ explicitly prohibits use with *"OpenClaw and similar tools that leverage third-party harnesses"* |
| `qianfan` (Baidu), `volcengine`, `longcat` | Generally require a Chinese phone number / KYC |
| `fireworks`, `modal`, `nlpcloud`, `friendliai`, `ai21`, `featherless-ai` | **`avoid`.** All carry explicit anti-proxy / anti-sublicensing clauses |

### 6.6 Per-provider gotchas

These are the expensive-to-discover facts. **This subsection is the single highest-value
part of the document.**

**OVHcloud**
- Anonymous host is `oai.endpoints.kepler.ai.cloud.ovh.net`. Unguessable.
- **A bad key is worse than no key.** Upstream returns 403 instead of falling back
  to anonymous. Therefore `auth: 'optional'` and the header must be **omitted
  entirely** when no real credential exists — never sent empty.
- The 2 req/min is **per model**, so spreading across all 5 gives ~10 req/min aggregate.
- An OVH API key requires a Public Cloud project **with a payment method on file** —
  so keyless is the only no-card path.
- **Supports structured `tool_calls`** — live-probed keyless 2026-06-10 on
  `gpt-oss-120b` and `Meta-Llama-3_3-70B-Instruct`.

**AI Horde**
- Anonymous key is the **literal string `0000000000`** — an absence is not enough.
- Needs a **120s timeout**; it is a volunteer queue and latency is minutes, not seconds.
- **No tool calling.** Workers run raw text-completion backends and 500 on a `tools` field.
- **`requiresPlainStringContent`** — the Aphrodite facade 500s on a single-text-part
  content array; it only implements the plain-string form.
- A real account key buys higher queue priority via kudos; it is optional.

**Kilo Gateway**
- Keyless verified live 2026-08-11: no `Authorization` header, `/chat/completions`
  answered 200 (routed to `stepfun/step-3.7-flash`).
- Model list is at `/api/gateway/models` (**no `/v1`**); the `/v1/models` path only
  accepts POST and returns **405** on GET.
- **Free prompts and outputs are logged for training.** This must be recorded as
  `trainsOnYourData: 'yes'` — the only provider in this document where the answer
  is known and is yes.
- Most named "free" routes eventually transition to paid. Probe before trusting.

**Cloudflare Workers AI**
- **The base URL is dynamic** — it embeds the user's Account ID:
  `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1`.
- FreeLLMAPI's solution is clean and worth copying: **store the key as
  `account_id:api_token`** and template the URL from it.
- This is the one provider in this document that **does not fit Alexia's
  "providers are rows" rule as written** — see §7 and §16 Q3.
- Needs a **60s timeout**; `@cf/zai-org/glm-4.7-flash` needs **200s** (repeated 15s
  aborts in a live sweep 2026-07-11).
- Several catalogued model ids are dead and return 400/403/410 — do not seed
  `llama-3.3-70b-instruct`, `llama-3.1-8b-instruct`, `gemma-3-12b-it`,
  `qwen2.5-coder-15b-instruct`.

**Cohere**
- **Must use `https://api.cohere.com/compatibility/v1`**, not the native `/v2/chat`.
  The native endpoint returns a proprietary shape
  (`{ message: { content: [{type:"text", text:...}] } }`) that no OpenAI-compatible
  client can read.
- Free tier is **1,000 API calls/month** — a call budget, not a token budget. Alexia's
  `rpd`/`rpm` fields cannot express this. See §16 Q4.

**Z.ai / Zhipu**
- **Two consoles that do not share a key namespace.** A key minted on `z.ai` is a
  401 at `open.bigmodel.cn` and vice versa. A single pinned host makes every
  key from the other console look like a bad key.
- Global (recommended): `https://api.z.ai/api/paas/v4` — OpenAI-compatible.
- Domestic: `https://open.bigmodel.cn/api/paas/v4`.
- Note OmniRoute's `zai` entry uses the **Anthropic** wire format at
  `api.z.ai/api/anthropic/v1/messages` with `x-api-key`. **Do not copy that** —
  use the OpenAI-compatible `paas/v4` path above.
- Needs a longer timeout (reasoning models).

**LLM7**
- ⚠️ **Sources conflict on whether a key is needed.** Record as unresolved:
  - `FREE_TIERS.md` audit: *"the 'no signup required' claim is now outdated — a free
    token from token.llm7.io is now required."*
  - `PROVIDER_REFERENCE.md`: *"Use any non-empty key (for example 'unused')."*
  - FreeLLMAPI: *"100 req/hr free; anonymous access also works for basic models."*
  - **Action: live-probe before deciding whether it belongs in Tier A or Tier B.**
- Rate limits have moved before (20 RPM / 100 req-hr up to 40 RPM / 200 req-hr).

**NaraRouter**
- Free key requires **no card, but Telegram channel/link verification**. That is real
  onboarding friction and a trust question — flag it on the key tile (§12).
- Free tier is a **shared 5M tokens/day pool**, not per-user.
- Live-probed 2026-07-09 on a zero-balance account: only `mistral-large`,
  `mistral-medium-3-5` and `tencent-hy3` answered 200. The rest of `/v1/models` was
  credit- or plan-gated. **Pin only the three known-free ids.**
- `mistral-large` and `mistral-medium-3-5` support tool calling; `tencent-hy3` has a
  1M context.

**Ollama Cloud**
- Model list is at **`/api/tags`** (Ollama-native), not `/v1/models`.
- Needs a **120s timeout**.
- Returns reasoning in `message.reasoning`, not `reasoning_content`.
- Rate limits vary by plan and are undocumented for free ("Light usage").

**UncloseAI**
- Accepts **any non-empty string** as a key, used only for identification.
- Some built-in model ids 404; verified-live id is
  `solidrust/Hermes-3-Llama-3.1-8B-AWQ`.

**OpenCode Zen** (if ever added)
- Needs a free account key from `opencode.ai/auth`, no card.
- Free roster is **trial-only** and **prompts/outputs may be used to improve the
  models**.

---

## 7. Changes needed to the `Provider` interface

Alexia's `Provider` (`provider.ts:15–52`) is close but cannot express four things
the providers above require.

```ts
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
 * The date somebody last confirmed this row against the provider's own docs.
 * These endpoints die monthly; a copied table goes stale silently.
 */
verified?: string
```

Two further items, both unresolved — see §16:

- **A URL template**, for Cloudflare's account-id-in-path. Options: a `{account}`
  placeholder in `baseUrl` plus a key parsed as `account_id:api_token`
  (FreeLLMAPI's approach), or accept one code exception.
- **A call budget**, for Cohere's 1,000 calls/month. `rpm`/`rpd` cannot express it.

**`tools?: false` collides with the router.** `router.ts:203` already filters on
`model.supportsTools`, and `catalog.ts:29` already carries the per-model flag. The
provider-wide fallback is needed because AI Horde's roster is discovered live —
without it, any newly-discovered model sends `tools` straight through and gets a 500.

---

## 8. The routing ladder

### 8.1 The organising idea: hands versus mouth

Some models have **hands** — they can call tools, so they can actually do work.
Some can only **talk**.

**Always ask a helper with hands first. Only when every hands-helper is exhausted
do you fall to the talkers.**

This is not a new mechanism. `router.ts:203` already implements the split:

```ts
.filter((c) => !needsTools || c.model.supportsTools)
```

One list plus one filter, not two lists.

### 8.2 The ladder

```
HELPERS WITH HANDS  (tool-capable — can do real work)
  1. your own direct free-tier keys      "ready for anything"          green
  2. your Claude subscription            "paid — but basically free"   green   [gated, §14.1]
  3. OpenRouter free (tool-capable only) "working, a bit worse"        amber
  4. local model (tool-capable)          "using your computer"         amber
  5. OVHcloud keyless                    "free floor, still capable"   amber   [tools confirmed]

HELPERS WHO ONLY TALK  (chat-only — no tool calling)
  6. free-tier chat-only models          "just chat now"               red
  7. OpenRouter chat-only                "just chat"                   red
  8. local chat-only                     "just chat"                   red
  9. AI Horde / UncloseAI keyless        "barely alive, but alive"     red
```

**OVHcloud at rung 5 is the important refinement** (§4.3). It is keyless *and*
tool-capable, so the agent loop survives all the way down to the no-key floor —
slowly, at 2 req/min, but it survives. Only below that does Alexia become
chat-only.

### 8.3 Local placement — the decision, and why

**Decision: local sits low in the cascade, not high. This was the owner's
correction and it is right.**

The reasoning that was initially offered against it — that
`router.ts:22` declares *"a privacy pin that escalates by itself is a betrayal"* —
**misapplied the pin.** Privacy is enforced by *mode selection*, not by cascade order:

> If a user wants privacy they press `/local`. That switches `MODES.local`
> (`router.ts:43`), which places **every** capability class locally and shuts the
> cloud cascade off entirely.

Therefore the cascade only ever runs for someone who **did not** ask for privacy.
For that person local is not "the private one" — it is **a slow helper that lives
in their house**. Slow helpers go near the end. Practically: a local 8B beats
OVHcloud-at-2-req/min on latency, but it loses to every keyed free tier above it,
and it is not the thing to reach for first.

**Open consequence.** In `MODES.combined`, `text` is placed `cloud`, so local text
is **not a rung in the cascade at all today**. Making it the last-resort text rung
changes `MODES` semantics. That is a real decision, not a tweak — see §16 Q1.

### 8.4 Status bubbles

Each rung shows the user what state they are in. **The bubble says what the
assistant can *do*, not what it costs.** "Not available for agentic work, just
chat" is useful; "currently paid" is not — nobody cares that it is paid, they care
that it still works.

Local model bubbles should carry a capability tag rather than a price:
*"good for agentic, slow"*, *"everything ready, using local"*,
*"everything ready, slower responses"*.

### 8.5 The mid-task rule (non-negotiable)

> **Never swap from a hands-helper to a talker in the middle of a job.**

A hands-helper on step 12 of 20 that gets tired cannot be replaced by a talker —
the talker cannot pick anything up, and the task is stranded half-done.

When the last tool-capable rung is exhausted mid-task, Alexia must either:

- **(a)** wait / retry within the hands ladder, or
- **(b)** stop and say plainly *"I ran out of helpers with hands."*

It must **never** quietly continue on a chat-only model. This is the agentic
sibling of the existing rule at `router.ts:23` (*"a pin is never silently
violated"*) and should be written down the same way.

---

## 9. Paid credits and the budget

### 9.1 The finding that reframes this

**This is not a feature to add. It is already shipping, uncapped.**

`router.ts:198`:
```ts
const spend = where === 'cloud' ? (pins.spend ?? 'mixed') : 'mixed'
```

The default is `mixed`, and `mixed` applies **no filter at all** (`router.ts:211`).
Paid models are in the pool right now, sorted cheapest-first. Free models win only
because they sort at price 0.

So the moment free is filtered out — `needsTools`, an `above` pin, `uncensored`, or
a spent free tier — **a paid model is chosen and billed. No cap, no confirmation,
no budget.** And `reachable()` deliberately keeps paid models alive on a key whose
free tier is spent, so the exhaustion path leads *straight* into billing.

`Alexia.md` opens by arguing these things *"cost money you should not have to
spend."* The shipped default contradicts the founding document. See §13.1.

### 9.2 Money is a permission, not a rung

Every other rung failure is free: a 429 costs nothing, falling to local costs
nothing. **Money is the only irreversible step.** That asymmetry means it does not
belong *in* the ladder — and Alexia's code already agrees, since `Spend` is a
filter, not a rank.

**One number: a daily allowance, defaulting to $0.**

- `$0` means the app behaves exactly like `spend: 'free'`.
- Set `$1/day` and paid unlocks.
- People think in "a coffee a week", not in dollars per million tokens.

Daily rather than monthly for two reasons: the free tiers it bridges reset daily,
and **an agent loop can burn a month's budget in an hour** — a daily cap bounds the
blast radius.

### 9.3 Where paid fires: two rules

This answers "before or after local?" without picking a fixed position:

| Why free failed | What happens |
|---|---|
| **Tired** (429, quota spent) | try **local first**, then pay |
| **Incapable** (nothing free has tools / the context / vision) | **pay now** — local is weaker than free and will not do it either |

Each is defensible in one sentence, which is the test for whether a routing rule
should exist.

### 9.4 Three details that stop it going wrong

1. **Always send `maxTokens` on a billed call.** This is the answer to *"how does
   it know what it will cost?"* — it cannot. Input tokens are countable before
   sending; output tokens are not. `maxTokens` converts an unknown cost into a
   bounded one. `ChatRequest.maxTokens` already exists; it must become **mandatory
   when money is involved**.
2. **Never pay for a sidegrade.** The cheapest-first comparator will happily buy a
   paid model no better than the free one that just ran out. Paying for equal
   quality is the worst possible outcome. A paid model enters only when it is
   genuinely **above** the rung it replaces.
3. **Show the number.** "Spent $0.12 of $1.00 today."

### 9.5 The user-facing prompt

When free-agentic and subscription are both exhausted and local is available:

> *"Do you want slow local (free), or paid credits on `<provider>`?"*

- **Ask once per task and remember for the session.** A router that asks about money
  on every request is a nag, and people click through nags without reading — which
  is worse than not asking.
- Once they say yes, pick **the cheapest model that is a genuine step up** from the
  one that failed — not cheapest-first (that is the bug in 9.4.2).

### 9.6 The minimal alternative

If the appetite for this is low: **change the default from `mixed` to `free`.** One
line. The three-way switch already exists, so a user who wants to spend flips it
themselves and is never surprised.

**Recommendation: the middle.** Keep `mixed` as default but gate it behind an
allowance starting at zero — same safety as `free` out of the box, and the router
gets smarter the moment someone opts in.

---

## 10. Escalation — routing by difficulty

### 10.1 The problem

A cheap model that loops for 40 turns costs more than a good model that solves it in
4. But a good model on a trivial task is pure waste — for *"open a calculator and
screenshot it"*, the cheapest model wins by a thousandfold. So neither
"always cheap" nor "always expensive" is right.

### 10.2 Why "read the request and decide" cannot work

Difficulty is currently guessed at `router.ts:157`:

```ts
const HARD = /\b(refactor|debug|architect|design|prove|derive|optimi[sz]e|why does|step by step|plan (?:out|the))\b/i
```

...plus "is it over 400 chars" and "does it contain a code fence". Its own comment
says *"Boring, and edited when it is wrong."*

- *"open a calculator and send me a screenshot"* → `simple`. Correct.
- *"fix this bug"* → `simple`. Could be three hours.

**No regex fixes this and no classifier does either, because the difficulty is not
in the sentence.** The router header already warns: *"a learned router this early
is a trap."*

### 10.3 The reframe: measure struggle, do not predict difficulty

The agent loop reveals ground truth as it runs. By step 6 you know things no prompt
could tell you:

| Signal | Meaning | Cost to detect |
|---|---|---|
| Same tool + same args called twice | looping | **exact**, a string compare |
| Same tool error 3x running | stuck | trivial |
| N steps, nothing new touched | spinning | cheap |
| Step count past a fraction of `maxSteps` | grinding | free |
| X% of task budget burned, not done | expensive | free |

The first is exact rather than heuristic and catches most of the "loops for hours"
case on its own.

### 10.4 Start cheap — always. The asymmetry

| | start cheap | start expensive |
|---|---|---|
| **easy task** (the majority) | costs ~nothing | **pay 100x for a screenshot** |
| **hard task** | waste ~5 cheap steps detecting struggle, then escalate | correct, but taxed everything else |

Wasting five cheap steps to *learn* that a task is hard costs a fraction of a cent.
Paying premium on every calculator screenshot costs constantly. Easy tasks dominate.

### 10.5 The budget cap is a trigger, not a wall

This resolves the objection that a per-task cap is bad because a cheap model burns
it looping and fails — correct, **if the cap is a wall.** Make it a doorway:

> When a task has burned ~40% of its budget without finishing, **that is the
> evidence** that cheap is not working. Spend the remaining 60% on one attempt with
> a better model.

Same budget, opposite outcome: instead of *"cheap model burns the cap and fails"*,
it is *"cheap model spends 40% proving it cannot, good model spends 60% and
finishes."* **The waste becomes the signal.**

### 10.6 What already exists

- **`agent.ts:24`** — *"Every step re-asks the router. Not one model for the task —
  one per step. A free rung that ran out on step four does not fail the task on step
  five."* **Escalation needs no restart**; changing the pin mid-task is already the
  architecture.
- **`router.ts:99`** — `above?: Tier`, *"try that again with a smarter model."*
  **The escalation pin already exists, wired to a button.**
- **`agent.ts:133`** — `maxSteps`, whose comment names the exact fear: *"the failure
  without one is a model calling the same tool until the month's budget is gone."*

**So the work is not "build escalation" — it is "fire the existing pin automatically
when the loop shows struggle."** The pin's own documentation anticipated this: the
manual escape hatch *"collects the labelled data a cleverer one would need anyway."*

**Refinement:** escalate the **planning** step, not every step. Let the good model
think; let cheap models keep doing the mechanical read-file / run-command turns.
Per-step routing already supports this, and that is where most of the saving lives.

### 10.7 What D62 already settled

D62 removed shape-to-tier routing — but **not for a reason that blocks this.** It
went because a local 8B turned out to *be able* to plan, so every row in the table
collapsed to `T0` and the lookup did nothing (*"a lookup that returns the same answer
for every key is drift with a type annotation"*). `PLANNER = 7` took over the job
`tier` could not do.

Difficulty routing **inside the paid pool** was never what D62 rejected. Its closing
line is in fact the complaint this section answers: *"In cloud mode every step was
already going cheapest-first, so there was never a saving there to find."*

### 10.8 The honest limit

Struggle detection catches **looping and thrashing**. It does **not** catch the
*confidently wrong* model — one making smooth, plausible progress toward a wrong
answer. No telemetry sees that; only a checker or the user does. `checker.ts` is the
place for it, and it is a separate problem.

---

## 11. Context, trimming, and hand-off between models

### 11.1 There is no hand-off

Models are **stateless functions over the conversation**. Nothing is ever "in a
model's brain" — whatever the planner thought is either written into the message
list or it never existed. Every step re-asks the router and hands whichever model
wins the *same* message list.

So *"is the context shareable?"* — it was never owned by a model. There is no
transfer, no farewell, no export. Model B simply reads what is there.

**The scratchpad already exists.** It is `Message[]` in the store, and `trim.ts`
(174 lines) already compacts it. Its docstring is already reaching for the right
principle:

> *"Summarise for what worked, not only for what happened. A trace trimmed to
> 'read three files, then answered' is enough to carry on with and useless for
> anything else."*

### 11.2 Compact as you go — never at hand-off

The worry — *you cannot ask the model to summarise before handing off, because the
quota might die unexpectedly and providers give no countdown* — is correct, and the
architecture already avoids it. `agent.ts`: trimming is *"re-applied every step,
because the trace grows under the loop."*

Because compaction is continuous, the context is **always** in a hand-off-ready
state. There is no moment where a summary is pending, so **no model ever needs to
say goodbye.** This failure mode cannot occur.

### 11.3 The rule for what survives: closed versus open

From the calculator example — *does the next agent need to know where the last one
looked? Yes if not found, no if found* — generalised:

> **An observation matters until a conclusion supersedes it.**

- **Found it** → the 47 failed paths are dead weight. One line survives:
  `calculator.exe is at C:\...`
- **Not found** → the paths *are* the finding. They are negative space that stops
  the next model repeating the search.

So the question is never *"is this important?"* (unanswerable). It is **"has this
line of inquiry closed?"** — which the loop already knows, because it can see
whether a sub-goal was answered.

Most of the collapse is **mechanical, no model required**:

- a call that errored and was later retried successfully → drop the error
- a file read, then edited → keep the edit, drop the stale read
- an identical call repeated → keep one
- a result superseded by a later one → drop the earlier

That is the cheap 80%, fully deterministic.

### 11.4 Context is a cache, not a record

For bug-hunting, "even one line of code matters" is true — but code does not have
to live **in context**. Keep a **pointer**:

`src/router.ts:198-211` is ~30 tokens. Its content is ~2,000.

**If the next model needs it, it re-reads it.** In an agent loop, anything
re-derivable by a tool call is droppable, because dropping it costs *one tool call*,
not the information. That is the difference between an agent and a chat window, and
it is what lets a 32k model work in a repo of hundreds of thousands of lines.

### 11.5 On graphs: right mental model, wrong build

A graph's value is answering *"what does this conclusion depend on?"* — but building
one requires answering *"does this line of code matter to this bug?"*, which is the
unanswerable question. **Do not build a structure whose value depends on a question
you cannot answer.**

Cheaper and ~90% as good: **tag each cycle with the sub-goal it serves.** One level,
not a graph. When a sub-goal closes, its cycles collapse to the conclusion. That
yields dependency-collapse without dependency-tracking.

### 11.6 The consequence: planner versus cranker

Context-aware routing splits the ladder by **role**:

- A **small-context model cannot plan** a long task — it cannot hold the history.
- It can absolutely **execute one step** ("read this file", "run this command"),
  which needs almost no history at all.

So the free tier does not become useless as the trace grows — it becomes the
**cranker**, while the planner stays on something with a real window.

This is the **same split** already wanted for cost reasons (§10.6), arriving again
for a completely different reason. That is usually a sign the split is real.

---

## 12. Onboarding and first run

### 12.1 What exists

`packages/ui/src/main.ts:123` (`firstRun`), gated at `:295` by `state.setup.done`.
Today: name field, three mode radios (Local / Combined / Cloud), **one** provider
dropdown plus one key box, terms line, autostart, hotkey note.

`Alexia.md` specifies first run as five screens, **under two minutes**, with
explicitly *no account, no email, no sign-up, no tour, no permission questions*.

### 12.2 The proposed screen: a bento key wall

**Do not fork the user on "OpenRouter or OmniRoute" at screen one.** That asks
someone to pick a vendor's plumbing before they have said hello, and it contradicts
the two-minute rule. Screen 3 already asks the right question — *"How should I
run?"* — which is about **them**, not about vendors.

Keep screen 3. Replace step **4a** with a bento wall:

- **Logo tiles** for every provider in `PROVIDERS`, each showing its real free-tier
  numbers on the face — *"Gemini — 60M tokens/mo, free"*, *"LLM7 — 150M tokens/mo"*.
- **Paste a key inline**, with a "how do I get one?" expander per tile carrying the
  3-step signup.
- **OmniRoute and OpenRouter are tiles among many**, not a fork.
- **Flag the friction** where it exists — NaraRouter's Telegram verification, and
  Cloudflare's Account ID, both belong on the tile face, not discovered later.
- **Flag the privacy cost** where it is known — Kilo logs free prompts for training.
- **Skip must be loud.** Zero keys must still reach a working conversation. That is
  the whole point of §2.

### 12.3 The four-stage mental model the user should end up with

Not a screen, but the thing the UI should make legible over time: free keys →
subscription → OpenRouter → local → truly-free floor, with the hands/mouth split
running through it (§8.2) and a bubble naming the current state (§8.4).

---

## 13. Bugs and gaps found during this research

These exist in `main` today. Listed by severity.

### 13.1 Unbounded automatic spending (§9.1)

`router.ts:198` defaults `spend` to `mixed`; `mixed` filters nothing. Paid models
are billed automatically with no cap, no confirmation and no budget, and the
free-tier exhaustion path leads directly into billing. **Contradicts `Alexia.md`'s
founding argument.** Worth fixing before any real user sees it.

### 13.2 The router never checks model context size

```
$ grep -n "context" packages/core/src/router.ts
(nothing)
```

`Model.context` exists (`catalog.ts:28`) and is **never read**. A 40k-token
conversation can be routed to a 32k model — not a degraded answer, a hard failure.

**This — not the scratchpad design — is what would break the keyless floor.** The
fix is a filter: a model whose window cannot hold the trace is **not a candidate**
and drops out of the pool the way a spent free tier does.

### 13.3 Trim budget is fixed regardless of target model

`trim.ts:37` — `budget: 24_000` chars, always. Conservative-safe for a 32k model,
wasteful on a 200k Claude.

Budget should be a function of the chosen model's context. That implies an ordering:
**route first, then trim to that model's window**, with the router's context filter
testing against the *floor* (head plus newest cycle — the part that can never
collapse). If even the floor does not fit, the rung is gone.

### 13.4 No staleness marker on provider rows

Free tiers die monthly. A copied table goes stale silently and the failure looks
like a bug in Alexia. Needs the `verified` field (§7) plus a way to re-check —
a `providers verify` command that pings each `models` URL. Probably not a CI test,
since it needs network.

### 13.5 The core promise is not tested

`test/invariants/02-boots-with-no-plugins.test.ts` exists. Its sibling does not.

> **`answers-with-no-keys.test.ts`** — no keychain entries, no Ollama running, and
> Alexia still returns a completion.

That turns §2 from a README claim into something CI enforces. Given the whole point
of this document, **this is the test that matters most.**

---

## 14. Constraints and gates

### 14.1 The Claude Code rung cannot be automatic

`plugins/claude-code/index.js` exists, but:

- **D53** (`plan.md`) — the plugin **ships off**, is **never auto-enabled**, and the
  user runs `claude setup-token` themselves.
- **M4-7** is open: *"Ask Anthropic about the Claude Code integration, in writing.
  The plugin ships off until that answer exists."*
- Anthropic's Consumer Terms bar accessing services *"through automated or non-human
  means"* and bar commercial use of a consumer subscription; cutting the other way,
  `claude setup-token` is an Anthropic-shipped feature explicitly for
  non-interactive use.

**Therefore rung 2 in §8.2 cannot be part of a shipped default cascade.** It can sit
in the ladder as a rung the user explicitly unlocks. Everything else in the ladder
is unaffected.

### 14.2 Licence obligations

MIT into AGPL is fine. Keep the MIT notice on anything copied verbatim, and prefer a
`Source:` + date comment per row (§3.4, §7).

### 14.3 The ToS posture

`trainsOnYourData` in `provider.ts` is `'unknown'` for **every** current row, on
purpose, and the plan makes reading those terms a condition of any public release.
The providers added here must follow the same rule:

- **Never infer the answer from the price**, however strongly a free tier hints.
- **One known exception:** Kilo Gateway logs free prompts and outputs for training.
  That is `'yes'`, and it is the only row in this document where the answer is known.

---

## 15. Do and do not

**Do**

- Vendor provider **rows**, with a `Source:` comment and a `verified:` date.
- Take the **gotchas** (§6.6) — they are the expensive part, not the URLs.
- Keep **one router**: Alexia's.
- **Start cheap**, escalate on measured struggle.
- Make the **context filter** exist before adding small-context providers.
- Ask about money **once per task**, and show what was spent.
- Let **Skip** on the key wall reach a working conversation.
- Record `trainsOnYourData: 'yes'` for Kilo.
- Live-probe **LLM7** to resolve the key conflict (§6.6).

**Do not**

- Run OmniRoute or FreeLLMAPI as a daemon.
- Call any gateway with `auto`.
- Add anything from the **`avoid`** bucket, however good the model list looks.
- Copy OmniRoute's default of pre-wiring OpenCode Free and Felo.
- Put **local** high in the cascade.
- Fall from a tool-capable rung to a chat-only one **mid-task**, silently or at all.
- Ship `spend: 'mixed'` without an allowance.
- Send an **empty** auth header to OVHcloud — omit it entirely.
- Pay for a **sidegrade**.
- Predict difficulty from the prompt.
- Build a dependency **graph** of the trace.
- Guess `trainsOnYourData`.
- Trust either gateway's catalogue to stay current.

---

## 16. Open questions — need a human answer

**Q1 — Does local become a rung in the cloud text cascade?**
Today `MODES.combined` places `text` in the cloud, so local text is not in the
cascade at all. §8.2 puts it at rung 4/8. That changes `MODES` semantics and
deserves its own `D`-number. *Blocking for the ladder.*

**Q2 — How many providers, and how curated?**
Options: (a) Tier A + the seven = 11 new rows; (b) plus the ToS-`ok` cluster = 16;
(c) everything credible. More rows means more surface to keep verified (§13.4).
*Recommendation: (a), then (b) if the key wall looks sparse.*

**Q3 — How is Cloudflare's account-id-in-URL handled?**
A `{account}` template in `baseUrl` with the key stored as `account_id:api_token`
(FreeLLMAPI's approach), or a code exception, or drop Cloudflare. *A template keeps
the "no code per provider" rule intact and is the recommendation.*

**Q4 — How is a call budget expressed?**
Cohere's free tier is 1,000 **calls**/month; `rpm`/`rpd` cannot say that. Add a
`callsPerMonth` field, or drop Cohere as not worth a schema change.

**Q5 — What is the default daily allowance?**
$0 is recommended (§9.2), which makes `mixed` behave like `free` until the user
opts in. Confirm.

**Q6 — Does this become one `D`-number or several?**
It spans providers, routing, spend, escalation, context and onboarding. Likely
several: providers + interface; the ladder + mid-task rule; spend + allowance;
escalation; the context filter.

**Q7 — Is the `avoid` bucket permanently out, or out pending a written policy?**
Recorded here as permanently out. Confirm that is the intent.

---

## 17. Appendix — reference data

### 17.1 The keyless catalogue in full

From `freeModelCatalog.data.ts`, curated 2026-08-20. **15 providers, 80 models.**

| ToS | Provider | Models |
|---|---|---|
| **ok** | `ovhcloud` | 5 — GPT-OSS 120B, GPT-OSS 20B, Qwen3.6 27B, Mistral Small 3.2 24B, Qwen2.5 VL 72B |
| **ok** | `aihorde` | 3 — Cydonia 24B, Skyfall 31B, Gemma 4 31B |
| caution | `pollinations` | 24 — **broken** |
| caution | `uncloseai` | 3 — Hermes 3 Llama 3.1 8B, Qwen3 Coder 27B, Gemma 4 31B |
| caution | `sparkdesk` | 1 — Spark Lite |
| unknown | `liquid` | 1 — Liquid LFM 40B |
| **avoid** | `agy` | 9 — Gemini 3.7 Flash x3, Gemini 3.1 Pro x2, Gemini 3.1 Flash Lite, Claude Opus 4.6 Thinking, Claude Sonnet 4.6, GPT-OSS 120B |
| **avoid** | `opencode` | 7 — Big Pickle, DeepSeek V4 Flash, MiniMax M2.5, Ling 2.6, Trinity Large Preview, Nemotron 3 Super, Qwen3.6 Plus |
| **avoid** | `blackbox` | 6 — GPT-4o, Gemini 2.5 Flash, Claude Sonnet 4, DeepSeek V3, Blackbox AI, Blackbox AI Pro |
| **avoid** | `duckduckgo-web` | 6 — GPT-5.4 Mini, GPT-5.4 Nano, Claude Haiku 4.5, Mistral Small 4, gpt-oss 120B, Gemma 4 31B |
| **avoid** | `felo-web` | 5 — Chat, Search, Scholar, Social, Document |
| **avoid** | `qwen-web` | 4 — Qwen3.8 Max, Qwen3.7 Max, Qwen3.7 Plus, Qwen3.6 Plus |
| **avoid** | `muse-spark-web` | 3 — Muse Spark, Thinking, Contemplating |
| **avoid** | `friendliai` | 2 — Llama 3.1 70B, Llama 3.1 8B |
| **avoid** | `iflytek` | 1 — General V3.5 |

### 17.2 FreeLLMAPI's 34 providers, cross-referenced

`HAVE` = already in Alexia · `PLAN` = §6.2 · `NEW` = §6.3/6.4 · `SKIP` = §6.5
· `UNVERIFIED` = §6.5 last row

| Provider | Status | Free/mo | OmniRoute verdict |
|---|---|---|---|
| `groq` | HAVE | 15M | recurring-daily / caution |
| `cerebras` | HAVE | 30M | recurring-daily / caution |
| `mistral` | HAVE | 1000M | recurring-monthly / caution |
| `openrouter` | HAVE | 1M | recurring-daily / caution |
| `nvidia` | HAVE | — | one-time-initial / caution |
| `github` | HAVE | ? | not in catalogue |
| `google` | HAVE | ? | not in catalogue |
| `ovh` | PLAN | — | keyless / **ok** |
| `aihorde` | PLAN | — | keyless / **ok** |
| `kilo` | PLAN + NEW | uncapped | recurring-uncapped / caution |
| `llm7` | **NEW** | **150M** | recurring-daily / caution |
| `nara` | **NEW** | **150M** | recurring-daily / caution |
| `cloudflare` | **NEW** | 30M | recurring-daily / caution |
| `ollama` | **NEW** | 20M | recurring-monthly / ambiguous |
| `zhipu` | **NEW** | uncapped + 20M | one-time-initial / **ok** |
| `cohere` | **NEW** | 1k calls | recurring-monthly / caution |
| `huggingface` | optional | ~200K | recurring-monthly / caution |
| `siliconflow` | optional | uncapped | recurring-uncapped / caution |
| `opencode` | **SKIP** | uncapped | **avoid** |
| `pollinations` | **SKIP** | — | keyless / caution, **broken** |
| `xfyun` | **SKIP** | — | keyless / **avoid** |
| `qianfan` | **SKIP** | uncapped | recurring-uncapped / caution, KYC |
| `volcengine` | **SKIP** | ? | not in catalogue, KYC |
| `longcat` | **SKIP** | 10M credit | one-time-initial / caution, KYC |
| `agnes` | ok-cluster | — | recurring-uncapped / **ok** |
| `aion` | ok-cluster | — | recurring-uncapped / **ok** |
| `requesty` | ok-cluster | — | recurring-uncapped / **ok** |
| `sealion` | ok-cluster | — | recurring-uncapped / **ok** |
| `navy` | ok-cluster | 4M | recurring-daily / **ok** |
| `bazaarlink` | optional | 4M | recurring-daily / caution |
| `ainative` | optional | — | recurring-uncapped / caution |
| `routeway` | optional | — | recurring-uncapped / caution |
| `reka` | optional | — | recurring-monthly / caution |
| `modelscope` | UNVERIFIED | ? | not in catalogue |
| `bai` | UNVERIFIED | ? | not in catalogue |
| `anyapi` | UNVERIFIED | ? | not in catalogue |
| `orcarouter` | UNVERIFIED | ? | not in catalogue |
| `unorouter` | UNVERIFIED | ? | not in catalogue |
| `xkiro` | UNVERIFIED | ? | not in catalogue |

**Unverified** = present in FreeLLMAPI but absent from OmniRoute's audited
catalogue entirely. Two independent projects, one listing. Probe before trusting.

### 17.3 Verified rate limits

| Provider | Anonymous | With key | Source |
|---|---|---|---|
| OVHcloud | **2 req/min per IP per model** | 400 req/min | OVHcloud docs, 2026-08-30 |
| AI Horde | lowest queue priority (anon key `0000000000`) | kudos-based priority | aihorde.net, 2026-08-30 |
| Kilo Gateway | **200 req/hr per IP** | higher | FreeLLMAPI, probed 2026-08-11 |
| LLM7 | ⚠️ disputed | 100 req/hr | conflicting, see §6.6 |
| Pollinations | 1 pollen/IP/hr — **broken via gateway** | key required | probed 2026-07-31 |
| Cohere | — | 1,000 calls/month | OmniRoute provider ref |
| Cloudflare | — | 10k Neurons/day (~150 LLM responses) | OmniRoute registry |

### 17.4 Alexia source references

| Fact | Location |
|---|---|
| `PROVIDERS` table | `packages/core/src/provider.ts:66–130` |
| "adding a provider must never mean adding code" | `provider.ts:9–13` |
| Key naming `provider_<id>` | `provider.ts` `keyOf()` |
| Tiers `T0`–`T3` | `router.ts:28` |
| `MODES` placement | `router.ts:43` |
| `Spend` type | `router.ts:61` |
| `Pins.spend` | `router.ts:72` |
| `Pins.above` (escalation pin) | `router.ts:99` |
| `PLANNER = 7` | `router.ts:155` |
| `HARD` difficulty regex | `router.ts:157` |
| **spend defaults to `mixed`** | `router.ts:198` |
| tool-capability filter | `router.ts:203` |
| spend filter | `router.ts:211` |
| 429 → next rung, pins never violated | `router.ts:21–24` |
| `Model.context`, `Model.supportsTools` | `catalog.ts:28–29` |
| trim defaults (`budget: 24_000`) | `trim.ts:37` |
| "every step re-asks the router" | `agent.ts:24–26` |
| `maxSteps` | `agent.ts:133`, ceiling at `:172` |
| first-run screen | `packages/ui/src/main.ts:123`, gated `:295` |
| D53 / M4-7 (Claude Code gate) | `plan.md:297–309`, `:3614`, `:3776` |
| D62 (shape-to-tier removal) | `plan.md:3765` |
| first-run spec, "costs money you should not have to spend" | `Alexia.md:29`, `:100–130` |
