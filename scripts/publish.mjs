// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The registry, as files (M3-1's other half).
 *
 * `registry/` is a Cloudflare Worker over D1, and deploying it needs an account, a database
 * and a person with a card. That gate is real and it has never been passed, so the library
 * screen has always drawn `Nothing new at …` — a marketplace with nothing on the shelf.
 *
 * **The client never needed the Worker.** `Library.#get` resolves a path against a base URL
 * and calls `.json()` on what comes back; it checks no content type, sends no auth and asks
 * for nothing a static file cannot answer. `Library.url` is a kv entry, already overridable,
 * already commented *"so a fork points at its own"*. So the four paths the client reads —
 *
 *     /v0/plugins.json        every plugin, the shelf
 *     /v0/skills.json         standalone skills, a separate shelf on purpose
 *     /v0/revoked.json        the half of the registry for people not currently browsing
 *     /v0/plugins/<id>.json   one entry, re-read at the moment of install
 *
 * — can be four files in a GitHub Pages site, and publishing becomes `git push`. No Worker,
 * no D1, no `ADMIN_TOKEN`, no bill. The Worker stays in the tree and stays correct; this is
 * the same registry with a filesystem where the database was.
 *
 * **The `.json` is not decoration.** A filesystem has one namespace where REST has two, so
 * `/v0/plugins` cannot be both the list and the folder holding each entry — the first run of
 * this script died on exactly that (`EISDIR`). The client asks for `.json` and the Worker
 * strips it before routing, so both spellings reach the same place and neither host is a
 * special case.
 *
 * **What is lost, said plainly.** The Worker sets `cache-control: no-store` on `/v0/revoked`
 * because *"the whole value of a revocation is that it is not five minutes late"*. Pages sits
 * behind a CDN that caches for roughly ten minutes, so the kill switch gets that much slower.
 * It still works — `Library.install` refuses on `'revoked' in found`, reading the per-plugin
 * file, so a revoked entry blocks the install without needing the Worker's 410 — but it is
 * slower, and a registry serving strangers should go back to the Worker for that one reason.
 *
 * **The bytes are not here.** A registry entry is a name, a URL and a checksum; the checksum
 * is what is trusted, not the host. So the `.tgz` files can sit in the same Pages site (the
 * default: one push publishes everything) or anywhere else `--base` points at — a Release, a
 * bucket, another domain — and nothing about the security story changes.
 *
 * Usage:
 *
 *     node scripts/publish.mjs --repo cr3studioo/alexia-registry
 *     node scripts/publish.mjs --repo owner/name --base https://…/releases/download/v1
 *
 * Then commit the contents of `dist-registry/` to that repo and enable Pages on it. Point
 * Alexia at it once, in Settings, or change DEFAULT_REGISTRY.
 */
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Manifest } from '../packages/protocol/dist/src/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Everything in `plugins/` except these.
 *
 * A deny list rather than the allow list `package.mjs` carries, and that is the point of
 * writing a second one: `SHIPPED` there silently omitted `commitments` the day it was
 * written, because an allow list forgets. A plugin added to the repo is published unless
 * somebody says otherwise here.
 *
 * `crasher` and `vanisher` exist to die on purpose — they are how the supervisor's restart
 * and the loader's disappearance paths get tested — and a shelf is not where they belong.
 */
const NEVER = new Set(['crasher', 'vanisher'])

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : args[at + 1]
}

const repo = flag('repo')
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.error('publish.mjs needs --repo owner/name — the GitHub repo that will serve the registry.')
  console.error('  node scripts/publish.mjs --repo cr3studioo/alexia-registry')
  process.exit(1)
}
const [owner, name] = repo.split('/')
const out = flag('out', join(root, 'dist-registry'))
const site = `https://${owner}.github.io/${name}`
/** Where the `.tgz` files will be readable from. The site itself unless told otherwise. */
const base = flag('base', `${site}/tgz`)
const author = flag('author')

/**
 * Windows ships bsdtar as `System32\tar.exe`. What is on PATH may be Git for Windows' GNU
 * tar, which reads a drive-lettered path as `host:path` — the same trap `library.ts` names
 * on the extract side, and the same one-line answer.
 */
const archiver = () => {
  const sys = process.env.SystemRoot
  return process.platform === 'win32' && sys ? join(sys, 'System32', 'tar.exe') : 'tar'
}

const tar = (cwd, id, to) =>
  new Promise((resolve, reject) => {
    const child = spawn(archiver(), ['-czf', to, '-C', cwd, id], { stdio: ['ignore', 'ignore', 'pipe'] })
    let said = ''
    child.stderr?.on('data', (chunk) => (said += String(chunk)))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`could not pack ${id}: ${said.trim() || `tar exited ${String(code)}`}`)),
    )
  })

rmSync(out, { recursive: true, force: true })
const v0 = join(out, 'v0')
mkdirSync(join(v0, 'plugins'), { recursive: true })
mkdirSync(join(out, 'tgz'), { recursive: true })

/**
 * Pages runs Jekyll unless told not to, and Jekyll does not serve a file whose name has no
 * extension the way this needs. `.nojekyll` is one empty file and the difference between a
 * working registry and four 404s.
 */
writeFileSync(join(out, '.nojekyll'), '')

/**
 * Revocations, if there are any.
 *
 * A JSON file beside this script rather than a flag: revoking is a thing you do once and
 * must not forget, and a flag is forgotten the next time somebody publishes. Shape:
 *
 *     { "plugins": { "some-id": "why it was withdrawn" }, "skills": {} }
 */
const revokedFile = join(root, 'registry-revoked.json')
const revoked = existsSync(revokedFile) ? JSON.parse(readFileSync(revokedFile, 'utf8')) : { plugins: {}, skills: {} }
const revokedPlugins = revoked.plugins ?? {}

