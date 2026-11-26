// SPDX-License-Identifier: AGPL-3.0-only
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { log, plugin } from '@alexia/sdk'
import { createInk } from './ink.js'
import { macos } from './macos.js'
import { startProcess } from './run.js'
import { register } from './tools.js'
import { windows } from './windows.js'

/**
 * Screen ink — boxes, arrows, labels and Alexia's own cursor, on a see-through layer over the
 * screen that never takes a click or the focus. The layer is a helper process that starts when
 * something is first drawn and leaves a minute after nothing is.
 *
 * It only starts serving when run as the entry point, so importing it (as the tests do)
 * never attaches to stdio.
 */

const alexia = plugin()

const backend = { win32: windows, darwin: macos }[process.platform]
const ink = backend && createInk({ backend: backend(), start: startProcess, warn: (why) => log.warn(`screen ink: ${why}`) })

register(alexia, ink)

if (isEntry()) {
  // Core's end of stdin closing ends this process, and with it the helper's, which then quits.
  process.once('exit', () => ink?.close())
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
