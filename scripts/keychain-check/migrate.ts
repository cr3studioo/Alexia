// SPDX-License-Identifier: AGPL-3.0-only
// The keychain migration, on this Mac's real login keychain: the shell's vault.rs (under a test
// service name) on one side, core's own `fromShell()` on the other, and core's real old place
// (service `alexia`) — only ever with the test accounts below.
import { spawn, type ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { fromShell, keychain, vault, type SecretStore } from '../../packages/core/src/secrets.ts'

const harness = process.env.KEYCHAIN_HARNESS ?? ''
const PLUGIN = 'zz-migration-test'
let failures = 0
const check = (what: string, ok: boolean, got?: unknown) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : `  (got ${JSON.stringify(got)})`}`)
  if (!ok) failures += 1
}

/** One launch of the shell: its vault, and the line it hands core. */
async function shell(): Promise<{ child: ChildProcess; line: string }> {
  const child = spawn(harness, [], { stdio: ['pipe', 'pipe', 'inherit'] })
  const line = await new Promise<string>((resolve) => {
    let said = ''
    child.stdout!.on('data', (chunk) => {
      said += String(chunk)
      if (said.includes('\n')) resolve(said)
    })
  })
  return { child, line }
}
/** Core, started by that shell: `fromShell` reading the handover off "stdin". */
async function core(line: string): Promise<SecretStore> {
  const input = new PassThrough()
  input.write(line)
  return fromShell(input)
}

const { child, line } = await shell()
const { port, token } = JSON.parse(line) as { port: number; token: string }
const raw = vault({ port, token })
const whole = async () => JSON.parse((await raw.get('_core', 'vault')) ?? '{}') as { secrets?: Record<string, string>; looked?: string[] }

// A clean start, whatever a previous run left.
for (const key of ['api_key', 'token', 'fresh']) {
  await keychain.delete(PLUGIN, key)
  await raw.delete(PLUGIN, key)
}
await raw.delete('_core', 'vault')

// Before: a key core kept itself (service `alexia`, written by this Node), and one the vault kept
// per account before there was one entry for everything (written by this vault's program).
await keychain.set(PLUGIN, 'api_key', 'legacy-secret')
await raw.set(PLUGIN, 'token', 'd153-secret')
check('seeded: core’s old place holds its key', (await keychain.get(PLUGIN, 'api_key')) === 'legacy-secret')
check('seeded: the vault holds a per-account entry', (await raw.get(PLUGIN, 'token')) === 'd153-secret')

// First launch after the update.
const first = await core(line)
check('first read moves core’s old key in', (await first.get(PLUGIN, 'api_key')) === 'legacy-secret')
check('first read moves the per-account entry in', (await first.get(PLUGIN, 'token')) === 'd153-secret')
check('core’s old place is emptied', (await keychain.get(PLUGIN, 'api_key')) === undefined, await keychain.get(PLUGIN, 'api_key'))
check('the per-account entry is emptied', (await raw.get(PLUGIN, 'token')) === undefined)
const after = await whole()
check('both live in the one entry', after.secrets?.[`${PLUGIN}.api_key`] === 'legacy-secret' && after.secrets?.[`${PLUGIN}.token`] === 'd153-secret', after.secrets)
check('both accounts are recorded as settled', (after.looked ?? []).includes(`${PLUGIN}.api_key`) && (after.looked ?? []).includes(`${PLUGIN}.token`), after.looked)
check('nothing else was touched', Object.keys(after.secrets ?? {}).every((name) => name.startsWith(`${PLUGIN}.`)), Object.keys(after.secrets ?? {}))

// Something writes core's old place after the move — any script can.
await keychain.set(PLUGIN, 'api_key', 'planted')
child.stdin!.end()
await new Promise((resolve) => child.once('exit', resolve))

// Next launch: a new shell process, same program, same entry.
const again = await shell()
const second = await core(again.line)
check('the next launch reads what was moved', (await second.get(PLUGIN, 'api_key')) === 'legacy-secret')
check('something planted in the old place later is not adopted', (await second.get(PLUGIN, 'api_key')) === 'legacy-secret')
check('…and is left where it was, for whoever put it there', (await keychain.get(PLUGIN, 'api_key')) === 'planted')

// Saving and clearing, after the move.
await second.set(PLUGIN, 'fresh', 'new-value')
check('a new key is saved into the one entry', (await second.get(PLUGIN, 'fresh')) === 'new-value')
await second.delete(PLUGIN, 'token')
check('a cleared key is gone', (await second.get(PLUGIN, 'token')) === undefined)
const raw2 = vault(JSON.parse(again.line) as { port: number; token: string })
const last = JSON.parse((await raw2.get('_core', 'vault')) ?? '{}') as { secrets?: Record<string, string> }
check('the entry holds exactly what is left', JSON.stringify(Object.keys(last.secrets ?? {}).sort()) === JSON.stringify([`${PLUGIN}.api_key`, `${PLUGIN}.fresh`]), last.secrets)
// Five at once, the way the startup poll asks.
const burst = await Promise.all(Array.from({ length: 5 }, () => second.get(PLUGIN, 'fresh')))
check('several at once all answer', burst.every((one) => one === 'new-value'), burst)

// Cleanup: the test accounts and the test entry, nothing else.
await keychain.delete(PLUGIN, 'api_key')
await raw2.delete('_core', 'vault')
check('cleaned up: no test entry left in core’s old place', (await keychain.get(PLUGIN, 'api_key')) === undefined)
check('cleaned up: no test vault entry left', (await raw2.get('_core', 'vault')) === undefined)
again.child.stdin!.end()
console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)