// SPDX-License-Identifier: AGPL-3.0-only
import { join } from 'node:path'
import { readRole } from './compute/role.js'
import { computeServe } from './compute/service.js'
import { noShell, shellPipe, type Shell } from './compute/shell.js'
import type { Role } from './compute/types.js'
import type { SecretStore } from './secrets.js'
import { serve } from './serve.js'
import { dataDir, Store } from './store.js'

// For `boot.mjs`, which imports the bundle this file is the entry of and nothing else (D153).
export { serve } from './serve.js'
export { fromShell } from './secrets.js'

export interface Started { url: string; role: Role; close(): Promise<void> }

export interface StartOptions {
  port?: number
  secrets?: SecretStore
  dataDir?: string
  uiDir?: string
  /** The desktop shell. Default: the pipes under the app (`ALEXIA_TAURI`), nothing from a checkout. */
  shell?: Shell
}

/**
 * **The bundle's entry: one role's service, and only that one** (`remote-compute.md` §1.6).
 *
 * The store is opened just long enough to read the role and closed again, so the service that
 * starts owns the database alone. In the interaction role that is `serve()`, as it always was.
 * In the compute role `serve()` is never called, so none of the assistant exists — which is
 * the point of the role. A restart after a role switch comes back through here and reads the
 * role the switch wrote.
 */
export async function start(options: StartOptions = {}): Promise<Started> {
  const root = options.dataDir ?? dataDir()
  const store = new Store(join(root, 'alexia.db'))
  let role: Role
  try { role = readRole(store) } finally { store.close() }
  const shell = options.shell ?? (process.env.ALEXIA_TAURI ? shellPipe() : noShell())
  const common = {
    dataDir: root,
    ...(options.port !== undefined && { port: options.port }),
    ...(options.secrets && { secrets: options.secrets }),
    ...(options.uiDir !== undefined && { uiDir: options.uiDir }),
  }
  if (role === 'compute') {
    const { url, close } = await computeServe({ ...common, shell })
    return { url, role, close }
  }
  // The shell is only how a role switch restarts the app (T13's deviation 9).
  const { url, close } = await serve({ ...common, compute: { shell } })
  return { url, role, close }
}

if (import.meta.main) {
  const { url, role } = await start()
  // stdout is not a wire here — this is the app, not a plugin.
  console.log(`Alexia (${role}) is at ${url}`)
}
