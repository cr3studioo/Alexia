// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { Catalog } from './catalog.js'
import { installed, OLLAMA, running } from './ollama.js'
import { usable } from './pool.js'
import { PROVIDERS } from './provider.js'
import { MODES, route, send, type Placement } from './router.js'
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
  /** Where `index.html` lives. Defaults to `packages/ui`, beside this package. */
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

const STATIC: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  // The shell is TypeScript compiled by the same `tsc -b` as everything else. No bundler,
  // because a chat window is not a build problem.
  '/main.js': [join('dist', 'src', 'main.js'), 'text/javascript; charset=utf-8'],
}

export async function serve(options: ServeOptions = {}): Promise<Serving> {
  const root = options.dataDir ?? dataDir()
  const ui = options.uiDir ?? join(import.meta.dirname, '..', '..', 'ui')
  const secrets = options.secrets ?? keychain
  const store = new Store(join(root, 'alexia.db'))
  const catalog = new Catalog(join(root, 'cache', 'models.json'))
  const token = randomUUID()

  // The daily poll, such as it is: once at startup, and `refresh` itself declines to fetch
  // anything younger than a day old.
  const openrouter = PROVIDERS.find((p) => p.id === 'openrouter')
  if (openrouter) void catalog.refresh(openrouter)

  const session = store.sessions()[0]?.id ?? store.createSession()

  const placement = (): Placement =>
    MODES[(store.kvGet(CORE, 'mode') as keyof typeof MODES | undefined) ?? 'combined']

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
      const body = readFileSync(join(ui, file), 'utf8').replace('__TOKEN__', token)
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
          messages: store.history(session),
          spent: month.spent,
          cap: month.cap,
          warning: warning(month),
          models: (await world()).models.length + (await installed()).length,
        }),
      )
      return
    }

    if (url.pathname === '/api/chat' && request.method === 'POST') {
      await reply(request, response)
      return
    }

    response.writeHead(404)
    response.end()
  }

  /** One turn: the user's line in, the model's line out, and both kept in the history. */
  async function reply(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let raw = ''
    for await (const chunk of request) raw += String(chunk)
    const { text } = JSON.parse(raw || '{}') as { text?: string }
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
    const verdict = route({ messages: store.history(session) }, { placement: placement() }, await world())
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
