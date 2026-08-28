// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { run, said } from './agent.js'
import { Catalog } from './catalog.js'
import { asRuling, counted, freshTally, ModelChecker, type Tally } from './checker.js'
import { commands, pins, run as runCommand } from './commands.js'
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
import { MODES } from './router.js'
import { CORE, keychain, type SecretStore } from './secrets.js'
import { Skills } from './skills.js'
import { dataDir, Store, type Message } from './store.js'
import { PluginTooling } from './tooling.js'
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
  const candidates = [join('..', '..', '..', 'ui'), join('..', '..', 'ui'), 'ui'].map((up) =>
    join(import.meta.dirname, up),
  )
  return candidates.find((dir) => existsSync(join(dir, 'index.html'))) ?? candidates[0]!
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

  /**
   * Everything installed, and the aggregate of what it can do (M15-2).
   *
   * The loop asks `tooling.list()` on every step and this cache answers it, so a folder
   * deleted mid-task is noticed on the next step rather than at the end of the run — which
   * is invariant 4 meeting the agent loop, and what M15-8 tests.
   */
  const plugins = new Plugins({
    dir: options.pluginsDir ?? join(root, 'extensions'),
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
  })
  /**
   * Know-how (M2-2). Two arrival routes and one format: folders the user installed on their
   * own, and folders a plugin declared — which is why the bundled half is a function rather
   * than a list. Deleting the plugin deletes its skills, and the next read simply finds
   * fewer folders.
   */
  const skills = new Skills({
    dir: join(root, 'skills'),
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
   * The second opinion (M15-4). Local by default — a reviewer that ships what it is
   * reviewing to somebody else's API has leaked the very file it was asked about.
   *
   * The tally lives here rather than in the checker because *this session* is what the
   * give-up rule counts, and the checker itself is stateless on purpose.
   */
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
      const chosen = JSON.parse(await read(request)) as {
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

    if (url.pathname === '/api/command' && request.method === 'POST') {
      const { input } = JSON.parse(await read(request)) as { input?: string }
      const ran = await runCommand(input ?? '', {
        store,
        manifests: manifests(),
        // A command is bound to the plugin tool of the same name — the whole binding, and
        // why a manifest declares a command with a name and a sentence and nothing else.
        call: async (plugin, tool) => {
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
      response.end(JSON.stringify({ ...ran, setup: setup(), pins: { ...pins(store), placement: undefined } }))
      return
    }

    if (url.pathname === '/api/permissions' && request.method === 'POST') {
      const asked = JSON.parse(await read(request)) as {
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
      const asked = JSON.parse(await read(request)) as Partial<Ceilings>
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
      const { allowed } = JSON.parse(await read(request)) as { allowed?: boolean }
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
          // Broken skills ride the same list as broken plugin folders, because they are the
          // same sentence to the same person: this folder is here and is doing nothing.
          skillProblems: skills.problems,
        }),
      )
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
      const asked = JSON.parse(await read(request)) as { id?: string; action?: string }
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
      const { path } = JSON.parse(await read(request)) as { path?: string }
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

    if (url.pathname === '/api/settings' && request.method === 'POST') {
      const edit = JSON.parse(await read(request)) as { plugin?: string; key?: string; value?: unknown }
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
      const press = JSON.parse(await read(request)) as { plugin?: string; key?: string; approved?: boolean }
      const plugin = press.plugin ?? ''
      const declared = plugins
        .manifest(plugin)
        ?.settings?.find((setting) => setting.key === press.key && setting.type === 'action')
      if (declared?.type !== 'action') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, said: `There is no button called "${press.key ?? ''}".` }))
        return
      }

      const about = await tooling.about(`${plugin}__${declared.tool}`)
      const ruling = rule(
        {
          tool: declared.tool,
          ...(about?.annotations && { annotations: about.annotations }),
          reviewed: true,
        },
        scope(),
      )
      if (ruling.verdict === 'blocked' || (ruling.verdict === 'ask' && press.approved !== true)) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify(
            ruling.verdict === 'blocked' ? { ok: false, said: ruling.why } : { ok: false, ask: ruling.why },
          ),
        )
        return
      }

      const result = await plugins.action(plugin, declared.key)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ...result, panes: await plugins.panes() }))
      return
    }

    if (url.pathname === '/api/chat' && request.method === 'POST') {
      await reply(request, response)
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
  async function reply(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const { text } = JSON.parse(await read(request)) as { text?: string }
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

    const stop = new AbortController()
    task = stop
    try {
      const result = await run({
        messages: store.history(session),
        tools: tooling,
        pins: pins(store),
        world,
        store,
        secrets,
        session,
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
              // ponytail: M3-6 adds servers nobody reviewed, and this is where they become
              // `false`. Everything installed today came from this repo.
              reviewed: true,
            },
            now,
          )
          // The fixed rules have already spoken. The checker is coverage on top of them and
          // never instead of them, so it is only asked about something they would let run.
          if (ruling.verdict !== 'run' || now.mode !== 'watch') return ruling

          const step = { n: 0, name: call.name, args: call.args }
          const review = await checker.review({ step, task: text, scope: now })
          tally = counted(tally, review)
          return asRuling(review, step, tally)
        },
        approve: (ruling) =>
          new Promise<boolean>((resolve) => {
            pending = resolve
            say({ ask: ruling.why })
          }),
        on: {
          delta: (delta) => say({ delta }),
          note: (note) => say({ note }),
          step: (step) => say({ step: { n: step.n, name: step.name, args: step.args } }),
          done: (step) => say({ step: { n: step.n, name: step.name, ...step.outcome } }),
        },
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
