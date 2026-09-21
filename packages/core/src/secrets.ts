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
 * hold anything, and as the place {@link kept} moves old entries out of.
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
 * Core's old entries, for moving out of: {@link keychain}, except that a delete which fails says
 * so. The ordinary one swallows every error because purge deletes passwords nobody ever set;
 * moving a key out and quietly leaving it behind, readable by any script, is the one failure
 * the move exists to prevent.
 */
const oldKeychain: SecretStore = {
  get: (plugin, key) => keychain.get(plugin, key),
  set: (plugin, key, secret) => keychain.set(plugin, key, secret),
  async delete(plugin, key) {
    await deletePassword(SERVICE, account(plugin, key)).catch((error: unknown) => {
      // Gone already is what a delete is for.
      if (error instanceof Error && /not found/i.test(error.message)) return
      throw error
    })
  },
}

/** The one keychain entry everything is kept in, under the desktop app (D187). */
const WHOLE = 'vault'

/** What that entry holds. */
interface Kept {
  /** Every secret, by {@link account}. */
  secrets: Record<string, string>
  /** Accounts whose older homes have been looked in and emptied. Never looked in again. */
  looked: string[]
  /**
   * **Nothing older to look in, for any account.** Nothing in the app writes it today: the build
   * check's stand-in shell does, so checking a build never reads or deletes a real install's old
   * entries — and it is the switch for the day the older homes go altogether.
   */
  moved?: 'all'
}

function readKept(said: string): Kept {
  const kept = JSON.parse(said) as Partial<Kept>
  if (typeof kept.secrets !== 'object' || kept.secrets === null || !Array.isArray(kept.looked)) {
    throw new Error('not the shape Alexia writes')
  }
  return { secrets: kept.secrets, looked: kept.looked, ...(kept.moved === 'all' && { moved: 'all' }) }
}

/** How long a refused entry is taken at its word before it is asked again (D187). */
const REFUSED_FOR = 5 * 60 * 1000

const warn = (line: string): void => console.error(`[keychain] ${line}`)

/**
 * **The shell's vault, as one entry, with older entries moved in once** (D153, D187).
 *
 * **One entry, not one per secret.** The keychain's access list is per entry and each release is
 * a new signature, so an update used to ask once *per secret* — five dialogs in a row for three
 * provider keys and two plugin passwords, each holding up every other request behind it. Kept
 * together it is one question per update. It is read once and held in memory, since nothing but
 * this process writes it: a message no longer costs a round trip per provider.
 *
 * **One thing at a time.** Every read and write waits for the one before it. That is what makes
 * a move safe — read the old place, write here, delete the old place — against a key saved or
 * cleared halfway through it, and it keeps a keychain prompt in core (the old place is read by a
 * synchronous call) from stalling a vault request already on the wire.
 *
 * **Older homes are looked in once per account, ever.** Two of them: the per-account entries this
 * vault kept before there was one entry, and core's own from before the shell held the keychain,
 * which any script can read. A key found is **copied first and deleted second**, so a failure in
 * between leaves it in both places and never in neither; a delete that fails is said, not
 * swallowed, and tried again next launch. Once an account is settled nothing there is read again
 * — so something planted in core's old place later is never adopted, a checkout that shares that
 * place keeps what it saves there, and a miss costs nothing. A read the person refused is asked
 * again next launch rather than every time.
 */
export function kept(shell: Handshake, legacy: SecretStore = oldKeychain): SecretStore {
  const single = vault(shell)
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work)
    queue = run.catch(() => undefined)
    return run
  }

  let held: Kept | undefined
  let refused: { at: number; error: unknown } | undefined
  /**
   * The entry, read once. **A refusal is remembered for a while** rather than asked again on the
   * next read: every step reads keys, and a person who pressed Deny should not be asked again
   * before they have had a chance to do anything else. **Unreadable is never overwritten** — it
   * throws, so nothing below it saves over secrets it could not parse.
   */
  const load = async (): Promise<Kept> => {
    if (held !== undefined) return held
    if (refused !== undefined && Date.now() - refused.at < REFUSED_FOR) throw refused.error
    try {
      const said = await single.get(CORE, WHOLE)
      let parsed: Kept
      try {
        parsed = said === undefined ? { secrets: {}, looked: [] } : readKept(said)
      } catch (error) {
        throw new Error(`The keychain entry Alexia keeps its secrets in is unreadable (${(error as Error).message}), so nothing was read or changed.`, {
          cause: error,
        })
      }
      held = parsed
      refused = undefined
      return parsed
    } catch (error) {
      refused = { at: Date.now(), error }
      throw error
    }
  }
  const save = async (next: Kept): Promise<void> => {
    await single.set(CORE, WHOLE, JSON.stringify(next))
    held = next
  }

  /** Accounts already looked for this launch, settled or not, so a failure is not retried per read. */
  const tried = new Set<string>()
  const settle = async (plugin: string, key: string, adopt: boolean): Promise<void> => {
    const name = account(plugin, key)
    const before = await load()
    if (before.moved === 'all' || before.looked.includes(name) || tried.has(name)) return
    tried.add(name)
    const homes: [string, SecretStore][] = [
      ['its own entry from before there was one for everything', single],
      ['the entry core kept before the app held the keychain', legacy],
    ]
    const found: { where: string; from: SecretStore; secret: string }[] = []
    let unread = false
    for (const [where, from] of homes) {
      const there = await from.get(plugin, key).catch((error: unknown) => {
        unread = true
        warn(`${name}: could not read ${where} (${error instanceof Error ? error.message : String(error)}); asked again next launch.`)
        return undefined
      })
      if (there !== undefined) found.push({ where, from, secret: there })
    }
    const first = found[0]
    if (adopt && first !== undefined) {
      const now = await load()
      if (now.secrets[name] === undefined) await save({ ...now, secrets: { ...now.secrets, [name]: first.secret } })
    }
    let clean = !unread
    for (const { where, from } of found) {
      await from.delete(plugin, key).catch((error: unknown) => {
        clean = false
        warn(`${name}: moved, but ${where} could not be deleted (${error instanceof Error ? error.message : String(error)}); it is tried again next launch.`)
      })
    }
    if (clean) {
      const now = await load()
      await save({ ...now, looked: [...now.looked, name] })
    }
  }

  return {
    get: (plugin, key) =>
      serial(async () => {
        await settle(plugin, key, true)
        return (await load()).secrets[account(plugin, key)]
      }),
    set: (plugin, key, secret) =>
      serial(async () => {
        await settle(plugin, key, false)
        const now = await load()
        await save({ ...now, secrets: { ...now.secrets, [account(plugin, key)]: secret } })
      }),
    delete: (plugin, key) =>
      serial(async () => {
        await settle(plugin, key, false)
        const now = await load()
        const name = account(plugin, key)
        if (now.secrets[name] === undefined) return
        const rest = { ...now.secrets }
        delete rest[name]
        await save({ ...now, secrets: rest })
      }),
  }
}

/**
 * Secrets under the desktop app: whatever the shell hands over on `input`, kept as one entry
 * with older ones moved in. `boot.mjs` awaits this before serving, so a shell that hands over
 * nothing is a core that does not start — not one that quietly keeps secrets where any script
 * can read them.
 */
export async function fromShell(input: NodeJS.ReadableStream, ms?: number): Promise<SecretStore> {
  return kept(await handshake(input, ms))
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
