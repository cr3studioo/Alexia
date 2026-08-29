// SPDX-License-Identifier: AGPL-3.0-only
import { ALEXIA_PROTOCOL_MAX, ALEXIA_PROTOCOL_MIN, CORE_CAPABILITIES } from '@alexia/protocol'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { run, said } from './agent.js'
import { Catalog } from './catalog.js'
import { asRuling, counted, freshTally, ModelChecker, type Tally } from './checker.js'
import { commands, pins, run as runCommand } from './commands.js'
import { preauthorise, record } from './consent.js'
import { refuse, type Body } from './guard.js'
import { Library } from './library.js'
import { distil, forget, learnable, outline, save, type Episode } from './learned.js'
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
import { keyOf, PROVIDERS } from './provider.js'
import { MODES, route, send, shapeOf } from './router.js'
import { CORE, keychain, type SecretStore } from './secrets.js'
import { addServer, markReviewed, unreviewed } from './servers.js'
import { declaredAction, declaredTable } from './settings.js'
import { search } from './palette.js'
import { actions as coreActions, sources as coreSources, searchable } from './surface.js'
import { Skills, SKILL_TOOL } from './skills.js'
import { dataDir, Store, type Message } from './store.js'
import { PluginTooling } from './tooling.js'
import { Trace } from './trace.js'
import { allowance, warning } from './usage.js'

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

const STATIC: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  // The shell is TypeScript compiled by the same `tsc -b` as everything else. No bundler,
  // because a chat window is not a build problem. Modules beyond the entry point are matched
  // by MODULE below rather than listed here, one line each.
  '/main.js': [join('dist', 'src', 'main.js'), 'text/javascript; charset=utf-8'],
  // Her face: the header mark, the first-run mark and the tab icon, one file doing all
  // three. Everything above is text and gets the token substituted into it; this does not,
  // which is why the read below is bytes until the content type says otherwise.
  '/alexia.png': ['alexia.png', 'image/png'],
}

