// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Turn the packaged build into what Tauri expects beside the app (M5-1).
 *
 * `scripts/package.mjs` already produces a folder that runs on a machine with nothing
 * installed. This does not rebuild any of that — it runs it, then arranges the same files
 * the way `tauri build` looks for them:
 *
 *   src-tauri/binaries/alexia-core-<target triple>.exe   the runtime, as the sidecar
 *   src-tauri/resources/                                  alexia.mjs, boot.mjs, ui/
 *
 * The split is Tauri's, not ours: an `externalBin` lands beside the executable and gets the
 * triple appended, while `resources` land in a directory of their own. `main.rs` bridges the
 * two by starting the sidecar with the resource directory as its working directory, which is
 * the whole of what that one line is doing.
 *
 * **Re-evaluated here, as the plan asked: Node SEA against shipping `node.exe`** (M5-1). SEA
 * would be one signable artefact instead of an executable plus a script, which matters at
 * M5-3. It also cannot load a native addon from a snapshot, and `@napi-rs/keyring` is how the
 * unzipped build reaches the credential store, and how the app moves entries from before D153
 * into the shell's vault — losing that to tidy up the artefact count would be trading a real
 * property for a cosmetic one. So: `node.exe`, renamed, and the signing story covers two files
 * instead of one.
 *
 * **`--universal` makes one Mac app for both processors** (D150), for
 * `tauri build --target universal-apple-darwin`. Two disk images asked somebody who has never
 * opened *About This Mac* which chip they have, on the download page, before anything else —
 * which is where setup dies. Tauri merges the shell's two builds itself; the two things here
 * that are per-architecture, Node and the keychain library, are merged with `lipo` from this
 * machine's copy and the other processor's, fetched and checked against the hash its publisher
 * wrote down.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const packaged = join(root, 'dist-app', 'Alexia')
const tauri = join(root, 'src-tauri')
const universal = process.argv.includes('--universal')
if (universal && process.platform !== 'darwin') {
  console.error(`--universal makes a Mac app, and this is ${process.platform}.`)
  process.exit(1)
}
/** The processor this machine is not, whose half of a universal app has to be fetched. */
const other = process.arch === 'arm64' ? 'x64' : 'arm64'

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

// 2. The runtime, under the name Tauri resolves `sidecar("alexia-core")` to — which for a
//    universal build is the triple Tauri is told to build, not the one this machine is.
const suffix = host.includes('windows') ? '.exe' : ''
const target = universal ? 'universal-apple-darwin' : host
const sidecar = join(binaries, `alexia-core-${target}${suffix}`)
if (universal) {
  // Tauri compiles each processor's shell on its own before merging them, and each of those
  // builds refuses to start without a sidecar of its own triple — so both halves are written
  // under their own names too, and only the merged one reaches the bundle.
  const halves = { [process.arch]: join(packaged, 'node'), [other]: await nodeFor(other) }
  for (const [arch, from] of Object.entries(halves)) {
    cpSync(from, join(binaries, `alexia-core-${arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`))
  }
  lipo(Object.values(halves), sidecar)
} else cpSync(join(packaged, `node${suffix}`), sidecar)

// 3. Everything the sidecar reads once it is running. `Alexia.cmd` and the runtime itself do
//    not come: the launcher is the app now, and the runtime is above. Neither do plugins —
//    there are none to copy (D118), and every one of them arrives as a download into
//    `%LOCALAPPDATA%\Alexia\extensions` instead.
for (const name of ['alexia.mjs', 'boot.mjs', 'ui', 'scripts']) {
  const from = join(packaged, name)
  if (existsSync(from)) cpSync(from, join(resources, name), { recursive: true })
}
// The native keyring, whatever it is called on this platform. Found rather than named, so
// this does not quietly ship yesterday's copy under today's filename — the names this used to
// list included `darwin-universal`, which the keyring has never published (D144).
for (const name of readdirSync(packaged).filter((file) => /^keyring\..+\.node$/.test(file))) {
  if (universal) continue
  cpSync(join(packaged, name), join(resources, name))
  if (process.platform === 'darwin') sign(join(resources, name))
}
// `darwin-universal` is the first name the keyring's loader tries, before either processor's —
// so the merged library needs no second copy of either beside it.
if (universal) {
  const merged = join(resources, 'keyring.darwin-universal.node')
  lipo([join(packaged, `keyring.darwin-${process.arch}.node`), await keyringFor(other)], merged)
  sign(merged)
}

