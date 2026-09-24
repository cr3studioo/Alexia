// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'
import { afterAll, expect, test } from 'vitest'
import { account, handshake, kept, memorySecrets, vault, type SecretStore } from '../src/secrets.js'
import { files } from './invariants/_repo.js'

/**
 * **The shell holds the keychain** (D153).
 *
 * Found by asking, on 2026-09-15: *is this secure enough?* It was not. The keychain trusts a
 * program, core's program is Node, and a two-line script handed to `alexia-core` read a real
 * OpenRouter key with no prompt — as could every plugin, since they are started with the same
 * binary. So under the desktop app the shell holds the entries and core asks for them over a
 * loopback port, with a token that reaches core down its stdin and nowhere else.
 *
 * **What this file cannot do is run the Rust.** CI builds no Rust, so the far end here is a
 * stand-in — which is exactly the shape D69 warned about: an interface with one implementation
 * in production and another in every test. The stand-in is checked field for field against
 * `vault.rs` below, which narrows that gap and does not close it: when `vault.rs` or the move
 * changes, run `pnpm check:keychain`, which builds `vault.rs` and moves test keys through this
 * machine's real keychain (D187).
 */

/** `vault.rs`, in forty lines of Node: the same fields in, the same fields out. */
async function standIn(token: string) {
  const entries = new Map<string, string>()
  /** Accounts the stand-in refuses, the way a keychain does when somebody presses Deny. */
  const refusing = new Set<string>()
  /** Every account asked about, in order. */
  const asked: string[] = []
  const server = createServer((socket) => {
    let said = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      said += chunk
      const end = said.indexOf('\n')
      if (end === -1) return
      const ask = JSON.parse(said.slice(0, end)) as { token: string; op: string; account: string; secret?: string }
      let answer: object
      asked.push(ask.account)
      if (ask.token !== token || refusing.has(ask.account)) answer = { error: 'refused' }
      else if (ask.op === 'get') answer = { ok: true, secret: entries.get(ask.account) ?? null }
      else if (ask.op === 'set' && typeof ask.secret === 'string') {
        entries.set(ask.account, ask.secret)
        answer = { ok: true, secret: null }
      } else if (ask.op === 'delete') {
        entries.delete(ask.account)
        answer = { ok: true, secret: null }
      } else answer = { error: 'not an operation' }
      socket.end(`${JSON.stringify(answer)}\n`)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as AddressInfo).port, entries, refusing, asked, server }
}

const TOKEN = 'a'.repeat(64)
const shell = await standIn(TOKEN)
afterAll(() => shell.server.close())

test('the handover is one line on stdin, read once', async () => {
  const input = new PassThrough()
  const reading = handshake(input)
  // In two pieces, because a pipe owes nobody a whole line per chunk.
  input.write(`{"port":${shell.port},`)
  input.write(`"token":"${TOKEN}"}\n`)
  await expect(reading).resolves.toEqual({ port: shell.port, token: TOKEN })
})

test('no handover is a refusal with a reason, never a wait that lasts forever', async () => {
  await expect(handshake(new PassThrough(), 50)).rejects.toThrow(/did not hand over the keychain/)

  const closed = new PassThrough()
  const reading = handshake(closed)
  closed.end()
  await expect(reading).rejects.toThrow(/closed without handing over/)

  const garbled = new PassThrough()
  const unreadable = handshake(garbled)
  garbled.write('Alexia is running.\n')
  await expect(unreadable).rejects.toThrow(/unreadable/)
})

test('the vault stores, reads and deletes, and nothing there is not an error', async () => {
  const secrets = vault({ port: shell.port, token: TOKEN })
  expect(await secrets.get('_core', 'provider_openrouter')).toBeUndefined()

  await secrets.set('_core', 'provider_openrouter', 'sk-or-not-a-real-key')
  expect(shell.entries.get(account('_core', 'provider_openrouter'))).toBe('sk-or-not-a-real-key')
  expect(await secrets.get('_core', 'provider_openrouter')).toBe('sk-or-not-a-real-key')

  await secrets.delete('_core', 'provider_openrouter')
  expect(await secrets.get('_core', 'provider_openrouter')).toBeUndefined()
  // Purge deletes every declared password, and most were never filled in.
  await expect(secrets.delete('hello', 'api_key')).resolves.toBeUndefined()
})

