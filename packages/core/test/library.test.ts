// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { Library, type Entry } from '../src/library.js'
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

  const signed = world()
  const signature = sign(null, Buffer.from(signed.entry.sha256, 'utf8'), privateKey).toString('base64')
  signed.entry.signature = signature

  // No key configured. The install still happens — the checksum gated it — and the word
  // for what was checked is `unverified`, which is exactly what it is worth.
  expect(await signed.library.install('weather')).toMatchObject({ ok: true, signature: 'unverified' })

  const withKey = world({ signature })
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