/** One Mach-O holding both halves. The inputs' signatures do not survive it, so both outputs are signed after. */
function lipo(halves, to) {
  const made = spawnSync('lipo', ['-create', '-output', to, ...halves], { stdio: 'inherit' })
  if (made.status !== 0) throw new Error(`lipo could not merge ${halves.join(' and ')}`)
}

/**
 * The bytes at a URL, refused unless they hash to what their publisher wrote down.
 *
 * Both halves fetched here end up inside a signed app that runs with somebody's keychain, so a
 * mirror serving something else is not a download error to retry — it is the one thing this
 * script must never package.
 */
async function fetched(url, algorithm, expected, encoding) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const actual = createHash(algorithm).update(bytes).digest(encoding)
  if (actual !== expected) throw new Error(`${url} is not the file its publisher hashed (${algorithm} ${actual})`)
  const dir = mkdtempSync(join(tmpdir(), 'alexia-universal-'))
  const path = join(dir, url.split('/').at(-1))
  writeFileSync(path, bytes)
  return { dir, path }
}

/** One file out of a downloaded archive. */
function unpacked({ dir, path }, member) {
  const done = spawnSync('tar', ['-xzf', path, '-C', dir, member], { stdio: 'inherit' })
  if (done.status !== 0) throw new Error(`${member} is not in ${path}`)
  return join(dir, member)
}

/** This same Node release for the other processor, checked against nodejs.org's SHASUMS256. */
async function nodeFor(arch) {
  const base = `https://nodejs.org/dist/${process.version}`
  const name = `node-${process.version}-darwin-${arch}`
  const sums = await fetch(`${base}/SHASUMS256.txt`).then((response) => response.text())
  const sum = new RegExp(`^([0-9a-f]{64})\\s+${name}\\.tar\\.gz$`, 'm').exec(sums)?.[1]
  if (!sum) throw new Error(`nodejs.org lists no ${name}.tar.gz`)
  return unpacked(await fetched(`${base}/${name}.tar.gz`, 'sha256', sum, 'hex'), `${name}/bin/node`)
}

/** The keyring's library for the other processor, at the version and hash `pnpm-lock.yaml` pins. */
async function keyringFor(arch) {
  const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')
  const pinned = new RegExp(`'@napi-rs/keyring-darwin-${arch}@([^']+)':\\s+resolution: \\{integrity: sha512-([^}]+)\\}`).exec(lock)
  if (!pinned) throw new Error(`pnpm-lock.yaml pins no @napi-rs/keyring-darwin-${arch}`)
  const [, version, integrity] = pinned
  const url = `https://registry.npmjs.org/@napi-rs/keyring-darwin-${arch}/-/keyring-darwin-${arch}-${version}.tgz`
  return unpacked(await fetched(url, 'sha512', integrity, 'base64'), `package/keyring.darwin-${arch}.node`)
}

/**
 * Sign a native library the way Tauri signs the executables beside it (D145).
 *
 * Tauri signs the shell and every `externalBin`, and nothing under `resources` — so the
 * keychain's `.node` would reach notarisation carrying whatever signature its publisher gave
 * it, and Apple refuses a bundle with one foreign library inside. Signed here, with the same
 * identity `tauri build` will use: `APPLE_SIGNING_IDENTITY` in a release, and ad hoc (`-`)
 * otherwise, which is what `tauri.macos.conf.json` falls back to as well.
 */
function sign(path) {
  const identity = process.env.APPLE_SIGNING_IDENTITY || '-'
  const args = ['--force', '--options', 'runtime', '--sign', identity, path]
  if (identity !== '-') args.splice(2, 0, '--timestamp')
  const signed = spawnSync('codesign', args, { stdio: 'inherit' })
  if (signed.status !== 0) throw new Error(`codesign refused ${path}`)
}

// 4. The entry point has to be there, because `main.rs` names it and a sidecar that starts
//    Node with nothing to run opens a REPL and waits forever.
if (!existsSync(join(resources, 'boot.mjs'))) throw new Error('the packaged build has no boot.mjs')

console.log(`Sidecar: ${sidecar}`)
console.log(`Resources: ${resources}`)
console.log(universal ? 'Now: pnpm tauri build --target universal-apple-darwin' : 'Now: pnpm tauri build')
