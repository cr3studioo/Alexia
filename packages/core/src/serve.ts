// SPDX-License-Identifier: AGPL-3.0-only
import { APP_VERSION, CORE_CAPABILITIES, FILES_META, LENGTHS_META, TOOLS_META } from '@alexia/protocol'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import type { CreateMessageResult } from '@modelcontextprotocol/client'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, sep } from 'node:path'
import { run, said, type Produced } from './agent.js'
import {
  discard,
  MOST_FILES,
  MOST_PER_FILE,
  MOST_TOGETHER,
  noteFor,
  receive,
  typedOf,
  withDocuments,
  type Reading,
  type Saved,
  type Upload,
} from './attach.js'
import { Catalog, news, POLL_EVERY, type Change } from './catalog.js'
import { asRuling, counted, freshTally, ModelChecker, type Tally } from './checker.js'
import { commands, pins, type Ran, run as runCommand } from './commands.js'
import { preauthorise, record } from './consent.js'
import { refuse, type Body } from './guard.js'
import { judge } from './health.js'
import { Library, offerable } from './library.js'
import { distil, forget, learnable, outline, save, type Episode } from './learned.js'
import { mimeOf, Offers, openable, reach } from './offered.js'
import { installed, OLLAMA, running } from './ollama.js'
import { accountKey, fundedBy, keylessOn, usable, type Account } from './pool.js'
import { ceilings, estimate, previewLine, setCeilings, worthAsking, type Ceilings } from './preview.js'
import { Plugins } from './plugins.js'
import {
  boundaryAck,
  DEFAULT_MODE,
  heard,
  lifts,
  MODE_LABELS,
  pathsIn,
  rootsOf,
  rule,
  type Boundary,
  type Mode,
  type Ruling,
  type Scope,
} from './permissions.js'
import { anonymous, keyOf, PROVIDERS, type Provider } from './provider.js'
import { redactSecrets } from './redact.js'
import {
  allowed,
  hearingPlan,
  MODES,
  paid,
  personalityFrom,
  route,
  send,
  shapeOf,
  sizedFor,
  sizeFor,
  wantsCapable,
  type Bubble,
  type Choice,
  type Personality,
  type Size,
  type Tier,
} from './router.js'
import { CORE, keychain, type SecretStore } from './secrets.js'
// For `boot.mjs`, which imports the bundle this file is the entry of and nothing else (D153).
export { fromShell } from './secrets.js'
import { addServer, markReviewed, unreviewed } from './servers.js'
import { declaredAction, declaredTable } from './settings.js'
import { search } from './palette.js'
import { tabs as coreTabs } from './panels.js'
import { actions as coreActions, sources as coreSources, searchable } from './surface.js'
import { Skills, SKILL_TOOL } from './skills.js'
import { dataDir, Store, textOf, type Message, type Part } from './store.js'
import { PluginTooling } from './tooling.js'
import { Trace } from './trace.js'
import { trial } from './trial.js'
import { Uptime, watched } from './uptime.js'
import { allowance, caps, costOf, setCaps, today, warning } from './usage.js'

/**
 * The chat shell's other half: a loopback bridge between a webview and core.
 *
 * The shell is a web page with no Node in it (invariant 6), so something has to carry a
 * message across. At M5 that is Tauri's IPC; today it is `node:http` on 127.0.0.1, which
 * means the shell can be opened in a browser and used *now* — and the M5 port replaces this
 * file rather than the shell.
 *
 * It is a local server that spends money and holds a conversation, so it is not open to
 * whatever else is on the machine: a token minted at startup and injected into the page,
 * required on every call, and the `Host` header checked so a name resolving to 127.0.0.1
 * cannot be used to reach it from a web page.
 */

/**
 * One finished exchange, in the shape the capture capability takes it (M7-3).
 *
 * **Credentials never make the trip.** The same scan the router runs on the way out (M7-1),
 * on the other door — because a key pasted into a conversation is the one thing that must be
 * in neither a payload nor a memory, and a plugin that never sees it cannot leak it.
 *
 * **Location is deliberately not stripped.** What may be *written down* is not what may be
 * *sent*: where somebody lives is worth remembering and only dangerous when it leaves, and a
 * memory that could not hold an address would be a worse memory for no gain. That asymmetry
 * is the same one `SecretStore` already draws between storing and transmitting.
 *
 * Its own function so it is a thing that can be tested rather than an argument list buried
 * in a handler — this is the one place core hands a conversation to a plugin.
 */
export function exchange(said: string, answered: string, at: number = Date.now()): Record<string, unknown> {
  return { said: redactSecrets(said).text, answered: redactSecrets(answered).text, at }
}

export interface ServeOptions {
  dataDir?: string
  /** Where `index.html` lives. Found beside this package unless something says otherwise. */
  uiDir?: string
  /**
   * The folder holding installed plugin folders.
   *
   * `<dataDir>/extensions`, and deliberately **not** `<dataDir>/plugins` — storage.md spends
   * that one on a plugin's own data directory, and an install folder that is also the data
   * folder makes purge remove the same path twice and D58's cwd rule ambiguous.
   *
   * ponytail: M2-5 owns install/enable/disable/purge and confirms or renames this.
   */
  pluginsDir?: string
  /** Zero — the default — takes whatever port is free, which is what a local app should do. */
  port?: number
  /**
   * The provider table this server may reach, defaulting to all of it.
   *
   * A seam rather than a setting. Since the keyless floor landed, *no provider is connected*
   * is no longer a state a running Alexia can be in — four of these rows answer with an empty
   * keychain — and a test that wanted a world containing only its own stub had no way to say
   * so. It would silently route to a real provider over the real network, pass, and be
   * measuring somebody else's server.
   *
   * The one test that is *supposed* to reach the real floor says so by not passing this.
   */
  providers?: Provider[]
  /**
   * Whether this server looks for models on this machine. Yes unless a test says otherwise.
   *
   * The same seam as `providers`, one rung further down. A test that expected a refusal on
   * *a machine with no Ollama* was answered by the Ollama on the laptop running it, and since a
   * failed rung walks on to the next one (D155), so is any test whose stub provider fails.
   */
  local?: boolean
  /**
   * How long a task started elsewhere waits for a yes to a paid model before it stops (§4 H). Ten
   * minutes unless a test says otherwise, because a test cannot wait ten minutes for a no.
   */
  allowWaitMs?: number
  secrets?: SecretStore
}

export interface Serving {
  url: string
  token: string
  store: Store
  close(): Promise<void>
}

/**
 * Where the shell is, from wherever this file is running: compiled into `dist/src`, which is
 * how it ships, or straight from `src` under a TypeScript runner. Checked rather than
 * assumed — a wrong path here is a blank window, and it found me before the tests did,
 * because they were the ones passing the path in.
 *
 * `./ui` is the packaged build (M1-I1): one bundled file with the shell in a folder beside
 * it. It is checked last because the repo layouts are the ones a developer hits, and first
 * match wins either way — the packaged tree has no `../../ui` to be confused by.
 */
function shell(): string {
  // `./ui` first, because that is the packaged layout and the packaged layout is the one
  // that ships. It used to be last, and under the desktop shell (M5-1) the walk upwards
  // found `src-tauri/ui` — Tauri's own placeholder frontend — three directories above the
  // bundle, and served that instead. The window came up with the wrong page and nothing
  // said why. In the repo `./ui` simply does not exist, so nothing about that case changes.
  const candidates = ['ui', join('..', '..', '..', 'ui'), join('..', '..', 'ui')].map((up) =>
    join(import.meta.dirname, up),
  )
  return candidates.find((dir) => existsSync(join(dir, 'index.html'))) ?? candidates[1]!
}

/**
 * The three answers to *which theme*, and the only three this endpoint will store.
 *
 * Written down twice — the other copy is `THEMES` in `packages/ui/src/theme.ts`, which cannot
 * import this one because the shell has no dependencies and no Node in it (invariant 6). Two
 * copies drift, so `packages/ui/test/theme.test.ts` reads both files and holds them equal.
 */
const THEMES = ['system', 'light', 'dark']

/**
 * MCP's content blocks, as the parts a stored message is made of.
 *
 * The narrowing worth stating: **a string comes back when a string is all there was**, which
 * is nearly always. Every turn that is only words is stored and sent exactly as it was before
 * any of this existed, so the shape a provider sees is unchanged for the overwhelming
 * majority of traffic and the array is not a tax everybody pays for a feature few use.
 *
 * MCP hands an image over as base64 plus its media type, in two fields; a provider wants one
 * `data:` URL. That reassembly is the whole of what this does that a `map` would not.
 */
function asParts(blocks: { type: string; text?: string; data?: string; mimeType?: string }[]): string | Part[] {
  if (blocks.every((block) => block.type === 'text')) return blocks.map((block) => block.text ?? '').join('\n')
  return blocks.map((block) =>
    block.type === 'image' && typeof block.data === 'string' ?
      { type: 'image' as const, url: `data:${block.mimeType ?? 'image/png'};base64,${block.data}` }
      // Audio, a resource, something MCP adds next year. Named rather than dropped: *the
      // caller sent audio* is something a model can answer about, and a blank is not.
    : { type: 'text' as const, text: block.type === 'text' ? (block.text ?? '') : `[${block.type}]` },
  )
}

const STATIC: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  // The shell is TypeScript compiled by the same `tsc -b` as everything else. No bundler,
  // because a chat window is not a build problem. Modules beyond the entry point are matched
  // by MODULE below rather than listed here, one line each.
  '/main.js': [join('dist', 'src', 'main.js'), 'text/javascript; charset=utf-8'],
  // Her face: the first-run mark and the tab icon. Everything above is text and gets the
  // token substituted into it; this does not, which is why the read below is bytes until the
  // content type says otherwise.
  '/alexia.png': ['alexia.png', 'image/png'],
  // The painting, as three masks rather than three pictures (docs/design.md). They are drawn
  // in `currentColor`'s place — the element behind the mask carries the theme's own accent —
  // which is what lets one file be champagne on cobalt and cobalt on champagne. SVG is not
  // `text/`, so it passes through without the token substitution, like the PNG.
  '/alexia-mark.svg': ['alexia-mark.svg', 'image/svg+xml'],
  '/alexia-panel.svg': ['alexia-panel.svg', 'image/svg+xml'],
  '/alexia-band.svg': ['alexia-band.svg', 'image/svg+xml'],
  // The two themes, as the two pictures they are. These are the one place the painting is
  // *not* a mask: the settings screen is choosing which colours it takes, and a preview that
  // recoloured with the current theme would show the same theme three times. Flat bitmaps,
  // so like the PNG they go out as bytes with no token substituted into them.
  '/theme-light.webp': ['theme-light.webp', 'image/webp'],
  '/theme-dark.webp': ['theme-dark.webp', 'image/webp'],
}

