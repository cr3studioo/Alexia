// SPDX-License-Identifier: AGPL-3.0-only
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { log, plugin } from '@alexia/sdk'

/**
 * Google — a skeleton. It loads, says hello and offers no tools yet; the task for this
 * plugin (see v3/specs/P3) fills it in.
 *
 * It only starts serving when run as the entry point, so importing it (as the load test does)
 * never attaches to stdio.
 */

const alexia = plugin()

if (isEntry()) {
  await alexia.start()
  log.info(`${alexia.manifest.name} is ready`)
}

/** True when run as the entry point. argv[1] is resolved through links (a junction or symlink
 * to the plugins folder, macOS /var), because Node already resolves import.meta.url. */
function isEntry() {
  if (!process.argv[1]) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}

export default alexia
