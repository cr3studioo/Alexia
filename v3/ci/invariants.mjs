// SPDX-License-Identifier: AGPL-3.0-only
/**
 * v3's structural invariants (INTERFACES.md §7). Run from the repo root:
 *   node v3/ci/invariants.mjs              exit 0 = all pass, 1 = a hit (each one printed)
 *   node v3/ci/invariants.mjs --self-test  prove each check catches a planted violation
 *
 * 1. No crate names a plugin (v2's rule: the id quoted, or a path segment after `plugins/`).
 * 1b. No crate outside alexia-gateway names a `channels::<module>` path (only secret_keys,
 *    configured, pairing_codes, v2_secret_names); scans `src/` and `tests/`.
 * 2. Internal dependency edges are exactly the allowed table; licence and SPDX headers.
 * 3. No hard-coded absolute paths in crate sources.
 * 11. No v2 core (P2-38): no `V2Bridge`, `ALEXIA_V2_ROOT|URL|TOKEN` or `/api/chat` in any
 *    crate's `src/`, comments included.
 *
 * Deliberate deviation from the spec (CEO-approved): lines whose trimmed text starts with `//`
 * (so `///` and `//!` too) are skipped by every check; and the path check (3) also skips test
 * code: files under a `tests/` folder and everything from a `#[cfg(test)]` line that is directly followed by an
 * inline `mod x {` line to the end of the file (an out-of-line `mod x;` skips nothing). Checks 1 and 3
 * scan only each crate's `src/`. The plugin-name check does not skip test code inside `src/`.
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
/** Marks a line in channels/ that names a plugin because it reads v2 data (INTERFACES.md §8.9). */
const V2_IMPORT = '// invariant: v2 import'
/** Marks a line under channels/telegram/ that uses a Bot API term which is also a plugin id. */
const BOT_API = '// invariant: bot api term'
const TELEGRAM = `${CHANNELS}telegram/`

const isComment = (line) => line.trim().startsWith('//')
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Hits for check 1 in one file's text. `path` is repo-relative with forward slashes. */
export function pluginHits(path, text, ids) {
  const out = []
  // The service a channel file speaks to: `channels/<svc>/...` (none for channels/mod.rs).
  const parts = path.startsWith(CHANNELS) ? path.slice(CHANNELS.length).split('/') : []
  const svc = parts.length > 1 ? parts[0] : null
  text.split('\n').forEach((line, i) => {
    if (isComment(line)) return
    const at = `${path}:${i + 1}`
    if (/plugins[\\/]/.test(line)) out.push(`${at}: names the plugins/ folder`)
    if (path.startsWith(CHANNELS) && line.includes(V2_IMPORT)) return
    if (path.startsWith(TELEGRAM) && line.includes(BOT_API)) return
    for (const id of ids) {
      if (id === svc) continue
      const re = new RegExp(`['"\`]${escape(id)}['"\`]|plugins[\\\\/]${escape(id)}\\b`)
      if (re.test(line)) out.push(`${at}: names plugin "${id}"`)
    }
  })
  return out
}

/** Hits for check 1b: a `channels::<module>` path outside alexia-gateway (INTERFACES.md §7). */
export function channelHits(path, text) {
  const out = []
  if (path.startsWith('v3/crates/alexia-gateway/')) return out
  text.split('\n').forEach((line, i) => {
    if (isComment(line)) return
    if (/\bchannels::(?!secret_keys\b|configured\b|pairing_codes\b|v2_secret_names\b)[a-z_]+/.test(line)) {
      out.push(
        `${path}:${i + 1}: reaches into a channel adapter (use channels::{secret_keys, configured, pairing_codes, v2_secret_names})`,
      )
    }
  })
  return out
}

