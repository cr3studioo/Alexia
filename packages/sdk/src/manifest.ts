// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Manifest } from '@alexia/protocol'

/**
 * Your own `plugin.json`, parsed and checked against the same schema core used before it
 * spawned you. If core loaded you, this cannot throw — which is the point: read your id,
 * your version and your declared settings from here rather than repeating them in code.
 *
 * The default is the working directory because core spawns you in your own folder.
 */
export function readManifest(dir: string = process.cwd()): Manifest {
  return Manifest.parse(JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')))
}
