// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { routes, sizeOf, type Catalog, type Model } from './catalog.js'
import { pins, setPin } from './commands.js'
import type { Aside } from './health.js'
import { OLLAMA } from './ollama.js'
import { MODEL_GROUPS } from './panels.js'
import { setKeylessOn } from './pool.js'
import { available, paid, ranking, route, type Choice, type Spend, type World } from './router.js'
import { allow, forgetConsent } from './consent.js'
import { forget } from './learned.js'
import type { Row } from './plugins.js'
import { anonymous, type Provider } from './provider.js'
import { Plugins } from './plugins.js'
import type { Skills } from './skills.js'
import type { Searchable } from './palette.js'
import type { Outcome, Store, Try } from './store.js'
import type { PluginTooling } from './tooling.js'
import { asText, spentOn, type Trace } from './trace.js'
import { caps, setCaps } from './usage.js'

/**
 * What core's own tables are made of (M6-4).
 *
 * Three panels, one widget. If any of them had needed a line of bespoke rendering in the
 * shell, `table` would have been the wrong widget and this is where that would have shown
 * up — which is why they were one task and not three. They did not, so this file is what a
 * core tab is: four functions returning rows, and one that acts on one.
 *
 * **Read-only unless this screen is the only owner.** Two of these say so out loud. The
 * plugins screen owns installing and removing a plugin, and `tooling.ts` reads the plugins
 * rather than the other way round — a second write path from here would be a parallel
 * mechanism, which is the rule the old dashboard got right on the first try and kept.
 *
 * Nothing in this file names a plugin. It reads whatever is installed and groups by whatever
 * that turns out to be called.
 */

export interface Source {
  rows(): Promise<Row[]>
  /** One line above the rows, when there is something to say — the Models tab's news (§4 D). */
  note?(): string | undefined
  /** What expands under one row. Text, and it is read rather than computed. */
  detail?(id: string): Promise<string>
}

export interface SurfaceOptions {
  skills: Skills
  /** Where the consent ladder is kept (M6-9). */
  store: Store
  tooling: PluginTooling
  plugins: Plugins
  /** Where the user's own skills live. A learned skill is a folder in it. */
  skillsDir: string
  /** The last five runs (M6-5). In memory, so this is the only place they exist. */
  trace: Trace
  /** Alexia's own data directory. An exported run is written into it. */
  dataDir: string
  /** What models exist, cached from each provider's own list (M6-4, Models tab). */
  catalog: Catalog
  /**
   * The providers holding a key, as a set rather than a question per provider.
   *
   * One call, because the answer lives in the OS keychain and the alternative is one
   * unlock per row on a table with several hundred of them.
   */
  connected(): Promise<ReadonlySet<string>>
  /** The provider rows this core reads, for a provider's name where a row has only its id. */
  providers: readonly Provider[]
  /** What the last fetch of each list added, as one line, or nothing (§4 D). */
  news?(): string | undefined
  /**
   * What the router can see right now — the same gathering the chat uses.
   *
   * Here so *recommended* can be the router's own answer rather than a second opinion about
   * models kept beside it. A screen that recommended something the thing would not itself
   * choose would be two routers, and the one nobody can see would win every time.
   */
  world(): Promise<World>
  /**
   * Ask every provider for its list again, if what is cached has aged out.
   *
   * Called when the Models table is opened, which is what makes the figures on it live
   * rather than as old as the last restart. It is safe to call on every draw because
   * `Catalog.refresh` declines anything younger than a day per provider — so this is a
   * cheap no-op almost always, and a fetch exactly when somebody is looking at stale
   * numbers. Nothing waits for it: the rows being returned are the cached ones, and the
   * fetch lands in time for the next open.
   */
  refresh(): void
  /**
   * Which conversation is on screen, and how to move to another (M8-2).
   *
   * A getter rather than a number, because this file outlives any one of them: the whole
   * point of the Chats tab is that the answer changes while it is open, and a number
   * captured when the surface was built would be the conversation that happened to be open
   * when Alexia started.
   */
  session(): number
  openSession(id: number): void
  /**
   * A conversation just ended, so anything held for it can be let go of.
   *
   * Optional, because this object is built in tests that have no plugins to tell.
   */
  ended?(): void
}

/** `▲` is the one mark that is coloured, because on this screen a colour means look at this. */
const OK = '● ready'

/** What a router row is labelled, in place of what it can do (D159). */
const ROUTER = (model: Model): string => (paid(model.tier) ? 'a different model each time' : 'a different free model each time')

const CHOSEN = MODEL_GROUPS.chosen
const LISTED = MODEL_GROUPS.listed
const AUTOMATIC = MODEL_GROUPS.automatic
const SET_ASIDE = MODEL_GROUPS.aside
const PAID = MODEL_GROUPS.paid

/** The set-aside group's order, most final reason first: a key or a retirement before a bad day. */
const ASIDE: readonly Aside[] = ['needs a key', 'retired', 'answers empty', 'always busy for you', 'not answering']

/** One model on one provider, as a row's id (D161). The detail and the row actions read both halves. */
const rowId = (provider: string, model: string): string => `${provider}\n${model}`

/** `31B, from its name` · `8.2B, reported` · `not said`. A size read from a name says so (D159). */
const sized = (model: Model): string => {
  const billions = sizeOf(model)
  if (billions === undefined) return 'not said'
  const shown = billions >= 10 ? String(Math.round(billions)) : String(Math.round(billions * 10) / 10)
  return `${shown}B, ${model.params === undefined ? 'from its name' : 'reported'}`
}

/** What each outcome in the record is called in a sentence about one model. */
const DID: Record<Outcome, string> = {
  answered: 'Answered',
  busy: 'Said it was too busy',
  slow: 'Did not answer in time',
  failed: 'Failed',
  unreachable: 'Could not be reached',
  empty: 'Answered with nothing',
  cut: 'Ran out of room before finishing',
  retired: 'Said it is no longer offered',
  'needs-key': 'Wanted a key',
  'no-credit': 'Had no credit to pay for it',
  'key-refused': 'Had its key refused',
  'too-long': 'Found the conversation too long',
  'bad-answer': 'Was marked a bad answer',
}

