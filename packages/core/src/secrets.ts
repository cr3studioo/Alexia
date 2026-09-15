// SPDX-License-Identifier: AGPL-3.0-only
import { deletePassword, getPassword, setPassword } from 'cross-keychain'
import { connect } from 'node:net'

/**
 * Where a `password` setting actually lives — the OS keychain, never the SQLite file.
 *
 * It is an interface because there are two holders (D153). **Under the desktop app the shell
 * holds the keychain** and core asks it through {@link fromShell}; run from a checkout or the
 * unzipped build, core holds it itself through {@link keychain}. Account `<plugin>.<key>`
 * either way, as the purge table in `docs/spec/storage.md` says.
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

/**
 * Core holding the keychain itself: service `alexia`, through `cross-keychain`.
 *
 * **Not what the desktop app uses, and why** (D153). The macOS keychain trusts a *program*,
 * and core's program is Node — so an entry this creates is readable by any script Node will
 * run, which includes every plugin and a two-line `alexia-core -e` from any terminal. Measured,
 * against a real key. It stays for a checkout and the unzipped build, which have no shell to
 * hold anything, and as the place {@link custody} moves old entries out of.
 */
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

/** What the shell writes down core's stdin before anything else: where the vault is, and the way in. */
export interface Handshake {
  port: number
  token: string
}

/**
 * Read the shell's one line off `input` — core's stdin, under the desktop app.
 *
 * **Refuses rather than waits forever, and refuses loudly.** No line means this core was not
 * started by the shell it thinks it was, and the alternative to saying so is quietly holding
 * secrets somewhere else — the failure D75 was about, one layer up.
 */
export function handshake(input: NodeJS.ReadableStream, ms = 10_000): Promise<Handshake> {
  return new Promise((resolve, reject) => {
    let said = ''
    const finish = (error: Error | undefined, found?: Handshake) => {
      clearTimeout(timer)
      input.off('data', heard)
      input.off('end', ended)
      // Paused, so a stdin nobody is reading any more does not keep this process alive.
      input.pause()
      if (error) reject(error)
      else resolve(found as Handshake)
    }
    const heard = (chunk: Buffer | string) => {
      said += String(chunk)
      const end = said.indexOf('\n')
      if (end === -1) return
      try {
        const { port, token } = JSON.parse(said.slice(0, end)) as Partial<Handshake>
        if (typeof port !== 'number' || typeof token !== 'string') throw new Error('no port or token in it')
        finish(undefined, { port, token })
      } catch (error) {
        finish(new Error(`The desktop shell's keychain handover was unreadable: ${(error as Error).message}`))
      }
    }
    const ended = () => finish(new Error('The desktop shell closed without handing over the keychain.'))
    const timer = setTimeout(
      () => finish(new Error(`The desktop shell did not hand over the keychain within ${ms / 1000} seconds.`)),
      ms,
    )
    timer.unref()
    input.on('data', heard)
    input.on('end', ended)
    input.resume()
  })
}

/** One request, one line back, one connection. What `vault.rs` answers, field for field. */
function exchange(port: number, request: object): Promise<{ ok?: true; secret?: string | null; error?: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    let said = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', (chunk: string) => {
      said += chunk
      const end = said.indexOf('\n')
      if (end === -1) return
      socket.end()
      try {
        resolve(JSON.parse(said.slice(0, end)) as { ok?: true; secret?: string | null; error?: string })
      } catch {
        reject(new Error('The desktop shell answered the keychain request with something unreadable.'))
      }
    })
    socket.on('error', reject)
    // After a resolve this is a no-op; before one, it is a shell that hung up without answering.
    socket.on('close', () => reject(new Error('The desktop shell closed the keychain request without answering.')))
  })
}

/**
 * The shell's vault, as a {@link SecretStore}: `vault.rs` on the other end of a loopback port.
 *
 * **No timeout on an answer**, deliberately. The one slow answer the keychain gives is a
 * prompt on somebody's screen, and giving up on that would refuse a secret the person was in
 * the middle of allowing.
 */
export function vault({ port, token }: Handshake): SecretStore {
  const ask = async (op: 'get' | 'set' | 'delete', name: string, secret?: string) => {
    const answer = await exchange(port, { token, op, account: name, secret })
    if (!answer.ok) throw new Error(`The keychain refused (${op} ${name}): ${answer.error ?? 'no reason given'}`)
    return answer.secret ?? undefined
  }
  return {
    get: (plugin, key) => ask('get', account(plugin, key)),
    set: async (plugin, key, secret) => void (await ask('set', account(plugin, key), secret)),
    delete: async (plugin, key) => void (await ask('delete', account(plugin, key))),
  }
}

/**
 * The shell's vault, with the entries core used to hold moved into it as they are asked for.
 *
 * **Why core moves them and the shell does not.** An entry core created trusts core's
 * program, so a core still running the runtime that wrote it reads and deletes it without a
 * prompt, where the shell reading it would always ask. If the runtime has changed since — a
 * new Node, pinned by hash like everything ad-hoc signed — the keychain asks once either way,
 * which is the prompt a Node update always cost. So a miss in the vault looks in the old
 * place, and a hit there is **copied first and deleted second** — a failure in between
 * leaves the key in both, never in neither. Setting or deleting clears the
 * old place too, so a key replaced before it was ever read cannot linger there readable by
 * any script.
 *
 * ponytail: the old place is asked on every miss, which is one local keychain lookup per
 * provider with no key. Once installs from before D153 have all been opened, `legacy` goes.
 */
export function custody(held: SecretStore, legacy: SecretStore): SecretStore {
  return {
    async get(plugin, key) {
      const secret = await held.get(plugin, key)
      if (secret !== undefined) return secret
      const left = await legacy.get(plugin, key).catch(() => undefined)
      if (left === undefined) return undefined
      await held.set(plugin, key, left)
      await legacy.delete(plugin, key)
      return left
    },
    async set(plugin, key, secret) {
      await held.set(plugin, key, secret)
      await legacy.delete(plugin, key)
    },
    async delete(plugin, key) {
      await held.delete(plugin, key)
      await legacy.delete(plugin, key)
    },
  }
}

/**
 * Secrets under the desktop app: whatever the shell hands over on `input`, with old entries
 * moved across. `boot.mjs` awaits this before serving, so a shell that hands over nothing is
 * a core that does not start — not one that quietly keeps secrets where any script can read them.
 */
export async function fromShell(input: NodeJS.ReadableStream, ms?: number): Promise<SecretStore> {
  return custody(vault(await handshake(input, ms)), keychain)
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
