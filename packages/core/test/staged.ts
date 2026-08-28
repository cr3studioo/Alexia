// SPDX-License-Identifier: AGPL-3.0-only
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = join(import.meta.dirname, '..', '..', '..')

/**
 * A plugins directory a test can delete folders out of, without deleting the repo's.
 *
 * Each staged folder holds the real plugin's `plugin.json` with one field rewritten: the
 * entry points at the real script by absolute path. That is deliberate rather than a copy —
 * deleting a plugin means deleting the folder core reads, and a process that has already
 * loaded its code keeps running exactly as it does in life. Copying the folder would drag
 * `node_modules` along and prove less. Bundled skills (M2-2) are the exception: they are
 * text inside the folder, they are read from the folder core is watching, and they are what
 * a purge has to take with it — so they are copied.
 */
export function stage(...ids: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'alexia-plugins-'))
  for (const id of ids) {
    const from = join(repo, 'plugins', id)
    const manifest = JSON.parse(readFileSync(join(from, 'plugin.json'), 'utf8')) as {
      entry: { args?: string[] }
      skills?: string[]
    }
    manifest.entry.args = manifest.entry.args?.map((arg) =>
      arg.endsWith('.js') ? join(from, arg) : arg,
    )
    mkdirSync(join(root, id), { recursive: true })
    writeFileSync(join(root, id, 'plugin.json'), JSON.stringify(manifest, null, 2))
    for (const skill of manifest.skills ?? []) {
      cpSync(join(from, skill), join(root, id, skill), { recursive: true })
    }
  }
  return root
}
