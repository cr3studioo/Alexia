// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { Library, offerable, type Entry } from '../src/library.js'
import { Store } from '../src/store.js'

// M3-2 and M3-7. The library downloads somebody else's bytes and puts them in the folder
// core watches, so what is tested is the order of operations: check first, unpack second,
// and never enable. Every one of these is a way that ordering could be got wrong.

const root = mkdtempSync(join(tmpdir(), 'alexia-library-'))
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))

const archiver = (): string => {
  const system = process.env.SystemRoot
  return process.platform === 'win32' && system ? join(system, 'System32', 'tar.exe') : 'tar'
}

/** A plugin folder, packed the way a publisher would pack one. */
function pack(id: string, extra: Record<string, unknown> = {}): { bytes: Buffer; sha256: string } {
  const staging = mkdtempSync(join(root, 'pack-'))
  const folder = join(staging, id)
  mkdirSync(folder, { recursive: true })
  writeFileSync(
    join(folder, 'plugin.json'),
    JSON.stringify({
      manifest_version: 1,
      id,
      name: id,
      summary: 'Something to install.',
      version: '0.1.0',
      license: 'Apache-2.0',
      entry: { run: 'node', args: ['index.js'] },
      alexia_protocol: 2,
      mcp_protocol: '2025-11-25',
      ...extra,
    }),
  )
  writeFileSync(join(folder, 'index.js'), '// nothing\n')
  const archive = join(staging, 'out.tgz')
  // Checked rather than assumed. This suite has a rare red on this line under a full
  // parallel run, and an ignored exit status turns whatever tar said into an unrelated
  // assertion twenty lines later — which is how it stayed unexplained.
  const packed = spawnSync(archiver(), ['-czf', archive, '-C', staging, id])
  if (packed.status !== 0) {
    throw new Error(`tar failed (${String(packed.status)}): ${packed.stderr?.toString() ?? String(packed.error)}`)
  }
  const bytes = readFileSync(archive)
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}

interface World {
  library: Library
  extensions: string
  entry: Entry
}

function world(overrides: Partial<Entry> = {}, bytes?: Buffer): World {
  const dir = mkdtempSync(join(root, 'world-'))
  const extensions = join(dir, 'extensions')
  const skillsDir = join(dir, 'skills')
  const packed = pack(overrides.id ?? 'weather')
  const entry: Entry = {
    id: 'weather',
    name: 'Weather',
    summary: 'Tells you whether to take a coat.',
    version: '0.1.0',
    license: 'Apache-2.0',
    url: 'https://example.invalid/weather.tgz',
    sha256: packed.sha256,
    alexia_protocol: 2,
    mcp_protocol: '2025-11-25',
    requires: [{ cap: 'net.request', why: 'to ask a forecast service' }],
    provides: [],
    updated_at: 0,
    ...overrides,
  }
  const served = bytes ?? packed.bytes

  const fake: typeof globalThis.fetch = (input) => {
    const path = new URL(String(input)).pathname
    if (path === '/v0/plugins.json') return Promise.resolve(Response.json({ plugins: [entry] }))
    if (path === `/v0/plugins/${entry.id}.json`) return Promise.resolve(Response.json(entry))
    if (path === '/v0/revoked.json') return Promise.resolve(Response.json({ plugins: [], skills: [] }))
    if (path === '/v0/skills.json') return Promise.resolve(Response.json({ skills: [] }))
    // The archive itself, from wherever the entry points.
    return Promise.resolve(new Response(new Uint8Array(served), { headers: { 'content-length': String(served.byteLength) } }))
  }

  const library = new Library({ store: new Store(':memory:'), pluginsDir: extensions, skillsDir, fetch: fake })
  library.url = 'https://registry.invalid'
  return { library, extensions, entry }
}

test('install: checked, unpacked, and left not enabled', async () => {
  const { library, extensions } = world()
  const done = await library.install('weather')
  expect(done).toMatchObject({ ok: true, id: 'weather', signature: 'none' })
  expect(existsSync(join(extensions, 'weather', 'plugin.json'))).toBe(true)
  expect(existsSync(join(extensions, 'weather', 'index.js'))).toBe(true)
})

test('a checksum that does not match installs nothing at all', async () => {
  const { library, extensions } = world({ sha256: 'f'.repeat(64) })
  const done = await library.install('weather')
  expect(done.ok).toBe(false)
  expect('why' in done && done.why).toMatch(/not what the registry described/)
  // The point of checking before unpacking: no folder, not even a partial one.
  expect(existsSync(join(extensions, 'weather'))).toBe(false)
})