test('the vault answers several at once, which is how the pool asks', async () => {
  const secrets = vault({ port: shell.port, token: TOKEN })
  await Promise.all(['a', 'b', 'c', 'd'].map((key) => secrets.set('demo', key, `secret-${key}`)))
  expect(await Promise.all(['a', 'b', 'c', 'd'].map((key) => secrets.get('demo', key)))).toEqual([
    'secret-a',
    'secret-b',
    'secret-c',
    'secret-d',
  ])
})

test('without the token the vault refuses, and the refusal reaches the caller', async () => {
  const guess = vault({ port: shell.port, token: 'b'.repeat(64) })
  await expect(guess.get('_core', 'provider_openrouter')).rejects.toThrow(/refused/)
})

/** A shell of its own, so what one test leaves in the vault is not what the next one finds. */
const fresh = async () => {
  const one = await standIn(TOKEN)
  opened.push(one.server)
  return one
}
const opened: { close(): void }[] = []
afterAll(() => opened.forEach((server) => server.close()))

/** Core's old entries, counting what is asked of them, and failing where a test says. */
function oldPlace(fail: { get?: boolean; delete?: boolean } = {}) {
  const inner = memorySecrets()
  const reads: string[] = []
  const store: SecretStore = {
    get: (plugin, key) => {
      reads.push(account(plugin, key))
      return fail.get ? Promise.reject(new Error('User canceled the operation')) : inner.get(plugin, key)
    },
    set: (plugin, key, secret) => inner.set(plugin, key, secret),
    delete: (plugin, key) => (fail.delete ? Promise.reject(new Error('delete not allowed')) : inner.delete(plugin, key)),
  }
  return { store, inner, reads }
}

const WHOLE = account('_core', 'vault')
const whole = (shell: { entries: Map<string, string> }) => JSON.parse(shell.entries.get(WHOLE) ?? '{}') as { secrets?: Record<string, string>; looked?: string[] }

test('everything is kept in one entry, so an update asks about one entry and not one per secret (D187)', async () => {
  const shell = await fresh()
  const secrets = kept({ port: shell.port, token: TOKEN }, oldPlace().store)
  await secrets.set('_core', 'provider_openrouter', 'sk-or-1')
  await secrets.set('hello', 'api_key', 'hello-1')
  expect([...shell.entries.keys()]).toEqual([WHOLE])
  expect(whole(shell).secrets).toEqual({ '_core.provider_openrouter': 'sk-or-1', 'hello.api_key': 'hello-1' })
  expect(await secrets.get('hello', 'api_key')).toBe('hello-1')
  await secrets.delete('hello', 'api_key')
  expect(await secrets.get('hello', 'api_key')).toBeUndefined()
  // Read once and held: nothing but this process writes it, so asking again would only be slower.
  const reads = shell.asked.filter((one) => one === WHOLE).length
  await secrets.get('_core', 'provider_openrouter')
  expect(shell.asked.filter((one) => one === WHOLE).length).toBe(reads)
})

test('an old entry moves on first read: copied into the vault, then gone from where any script could read it', async () => {
  const shell = await fresh()
  const old = oldPlace()
  await old.inner.set('_core', 'provider_openrouter', 'sk-or-from-before')
  // And the per-account entry the vault itself kept before there was one entry for everything.
  shell.entries.set(account('hello', 'api_key'), 'hello-from-0.6')
  const secrets = kept({ port: shell.port, token: TOKEN }, old.store)

  expect(await secrets.get('_core', 'provider_openrouter')).toBe('sk-or-from-before')
  expect(await secrets.get('hello', 'api_key')).toBe('hello-from-0.6')
  expect(await old.inner.get('_core', 'provider_openrouter')).toBeUndefined()
  expect(shell.entries.has(account('hello', 'api_key'))).toBe(false)
  expect(whole(shell).looked).toEqual(['_core.provider_openrouter', 'hello.api_key'])
})

test('an account is looked for in the old places once, ever: nothing planted there later is adopted', async () => {
  const shell = await fresh()
  const old = oldPlace()
  const secrets = kept({ port: shell.port, token: TOKEN }, old.store)
  expect(await secrets.get('_core', 'provider_openrouter')).toBeUndefined()
  expect(old.reads).toEqual(['_core.provider_openrouter'])

  // Any script can write core's old place. Written after the account was settled, it is never read.
  await old.inner.set('_core', 'provider_openrouter', 'sk-somebody-else')
  expect(await secrets.get('_core', 'provider_openrouter')).toBeUndefined()
  const nextLaunch = kept({ port: shell.port, token: TOKEN }, old.store)
  expect(await nextLaunch.get('_core', 'provider_openrouter')).toBeUndefined()
  expect(old.reads).toEqual(['_core.provider_openrouter'])
})

