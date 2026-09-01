// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Publishing a plugin (M3-1, rewritten by D118).
 *
 * **A plugin version is a GitHub Release.** The `.tgz` is an asset on it and the entry
 * Alexia reads is a fenced ```alexia block in the release notes, so publishing is one
 * `gh release create` and there is no index to regenerate, no site to deploy, and nothing
 * that can be stale between cutting a release and somebody seeing the plugin. That is the
 * property the previous two shapes did not have: `registry/`'s Cloudflare Worker needed an
 * account, a database and a card — a gate that was never passed, so the library screen drew
 * *Nothing new at …* for two milestones — and the GitHub Pages site that replaced it needed
 * a second repository, a deploy, and a commit for every publish.
 *
 * What this script does, in order:
 *
 *   1. validates each `plugin.json` against the loader's own schema — a manifest that would
 *      not load is not a thing to put on a shelf, and finding out here costs a second rather
 *      than a download and a support message;
 *   2. bundles each plugin the way `package.mjs` bundles core, because a plugin in this repo
 *      reaches its SDK through a pnpm symlink into a store no downloader has;
 *   3. packs a `.tgz`, hashes it, and writes the release body around that hash;
 *   4. cuts the release, unless `--dry-run`.
 *
 * **`--latest=false` on every plugin release, and it is not cosmetic.** Alexia updates
 * itself from `releases/latest/download/latest.json` on this same repository, and a plugin
 * release that became *latest* would point the app's updater at a release with no installer
 * on it.
 *
 * **It does less than the name suggests, and that is worth writing down**: it stops *this*
 * release being promoted, and GitHub's fallback — when no release has been explicitly
 * promoted — is still the newest by date. Measured on the first real publish: eleven releases
 * cut with this flag, and `/releases/latest` answered with the last one anyway. What holds the
 * pointer down is the app's own release carrying `make_latest: true`. This flag keeps the
 * plugins from taking it back.
 *
 * Usage:
 *
 *     node scripts/publish.mjs                      # every plugin, to cr3studioo/Alexia
 *     node scripts/publish.mjs --only documents     # one of them
 *     node scripts/publish.mjs --dry-run            # build and print, publish nothing
 *     node scripts/publish.mjs --pages --repo o/n   # the static layout instead (see below)
 *
 * A tag that already exists is skipped rather than overwritten: a published version is
 * somebody else's download now, and republishing one silently changes the bytes under a
 * checksum a machine may already have written down. Bump the version in `plugin.json`.
 *
 * **`--pages` keeps the static layout alive**, four JSON files under `/v0/` for a GitHub
 * Pages site or the Worker in `registry/`. It is still the right answer for a registry
 * serving strangers, for one reason: its `/v0/revoked.json` is a kill switch that reaches
 * people who already installed something, and deleting a GitHub release reaches nobody.
 */
import { build } from 'esbuild'
import { spawn, spawnSync } from 'node:child_process'
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

const repo = flag('repo', 'cr3studioo/Alexia')
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.error(`--repo wants owner/name, not "${repo}".`)
  process.exit(1)
}
const [owner, name] = repo.split('/')
const pages = args.includes('--pages')
const dry = args.includes('--dry-run')
const only = flag('only')
const out = flag('out', join(root, 'dist-registry'))
const site = `https://${owner}.github.io/${name}`
/** Where the `.tgz` files are readable from, in `--pages` mode. Releases name their own. */
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
  .filter((id) => only === undefined || id === only)
  .sort()
if (ids.length === 0) {
  console.error(only ? `No plugin called "${only}" in plugins/.` : 'No plugins to publish.')
  process.exit(1)
}

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
    // The Alexia builds it declared it runs on (D118). Absent means any, and stays absent
    // rather than being filled in with today's version — a range nobody asked for is a
    // plugin that falls off the shelf the next time the app is released.
    ...(manifest.min_app ? { min_app: manifest.min_app } : {}),
    ...(manifest.max_app ? { max_app: manifest.max_app } : {}),
    // The author's own sentences, verbatim. The screen draws these before it downloads
    // anything, so a `why` rewritten here would be a rewritten reason on a consent screen.
    requires: manifest.requires ?? [],
    provides: manifest.provides ?? [],
    updated_at: now,
  }
  entries.push({ ...entry, tgz, tag: `${id}-v${manifest.version}`, title: `${manifest.name} ${manifest.version}` })

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

/**
 * Every field the client reads, and nothing this script keeps for itself.
 *
 * `url` is dropped deliberately rather than forgotten: on a release the asset *is* the url,
 * and a block carrying one as well would be a second answer to the same question, able to
 * point somewhere else. `--pages` puts it back, because there the JSON is all there is.
 */
const MINE = new Set(['tgz', 'tag', 'title', 'url'])
const blockOf = (entry) => Object.fromEntries(Object.entries(entry).filter(([key]) => !MINE.has(key)))

/**
 * The release body: a sentence for a person, then the block for Alexia.
 *
 * Both audiences on one page on purpose. Somebody who lands on the release from a search
 * should be able to read what the plugin is and what it will ask for without installing
 * anything, and that is the same information the block carries — so the prose is generated
 * from the manifest rather than written twice and allowed to drift.
 */
