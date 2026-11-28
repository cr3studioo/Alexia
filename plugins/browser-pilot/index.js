// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { log, plugin } from '@alexia/sdk'
import { browserTools, createPilot } from './pilot.js'
import { startSocket } from './socket.js'

/**
 * Browser — Alexia in the owner's own browser, through Alexia's extension. The extension
 * connects to 127.0.0.1 with a token the owner pastes once; this plugin runs on whichever
 * computer it is installed on, so each of the owner's browsers is reachable where it is.
 *
 * **The token and page text are never logged.**
 *
 * It only starts serving when run as the entry point, so importing it (as the tests do)
 * never attaches to stdio.
 */

const alexia = plugin()
const pilot = createPilot()

for (const { name, config, run } of browserTools(pilot)) alexia.tool(name, config, (args) => run(args))

/** The token as it stands; read by the socket on every hello. */
let token = ''
let socket

const newToken = () => randomBytes(32).toString('base64url')

alexia.tool(
  'browser_new_token',
  {
    description: 'Make a new code for the browser extension. The old one stops working, and the extension must be given the new one.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async () => {
    token = newToken()
    await alexia.storage.set('token', token)
    // A new code is also how the owner lets a different extension in (a reinstall changes its id).
    await alexia.storage.remove('extension_id')
    await alexia.status('token', token)
    socket?.current?.close(4001, 'bad token')
    return { content: [{ type: 'text', text: 'A new code is in Browser settings. Paste it into the extension.' }] }
  },
)

/** Listen, on the port this computer had last time when it is still free. Own dir is the working directory. */
async function serve() {
  const stored = await alexia.storage.get('token')
  token = typeof stored === 'string' && stored !== '' ? stored : newToken()
  if (token !== stored) await alexia.storage.set('token', token)
  await alexia.status('token', token)

  const portFile = join(process.cwd(), 'port.json')
  const remembered = await readFile(portFile, 'utf8').then((t) => JSON.parse(t).port, () => 0)
  socket = await startSocket({
    port: Number.isInteger(remembered) ? remembered : 0,
    token: () => token,
    pinned: async () => {
      const id = await alexia.storage.get('extension_id')
      return typeof id === 'string' ? id : undefined
    },
    pin: (id) => alexia.storage.set('extension_id', id),
    onConnect: (conn) => {
      pilot.attach(conn)
      log.info(`the ${conn.browser} extension connected`)
      conn.once('close', () => log.info('the browser extension disconnected'))
    },
  })
  if (socket.port !== remembered) await writeFile(portFile, JSON.stringify({ port: socket.port }))
  await alexia.status('port', String(socket.port))
}

if (isEntry()) {
  await alexia.start()
  await serve()
  log.info(`${alexia.manifest.name} is ready`)
}

/** True when run as the entry point (argv[1] resolved through links, as Node resolves import.meta.url). */
function isEntry() {
  if (!process.argv[1]) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}

export default alexia