const ids = readdirSync(join(root, 'plugins'), { withFileTypes: true })
  .filter((e) => e.isDirectory() && !NEVER.has(e.name))
  .map((e) => e.name)
  .sort()

const staging = mkdtempSync(join(tmpdir(), 'alexia-publish-'))
const entries = []
const now = Math.floor(Date.now() / 1000)

for (const id of ids) {
  const from = join(root, 'plugins', id)
  const raw = JSON.parse(readFileSync(join(from, 'plugin.json'), 'utf8'))

  // `$schema` points at a path in this repo, which is not somewhere anybody downloading
  // this has. Same reason `package.mjs` drops it: it is a convenience for whoever edits the
  // file, and it does not travel.
  delete raw.$schema

  // Held to the loader's own schema *before* it is published, not after somebody installs
  // it. A manifest that would not load is not a thing to put on a shelf, and finding that
  // out here costs a second rather than a download and a support message.
  const parsed = Manifest.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    console.error(`${id}: plugin.json is not valid — ${first?.path.join('.')} ${first?.message}`)
    process.exit(1)
  }
  const manifest = parsed.data
  if (manifest.id !== id) {
    // `Library.install` refuses when the row and the manifest disagree, calling it a
    // substitution. Better to never publish the disagreement than to ship one that gets
    // refused on every machine that tries.
    console.error(`${id}: its plugin.json calls it "${manifest.id}". The folder name is the id.`)
    process.exit(1)
  }

  // The tree that becomes the plugin, built exactly the way `package.mjs` builds it — a
  // plugin in this repo reaches its SDK through a pnpm symlink into a store no downloader
  // has, so what ships is a manifest, one bundled file, and whatever it brought with it.
  const tree = join(staging, id)
  mkdirSync(tree, { recursive: true })
  writeFileSync(join(tree, 'plugin.json'), JSON.stringify(raw, null, 2))

  const script = (manifest.entry.args ?? []).find((arg) => arg.endsWith('.js'))
  if (!script) {
    console.error(`${id}: no script in entry.args to bundle.`)
    process.exit(1)
  }
  await build({
    entryPoints: [join(from, script)],
    outfile: join(tree, script),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    banner: { js: 'import{createRequire as __cr}from"node:module";const require=__cr(import.meta.url);' },
  })

  // Its skills (M2-2). Text, and they install and purge with the plugin that brought them.
  for (const skill of manifest.skills ?? []) cpSync(join(from, skill), join(tree, skill), { recursive: true })

  // One level down, which is how `npm pack` and `git archive` lay an archive out and what
  // `holdingManifest` looks for on the way back in.
  const file = `${id}-${manifest.version}.tgz`
  const tgz = join(out, 'tgz', file)
  await tar(staging, id, tgz)
  const sha256 = createHash('sha256').update(readFileSync(tgz)).digest('hex')

  const entry = {
    id,
    name: manifest.name,
    summary: manifest.summary,
    version: manifest.version,
    license: manifest.license,
    ...(author ? { author } : {}),
    url: `${base}/${file}`,
    sha256,
    alexia_protocol: manifest.alexia_protocol,
    mcp_protocol: manifest.mcp_protocol,
    // The author's own sentences, verbatim. The screen draws these before it downloads
    // anything, so a `why` rewritten here would be a rewritten reason on a consent screen.
    requires: manifest.requires ?? [],
    provides: manifest.provides ?? [],
    updated_at: now,
  }
  entries.push(entry)

  // `/v0/plugins/<id>` — re-read at the moment of install, which is where a revocation
  // published five minutes ago gets to stop one.
  const reason = revokedPlugins[id]
  writeFileSync(
    join(v0, 'plugins', `${id}.json`),
    JSON.stringify(reason ? { ...entry, revoked: reason, revoked_reason: reason } : entry, null, 2),
  )
  console.log(`${id} ${manifest.version}  ${sha256.slice(0, 12)}…  ${(readFileSync(tgz).length / 1024).toFixed(0)} KB`)
}

rmSync(staging, { recursive: true, force: true })

// The shelf. A revoked plugin is off it — it stays reachable at its own path so that
// somebody who already installed it is told why, which is the whole point of keeping the row.
writeFileSync(
  join(v0, 'plugins.json'),
  JSON.stringify({ plugins: entries.filter((e) => !revokedPlugins[e.id]) }, null, 2),
)

/**
 * Standalone skills, deliberately a separate list (M3-5).
 *
 * Empty, and emitted anyway: `Library.skills()` throws on a non-ok response, and an empty
 * shelf is a different thing from a registry that cannot be reached. Nothing in this repo is
 * a standalone skill yet — the ones that exist arrive bundled inside a plugin and are
 * covered by that plugin's own yes.
 */
writeFileSync(join(v0, 'skills.json'), JSON.stringify({ skills: [] }, null, 2))

writeFileSync(
  join(v0, 'revoked.json'),
  JSON.stringify(
    {
      plugins: Object.entries(revokedPlugins).map(([id, why]) => ({ id, revoked_at: now, revoked_reason: why })),
      skills: Object.entries(revoked.skills ?? {}).map(([id, why]) => ({ id, revoked_at: now, revoked_reason: why })),
    },
    null,
    2,
  ),
)

console.log('')
console.log(`${entries.length} plugin(s) → ${out}`)
console.log('')
console.log('Next:')
console.log(`  1. Commit everything in that folder to https://github.com/${repo}`)
console.log(`  2. Settings → Pages → deploy from the branch root`)
console.log(`  3. Check it: curl ${site}/v0/plugins.json`)
console.log('')
console.log(`Alexia reads it from ${site} — set that in Settings, or leave DEFAULT_REGISTRY pointing there.`)
