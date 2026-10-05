// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, expect, test } from 'vitest'
import { BUILDS, COMFYUI, SEVEN_ZIP, comfyStatus, home, installComfy, installed, requirement, route, unpack } from '../install.js'
import * as launch from '../launch.js'
import { RENDER, USUAL_PORT } from '../worker.js'

/**
 * Alexia installing its own ComfyUI on the computer that renders.
 *
 * The promises, each one a wrong answer to would look like the plugin working: the size is on
 * the list before anything is pressed and nothing crosses the wire until it is; an interrupted
 * download carries on, and a wrong one is thrown away rather than unpacked; what is unpacked
 * lands in the plugin's folder and is what `launch.js` starts when the person has no ComfyUI;
 * and a ComfyUI the person has is never stopped, replaced or written into.
 *
 * Nothing real is downloaded. The release is a few kilobytes of JSON standing in for an
 * archive, served by a server that writes down what it was asked, and 7-Zip is a script that
 * unpacks that JSON — run through the same `unpack` the real one is.
 */

const root = mkdtempSync(join(tmpdir(), 'alexia-media-install-'))
const closing = []
afterEach(async () => {
  while (closing.length > 0) await closing.pop()()
})
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))

const folder = (name) => {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** What the portable build unpacks to, as far as anything here can tell. */
const ARCHIVE = Buffer.from(
  JSON.stringify({
    'ComfyUI_windows_portable/ComfyUI/main.py': '# main\n',
    'ComfyUI_windows_portable/ComfyUI/nodes.py': '# nodes\n',
    'ComfyUI_windows_portable/python_embeded/python.exe': 'python\n',
    'ComfyUI_windows_portable/python_embeded/bin/python': 'python\n',
    'ComfyUI_windows_portable/README_VERY_IMPORTANT.txt': 'run_nvidia_gpu.bat\n',
    // Padding, so a download has a middle to be interrupted in.
    padding: 'x'.repeat(64 * 1024),
  }),
)

/** 7-Zip, as far as `x <archive> -o<folder>` goes: the archive is JSON of path to contents. */
const SEVEN = Buffer.from(`
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { dirname, join } = require('node:path')
const [verb, archive, ...rest] = process.argv.slice(2)
if (verb !== 'x') process.exit(7)
const into = rest.find((one) => one.startsWith('-o')).slice(2)
let files
try {
  files = JSON.parse(readFileSync(archive, 'utf8'))
} catch {
  process.stderr.write('ERROR: Can not open the file as archive\\n')
  process.exit(2)
}
const names = Object.keys(files)
names.forEach((name, i) => {
  const to = join(into, ...name.split('/'))
  mkdirSync(dirname(to), { recursive: true })
  writeFileSync(to, files[name])
  process.stdout.write(' ' + Math.round(((i + 1) / names.length) * 100) + '%\\b\\b\\b\\b')
})
`)

/** The pins, pointed at the fake server, with the fake bytes' own sizes and hashes. */
const pins = (server) => ({
  seven: { ...SEVEN_ZIP, url: `${server}/7zr.exe`, bytes: SEVEN.length, sha256: sha(SEVEN) },
  builds: [{ ...BUILDS[0], url: `${server}/${BUILDS[0].asset}`, bytes: ARCHIVE.length, sha256: sha(ARCHIVE) }],
})

/**
 * Something that serves the release the way GitHub does — `Range` included — and can be told
 * to end early, to ignore `Range`, or to hand out the wrong bytes.
 */
async function releases({ cut = 0, ranges = true, corrupt = false } = {}) {
  const asked = []
  const state = { cut }
  const server = createServer((request, response) => {
    asked.push({ path: request.url, range: request.headers.range })
    let body = request.url === '/7zr.exe' ? SEVEN : request.url === `/${BUILDS[0].asset}` ? ARCHIVE : undefined
    if (!body) {
      response.writeHead(404)
      return response.end()
    }
    if (corrupt && body === ARCHIVE) {
      body = Buffer.from(body)
      body[100] ^= 0xff
    }
    const from = Number(/bytes=(\d+)-/.exec(request.headers.range ?? '')?.[1] ?? 0)
    if (ranges && from > 0) {
      response.writeHead(206, { 'content-range': `bytes ${from}-${body.length - 1}/${body.length}` })
      body = body.subarray(from)
    } else {
      response.writeHead(200)
    }
    // An interrupted connection, once: the server stops partway and the next request is whole.
    if (state.cut > 0 && body.length > state.cut && request.url !== '/7zr.exe') {
      body = body.subarray(0, state.cut)
      state.cut = 0
    }
    response.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  closing.push(() => new Promise((resolve) => server.close(resolve)))
  return { server: `http://127.0.0.1:${server.address().port}`, asked, archives: () => asked.filter((one) => one.path !== '/7zr.exe') }
}

/** A Windows PC with an NVIDIA card and a current driver, whichever machine the test is on. */
const PC = { platform: 'win32', arch: 'x64', card: { name: 'NVIDIA GeForce RTX 4060 Ti', driver: '581.57', vram: 8 * 2 ** 30 } }

/** The real extractor's argument shape, run with Node because the fake 7-Zip is a script. */
const extract = (tool, args, options) => unpack(process.execPath, [tool, ...args], options)

const setUp = (own, server, extra = {}) => installComfy({ own, ...PC, ...pins(server), extract, ...extra })

test('ComfyUI is listed with its download size, and nothing is fetched to draw the list', async () => {
  const own = folder('listed')
  const release = await releases()
  const status = await comfyStatus({ own, ...PC })
  expect(status).toMatchObject({ state: 'missing', build: BUILDS[0], bytes: BUILDS[0].bytes + SEVEN_ZIP.bytes })
  expect(requirement(status)).toEqual(
    expect.objectContaining({ id: COMFYUI, kind: 'runtime', title: 'ComfyUI', action: 'install', bytes: BUILDS[0].bytes + SEVEN_ZIP.bytes, blocks: [RENDER] }),
  )
  expect(requirement(status).detail).toMatch(/v0\.38\.0/)
  expect(release.asked).toEqual([])
  expect(existsSync(home(own))).toBe(false)
})

test('the driver decides the build, and where Alexia cannot install it the list says how instead', async () => {
  // CUDA 13.0 needs a 580-series driver; an older one gets the CUDA 12.6 build ComfyUI publishes for it.
  expect(route({ ...PC }).build.asset).toBe('ComfyUI_windows_portable_nvidia.7z')
  expect(route({ ...PC, card: { ...PC.card, driver: '566.36' } }).build.asset).toBe('ComfyUI_windows_portable_nvidia_cu126.7z')
  expect(route({ ...PC, card: { ...PC.card, driver: '537.58' } })).toMatchObject({ ok: false, said: /older than ComfyUI needs/ })

  // No NVIDIA card, a Mac, Linux: a sentence and a link, and no button.
  const asked = []
  const probe = async () => {
    asked.push('nvidia-smi')
    return undefined
  }
  for (const [platform, words] of [
    ['win32', /NVIDIA graphics card/],
    ['darwin', /ComfyUI Desktop/],
    ['linux', /installed by hand/],
  ]) {
    const status = await comfyStatus({ own: folder(`none-${platform}`), platform, arch: 'x64', probe })
    expect(status.state).toBe('unavailable')
    expect(requirement(status)).toEqual(expect.objectContaining({ id: COMFYUI, action: 'instructions', instructions: expect.stringMatching(words) }))
    expect(requirement(status).instructions).toMatch(/https:\/\//)
    expect(requirement(status).bytes).toBeUndefined()
  }
  // Only Windows has a build to choose between, so only Windows is asked about its card.
  expect(asked).toEqual(['nvidia-smi'])
  await expect(installComfy({ own: folder('mac'), platform: 'darwin', probe })).rejects.toThrow(/ComfyUI Desktop/)
})

test('pressing Install downloads, verifies and unpacks into the plugin’s folder, and the list empties', async () => {
  const own = folder('own')
  const release = await releases()
  const said = []
  const done = await setUp(own, release.server, { onProgress: (n, total, text) => said.push(text) })

  const dir = join(home(own), 'ComfyUI_windows_portable', 'ComfyUI')
  expect(done).toMatchObject({ dir, tag: 'v0.38.0', asset: BUILDS[0].asset, already: false })
  expect(await launch.isInstall(dir)).toBe(true)
  expect(existsSync(join(home(own), 'ComfyUI_windows_portable', 'python_embeded', 'python.exe'))).toBe(true)
  // The archive and the extractor are gone once it is unpacked; so is the scratch folder.
  expect(readdirSync(home(own)).sort()).toEqual(['ComfyUI_windows_portable', 'installed.json'])
  // What was installed is written down: which release, which file, and its hash.
  const record = JSON.parse(readFileSync(join(home(own), 'installed.json'), 'utf8'))
  expect(record).toMatchObject({ tag: 'v0.38.0', asset: BUILDS[0].asset, sha256: sha(ARCHIVE), extractor: { tag: SEVEN_ZIP.tag } })
  expect(said.some((line) => /Unpacking ComfyUI v0\.38\.0 — 100%/.test(line))).toBe(true)

  expect(await installed(own)).toMatchObject({ dir, tag: 'v0.38.0' })
  expect(requirement(await comfyStatus({ own, ...PC }))).toBeUndefined()

  // Pressing it again is not a second download.
  const before = release.asked.length
  expect(await setUp(own, release.server)).toMatchObject({ dir, already: true })
  expect(release.asked).toHaveLength(before)
})

test('the installed ComfyUI is the one launch.js starts when the person has none', async () => {
  const own = folder('launched')
  const release = await releases()
  const { dir } = await setUp(own, release.server)
  const ours = async () => (await installed(own))?.dir
  // A budget of nothing stands in for a search of this machine that finds no ComfyUI.
  expect(await launch.install(undefined, 0, ours)).toBe(dir)
  // And it is started with the Python that came with it, not whatever is on PATH.
  expect(await launch.python(dir)).toMatch(/comfyui[\\/]ComfyUI_windows_portable[\\/]python_embeded[\\/]/)

  // A ComfyUI the person has wins — named in the settings, or found by the search.
  const theirs = folder(join('person', 'ComfyUI'))
  for (const file of ['main.py', 'nodes.py']) writeFileSync(join(theirs, file), '# theirs\n')
  expect(await launch.install(theirs, 400, ours)).toBe(theirs)
  expect(await launch.search(folder('person'))).toBe(theirs)
  // A setting that names a folder with nothing in it is still the person's answer, not a reason to start ours.
  expect(await launch.install(folder('empty-setting'), 400, ours)).toBeUndefined()
})

test('an interrupted download carries on from where it stopped', async () => {
  const own = folder('resumed')
  const release = await releases({ cut: 20_000 })
  await expect(setUp(own, release.server)).rejects.toThrow(/ended early.*carries on/)
  const part = join(home(own), 'downloads', `${BUILDS[0].asset}.part`)
  expect(statSync(part).size).toBe(20_000)
  expect(await installed(own)).toBeUndefined()

  await setUp(own, release.server)
  expect(release.archives().map((one) => one.range)).toEqual([undefined, 'bytes=20000-'])
  expect(await installed(own)).toBeDefined()
})

test('a server that ignores the range is started again rather than appended to', async () => {
  const own = folder('restarted')
  const release = await releases({ ranges: false })
  mkdirSync(join(home(own), 'downloads'), { recursive: true })
  writeFileSync(join(home(own), 'downloads', `${BUILDS[0].asset}.part`), ARCHIVE.subarray(0, 5000))
  await setUp(own, release.server)
  expect(release.archives()).toEqual([{ path: `/${BUILDS[0].asset}`, range: 'bytes=5000-' }])
  expect(await installed(own)).toBeDefined()
})

test('a download that is not the published file is deleted, not unpacked', async () => {
  const own = folder('corrupt')
  const release = await releases({ corrupt: true })
  await expect(setUp(own, release.server)).rejects.toThrow(/not the file ComfyUI published/)
  expect(existsSync(join(home(own), 'downloads', `${BUILDS[0].asset}.part`))).toBe(false)
  expect(existsSync(join(home(own), 'downloads', BUILDS[0].asset))).toBe(false)
  expect(existsSync(join(home(own), 'unpacking'))).toBe(false)
  expect(await installed(own)).toBeUndefined()
})

test('Install pressed twice is one download', async () => {
  const own = folder('twice')
  const release = await releases()
  const [one, two] = await Promise.all([setUp(own, release.server), setUp(own, release.server)])
  expect(one).toEqual(two)
  expect(release.archives()).toHaveLength(1)
})

test('a ComfyUI the person is running, and the one they installed, are not touched by an install', async () => {
  // Their ComfyUI on its usual port — or beside it, if this machine already has something there.
  const asked = []
  const theirs = createServer((request, response) => {
    asked.push(request.url)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"devices":[]}')
  })
  const at = await new Promise((resolve) => {
    theirs.once('error', () => theirs.listen(0, '127.0.0.1', () => resolve(theirs.address().port)))
    theirs.listen(USUAL_PORT, '127.0.0.1', () => resolve(USUAL_PORT))
  })
  closing.push(() => new Promise((resolve) => theirs.close(resolve)))
  const installedByThem = folder(join('their-desktop', 'ComfyUI'))
  for (const file of ['main.py', 'nodes.py']) writeFileSync(join(installedByThem, file), '# theirs\n')
  const before = readdirSync(join(root, 'their-desktop'), { recursive: true }).sort()

  const own = folder('beside-theirs')
  const release = await releases()
  const done = await setUp(own, release.server)

  expect(done.dir.startsWith(home(own))).toBe(true)
  expect(asked).toEqual([])
  expect(await launch.awake(`http://127.0.0.1:${at}`)).toBe(true)
  expect(readdirSync(join(root, 'their-desktop'), { recursive: true }).sort()).toEqual(before)
  expect(readFileSync(join(installedByThem, 'main.py'), 'utf8')).toBe('# theirs\n')
})
