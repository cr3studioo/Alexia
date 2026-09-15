// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'
import { afterAll, expect, test } from 'vitest'
import { account, custody, handshake, memorySecrets, vault, type SecretStore } from '../src/secrets.js'
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
 * `vault.rs` below, which narrows that gap and does not close it: when `vault.rs` moves, build
 * the app, paste a key, and read it back.
 */

/** `vault.rs`, in forty lines of Node: the same fields in, the same fields out. */
async function standIn(token: string) {
  const entries = new Map<string, string>()
  const server = createServer((socket) => {
    let said = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      said += chunk
      const end = said.indexOf('\n')
      if (end === -1) return
      const ask = JSON.parse(said.slice(0, end)) as { token: string; op: string; account: string; secret?: string }
      let answer: object
      if (ask.token !== token) answer = { error: 'refused' }
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
  return { port: (server.address() as AddressInfo).port, entries, server }
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

test('an old entry moves on first read: copied into the vault, then gone from where any script could read it', async () => {
  const held = memorySecrets()
  const legacy = memorySecrets()
  await legacy.set('_core', 'provider_openrouter', 'sk-or-from-before')
  const secrets = custody(held, legacy)

  expect(await secrets.get('_core', 'provider_openrouter')).toBe('sk-or-from-before')
  expect(await held.get('_core', 'provider_openrouter')).toBe('sk-or-from-before')
  expect(await legacy.get('_core', 'provider_openrouter')).toBeUndefined()
})

test('a vault that cannot take the old entry leaves it where it was, rather than nowhere', async () => {
  const legacy = memorySecrets()
  await legacy.set('_core', 'provider_openrouter', 'sk-or-from-before')
  const broken: SecretStore = {
    get: () => Promise.resolve(undefined),
    set: () => Promise.reject(new Error('The keychain refused')),
    delete: () => Promise.resolve(),
  }

  await expect(custody(broken, legacy).get('_core', 'provider_openrouter')).rejects.toThrow(/refused/)
  expect(await legacy.get('_core', 'provider_openrouter')).toBe('sk-or-from-before')
})

test('replacing or clearing a key clears the old place too, even if it was never read', async () => {
  const held = memorySecrets()
  const legacy = memorySecrets()
  const secrets = custody(held, legacy)

  await legacy.set('hello', 'api_key', 'old')
  await secrets.set('hello', 'api_key', 'new')
  expect(await legacy.get('hello', 'api_key')).toBeUndefined()
  expect(await secrets.get('hello', 'api_key')).toBe('new')

  await legacy.set('hello', 'api_key', 'old')
  await secrets.delete('hello', 'api_key')
  expect(await legacy.get('hello', 'api_key')).toBeUndefined()
  expect(await secrets.get('hello', 'api_key')).toBeUndefined()
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
  expect(source).toContain('const SERVICE: &str = "dev.alexia.app";')
})

test('the core the shell hands the vault to cannot be steered from outside', () => {
  const source = main()
  // Its environment rebuilt without the variables that change what Node runs or trusts,
  // cleared *first* so the filter is the whole of what gets through.
  expect(source).toMatch(/\.env_clear\(\)\s*\.envs\(std::env::vars_os\(\)\.filter\(\|\(name, _\)\| !steers_node\(name\)\)\)/)
  // `vars()` panics on a variable that is not valid Unicode, and the release profile aborts.
  expect(source).not.toMatch(/\.envs\(std::env::vars\(\)/)
  for (const prefix of ['"NODE_"', '"DYLD_"', '"LD_"', '"OPENSSL_"']) expect(source).toContain(prefix)
  // SIGUSR1 opens Node's inspector, and any process running as this user may send it.
  expect(source).toContain('.args(["--disable-sigusr1", "boot.mjs"])')
  // And the token goes down stdin, the one channel nothing else shares.
  expect(source).toContain('child.write(vault::open()?.as_bytes())?;')
})

test('boot waits for the handover under the app, and only there', () => {
  const source = packager()
  expect(source).toContain('const secrets = process.env.ALEXIA_TAURI ? await fromShell(process.stdin) : undefined')
  expect(source).toMatch(/await serve\(\{ port: Number\(process\.env\.ALEXIA_PORT\) \|\| 0, secrets \}\)/)
})