/**
 * **What Alexia has seen**, a sentence per kind of thing that happened (§4 C): how many times, and
 * when — *said it was too busy 4 times, from 18:10 to 21:40*. The record's own words, so the detail
 * and the tags above it are read from the same rows.
 */
const evidence = (tries: readonly Try[]): string[] => {
  if (tries.length === 0) return ['Nothing yet: it has not been asked on this machine in the last 30 days.']
  const kinds = new Map<Outcome, Try[]>()
  for (const one of tries) kinds.set(one.outcome, [...(kinds.get(one.outcome) ?? []), one])
  return [...kinds].map(([outcome, all]) => {
    const [earliest, latest] = [all[0]!, all.at(-1)!]
    return all.length === 1 ?
        `${DID[outcome]} once, ${when(earliest.at)}.`
      : `${DID[outcome]} ${String(all.length)} times, from ${when(earliest.at)} to ${when(latest.at)}.`
  })
}


/** `2026-08-29 14:03`, which is what a person reads. Never a raw timestamp. */
const when = (at: number): string => new Date(at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })

/** `128k`, which is what a person reads. Never 131072, and never a bare 0 for *not said*. */
const window = (tokens: number): string => (tokens > 0 ? `${String(Math.round(tokens / 1000))}k` : '—')

/**
 * The same, for a running total: `1.2M` once thousands stop meaning anything, and `392.0B` once
 * millions do — the world's weekly figure for a busy model is hundreds of billions, and it read
 * as `391965.2M` until the Models table put one in the first row (D164).
 */
