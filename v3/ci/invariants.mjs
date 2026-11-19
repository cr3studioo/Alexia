// SPDX-License-Identifier: AGPL-3.0-only
/**
 * v3's structural invariants (INTERFACES.md §7). Run from the repo root:
 *   node v3/ci/invariants.mjs              exit 0 = all pass, 1 = a hit (each one printed)
 *   node v3/ci/invariants.mjs --self-test  prove each check catches a planted violation
 *
 * 1. No crate names a plugin (v2's rule: the id quoted, or a path segment after `plugins/`).
 * 2. Internal dependency edges are exactly the allowed table; licence and SPDX headers.
 * 3. No hard-coded absolute paths in crate sources.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const SPDX = '// SPDX-License-Identifier: AGPL-3.0-only'
const LIBS = ['alexia-store', 'alexia-mcp', 'alexia-core', 'alexia-gateway', 'alexia-scheduler']
/** INTERFACES.md §1.1. Normal and dev edges alike. */
const ALLOWED = {
  'alexia-mcp': ['alexia-store'],
  'alexia-core': ['alexia-store', 'alexia-mcp'],
  'alexia-gateway': ['alexia-store', 'alexia-core'],
  'alexia-scheduler': ['alexia-store', 'alexia-core'],
  'alexia-hub': LIBS,
  'alexia-limb': ['alexia-mcp'],
}
/** A service a channel adapter speaks to may be named there (INTERFACES.md §8.1). */
const CHANNELS = 'v3/crates/alexia-gateway/src/channels/'

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Hits for check 1 in one file's text. `path` is repo-relative with forward slashes. */
export function pluginHits(path, text, ids) {
  const out = []
  text.split('\n').forEach((line, i) => {
    const at = `${path}:${i + 1}`
    if (/plugins[\\/]/.test(line)) out.push(`${at}: names the plugins/ folder`)
    if (path.startsWith(CHANNELS)) return
    for (const id of ids) {
      const re = new RegExp(`['"\`]${escape(id)}['"\`]|plugins[\\\\/]${escape(id)}\\b`)
      if (re.test(line)) out.push(`${at}: names plugin "${id}"`)
    }
  })
  return out
}

/** Hits for check 3. */
export function pathHits(path, text) {
  const out = []
  text.split('\n').forEach((line, i) => {
    if (/C:\\|C:\/|\/home\/|\/Users\//.test(line)) out.push(`${path}:${i + 1}: hard-coded path`)
  })
  return out
}

/** Hits for check 2's graph half. `packages` is `cargo metadata`'s `packages`. */
export function graphHits(packages) {
  const internal = new Set(packages.map((p) => p.name))
  const out = []
  for (const p of packages) {
    if (p.license !== 'AGPL-3.0-only') out.push(`${p.name}: license is ${p.license}, not AGPL-3.0-only`)
    for (const d of p.dependencies) {
      if (internal.has(d.name) && !(ALLOWED[p.name] ?? []).includes(d.name)) {
        out.push(`${p.name} -> ${d.name}: dependency edge not in INTERFACES.md §1.1`)
      }
    }
  }
  return out
}

export function spdxHits(path, text) {
  return text.startsWith(SPDX) ? [] : [`${path}:1: missing "${SPDX}"`]
}

/** Every `.rs` under `dir`. */
function rustFiles(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.rs'))
    .map((e) => join(e.parentPath, e.name))
}
const rel = (f) => relative('.', f).split(sep).join('/')

function run() {
  const ids = readdirSync('plugins', { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
  const hits = []
  if (ids.length === 0) hits.push('plugins/ has no folders: the plugin-name check would be vacuous')

  for (const c of readdirSync('v3/crates')) {
    for (const f of rustFiles(join('v3/crates', c))) {
      const path = rel(f)
      const text = readFileSync(f, 'utf8')
      hits.push(...spdxHits(path, text))
      if (path.startsWith(`v3/crates/${c}/src/`)) {
        hits.push(...pluginHits(path, text, ids), ...pathHits(path, text))
      }
    }
  }
  const meta = execFileSync(
    'cargo',
    ['metadata', '--format-version', '1', '--no-deps', '--manifest-path', 'v3/Cargo.toml'],
    { encoding: 'utf8', maxBuffer: 1 << 28 },
  )
  hits.push(...graphHits(JSON.parse(meta).packages))
  return hits
}

function selfTest() {
  const bad = []
  const expect = (what, got) => {
    if (got.length === 0) bad.push(`self-test: ${what} was not caught`)
  }
  const ok = (what, got) => {
    if (got.length !== 0) bad.push(`self-test: ${what} was flagged: ${got.join('; ')}`)
  }
  const src = 'v3/crates/alexia-core/src/x.rs'
  expect('a quoted plugin id', pluginHits(src, 'let a = "voice";', ['voice']))
  expect('a single-quoted plugin id', pluginHits(src, "let a = 'voice';", ['voice']))
  expect('a plugins/x path', pluginHits(src, 'let p = "plugins/voice/x";', ['voice']))
  expect('a bare plugins/ string', pluginHits(src, 'let p = "plugins/";', ['voice']))
  expect('a plugins\\ string', pluginHits(src, 'let p = "plugins\\\\";', ['voice']))
  expect('a plugins\\x path', pluginHits(src, 'let p = "plugins\\\\voice";', ['voice']))
  ok('the English word memory', pluginHits(src, '// memory of the media', ['memory', 'media']))
  ok('a channel naming its service', pluginHits(`${CHANNELS}telegram.rs`, 'let n = "telegram";', ['telegram']))
  const pkg = (name, deps, license = 'AGPL-3.0-only') => ({
    name,
    license,
    dependencies: deps.map((d) => ({ name: d })),
  })
  const all = (over) => [...LIBS, 'alexia-hub', 'alexia-limb'].map((n) => over[n] ?? pkg(n, ALLOWED[n] ?? []))
  ok('the allowed graph', graphHits(all({})))
  expect('a bad edge', graphHits(all({ 'alexia-store': pkg('alexia-store', ['alexia-core']) })))
  expect('a bad dev edge', graphHits(all({ 'alexia-limb': pkg('alexia-limb', ['alexia-mcp', 'alexia-core']) })))
  expect('a wrong license', graphHits(all({ 'alexia-mcp': pkg('alexia-mcp', ['alexia-store'], 'MIT') })))
  ok('an external dependency', graphHits(all({ 'alexia-mcp': pkg('alexia-mcp', ['alexia-store', 'tokio']) })))
  expect('a missing SPDX header', spdxHits(src, 'fn main() {}'))
  ok('a present SPDX header', spdxHits(src, `${SPDX}\nfn main() {}`))
  expect('a C:\\ path', pathHits(src, 'let p = "C:\\\\Users";'))
  expect('a C:/ path', pathHits(src, 'let p = "C:/x";'))
  expect('a /home/ path', pathHits(src, 'let p = "/home/me";'))
  expect('a /Users/ path', pathHits(src, 'let p = "/Users/me";'))
  ok('a relative path', pathHits(src, 'let p = "data/x";'))
  return bad
}

const testing = process.argv.includes('--self-test')
const failures = testing ? selfTest() : run()
if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log(testing ? 'self-test: ok' : 'invariants: ok')
