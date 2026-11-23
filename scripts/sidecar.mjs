// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Turn the packaged build into what Tauri expects beside the app (M5-1).
 *
 * `scripts/package.mjs` already produces a folder that runs on a machine with nothing
 * installed. This does not rebuild any of that — it runs it, then arranges the same files
 * the way `tauri build` looks for them:
 *
 *   src-tauri/binaries/alexia-core-<target triple>.exe   Node, which the hub runs plugins with
 *   src-tauri/binaries/alexia-connect-<target triple>.exe   native transport
 *   src-tauri/resources/hub/alexia-hub(.exe)               the Rust hub the app starts (P2D-13)
 *   src-tauri/resources/ui/                               the window's files, as the hub serves them
 *
 * The split is Tauri's, not ours: an `externalBin` is staged with the triple appended and
 * lands beside the executable without it, while `resources` land in a directory of their own.
 * `main.rs` bridges the two: it starts `resources/hub/alexia-hub run` with `ALEXIA_UI_DIR` set
 * to `resources/ui` and `ALEXIA_NODE` set to the sidecar's path. No Node core runs any more, so
 * `alexia.mjs`, `boot.mjs` and `scripts/` are no longer copied: nothing reads them.
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
 * which is where setup dies. Tauri merges the shell's two builds itself; Node and the keychain
 * library are merged with `lipo` from this machine's copy and the other processor's, fetched
 * and checked against the hash its publisher wrote down. The transport is built with Cargo
 * for both targets and merged the same way.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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

// Core finds the transport beside process.execPath, not among the resources. Tauri removes
// the target suffix when bundling and signs this externalBin the same way as alexia-core.
const transport = join(binaries, `alexia-connect-${target}${suffix}`)
const connectTarget = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(root, 'connect', 'target')
if (universal) {
  const halves = ['aarch64-apple-darwin', 'x86_64-apple-darwin'].map((arch) => {
    const from = connectFor(arch)
    cpSync(from, join(binaries, `alexia-connect-${arch}`))
    return from
  })
  lipo(halves, transport)
} else cpSync(connectFor(), transport)

/** Build the crate's release binary, using the same output directory we copy from. */
function connectFor(arch) {
  const args = ['build', '--release', '--locked', '--manifest-path', join(root, 'connect', 'Cargo.toml'), '--target-dir', connectTarget]
  if (arch) args.push('--target', arch)
  const built = spawnSync('cargo', args, { cwd: root, stdio: 'inherit' })
  if (built.status !== 0) throw new Error(`cargo could not build alexia-connect${arch ? ` for ${arch}` : ''}`)
  const from = join(connectTarget, ...(arch ? [arch] : []), 'release', `alexia-connect${suffix}`)
  if (!existsSync(from)) throw new Error(`cargo produced no ${from}`)
  return from
}

// 3. The hub (P2D-13), built into v3's own target folder whatever CARGO_TARGET_DIR says, so the
//    copy below is always the binary just built. A universal Mac gets both halves merged.
const hubTarget = join(root, 'v3', 'target')
const hubExe = join(resources, 'hub', `alexia-hub${suffix}`)
mkdirSync(join(resources, 'hub'), { recursive: true })
if (universal) lipo(['aarch64-apple-darwin', 'x86_64-apple-darwin'].map(hubFor), hubExe)
else cpSync(hubFor(), hubExe)
// Tauri signs every `externalBin` and nothing under `resources`, so the hub is signed here, the
// way the keyring's library is below — a foreign or missing signature fails notarisation.
if (process.platform === 'darwin') sign(hubExe)

/** Build the hub's release binary and return where cargo put it. */
function hubFor(arch) {
  const args = ['build', '--release', '--locked', '-p', 'alexia-hub', '--manifest-path', join(root, 'v3', 'Cargo.toml'), '--target-dir', hubTarget]
  if (arch) args.push('--target', arch)
  const built = spawnSync('cargo', args, { cwd: root, stdio: 'inherit' })
  if (built.status !== 0) throw new Error(`cargo could not build alexia-hub${arch ? ` for ${arch}` : ''}`)
  const from = join(hubTarget, ...(arch ? [arch] : []), 'release', `alexia-hub${suffix}`)
  if (!existsSync(from)) throw new Error(`cargo produced no ${from}`)
  return from
}

// 4. The window's files exactly as the hub serves them (`alexia-api`'s statics.rs): the pages,
//    the stylesheet and pictures, and every compiled module under `dist/src/`, which is where it
//    reads `<name>.js` from. `pnpm sidecar` has already run `tsc -b`. No plugins: every one
//    arrives as a download (D118).
const uiFrom = join(root, 'packages', 'ui')
const uiTo = join(resources, 'ui')
mkdirSync(join(uiTo, 'dist', 'src'), { recursive: true })
for (const name of readdirSync(uiFrom).filter((file) => /^(index|compute)\.html$|^app\.css$|\.(png|svg|webp)$/.test(file))) {
  cpSync(join(uiFrom, name), join(uiTo, name))
}
for (const name of readdirSync(join(uiFrom, 'dist', 'src')).filter((file) => file.endsWith('.js'))) {
  cpSync(join(uiFrom, 'dist', 'src', name), join(uiTo, 'dist', 'src', name))
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

/** One Mach-O holding both halves. The inputs' signatures do not survive it, so outputs are signed after. */
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
 *
 * `--timestamp` goes first. It used to be spliced in at index 2, between `--options` and its
 * value, so `codesign` read `--timestamp` as the options and refused — which no ad-hoc build
 * ever reaches, so every signed release would have stopped here (found by D207's first signed
 * build).
 */
function sign(path) {
  const identity = process.env.APPLE_SIGNING_IDENTITY || '-'
  const args = ['--force', '--options', 'runtime', '--sign', identity, path]
  if (identity !== '-') args.unshift('--timestamp')
  const signed = spawnSync('codesign', args, { stdio: 'inherit' })
  if (signed.status !== 0) throw new Error(`codesign refused ${path}`)
}

// 5. What `main.rs` starts and what the hub serves at `/` have to be there, or the app opens on
//    a starting page that never leaves.
for (const needed of [hubExe, join(uiTo, 'index.html')]) {
  if (!existsSync(needed)) throw new Error(`staging left no ${needed}`)
}

console.log(`Sidecar: ${sidecar}`)
console.log(`Transport: ${transport}`)
console.log(`Hub: ${hubExe}`)
console.log(`Resources: ${resources}`)
console.log(universal ? 'Now: pnpm tauri build --target universal-apple-darwin' : 'Now: pnpm tauri build')
