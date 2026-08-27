// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Manifest } from '@alexia/protocol'

/**
 * Your own `plugin.json`, parsed and checked against the same schema core used before it
 * spawned you. If core loaded you, this cannot throw — which is the point: read your id,
 * your version and your declared settings from here rather than repeating them in code.
 *
 * Your folder is `ALEXIA_PLUGIN_DIR`, **not** the working directory: a running process's
 * working directory cannot be deleted on Windows, and being deletable is the whole point
 * of a plugin folder.
 */
export function readManifest(dir: string = process.env.ALEXIA_PLUGIN_DIR ?? process.cwd()): Manifest {
  return Manifest.parse(JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')))
}