const notesFor = (entry) => {
  const asks =
    entry.requires.length === 0 ?
      'It asks for nothing.'
    : ['It asks for:', ...entry.requires.map((need) => `- \`${need.cap}\` — ${need.why}`)].join('\n')
  const range =
    entry.min_app ? `
Needs Alexia ${entry.min_app} or later.` : ''
  return [
    entry.summary,
    '',
    asks,
    range,
    '',
    'Install it from the Plugins screen inside Alexia rather than by hand — that is the path',
    'that checks the download against the checksum below before anything is unpacked.',
    '',
    '```alexia',
    JSON.stringify(blockOf(entry), null, 2),
    '```',
  ].join('\n')
}

if (pages) {
  // ---- the static layout, for a Pages site or the Worker in `registry/` -------------------
  // The shelf. A revoked plugin is off it — it stays reachable at its own path so that
  // somebody who already installed it is told why, which is the whole point of keeping the row.
  writeFileSync(
    join(v0, 'plugins.json'),
    // `url` back on, because in this layout the JSON is all there is — there is no release
    // asset to read it off.
    JSON.stringify(
      { plugins: entries.filter((e) => !revokedPlugins[e.id]).map((e) => ({ ...blockOf(e), url: e.url })) },
      null,
      2,
    ),
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
  console.log(`Point Alexia at ${site} in Settings — the default source is github:${repo}.`)
  process.exit(0)
}

// ---- releases ----------------------------------------------------------------------------

/**
 * `gh`, because the alternative is a token in an environment variable and three REST calls
 * with a multipart upload in the middle of them. `gh` is already how a release gets cut by
 * hand, it already holds the credential, and a publisher who has not got it is one line away
 * from having it.
 */
const gh = (argv, quiet) => {
  const done = spawnSync('gh', argv, { encoding: 'utf8', stdio: quiet ? 'pipe' : ['ignore', 'pipe', 'inherit'] })
  if (done.error) {
    console.error('gh is not on PATH. Install the GitHub CLI (https://cli.github.com) and run `gh auth login`.')
    process.exit(1)
  }
  return done
}

if (!dry && gh(['auth', 'status'], true).status !== 0) {
  console.error('gh is not signed in. Run `gh auth login` first.')
  process.exit(1)
}

let cut = 0
for (const entry of entries) {
  if (dry) {
    console.log('')
    console.log(`--- ${entry.tag} (dry run, nothing published) ---`)
    console.log(notesFor(entry))
    continue
  }
  // A published version is somebody else's download now. Republishing a tag would change the
  // bytes under a checksum a machine may already have written down, so an existing tag is a
  // skip and a sentence rather than a `--clobber`.
  if (gh(['release', 'view', entry.tag, '--repo', repo], true).status === 0) {
    console.log(`${entry.tag} is already published — bump the version in plugin.json to publish again.`)
    continue
  }
  const notes = join(out, `${entry.tag}.md`)
  writeFileSync(notes, notesFor(entry))
  const made = gh([
    'release', 'create', entry.tag,
    entry.tgz,
    '--repo', repo,
    '--title', entry.title,
    '--notes-file', notes,
    // See the header: the app's own updater reads `releases/latest`, and a plugin release
    // claiming to be latest would point it at a release with no installer on it.
    '--latest=false',
  ])
  if (made.status !== 0) {
    console.error(`Could not publish ${entry.tag}.`)
    process.exit(1)
  }
  cut += 1
}

/**
 * Put the *latest* label back on the app, whatever GitHub thinks (D118).
 *
 * `--latest=false` above stops each plugin release being promoted, and that turned out not to
 * be the same thing as leaving the pointer alone: with nothing explicitly promoted, GitHub
 * answers `/releases/latest` with whichever release is newest, and eleven plugin releases in
 * a row duly took it. The app's own release now carries `make_latest: true`, which should
 * hold — *should* being the word this is here to remove.
 *
 * So: after publishing, the newest `vN.N.N` release is re-asserted as latest. It costs one
 * API call, it is idempotent, and what it protects is the URL every installed Alexia asks for
 * its updates — a pointer that has silently moved to a plugin release is an update path that
 * stops working with nothing on screen to say why.
 */
if (!dry && cut > 0) {
  const app = JSON.parse(
    gh(['api', `repos/${repo}/releases`, '--jq', '[.[] | select(.tag_name | test("^v[0-9]")) | {id, tag_name}]'], true)
      .stdout || '[]',
  )[0]
  if (app) {
    gh(['api', '-X', 'PATCH', `repos/${repo}/releases/${app.id}`, '-f', 'make_latest=true'], true)
    const now = gh(['api', `repos/${repo}/releases/latest`, '--jq', '.tag_name'], true).stdout.trim()
    console.log(`Latest release is ${now}${now === app.tag_name ? '' : ` — expected ${app.tag_name}`}`)
  } else {
    console.log('No app release to mark latest yet. The first one to be published claims it.')
  }
}

console.log('')
console.log(
  dry ? `${entries.length} plugin(s) built into ${out}. Nothing was published.`
  : `${cut} release(s) published to https://github.com/${repo}/releases`,
)
console.log(`Alexia reads them from github:${repo} — the default source.`)
