// SPDX-License-Identifier: AGPL-3.0-only
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { log, plugin } from '@alexia/sdk'
import { createDeck } from './deck.js'
import { macosBackend } from './macos.js'
import { registerTools } from './tools.js'
import { windowsBackend } from './windows.js'

/**
 * Windows — list and arrange the open windows, remember layouts, and quit apps (PC-03, PC-04).
 *
 * Opening an app and bringing a window forward belong to whatever controls the computer; this is
 * the rest. Layouts live in this plugin's own table `layouts` and never leave the computer.
 *
 * It only starts serving when run as the entry point, so importing it (as the tests do)
 * never attaches to stdio.
 */

const alexia = plugin()

const backend =
  process.platform === 'win32' ? windowsBackend()
  : process.platform === 'darwin' ? macosBackend()
  : undefined

registerTools(alexia, backend && createDeck({ backend, storage: alexia.storage }))

if (isEntry()) {
  await alexia.start()
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
