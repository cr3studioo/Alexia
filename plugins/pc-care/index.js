// SPDX-License-Identifier: AGPL-3.0-only
import { realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { log, plugin } from '@alexia/sdk'
import { createCare } from './care.js'
import { macosBackend } from './macos.js'
import { createPower } from './power.js'
import { registerTools } from './tools.js'
import { windowsBackend } from './windows.js'

/**
 * Computer care — settings, maintenance and power on this computer (PC-08, PC-09, PC-10).
 *
 * Nothing here is logged but what happened to a waiting power action: file names, startup items
 * and settings stay in the answers.
 *
 * It only starts serving when run as the entry point, so importing it (as the tests do)
 * never attaches to stdio.
 */

const alexia = plugin()

const backend =
  process.platform === 'win32' ? windowsBackend()
  : process.platform === 'darwin' ? macosBackend()
  : undefined

registerTools(
  alexia,
  backend && {
    care: createCare({
      backend,
      temp: tmpdir(),
      home: homedir(),
      system: process.platform === 'win32' ? process.env.SystemRoot : undefined,
    }),
    power: createPower({ backend, log: (text) => log.warn(text) }),
  },
)

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
