// SPDX-License-Identifier: AGPL-3.0-only
/**
 * *Alexia Dev*: this checkout, built and installed beside the real Alexia, for trying a change
 * on this Mac before anybody else can see it. `pnpm app:dev`.
 *
 * **Nothing here is outward-facing.** No release, no upload, no signature. The build is the
 * same one `pnpm app` makes, with `src-tauri/tauri.dev.conf.json` laid over it and two
 * variables compiled in, so that it is a different app to macOS in every way that matters:
 *
 *   name          Alexia Dev.app, beside Alexia.app in /Applications
 *   identifier    dev.alexia.app.dev — its own single-instance lock and its own launch agent
 *   data          ~/Library/Application Support/Alexia Dev   (`ALEXIA_DEV_NAME`, `store.ts`)
 *   keychain      its own entry, under dev.alexia.app.dev     (`ALEXIA_KEYCHAIN`, `vault.rs`)
 *   updates       none — no endpoint, so it never turns itself back into the released Alexia
 *
 * **The real Alexia's data is copied in the first time**, and again with `--fresh-data`, which
 * throws away whatever the dev copy has done since. Copied, never shared: the real folder is
 * only read, the database through SQLite's own backup so a running Alexia is copied whole
 * rather than half-written. The keychain entry is copied too — macOS asks once whether
 * `security` may read Alexia's entry — and it is marked as having nothing older to move in,
 * which is the switch that keeps a second install from deleting the first one's old entries
 * (`Kept.moved` in `secrets.ts`).
 *
 * **Telegram is switched off in the copy.** The keychain entry holds the bot token, and a
 * Telegram bot hands its messages to one poller at a time: with both apps running, both would
 * poll the one bot, answer some of the messages each, and send every reminder and morning
 * summary twice. So the copied database has `telegram` taken out of the list of switched-on
 * plugins (`enabled` in core's `kv`, `plugins.ts`). Only the copy is changed — the real
 * database is read through the backup and never written. The token stays, so switching
 * Telegram on in Alexia Dev is one click when that is the thing being tried; the two then take
 * turns with the bot every few minutes rather than fighting over it (`clash.js`), and the
 * other copy's Telegram screen says it is paused.
 *
 *   pnpm app:dev                     build, install, open
 *   pnpm app:dev --fresh-data        …and replace the dev data with a new copy of the real one
 *   pnpm app:dev --data-only         just the new copy, no build
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = 'Alexia Dev'
const KEYCHAIN = 'dev.alexia.app.dev'
const REAL_KEYCHAIN = 'dev.alexia.app'
/** `account(CORE, WHOLE)` in `secrets.ts`: the one entry every secret is kept in. */
const VAULT = '_core.vault'

if (process.platform !== 'darwin') {
  console.error(`${NAME} is a Mac build, and this is ${process.platform}.`)
  process.exit(1)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const support = join(homedir(), 'Library', 'Application Support')
const real = join(support, 'Alexia')
const dev = join(support, NAME)
const installed = join('/Applications', `${NAME}.app`)
const dataOnly = process.argv.includes('--data-only')
// rustup installs into ~/.cargo/bin and adds it to the login shell's PATH only, so a preview
// started by an agent or an editor would find no `rustc` and stop before building anything.
const cargo = join(homedir(), '.cargo', 'bin')
if (existsSync(cargo) && !(process.env.PATH ?? '').split(':').includes(cargo)) {
  process.env.PATH = `${cargo}:${process.env.PATH ?? ''}`
}
const fresh = dataOnly || process.argv.includes('--fresh-data') || !existsSync(dev)

function run(command, args, options = {}) {
  const done = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options })
  if (done.status !== 0) {
    console.error(`\n${command} ${args.join(' ')} failed.`)
    process.exit(done.status ?? 1)
  }
  return done
}

/** Quit the dev copy if it is running — by name, so the real Alexia is never asked to. */
function quitDev() {
  spawnSync('osascript', ['-e', `if application "${NAME}" is running then tell application "${NAME}" to quit`], { stdio: 'ignore' })
  // Its core is a child that goes with it; give both a moment to let go of the database.
  spawnSync('sleep', ['2'])
}

function copyData() {
  if (!existsSync(real)) {
    console.log(`No real Alexia data at ${real}, so ${NAME} starts empty.`)
    return
  }
  console.log(`Copying ${real}\n     to ${dev}`)
  rmSync(dev, { recursive: true, force: true })
  mkdirSync(dev, { recursive: true })
  for (const name of readdirSync(real)) {
    // The database is copied below, whole; the `.before-*` files are hand-made backups.
    if (name.startsWith('alexia.db') || name.includes('.before-')) continue
    cpSync(join(real, name), join(dev, name), { recursive: true })
  }
  if (existsSync(join(real, 'alexia.db'))) {
    run('sqlite3', [join(real, 'alexia.db'), `.backup '${join(dev, 'alexia.db').replaceAll("'", "''")}'`])
    offTelegram()
  }
  copyKeychain()
}

/**
 * Switch Telegram off in the dev copy's database — the copy only, after the backup has
 * finished with the real one. See the header for why.
 */
function offTelegram() {
  const off = `UPDATE kv SET value = (
      SELECT json_group_array(value) FROM json_each(kv.value) WHERE value <> 'telegram'
    ) WHERE ns = '_core' AND key = 'enabled' AND json_valid(value) AND json_type(value) = 'array';`
  const done = spawnSync('sqlite3', [join(dev, 'alexia.db'), off], { stdio: ['ignore', 'ignore', 'inherit'] })
  if (done.status === 0) {
    console.log(`Telegram is switched off in ${NAME}, so the two apps do not share the bot. Switch it on in ${NAME} to try it.`)
  } else {
    console.error(`Could not switch Telegram off in ${NAME}. If both apps run, switch it off there by hand.`)
  }
}

function copyKeychain() {
  const read = spawnSync('security', ['find-generic-password', '-s', REAL_KEYCHAIN, '-a', VAULT, '-w'], { encoding: 'utf8' })
  let kept = { secrets: {}, looked: [] }
  if (read.status === 0) {
    try {
      kept = JSON.parse(read.stdout.trim())
    } catch {
      console.error('The real keychain entry is not the shape Alexia writes, so the dev copy starts with no keys.')
    }
  } else {
    console.log('No keychain entry read from the real Alexia (none there, or access was refused), so the dev copy starts with no keys.')
  }
  // Nothing older to move in: without this, the dev core would look in the real install's
  // old per-secret entries, copy them, and delete them.
  kept.moved = 'all'
  run('security', ['add-generic-password', '-U', '-s', KEYCHAIN, '-a', VAULT, '-T', installed, '-w', JSON.stringify(kept)], {
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  console.log(`Keychain: ${Object.keys(kept.secrets ?? {}).length} secret(s) copied.`)
}

quitDev()
if (!dataOnly) {
  run('pnpm', ['sidecar'])
  run('pnpm', ['tauri', 'build', '--config', 'src-tauri/tauri.dev.conf.json', '--bundles', 'app'], {
    env: { ...process.env, ALEXIA_DEV_NAME: NAME, ALEXIA_KEYCHAIN: KEYCHAIN },
  })
  const built = join(root, 'src-tauri', 'target', 'release', 'bundle', 'macos', `${NAME}.app`)
  rmSync(installed, { recursive: true, force: true })
  run('ditto', [built, installed])
  console.log(`Installed ${installed}`)
}
if (fresh) copyData()
run('open', [installed])
console.log(`\n${NAME} is open. The real Alexia and its data were not touched.`)