test('once settled, saving or clearing a key leaves the old place alone — a checkout that shares it keeps its own', async () => {
  const shell = await fresh()
  const old = oldPlace()
  const secrets = kept({ port: shell.port, token: TOKEN }, old.store)

  // Replaced before it was ever read: cleared from the old place, not adopted.
  await old.inner.set('hello', 'api_key', 'old')
  await secrets.set('hello', 'api_key', 'new')
  expect(await old.inner.get('hello', 'api_key')).toBeUndefined()
  expect(await secrets.get('hello', 'api_key')).toBe('new')

  // The checkout saves its own there afterwards; the app clearing its copy does not touch it.
  await old.inner.set('hello', 'api_key', 'checkout')
  await secrets.delete('hello', 'api_key')
  expect(await secrets.get('hello', 'api_key')).toBeUndefined()
  expect(await old.inner.get('hello', 'api_key')).toBe('checkout')
})

test('a key saved while an old one is moving in is the one that stays', async () => {
  const shell = await fresh()
  const old = oldPlace()
  await old.inner.set('_core', 'provider_openrouter', 'old')
  const secrets = kept({ port: shell.port, token: TOKEN }, old.store)
  // Asked together, the way a background read and somebody pressing Save arrive.
  const [read] = await Promise.all([secrets.get('_core', 'provider_openrouter'), secrets.set('_core', 'provider_openrouter', 'new')])
  expect(read).toBe('old')
  expect(await secrets.get('_core', 'provider_openrouter')).toBe('new')
  // And two reads at once both see the key, rather than the second finding the old place emptied.
  const other = await fresh()
  const old2 = oldPlace()
  await old2.inner.set('_core', 'provider_groq', 'gsk-old')
  const twice = kept({ port: other.port, token: TOKEN }, old2.store)
  expect(await Promise.all([twice.get('_core', 'provider_groq'), twice.get('_core', 'provider_groq')])).toEqual(['gsk-old', 'gsk-old'])
})

test('a vault that cannot take the old entry leaves it where it was, rather than nowhere', async () => {
  const shell = await fresh()
  const old = oldPlace()
  await old.inner.set('_core', 'provider_openrouter', 'sk-or-from-before')
  shell.entries.set(WHOLE, JSON.stringify({ secrets: {}, looked: [] }))
  const secrets = kept({ port: shell.port, token: TOKEN }, old.store)
  await secrets.get('_core', 'provider_groq')
  shell.refusing.add(WHOLE)

  await expect(secrets.get('_core', 'provider_openrouter')).rejects.toThrow(/refused/)
  expect(await old.inner.get('_core', 'provider_openrouter')).toBe('sk-or-from-before')
})

test('a refused read of the old place is asked again next launch, not on every read', async () => {
  const shell = await fresh()
  const old = oldPlace({ get: true })
  const secrets = kept({ port: shell.port, token: TOKEN }, old.store)
  expect(await secrets.get('_core', 'provider_openrouter')).toBeUndefined()
  expect(await secrets.get('_core', 'provider_openrouter')).toBeUndefined()
  expect(old.reads).toHaveLength(1)
  expect(whole(shell).looked ?? []).toEqual([])
  await kept({ port: shell.port, token: TOKEN }, old.store).get('_core', 'provider_openrouter')
  expect(old.reads).toHaveLength(2)
})

test('a move whose old copy cannot be deleted says so and tries again next launch', async () => {
  const shell = await fresh()
  const old = oldPlace({ delete: true })
  await old.inner.set('_core', 'provider_openrouter', 'sk-or-from-before')
  const said: string[] = []
  const error = console.error
  console.error = (line: string) => said.push(line)
  try {
    const secrets = kept({ port: shell.port, token: TOKEN }, old.store)
    expect(await secrets.get('_core', 'provider_openrouter')).toBe('sk-or-from-before')
    expect(said.join('\n')).toMatch(/could not be deleted/)
    expect(whole(shell).looked ?? []).toEqual([])
    await kept({ port: shell.port, token: TOKEN }, old.store).get('_core', 'provider_openrouter')
    expect(old.reads).toHaveLength(2)
  } finally {
    console.error = error
  }
})

