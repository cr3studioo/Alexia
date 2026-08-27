// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { Catalog } from './catalog.js'
import { commands, pins, run } from './commands.js'
import { installed, OLLAMA, running } from './ollama.js'
import { usable } from './pool.js'
import { keyOf, PROVIDERS } from './provider.js'
import { MODES, route, send } from './router.js'
import { CORE, keychain, type SecretStore } from './secrets.js'
import { dataDir, Store, type Message } from './store.js'
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
   * First run, steps 2 to 4a. Done means a mode was chosen — the name is skippable and a
   * provider can wait, but *where your words go* is not a question Alexia answers for you.
   */
  const setup = () => ({
    done: store.kvGet(CORE, 'mode') !== undefined,
    name: (store.kvGet(CORE, 'display_name') as string | undefined) ?? 'Alexia',
    mode: (store.kvGet(CORE, 'mode') as string | undefined) ?? 'combined',
  })

  /** Everything the router needs to know, asked fresh: a tier can be exhausted mid-sentence. */
  const world = async () => ({
    models: catalog.models,
    local: (await running()) ? await installed() : [],
    rungs: await usable(store, secrets),
  })

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
          commands: commands(),
          pins: { ...pins(store), placement: undefined },
          messages: store.history(session),
          spent: month.spent,
          cap: month.cap,
          warning: warning(month),
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
      const ran = await run(input ?? '', { store })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ...ran, setup: setup(), pins: { ...pins(store), placement: undefined } }))
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

  /** One turn: the user's line in, the model's line out, and both kept in the history. */
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

    const month = allowance(store)
    const verdict = route({ messages: store.history(session) }, pins(store), await world())
    if (!verdict.ok) {
      // The refusal is the answer. It is written to be read by the person who has to act
      // on it, so it goes to the screen exactly as the router wrote it.
      say({ error: verdict.why })
      response.end()
      return
    }

    try {
      const answer = await send(verdict.choices, { messages: store.history(session) }, store, secrets, {
        session,
        paidAllowed: !month.stop,
        onDelta: (delta) => say({ delta }),
        onNote: (note) => say({ note }),
      })
      store.append(session, answer.message)
      const after = allowance(store)
      say({ done: { model: answer.model.name, tier: answer.model.tier, spent: after.spent, warning: warning(after) } })
    } catch (error) {
      say({ error: error instanceof Error ? error.message : String(error) })
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
      await new Promise<void>((resolve) => server.close(() => resolve()))
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