const count = (n: number): string =>
  n === 0 ? '—'
  : n >= 1_000_000_000 ? `${(n / 1_000_000_000).toFixed(1)}B`
  : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
  : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k`
  : String(n)

/**
 * Dollars per million input tokens, or the word for what free means here.
 *
 * Zero is printed as *free* rather than `$0.00` because those are different claims: one is a
 * price and the other is the free tier this whole project is built on. A provider that does
 * not publish prices at all lands here as zero too — which is true of every free tier in the
 * table, and the column would rather say so than invent a number.
 */
const price = (usd: number): string => (usd === 0 ? 'free' : `$${usd.toFixed(2)}`)

/**
 * Which side of the price line a model is on — the one fact the ladder groups by (D112).
 *
 * `tier` is the authority rather than the price, because the two can disagree and the tier is
 * the thing every other rule in the router reads: `T2` and `T3` are billed to credit, `T0`
 * and `T1` are not. A `T2` a provider happens to publish at zero today is still a paid row,
 * and putting it in the free column would be the screen promising something the router does
 * not.
 */
const sideOf = (model: Model): 'free' | 'paid' => (model.tier === 'T2' || model.tier === 'T3' ? 'paid' : 'free')

/**
 * The three stops, left to right — the values the slider is allowed to send.
 *
 * Written here and not in `panels.ts` because this is the end that refuses one: a stop
 * declared on the screen that this list does not know about is a slider position that says
 * *“whatever” is not one of free, mixed, paid* when you press it, which is a control that
 * looks fine and does nothing. The two are held together by a test rather than by care.
 */
export const SPENDS: readonly Spend[] = ['free', 'mixed', 'paid']

export function sources(options: SurfaceOptions): Record<string, Source> {
  const { skills, tooling, plugins, trace, catalog, store } = options

  /**
   * A skill's own text, which is the only thing there is to show about one.
   *
   * The screen's reader rather than the model's: the same file, the same frontmatter
   * stripped, the same folder boundary — but it can open one that is still **waiting for a
   * person**, because reading it is how somebody decides whether to say yes (M6-9).
   */
  const skillText = (name: string): Promise<string> => Promise.resolve(skills.text(name))

  /**
   * **Why a model somebody named cannot be asked** (§1 step 4): its provider has no key any more.
   * Said on the row rather than by taking the row away — a pin and a list are the person's, and
   * a key removed is a key that may come back.
   */
  const unreachable = (provider: string): string => `not available — no key for ${nameOf(provider)}`

  /** A provider's name where a row has only its id. */
  const nameOf = (provider: string): string =>
    provider === OLLAMA.id ? 'this Mac' : (options.providers.find((one) => one.id === provider)?.name ?? provider)

  /** The provider row itself, for a model no plan holds — its name and whether it answers keyless. */
  const providerOf = (provider: string): Provider =>
    provider === OLLAMA.id ? OLLAMA : (options.providers.find((one) => one.id === provider) ?? { id: provider, name: provider, baseUrl: '' })

  /** *your key* · *no key* · *this Mac*: which rung of the ladder a choice stands on. */
  const access = (choice: Choice): string =>
    choice.model.tier === 'T0' ? 'this Mac'
    : (choice.keyed ?? !anonymous(choice.provider)) ? 'your key'
    : 'no key'

  /** The same, as a phrase: *on your OpenRouter key*. */
  const where = (choice: Choice): string =>
    choice.model.tier === 'T0' ? 'on this Mac'
    : access(choice) === 'your key' ? `on your ${nameOf(choice.provider.id)} key`
    : `on ${nameOf(choice.provider.id)} with no key`

  /** The first row of Automatic, which has no row above it to be explained against. */
  const first = (choice: Choice): string => {
    const size = sizeOf(choice.model)
    const facts = [
      where(choice),
      choice.model.supportsTools ? 'can use tools' : 'talks only',
      size === undefined ? '' : sized(choice.model).replace(/, .*$/, ''),
    ].filter(Boolean)
    return `First choice: the free model Alexia would ask first — ${facts.join(', ')}.`
  }

  /**
   * What brings a set-aside model back. **A test message is promised only where one can reach
   * it**: §4 E sends them to free models it can still ask (D166), never to a paid model and
   * never to this Mac's own, so those keep the plainer sentence rather than a promise nothing
   * will keep.
   */
  const back = (tested: boolean): string =>
    tested ?
      ' Alexia sends it a test message on its own, and one good reply brings it back.'
    : ' One good reply brings it back.'

  /** Why a model is set aside, and what brings it back. */
  const setAside = (reason: Aside, provider: string, tested: boolean): string =>
    reason === 'needs a key' ? `Set aside: ${nameOf(provider)} now wants a key for it. Back the moment you add one.`
    : reason === 'retired' ? `Set aside: ${nameOf(provider)} no longer offers it.`
    : reason === 'answers empty' ? `Set aside: it answered with nothing three times in a row.${back(tested)}`
    : reason === 'always busy for you' ? `Set aside: too busy every time for a whole day.${back(tested)}`
    : `Set aside: it timed out or failed every time for a whole day.${back(tested)}`

  return {
    /**
     * Every conversation, and which one you are in (M8-2).
     *
     * **The only core table whose rows are the product rather than a report about it.** The
     * other five say what Alexia has been doing; this one is what it was doing it about, and
     * pressing a row is the only way back into a conversation that has scrolled out of a
     * session.
     *
     * The title is the first thing the user said. Not a model-written summary: naming a
     * conversation is a model call on a screen that opens at the speed of a file read, and
     * *the one where I asked about the printer* is already on disk in the person's own words.
     */
    chats: {
      rows: () => {
        const open = options.session()
        return Promise.resolve(
          store.conversations().map((chat) => ({
            id: String(chat.id),
            title: chat.title,
            turns: String(chat.messages),
            when: when(chat.updatedAt),
            state: chat.id === open ? '● open' : '',
          })),
        )
      },
      /**
       * The conversation itself, which is the only thing there is to show about one — and
       * the reason it is capped: a detail row that expands to four hundred turns is a page
       * nobody can scroll past, and the way to read a whole conversation is to open it.
       */
      detail: (id) => {
        const said = store
          .history(Number(id))
          .filter((turn) => turn.role === 'user' || turn.role === 'assistant')
        const shown = said.slice(-12)
        const lines = shown.map((turn) => `${turn.role === 'user' ? 'You' : 'Alexia'}: ${turn.content}`)
        return Promise.resolve(
          said.length === 0 ? 'Nothing has been said in this one yet.'
          : (said.length > shown.length ? [`… ${String(said.length - shown.length)} earlier turns`, ...lines] : lines)
              .join('\n\n'),
        )
      },
    },

    /**
     * Every model any provider will admit to, and which one is being used (the Models tab).
     *
     * The catalog is the only source. Nothing here asks a provider anything: the lists are
     * fetched on the daily poll and cached, so this screen opens at the speed of a file read
     * whether or not the machine is online — the same rule the other four tables follow.
     *
     * **Only what you can actually reach.** A provider with no key contributes nothing here.
     *
     * This screen used to list everything and mark the unreachable rows *needs a key*, on
     * the argument that *what would connecting Groq get me* is a question worth answering.
     * It is — but not at this price: one key gets you four hundred models and six providers
     * you have never signed up to, so the answer arrived as eighty rows of noise wrapped
     * around the twenty that can answer a question today. A chooser whose contents you
     * cannot use is a catalogue, and nobody opens this tab to browse a catalogue.
     *
     * The question keeps its answer in the place that was always better for it: the settings
     * screen, where the keys are, listing every provider and what connecting one costs.
     */
    models: {
      /**
       * **The table is the ranking** (D161, `model_plan.md` §4 C). Every row is a place in a plan
       * `route()` made, in the order it made it, and the sentence under each is `explain()` on the
       * row above — so the screen cannot describe an order the router is not walking. It used to
       * sort with a comparator of its own and group by provider, and so had no order to read.
       *
       * Four groups: what the person chose (a pin, or a list), Automatic's free plan, what Alexia
       * has set aside, and the paid plan. A row is one model on one provider, keyed
       * `provider\nmodel`, because Kilo's copy of a model can be busy while OpenRouter's answers.
       */
      rows: async () => {
        // Opening the list is the signal that somebody wants it current. Deliberately not
        // awaited — a screen that blocked on seven providers would be a screen that opens
        // slowly on a bad connection to show numbers it already had.
        options.refresh()
        const standing = pins(store)
        const keyed = await options.connected()
        const world = await options.world()
        const spend = standing.spend ?? 'mixed'
        const unpinned = { ...standing, model: undefined, order: undefined }
        const plain = { messages: [] }
        /** Automatic's comparator and its sentences, the same way round `route()` sorted. */
        const ranked = ranking(world, standing.prefer === 'best' ? 'best' : 'cheap')
        /**
         * The ★: what the router would ask first for a request carrying tools, which is the shape
         * Alexia's own loop sends — the first of the person's list when there is one (D155).
         */
        const tools = route({ messages: [], tools: [{ name: 'a_tool' }] }, { ...standing, model: undefined }, world)
        const star = tools.ok ? tools.choices[0] : undefined
        const answered = new Map<string, number>()
        for (const one of store.tries()) {
          if (one.outcome === 'answered') answered.set(rowId(one.provider, one.model), (answered.get(rowId(one.provider, one.model)) ?? 0) + 1)
        }

        const out: Row[] = []
        const push = (choice: Choice, group: string, place: number, note: string): void => {
          const { model, provider } = choice
          const id = rowId(provider.id, model.id)
          const judged = world.health?.get(id)
          const chosen = model.id === standing.model
          const starred = star !== undefined && star.provider.id === provider.id && star.model.id === model.id
          const reachable = model.tier === 'T0' || keyed.has(provider.id)
          out.push({
            id,
            group,
            rank: `${chosen && group === CHOSEN ? '◆ ' : starred ? '★ ' : ''}${String(place)}`,
            name: model.name,
            provider: provider.id,
            via: `${model.tier === 'T0' ? 'this Mac' : nameOf(provider.id)} · ${access(choice)}`,
            note,
            size: sized(model),
            can: [
              model.supportsTools ? 'tools' : 'talk only',
              model.modality.includes('image') ? 'pictures' : '',
              model.context > 0 ? `reads ${window(model.context)}` : '',
            ]
              .filter(Boolean)
              .join(' · '),
            week: model.weekly === undefined ? '—' : `${count(model.weekly)}${model.weeklyFrom === undefined ? '' : ` via ${nameOf(model.weeklyFrom)}`}`,
            answered: String(answered.get(id) ?? 0),
            price: price(model.priceIn),
            tier: model.tier,
            tags: judged?.tags ?? [],
            /**
             * What the rail reads: `◆` is the chosen mark and `★` the router's own answer. The
             * rest say what a row can do, in the marks every core table already speaks in.
             */
            state:
              chosen ? `◆ everything goes here${reachable ? '' : ` · ${unreachable(provider.id)}`}`
              : starred ? '★ recommended'
              : judged?.aside !== undefined ? `■ set aside · ${judged.aside}`
                // A router says so in place of tools: what it can do is whatever it picks (D159).
              : routes(model) ? `${OK} · ${ROUTER(model)}`
              : model.supportsTools ? `${OK} · tools`
              : `${OK} · text only`,
          })
        }
        /** A model the person named that no plan holds, with the reason — never dropped (D155). */
        const missing = (id: string): { choice: Choice; why: string } | undefined => {
          const copies = [...world.models, ...world.local].filter((model) => model.id === id)
          const model = copies.find((one) => one.tier === 'T0' || keyed.has(one.provider)) ?? copies[0]
          if (model === undefined) return undefined
          const choice = { model, provider: providerOf(model.provider) }
          const aside = world.health?.get(rowId(model.provider, model.id))?.aside
          const why =
            model.tier !== 'T0' && !keyed.has(model.provider) ? unreachable(model.provider)
            : aside !== undefined ? `not available — set aside: ${aside}`
            : 'not available for a request like this, or on this side of the price line'
          return { choice, why }
        }

        // Your choice: a pin is one model and never falls back (D155).
        if (standing.model !== undefined) {
          const pinned = route(plain, standing, world)
          if (pinned.ok && pinned.choices[0] !== undefined) {
            push(pinned.choices[0], CHOSEN, 1, 'Your choice: every request goes to it, and if it cannot answer, Alexia stops and says why.')
          } else {
            const gone = missing(standing.model)
            if (gone !== undefined) push(gone.choice, CHOSEN, 1, `Your choice, ${gone.why}.`)
          }
        }

        // Your list: the plan a sequence makes, then any entry it could not hold.
        const listed = standing.order ?? []
        if (listed.length > 0) {
          const plan = route(plain, { ...standing, model: undefined }, world)
          const planned = plan.ok ? plan.choices : []
          planned.forEach((choice, at) => {
            const number = listed.indexOf(choice.model.id) + 1
            const before = planned.slice(0, at).filter((one) => one.model.id === choice.model.id).at(-1)
            push(
              choice,
              LISTED,
              at + 1,
              before === undefined ?
                `Number ${String(number)} in your list, ${where(choice)}.`
              : `Number ${String(number)} in your list again, ${where(choice)}: asked only if ${nameOf(before.provider.id)}'s copy fails.`,
            )
          })
          let place = planned.length
          for (const [at, id] of listed.entries()) {
            if (planned.some((one) => one.model.id === id)) continue
            const gone = missing(id)
            if (gone !== undefined) push(gone.choice, LISTED, ++place, `Number ${String(at + 1)} in your list, ${gone.why}.`)
          }
        }

        // Automatic, free: the order Automatic walks for a plain request.
        const shown = new Set<string>()
        if (spend !== 'paid') {
          const free = route(plain, { ...unpinned, spend: 'free' }, world)
          const choices = free.ok ? free.choices : []
          choices.forEach((choice, at) => {
            shown.add(rowId(choice.provider.id, choice.model.id))
            const above = choices[at - 1]
            push(choice, AUTOMATIC, at + 1, above === undefined ? first(choice) : ranked.explain(choice, above))
          })
        }

        // Paid: Automatic's order under *paid only* — tools first, then cheapest.
        const paidRows: Row[] = []
        if (spend !== 'free') {
          const priced = route(plain, { ...unpinned, spend: 'paid' }, world)
          const choices = priced.ok ? priced.choices : []
          const mark = out.length
          choices.forEach((choice, at) => {
            shown.add(rowId(choice.provider.id, choice.model.id))
            const above = choices[at - 1]
            push(
              choice,
              PAID,
              at + 1,
              above === undefined ?
                `The first paid model Alexia would ask: ${where(choice)}, ${price(choice.model.priceIn)} per million tokens in.`
              : ranked.explain(choice, above),
            )
          })
          paidRows.push(...out.splice(mark))
        }

        // Set aside by Alexia: reachable, and in no plan above because of it. By reason, then name.
        const aside = [...world.models, ...world.local]
          .filter(
            (model) =>
              (model.tier === 'T0' ||
                available(model, keyed, spend, new Set(world.rungs.filter((rung) => rung.funded === false).map((rung) => rung.provider.id)))) &&
              !shown.has(rowId(model.provider, model.id)),
          )
          .flatMap((model) => {
            const reason = world.health?.get(rowId(model.provider, model.id))?.aside
            return reason === undefined ? [] : [{ model, reason }]
          })
          .sort((a, b) => ASIDE.indexOf(a.reason) - ASIDE.indexOf(b.reason) || a.model.name.localeCompare(b.model.name))
        aside.forEach(({ model, reason }, at) => {
          const choice = { model, provider: providerOf(model.provider) }
          push(choice, SET_ASIDE, at + 1, setAside(reason, model.provider, !paid(model.tier) && model.tier !== 'T0'))
        })

        return [...out, ...paidRows]
      },
      note: () => options.news?.(),
      detail: async (id) => {
        const [providerId, modelId] = id.includes('\n') ? (id.split('\n', 2) as [string, string]) : [undefined, id]
        const world = await options.world()
        const model = [...world.models, ...world.local].find(
          (one) => one.id === modelId && (providerId === undefined || one.provider === providerId),
        )
        if (!model) return 'That model is not in the catalog any more.'
        const keyed = await options.connected()
        const key = rowId(model.provider, model.id)
        const tags = world.health?.get(key)?.tags ?? []
        return (
          [
            `${model.name} on ${model.tier === 'T0' ? 'this Mac' : nameOf(model.provider)}`,
            model.id,
            '',
            'What Alexia has seen here in the last 30 days:',
            ...evidence(store.tries().filter((one) => rowId(one.provider, one.model) === key)),
            '',
            `What Alexia thinks: ${tags.length === 0 ? 'nothing to say yet.' : `${tags.map((tag) => tag.says).join(', ')}.`}`,
            '',
            `${model.tier} · ${price(model.priceIn)} in, ${price(model.priceOut)} out, per million tokens`,
            `Context: ${window(model.context)} · takes ${model.modality.join(', ')}`,
            `Tools: ${model.supportsTools ? 'yes' : 'not according to its provider'}`,
            ...(routes(model) ?
              [`A router: ${ROUTER(model)}, chosen by ${model.provider}. Automatic asks it after every single model.`]
            : []),
            model.weekly === undefined ?
              `${model.provider} does not publish how much its models are used.`
            : model.weeklyFrom !== undefined ?
              `${count(model.weekly)} tokens through this model last week on ${model.weeklyFrom}, which publishes the figure ${model.provider} does not.`
            : `${count(model.weekly)} tokens through this model last week, across everyone using ${model.provider}.`,
            // The two flags nobody may guess at. Both say `unknown` until a person has read
            // the provider's terms, and the screen repeats that rather than rounding it off.
            `Trains on what you send it: ${model.trainsOnYourData}`,
            `Uncensored: ${model.nsfwOk}`,
            ...(model.tier === 'T0' || keyed.has(model.provider) ? [] : ['', `Add a key for ${model.provider} in settings to use this.`]),
          ].join('\n')
        )
      },
    },

    /**
     * The ladder: what may answer, and in what order (D112, the Models tab).
     *
     * **The same rows the table above it draws**, cut to what a running order is about — a
     * name, what it costs, and which side of the price line it is on. It is a separate read
     * rather than a flag on the table's rows because the two answer different questions:
     * the table is *what exists*, and this is *what I said*, which is a list of five things
     * on a machine where four hundred exist.
     *
     * `rank` is the position in the user's own shortlist, or empty for everything that is
     * not in it. Everything is returned either way: the unlisted rows are what the search
     * box adds from, and a picker whose contents are a second fetch is a picker that is
     * empty for the first half-second somebody uses it.
     */
    routing: {
      rows: async () => {
        const standing = pins(store)
        const keyed = await options.connected()
        const listed = standing.order ?? []
        /**
         * What can be asked, and — only for what the person's list names — what cannot any more.
         *
         * The ladder used to be given connected rows alone and dropped every order entry it could
         * not find, then saved what it was showing on the next drag: removing a key quietly
         * deleted that provider's models from the person's list. A model another connected
         * provider still serves is reachable and is not repeated here.
         */
        const reachable = new Set(catalog.models.filter((model) => keyed.has(model.provider)).map((model) => model.id))
        const lost = new Set<string>()
        return catalog.models
          .filter((model) => {
            if (keyed.has(model.provider)) return true
            if (!listed.includes(model.id) || reachable.has(model.id) || lost.has(model.id)) return false
            lost.add(model.id)
            return true
          })
          .map((model) => ({
            id: model.id,
            name: model.name,
            provider: model.provider,
            price: price(model.priceIn),
            side: sideOf(model),
            // A number a person counts from, not an array index. Empty is *not on the list*,
            // which is the ordinary state of almost every row here.
            rank: listed.indexOf(model.id) === -1 ? '' : String(listed.indexOf(model.id) + 1),
            tools: model.supportsTools ? 'tools' : 'text only',
            // Empty for everything that can be asked; the reason, for a listed model that cannot.
            off: keyed.has(model.provider) ? '' : unreachable(model.provider),
          }))
          .sort(
            (a, b) =>
              (a.rank === '' ? Number.MAX_SAFE_INTEGER : Number(a.rank)) -
                (b.rank === '' ? Number.MAX_SAFE_INTEGER : Number(b.rank)) || a.name.localeCompare(b.name),
          )
      },
    },

    activity: {
      rows: () =>
        Promise.resolve(
          trace.runs.map((run) => ({
            id: run.id,
            // Their own words, cut rather than summarised — a paraphrase of what somebody
            // asked for is the one thing that makes a run hard to find again.
            task: run.task.length > 90 ? `${run.task.slice(0, 90)}…` : run.task,
            steps: run.steps.length,
            // Four places, because a free run is $0.0000 and a cheap one is $0.0003, and
            // rounding the second to the first is how a ledger stops being believed.
            cost: run.ended === undefined ? '—' : `$${spentOn(run).toFixed(4)}`,
            ended: run.ended ?? 'still going',
            when: when(run.at),
          })),
        ),
      // The whole run, untrimmed, and the same text `export` writes. One renderer, so what
      // somebody reads on screen is exactly what they send on.
      detail: (id) => {
        const run = trace.one(id)
        return Promise.resolve(run === undefined ? 'That run has gone. They are kept in memory only.' : asText(run))
      },
    },

    skills: {
      rows: () =>
        Promise.resolve([
          // The broken ones first and marked, because *this folder is here and is doing
          // nothing* is the sentence somebody opened this screen to find.
          ...skills.problems.map((problem) => ({
            id: problem.dir,
            name: problem.dir.split(/[\\/]/).pop() ?? problem.dir,
            where: 'a folder',
            state: `▲ ${problem.reason}`,
          })),
          ...skills.all
            .filter((skill) => skill.learned !== true)
            .map((skill) => ({
              id: skill.name,
              name: skill.name,
              // A bundled skill says whose it is, which is also why it has no separate
              // delete: it arrived with something and it goes when that does.
              where:
                skill.pluginId !== undefined ? `with ${skill.pluginId}`
                  // Where it came from, never guessed. A folder that appeared with nothing
                  // written about it is *unknown*, which is a fact and not a shrug (M6-9).
                : skill.provenance === 'installed' ? 'from the marketplace'
                : skill.provenance === 'unknown' ? 'unknown'
                : 'installed here',
              state: skill.live === false ? '▲ waiting for you' : OK,
            })),
        ]),
      detail: skillText,
    },

    learned: {
      rows: () =>
        Promise.resolve(
          skills.all
            .filter((skill) => skill.learned === true)
            .map((skill) => ({
              id: skill.name,
              name: skill.name,
              // Absent is shown as absent. A skill written before this was recorded cannot
              // have it recovered, and guessing at it would be worse than the blank.
              from: skill.learnedFrom ?? 'not recorded',
              when: skill.learnedAt ?? '—',
              // A model wrote it, after a task, about what it thinks it just learned. Until
              // somebody says yes it is not in the index and cannot be read (M6-9, D84).
              state: skill.live === false ? '▲ waiting for you' : OK,
            })),
        ),
      detail: skillText,
    },

    tools: {
      rows: async () =>
        Promise.all(
          (await tooling.list()).map(async (tool) => {
            // `plugin__tool`, which is how a tool reaches the model. Split back apart here so
            // the grouping is by whoever offers it — core never wrote any of these names down.
            const [owner, ...rest] = tool.name.split('__')
            const bare = rest.join('__')
            const declared = (await tooling.about(tool.name))?.annotations
            return {
              id: tool.name,
              name: bare === '' ? tool.name : bare,
              plugin: bare === '' ? 'Alexia' : owner!,
              // **What the permission gate will do with it**, which is the only thing on this
              // screen worth a column. Read from the same annotations `rule()` reads, and
              // silence is reported as silence — a tool that declared nothing has not said it
              // is safe, and the gate treats it accordingly.
              kind:
                declared?.destructiveHint === true ? 'changes things'
                : declared?.readOnlyHint === true ? 'reads only'
                : 'not declared',
            }
          }),
        ),
      detail: async (id) => {
        const found = (await tooling.list()).find((tool) => tool.name === id)
        // The description is prompt text: it is what the model reads when it decides to
        // reach for this, so it is shown verbatim rather than summarised.
        return found?.description ?? 'That tool is not offered any more.'
      },
    },

    library: {
      rows: () =>
        Promise.resolve([
          ...plugins.problems.map((problem) => ({
            id: problem.dir,
            name: problem.dir.split(/[\\/]/).pop() ?? problem.dir,
            version: '—',
            state: `▲ ${problem.reason}`,
          })),
          ...plugins.ids.flatMap((id) => {
            const manifest = plugins.manifest(id)
            if (!manifest) return []
            return [
              {
                id,
                name: manifest.name,
                version: manifest.version,
                state:
                  !plugins.enabled(id) ? '■ not enabled'
                  : plugins.running(id) ? OK
                  : '● enabled',
              },
            ]
          }),
        ]),
      detail: (id) => {
        const manifest = plugins.manifest(id)
        if (!manifest) return Promise.resolve('That plugin is not installed any more.')
        // The author's own sentences, verbatim. This is what a person reads when deciding
        // whether to keep something, so core never rewrites it and never summarises it.
        const asked = (manifest.requires ?? []).map((one) => `- ${one.cap} — ${one.why}`)
        return Promise.resolve(
          [manifest.summary, '', `${manifest.version} · ${manifest.license}`, ...(asked.length > 0 ? ['', 'It asked for:', ...asked] : [])].join(
            '\n',
          ),
        )
      },
    },
  }
}

