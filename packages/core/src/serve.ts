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
 */
function shell(): string {
  const candidates = [join('..', '..', '..', 'ui'), join('..', '..', 'ui')].map((up) =>
    join(import.meta.dirname, up),
  )
  return candidates.find((dir) => existsSync(join(dir, 'index.html'))) ?? candidates[0]!
}

const STATIC: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  // The shell is TypeScript compiled by the same `tsc -b` as everything else. No bundler,
  // because a chat window is not a build problem.
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
    onToolsChanged: () => tooling.invalidate(),
    // The folders the user chose, as MCP roots. A plugin is told where it may work by the
    // protocol's own mechanism rather than by anything Alexia invented.
    roots: () => rootsOf(scope()),
  })
  const tooling = new PluginTooling(plugins, (line) => console.error(`[tools] ${line}`))
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
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const asset = STATIC[url.pathname]
    if (asset) {
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