test('an entry that cannot be read is never written over, and a refusal is not asked again straight away', async () => {
  const shell = await fresh()
  shell.entries.set(WHOLE, 'not json')
  const secrets = kept({ port: shell.port, token: TOKEN }, oldPlace().store)
  await expect(secrets.set('hello', 'api_key', 'x')).rejects.toThrow(/unreadable/)
  expect(shell.entries.get(WHOLE)).toBe('not json')

  const denied = await fresh()
  denied.refusing.add(WHOLE)
  const asking = kept({ port: denied.port, token: TOKEN }, oldPlace().store)
  await expect(asking.get('hello', 'api_key')).rejects.toThrow(/refused/)
  await expect(asking.get('hello', 'api_key')).rejects.toThrow(/refused/)
  expect(denied.asked.filter((one) => one === WHOLE)).toHaveLength(1)
})

test('a shell that says there is nothing older is never made to look (the build check)', async () => {
  const shell = await fresh()
  shell.entries.set(WHOLE, JSON.stringify({ secrets: {}, looked: [], moved: 'all' }))
  const old = oldPlace()
  await old.inner.set('_core', 'provider_openrouter', 'a-real-install-s-key')
  const secrets = kept({ port: shell.port, token: TOKEN }, old.store)
  expect(await secrets.get('_core', 'provider_openrouter')).toBeUndefined()
  await secrets.delete('_core', 'provider_openrouter')
  expect(old.reads).toEqual([])
  expect(await old.inner.get('_core', 'provider_openrouter')).toBe('a-real-install-s-key')
})

const rust = () => files(['src-tauri/src/vault.rs'])[0]?.text ?? ''
const main = () => files(['src-tauri/src/main.rs'])[0]?.text ?? ''
const packager = () => files(['scripts/package.mjs'])[0]?.text ?? ''

test('the stand-in above is vault.rs: the same fields in and the same answers out', () => {
  const source = rust()
  expect(source.length, 'the scanner is actually reading vault.rs').toBeGreaterThan(1000)
  expect(source).toMatch(/token: String,\s*op: String,\s*account: String,\s*secret: Option<String>,/)
  for (const op of ['("get", _)', '("set", Some(secret))', '("delete", _)']) expect(source).toContain(op)
  expect(source).toContain('json!({ "ok": true, "secret": secret })')
  expect(source).toContain('Err(keyring::Error::NoEntry) => json!({ "ok": true, "secret": null })')
  expect(source).toContain('json!({ "port": port, "token": token })')
  // Its own name, never core's old one — reading an entry Node created would prompt.
  // The released app's name for it. Alexia Dev (`pnpm app:dev`) compiles in its own instead.
  expect(source).toContain('None => "dev.alexia.app" };')
})

test('the core the shell hands the vault to cannot be steered from outside', () => {
  const source = main()
  // Its environment rebuilt from a short list of what it needs, cleared *first* so the list
  // is the whole of what gets through — a list of what to block is never finished.
  expect(source).toMatch(/\.env_clear\(\)\s*\.envs\(std::env::vars_os\(\)\.filter\(\|\(name, _\)\| passes\(name\)\)\)/)
  // `vars()` panics on a variable that is not valid Unicode, and the release profile aborts.
  expect(source).not.toMatch(/\.envs\(std::env::vars\(\)/)
  const needed = /const NEEDED: \[&str; \d+\] = \[([^\]]*)\]/.exec(source)?.[1] ?? ''
  expect(needed).toContain('"PATH"')
  for (const steers of ['NODE_OPTIONS', 'DYLD_', 'LD_PRELOAD', 'GCONV_PATH', 'OPENSSL_', 'NODE_TLS_REJECT_UNAUTHORIZED']) {
    expect(needed).not.toContain(steers)
  }
  // The certificate variables pass on Windows alone, where the credential store trusts no program.
  expect(source).toContain('cfg!(windows) && ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"]')
  // SIGUSR1 opens Node's inspector, and any process running as this user may send it.
  expect(source).toContain('.args(["--disable-sigusr1", "boot.mjs"])')
  // And the token goes down stdin, the one channel nothing else shares — the vault opened before
  // core is started, and the child held before the write, so no failure leaves a core running loose.
  expect(source.indexOf('let handover = vault::open()?;')).toBeGreaterThan(-1)
  expect(source.indexOf('let handover = vault::open()?;')).toBeLessThan(source.indexOf('sidecar.spawn()?'))
  expect(source).toContain('held.insert(child).write(handover.as_bytes())?;')
})

test('boot waits for the handover under the app, and only there', () => {
  const source = packager()
  expect(source).toContain('const secrets = process.env.ALEXIA_TAURI ? await fromShell(process.stdin) : undefined')
  expect(source).toMatch(/await serve\(\{ port: Number\(process\.env\.ALEXIA_PORT\) \|\| 0, secrets \}\)/)
})