test('a withdrawn plugin is refused with the registry’s reason', async () => {
  const dir = mkdtempSync(join(root, 'revoked-'))
  const library = new Library({
    store: new Store(':memory:'),
    pluginsDir: join(dir, 'extensions'),
    skillsDir: join(dir, 'skills'),
    fetch: () => Promise.resolve(Response.json({ error: 'revoked', reason: 'it read the whole home directory' }, { status: 410 })),
  })
  // A static registry, deliberately: the 410 is that layout's kill switch, and it is the
  // reason `publishing.md` still names it as the right answer for a registry serving
  // strangers. Deleting a GitHub release stops new installs and reaches nobody who has one.
  library.url = 'https://registry.invalid'
  const done = await library.install('weather')
  expect(done.ok).toBe(false)
  expect('why' in done && done.why).toMatch(/withdrawn.*read the whole home directory/)
})

test('an archive whose manifest disagrees with the registry row does not get a folder', async () => {
  // The bytes hash correctly and are still not what was ordered — a substitution the
  // checksum alone cannot catch, because whoever swapped the row swapped the hash with it.
  const other = pack('something-else')
  const { library, extensions } = world({ sha256: other.sha256 }, other.bytes)
  const done = await library.install('weather')
  expect(done.ok).toBe(false)
  expect('why' in done && done.why).toMatch(/calls it/)
  expect(existsSync(join(extensions, 'weather'))).toBe(false)
})

test('signing: verified, bad, and the honest word for having no key', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

  /**
   * Over *this* world's checksum, never a sibling's.
   *
   * Every `world()` packs its own archive and a tar carries the mtimes of the second it was
   * packed in — so two of them hash alike only while both happen inside the same second.
   * Signing one world's sha256 and installing another's therefore passed on an idle machine
   * and failed on a loaded one, which is the worst way for a signature test to be wrong.
   */
  const signFor = (made: World): string =>
    sign(null, Buffer.from(made.entry.sha256, 'utf8'), privateKey).toString('base64')

  // No key configured. The install still happens — the checksum gated it — and the word
  // for what was checked is `unverified`, which is exactly what it is worth.
  const signed = world()
  signed.entry.signature = signFor(signed)
  expect(await signed.library.install('weather')).toMatchObject({ ok: true, signature: 'unverified' })

  const withKey = world()
  withKey.entry.signature = signFor(withKey)
  withKey.library.publisherKey = pem
  expect(await withKey.library.install('weather')).toMatchObject({ ok: true, signature: 'verified' })

  const forged = world({ signature: Buffer.from('not a signature at all abcdefgh').toString('base64') })
  forged.library.publisherKey = pem
  const done = await forged.library.install('weather')
  expect(done.ok).toBe(false)
  expect('why' in done && done.why).toMatch(/signature does not match/)
  expect(existsSync(join(forged.extensions, 'weather'))).toBe(false)
})

test('installing twice is refused rather than overwriting what is there', async () => {
  const { library } = world()
  expect((await library.install('weather')).ok).toBe(true)
  const again = await library.install('weather')
  expect(again.ok).toBe(false)
  expect('why' in again && again.why).toMatch(/already installed/)
})

// ---- the shelf is GitHub Releases (D118) ------------------------------------------------

/** A release as GitHub returns one, with the block `publish.mjs` writes into the body. */
function release(entry: Partial<Entry> & { id: string; version: string; sha256: string }, extra = ''): unknown {
  const block = {
    name: entry.id,
    summary: 'Something to install.',
    license: 'Apache-2.0',
    alexia_protocol: 2,
    mcp_protocol: '2025-11-25',
    requires: [],
    provides: [],
    ...entry,
  }
  return {
    tag_name: `${entry.id}-v${entry.version}`,
    published_at: '2026-08-30T12:00:00Z',
    body: `${extra}\n\`\`\`alexia\n${JSON.stringify(block)}\n\`\`\`\n`,
    assets: [
      { name: `${entry.id}-${entry.version}.tgz`, browser_download_url: `https://example.invalid/${entry.id}.tgz` },
    ],
  }
}

/** A world whose registry is a repository, and whose releases are whatever is passed in. */
function releases(rows: unknown[], bytes: Buffer): { library: Library; extensions: string } {
  const dir = mkdtempSync(join(root, 'gh-'))
  const extensions = join(dir, 'extensions')
  const fake: typeof globalThis.fetch = (input) => {
    if (String(input).startsWith('https://api.github.com/')) return Promise.resolve(Response.json(rows))
    return Promise.resolve(
      new Response(new Uint8Array(bytes), { headers: { 'content-length': String(bytes.byteLength) } }),
    )
  }
  const library = new Library({
    store: new Store(':memory:'),
    pluginsDir: extensions,
    skillsDir: join(dir, 'skills'),
    fetch: fake,
  })
  library.url = 'github:cr3studioo/Alexia'
  return { library, extensions }
}

test('a release is a plugin, and the asset is where the bytes come from', async () => {
  const packed = pack('weather')
  const { library, extensions } = releases([release({ id: 'weather', version: '0.1.0', sha256: packed.sha256 })], packed.bytes)

  const shelf = await library.plugins()
  expect(shelf).toHaveLength(1)
  // Never the block's own idea of where the bytes are: whatever is offered is on the release
  // that offered it, so the two cannot be made to point in different directions.
  expect(shelf[0]!.url).toBe('https://example.invalid/weather.tgz')

  expect(await library.install('weather')).toMatchObject({ ok: true, id: 'weather' })
  expect(existsSync(join(extensions, 'weather', 'plugin.json'))).toBe(true)
})