export async function serve(options: ServeOptions = {}): Promise<Serving> {
  const root = options.dataDir ?? dataDir()
  const ui = options.uiDir ?? shell()
  const secrets = options.secrets ?? keychain
  const providers = options.providers ?? PROVIDERS
  const store = new Store(join(root, 'alexia.db'))
  const catalog = new Catalog(join(root, 'cache', 'models.json'))
  const token = randomUUID()

  // The daily poll, such as it is: once at startup, and `refresh` itself declines to fetch
  // anything younger than a day old — per provider, so asking for the second list in a day
  // is a fetch rather than a shrug.
  //
  // Every provider, not just the one somebody happened to connect first. A model list is
  // public, which is what lets first run show what is free before anybody has pasted a key,
  // and it is what lets the Models tab show what a key would get you. A provider that is
  // unreachable, or that wants a key for its list, leaves the cache exactly as it was.
  /**
   * **What the last fetch of each provider's list added**, as the Models tab's news line (§4 D):
   * one line per provider, replaced by that provider's next fetch — so a model added between two
   * fetches is news once, and a fetch that adds nothing clears it.
   */
  const headlines = new Map<string, string>()
  /**
   * Fetch one provider's list — when it has aged out, or at once with `maxAge` 0 — and write down
   * what changed: first sightings and departures into the record, and the news line.
   */
  const fetchList = async (provider: Provider, maxAge?: number, key?: string): Promise<Change> => {
    const since = catalog.fetchedFrom(provider.id)
    const change = await catalog.refresh(provider, maxAge, key ?? (await secrets.get(CORE, keyOf(provider)).catch(() => undefined)))
    // Declined as fresh, or failed: nothing was fetched, so nothing changed.
    if (change.failed !== undefined || catalog.fetchedFrom(provider.id) === since) return change
    store.recordSeen(provider.id, {
      added: change.added.map((model) => model.id),
      removed: change.removed.map((model) => model.id),
      listKnown: change.listKnown,
    })
    const line = news(change, {
      provider: provider.name,
      ...(since > 0 && { since: new Date(since).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) }),
    })
    if (line === undefined) headlines.delete(provider.id)
    else headlines.set(provider.id, line)
    return change
  }
  const poll = async (provider: Provider): Promise<void> => {
    void (await fetchList(provider))
  }

  /**
   * **What the provider says the key's account is** (§4 D): still on the free tier or not, and how
   * much of the key's credit limit is left. Kept in the store's core namespace, so the ledger's
   * daily allowance and *Funded* read the provider's own word rather than D107's low guess. A key
   * with nowhere to ask, a refusal, or a shape this does not know leaves what was known.
   */
  /** How long an account question waits. Declared here, above the startup poll that first asks one. */
  const ACCOUNT_WAIT = 15_000
  const readAccount = async (provider: Provider, key?: string): Promise<Account | undefined> => {
    if (provider.keyInfo === undefined) return undefined
    const stored = key ?? (await secrets.get(CORE, keyOf(provider)).catch(() => undefined))
    if (stored === undefined) return undefined
    try {
      const response = await fetch(`${provider.baseUrl}${provider.keyInfo}`, {
        headers: { authorization: `Bearer ${stored}`, accept: 'application/json', ...provider.headers },
        signal: AbortSignal.timeout(ACCOUNT_WAIT),
      })
      if (!response.ok) return undefined
      const { data } = (await response.json()) as { data?: { is_free_tier?: unknown; limit_remaining?: unknown } }
      if (typeof data?.is_free_tier !== 'boolean') return undefined
      const account: Account = {
        freeTier: data.is_free_tier,
        limitRemaining: typeof data.limit_remaining === 'number' ? data.limit_remaining : null,
        at: Date.now(),
      }
      // Only if that key is still the one stored: a key removed while this was asking takes its
      // account with it, and an answer arriving after must not write it back.
      if ((await secrets.get(CORE, keyOf(provider)).catch(() => undefined)) !== stored) return undefined
      store.kvSet(CORE, accountKey(provider.id), account)
      return account
    } catch {
      return undefined
    }
  }

  /** Every provider, if its own list has aged out, and every account a key can ask about. Startup calls it; so does the Models tab. */
  const pollAll = (): void => {
    for (const provider of providers) {
      void poll(provider)
      void readAccount(provider)
    }
  }
  pollAll()
  /**
   * **Every six hours while the app runs** (D161), which is how the lists stay current without
   * anybody opening the Models tab. A tick that comes late after the machine slept simply polls:
   * each provider's own age decides, not the timer. Cleared on close.
   */
  const ticking = setInterval(() => {
    pollAll()
    // And today's test messages, on the same tick (§4 E). Declared below, and a tick is hours away.
    void testModels()
  }, POLL_EVERY)
  ticking.unref()

  /**
   * The conversation on screen (M8-2), and the reason it is a variable.
   *
   * It used to be a `const` read once at startup: one conversation, for the life of the
   * install, growing until `trim()` was the only thing standing between it and the context
   * window. The Chats tab moves it, and everything that reads it — the transcript, an
   * append, a spend row, the checker — reads it **per request** rather than holding the
   * number it was born with, which is the whole of what makes switching work.
   *
   * A task already running keeps the conversation it started in: `reply()` closes over
   * nothing, but the appends it makes happen while it runs, and finishing an answer into a
   * conversation somebody has navigated away from is better than finishing it into one they
   * are reading. **The switch takes effect on the next thing said**, which is what the
   * button says it does.
   */
  let session = store.sessions()[0]?.id ?? store.createSession()

  const extensions = options.pluginsDir ?? join(root, 'extensions')
  const skillsDir = join(root, 'skills')
  /**
   * The library (M3-2). It downloads, checks a checksum and unpacks; it never enables
   * anything, which is why every route below that installs ends by re-drawing the panes
   * with the new plugin sitting in the *not enabled* state.
   */
  const library = new Library({ store, pluginsDir: extensions, skillsDir })
  /**
   * **The shelf is not read from here** (D118), and that is deliberate.
   *
   * Nothing ships inside the installer any more, so *what can this thing do* is a network
   * call — and the tempting place to make it is at boot, so the Plugins screen opens on a
   * list rather than a spinner. It is not made here because *here* is every core that ever
   * starts: every test, every headless run, every restart of a daemon nobody is looking at,
   * each one spending a request from an hourly quota of sixty for a screen that may not be
   * opened. The shell asks on load, which is the moment somebody is actually there, and
   * `Library` holds the answer for fifteen minutes so that opening the screen again is free.
   */

  /**
   * The files tools have handed back, for as long as this core is up.
   *
   * Here rather than in the store on purpose — see `offered.ts`. A row that survived a
   * restart would be a button promising a file core has not looked at since, and a download
   * that fails is worse than one that was never offered.
   */
  const offers = new Offers()

  /**
   * **Who is answering, kept until a plugin's tools change** (improvements 8 and 10).
   *
   * The chip and *That wasn't her* are read on every state poll — twenty a minute with the
   * window open — and each is a question a plugin's *binding* answers, which means waking the
   * plugin to ask. Asked per poll, that kept a lazy plugin running for as long as the window
   * was open, and put a plugin round trip in front of every state read. Neither answer changes
   * unless a plugin changes what it binds, and every such change arrives as `onToolsChanged`
   * below: switching, forgetting, enabling, disabling, a crash. So it is asked once, then kept.
   *
   * Declared before the plugins it listens to, because their loading already reports changes.
   */
  let speaking: Promise<{ character?: string; notHer: boolean }> | undefined

  /**
   * Everything installed, and the aggregate of what it can do (M15-2).
   *
   * The loop asks `tooling.list()` on every step and this cache answers it, so a folder
   * deleted mid-task is noticed on the next step rather than at the end of the run — which
   * is invariant 4 meeting the agent loop, and what M15-8 tests.
   */
  const plugins = new Plugins({
    dir: extensions,
    store,
    dataDir: root,
    secrets,
    log: (id, line) => console.error(`[${id}] ${line}`),
    onToolsChanged: () => {
      tooling.invalidate()
      // A plugin arriving or going away takes its bundled skills with it, and the index the
      // model is shown is a tool description built from that list.
      skills.invalidate()
      // And who is answering is asked again on the next state read.
      speaking = undefined
    },
    // The folders the user chose, as MCP roots. A plugin is told where it may work by the
    // protocol's own mechanism rather than by anything Alexia invented.
    roots: () => rootsOf(scope()),
    /**
     * A plugin asking the model something, over MCP's own `sampling/createMessage`.
     *
     * This is what a plugin holding a conversation of its own needs — a message arriving
     * from outside has to be answered by something, and a plugin bundling its own model
     * key would be a second place the user pays from and a second place their words go.
     * So it goes through the same router as everything else, on the same rungs, under the
     * same monthly cap.
     *
     * **The spend lands on the plugin that spent it.** That is the whole reason
     * `usage.plugin` exists, and until something called this it was a column nothing wrote.
     */
    sample: async (pluginId, params, signal) => {
      const asked: Message[] = [
        ...(params.systemPrompt === undefined ? [] : [{ role: 'system' as const, content: params.systemPrompt }]),
        ...params.messages.map((turn) => ({
          role: turn.role === 'assistant' ? ('assistant' as const) : ('user' as const),
          /**
           * MCP lets one turn carry several blocks, and several kinds.
           *
           * This used to flatten every one of them to the literal string `[image]`, on the
           * true-at-the-time grounds that *a model reached over this path is a text one*. It
           * is not any more, so a plugin holding a picture — a screenshot it just took, a
           * page it just scanned — can hand it over and have it *seen*, and the router picks
           * a model that can see it.
           *
           * Anything that is neither text nor an image is still named rather than dropped:
           * *the caller sent audio* is something a model can answer about, and a blank is not.
           */
          content: asParts([turn.content].flat()),
        })),
      ]
      /**
       * *Use my tools, and ask me when you must* (M7-5).
       *
       * With the flag set this is not one completion, it is **the whole loop**: the tool
       * list, the permission gate, the trace and the ledger, on exactly the terms a task
       * started at the keyboard gets. The plugin that sets it is one holding a conversation
       * somewhere else — a phone — and until now that path had no tools at all, because
       * there was nowhere to ask a permission question. There is now.
       *
       * **A flag on this request rather than a new method.** An Alexia that does not know it
       * ignores it and answers without tools, which is precisely what it did before the flag
       * existed — so nothing a plugin can see goes wrong, and the contract's number does not
       * move for it.
       */
      /**
       * A slash command, wherever it was typed. Before the flag and before the loop: a
       * command is not a question for a model, and `/new` in particular has to work while a
       * task is running rather than queue behind one.
       *
       * **One short line, and a command-shaped word.** Not every plugin on this path is
       * carrying something a person typed — some send text wrapped in a prompt of their own
       * — and a wrapped prompt that happened to begin with a slash being answered *there is
       * no /home* instead of being read would be a bug nobody would find for weeks.
       */
      const lastAsked = [...asked].reverse().find((turn) => turn.role === 'user')
      const typed = lastAsked === undefined ? '' : textOf(lastAsked).trim()
      if (!typed.includes('\n') && /^\/[a-z][a-z0-9.-]*(?:\s|$)/i.test(typed)) return asCommand(pluginId, typed)

      if (params._meta?.[TOOLS_META] === true) {
        return asTask(pluginId, asked, signal, background(pluginId), declaredFor(pluginId, params.modelPreferences))
      }

      /**
       * **What the plugin declared about the model it needs** (M8-1), and both halves of it
       * were fields nobody read until this line.
       *
       * `min_tier` is the manifest's floor — *the cheapest rung my work is safe on* — and it
       * is passed on both sampling paths, this one and `asTask`, because the spec's sentence
       * is about `sampling/createMessage` and the tools flag does not make a request a
       * different request. `modelPreferences` is MCP's own, and {@link wantsCapable} is the
       * whole of what core reads from it.
       */
      const declared = declaredFor(pluginId, params.modelPreferences)
      /**
       * **A personality in its three lengths, and which one to hear** (D189, *Hear her*). With it,
       * a rung is sent the length the chat would give that model — or, with `hear` set, that
       * length, on a model the chat would give it to. Without it, the system prompt as written.
       */
      const offered = params._meta?.[LENGTHS_META] as Record<string, unknown> | undefined
      const lengths = offered === undefined ? undefined : personalityFrom(offered)
      const hear: Size | undefined =
        lengths !== undefined && (offered?.hear === 'small' || offered?.hear === 'medium' || offered?.hear === 'high') ? offered.hear : undefined
      /**
       * **A button somebody pressed is a run, and may spend like one** (G13, D156).
       *
       * `send` reads *attributed to a plugin, belonging to no run* as *free tiers only* (G12,
       * D96), and that ceiling is right for a poll loop that woke up at 3am with nobody there.
       * A press is the other thing: somebody is at the screen watching a progress bar, which
       * is exactly the audience the spend preview was missing on this path. So a press gets a
       * run id, and with it the same money rails a task at the keyboard has — the paid switch,
       * today's amount, and the monthly cap. Derived from `pressing`, the same map that
       * already decides chat-or-background, so no call site has a flag to forget.
       */
      const behind = background(pluginId)
      const asRun = behind ? undefined : randomUUID()
      // The paid switch, for a press that may now reach across the price line (§4 H). No
      // conversation to have said *Allow* in — a press is not a chat — so it is the switch
      // alone. Left unasked without a run, where paid was never reachable anyway.
      const seen = asRun === undefined ? await world() : { ...(await world()), cross: caps(store).cross === true }
      const verdict = route(
        {
          messages: asked,
          shape: shapeOf({ messages: asked }),
          ...(behind && { background: true }),
          ...declared,
        },
        pins(store),
        seen,
      )
      if (!verdict.ok) throw new Error(verdict.why)
      /** Heard at one length: the rungs the chat would give it to, under the same pins and switch (D189). */
      const hearAt = hear === undefined ? undefined : hearingPlan(verdict.choices, seen, hear)
      /** The length a rung is given, as the chat would give it — or the one asked to be heard. */
      const worn = (choice: Choice): { text: string; size: Size } | undefined =>
        lengths === undefined ? undefined : sizedFor(lengths, hear ?? sizeFor(choice, seen))
      sampling += 1
      const answer = await send(
        hearAt?.choices ?? verdict.choices,
        {
          messages: asked,
          ...(params.maxTokens !== undefined && { maxTokens: params.maxTokens }),
          // The plugin's cancel (D160). When it stops waiting, no further rung is asked and
          // nothing is counted as the model's failure: nobody is there to be answered.
          ...(signal !== undefined && { signal }),
        },
        store,
        secrets,
        {
          plugin: pluginId,
          ...(asRun !== undefined && { run: asRun, paidAllowed: !allowance(store).stop }),
          // Today's allowance holds each paid rung to what the reply could cost (D186), so a press
          // asking for a capable model cannot buy the dearest one past what the day has left.
          ...(verdict.left !== undefined && { left: verdict.left }),
          // Each rung its own length, in place of the one system prompt the plugin wrote (D189).
          ...(lengths !== undefined && {
            messagesFor: (choice: Choice): Message[] => [
              { role: 'system', content: worn(choice)?.text ?? lengths.high },
              ...asked.filter((turn) => turn.role !== 'system'),
            ],
          }),
        },
      ).finally(() => (sampling -= 1))
      /**
       * **What was heard, and what the chat would do** (D189): the length that went out and on
       * which model, whether that model costs money and what this cost, whether it is a model the
       * chat would give that length to — and, beside it, the model the chat asks first right now
       * and the length it is given, which is the answer to *which length will she get?*
       */
      const told = async (): Promise<Record<string, unknown>> => {
        if (lengths === undefined) return {}
        const chatWorld = { ...(await world()), cross: caps(store).cross === true }
        const chat = route({ messages: asked, shape: shapeOf({ messages: asked }) }, pins(store), chatWorld)
        const first = chat.ok ? chat.choices[0] : undefined
        return {
          [LENGTHS_META]: {
            sent: worn({ model: answer.model, provider: answer.provider })?.size,
            model: answer.model.name,
            paid: paid(answer.model.tier),
            cost: costOf(answer.model, answer.usage),
            matched: hearAt?.matched ?? true,
            ...(hear !== undefined && { asked: hear }),
            ...(first !== undefined && { chat: { model: first.model.name, size: sizedFor(lengths, sizeFor(first, chatWorld)).size } }),
          },
        }
      }
      const meta = await told()
      return {
        role: 'assistant',
        content: { type: 'text', text: textOf(answer.message) },
        model: answer.model.id,
        // MCP's own word for *it ran out of room*. A plugin told `endTurn` about half an
        // answer has no way to know it is half, and the personality adapter saved one.
        stopReason: answer.cut ? 'maxTokens' : 'endTurn',
        ...(Object.keys(meta).length > 0 && { _meta: meta }),
      }
    },
  })
  /**
   * Know-how (M2-2). Two arrival routes and one format: folders the user installed on their
   * own, and folders a plugin declared — which is why the bundled half is a function rather
   * than a list. Deleting the plugin deletes its skills, and the next read simply finds
   * fewer folders.
   */
  const skills = new Skills({
    dir: skillsDir,
    // The consent ladder (M6-9). Without a store every skill is live, which is what a
    // caller with no store is asking for; core has one, so a skill nobody has said yes to
    // waits — and the one this exists for is the skill a model wrote about itself.
    store,
    bundled: () =>
      plugins.ids.flatMap((id) => {
        const folder = plugins.folder(id)
        // A skill bundled with a plugin nobody has enabled is know-how about something
        // Alexia cannot currently do. It arrives with the plugin and it waits with it.
        if (folder === undefined || !plugins.enabled(id)) return []
        return (plugins.manifest(id)?.skills ?? []).map((path) => ({ dir: join(folder, path), pluginId: id }))
      }),
  })
  const tooling = new PluginTooling(plugins, (line) => console.error(`[tools] ${line}`), skills)
  /**
   * The folder exists before anything watches it. A fresh install has installed nothing, so
   * there is no `extensions` yet — and `watch()` on a folder that is not there fails once and
   * never tries again. Every install since the plugins stopped shipping (D118) started that
   * way: the library made the folder on the first download, and nothing noticed a plugin
   * folder deleted by hand until the next restart. `Plugins` still refuses to watch a missing
   * folder (invariant 2); making it is the job of whoever owns the data directory, which is here.
   */
  mkdirSync(extensions, { recursive: true })
  plugins.load()
  plugins.watch()

  /**
   * First run, steps 2 to 4a. Done means a mode was chosen — the name is skippable and a
   * provider can wait, but *where your words go* is not a question Alexia answers for you.
   */
  const setup = () => ({
    done: store.kvGet(CORE, 'mode') !== undefined,
    name: (store.kvGet(CORE, 'display_name') as string | undefined) ?? 'Alexia',
    mode: (store.kvGet(CORE, 'mode') as string | undefined) ?? 'combined',
    // Which theme, and `system` when nobody has said — which is the answer first run gets and
    // the answer somebody gets back after changing their mind twice. It is stored here rather
    // than in the browser because it is a fact about this install, like the name: the desktop
    // window and a tab pointed at the same core are one Alexia and should not disagree about
    // what colour it is.
    theme: (store.kvGet(CORE, 'theme') as string | undefined) ?? 'system',
    // How opaque the frosted panels are, as a `--glass-tint` percentage (0–100, 0 being just
    // the border). Stored here with the theme because it is the same kind of fact and a tab
    // and the window should not disagree about it. 60 is the sheet's own default.
    glass: (store.kvGet(CORE, 'glass') as number | undefined) ?? 60,
    /**
     * Whether Alexia looks for a newer version of itself when it starts (D121).
     *
     * **On unless somebody says otherwise, and sayable in one place.** An assistant that
     * quietly stops updating is one running last month's bugs on purpose, so the default is
     * to look — and *a person who wants to stay where they are* is a real answer rather than
     * a mistake, which is why it is a stored preference and not a hidden flag. It gates the
     * *looking*, not the installing: nothing has ever installed itself here without somebody
     * pressing a button, and the About page says so in those words.
     */
    updates: (store.kvGet(CORE, 'updates_auto') as boolean | undefined) ?? true,
  })

  /**
   * Where Alexia may work and how much it may do unasked (M15-3). One kv entry, because
   * these are always read together and always shown together.
   */
  const scope = (): Scope => {
    const saved = store.kvGet(CORE, 'scope') as Partial<Scope> | undefined
    return {
      mode: saved?.mode ?? DEFAULT_MODE,
      roots: saved?.roots ?? [],
      ...(saved?.everywhere === true && { everywhere: true }),
      boundaries: (store.kvGet(CORE, 'boundaries') as Boundary[] | undefined) ?? [],
      dataDir: root,
    }
  }

  const limitsNow = (): Ceilings => ceilings(store)

  /** Every enabled plugin's manifest, which is where its commands come from (M1-12). */
  const manifests = () => plugins.ids.flatMap((id) => plugins.manifest(id) ?? [])

  /**
   * Which models' hosts are down by their provider's own status (`uptime.ts`): the last read, held
   * for the life of this core, with the next one started behind it and never waited for.
   */
  const uptime = new Uptime()

  /** Everything the router needs to know, asked fresh: a tier can be exhausted mid-sentence. */
  const world = async () => {
    const models = catalog.models
    const local = options.local !== false && (await running()) ? await installed() : []
    const rungs = await usable(store, secrets, providers)
    const tries = store.tries()
    const standing = pins(store)
    return {
      models,
      local,
      rungs,
      // Asked fresh with the rest of it, and for the same reason: an allowance can run out
      // mid-sentence exactly the way a free tier can.
      today: today(store),
      // What failed here in the last day, so a model that just timed out is not first again (D159).
      strikes: store.strikes(),
      // What Alexia thinks of each model, from 30 days of tries (D161). Judged on every ask, so a
      // key saved a moment ago brings back a provider set aside for wanting one, without a restart.
      health: judge(
        tries,
        store.seen(),
        [...models, ...local],
        new Set(rungs.filter((rung) => rung.keyed === true).map((rung) => rung.provider.id)),
        Date.now(),
        store.waits(),
      ),
      // Nothing is reported from anywhere else: the hook for a shared record, decided later (§4 J, D160).
      reported: new Set<string>(),
      // Down by the provider's own status, as last read: a minute old at most, and never waited for.
      // Not looked at when text is answered on this Mac, where no hosted model is asked.
      down: standing.placement.text === 'local' ? new Set<string>() : uptime.down(() => watched(rungs, models, tries, standing.model)),
    }
  }

  /**
   * One question at a time, waiting for an answer from the screen.
   *
   * A permission prompt is the one place the loop genuinely blocks on a person, so it is
   * held here rather than invented per request: the task streams `ask`, this promise waits,
   * and `/api/approve` settles it. A second question cannot arrive while one is open,
   * because the loop is single-threaded through it.
   */
  let pending: ((allowed: boolean) => void) | undefined

  /**
   * The stop control (M15-5).
   *
   * One task runs at a time, so one controller is the whole of it. Aborting reaches three
   * places at once: the loop checks it between steps, `chat()` passes it to `fetch` so a
   * half-streamed answer stops arriving, and `tools/call` carries it to the plugin as MCP
   * `notifications/cancelled`. The plugin that ignores that is why `callMs` exists.
   */
  let task: AbortController | undefined

  /** A plugin's sampling requests on their way — answers somebody may be waiting for (§4 E). */
  let sampling = 0

  /**
   * **Plugins whose button somebody has just pressed** (§4 F, D161). A request a plugin makes while
   * its own press is in flight is somebody watching a progress bar — Adapt is the case — and counts
   * as the chat for free requests; anything else a plugin asks for is background. Without a run id
   * on a press (G13's build, not yet), this is how core tells the two apart.
   */
  const pressing = new Map<string, number>()
  const background = (pluginId: string): boolean => (pressing.get(pluginId) ?? 0) === 0

  /**
   * **Today's test messages** (§4 E): a minute after start, and on every six-hour tick. Never while
   * a task runs or a plugin's request is being answered — asked before each test, so an answer
   * that starts mid-round stops the round — and never more than the day allows, which the store
   * remembers across a restart.
   */
  const answering = (): boolean => task !== undefined || sampling > 0
  const testModels = async (): Promise<void> => {
    if (answering()) return
    await trial({ world: await world(), store, secrets, busy: answering }).catch(() => undefined)
  }
  const firstTests = setTimeout(() => void testModels(), 60_000)
  firstTests.unref()

  /**
   * The last task worth learning from, waiting for an answer (M4-5).
   *
   * One, not a queue: the offer is made at the end of a task and answered before the next
   * one starts, or it is not answered at all. A backlog of *do you want to remember this*
   * from last Tuesday is a backlog nobody clears.
   */
  let lesson: Episode | undefined

  /**
   * The answer the last *That wasn't her* press was about, so the line typed after it lands on
   * the same one (improvement 10). One, like `lesson`: the box is under the latest answer only.
   */
  let pressed: { session: typeof session; answer: string; asked?: string } | undefined

  /**
   * The second opinion (M15-4). Local by default — a reviewer that ships what it is
   * reviewing to somebody else's API has leaked the very file it was asked about.
   *
   * The tally lives here rather than in the checker because *this session* is what the
   * give-up rule counts, and the checker itself is stateless on purpose.
   */
  /**
   * The permission ruling for a tool a screen is about to call (M15-3).
   *
   * Four callers now — an action button, a row action, a slash command, and the two reads a
   * `table` makes — and one gate, because *the same call through a different screen is the
   * same call*. Written once rather than four times: the copy made for `/api/command` had
   * already started drifting from the one it was copied from.
   */
  const rulingFor = async (plugin: string, tool: string): Promise<Ruling> => {
    const about = await tooling.about(`${plugin}__${tool}`)
    return rule(
      {
        tool,
        ...(about?.annotations && { annotations: about.annotations }),
        reviewed: !unreviewed(store).has(plugin),
      },
      scope(),
    )
  }

  /**
   * What core's own tabs are made of (M6-4). Built once, because every one of them reads
   * something this closure already holds — and read fresh on every call, because a skills
   * list that answered from a snapshot would be the one thing on this screen that lies.
   */
  /**
   * The trace, with a memory (M6-5). Five runs, in memory, gone on restart — which is the
   * honest behaviour for something that was never meant to be a permanent log. What outlives
   * a restart is whatever somebody exported.
   */
  const trace = new Trace()

  /**
   * Which providers hold a key, asked once per read rather than once per row.
   *
   * The same question `/api/state` answers for the settings screen, and the same answer: a
   * key is never read out of here, only counted. A keychain that refuses is *not connected*
   * rather than an exception — this is a column on a table, and a locked credential store
   * should grey a button, not empty the screen.
   */
  const connected = async (): Promise<ReadonlySet<string>> => {
    // The keyless floor's switch (D154). A key is asked about first, so a provider somebody
    // pasted one into is keyed rather than the floor and stays connected either way.
    const floor = keylessOn(store)
    const found = await Promise.all(
      providers.map(async (p) =>
        (await secrets.get(CORE, keyOf(p)).catch(() => undefined)) !== undefined ? [p.id]
        : anonymous(p) && floor ? [p.id]
        : [],
      ),
    )
    return new Set(found.flat())
  }

  const capitalised = (line: string): string => line.charAt(0).toUpperCase() + line.slice(1)

  /** `14 free models`, `1 free model`. */
  const models = (n: number, kind: string): string => `${String(n)} ${kind}model${n === 1 ? '' : 's'}`

  /**
   * **How long a saved key waits for its provider's list** (§1 step 3, D163). Long enough for
   * OpenRouter's, the biggest, on a slow connection; short enough that a provider that never
   * answers leaves a Save button that answered. The fetch goes on behind it either way.
   */
  const LIST_WAIT = 15_000

  /**
   * A key was just saved: fetch that provider's list with it and say what it unlocked.
   *
   * The count is what the slider lets answer, from the same `allowed()` the Models tab and the
   * router read (D154) — *14 free models* on *free only* should not quietly include paid rows
   * a person will never see. A list that does not arrive is said too, because the commonest
   * reason for that on a list that needs a key is the key.
   */
  const connectedNow = async (provider: Provider, key: string): Promise<string> => {
    const fetched = fetchList(provider, 0, key)
    const waited = await Promise.race([
      fetched,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), LIST_WAIT).unref()),
    ])
    if (waited === undefined) {
      return `${provider.name} connected. Its model list is still arriving — open the Models tab again in a moment.`
    }
    if (waited.failed !== undefined) {
      return `${provider.name}'s key is saved, but its model list did not arrive (${waited.failed}). If it says 401 or 403, the key was not accepted.`
    }
    // What the account is, where the provider says: it decides the day's allowance and whether its
    // paid models can be bought, so it is asked before the count below is taken (§4 D).
    const account = await readAccount(provider, key)
    const spend = pins(store).spend ?? 'mixed'
    const funded = fundedBy(account)
    const listed = catalog.models.filter((m) => m.provider === provider.id && allowed(m, spend) && !(paid(m.tier) && funded === false))
    const free = listed.filter((m) => !paid(m.tier)).length
    const priced = listed.length - free
    return (
      `${provider.name} connected — ${models(free, 'free ')}${priced > 0 ? ` and ${String(priced)} paid` : ''}.` +
      (funded === false ? ` Its paid models are not listed: ${provider.name} says ${account?.freeTier === true ? 'this account has no credit yet' : "this key's credit limit is used up"}.` : '')
    )
  }

  /**
   * **Take a key out of the keychain** (§1 step 4). The provider is disconnected, unless it
   * answers without a key, in which case it goes back to the shared floor.
   *
   * **A pin and a list are never edited by this** — D155's *Alexia never edits a list* — so
   * whatever named this provider's models stays named, and the Models tab and the ladder show
   * it as *not available* until a key is back. The sentence says so, because the alternative is
   * somebody finding a list entry greyed out a week later with no memory of why.
   */
  const disconnect = async (provider: Provider): Promise<string> => {
    await secrets.delete(CORE, keyOf(provider))
    // What the provider said about that key's account goes with the key.
    store.kvDelete(CORE, accountKey(provider.id))
    // Only while the keyless switch is on: off, the shared floor is not asked at all, and saying
    // it *still answers* sent somebody looking for answers that were never coming.
    if (anonymous(provider) && keylessOn(store)) {
      return `The ${provider.name} key is removed. ${provider.name} still answers without one, on its shared free tier.`
    }
    const standing = pins(store)
    const ids = new Set(catalog.models.filter((m) => m.provider === provider.id).map((m) => m.id))
    // A model another connected provider also serves still answers, so it is not named here.
    const reachable = await connected()
    const still = new Set(catalog.models.filter((m) => reachable.has(m.provider)).map((m) => m.id))
    const lost = (id: string): boolean => ids.has(id) && !still.has(id)
    const pinned = standing.model !== undefined && lost(standing.model)
    const listed = (standing.order ?? []).filter(lost).length
    const kept = [
      ...(pinned ? ['the model you chose stays chosen'] : []),
      ...(listed > 0 ? [`your list keeps ${listed === 1 ? 'the one it names' : `the ${String(listed)} it names`}`] : []),
    ]
    return (
      `The ${provider.name} key is removed, and its ${models(ids.size, '')} are no longer listed.` +
      (kept.length === 0 ? '' : ` ${capitalised(kept.join(' and '))}, shown as not available until a key is back.`)
    )
  }

  /**
   * **The conversations in which somebody pressed *Allow switching to a paid model*** (§4 H).
   *
   * One press covers the conversation it was pressed in, and only that one: consent given in one
   * conversation is not consent given in another. Kept per conversation rather than cleared when
   * another is opened, so going back to one where it was allowed finds it still allowed — and a
   * Telegram conversation's yes is its own.
   */
  const paidIn = new Set<number>()

  /**
   * **The world a task in this conversation sees** (§4 H): everything `world()` gathers, and
   * whether paid may be crossed into by itself — the paid switch on, or *Allow* pressed here.
   */
  const worldFor = (conversation: number) => async () => ({
    ...(await world()),
    cross: caps(store).cross === true || paidIn.has(conversation),
  })

  const surface = {
    skills, tooling, plugins, skillsDir, trace, dataDir: root, store, catalog, connected, providers, world,
    news: () => (headlines.size === 0 ? undefined : [...headlines.values()].join(' ')),
    refresh: pollAll,
    session: () => session,
    openSession: (id: number) => (session = id),
    // Broadcast, to whoever is running and cares. Nothing is spawned to hear it and nothing
    // waits for it — a new conversation must not be held up by a plugin letting go of a
    // graphics card.
    ended: () => void plugins.ended(),
  }
  const ours = coreSources(surface)
  const ourActions = coreActions(surface)

  // The session is read when a review is charged rather than when the checker is built, so a
  // review lands on the conversation it was spent for (M8-2).
  const checker = new ModelChecker({ store, secrets, world, session: () => session })
  let tally: Tally = freshTally()

  /**
   * May this call run? (M15-3.) One gate, and from M7-5 two callers.
   *
   * Built fresh per task rather than once, because the mode, the folders and the boundaries
   * can all change while one is running — and the point of a boundary spoken mid-task is
   * that it takes effect on the next step, not the next task.
   *
   * It is a function rather than a closure written twice because a task started from a phone
   * has to meet **the same ruling the app would have produced**, and two copies of a
   * permission gate is two rulings waiting to disagree.
   */
  const gate =
    (text: string, run: string) =>
    async (call: { name: string; args: Record<string, unknown> }): Promise<Ruling> => {
      const about = await tooling.about(call.name)
      const now = scope()
      const ruling = rule(
        {
          tool: call.name,
          ...(about?.annotations && { annotations: about.annotations }),
          paths: pathsIn(call.args),
          // M3-6. A tool from a server nobody reviewed is destructive whatever its own
          // annotations claim — MCP's own guidance, and the gate reads it right here.
          reviewed: about?.pluginId === undefined || !unreviewed(store).has(about.pluginId),
        },
        now,
      )
      // The fixed rules have already spoken. The checker is coverage on top of them and
      // never instead of them, so it is only asked about something they would let run.
      if (ruling.verdict !== 'run' || now.mode !== 'watch') return ruling

      const step = { n: 0, name: call.name, args: call.args }
      // The review is spent because of this task, so it lands on this task's rows (M7-2).
      const review = await checker.review({ step, task: text, scope: now, run })
      tally = counted(tally, review)
      return asRuling(review, step, tally)
    }

  /**
   * The chosen personality, or nothing (M4-4).
   *
   * **Read once per task, not once per step.** It goes into the system prompt in front of
   * every decision the loop makes, which is the whole reason it is here rather than on the
   * finished answer — but a plugin woken twenty-four times to repeat one paragraph is a
   * plugin somebody turns off.
   *
   * Nothing provides it, nothing is chosen, or whatever does provide it is having a bad
   * day → the stock four lines, and a task that runs. A personality is a preference, and a
   * preference must never be the reason an answer does not happen.
   */
  async function personality(channel?: string): Promise<Personality | undefined> {
    if (!plugins.answers(CORE_CAPABILITIES.personality)) return undefined
    try {
      /**
       * **Where this task is being read** (improvement 9), when it is not the window.
       *
       * A reply read on a phone wants to be shorter and plainer than one at the desk, and the
       * only thing core knows about that is which plugin started the task — so that is what it
       * says, and what the answer means by it is entirely the answering plugin's business.
       *
       * **Optional at both ends.** A persona plugin that ignores it behaves as it always did,
       * which is the bar for not moving the contract's number; core sends nothing at all for a
       * task from the window, because *the window* is not a channel anybody bound a personality
       * to — it is the absence of one.
       */
      const answered = await plugins.capability(
        CORE_CAPABILITIES.personality,
        channel === undefined ? undefined : { channel },
      )
      const said = (answered.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('')
        .trim()
      if (said === '') return undefined
      /**
       * **The three lengths, where the plugin offers them** (§2, D160). `content` is still the
       * long one and still the only required half, so a persona plugin too old to know about
       * sizes — or a row written before there were any — hands over one document and every
       * model gets it, which is exactly what happened before this line existed.
       *
       * Read defensively rather than parsed: `structuredContent` is whatever the plugin put
       * there, a shorter size that is not a string is no shorter size, and a personality is a
       * preference that must never be the reason an answer does not happen.
       */
      return personalityFrom((answered.structuredContent ?? {}) as Record<string, unknown>, said)
    } catch (error) {
      console.error(`[personality] ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /**
   * **The name of the personality in use**, for the chip in the chat header (improvement 8).
   *
   * A second tool on the same plugin rather than a field on `persona.personality`, because the
   * two questions have different answers at different times: the document is read once a task
   * and is the thing a model is given, and the name is read on every state poll and is a thing
   * a person is shown. Folding the name into the document's result would send a page of text
   * to the header twenty times a minute.
   *
   * Nothing provides it, nothing is chosen, or whatever does is having a bad day → no chip,
   * and a chat that works. This is a label; it is never a reason anything fails.
   */
  async function chip(): Promise<string | undefined> {
    if (!plugins.answers(CORE_CAPABILITIES.inUse)) return undefined
    try {
      const answered = await plugins.capability(CORE_CAPABILITIES.inUse)
      const said = (answered.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('')
        .trim()
      return said === '' ? undefined : said.slice(0, 40)
    } catch {
      return undefined
    }
  }

  /**
   * **The chip, and whether *That wasn't her* has anywhere to go**, as the state read gets them
   * — asked once and kept until tools change ({@link speaking}).
   *
   * `notHer` is the **binding**, not the manifest's promise. A persona plugin with nothing in use
   * still lists `persona.not_her` among what it provides and withholds the tool, so reading the
   * promise drew the button with nobody behind it, and a press was dropped while the screen said
   * *Noted*.
   */
  const who = (): Promise<{ character?: string; notHer: boolean }> =>
    (speaking ??= (async () => {
      const [character, notHer] = await Promise.all([
        chip(),
        plugins.answers(CORE_CAPABILITIES.notHer) ? plugins.offers(CORE_CAPABILITIES.notHer) : false,
      ])
      return { ...(character !== undefined && { character }), notHer }
    })())

  /**
   * One task, asked for by a plugin (M7-5).
   *
   * Everything is the same as a task from the window except where the questions go: there is
   * no stream to write an `ask` to, so a step that needs a yes goes out through
   * {@link CORE_CAPABILITIES.ask} and waits for the answer to come back. With nothing
   * providing it, a question nobody can be shown is a no — which is what it already was, and
   * is why the tools were withheld on that path in the first place.
   *
   * **One task at a time**, which the rest of this file already assumes: one `AbortController`,
   * one pending question. A plugin asking while somebody is working at the keyboard is told
   * so rather than quietly queued behind them or, worse, run alongside them.
   */
  /**
   * The conversation a plugin's messages belong to.
   *
   * **Not the one on screen.** A task started from a phone used to be written into whatever
   * conversation the desktop window happened to be open on, so its replies appeared inside
   * somebody else's chat with no question in front of them — and the message that started it
   * appeared nowhere at all, because the user's turn is appended by whoever received it and
   * nothing had. One session per plugin fixes both: the words land together, in the order
   * they were said, in a row on the Chats screen named after the plugin that carried them.
   *
   * It is looked up rather than held, because a conversation the user deleted must not be
   * appended to — the row is gone, and the next message starts a new one.
   */
  function conversation(pluginId: string): number {
    const held = store.kvGet(CORE, `chat:${pluginId}`)
    if (typeof held === 'number' && store.sessions().some((one) => one.id === held)) return held
    const made = store.createSession(plugins.manifest(pluginId)?.name ?? pluginId)
    store.kvSet(CORE, `chat:${pluginId}`, made)
    return made
  }

  /**
   * The tool behind a plugin's slash command, once something has ruled that it may run.
   *
   * Shared because there are two callers and one meaning: the window's `/api/command`, which
   * asks the person in front of it, and a plugin's own command below, which asks wherever
   * `ask.confirm` is answered. The ruling differs; what running it *is* does not.
   */
  async function commandTool(plugin: string, tool: string, args?: Record<string, unknown>): Promise<string> {
    const process = plugins.process(plugin)
    if (!process) throw new Error(`${plugin} is not running`)
    const result = await process.callTool(tool, args)
    const said = (result.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
      .join('\n')
      .trim()
    if (result.isError === true) throw new Error(said || `${plugin} could not do that`)
    return said || 'Done.'
  }

  /**
   * A fresh conversation for a plugin — what `/new` means from a phone.
   *
   * The window has a button for this and a plugin has nowhere to put one, which is the whole
   * reason the command exists. An empty one is not stacked on, for the same reason pressing
   * *New chat* twice does not make two: the second press means what the first did.
   */
  function freshFor(pluginId: string): Promise<Ran> {
    const open = conversation(pluginId)
    if (store.history(open).length === 0) {
      return Promise.resolve({ ok: true, note: 'This is already a new chat — nothing has been said in it.' })
    }
    store.kvSet(CORE, `chat:${pluginId}`, store.createSession(plugins.manifest(pluginId)?.name ?? pluginId))
    return Promise.resolve({ ok: true, note: 'Started a new chat.' })
  }

  /**
   * A slash command typed somewhere that is not the window.
   *
   * **The same commands, wherever they are typed.** They were reachable from one screen and
   * nowhere else — so a phone could not change the mode, could not reach a plugin's command,
   * and, the one that matters, could not start a new conversation. Every message anybody
   * ever sent from one landed in the same chat carrying every message before it.
   *
   * Checked before the tools flag and before `asTask`, so a command is answered *while* a
   * task is running rather than refused behind it: `/new` is wanted most exactly when
   * something has gone wrong in the conversation you are in.
   */
  async function asCommand(pluginId: string, input: string): Promise<CreateMessageResult> {
    const ran = await runCommand(input, {
      store,
      manifests: manifests(),
      newChat: () => freshFor(pluginId),
      call: async (plugin, tool, args) => {
        const ruling = await rulingFor(plugin, tool)
        if (ruling.verdict === 'blocked') throw new Error(ruling.why ?? `${tool} did not run.`)
        if (ruling.verdict === 'ask') {
          // The same yes, from the same place a task's questions go — and nothing providing
          // it is a no, which is what a question nobody can see already meant (M7-5).
          const asked = await plugins
            .capability(CORE_CAPABILITIES.ask, { question: ruling.why, options: ['Yes', 'No'] })
            .catch(() => undefined)
          const said = (asked?.content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join('')
          if (said.trim().toLowerCase() !== 'yes') throw new Error('Not approved, so nothing ran.')
        }
        return commandTool(plugin, tool, args)
      },
    })
    return { role: 'assistant', model: '', content: { type: 'text', text: ran.note }, stopReason: 'endTurn' }
  }

  /**
   * **What a plugin declared about the model it needs**, both halves of it (M8-1).
   *
   * A function rather than two lines at each call site because there are two sampling paths —
   * one completion, and the whole loop behind the tools flag — and a declaration honoured on
   * one of them is the contract being wrong about itself in a subtler way than never reading
   * it at all. `min_tier` is the manifest's floor; the rest is {@link wantsCapable}'s reading
   * of MCP's `modelPreferences`, which is the whole of what core takes from that field.
   */
  function declaredFor(
    pluginId: string,
    prefs?: Parameters<typeof wantsCapable>[0],
  ): { minTier?: Tier; capable?: boolean } {
    const manifest = plugins.manifest(pluginId)
    return {
      ...(manifest?.min_tier !== undefined && { minTier: manifest.min_tier }),
      ...(wantsCapable(prefs) && { capable: true }),
    }
  }

  async function asTask(
    pluginId: string,
    messages: Message[],
    gaveUp?: AbortSignal,
    behind = true,
    /** What the plugin declared about the model it needs (M8-1) — the same two on either path. */
    declared: { minTier?: Tier; capable?: boolean } = {},
  ): Promise<CreateMessageResult> {
    if (task) throw new Error('Alexia is already working on something. Try again when it has finished.')
    const started = [...messages].reverse().find((m) => m.role === 'user')
    const text = started === undefined ? '' : textOf(started)
    // The same two lines `/api/chat` does before it runs anything: the turn that started
    // this is written down before the answer to it is, or the transcript reads as Alexia
    // talking to itself. The *whole* turn is stored — a picture in it included — while
    // `text` stays the words, because the gate, the trace and the ledger all read that.
    const its = conversation(pluginId)
    if (started !== undefined) store.append(its, { role: 'user', content: started.content })
    const runId = randomUUID()
    const stop = new AbortController()
    task = stop
    trace.start(runId, text)
    try {
      const month = allowance(store)
      // The plugin that started this is where the answer will be read (improvement 9).
      const chosen = await personality(pluginId)
      // What reaches the model is counted per step now, because §2's three lengths mean it can
      // differ between them — the loop reports it through `on.personality`, below.
      if (chosen === undefined) trace.personality(0, 'high')
      const once = (asked: Message[]): ReturnType<typeof run> => run({
        messages: asked,
        tools: tooling,
        pins: pins(store),
        // Whether paid may be crossed into for this conversation: the switch, or a yes on the phone (§4 H).
        world: worldFor(its),
        store,
        secrets,
        session: its,
        run: runId,
        ...(chosen !== undefined && { personality: chosen }),
        // The spend lands on the plugin that asked, exactly as a plain `sampling` call's
        // does — and it is a run now, so it is a paid path like any other task (G12, D96).
        plugin: pluginId,
        // A message from a phone is not the chat on screen: its free requests come second (§4 F).
        ...(behind && { background: true }),
        // The manifest's floor and MCP's own preference, on this path as well as the plain
        // one: the tools flag does not make it a different request (M8-1).
        ...(declared.minTier !== undefined && { minTier: declared.minTier }),
        ...(declared.capable === true && { capable: true }),
        paidAllowed: !month.stop,
        maxSteps: limitsNow().steps,
        // The stop button, and the plugin that started this giving up: either one ends the task.
        signal: gaveUp === undefined ? stop.signal : AbortSignal.any([stop.signal, gaveUp]),
        guard: gate(text, runId),
        // How much of her this step's model was given (§2). The only `on` this path wants:
        // there is no stream here to write a step to, but the record is still worth keeping.
        on: { personality: (chars, size) => trace.personality(chars, size) },
        /**
         * The yes, from wherever the person is.
         *
         * Nothing provides it → the promise rejects → the answer is no, and the loop plans
         * around a refusal the way it plans around any other. That is the honest failure and
         * the one this path had before: a question that cannot be shown has been answered.
         */
        approve: async (ruling) => {
          const asked = await plugins
            .capability(CORE_CAPABILITIES.ask, { question: ruling.why, options: ['Yes', 'No'] })
            .catch(() => undefined)
          const said = (asked?.content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join('')
          return said.trim().toLowerCase() === 'yes'
        },
      })
      let result = await once(messages)
      /**
       * **A pause, asked on the phone** (§4 H). The free models are done and a paid one would answer,
       * with the switch off: the question goes where the person is, as a yes or no, and waits ten
       * minutes. A yes covers this conversation and carries on from where it stopped; no, or no
       * answer, ends the task with the sentence sent back there. With no daily amount there is
       * nothing a yes could buy, so the sentence says where to set one instead of asking.
       */
      if (result.ended === 'paused') {
        const daily = caps(store).daily ?? 0
        const why = result.why ?? 'The free models are used up.'
        if (daily <= 0) {
          result = { ...result, why: `${why} A paid model needs a daily amount first — set one under the paid switch on the Models tab in the app.` }
        } else {
          const yes = await Promise.race([
            plugins
              .capability(CORE_CAPABILITIES.ask, {
                question: `${why} Allow switching to a paid model, up to $${daily.toFixed(2)} today?`,
                options: ['Yes', 'No'],
              })
              .then((asked) => (asked.content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join('').trim().toLowerCase() === 'yes')
              .catch(() => false),
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), options.allowWaitMs ?? 10 * 60_000).unref()),
          ])
          if (yes === true) {
            paidIn.add(its)
            result = await once([...messages, ...result.messages])
          } else {
            result = {
              ...result,
              why:
                yes === false ?
                  `${why} Not allowed, so no paid model was asked.`
                : `${why} Nobody allowed a paid model within ten minutes, so this stopped.`,
            }
          }
        }
      }
      trace.end(result.ended, {
        ...(result.why !== undefined && { why: result.why }),
        calls: store.callsIn(runId),
      })
      const last = result.messages.at(-1)
      const carried = carry(result.steps.flatMap((step) => step.outcome?.files ?? []))
      return {
        role: 'assistant',
        model: last?.model ?? '',
        content: { type: 'text', text: result.why ?? (last === undefined ? '' : textOf(last)) },
        // The files the task made, for a channel that cannot reach `/api/file` from its own
        // process (D122). The window takes them off the step trace instead and needs no
        // `_meta`. A key an older Alexia ignores, exactly like the tools flag before it.
        ...(carried.length > 0 && { _meta: { [FILES_META]: carried } }),
      }
    } catch (error) {
      trace.end('refused', { why: said(error), calls: store.callsIn(runId) })
      throw error
    } finally {
      task = undefined
    }
  }

  /**
   * Read what a task's tools wrote, so a channel plugin can send it on (D122).
   *
   * Same ceilings as an upload and for the same reason — a base64 body is one string in
   * memory whichever door it goes through. A file that is gone, or over the bar, is dropped:
   * the answer's words still arrive, and it is the words that carried the meaning.
   */
  function carry(files: readonly Produced[]): { name: string; mime: string; data: string }[] {
    const out: { name: string; mime: string; data: string }[] = []
    let together = 0
    for (const file of files.slice(0, MOST_FILES)) {
      try {
        const bytes = readFileSync(file.path)
        if (bytes.length === 0 || bytes.length > MOST_PER_FILE) continue
        if (together + bytes.length > MOST_TOGETHER) break
        together += bytes.length
        out.push({ name: file.name, mime: file.mime, data: bytes.toString('base64') })
      } catch {
        // The tool named a file that is no longer there. Not this path's problem to explain.
      }
    }
    return out
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' })
      response.end(String(error))
    })
  })

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // The request target read as a path and only as a path. Resolving it *against* an origin
    // instead of pasting it onto one lets `//app.css` be a protocol-relative URL — host
    // `app.css`, path `/`, so every path answers with the shell — and `//` on its own has no
    // host at all and throws, which is a 500 for a request that should be a plain refusal.
    // Found by the packaged build's smoke test, which was joining its URLs badly.
    const target = request.url ?? '/'
    const url = new URL(`http://127.0.0.1${target.startsWith('/') ? target : `/${target}`}`)
    // Any other compiled shell module, by name only. The pattern is the whole of the
    // defence: no dots, no slashes, so there is nothing to climb out of `dist/src` with.
    const module = /^\/([a-z][a-z0-9-]*)\.js$/.exec(url.pathname)
    const asset =
      STATIC[url.pathname] ??
      (module ? ([join('dist', 'src', `${module[1]!}.js`), 'text/javascript; charset=utf-8'] as const) : undefined)
    if (asset && existsSync(join(ui, asset[0]))) {
      const [file, type] = asset
      const bytes = readFileSync(join(ui, file))
      // Text assets carry the token; anything else is passed through untouched, because
      // decoding a PNG as UTF-8 to run a string replace over it returns a broken PNG.
      const body = type.startsWith('text/') ? bytes.toString('utf8').replace('__TOKEN__', token) : bytes
      response.writeHead(200, { 'content-type': type })
      response.end(body)
      return
    }

    // Everything past here reads history or spends money.
    if (request.headers['x-alexia-token'] !== token || !(request.headers.host ?? '').startsWith('127.0.0.1')) {
      response.writeHead(403, { 'content-type': 'text/plain' })
      response.end('not for you')
      return
    }

    /**
     * The body, read and parsed once, here rather than in each handler — because the guard
     * below has to see it before the route does, and a stream can only be drained once.
     *
     * Bad JSON is a refusal rather than a 500. It used to be one of those instead of the
     * other in every handler independently, which is the same accident twelve times.
     */
    let sent: Body = {}
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      try {
        const parsed: unknown = JSON.parse(await read(request))
        if (typeof parsed === 'object' && parsed !== null) sent = parsed as Body
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, said: 'That request body is not JSON.' }))
        return
      }
    }

    /**
     * Guarded, or declared safe with a written reason, and there is no third kind (M6-1).
     *
     * It runs *before* dispatch on purpose. A confirm each handler had to remember to ask
     * for is a confirm the thirteenth handler will not ask for — this way a route that
     * nobody has classified is refused rather than run, and `guard.test.ts` walks the real
     * routes so the classification cannot quietly fall behind the file.
     */
    const refusal = refuse(url.pathname, request.method ?? 'GET', sent)
    if (refusal) {
      response.writeHead(refusal.status, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, said: refusal.said, ...(refusal.confirmable && { confirm: true }) }))
      return
    }

    if (url.pathname === '/api/state') {
      const month = allowance(store)
      const keyed = await connected()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          setup: setup(),
          /**
           * What this build is (D121).
           *
           * Sent with every state read rather than fetched from the shelf, because the About
           * page must be able to answer *which version am I running* with the network down —
           * which is exactly when somebody is most likely to be asking.
           */
          app: APP_VERSION,
          // Everything you could type right now, and the pins those commands set. The
          // shell shows both as controls: a command is a shortcut, never the only route.
          commands: commands(manifests()),
          pins: { ...pins(store), placement: undefined },
          messages: store.history(session),
          spent: month.spent,
          cap: month.cap,
          warning: warning(month),
          // Today's side of the same question, and the one that decides whether the router
          // may reach across the price line on its own at all.
          today: today(store),
          /**
           * **Who is answering, and whether there is anything to say she was not her**
           * (`plan-personality.md` improvements 8 and 10).
           *
           * The chip in the chat header is the name of the personality in use, and the whole
           * point of it is that *which one is on* stops being a settings screen away. Absent
           * when none is chosen, which is Alexia's own voice and not a chip saying so.
           *
           * `notHer` is whether anything will listen if somebody presses *That wasn't her* —
           * the button is not drawn otherwise, which is the honest version of *there is
           * nothing here this would tell*. Resolved by capability; core never learns who.
           * Both come from {@link who}, which keeps them until a plugin's tools change.
           */
          ...(await who()),
          // The paid switch (§4 H), so the screen can say above the message box that paid is on.
          cross: caps(store).cross === true,
          // The permission controls, and what is standing. Every one of these is a control
          // in the shell, not only a command — same rule as M1-12.
          ceilings: limitsNow(),
          permissions: {
            mode: scope().mode,
            modes: MODE_LABELS,
            roots: scope().roots,
            everywhere: scope().everywhere === true,
            boundaries: scope().boundaries,
          },
          // What the mode picker has to be honest about: nobody has read these terms yet,
          // and a flag that guesses would be worse than the awkward truth (D51).
          providers: await Promise.all(
            providers.map(async (p) => ({
              id: p.id,
              name: p.name,
              terms: p.terms,
              trainsOnYourData: p.trainsOnYourData ?? 'unknown',
              free: p.rpd !== undefined || p.rpm !== undefined,
              /**
               * **What the key wall puts on a tile face** (§12.2): the published limits, the
               * date somebody last checked them, and the two things that cost a person a
               * minute before a key exists at all.
               *
               * Sent as the row has them rather than as a sentence, because the screen is
               * where a number turns into words — and because a row with no limits published
               * has to read as *not published* rather than as zero.
               */
              ...(p.rpm !== undefined && { rpm: p.rpm }),
              ...(p.rpd !== undefined && { rpd: p.rpd }),
              ...(p.callsPerMonth !== undefined && { callsPerMonth: p.callsPerMonth }),
              ...(p.verified !== undefined && { verified: p.verified }),
              ...(p.friction !== undefined && { friction: p.friction }),
              ...(p.wantsCard === true && { card: true }),
              /** Answers without a key at all, which is the tier the Skip button lands on. */
              keyless: (p.auth ?? 'required') !== 'required',
              /** Its account id goes in the URL, so the key it wants is `account_id:token`. */
              account: p.baseUrl.includes('{account}'),
              // Whether there is a key for it, never the key. The settings screen is where a
              // key gets replaced, and a box that looks identical either way is a box nobody
              // can tell they already filled in.
              connected: keyed.has(p.id),
            })),
          ),
        }),
      )
      return
    }

    if (url.pathname === '/api/setup' && request.method === 'POST') {
      const chosen = sent as {
        name?: string
        mode?: keyof typeof MODES
        theme?: string
        glass?: number
        updates?: boolean
        /** A key to store, or `remove` to take the stored one out of the keychain (§1 step 4). */
        provider?: { id: string; key?: string; remove?: boolean }
      }
      if (chosen.name) store.kvSet(CORE, 'display_name', chosen.name)
      if (chosen.mode && chosen.mode in MODES) store.kvSet(CORE, 'mode', chosen.mode)
      // Checked against the list rather than kept as typed. The shell only ever sends one of
      // three, and a fourth word stored here would reach the root element as `data-theme` and
      // match neither override — light on a dark desktop, with nothing on any screen saying
      // why. The list is short enough to be the check.
      if (chosen.theme && THEMES.includes(chosen.theme)) store.kvSet(CORE, 'theme', chosen.theme)
      // Clamped, not trusted: it reaches the page as a `--glass-tint` percentage, and a value
      // outside 40–100 is either an unreadable pane or a solid one that nothing said to make.
      if (typeof chosen.glass === 'number' && Number.isFinite(chosen.glass)) {
        store.kvSet(CORE, 'glass', Math.min(100, Math.max(0, Math.round(chosen.glass))))
      }
      // Whether to look for a newer Alexia at startup (D121). Stored beside the theme because
      // it is the same kind of fact: an answer about this install that outlives the window it
      // was given in.
      if (typeof chosen.updates === 'boolean') store.kvSet(CORE, 'updates_auto', chosen.updates)
      /** What happened to a key, as the one line the screen shows where it was pressed (§1). */
      let said: string | undefined
      if (chosen.provider?.key) {
        const provider = providers.find((p) => p.id === chosen.provider?.id)
        /**
         * A key is a token, and a token has no spaces in it. Anything else is a sentence
         * that landed in the box by accident — and the one that lands there most is the
         * screen's own hint, copied out to ask somebody why the key would not save and
         * pasted back over the key. That is not hypothetical: it is how this check got
         * written.
         *
         * The box is the only place this is catchable. A stored sentence is a valid string
         * all the way down: it reaches the provider as a Bearer token, and the answer comes
         * back as a 401 about a header, three screens from the paste that caused it and
         * naming nothing a person could act on.
         *
         * Whitespace only, deliberately. Every provider here issues an opaque token, and no
         * two agree on its length or prefix — a stricter rule would be guessing at formats
         * that change without telling us, and rejecting somebody's real key is worse than
         * accepting a wrong one.
         */
        if (/\s/.test(chosen.provider.key)) {
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end(
            JSON.stringify({
              ok: false,
              said: 'That does not look like a key — it has spaces in it. Copy the key itself and paste it again.',
            }),
          )
          return
        }
        // Straight to the keychain, never to the database — the same path a plugin's
        // password takes, and the same check proves it.
        if (provider) {
          await secrets.set(CORE, keyOf(provider), chosen.provider.key)
          // And its list, now that there is something to ask with. Four of the six refuse an
          // unauthenticated request, so this is the moment their models become knowable at
          // all. **Waited for** (§1 step 3), so the answer can say what the key unlocked and
          // the shell can redraw the list with it in — it used to be fired and forgotten, and
          // the Models tab opened straight after showed the provider with nothing in it.
          said = await connectedNow(provider, chosen.provider.key)
        }
      } else if (chosen.provider?.remove === true) {
        const provider = providers.find((p) => p.id === chosen.provider?.id)
        if (provider) said = await disconnect(provider)
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ...setup(), ...(said !== undefined && { said }) }))
      return
    }

    /**
     * A slash command (M1-12), and the gate it was missing.
     *
     * Core's own commands set a mode or a pin, and both are one word to change back. A
     * plugin's command is something else entirely — **a tool call under a short name** — and
     * it was reaching `callTool` with nothing in between, while the identical call from an
     * action button and from the loop both went through `rule()`. Classifying this route for
     * M6-1 is what found it: there was no sentence that made it safe, because it was not.
     *
     * Asked in two steps rather than by blocking, exactly as `/api/action` is: this request
     * carries no stream to put a question down, so the first call answers `ask` and the
     * second carries the person's yes. `blocked` has no second call.
     */
    if (url.pathname === '/api/command' && request.method === 'POST') {
      const { input, approved } = sent as { input?: string; approved?: boolean }
      let asked: Ruling | undefined
      /** Whether the conversation on screen is no longer the one this window is showing. */
      let moved = false
      const ran = await runCommand(input ?? '', {
        store,
        manifests: manifests(),
        // The conversation on screen, which is the one whoever typed this is looking at —
        // and the same action the Chats screen's button runs, rather than a second copy of
        // *what a new conversation is* waiting to disagree with the first.
        newChat: async () => {
          const before = session
          const said = await ourActions.new_chat!('')
          moved = session !== before
          return { ok: said.ok, note: said.said }
        },
        // A command is bound to the plugin tool of the same name — the whole binding, and
        // why a manifest declares a command with a name and a sentence and nothing else.
        // Whatever followed the word rides along under `rest`, unread by core (D177).
        call: async (plugin, tool, args) => {
          const ruling = await rulingFor(plugin, tool)
          if (ruling.verdict === 'blocked' || (ruling.verdict === 'ask' && approved !== true)) {
            asked = ruling
            throw new Error(ruling.why ?? `${tool} did not run.`)
          }
          return commandTool(plugin, tool, args)
        },
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          ...ran,
          // A question, not a refusal — the shell puts it to the person and sends the same
          // command back with their answer. A `blocked` ruling never gets one.
          ...(asked?.verdict === 'ask' && { ask: asked.why }),
          // `/new` moved the conversation out from under the window, so what is on screen
          // is last conversation's log. The shell repaints rather than waiting for the next
          // thing that happens to redraw it.
          ...(moved ? { moved: true } : {}),
          setup: setup(),
          pins: { ...pins(store), placement: undefined },
        }),
      )
      return
    }

    if (url.pathname === '/api/permissions' && request.method === 'POST') {
      const asked = sent as {
        mode?: Mode
        roots?: string[]
        everywhere?: boolean
        lift?: boolean
      }
      const now = scope()
      store.kvSet(CORE, 'scope', {
        mode: asked.mode && asked.mode in MODE_LABELS ? asked.mode : now.mode,
        roots: asked.roots ?? now.roots,
        everywhere: asked.everywhere ?? now.everywhere === true,
      })
      // Lifting a boundary is a control as well as a sentence, because a rule you cannot
      // find the off switch for is a rule that gets worked around instead.
      if (asked.lift === true) store.kvSet(CORE, 'boundaries', [])
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ mode: scope().mode, roots: scope().roots, everywhere: scope().everywhere === true, boundaries: scope().boundaries }))
      return
    }

    if (url.pathname === '/api/ceilings' && request.method === 'POST') {
      const asked = sent as Partial<Ceilings> & { daily?: number }
      // Both ceilings editable, and the preview threshold with them — a leash you cannot
      // shorten is not a leash, it is a decision somebody else made for you.
      setCeilings(store, {
        ...(typeof asked.steps === 'number' && asked.steps > 0 && { steps: Math.floor(asked.steps) }),
        ...(typeof asked.monthly === 'number' && { monthly: asked.monthly }),
        ...(typeof asked.askAbove === 'number' && asked.askAbove >= 0 && { askAbove: asked.askAbove }),
      })
      /**
       * The daily allowance, edited on the same screen as the other two and stored with the
       * spend ledger rather than with the leash — because it is not a limit on something
       * already happening, it is the permission for it to happen at all. Zero is a real
       * value here and the default one, so it is written whenever it is sent.
       */
      if (typeof asked.daily === 'number' && asked.daily >= 0) {
        setCaps(store, { ...caps(store), daily: asked.daily })
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ...limitsNow(), ...today(store) }))
      return
    }

    if (url.pathname === '/api/stop' && request.method === 'POST') {
      // Works mid-step, always. An open permission question is settled as a no on the way
      // out, because a stopped task must not leave the next one waiting on it.
      task?.abort()
      pending?.(false)
      pending = undefined
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ stopping: task !== undefined }))
      return
    }

    if (url.pathname === '/api/approve' && request.method === 'POST') {
      const { allowed } = sent as { allowed?: boolean }
      const waiting = pending
      pending = undefined
      waiting?.(allowed === true)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: waiting !== undefined }))
      return
    }

    /**
     * Every installed plugin's settings pane, plus the folders that are not plugins (M2-1).
     *
     * A GET, and a cheap one: it reads manifests, the store and the keychain, and **spawns
     * nothing**. That is the whole reason the widget schema lives in `plugin.json` — with
     * lazy spawn, "not running" is the ordinary state of a plugin, and a screen that woke
     * three processes to draw itself would wake them every time somebody looked.
     */
    if (url.pathname === '/api/plugins') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          panes: await plugins.panes(),
          problems: plugins.problems,
          skills: skills.all,
          // Which of these arrived through compatibility mode (M3-6). The pane draws the
          // warning from this, and the *trust it* control that is the only way out.
          unreviewed: [...unreviewed(store)],
          // Broken skills ride the same list as broken plugin folders, because they are the
          // same sentence to the same person: this folder is here and is doing nothing.
          skillProblems: skills.problems,
        }),
      )
      return
    }

    /**
     * The control surface's tab list (M6-2, narrowed by D118).
     *
     * Core's own tabs and nothing else. A plugin's panel used to arrive here as a tab of its
     * own and is now the second half of its page on `/api/plugins`, because one plugin with
     * two homes is one of them being the wrong guess. The shell still draws whatever comes
     * back and writes none of it down.
     *
     * A GET, and it spawns nothing, for the same reason `/api/plugins` does not.
     */
    if (url.pathname === '/api/panels') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ tabs: coreTabs({ store }) }))
      return
    }

    /**
     * The command palette (M6-10). Ctrl+K, type, jump.
     *
     * **One endpoint over each source's existing read path**, scored and merged. There is no
     * second index to keep in step with four sources of truth, and no dependency — exact
     * beats starts-with beats substring beats subsequence is fifteen lines, and this is
     * ranking four short in-memory lists rather than tuning relevance.
     *
     * **It navigates; it does not execute.** What comes back is a tab and a word to filter
     * by. Slash commands already run things, and a palette that also did would be a second
     * command system with a different permission story.
     */
    if (url.pathname === '/api/search') {
      const asked = url.searchParams.get('q') ?? ''
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ hits: search(asked, await searchable(surface, coreTabs({ store }))) }))
      return
    }

    /**
     * The lifecycle, in one endpoint (M2-5).
     *
     * `enable` is the moment of consent — the screen has just shown what this plugin asked
     * for, in its author's words — and `disable` is its cheap opposite: the process stops and
     * everything it owns stays. `delete` is the one that removes things, which is why the
     * screen puts it a step further back and why invariant 5 is the check that guards it.
     */
    if (url.pathname === '/api/plugin' && request.method === 'POST') {
      const asked = sent as { id?: string; action?: string }
      const id = asked.id ?? ''
      if (plugins.manifest(id) === undefined) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, said: `There is no plugin called “${id}”.` }))
        return
      }
      if (asked.action === 'enable') plugins.enable(id)
      else if (asked.action === 'disable') await plugins.disable(id)
      else if (asked.action === 'delete') await plugins.purge(id)
      else {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, said: `“${asked.action ?? ''}” is not something to do to a plugin.` }))
        return
      }
      skills.invalidate()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, panes: await plugins.panes(), skills: skills.all }))
      return
    }

    /**
     * Install: a folder somebody points at, checked and copied in.
     *
     * Crude on purpose — the library that makes this a browse-and-click is M3-2, and until
     * there is a registry there is nowhere else for a plugin to come from. It arrives
     * **installed and not enabled**, so the next thing the person sees is what it asked for.
     */
    if (url.pathname === '/api/install' && request.method === 'POST') {
      const { path } = sent as { path?: string }
      const done = plugins.install((path ?? '').trim())
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify(
          'reason' in done ?
            { ok: false, said: done.reason }
          : { ok: true, id: done.id, said: `${done.id} is installed. Read what it asked for, then enable it.`, panes: await plugins.panes() },
        ),
      )
      return
    }

    /**
     * The library (M3-2): what the registry lists, and what is already here.
     *
     * A network call, so it says what went wrong rather than answering an empty list — a
     * library that silently shows nothing when the registry is unreachable is a library
     * that looks broken and is not.
     */
    if (url.pathname === '/api/library') {
      const installed = new Set(plugins.ids)
      const here = new Set(skills.all.map((skill) => skill.name))
      try {
        const [available, offered, pulled] = await Promise.all([
          library.plugins(),
          library.skills().catch(() => []),
          library.revoked().catch(() => ({ plugins: [], skills: [] })),
        ])
        /**
         * What is here that has a newer version out, and what that update needs (M5-4, D118).
         *
         * The protocol window used to be passed in from this line; it is inside `offerable`
         * now, with the app-version range, because *can this build run it* had grown two
         * answers in two files and a screen has to say one sentence about it.
         */
        const updates = await library
          .updates(
            plugins.ids.flatMap((id) => {
              const manifest = plugins.manifest(id)
              return manifest ? [{ id, version: manifest.version }] : []
            }),
          )
          .catch(() => [])

        const shelf = available.map((entry) => ({ ...entry, offer: offerable(entry) }))
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            ok: true,
            registry: library.url,
            /** What this build is. The screen says it out loud when something needs a newer one. */
            app: APP_VERSION,
            // Whether a signature can be checked at all. `false` is shown, because an
            // unverified signature is exactly as good as none and must not look better.
            verifying: library.publisherKey !== undefined,
            plugins: shelf
              .filter((entry) => entry.offer === 'ok')
              .map((entry) => ({ ...entry, installed: installed.has(entry.id) })),
            updates: updates
              .filter((row) => row.offer === 'ok')
              .map(({ id, from, to }) => ({ id, from, to })),
            /**
             * The count that turns a missing plugin into something a person can act on.
             *
             * Not a list. Naming plugins somebody cannot install yet is a shop window for a
             * shop that is shut; the number plus *update Alexia* is the whole of what is
             * actionable, and the list arrives with the update that makes it real.
             */
            needsNewerApp: {
              plugins: shelf.filter((entry) => entry.offer === 'newer-app' && !installed.has(entry.id)).length,
              updates: updates.filter((row) => row.offer === 'newer-app').length,
            },
            skills: offered.map((entry) => ({ ...entry, installed: here.has(entry.name) })),
            // Only the ones this machine actually has. A list of everything ever withdrawn
            // is a list nobody reads.
            revoked: pulled.plugins.filter((row) => installed.has(row.id)),
          }),
        )
      } catch (error) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            ok: false,
            registry: library.url,
            app: APP_VERSION,
            why: `Could not reach the plugin shelf: ${error instanceof Error ? error.message : String(error)}`,
          }),
        )
      }
      return
    }

    if (url.pathname === '/api/library/install' && request.method === 'POST') {
      const asked = sent as { id?: string; kind?: string; update?: boolean; enable?: boolean }
      // Updating stops the running process first. Replacing the folder underneath a live
      // plugin on Windows fails on the files it has open, and the half-replaced folder that
      // leaves behind is worse than the version it was replacing.
      if (asked.update === true) await plugins.disable(asked.id ?? '')
      // Pressing Install having read what it is *is* the yes — it just arrives before the
      // folder does. Written before the download, because the answer is about the decision
      // and not about whether the network worked; an unspent one is consumed by the folder
      // that turns up under that name, and by nothing else (M6-9).
      if (asked.kind === 'skill') preauthorise(store, asked.id ?? '')
      const done =
        asked.kind === 'skill' ?
          await library.installSkill(asked.id ?? '')
        : await library.install(asked.id ?? '', undefined, asked.update === true)
      // Back on, but only if it was on: an update is not consent to run something that was
      // sitting there disabled.
      if (asked.update === true && done.ok) plugins.enable(asked.id ?? '')
      // First run's picker, and nothing else, asks for this (D118). Installed-and-not-enabled
      // is still where a plugin arrives everywhere a person installs one at a time; a screen
      // that showed four plugins' `requires` sentences and took four ticks has already had the
      // conversation D73 is about, and leaving all four inert afterwards would be an assistant
      // that quietly did not do the thing it was just asked to do.
      if (asked.enable === true && done.ok) plugins.enable(asked.id ?? '')
      if (done.ok) plugins.load()
      skills.invalidate()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify(
          done.ok ?
            {
              ok: true,
              said:
                'name' in done ?
                  `${done.name} is installed and Alexia can read it now.`
                : `${done.id} is installed${done.signature === 'verified' ? ', signature checked' : done.signature === 'unverified' ? ' — it is signed, but no publisher key is configured to check against' : ''}. Read what it asked for, then enable it.`,
              panes: await plugins.panes(),
              skills: skills.all,
            }
          : { ok: false, said: done.why },
        ),
      )
      return
    }

    /**
     * MCP compatibility mode (M3-6): any MCP server, as a tool source.
     *
     * `add` probes it before writing a folder, so a typo'd command fails here with the
     * operating system's own words. `trust` is the deliberate act that stops core treating
     * every one of its tools as destructive — a decision with a person behind it, which is
     * the only shape that answer should ever take.
     */
    if (url.pathname === '/api/server' && request.method === 'POST') {
      const asked = sent as {
        id?: string
        name?: string
        run?: string
        args?: string[]
        action?: string
      }
      if (asked.action === 'trust') {
        markReviewed(store, asked.id ?? '')
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true, unreviewed: [...unreviewed(store)], panes: await plugins.panes() }))
        return
      }
      const done = await addServer(
        {
          id: asked.id ?? '',
          ...(asked.name !== undefined && { name: asked.name }),
          run: asked.run ?? '',
          ...(asked.args && { args: asked.args }),
        },
        { store, pluginsDir: extensions },
      )
      if (!('why' in done)) plugins.load()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify(
          'why' in done ?
            { ok: false, said: done.why }
          : {
              ok: true,
              said: `${done.id} answered — MCP ${done.speaks}, ${String(done.tools)} tool${done.tools === 1 ? '' : 's'}. Nobody has reviewed it, so every one of them will be asked about until you say otherwise.`,
              panes: await plugins.panes(),
              unreviewed: [...unreviewed(store)],
            },
        ),
      )
      return
    }

    /**
     * The answer to the offer (M4-5), and the two things a learned skill needs afterwards.
     *
     * `learn` distils the last episode into a skill and saves it. `forget` deletes one.
     * `edit` rewrites one. All three are here rather than on the settings screen because
     * all three are things a person wants to do **at the moment the skill fired**, which is
     * in the middle of a conversation and not in a list.
     */
    if (url.pathname === '/api/learn' && request.method === 'POST') {
      const asked = sent as { action?: string; name?: string; text?: string }

      if (asked.action === 'forget') {
        const gone = forget(skillsDir, asked.name ?? '')
        skills.invalidate()
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: gone, said: gone ? `Forgotten. ${asked.name ?? ''} is gone.` : 'There is no skill by that name.' }))
        return
      }

      if (asked.action === 'edit') {
        const skill = skills.all.find((one) => one.name === asked.name && one.learned === true)
        if (!skill) {
          response.writeHead(200, { 'content-type': 'application/json' })
          // Only a learned one. A skill somebody installed belongs to whoever wrote it, and
          // rewriting it in place would silently fork it under its own name.
          response.end(JSON.stringify({ ok: false, said: 'That is not a skill Alexia wrote, so it is not editable here.' }))
          return
        }
        if (typeof asked.text === 'string' && asked.text.trim() !== '') {
          writeFileSync(join(skill.dir, 'SKILL.md'), asked.text.trim() + '\n')
          skills.invalidate()
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: true, said: 'Saved.' }))
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true, text: readFileSync(join(skill.dir, 'SKILL.md'), 'utf8') }))
        return
      }

      const episode = lesson
      lesson = undefined
      if (!episode) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, said: 'There is nothing waiting to be learned.' }))
        return
      }
      const month = allowance(store)
      const learned = await distil(episode, {
        store,
        secrets,
        pins: pins(store),
        world,
        paidAllowed: !month.stop,
      })
      if ('why' in learned) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, said: learned.why }))
        return
      }
      // The task it came out of goes with it (M6-4): a week later, that is the only thing
      // that can say where a skill Alexia wrote came from.
      save(skillsDir, learned, episode.task)
      // Written at creation, which is the only moment anything knows this for certain
      // (M6-9). No preauth is spent and none is written: **nobody asked for this skill**,
      // which is the entire reason the ladder reaches skills at all.
      record(store, learned.name, 'learned')
      skills.invalidate()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          ok: true,
          name: learned.name,
          said: `Learned: ${learned.name}. ${learned.description}`,
        }),
      )
      return
    }

    if (url.pathname === '/api/settings' && request.method === 'POST') {
      const edit = sent as { plugin?: string; key?: string; value?: unknown }
      try {
        await plugins.setSetting(edit.plugin ?? '', edit.key ?? '', edit.value)
      } catch (error) {
        // The refusal is a sentence about this value, written to be shown beside the control
        // that produced it. It is an answer, not a stack trace.
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, why: error instanceof Error ? error.message : String(error) }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, panes: await plugins.panes() }))
      return
    }

    /**
     * A `file` widget, filled.
     *
     * The same shape `/api/chat` sends an attachment in — a name and base64 — for the same
     * reason: `node:http` has no multipart parser, and the webview has bytes rather than a
     * path. What differs is where they go and how long they stay: an attachment is read and
     * deleted in one breath, and this one is a value, so it is written inside the plugin's own
     * folder and the path becomes the widget's stored value.
     *
     * A separate route rather than `/api/settings`, because the value core keeps is not the
     * value the page sent — `refuse()` turns a `file` away for exactly that reason.
     */
    if (url.pathname === '/api/upload' && request.method === 'POST') {
      const got = sent as { plugin?: string; key?: string; name?: string; data?: string }
      try {
        const answer = await plugins.upload(got.plugin ?? '', got.key ?? '', {
          name: String(got.name ?? 'file'),
          data: String(got.data ?? ''),
        })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify(
            'refused' in answer ?
              { ok: false, why: answer.refused }
            : { ok: true, path: answer.path, panes: await plugins.panes() },
          ),
        )
      } catch (error) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, why: error instanceof Error ? error.message : String(error) }))
      }
      return
    }

    /**
     * An `action` button, pressed.
     *
     * The permission gate is the same one every tool call goes through: a destructive tool is
     * asked about in every mode except Full trust, and the never-touch list is not negotiable
     * in any of them. It is asked in two steps rather than by blocking, because this request
     * carries no stream to ask down — the first call answers `ask`, the screen puts the
     * question to the person, and the second call carries their answer. `blocked` has no
     * second call: that is the difference between a question and a floor.
     */
    /**
     * ***That wasn't her*** (`plan-personality.md` improvement 10), pressed under the latest
     * answer, beside *Bad answer* and asking the opposite question.
     *
     * **It does not ask the question again**, and that is the whole difference. *Bad answer*
     * says the answer was wrong, so the answer is thrown away and something else is asked;
     * this says the answer was hers to give and did not sound like her, so the answer stays on
     * the page and what changes is the personality — later, deliberately, through Refine.
     *
     * **Core hands it over and forgets it.** The mark is about a plugin's document, so it goes
     * out under a capability name and core never learns who took it, never reads it back, and
     * never fails the press on the strength of it: a button that sometimes errors for reasons
     * about a plugin is a button people stop pressing.
     */
    if (url.pathname === '/api/not-her' && request.method === 'POST') {
      const { said } = sent as { said?: string }
      const line = typeof said === 'string' && said.trim() !== '' ? said.trim().slice(0, 500) : undefined
      response.writeHead(200, { 'content-type': 'application/json' })
      /**
       * **A line typed after the press is about the answer that was pressed**, not about whatever
       * is newest by the time somebody finishes typing it. The box stays open under its answer
       * while the conversation carries on, so the follow-up reuses the pair the press sent; the
       * plugin reads a second call about the same answer as the same moment, filled in.
       */
      let pair = line !== undefined && pressed?.session === session ? pressed : undefined
      if (pair === undefined) {
        const history = store.history(session)
        const answer = [...history].reverse().find((turn) => turn.role === 'assistant' && (turn.calls?.length ?? 0) === 0)
        if (answer === undefined) {
          response.end(JSON.stringify({ ok: false, said: 'There is no answer to mark yet.' }))
          return
        }
        // The turn it was answering, because an example is a pair: what she was asked, and the
        // thing she said that did not sound like her. One on its own teaches nothing.
        const at = history.lastIndexOf(answer)
        const asked = [...history.slice(0, at)].reverse().find((turn) => turn.role === 'user')
        pair = { session, answer: textOf(answer).slice(0, 2000), ...(asked !== undefined && { asked: typedOf(asked).slice(0, 500) }) }
      }
      pressed = pair
      const heard = await plugins
        .capability(CORE_CAPABILITIES.notHer, {
          answer: pair.answer,
          ...(pair.asked !== undefined && { asked: pair.asked }),
          ...(line !== undefined && { said: line }),
        })
        .then((result) => result.isError !== true)
        .catch((error: unknown) => {
          console.error(`[not-her] ${error instanceof Error ? error.message : String(error)}`)
          return false
        })
      // Still `ok`: a press never fails on the strength of a plugin. `heard` is the other half —
      // whether anything kept it — so the screen does not say *Noted* over a mark nobody took.
      response.end(JSON.stringify({ ok: true, heard }))
      return
    }

    if (url.pathname === '/api/action' && request.method === 'POST') {
      const press = sent as { plugin?: string; key?: string; row?: string; approved?: boolean }
      const plugin = press.plugin ?? ''

      // A row action on one of core's own tables (M6-4). No plugin, so no `rule()` — the
      // gate for core acting on core's own data is the route guard, which is why this one
      // needs an explicit `confirm` and the plugin half does not (M6-1).
      if (plugin === '') {
        const act = ourActions[press.key ?? '']
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify(
            act === undefined ?
              { ok: false, said: `There is no button called "${press.key ?? ''}".` }
            : await act(press.row ?? ''),
          ),
        )
        return
      }

      const manifest = plugins.manifest(plugin)
      // Either screen, and either kind. **A row action is an `action`** (D83): the same
      // lookup, the same gate, the same two steps. The only difference is that it carries
      // the row it is about, and the question appears beside that row rather than a button.
      const declared = manifest && declaredAction(manifest, press.key ?? '')
      if (!declared) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, said: `There is no button called "${press.key ?? ''}".` }))
        return
      }

      const ruling = await rulingFor(plugin, declared.tool)
      if (ruling.verdict === 'blocked' || (ruling.verdict === 'ask' && press.approved !== true)) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify(
            ruling.verdict === 'blocked' ? { ok: false, said: ruling.why } : { ok: false, ask: ruling.why },
          ),
        )
        return
      }

      // A press that does not fit its declaration — a row action with no row, or a plain
      // button handed one — is a sentence rather than a 500. The screen shows it beside the
      // control, which is where somebody can do something about it.
      pressing.set(plugin, (pressing.get(plugin) ?? 0) + 1)
      const result = await plugins
        .action(plugin, press.key ?? '', undefined, press.row)
        .catch((error: unknown) => ({ ok: false, said: error instanceof Error ? error.message : String(error) }))
        .finally(() => pressing.set(plugin, (pressing.get(plugin) ?? 1) - 1))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ...result, panes: await plugins.panes() }))
      return
    }

    /**
     * A `table` filling itself in, and what expands under one of its rows (M6-3).
     *
     * **This is where a panel starts a process, and the only place it does.** Drawing the
     * panel reads manifests and the store; opening it is a person asking for the contents,
     * which is a tool call like any other and goes through the gate like any other. A `rows`
     * tool that has not declared itself read-only is asked about — the author's problem to
     * fix, and not core's to guess around.
     */
    if ((url.pathname === '/api/rows' || url.pathname === '/api/detail') && request.method === 'POST') {
      const asked = sent as { plugin?: string; key?: string; row?: string; approved?: boolean }
      const plugin = asked.plugin ?? ''

      // Core's own tables (M6-4). They read what core already holds, so there is no process
      // to start and nothing to ask permission for — the reading is the screen.
      if (plugin === '') {
        const source = ours[asked.key ?? '']
        const answer =
          source === undefined ? { said: `There is no list called "${asked.key ?? ''}".` }
          : url.pathname === '/api/rows' ? { rows: await source.rows(), ...(source.note?.() !== undefined && { note: source.note() }) }
          : { text: (await source.detail?.(asked.row ?? '')) ?? 'There is nothing more to say about that.' }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify('said' in answer ? { ok: false, ...answer } : { ok: true, ...answer }))
        return
      }

      const manifest = plugins.manifest(plugin)
      const table = manifest && declaredTable(manifest, asked.key ?? '')
      const wanted = url.pathname === '/api/rows' ? table?.rows : table?.detail
      if (wanted === undefined) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, said: `There is no list called "${asked.key ?? ''}".` }))
        return
      }

      const ruling = await rulingFor(plugin, wanted)
      if (ruling.verdict === 'blocked' || (ruling.verdict === 'ask' && asked.approved !== true)) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify(
            ruling.verdict === 'blocked' ? { ok: false, said: ruling.why } : { ok: false, ask: ruling.why },
          ),
        )
        return
      }

      const answer = await (
        url.pathname === '/api/rows' ?
          plugins.rows(plugin, asked.key ?? '')
        : plugins.detail(plugin, asked.key ?? '', asked.row ?? '')
      ).catch((error: unknown) => ({ why: error instanceof Error ? error.message : String(error) }))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify('why' in answer ? { ok: false, said: answer.why } : { ok: true, ...answer }))
      return
    }

    /**
     * A file some tool made, on its way back to the person who asked for it.
     *
     * **The id is the whole design.** There is no path in either request, so there is no
     * traversal to defend against and no prefix to check: the string a caller sends is a key
     * into a map of files that tools offered during this run, and a key that is not in it is
     * a 404. A path could be pointed at anything on the disk; this cannot be pointed at all.
     *
     * `?id=` rather than `/api/file/<id>` for a reason that is about this repo rather than
     * about REST: `guard.test.ts` walks this file for the literal path comparisons below and
     * demands a classification for each one it finds. A path with a variable segment in it
     * would slip past that scanner — and a route the guard cannot see is exactly the hole
     * that test exists to close. It caught this comment quoting the pattern, which is a fair
     * indication it is reading the file rather than agreeing with itself.
     */
    /**
     * A picture an `image` widget is showing (D115's successor, `alexia_protocol` 5).
     *
     * **The boundary is the whole route.** `/api/file` serves what a *tool result* offered, by
     * id, which is a list core wrote down. A widget's rows are different: the plugin names the
     * paths, and serving whatever it names would turn this into a general file reader that any
     * plugin can point anywhere — at the keychain database, at somebody’s documents — and have
     * the shell fetch with its own token.
     *
     * So the only thing this will read is a file **inside the asking plugin’s own directory**,
     * which is the one place it already has. `realpath` before the comparison, because `..` and
     * a symlink are the two ways a path that looks inside points outside, and a prefix test on
     * the string alone catches neither.
     */
    if (url.pathname === '/api/plugin-file' && request.method === 'GET') {
      const id = url.searchParams.get('plugin') ?? ''
      const wanted = url.searchParams.get('path') ?? ''
      const deny = (code: number, said: string): void => {
        response.writeHead(code, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, said }))
      }
      if (!plugins.manifest(id)) return deny(404, 'There is no plugin by that name.')
      let real: string
      try {
        // `realpath` on both sides before the comparison. `..` and a symlink are the two ways a
        // path that reads as inside points outside, and a prefix test on the raw string catches
        // neither — which is the difference between a widget and a file reader.
        const root = realpathSync(plugins.ownDir(id))
        real = realpathSync(wanted)
        if (real !== root && !real.startsWith(root + sep)) {
          return deny(403, 'A plugin may only show files from its own folder.')
        }
      } catch {
        return deny(404, 'That file is not there.')
      }

      try {
        const bytes = readFileSync(real)
        response.writeHead(200, { 'content-type': mimeOf(real), 'cache-control': 'private, max-age=60' })
        response.end(bytes)
      } catch {
        deny(410, 'That file is no longer where it was.')
      }
      return
    }

    if (url.pathname === '/api/file') {
      const wanted = offers.get(request.method === 'GET' ? url.searchParams.get('id') : sent.id)
      if (wanted === undefined) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, said: 'That file is not one anything offered here.' }))
        return
      }
      if (request.method === 'GET') {
        let bytes: Buffer
        try {
          bytes = readFileSync(wanted.path)
        } catch {
          // It was there when the tool offered it and it is not there now — moved, deleted,
          // or on a drive that has been unplugged. That is a fact about the file rather than
          // an error in the request, and the shell says so on the row.
          response.writeHead(410, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: false, said: `${wanted.name} is no longer where it was made.` }))
          return
        }
        response.writeHead(200, {
          'content-type': wanted.mime === 'application/octet-stream' ? mimeOf(wanted.name) : wanted.mime,
          'content-length': String(bytes.length),
          // The shell saves through a blob it fetched, so this header is for anything that
          // reaches the route directly — and for the name being right when it does.
          'content-disposition': `attachment; filename="${wanted.name.replace(/[^\w. -]/g, '_')}"`,
          'cache-control': 'no-store',
        })
        response.end(bytes)
        return
      }
      const how = sent.action === 'open' ? 'open' : 'reveal'
      if (how === 'open' && !openable(wanted.name)) {
        // Refused, and pointed at the thing that does work. A refusal that leaves somebody
        // with no way to reach their own file would be answering a safety question with a
        // usability failure.
        response.writeHead(409, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            ok: false,
            said: `${wanted.name} is the sort of file that runs when it is opened, so Alexia will not open it for you. Show in folder still works, and from there it is your decision.`,
          }),
        )
        return
      }
      reach(wanted.path, how)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
      return
    }

    if (url.pathname === '/api/chat' && request.method === 'POST') {
      await reply(sent, response)
      return
    }

    response.writeHead(404)
    response.end()
  }

  async function read(request: IncomingMessage): Promise<string> {
    let raw = ''
    for await (const chunk of request) raw += String(chunk)
    return raw || '{}'
  }

  /**
   * The attachments on one message, read and then thrown away.
   *
   * **Core carries the bytes and a plugin reads them**, and the seam is a capability name.
   * That is the same answer already given to *not every model can hear* — `voice.transcribe`
   * is *audio file in, text out* and this is *file in, markdown out* — and it is why nothing
   * in this function knows what is installed. With nothing providing it, an attachment still
   * arrives and still appears in the conversation, saying that nothing could read it.
   *
   * Every file gets a line under the composer whether it was read or not, because the failure
   * worth designing against here is the quiet one: a model answering about a document that
   * never reached it, with nothing on screen to say so.
   */
  async function documents(
    text: string,
    uploads: Upload[],
    say: (event: Record<string, unknown>) => void,
  ): Promise<string | Part[]> {
    const { kept, refused } = receive(uploads, join(root, 'uploads'))
    const readings: Reading[] = []
    /** The pictures, which go to the model as pictures rather than as a reading of them. */
    const pictures: Part[] = []
    const seen: string[] = []
    try {
      for (const one of kept) {
        /**
         * **A picture is sent, not read** — and choosing between those two is the whole of
         * what this branch decides.
         *
         * Until the wire could carry an image there was one answer to every attachment:
         * extract text, and refuse when there was none to extract. There are two now, and
         * they are for different files. A scanned page wants recognition — exact characters,
         * cheap, no model. A screenshot or a photograph wants *sight*, and OCR over one
         * returns button labels and a timestamp in no order, which is §4's silent failure.
         *
         * So a picture goes as a picture, and **nothing here also runs OCR over it**. The
         * model can call whatever reads documents itself when it decides it wants the exact
         * text — which is the right way round, because it is the only participant that knows
         * whether the question was *what does this say* or *what is this*.
         */
        // What the shell said, when it said — a re-encoded picture keeps its old name and
        // no longer matches it. The name is the fallback, which is every other case.
        const mime = one.type ?? mimeOf(one.name)
        if (mime.startsWith('image/')) {
          pictures.push({ type: 'image', url: `data:${mime};base64,${readFileSync(one.path).toString('base64')}` })
          seen.push(one.name)
          continue
        }
        readings.push(await extracted(one))
      }
    } finally {
      // Written, read, gone. The extracted text is in the conversation and the original is
      // already on the user's own disk; a third copy accumulating beside the database is a
      // second place their documents live, for nothing.
      discard(kept)
    }
    // **One line, not one per file.** The note under the composer is a single line by
    // design — a message that scrolls away or overwrites itself is a message the user is
    // being tested on — so four attachments say four things in one sentence rather than
    // three of them being replaced by the fourth before anybody read them.
    const lines = [
      ...refused,
      ...seen.map((name) => `${name} went as a picture, for the model to look at.`),
      ...readings.map(noteFor),
    ]
    if (lines.length > 0) say({ note: lines.join(' ') })
    /**
     * **What was actually read, sent to the screen as well as to the model.**
     *
     * The finding this answers is the sharpest one about uploads: an extracted document is a
     * far larger surface than a chat turn — more of it, skewed towards the personal and the
     * official — and **nobody reads the extracted markdown before it is sent**. In a typed
     * turn the user wrote the words and knows what is in them; in an attached payslip they do
     * not, and until this line there was nothing anywhere that would have shown them.
     *
     * It does not change the policy, which is the owner's and is quoted verbatim in
     * `redact.ts`. It changes whether the thing the policy is applied to can be looked at, and
     * that is a different question with a cheaper answer: send it, fold it away, and let
     * anybody who wants to open it.
     */
    if (readings.length > 0) say({ attached: readings })

    /**
     * The words, and then the pictures.
     *
     * Named in the text as well as carried as parts, because a model handed three images and
     * a sentence has no way to tell which is `chart.png` and which is `receipt.jpg` — the
     * parts arrive in order and carry no filenames. The name is how the user refers to it and
     * therefore how the answer has to refer to it back.
     */
    const said = withDocuments(text, readings)
    if (pictures.length === 0) return said
    const named = seen.map((name) => `[attached: ${name} — a picture, in this message]`).join('\n')
    return [{ type: 'text', text: [said, named].filter((part) => part !== '').join('\n\n') }, ...pictures]
  }

  /**
   * One file, through whatever provides `document.extract`.
   *
   * It reads the **text** and nothing else. There is a `structuredContent` on that answer and
   * it would make a nicer sentence — *2 pages* rather than a character count — and reading it
   * would be core learning the shape one provider happens to return. The contract in the
   * registry is one line long, and this stays inside it so a second extractor is a drop-in.
   */
  async function extracted(one: Saved): Promise<Reading> {
    if (!plugins.answers(CORE_CAPABILITIES.extract)) {
      /**
       * Three states, not one, and the old sentence collapsed them into the rarest.
       *
       * It said *nothing installed here reads documents, the library has one — install it*,
       * which is wrong in the commonest case by a long way: the reader **is** installed and
       * is sitting in the list with its switch off, so *install* is the wrong verb and the
       * library is the wrong screen. Worse on a machine whose registry was never deployed,
       * where the library it sends somebody to is empty — a refusal that names a wall, points
       * at a door, and the door opens onto nothing.
       *
       * Core cannot promise anything about the library, because core cannot see it from here.
       * It can say exactly what is true: what is here and off, or that there is nothing, and
       * which screen either of those is fixed on.
       */
      const off = plugins.couldAnswer(CORE_CAPABILITIES.extract)
      return {
        name: one.name,
        refusal:
          off.length > 0 ?
            `${off.join(' and ')} can read this and ${off.length > 1 ? 'are' : 'is'} switched off. Turn ${off.length > 1 ? 'them' : 'it'} on in Settings, then Plugins, and attach this again.`
          : 'Nothing installed here reads documents. Settings, then Plugins, is where one is added.',
      }
    }
    try {
      const answered = await plugins.capability(CORE_CAPABILITIES.extract, { file: one.path })
      const read = answered.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n')
        .trim()
      if (answered.isError === true || read === '') {
        // The reader's own sentence, which is written to say which wall this is. Passing it
        // through unchanged is the difference between *that is a scan and nothing here does
        // OCR* and *could not read file*.
        return { name: one.name, refusal: read === '' ? 'Whatever reads documents here said nothing about it.' : read }
      }
      return { name: one.name, text: read, about: `${read.length.toLocaleString('en-GB')} characters` }
    } catch (error) {
      return { name: one.name, refusal: said(error) }
    }
  }

  /**
   * One task: the user's line in, and however many steps it takes to answer it.
   *
   * Not one turn any more (M15-1). What the shell gets is the same stream it always got,
   * with the step events added — so a turn that happens to need no tools looks exactly as
   * it did, which is most of them.
   */
  /** The tier of the model that wrote a message, from the catalog, when it is still there. */
  const tierOf = (message: Message): Tier | undefined =>
    catalog.models.find((model) => model.id === (message.row ?? message.model) && (message.provider === undefined || model.provider === message.provider))?.tier

  async function reply(sent: Body, response: ServerResponse): Promise<void> {
    const { text: typed, files, again, automatic, allow, bad } = sent as {
      text?: string
      files?: Upload[]
      again?: boolean
      automatic?: boolean
      /**
       * ***Allow switching to a paid model*** (§4 H), pressed on a pause: this conversation may cross
       * into paid from now on, and — when there was no daily amount — `daily` is the one typed
       * into the box beside the button. Sent with `again`, so the question carries on.
       */
      allow?: { daily?: number }
      /**
       * ***Bad answer*** (§4 I), pressed under the latest answer: it is marked, a *bad answer* is
       * recorded for the model and provider that wrote it, and the question is asked again without
       * that model — on Automatic, and above its tier when the paid switch is on. Sent with `again`.
       */
      bad?: Record<string, never>
    }
    /** The answer just marked bad, when this is a *Bad answer* press. */
    const marked = again === true && bad !== undefined ? store.markLastAnswerBad(session) : undefined
    if (again === true && bad !== undefined && marked === undefined) {
      response.writeHead(409)
      response.end()
      return
    }
    /** The catalog row the marked answer came from — not the id a router reported back (§4 I). */
    const markedRow = marked === undefined ? undefined : (marked.row ?? marked.model)
    if (markedRow !== undefined && marked?.provider !== undefined) {
      // One press, recorded like any other try: two in 30 days tag the model (D161, D162).
      store.recordTry({ provider: marked.provider, model: markedRow, outcome: 'bad-answer', status: 0, source: 'person' })
    }
    if (again === true && allow !== undefined) {
      paidIn.add(session)
      const daily = allow.daily
      if (typeof daily === 'number' && Number.isFinite(daily) && daily > 0) setCaps(store, { ...caps(store), daily: Math.round(daily * 100) / 100 })
    }
    const uploads = Array.isArray(files) ? files.slice(0, MOST_FILES) : []
    /**
     * **The question that stopped, asked again** (D155) — *Try again*, or *Use Automatic for
     * this answer* with `automatic` beside it.
     *
     * Nothing is appended: the question is already in the conversation, and so is every step
     * the task took before it stopped, so a task that stopped at step six carries on from
     * step six. Refused when the last thing in the conversation is an answer, because then
     * there is nothing left to answer and a second reply to the same question is not this.
     */
    // What a model may still be shown: a marked answer stays on the page and never goes back out.
    const history = again === true ? store.history(session).filter((turn) => turn.bad !== true) : []
    const question = [...history].reverse().find((turn) => turn.role === 'user')
    const last = history.at(-1)
    const answered = last?.role === 'assistant' && (last.calls?.length ?? 0) === 0
    if (again === true && (question === undefined || answered)) {
      response.writeHead(409)
      response.end()
      return
    }
    // A file with nothing typed is a whole message — *here, read this* — so the line is
    // required only when it is the only thing there is.
    if (again !== true && !typed && uploads.length === 0) {
      response.writeHead(400)
      response.end()
      return
    }
    // What the person typed — on a question asked again too, where the stored turn has every
    // document merged into it and reading that as typed would hand a document to the gate.
    const text = question === undefined ? String(typed ?? '') : typedOf(question)

    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    const say = (event: Record<string, unknown>): void => void response.write(`data: ${JSON.stringify(event)}\n\n`)

    if (question === undefined) {
      /**
       * The documents, read before anything else happens.
       *
       * **`text` stays what the person typed** and only `content` grows, which is the load-
       * bearing half of this: the permission gate, the boundary sentences and the offer to
       * learn all read `text`, and every one of them would be wrong to read a document. A file
       * containing the words *delete everything* is not somebody asking for anything.
       */
      const content = uploads.length === 0 ? text : await documents(text, uploads, say)

      const user: Message = { role: 'user', content, ...(content !== text && { typed: text }) }
      store.append(session, user)

      // A boundary the user just spoke, or one they just lifted. Said out loud either way:
      // a rule that changed silently is a rule they will be surprised by later. Once, when it
      // was said — asking the same question again does not say it a second time.
      const standing = scope().boundaries ?? []
      const spoken = heard(text)
      if (spoken) {
        store.kvSet(CORE, 'boundaries', [...standing, spoken])
        say({ note: boundaryAck(spoken) })
      } else if (standing.length > 0 && lifts(text)) {
        store.kvSet(CORE, 'boundaries', [])
        say({ note: 'Lifted. I can delete and change things again.' })
      }
    }

    /** Which rung of §8.2's ladder actually answered, for the badge at the end (§8.4). */
    let reached: Bubble | undefined

    const month = allowance(store)
    const limits = ceilings(store)

    // Once, at the only moment the answer can still change anything. A cheap or free task
    // never sees this, which is what keeps the question worth reading when it does appear.
    // The catalog's first row, which is all the estimate reads of the world — gathered whole, it
    // was every provider's key and thirty days of tries for one price.
    const guess = estimate(store.history(session), catalog.models[0])
    if (worthAsking(guess, limits)) {
      const allowed = await new Promise<boolean>((resolve) => {
        pending = resolve
        say({ ask: previewLine(guess) })
      })
      if (!allowed) {
        say({ note: 'Stopped before starting. Nothing was spent.' })
        response.end()
        return
      }
    }

    const stop = new AbortController()
    task = stop
    // A second consumer of the same stream (M6-5). What it keeps is what the loop did rather
    // than what the model was shown — M15-6 trims the second, and trimming this one because
    // of that would be one decision serving two jobs badly.
    const runId = randomUUID()
    trace.start(runId, text)
    const chosen = await personality()
    // Said per step by the loop (§2's three lengths); *none sent* has no step to wait for.
    if (chosen === undefined) trace.personality(0, 'high')
    try {
      const result = await run({
        messages: store.history(session).filter((turn) => turn.bad !== true),
        ...(chosen !== undefined && { personality: chosen }),
        tools: tooling,
        // *Use Automatic for this answer* is this answer, not a setting (D155): the pin and the
        // list are still there for the next message, and nothing here writes to them.
        pins:
          again === true && (automatic === true || marked !== undefined) ? { ...pins(store), model: undefined, order: undefined } : pins(store),
        // Without the model somebody just marked, and — with the paid switch on — above its tier (§4 I).
        ...(markedRow !== undefined &&
          marked?.provider !== undefined && { avoid: [`${marked.provider}\n${markedRow}`] }),
        ...(marked !== undefined && caps(store).cross === true && tierOf(marked) !== undefined && { above: tierOf(marked) }),
        // Whether paid may be crossed into here: the switch, or *Allow* pressed in this conversation (§4 H).
        world: worldFor(session),
        store,
        secrets,
        session,
        // Every charge this task makes lands on a row carrying this id (M7-2), which is what
        // turns *why did that cost £0.02* from an argument into a lookup.
        run: runId,
        paidAllowed: !month.stop,
        maxSteps: limits.steps,
        signal: stop.signal,
        // The gate (M15-3), the same one a task started from a phone meets (M7-5).
        guard: gate(text, runId),
        approve: (ruling) =>
          new Promise<boolean>((resolve) => {
            pending = resolve
            say({ ask: ruling.why })
          }),
        on: {
          delta: (delta) => say({ delta }),
          note: (note) => say({ note }),
          // Said twice (§4 G): the screen shows it for three seconds and keeps it on the answer.
          switch: (event) => say({ switch: event }),
          // The charge line, in a place of its own above the message box.
          paid: (line) => say({ paid: line }),
          // The words on screen since the turn began came from a model that stopped partway;
          // the answer is starting again on the next one (D155).
          restart: () => say({ restart: true }),
          turn: (models) => {
            trace.turn(models)
            // §8.4's badge. Held rather than sent per turn: the screen names one state at a
            // time, and the one worth naming is the one the answer actually came from.
            reached = models.bubble
          },
          personality: (chars, size) => trace.personality(chars, size),
          step: (step) => {
            trace.step(step)
            say({ step: { n: step.n, name: step.name, args: step.args } })
            // Attribution, at the moment it fires (M4-5). A learned skill can be wrong, and
            // the person finds out when it actually matters rather than in a settings list
            // nobody opens — so *edit* and *forget* travel with this line.
            const opened = step.name === SKILL_TOOL ? String(step.args.name ?? '') : ''
            if (opened !== '' && skills.isLearned(opened)) say({ learned: opened })
          },
          // The same row, moving. A frame per update, because the whole point is that the
          // screen is never more than a moment behind what the tool is doing (M2-6).
          progress: (step) => say({ step: { n: step.n, name: step.name, progress: step.progress } }),
          done: (step) => {
            trace.done(step)
            /**
             * A file the tool made, given an id and sent to the screen.
             *
             * The model already has what it can use — `[file: report.pdf]`, in the outcome
             * text — because `Message.content` is a string and the bytes were never going
             * anywhere near it. This is the other half: the person who asked gets a row they
             * can open, save, find or copy the path of, which until now was a sentence
             * containing a path and nothing else.
             */
            const files = step.outcome === undefined ? [] : offers.keep(step.outcome.files ?? [])
            say({
              step: {
                n: step.n,
                name: step.name,
                ...step.outcome,
                ...(files.length > 0 && { files: files.map((one) => ({ ...one, openable: openable(one.name) })) }),
              },
            })
          },
        },
      })
      trace.end(result.ended, {
        ...(result.why !== undefined && { why: result.why }),
        // Looked up, not subtracted (M7-2). The old difference-across-the-run split its
        // total with anything else spending at the same moment — a Telegram task, say.
        calls: store.callsIn(runId),
      })

      /**
       * **A pause** (§4 H): the free models are done, a paid one would answer, and the switch is off.
       * Nothing was billed. The screen shows the reason and *Allow switching to a paid model* — with
       * a box for the daily amount when there is none, since at $0 the press alone would buy nothing.
       */
      if (result.ended === 'paused') {
        say({ paused: result.why, daily: caps(store).daily ?? 0 })
        response.end()
        return
      }

      if (result.ended === 'refused') {
        // The refusal is the answer. It is written to be read by the person who has to act
        // on it, so it goes to the screen exactly as the router wrote it — and when what
        // stopped was the person's own choice, a pin or a list, the screen is told which, so
        // it can offer Automatic for this one answer (D155).
        say({
          error: result.why,
          ...((result.mode === 'pinned' || result.mode === 'sequence') && { chosen: result.mode }),
        })
        response.end()
        return
      }

      const after = allowance(store)
      const last = result.messages.at(-1)

      /**
       * The offer (M4-5). Made only after a task where something was actually worked out,
       * and made **once**, at the end, where the person has just watched it happen.
       *
       * It is held here rather than acted on: nothing is written, no model is called, and
       * no money is spent until somebody says yes. A feature that quietly distilled every
       * task would be a feature that quietly spent money on every task.
       */
      const episode = { task: text, steps: result.steps, answer: last === undefined ? '' : textOf(last) }
      if (result.ended === 'answered' && learnable(episode)) {
        lesson = episode
        say({ learn: { about: text.slice(0, 120), outline: outline(episode) } })
      }

      /**
       * What was just said, handed to whatever remembers things (M7-3).
       *
       * **Core does not decide what is worth keeping**, does not read it back, and does not
       * wait for it. It hands over the exchange and moves on: a memory that could delay an
       * answer is a memory people turn off, and one that could throw would break a
       * conversation over a flourish. Nothing provides it → nothing happens, which is the
       * bar for being a capability at all.
       *
       * **Credentials never make the trip.** The same scan the router runs on the way out
       * (M7-1), on the other door — because what may be written down is not what may be
       * sent, and a key pasted into a conversation is the one thing that must be in neither.
       * Location is deliberately *not* stripped here: where somebody lives is a thing worth
       * remembering, and it is only dangerous when it leaves.
       */
      const answered = last === undefined ? '' : textOf(last)
      if (result.ended === 'answered' && answered.trim() !== '') {
        void plugins.capability(CORE_CAPABILITIES.capture, exchange(text, answered)).catch(() => {
          // Nothing provides it, or whatever does is having a bad day. Either way this is
          // not the user's problem and never becomes one.
        })
      }

      say({
        done: {
          model: last?.model ?? '',
          // What state that leaves them in (§8.4) — what the assistant can *do*, never what it
          // cost. The money has its own badge, and putting a price in this one is the thing
          // that section says not to do.
          ...(reached !== undefined && { bubble: reached }),
          spent: after.spent,
          warning: warning(after),
          steps: result.steps.length,
          // `answered` is the ordinary end. The other two are limits the user should be
          // told about rather than left to wonder why it stopped talking.
          ended: result.ended,
        },
      })
    } catch (error) {
      // A run that threw is a run that ended, and the record says which — an entry left
      // open would read as *still going* to somebody looking at the panel afterwards.
      trace.end('refused', { why: said(error), calls: store.callsIn(runId) })
      say({ error: said(error) })
    } finally {
      // Whatever ended the task, an unanswered question outlives nothing. Settling it as a
      // no rather than leaving it is what keeps a stopped task from holding the next one.
      //
      // In a `finally` since §4 H: a refusal returned early and skipped this, so after any
      // refusal on screen a task from a phone was told Alexia was *already working on something*.
      pending?.(false)
      pending = undefined
      task = undefined
    }
    response.end()
  }

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/`,
    token,
    store,
    close: async () => {
      clearInterval(ticking)
      clearTimeout(firstTests)
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await plugins.stop()
      store.close()
    },
  }
}

if (import.meta.main) {
  const { url } = await serve()
  // stdout is not a wire here — this is the app, not a plugin.
  console.log(`Alexia is at ${url}`)
  console.log(`Ollama: ${(await running()) ? 'running' : 'not running'} (${OLLAMA.name})`)
}
