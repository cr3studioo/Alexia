// SPDX-License-Identifier: AGPL-3.0-only
/**
 * **The keychain migration, on this machine's real keychain** (D153, D187).
 *
 * `secrets.test.ts` runs against a stand-in, because CI builds no Rust and has no keychain; it
 * says as much, and says what to do when `vault.rs` moves. This is that, as a command rather than
 * a chore: `vault.rs` built as it is — under the service `dev.alexia.app.migration-test`, so the
 * installed app's own entry is never touched — with core's own `fromShell()` on the other side
 * and core's real old place, service `alexia`, used only for the account `zz-migration-test.*`.
 *
 * It moves an old key and a per-account one into the one entry, checks both old places are
 * emptied and nothing planted later is adopted, saves and clears, and checks a client that
 * connects and dribbles holds only itself. Everything it writes, it deletes.
 *
 * Needs cargo; on a Mac, an unlocked login keychain. Nothing here runs in CI.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const repo = join(import.meta.dirname, '..')
const shell = join(repo, 'src-tauri')
const into = join(shell, 'target', 'keychain-harness')
const service = 'const SERVICE: &str = "dev.alexia.app";'

const vaultRs = readFileSync(join(shell, 'src', 'vault.rs'), 'utf8')
if (!vaultRs.includes(service)) throw new Error(`vault.rs no longer says ${service}, so the harness cannot keep off the real entry.`)
mkdirSync(join(into, 'src'), { recursive: true })
writeFileSync(join(into, 'src', 'vault.rs'), vaultRs.replace(service, 'const SERVICE: &str = "dev.alexia.app.migration-test";'))
// The vault and nothing else: the handover line on stdout, then wait for stdin to close.
writeFileSync(
  join(into, 'src', 'main.rs'),
  [
    'mod vault;',
    'use std::io::{BufRead, Write};',
    'fn main() {',
    '    print!("{}", vault::open().expect("vault opens"));',
    '    std::io::stdout().flush().unwrap();',
    '    let _ = std::io::stdin().lock().read_line(&mut String::new());',
    '}',
    '',
  ].join('\n'),
)
// The shell's own dependency versions, so what is built here is what ships.
const manifest = readFileSync(join(shell, 'Cargo.toml'), 'utf8')
const pick = (name) => new RegExp(`^${name} = .*$`, 'm').exec(manifest)?.[0] ?? `${name} = "*"`
writeFileSync(
  join(into, 'Cargo.toml'),
  ['[package]', 'name = "keychain-harness"', 'version = "0.0.0"', 'edition = "2021"', 'publish = false', '', '[dependencies]', ...['keyring', 'serde', 'serde_json', 'getrandom'].map(pick), '', '[workspace]', ''].join('\n'),
)
copyFileSync(join(shell, 'Cargo.lock'), join(into, 'Cargo.lock'))

const env = { ...process.env, PATH: `${join(homedir(), '.cargo', 'bin')}:${process.env.PATH ?? ''}` }
const built = spawnSync('cargo', ['build', '--quiet'], { cwd: into, env, stdio: 'inherit' })
if (built.status !== 0) process.exit(built.status ?? 1)

const harness = join(into, 'target', 'debug', process.platform === 'win32' ? 'keychain-harness.exe' : 'keychain-harness')
const tsx = join(repo, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')
let status = 0
for (const check of ['migrate.ts', 'dribble.ts']) {
  console.log(`\n— ${check}`)
  const ran = spawnSync(tsx, [join(import.meta.dirname, 'keychain-check', check)], { env: { ...env, KEYCHAIN_HARNESS: harness }, stdio: 'inherit' })
  status ||= ran.status ?? 1
}
process.exit(status)