/** Hits for check 3. */
export function pathHits(path, text) {
  const out = []
  if (/(^|\/)tests\//.test(path)) return out
  const lines = text.split('\n')
  // Only a `#[cfg(test)]` directly followed by a `mod` line opens the test module.
  const cut = lines.findIndex(
    (l, i) => l.trim() === '#[cfg(test)]' && /^\s*(pub(\([^)]*\))?\s+)?mod\s[^;]*\{/.test(lines[i + 1] ?? ''),
  )
  lines.slice(0, cut < 0 ? undefined : cut).forEach((line, i) => {
    if (isComment(line)) return
    if (/C:\\|C:\/|\/home\/|\/Users\//.test(line)) out.push(`${path}:${i + 1}: hard-coded path`)
  })
  return out
}

const V2_CORE = /V2Bridge|ALEXIA_V2_(?:ROOT|URL|TOKEN)\b|\/api\/chat/

/** Hits for check 11: the hub never starts or calls v2 core (INTERFACES.md §2.6, §7). */
export function v2Hits(path, text) {
  const out = []
  text.split('\n').forEach((line, i) => {
    const m = line.match(V2_CORE)
    if (m) out.push(`${path}:${i + 1}: names v2 core ("${m[0]}")`)
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
      hits.push(...spdxHits(path, text), ...channelHits(path, text))
      if (path.startsWith(`v3/crates/${c}/src/`)) {
        hits.push(...pluginHits(path, text, ids), ...pathHits(path, text), ...v2Hits(path, text))
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
  const hub = 'v3/crates/alexia-hub/src/main.rs'
  const mod = `${CHANNELS}mod.rs`
  const naming = 'let x = "telegram";'
  const src0 = 'v3/crates/alexia-core/src/x.rs'
  expect('a plugin named in channels/mod.rs without the marker', pluginHits(mod, naming, ['telegram']))
  ok('a plugin named in channels/mod.rs with the marker', pluginHits(mod, `${naming} ${V2_IMPORT}`, ['telegram']))
  ok('telegram named in channels/telegram/', pluginHits(`${CHANNELS}telegram/api.rs`, naming, ['telegram']))
  ok('a Bot API term marked in channels/telegram/', pluginHits(`${TELEGRAM}api.rs`, `.part("voice", v); ${BOT_API}`, ['telegram', 'voice']))
  expect('a Bot API term marker outside channels/telegram/', pluginHits(mod, `.part("voice", v); ${BOT_API}`, ['telegram', 'voice']))
  expect('a Bot API term marker in another crate', pluginHits(src0, `.part("voice", v); ${BOT_API}`, ['voice']))
  expect('voice named in channels/telegram/', pluginHits(`${CHANNELS}telegram/api.rs`, 'let x = "voice";', ['telegram', 'voice']))
  expect('the hub reaching the telegram api', channelHits(hub, 'use alexia_gateway::channels::telegram::api::Api;'))
  expect(
    'a hub test reaching the adapter',
    channelHits('v3/crates/alexia-hub/tests/t.rs', 'let t = channels::telegram::Telegram::new(a, s, c);'),
  )
  ok('the hub calling configured', channelHits(hub, 'let c = channels::configured(store, &layout);'))
  ok('pairing_codes and secret_keys', channelHits(hub, 'channels::pairing_codes(&s); channels::secret_keys()'))
  ok('v2_secret_names', channelHits(hub, 'let renames = channels::v2_secret_names();'))
  ok(
    'the gateway own tests',
    channelHits('v3/crates/alexia-gateway/tests/telegram_api.rs', 'use alexia_gateway::channels::telegram::api::Api;'),
  )
  ok('a comment', channelHits(hub, '// channels::telegram is private'))
  const src = 'v3/crates/alexia-core/src/x.rs'
  expect('a quoted plugin id', pluginHits(src, 'let a = "voice";', ['voice']))
  expect('a single-quoted plugin id', pluginHits(src, "let a = 'voice';", ['voice']))
  expect('a plugins/x path', pluginHits(src, 'let p = "plugins/voice/x";', ['voice']))
  expect('a bare plugins/ string', pluginHits(src, 'let p = "plugins/";', ['voice']))
  expect('a plugins\\ string', pluginHits(src, 'let p = "plugins\\\\";', ['voice']))
  expect('a plugins\\x path', pluginHits(src, 'let p = "plugins\\\\voice";', ['voice']))
  ok('a plugin id in a doc comment', pluginHits(src, '/// the channel name ("voice")', ['voice']))
  expect('a plugin id in test code', pluginHits(src, '#[cfg(test)]\nlet a = "voice";', ['voice']))
  ok('the English word memory', pluginHits(src, '// memory of the media', ['memory', 'media']))
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
  ok('a path in a comment', pathHits(src, '/// `file:///C:/x`'))
  ok('a path in #[cfg(test)] code', pathHits(src, 'fn a() {}\n#[cfg(test)]\nmod t { const P: &str = "C:\\\\x"; }'))
  expect('a path after a mid-file #[cfg(test)] fn', pathHits(src, '#[cfg(test)]\nfn helper() {}\nconst P: &str = "/home/x";'))
  expect('a path before #[cfg(test)]', pathHits(src, 'const P: &str = "/home/x";\n#[cfg(test)]\nmod t {}'))
  expect('a path after an out-of-line #[cfg(test)] mod tests;', pathHits(src, '#[cfg(test)]\nmod tests;\nconst P: &str = "/home/x";'))
  expect('a plugin id after an out-of-line #[cfg(test)] mod tests;', pluginHits(src, '#[cfg(test)]\nmod tests;\nlet a = "voice";', ['voice']))
  ok('a path under tests/', pathHits('v3/crates/a/tests/t.rs', 'let p = "/home/x";'))
  ok('a relative path', pathHits(src, 'let p = "data/x";'))
  expect('V2Bridge', v2Hits(hub, 'let b = V2Bridge::new(cfg);'))
  expect('ALEXIA_V2_ROOT', v2Hits(hub, 'std::env::var("ALEXIA_V2_ROOT")'))
  expect('ALEXIA_V2_URL', v2Hits(hub, 'std::env::var("ALEXIA_V2_URL")'))
  expect('ALEXIA_V2_TOKEN', v2Hits(hub, 'std::env::var("ALEXIA_V2_TOKEN")'))
  expect('/api/chat', v2Hits(hub, 'let u = format!("{base}/api/chat");'))
  expect('V2Bridge in a doc comment', v2Hits(hub, '/// Implemented by the V2Bridge.'))
  ok('the v2 importer', v2Hits(hub, 'import_v2(&store, v2, &layout)?;'))
  ok('ALEXIA_V2_DATA_NAME', v2Hits(hub, 'std::env::var("ALEXIA_V2_DATA_NAME")'))
  return bad
}

const testing = process.argv.includes('--self-test')
const failures = testing ? selfTest() : run()
if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log(testing ? 'self-test: ok' : 'invariants: ok')