/**
 * Everything the palette can find, over the same reads the panels use (M6-10).
 *
 * **No second index.** These are the rows the tables themselves show, asked for the same way,
 * so a skill that has just been forgotten is gone from the palette by the act that removed
 * it and nothing has to be told twice.
 *
 * A plugin contributes its **name** and not its contents — through `library` below, which is
 * the list its own page is drawn from since D118. Reaching inside a plugin means a tool call,
 * and a palette that spawned every installed one on every keystroke would be a search box
 * with a startup cost, which is the opposite of what Ctrl+K is for.
 */
export async function searchable(
  options: SurfaceOptions,
  tabs: readonly { id: string; label: string }[],
): Promise<Searchable[]> {
  const ours = sources(options)
  const found: Searchable[] = tabs.map((tab) => ({ tab: tab.id, kind: 'panel', label: tab.label }))

  /** Which table each row comes from, and what to call one of its rows on screen. */
  const lists: [string, string, string, (row: Row) => string][] = [
    ['activity', 'activity', 'run', (row) => String(row.task)],
    ['skills', 'skills', 'skill', (row) => String(row.name)],
    ['skills', 'learned', 'learned skill', (row) => String(row.name)],
    ['tools', 'tools', 'tool', (row) => String(row.name)],
    // Not a control tab: plugins live on the settings screen (M8-3), and the shell routes
    // this one word there. Since D118 that page holds a plugin's panel too, so this row is
    // the only one a plugin needs — there is no second place to send anybody.
    ['plugins', 'library', 'plugin', (row) => String(row.name)],
  ]
  for (const [tab, key, kind, label] of lists) {
    const source = ours[key]
    if (!source) continue
    for (const row of await source.rows()) {
      const detail = [row.from, row.plugin, row.where, row.state].filter((one) => typeof one === 'string').join(' · ')
      found.push({ tab, kind, label: label(row), ...(detail !== '' && { detail }) })
    }
  }
  return found
}