test('a release with no block is not a plugin — which is how the app’s own installers stay off the shelf', async () => {
  const packed = pack('weather')
  const { library } = releases(
    [
      { tag_name: 'v0.2.0', body: 'Alexia 0.2.0.', assets: [{ name: 'Alexia_0.2.0_x64-setup.exe', browser_download_url: 'https://example.invalid/setup.exe' }] },
      release({ id: 'weather', version: '0.1.0', sha256: packed.sha256 }),
    ],
    packed.bytes,
  )
  expect((await library.plugins()).map((row) => row.id)).toEqual(['weather'])
})

test('two releases of one plugin: the later version is the one on the shelf', async () => {
  const packed = pack('weather')
  const { library } = releases(
    [
      // Newest-first is GitHub's order by date, and a release cut to fix last month's notes
      // would sit at the top of it. The version is what decides, not the position.
      release({ id: 'weather', version: '0.9.0', sha256: packed.sha256 }),
      release({ id: 'weather', version: '0.10.0', sha256: packed.sha256 }),
    ],
    packed.bytes,
  )
  expect((await library.plugins())[0]!.version).toBe('0.10.0')
})

test('a plugin that needs a newer Alexia is not offered, and refuses to install if asked anyway', async () => {
  const packed = pack('weather')
  const { library, extensions } = releases(
    [release({ id: 'weather', version: '0.1.0', sha256: packed.sha256, min_app: '99.0.0' })],
    packed.bytes,
  )
  const shelf = await library.plugins()
  expect(offerable(shelf[0]!)).toBe('newer-app')

  // The gate is asked again at the moment of install, because a row can sit on a screen for
  // an hour: hiding it on one screen is not the same as refusing it.
  const done = await library.install('weather')
  expect(done.ok).toBe(false)
  expect('why' in done && done.why).toMatch(/needs Alexia 99\.0\.0 or later/)
  expect(existsSync(join(extensions, 'weather'))).toBe(false)
})

test('an update that needs a newer Alexia is reported rather than offered', async () => {
  const packed = pack('weather')
  const { library } = releases(
    [release({ id: 'weather', version: '2.0.0', sha256: packed.sha256, min_app: '99.0.0' })],
    packed.bytes,
  )
  const [update] = await library.updates([{ id: 'weather', version: '0.1.0' }])
  // It is a real update and this build cannot take it. Both halves travel, because the
  // screen's sentence is "one plugin update needs a newer Alexia" and neither half says that.
  expect(update).toMatchObject({ id: 'weather', from: '0.1.0', to: '2.0.0', offer: 'newer-app' })
})

test('a rate-limited read shows the last shelf that arrived, not an empty one', async () => {
  // The failure this was written from: sixty unauthenticated requests an hour is a limit on
  // the *address*, so Alexia can be well inside its own share and still be refused because
  // something else on the network was not. A blank Plugins screen would be the wrong answer
  // to somebody else's traffic.
  const packed = pack('weather')
  const store = new Store(':memory:')
  const dir = mkdtempSync(join(root, 'stale-'))
  const shelf = [release({ id: 'weather', version: '0.1.0', sha256: packed.sha256 })]

  let refuse = false
  const fake: typeof globalThis.fetch = () =>
    Promise.resolve(
      refuse ? new Response('rate limited', { status: 403 }) : Response.json(shelf),
    )
  const of = (): Library => {
    const library = new Library({ store, pluginsDir: join(dir, 'e'), skillsDir: join(dir, 's'), fetch: fake })
    library.url = 'github:cr3studioo/Alexia'
    return library
  }

  expect((await of().plugins()).map((row) => row.id)).toEqual(['weather'])

  // A second core — a restart, a day later, and GitHub saying no. Its own memory is empty,
  // so what it answers with has to have come off the store.
  refuse = true
  expect((await of().plugins()).map((row) => row.id)).toEqual(['weather'])
})

test('a first run that has never reached GitHub says so rather than showing nothing', async () => {
  // The other half of the rule above: stale beats empty, and *nothing* is not stale. A shelf
  // that has never been read has no last-known state to fall back to, and pretending it is an
  // empty shelf would be telling somebody there are no plugins.
  const dir = mkdtempSync(join(root, 'cold-'))
  const library = new Library({
    store: new Store(':memory:'),
    pluginsDir: join(dir, 'e'),
    skillsDir: join(dir, 's'),
    fetch: () => Promise.resolve(new Response('rate limited', { status: 403 })),
  })
  library.url = 'github:cr3studioo/Alexia'
  await expect(library.plugins()).rejects.toThrow(/rate-limiting/)
})
