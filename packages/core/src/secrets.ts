// SPDX-License-Identifier: AGPL-3.0-only
import { deletePassword, getPassword, setPassword } from 'cross-keychain'

/**
 * Where a `password` setting actually lives — the OS keychain, never the SQLite file.
 *
 * It is an interface because the implementation changes: `cross-keychain` now, Tauri's own
 * keyring at M5. One file swaps, and nothing above it notices. Service `alexia`, account
 * `<plugin>.<key>`, as the purge table in `docs/spec/storage.md` says.
 */
export interface SecretStore {
  get(plugin: string, key: string): Promise<string | undefined>
  set(plugin: string, key: string, secret: string): Promise<void>
  delete(plugin: string, key: string): Promise<void>
}

/**
 * Core's own scope, for the things that are not a plugin's — a provider key, at M1-4. It
 * starts with an underscore, which a plugin id cannot: ids are lowercase letters, digits
 * and hyphens, so nothing installable can ever collide with it.
 */
export const CORE = '_core'

const SERVICE = 'alexia'

/**
 * Which entry in the keychain, from the plugin and the key.
 *
 * **A dot, not a slash.** `cross-keychain` refuses an account name containing anything but
 * alphanumerics, dots, underscores, `@` and hyphens — so the `<plugin>/<key>` this used to
 * build threw on every read and every write, on a real machine, in both directions. Nothing
 * caught it because every test uses {@link memorySecrets}, which has no such rule: the first
 * thing to touch the real store was M2-1's settings screen.
 *
 * A dot is unambiguous as well as legal. A plugin id is lowercase letters, digits and
 * hyphens; a setting key is lowercase letters, digits and underscores. Neither can contain
 * one, so `hello.api_key` splits exactly one way.
 */
export const account = (plugin: string, key: string): string => `${plugin}.${key}`

/** What the store above will accept. The reason this constant exists is the bug above. */
export const ACCOUNT_ALLOWED = /^[A-Za-z0-9._@-]+$/

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
