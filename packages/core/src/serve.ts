// SPDX-License-Identifier: AGPL-3.0-only
import { APP_VERSION, CORE_CAPABILITIES, FILES_META, TOOLS_META } from '@alexia/protocol'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
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
  withDocuments,
  type Reading,
  type Saved,
  type Upload,
} from './attach.js'
import { Catalog } from './catalog.js'
import { asRuling, counted, freshTally, ModelChecker, type Tally } from './checker.js'
import { commands, pins, type Ran, run as runCommand } from './commands.js'
import { preauthorise, record } from './consent.js'
import { refuse, type Body } from './guard.js'
import { Library, offerable } from './library.js'
import { distil, forget, learnable, outline, save, type Episode } from './learned.js'
import { mimeOf, Offers, openable, reach } from './offered.js'
import { installed, OLLAMA, running } from './ollama.js'
import { usable } from './pool.js'
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
import { MODES, route, send, shapeOf, type Bubble } from './router.js'
import { CORE, keychain, type SecretStore } from './secrets.js'
import { addServer, markReviewed, unreviewed } from './servers.js'
import { declaredAction, declaredTable } from './settings.js'
import { search } from './palette.js'
import { tabs as coreTabs } from './panels.js'
import { actions as coreActions, sources as coreSources, searchable } from './surface.js'
import { Skills, SKILL_TOOL } from './skills.js'
import { dataDir, Store, textOf, type Message, type Part } from './store.js'
import { PluginTooling } from './tooling.js'
import { Trace } from './trace.js'
import { allowance, caps, setCaps, today, warning } from './usage.js'

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
  const poll = async (provider: Provider): Promise<void> => {
    void (await catalog.refresh(provider, undefined, await secrets.get(CORE, keyOf(provider)).catch(() => undefined)))
  }
  /** Every provider, if its own list has aged out. Startup calls it; so does the Models tab. */
  const pollAll = (): void => {
    for (const provider of providers) void poll(provider)
  }
  pollAll()

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
    sample: async (pluginId, params) => {
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

      if (params._meta?.[TOOLS_META] === true) return asTask(pluginId, asked)

      const verdict = route({ messages: asked, shape: shapeOf({ messages: asked }) }, pins(store), await world())
      if (!verdict.ok) throw new Error(verdict.why)
      const answer = await send(
        verdict.choices,
        { messages: asked, ...(params.maxTokens !== undefined && { maxTokens: params.maxTokens }) },
        store,
        secrets,
        // No `run`, because there is no task: a plugin asked. **That is also the ceiling**
        // — `send` reads *attributed to a plugin, belonging to no run* as *free tiers only*
        // (G12, D96), so the rule is the router's rather than this call site's.
        { plugin: pluginId },
      )
      return {
        role: 'assistant',
        content: { type: 'text', text: textOf(answer.message) },
        model: answer.model.id,
        stopReason: 'endTurn',
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

  /** Everything the router needs to know, asked fresh: a tier can be exhausted mid-sentence. */
  const world = async () => ({
    models: catalog.models,
    local: (await running()) ? await installed() : [],
    rungs: await usable(store, secrets, providers),
    // Asked fresh with the rest of it, and for the same reason: an allowance can run out
    // mid-sentence exactly the way a free tier can.
    today: today(store),
  })

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

  /**
   * The last task worth learning from, waiting for an answer (M4-5).
   *
   * One, not a queue: the offer is made at the end of a task and answered before the next
   * one starts, or it is not answered at all. A backlog of *do you want to remember this*
   * from last Tuesday is a backlog nobody clears.
   */
  let lesson: Episode | undefined

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
    const found = await Promise.all(
      providers.map(async (p) =>
        anonymous(p) || (await secrets.get(CORE, keyOf(p)).catch(() => undefined)) !== undefined ?
          [p.id]
        : [],
      ),
    )
    return new Set(found.flat())
  }

  /**
   * Whether money has been agreed to in this conversation (§9.5).
   *
   * Once per task is what the loop guarantees; **for the session** is what this adds, by
   * being the same answer the next task finds. A router that asks about money on every
   * request is a nag, and a nag is clicked through without being read.
   *
   * Cleared when a different conversation is opened, because consent given in one is not
   * consent given in another.
   */
  let spending: boolean | undefined

  const surface = {
    skills, tooling, plugins, skillsDir, trace, dataDir: root, store, catalog, connected, world,
    refresh: pollAll,
    session: () => session,
    openSession: (id: number) => {
      spending = undefined
      return (session = id)
    },
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
  async function personality(): Promise<string | undefined> {
    if (!plugins.answers(CORE_CAPABILITIES.personality)) return undefined
    try {
      const answered = await plugins.capability(CORE_CAPABILITIES.personality)
      const said = (answered.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('')
        .trim()
      return said === '' ? undefined : said
    } catch (error) {
      console.error(`[personality] ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

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
  async function commandTool(plugin: string, tool: string): Promise<string> {
    const process = plugins.process(plugin)
    if (!process) throw new Error(`${plugin} is not running`)
    const result = await process.callTool(tool)
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
      call: async (plugin, tool) => {
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
        return commandTool(plugin, tool)
      },
    })
    return { role: 'assistant', model: '', content: { type: 'text', text: ran.note }, stopReason: 'endTurn' }
  }

  async function asTask(pluginId: string, messages: Message[]): Promise<CreateMessageResult> {
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
      const chosen = await personality()
      const result = await run({
        messages,
        tools: tooling,
        pins: pins(store),
        world,
        store,
        secrets,
        session: its,
        run: runId,
        ...(chosen !== undefined && { personality: chosen }),
        // The spend lands on the plugin that asked, exactly as a plain `sampling` call's
        // does — and it is a run now, so it is a paid path like any other task (G12, D96).
        plugin: pluginId,
        paidAllowed: !month.stop,
        maxSteps: limitsNow().steps,
        signal: stop.signal,
        guard: gate(text, runId),
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
        provider?: { id: string; key: string }
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
        if (provider) await secrets.set(CORE, keyOf(provider), chosen.provider.key)
        // And its list, now that there is something to ask with. Four of the six refuse an
        // unauthenticated request, so this is the moment their models become knowable at
        // all — waiting for the next restart would mean connecting a provider and finding
        // the Models tab still empty, with nothing on screen saying why.
        if (provider) void catalog.refresh(provider, 0, chosen.provider.key)
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(setup()))
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
        call: async (plugin, tool) => {
          const ruling = await rulingFor(plugin, tool)
          if (ruling.verdict === 'blocked' || (ruling.verdict === 'ask' && approved !== true)) {
            asked = ruling
            throw new Error(ruling.why ?? `${tool} did not run.`)
          }
          return commandTool(plugin, tool)
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
     * An `action` button, pressed.
     *
     * The permission gate is the same one every tool call goes through: a destructive tool is
     * asked about in every mode except Full trust, and the never-touch list is not negotiable
     * in any of them. It is asked in two steps rather than by blocking, because this request
     * carries no stream to ask down — the first call answers `ask`, the screen puts the
     * question to the person, and the second call carries their answer. `blocked` has no
     * second call: that is the difference between a question and a floor.
     */
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
      const result = await plugins
        .action(plugin, press.key ?? '', undefined, press.row)
        .catch((error: unknown) => ({ ok: false, said: error instanceof Error ? error.message : String(error) }))
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
          : url.pathname === '/api/rows' ? { rows: await source.rows() }
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
  async function reply(sent: Body, response: ServerResponse): Promise<void> {
    const { text: typed, files } = sent as { text?: string; files?: Upload[] }
    const uploads = Array.isArray(files) ? files.slice(0, MOST_FILES) : []
    // A file with nothing typed is a whole message — *here, read this* — so the line is
    // required only when it is the only thing there is.
    if (!typed && uploads.length === 0) {
      response.writeHead(400)
      response.end()
      return
    }
    const text = String(typed ?? '')

    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    const say = (event: Record<string, unknown>): void => void response.write(`data: ${JSON.stringify(event)}\n\n`)

    /**
     * The documents, read before anything else happens.
     *
     * **`text` stays what the person typed** and only `content` grows, which is the load-
     * bearing half of this: the permission gate, the boundary sentences and the offer to
     * learn all read `text`, and every one of them would be wrong to read a document. A file
     * containing the words *delete everything* is not somebody asking for anything.
     */
    const content = uploads.length === 0 ? text : await documents(text, uploads, say)

    const user: Message = { role: 'user', content }
    store.append(session, user)

    /** Which rung of §8.2's ladder actually answered, for the badge at the end (§8.4). */
    let reached: Bubble | undefined

    // A boundary the user just spoke, or one they just lifted. Said out loud either way:
    // a rule that changed silently is a rule they will be surprised by later.
    const standing = scope().boundaries ?? []
    const spoken = heard(text)
    if (spoken) {
      store.kvSet(CORE, 'boundaries', [...standing, spoken])
      say({ note: boundaryAck(spoken) })
    } else if (standing.length > 0 && lifts(text)) {
      store.kvSet(CORE, 'boundaries', [])
      say({ note: 'Lifted. I can delete and change things again.' })
    }

    const month = allowance(store)
    const limits = ceilings(store)

    // Once, at the only moment the answer can still change anything. A cheap or free task
    // never sees this, which is what keeps the question worth reading when it does appear.
    const guess = estimate(store.history(session), (await world()).models[0])
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
    try {
      const result = await run({
        messages: store.history(session),
        ...(chosen !== undefined && { personality: chosen }),
        tools: tooling,
        pins: pins(store),
        world,
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
        // The money question travels the same channel as a permission question, because it
        // is the same shape: one question, held open, settled by the person at the screen.
        money: {
          get allowed(): boolean | undefined {
            return spending
          },
          set allowed(answer: boolean | undefined) {
            spending = answer
          },
          ask: (question) =>
            new Promise<boolean>((resolve) => {
              pending = resolve
              say({ ask: question })
            }),
        },
        on: {
          delta: (delta) => say({ delta }),
          note: (note) => say({ note }),
          turn: (models) => {
            trace.turn(models)
            // §8.4's badge. Held rather than sent per turn: the screen names one state at a
            // time, and the one worth naming is the one the answer actually came from.
            reached = models.bubble
          },
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

      if (result.ended === 'refused') {
        // The refusal is the answer. It is written to be read by the person who has to act
        // on it, so it goes to the screen exactly as the router wrote it.
        say({ error: result.why })
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
    }
    // Whatever ended the task, an unanswered question outlives nothing. Settling it as a
    // no rather than leaving it is what keeps a stopped task from holding the next one.
    pending?.(false)
    pending = undefined
    task = undefined
    response.end()
  }

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/`,
    token,
    store,
    close: async () => {
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
