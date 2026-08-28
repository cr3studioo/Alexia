// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Turn the packaged build into what Tauri expects beside the app (M5-1).
 *
 * `scripts/package.mjs` already produces a folder that runs on a machine with nothing
 * installed. This does not rebuild any of that — it runs it, then arranges the same files
 * the way `tauri build` looks for them:
 *
 *   src-tauri/binaries/alexia-core-<target triple>.exe   the runtime, as the sidecar
 *   src-tauri/resources/                                  alexia.mjs, boot.mjs, ui/, plugins/
 *
 * The split is Tauri's, not ours: an `externalBin` lands beside the executable and gets the
 * triple appended, while `resources` land in a directory of their own. `main.rs` bridges the
 * two by starting the sidecar with the resource directory as its working directory, which is
 * the whole of what that one line is doing.
 *
 * **Re-evaluated here, as the plan asked: Node SEA against shipping `node.exe`** (M5-1). SEA
 * would be one signable artefact instead of an executable plus a script, which matters at
 * M5-3. It also cannot load a native addon from a snapshot, and `@napi-rs/keyring` is how a
 * key reaches the Windows credential locker rather than something worse — losing that to
 * tidy up the artefact count would be trading a real property for a cosmetic one. So:
 * `node.exe`, renamed, and the signing story covers two files instead of one.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const packaged = join(root, 'dist-app', 'Alexia')
const tauri = join(root, 'src-tauri')

/** What `rustc -vV` calls this machine. Tauri appends it to every `externalBin`. */
function triple() {
  const said = spawnSync('rustc', ['-vV'], { encoding: 'utf8' })
  if (said.status !== 0) throw new Error('rustc is not on PATH, so the target triple is unknown.')
  const found = /^host:\s*(\S+)$/m.exec(said.stdout)?.[1]
  if (!found) throw new Error(`could not read a host triple out of:\n${said.stdout}`)
  return found
}

// 1. The packaged build, exactly as the crude installer makes it. Running it rather than
//    duplicating it is the point: one build, checked by one smoke test, shipped two ways.
const built = spawnSync(process.execPath, [join(root, 'scripts', 'package.mjs')], {
  cwd: root,
  stdio: 'inherit',
})
if (built.status !== 0) process.exit(built.status ?? 1)

const host = triple()
const binaries = join(tauri, 'binaries')
const resources = join(tauri, 'resources')
rmSync(binaries, { recursive: true, force: true })
rmSync(resources, { recursive: true, force: true })
mkdirSync(binaries, { recursive: true })
mkdirSync(resources, { recursive: true })

// 2. The runtime, under the name Tauri resolves `sidecar("alexia-core")` to.
const suffix = host.includes('windows') ? '.exe' : ''
cpSync(join(packaged, `node${suffix}`), join(binaries, `alexia-core-${host}${suffix}`))

// 3. Everything the sidecar reads once it is running. `Alexia.cmd` and the runtime itself do
//    not come: the launcher is the app now, and the runtime is above.
for (const name of ['alexia.mjs', 'boot.mjs', 'ui', 'plugins', 'scripts']) {
  const from = join(packaged, name)
  if (existsSync(from)) cpSync(from, join(resources, name), { recursive: true })
}
// The native keyring, whatever it is called on this platform. Found rather than named, so
// this does not quietly ship yesterday's copy under today's filename.
for (const name of ['keyring.win32-x64-msvc.node', 'keyring.darwin-universal.node', 'keyring.linux-x64-gnu.node']) {
  const from = join(packaged, name)
  if (existsSync(from)) cpSync(from, join(resources, name))
}

// 4. The entry point has to be there, because `main.rs` names it and a sidecar that starts
//    Node with nothing to run opens a REPL and waits forever.
if (!existsSync(join(resources, 'boot.mjs'))) throw new Error('the packaged build has no boot.mjs')

console.log(`Sidecar: ${join(binaries, `alexia-core-${host}${suffix}`)}`)
console.log(`Resources: ${resources}`)
console.log('Now: pnpm tauri build')