export async function serve(options: ServeOptions = {}): Promise<Serving> {
  const root = options.dataDir ?? dataDir()
  const ui = options.uiDir ?? shell()
  const secrets = options.secrets ?? keychain
  const store = new Store(join(root, 'alexia.db'))
  const catalog = new Catalog(join(root, 'cache', 'models.json'))
  const token = randomUUID()

  // The daily poll, such as it is: once at startup, and `refresh` itself declines to fetch
  // anything younger than a day old.
  const openrouter = PROVIDERS.find((p) => p.id === 'openrouter')
  if (openrouter) void catalog.refresh(openrouter)

  const session = store.sessions()[0]?.id ?? store.createSession()

  const extensions = options.pluginsDir ?? join(root, 'extensions')
  const skillsDir = join(root, 'skills')
  /**
   * The library (M3-2). It downloads, checks a checksum and unpacks; it never enables
   * anything, which is why every route below that installs ends by re-drawing the panes
   * with the new plugin sitting in the *not enabled* state.
   */
  const library = new Library({ store, pluginsDir: extensions, skillsDir })

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
          // MCP lets one turn carry several blocks, and several kinds. A model reached over
          // this path is a text one, so anything else is named rather than dropped — *the
          // caller sent an image* is something to answer, and a blank is not.
          content: [turn.content]
            .flat()
            .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
            .join('\n'),
        })),
      ]
      const month = allowance(store)
      const verdict = route({ messages: asked, shape: shapeOf({ messages: asked }) }, pins(store), await world())
      if (!verdict.ok) throw new Error(verdict.why)
      const answer = await send(
        verdict.choices,
        { messages: asked, ...(params.maxTokens !== undefined && { maxTokens: params.maxTokens }) },
        store,
        secrets,
        { plugin: pluginId, paidAllowed: !month.stop },
      )
      return {
        role: 'assistant',
        content: { type: 'text', text: answer.message.content },
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
    rungs: await usable(store, secrets),
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

  const surface = { skills, tooling, plugins, skillsDir, trace, dataDir: root, store }
  const ours = coreSources(surface)
  const ourActions = coreActions(surface)

  const checker = new ModelChecker({ store, secrets, world, session })
  let tally: Tally = freshTally()

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
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          setup: setup(),
          // Everything you could type right now, and the pins those commands set. The
          // shell shows both as controls: a command is a shortcut, never the only route.
          commands: commands(manifests()),
          pins: { ...pins(store), placement: undefined },
          messages: store.history(session),
          spent: month.spent,
          cap: month.cap,
          warning: warning(month),
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
          providers: PROVIDERS.map((p) => ({
            id: p.id,
            name: p.name,
            terms: p.terms,
            trainsOnYourData: p.trainsOnYourData ?? 'unknown',
            free: p.rpd !== undefined || p.rpm !== undefined,
          })),
        }),
      )
      return
    }

    if (url.pathname === '/api/setup' && request.method === 'POST') {
      const chosen = sent as {
        name?: string
        mode?: keyof typeof MODES
        provider?: { id: string; key: string }
      }
      if (chosen.name) store.kvSet(CORE, 'display_name', chosen.name)
      if (chosen.mode && chosen.mode in MODES) store.kvSet(CORE, 'mode', chosen.mode)
      if (chosen.provider?.key) {
        const provider = PROVIDERS.find((p) => p.id === chosen.provider?.id)
        // Straight to the keychain, never to the database — the same path a plugin's
        // password takes, and the same check proves it.
        if (provider) await secrets.set(CORE, keyOf(provider), chosen.provider.key)
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
      const ran = await runCommand(input ?? '', {
        store,
        manifests: manifests(),
        // A command is bound to the plugin tool of the same name — the whole binding, and
        // why a manifest declares a command with a name and a sentence and nothing else.
        call: async (plugin, tool) => {
          const ruling = await rulingFor(plugin, tool)
          if (ruling.verdict === 'blocked' || (ruling.verdict === 'ask' && approved !== true)) {
            asked = ruling
            throw new Error(ruling.why ?? `${tool} did not run.`)
          }
          const process = plugins.process(plugin)
          if (!process) throw new Error(`${plugin} is not running`)
          const result = await process.callTool(tool)
          const said = (result.content ?? [])
            .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
            .join('\n')
            .trim()
          if (result.isError === true) throw new Error(said || `${plugin} could not do that`)
          return said || 'Done.'
        },
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          ...ran,
          // A question, not a refusal — the shell puts it to the person and sends the same
          // command back with their answer. A `blocked` ruling never gets one.
          ...(asked?.verdict === 'ask' && { ask: asked.why }),
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
      const asked = sent as Partial<Ceilings>
      // Both ceilings editable, and the preview threshold with them — a leash you cannot
      // shorten is not a leash, it is a decision somebody else made for you.
      setCeilings(store, {
        ...(typeof asked.steps === 'number' && asked.steps > 0 && { steps: Math.floor(asked.steps) }),
        ...(typeof asked.monthly === 'number' && { monthly: asked.monthly }),
        ...(typeof asked.askAbove === 'number' && asked.askAbove >= 0 && { askAbove: asked.askAbove }),
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(limitsNow()))
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
     * The control surface's tab list (M6-2).
     *
     * Assembled, never typed: core's own tabs, then one for every enabled plugin that
     * declared a panel. The shell draws whatever comes back and knows the name of nothing —
     * which is what makes deleting a folder take its tab with it, and what M6-G tests.
     *
     * A GET, and it spawns nothing, for the same reason `/api/plugins` does not.
     */
    if (url.pathname === '/api/panels') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ tabs: await plugins.tabs() }))
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
      response.end(JSON.stringify({ hits: search(asked, await searchable(surface, await plugins.tabs())) }))
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
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            ok: true,
            registry: library.url,
            // Whether a signature can be checked at all. `false` is shown, because an
            // unverified signature is exactly as good as none and must not look better.
            verifying: library.publisherKey !== undefined,
            plugins: available.map((entry) => ({ ...entry, installed: installed.has(entry.id) })),
            // What is here that has a newer version out (M5-4). The protocol window is
            // applied inside `updates`, so nothing is offered that this Alexia could not
            // then load — an update that bricks a working plugin is worse than no update.
            updates: await library
              .updates(
                plugins.ids.flatMap((id) => {
                  const manifest = plugins.manifest(id)
                  return manifest ? [{ id, version: manifest.version }] : []
                }),
                { min: ALEXIA_PROTOCOL_MIN, max: ALEXIA_PROTOCOL_MAX },
              )
              .then((rows) => rows.map(({ id, from, to }) => ({ id, from, to })))
              .catch(() => []),
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
            why: `Could not reach the registry: ${error instanceof Error ? error.message : String(error)}`,
          }),
        )
      }
      return
    }

    if (url.pathname === '/api/library/install' && request.method === 'POST') {
      const asked = sent as { id?: string; kind?: string; update?: boolean }
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
   * One task: the user's line in, and however many steps it takes to answer it.
   *
   * Not one turn any more (M15-1). What the shell gets is the same stream it always got,
   * with the step events added — so a turn that happens to need no tools looks exactly as
   * it did, which is most of them.
   */
  async function reply(sent: Body, response: ServerResponse): Promise<void> {
    const { text } = sent as { text?: string }
    if (!text) {
      response.writeHead(400)
      response.end()
      return
    }

    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    const say = (event: Record<string, unknown>): void => void response.write(`data: ${JSON.stringify(event)}\n\n`)

    const user: Message = { role: 'user', content: text }
    store.append(session, user)

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

    /**
     * The personality node (M4-4), and the two things about it that are the design.
     *
     * **It only exists when something provides it.** Default Alexia streams straight
     * through with no extra call, so nobody pays for a feature they are not using — which
     * is why this is a capability lookup off the manifests rather than a setting.
     *
     * **Only conversational output goes through it.** Everything else on this stream —
     * a permission question, a note about a charge, a step in the trace, a refusal, an
     * error — is written by core and reaches the screen untouched. Phrasing is the only
     * thing a persona may change, and the things above are the ones where the phrasing
     * *is* the fact.
     *
     * The cost is that the answer arrives at once rather than word by word: it cannot be
     * restyled until it is finished. That is the trade for choosing a voice, and it is the
     * reason the default does not pay it.
     */
    const styled = plugins.answers(CORE_CAPABILITIES.restyle)

    const stop = new AbortController()
    task = stop
    // A second consumer of the same stream (M6-5). What it keeps is what the loop did rather
    // than what the model was shown — M15-6 trims the second, and trimming this one because
    // of that would be one decision serving two jobs badly.
    const runId = randomUUID()
    trace.start(runId, text)
    try {
      const result = await run({
        messages: store.history(session),
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
        /**
         * The gate (M15-3). Built fresh per call, because the mode, the folders and the
         * boundaries can all change while a task is running — and the point of a boundary
         * spoken mid-task is that it takes effect on the next step, not the next task.
         */
        guard: async (call): Promise<Ruling> => {
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
          // The review is spent because of this task, so it lands on this task's rows.
          const review = await checker.review({ step, task: text, scope: now, run: runId })
          tally = counted(tally, review)
          return asRuling(review, step, tally)
        },
        approve: (ruling) =>
          new Promise<boolean>((resolve) => {
            pending = resolve
            say({ ask: ruling.why })
          }),
        on: {
          // Held back only when something is going to restyle it. Otherwise this is the
          // ordinary stream, unchanged, which is what most conversations get.
          delta: (delta) => {
            if (!styled) say({ delta })
          },
          note: (note) => say({ note }),
          turn: (models) => trace.turn(models),
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
            say({ step: { n: step.n, name: step.name, ...step.outcome } })
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
       * The restyle, if there is one — and its failure mode is the important part.
       *
       * A persona that is slow, broken, or has been deleted mid-task must not cost the
       * user their answer. So anything that goes wrong here falls back to the words the
       * model actually wrote, said plainly, and the person gets the answer they were
       * waiting for rather than an error about a decoration.
       */
      if (styled && last?.role === 'assistant' && last.content.trim() !== '') {
        let spoken = last.content
        try {
          const restyled = await plugins.capability(CORE_CAPABILITIES.restyle, { text: last.content })
          const said = (restyled.content ?? [])
            .map((block) => (block.type === 'text' ? block.text : ''))
            .join('')
            .trim()
          if (restyled.isError !== true && said !== '') spoken = said
        } catch (error) {
          console.error(`[restyle] ${error instanceof Error ? error.message : String(error)}`)
        }
        say({ delta: spoken })
      }

      /**
       * The offer (M4-5). Made only after a task where something was actually worked out,
       * and made **once**, at the end, where the person has just watched it happen.
       *
       * It is held here rather than acted on: nothing is written, no model is called, and
       * no money is spent until somebody says yes. A feature that quietly distilled every
       * task would be a feature that quietly spent money on every task.
       */
      const episode = { task: text, steps: result.steps, answer: last?.content ?? '' }
      if (result.ended === 'answered' && learnable(episode)) {
        lesson = episode
        say({ learn: { about: text.slice(0, 120), outline: outline(episode) } })
      }

      say({
        done: {
          model: last?.model ?? '',
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
