// SPDX-License-Identifier: AGPL-3.0-only
import { deletePassword, getPassword, setPassword } from 'cross-keychain'

/**
 * Where a `password` setting actually lives — the OS keychain, never the SQLite file.
 *
 * It is an interface because the implementation changes: `cross-keychain` now, Tauri's own
 * keyring at M5. One file swaps, and nothing above it notices. Service `alexia`, account
 * `<plugin>/<key>`, exactly as the purge table in `docs/spec/storage.md` says.
 */
export interface SecretStore {
  get(plugin: string, key: string): Promise<string | undefined>
  set(plugin: string, key: string, secret: string): Promise<void>
  delete(plugin: string, key: string): Promise<void>
}

const SERVICE = 'alexia'
const account = (plugin: string, key: string): string => `${plugin}/${key}`

export const keychain: SecretStore = {
  async get(plugin, key) {
    return (await getPassword(SERVICE, account(plugin, key))) ?? undefined
  },

  set(plugin, key, secret) {
    return setPassword(SERVICE, account(plugin, key), secret)
  },

  async delete(plugin, key) {
    // Purge runs this for every declared `password`, and most were never filled in.
    // Deleting one that was never there is the expected case, not a failure.
    await deletePassword(SERVICE, account(plugin, key)).catch(() => {})
  },
}

/**
 * The same interface, remembering nothing past this process. Tests use it — a CI runner has
 * no keychain daemon and should not grow one — and so does the conformance suite, which has
 * no business writing to a plugin author's real credential store.
 */
export function memorySecrets(): SecretStore {
  const vault = new Map<string, string>()
  return {
    get: (plugin, key) => Promise.resolve(vault.get(account(plugin, key))),
    set: (plugin, key, secret) => Promise.resolve(void vault.set(account(plugin, key), secret)),
    delete: (plugin, key) => Promise.resolve(void vault.delete(account(plugin, key))),
  }
}
