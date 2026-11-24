// SPDX-License-Identifier: AGPL-3.0-only
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await alexia.start()
  log.info(`${alexia.manifest.name} is ready`)
}

export default alexia