/**
 * A row action on one of core's own tables.
 *
 * There is exactly one, and that is the finding rather than an omission — see D87. Forgetting
 * a skill is the reason a person opens this screen: *it learned something wrong a week ago*.
 * Editing one stayed where M4-5 put it, beside the attribution line at the moment it fires,
 * because an editor is bespoke rendering and bespoke rendering is what M6-4 was watching for.
 */
export function actions(
  options: SurfaceOptions,
): Record<string, (id: string) => Promise<{ ok: boolean; said: string }>> {
  /**
   * *Yes* to a skill that is waiting (M6-9).
   *
   * The other end of the ladder, and the only place a person grants one: a skill nobody has
   * said yes to is not in the model's index and cannot be read by it.
   */
  /**
   * A new conversation, and moving between them (M8-2).
   *
   * **Nothing is ever appended to a conversation you are not in**, which is the whole reason
   * the open one is a variable in `serve.ts` rather than something each request carries: a
   * task started before a switch finishes into the conversation it was started in, because
   * that is the one the person watched it happen in.
   *
   * An empty conversation is reused rather than stacked. Pressing New twice in a row on a
   * screen that has not been typed into would otherwise leave a row of identical empty
   * chats, and the second press means the same thing as the first.
   */
  const newChat = (): Promise<{ ok: boolean; said: string }> => {
    const open = options.session()
    const empty = options.store.conversations().find((chat) => chat.messages === 0)
    if (empty?.id === open) {
      return Promise.resolve({ ok: true, said: 'You are already in a new chat — nothing has been said in this one.' })
    }
    options.openSession(empty?.id ?? options.store.createSession())
    // **Whatever anybody was holding for the last conversation, they can let go of now.** Here
    // rather than in either caller, because this is the one place both the button and `/new`
    // pass through — and below the early return above, so pressing New twice does not announce
    // an ending that did not happen. Nothing waits for it and no plugin is named.
    options.ended?.()
    // Said the same way wherever it was asked for: this is the Chats screen's button and
    // also `/new`, typed into the conversation it is about to replace, where *press Back*
    // would be an instruction to leave a screen nobody is on.
    return Promise.resolve({ ok: true, said: 'Started a new chat. Anything you say now goes into it.' })
  }

  const openChat = (id: string): Promise<{ ok: boolean; said: string }> => {
    const chat = options.store.conversations().find((one) => String(one.id) === id)
    if (!chat) return Promise.resolve({ ok: false, said: 'There is no conversation with that id.' })
    options.openSession(chat.id)
    return Promise.resolve({ ok: true, said: `Open: “${chat.title}”. Press Back and it is on screen.` })
  }

  /**
   * Forgetting one, and the one rule that makes it safe: **you cannot delete the conversation
   * you are in.** The messages go by `ON DELETE CASCADE`, so deleting the open one would
   * leave every later append pointing at a session row that is not there.
   */
  const forgetChat = (id: string): Promise<{ ok: boolean; said: string }> => {
    const chat = options.store.conversations().find((one) => String(one.id) === id)
    if (!chat) return Promise.resolve({ ok: false, said: 'There is no conversation with that id.' })
    if (chat.id === options.session()) {
      return Promise.resolve({
        ok: false,
        said: 'That is the conversation you are in. Open another one first, or press New chat.',
      })
    }
    options.store.deleteSession(chat.id)
    return Promise.resolve({ ok: true, said: `“${chat.title}” is gone, and everything said in it.` })
  }

  const allowSkill = (name: string): Promise<{ ok: boolean; said: string }> => {
    const skill = options.skills.all.find((one) => one.name === name)
    if (!skill) return Promise.resolve({ ok: false, said: `There is no skill called ${name}.` })
    if (skill.live !== false) return Promise.resolve({ ok: true, said: `${name} was already allowed.` })
    allow(options.store, name)
    options.skills.invalidate()
    return Promise.resolve({ ok: true, said: `${name} is live. Alexia can use it now.` })
  }

  const forgetSkill = (name: string): Promise<{ ok: boolean; said: string }> => {
    const skill = options.skills.all.find((one) => one.name === name)
    if (skill?.pluginId !== undefined) {
      return Promise.resolve({
        ok: false,
        said: `${name} came with ${skill.pluginId}. It goes when that does — delete the plugin, or disable it.`,
      })
    }
    const gone = forget(options.skillsDir, name)
    // What was said about it goes with it, so a folder that turns up under that name
    // tomorrow is a folder nobody has said yes to (M6-9).
    if (gone) forgetConsent(options.store, name)
    options.skills.invalidate()
    return Promise.resolve(
      gone ?
        { ok: true, said: `Forgotten. ${name} is gone.` }
      : { ok: false, said: `There is no skill called ${name}.` },
    )
  }

  /**
   * *Use this one, and stop choosing for me* — the Models tab's whole purpose.
   *
   * It writes `pins.model`, which the router already treats as final: a named model wins
   * outright, past the tier ladder and past a content flag nobody has verified. That branch
   * was written for a slash command that does not exist yet and had no way to be reached.
   * This is the way to reach it, and it adds no second notion of *chosen*.
   *
   * A model whose provider has no key is refused **here**, with the sentence naming what to
   * do. The router would refuse it too, but three screens later and as *is not available
   * right now*, which is true and useless.
   */
  const useModel = async (row: string): Promise<{ ok: boolean; said: string }> => {
    // A Models row is one model on one provider (D161); a pin is the model, and which of its
    // providers answers is the router's to pick, key first (D159). A bare id still works.
    const [provider, id] = row.includes('\n') ? (row.split('\n', 2) as [string, string]) : [undefined, row]
    const model =
      options.catalog.models.find((one) => one.id === id && (provider === undefined || one.provider === provider)) ??
      options.catalog.models.find((one) => one.id === id)
    if (!model) return { ok: false, said: 'That model is not in the catalog any more.' }
    if (!(await options.connected()).has(model.provider)) {
      return {
        ok: false,
        said: `${model.name} comes from ${model.provider}, which has no key yet. Add one in settings and try again.`,
      }
    }
    setPin(options.store, { model: id })
    return {
      ok: true,
      // One model never falls back (D155), and the moment somebody chooses one is the moment
      // to say so — not the evening it is rate-limited.
      said: `Every request now goes to ${model.name}. If it cannot answer, Alexia stops and says why rather than asking another model. Press Automatic on any row to hand the choice back.`,
    }
  }

  /**
   * The slider (D112). Three stops, and the middle one is what Automatic always did.
   *
   * It writes a pin like every other axis does, so there is no second notion of *which
   * models may answer* — the router reads one list of pins, and the ★ on the table below
   * moves because it is defined as what the router would pick.
   */
  const setSpend = (choice: string): Promise<{ ok: boolean; said: string }> => {
    if (!(SPENDS as readonly string[]).includes(choice)) {
      return Promise.resolve({ ok: false, said: `“${choice}” is not one of ${SPENDS.join(', ')}.` })
    }
    setPin(options.store, { spend: choice as Spend })
    return Promise.resolve({
      ok: true,
      said:
        choice === 'free' ?
          'Free only. Nothing that costs money will be asked, and if every free model is busy Alexia says so rather than reaching for a bill.'
        : choice === 'paid' ?
          'Paid only. Every request is billed to the provider you connected, and the free tiers are left alone.'
        : 'Free first, then paid. The free models answer until they are rate-limited or too small, and Alexia says one line before the first charge.',
    })
  }

  /**
   * The running order, dragged rather than numbered.
   *
   * One string of ids rather than a move-up call per row: a reorder is one thing a person
   * did, and sending it as four separate swaps is four chances to end up somewhere nobody
   * asked for if one of them is dropped. Empty clears it, which is the *reset* button.
   *
   * **Unknown ids are dropped rather than refused.** A model that left the catalog since the
   * screen was drawn would otherwise make the whole list unsaveable, with a sentence about a
   * row the person cannot see.
   *
   * **A list with anything in it is the whole plan** (D155), so the reply says that rather
   * than D112's *everything else still answers, behind them*, which is no longer true.
   */
  const setOrder = (list: string): Promise<{ ok: boolean; said: string }> => {
    const wanted = list.split(',').map((one) => one.trim()).filter((one) => one !== '')
    const known = new Set(options.catalog.models.map((model) => model.id))
    const order = wanted.filter((id) => known.has(id))
    setPin(options.store, { order })
    return Promise.resolve({
      ok: true,
      said:
        order.length === 0 ?
          'Order cleared, which is Automatic: every model the slider allows can answer, and when one fails the next one does.'
        : `${String(order.length)} in your own order, and only ${order.length === 1 ? 'that one answers' : 'these answer'}. If ${order.length === 1 ? 'it fails' : 'the last one fails too'}, Alexia stops and says why, and offers Automatic for that answer.`,
    })
  }

  /**
   * **The paid switch** (§4 H): `on:1.50` turns it on with that daily amount, `off` turns it off.
   *
   * The amount **is** the daily allowance, `caps.daily`, which already existed and was $0 by
   * default — so turning the switch on alone would have bought nothing. One money setting, not two.
   * Off keeps the amount: it still bounds what *Allow* can spend in a conversation.
   */
  const setCross = (value: string): Promise<{ ok: boolean; said: string }> => {
    const standing = caps(options.store)
    if (value === 'off') {
      setCaps(options.store, { ...standing, cross: false })
      return Promise.resolve({
        ok: true,
        said: 'Off. When the free models are done, the work pauses and asks before a paid model is used.',
      })
    }
    const amount = Number(/^on:(.*)$/.exec(value)?.[1] ?? Number.NaN)
    if (!Number.isFinite(amount) || amount <= 0) {
      return Promise.resolve({ ok: false, said: 'Say how much a day paid models may spend — a number above $0.' })
    }
    const daily = Math.round(amount * 100) / 100
    setCaps(options.store, { ...standing, cross: true, daily })
    return Promise.resolve({
      ok: true,
      said: `On. Paid models will be used once the free ones are done, up to $${daily.toFixed(2)} a day.`,
    })
  }

  /**
   * **The keyless floor's switch** (D154, §1 step 2): whether providers that answer without a
   * key may be asked at all.
   *
   * On by default — a fresh install has nothing else — and off for somebody who would rather
   * nothing left this machine for a provider they never signed up to. It says how many models
   * went or came back, because the count is the whole visible effect and the table behind the
   * switch may not be on screen.
   */
  const setKeyless = async (value: string): Promise<{ ok: boolean; said: string }> => {
    const on = value !== 'off'
    setKeylessOn(options.store, on)
    if (!on) {
      return { ok: true, said: 'Off. Only providers you added a key for are asked. Nothing was deleted, and the switch puts them back.' }
    }
    const world = await options.world()
    const floor = new Set(world.rungs.filter((rung) => rung.keyed !== true).map((rung) => rung.provider.id))
    const models = world.models.filter((model) => floor.has(model.provider)).length
    return {
      ok: true,
      said:
        floor.size === 0 ?
          'On. Providers that answer without a key may be asked again.'
        : `On. ${String(models)} model${models === 1 ? '' : 's'} from ${String(floor.size)} provider${floor.size === 1 ? '' : 's'} that need no key are back.`,
    }
  }

  return {
    new_chat: newChat,
    open_chat: openChat,
    forget_chat: forgetChat,
    use_model: useModel,
    set_spend: setSpend,
    set_order: setOrder,
    set_cross: setCross,
    set_keyless: setKeyless,
    /**
     * Back to the router choosing. On every row rather than only the pinned one, because a
     * button that appears and disappears as the selection moves is a button people hunt for
     * — and *stop pinning* means the same thing pressed anywhere.
     */
    automatic: () => {
      const { model: had, order = [] } = pins(options.store)
      setPin(options.store, { model: undefined })
      // The list above the table is a choice of its own, and this button does not clear it —
      // so while it has anything in it, *automatic* would be the wrong word (D155).
      const listed = order.length > 0
      return Promise.resolve({
        ok: true,
        said:
          listed ?
            `No model is pinned. Your own order of ${String(order.length)} still decides which models answer — clear it above for Automatic.`
          : had === undefined ? 'Already automatic — no model is pinned, so each request goes to the cheapest one that fits it.'
          : 'Back to automatic. Each request goes to the cheapest model that fits it, and no model is pinned.',
      })
    },

    /**
     * One run, written where a person can attach it to something (M6-5).
     *
     * A file rather than the clipboard, because the sentence this exists for is *send it to
     * somebody* — and because a page cannot hand a viewer a file without the shell's help,
     * while core writing one is three lines. The path is the answer.
     */
    export_run: (id) => {
      const run = options.trace.one(id)
      if (!run) return Promise.resolve({ ok: false, said: 'That run has gone. They are kept in memory only.' })
      const dir = join(options.dataDir, 'exports')
      const path = join(dir, `run-${new Date(run.at).toISOString().replace(/[:.]/g, '-')}.md`)
      try {
        mkdirSync(dir, { recursive: true })
        writeFileSync(path, asText(run))
        return Promise.resolve({ ok: true, said: `Written to ${path}` })
      } catch (error) {
        return Promise.resolve({ ok: false, said: `Could not write it: ${error instanceof Error ? error.message : String(error)}` })
      }
    },

    allow_skill: allowSkill,
    forget_skill: forgetSkill,
    // The learned list is a second table on the same screen, and a row action is looked up
    // by key — so two keys reaching the same two operations, rather than one key with two
    // possible meanings.
    allow_here: allowSkill,
    forget_here: forgetSkill,
  }
}
