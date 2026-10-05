// SPDX-License-Identifier: AGPL-3.0-only
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { isInstall } from './launch.js'
import { RENDER } from './worker.js'

/**
 * Installing ComfyUI, on the computer that renders, into this plugin's own folder.
 *
 * **This reverses a decision, and the reason is the computer nobody is sitting at.** Handing
 * somebody ComfyUI's own installer was right while the pictures were made on the machine in
 * front of them. A paired PC in another room is different: the person pressing *Install* is at
 * a Mac, and *go over there and run an installer* is the chore this whole feature exists to
 * remove. So Alexia installs one — and only ever its own copy:
 *
 * - **It goes into the plugin's folder and nowhere else.** Not Program Files, not the Desktop,
 *   never on top of a ComfyUI the person installed. Removing the plugin removes it, which is
 *   invariant 3 holding for a seven-gigabyte program as it does for a settings file.
 * - **A ComfyUI the person has is always preferred.** `launch.js` looks for theirs first; this
 *   copy is what is started only when there is none.
 * - **Only the official build, pinned.** The portable release ComfyUI publishes itself, by tag,
 *   with the size and SHA-256 GitHub records for it. A newer release is a decision made in this
 *   file, not something a download picks up on its own.
 * - **Nothing is fetched until somebody presses Install.** The size is on the button first.
 *
 * ponytail: only Windows with an NVIDIA card is installed here. That is the one platform where
 * ComfyUI ships a self-contained build — Python, PyTorch and all — that needs nothing else on
 * the machine. Everywhere else the official route is either an app the person installs (ComfyUI
 * Desktop on a Mac) or a Python and a toolchain the machine may not have, and those are said
 * plainly with a link rather than half-done here.
 */

/** The requirement id. The same one `worker.js` uses for its instructions, so a list never shows both. */
export const COMFYUI = 'comfyui'

const RELEASES = 'https://github.com/Comfy-Org/ComfyUI/releases/download'

/**
 * The portable builds, pinned to one release.
 *
 * Two of them because they are built against different CUDA versions and the driver decides
 * which will run: the default is CUDA 13.0, which needs a 580-series driver or newer, and the
 * `cu126` build is the one ComfyUI publishes for cards whose driver is older. Sizes and hashes
 * are GitHub's own `digest` for each asset of `v0.38.0` (published 2026-09-29).
 */
export const BUILDS = [
  {
    tag: 'v0.38.0',
    asset: 'ComfyUI_windows_portable_nvidia.7z',
    url: `${RELEASES}/v0.38.0/ComfyUI_windows_portable_nvidia.7z`,
    bytes: 1_994_326_521,
    sha256: '8f137eac345707fd7e42bcf8e29377415243011ca15522a86aed6c77331fbd56',
    cuda: '13.0',
    driver: 580,
  },
  {
    tag: 'v0.38.0',
    asset: 'ComfyUI_windows_portable_nvidia_cu126.7z',
    url: `${RELEASES}/v0.38.0/ComfyUI_windows_portable_nvidia_cu126.7z`,
    bytes: 1_886_111_296,
    sha256: 'bd3bd7e3ce0068d8bc58fe46c912c360dd510f9bcfd0c5029d4906e6e6fbc677',
    cuda: '12.6',
    driver: 560,
  },
]

/**
 * What opens the archive.
 *
 * **Node cannot read a `.7z`, and the release is only published as one** — LZMA2 with a BCJ2
 * filter and a 768 MB dictionary. Windows' own `tar.exe` is libarchive, which can read 7z in
 * principle, but the copy Windows 10 ships was built without LZMA and fails on exactly this
 * file. So the extractor is `7zr.exe`: the standalone, 7z-only build Igor Pavlov publishes, about
 * six hundred kilobytes, run once and deleted. Fetched from the 7-Zip project's own GitHub
 * release by tag and checked against the SHA-256 recorded for it there (the same file 7-zip.org
 * serves as `a/7zr.exe`; both were hashed when this was pinned).
 */
export const SEVEN_ZIP = {
  tag: '26.03',
  asset: '7zr.exe',
  url: 'https://github.com/ip7z/7zip/releases/download/26.03/7zr.exe',
  bytes: 602_624,
  sha256: 'ad4c82fadcbdf93c03b4fc440f300509c7d60c5c2f4d183e35d9d70d6957037d',
}

/** Where a person goes when Alexia cannot install it for them. */
export const LINKS = {
  download: 'https://www.comfy.org/download',
  manual: 'https://docs.comfy.org/installation/manual_install',
  driver: 'https://www.nvidia.com/en-us/drivers/',
}

/** The folder the copy lives in, inside the plugin's own. Everything this file writes is under it. */
export const home = (own) => join(own, 'comfyui')

/** The record of what was installed. Present means finished; a half-unpacked folder has none. */
const RECORD = 'installed.json'

const gb = (n) => `${(n / 1e9).toFixed(1)} GB`

/**
 * Ask the NVIDIA driver what card this is, and which driver version it is running.
 *
 * Asked of `nvidia-smi` by name and in the two places the driver puts it, because a plugin
 * inherits a short environment from core and `PATH` alone has missed it on a PC where it
 * answered in a terminal. No answer is no NVIDIA card, which is the honest reading: without a
 * driver that answers, the CUDA build would not run either.
 */
export async function nvidia({ platform = process.platform, env = process.env, timeout = 10_000 } = {}) {
  const commands = ['nvidia-smi']
  if (platform === 'win32') {
    if (env.SystemRoot) commands.push(join(env.SystemRoot, 'System32', 'nvidia-smi.exe'))
    const programs = env.ProgramW6432 ?? env.ProgramFiles
    if (programs) commands.push(join(programs, 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'))
  }
  for (const command of commands) {
    const said = await new Promise((done) =>
      execFile(
        command,
        ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader,nounits'],
        { timeout, windowsHide: true },
        (error, stdout) => done(error ? '' : String(stdout)),
      ),
    )
    const [name, driver, mb] = said.split(/\r?\n/)[0].split(',').map((part) => part.trim())
    if (name && driver) return { name, driver, vram: Number(mb) * 1024 * 1024 }
  }
  return undefined
}

/**
 * Which build this computer gets — or, where there is none Alexia can install, why not.
 *
 * `card` is `nvidia()`'s answer. Kept apart from asking it so the choice is a table a test can
 * read, rather than something that depends on the machine the test runs on.
 */
export function route({ platform = process.platform, arch = process.arch, card } = {}) {
  if (platform === 'darwin') {
    return {
      ok: false,
      said:
        'On a Mac, ComfyUI’s own app is the supported way to install it. Download ComfyUI Desktop from ' +
        `${LINKS.download}; Alexia finds it afterwards and leaves it as it is.`,
      link: LINKS.download,
    }
  }
  if (platform !== 'win32') {
    return {
      ok: false,
      said:
        'On Linux, ComfyUI is installed by hand with Python and the PyTorch build for your graphics card, ' +
        `which Alexia cannot do for you. The steps are at ${LINKS.manual}; Alexia finds it afterwards.`,
      link: LINKS.manual,
    }
  }
  if (arch !== 'x64' || !card) {
    return {
      ok: false,
      said:
        'Alexia installs ComfyUI by itself only on Windows PCs with an NVIDIA graphics card, and none answered on ' +
        `this one. For an AMD or Intel card, install ComfyUI from ${LINKS.download}; Alexia finds it afterwards.`,
      link: LINKS.download,
    }
  }
  const driver = Number.parseFloat(card.driver)
  const build = BUILDS.find((one) => driver >= one.driver)
  if (!build) {
    return {
      ok: false,
      said:
        `The NVIDIA driver on this PC (${card.driver}) is older than ComfyUI needs. Update it from ${LINKS.driver}, ` +
        'then press Install again.',
      link: LINKS.driver,
    }
  }
  return { ok: true, build }
}

/**
 * Is Alexia's own ComfyUI installed here, and where?
 *
 * Read from the record written when an install finished, and checked against the disk: a
 * record whose folder has since gone is not an install.
 */
export async function installed(own) {
  if (!own) return undefined
  try {
    const said = JSON.parse(await readFile(join(home(own), RECORD), 'utf8'))
    const dir = resolve(home(own), String(said.dir ?? ''))
    return dir.startsWith(resolve(home(own)) + sep) && (await isInstall(dir)) ? { ...said, dir } : undefined
  } catch {
    return undefined
  }
}

/**
 * Where this computer stands: `installed`, `missing` (and installable, with its size), or
 * `unavailable` with the sentence and link that say why.
 */
export async function comfyStatus({ own, platform, arch, card, probe = nvidia } = {}) {
  const there = await installed(own)
  if (there) return { state: 'installed', dir: there.dir, tag: there.tag, asset: there.asset }
  // Only Windows has a build to choose between, so only Windows is asked about its card.
  const windows = (platform ?? process.platform) === 'win32'
  const way = route({ platform, arch, card: card === undefined && windows ? await probe({ platform }) : card })
  if (!way.ok) return { state: 'unavailable', said: way.said, link: way.link }
  return { state: 'missing', build: way.build, bytes: way.build.bytes + SEVEN_ZIP.bytes }
}

/**
 * The setup requirement, in the shape `computeHooks.setup` returns — or nothing once installed.
 *
 * The size is the two downloads together, because that is what crosses the wire when the
 * button is pressed; unpacked it is several times larger, and a person with a nearly full disk
 * finds that out from the extractor's own sentence rather than from a guess here.
 */
export function requirement(status) {
  if (!status || status.state === 'installed') return undefined
  if (status.state === 'unavailable') {
    return {
      id: COMFYUI,
      kind: 'runtime',
      title: 'ComfyUI',
      detail: 'The program that makes the pictures.',
      action: 'instructions',
      instructions: status.said,
      blocks: [RENDER],
    }
  }
  return {
    id: COMFYUI,
    kind: 'runtime',
    title: 'ComfyUI',
    detail:
      `The program that makes the pictures — ComfyUI ${status.build.tag} for NVIDIA (CUDA ${status.build.cuda}), installed ` +
      'into Alexia’s own folder. A ComfyUI you install yourself is used instead and left alone.',
    bytes: status.bytes,
    action: 'install',
    blocks: [RENDER],
  }
}

const size = async (path) => {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/** The SHA-256 of a file on disk, read in one pass. */
export async function sha256(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/**
 * Fetch one pinned file, resuming what an earlier attempt left, and refusing anything that is
 * not exactly what was pinned.
 *
 * Like `models.js`, it writes to a `.part` and the rename is the commit. Unlike a model, the
 * publisher states a hash, so the file is checked against it before it is used — **a download
 * of the right length and the wrong bytes is deleted, not unpacked**, because the next thing
 * done with it is running what is inside. A `.part` that is already too long cannot be resumed
 * into anything correct and is started again; one that ends early is kept, so pressing Install
 * again carries on from there.
 */
export async function download(pin, to, { signal, onProgress, label = pin.asset, fetch = globalThis.fetch } = {}) {
  if ((await size(to)) === pin.bytes && (await sha256(to)) === pin.sha256) return { path: to, already: true }
  await rm(to, { force: true })
  const part = `${to}.part`
  let from = await size(part)
  if (from > pin.bytes) {
    await rm(part, { force: true })
    from = 0
  }
  let got = from
  if (from < pin.bytes) {
    const response = await fetch(pin.url, { signal, headers: from > 0 ? { range: `bytes=${from}-` } : {} })
    if (!response.ok) throw new Error(`Could not download ${label}: ${response.status} ${response.statusText}`.trim())
    // A server that ignores `Range` answers 200 with the whole file. Appending that to what is
    // already here would make a file too long and quietly wrong, so it starts again instead.
    const resuming = from > 0 && response.status === 206
    got = resuming ? from : 0
    let told = 0
    const counting = new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk)
        got += chunk.length
        const now = Date.now()
        if (now - told > 1000) {
          told = now
          onProgress?.(got, pin.bytes, `Downloading ${label} — ${gb(got)} of ${gb(pin.bytes)}`)
        }
      },
    })
    await pipeline(Readable.fromWeb(response.body.pipeThrough(counting)), createWriteStream(part, { flags: resuming ? 'a' : 'w' }), { signal })
  }
  if (got < pin.bytes) {
    throw new Error(`The download of ${label} ended early — ${gb(got)} of ${gb(pin.bytes)}. Press Install again and it carries on from there.`)
  }
  if (got > pin.bytes || (await sha256(part)) !== pin.sha256) {
    await rm(part, { force: true })
    throw new Error(`The download of ${label} was not the file ComfyUI published, so it was deleted rather than used. Press Install to try again.`)
  }
  await rename(part, to)
  return { path: to, already: false }
}

/**
 * Run the extractor, reporting the percentage it prints.
 *
 * `-bsp1` sends 7-Zip's progress to standard output, which is read for its last percentage;
 * `-bso0` keeps the list of every file it wrote out of it. Its own sentence on failure — *not
 * enough space on the disk* is the likely one — is what the error says.
 */
export function unpack(tool, args, { signal, onProgress } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(tool, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(signal && { signal }) })
    let said = ''
    child.stdout.on('data', (chunk) => {
      const percent = [...String(chunk).matchAll(/(\d{1,3})%/g)].pop()
      if (percent) onProgress?.(Number(percent[1]))
    })
    child.stderr.on('data', (chunk) => {
      said = (said + String(chunk)).slice(-2000)
    })
    child.on('error', fail)
    child.on('close', (code) => {
      if (code === 0) return done()
      const last = said.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-2).join(' — ')
      fail(new Error(`ComfyUI could not be unpacked${last ? `: ${last}` : ` (7-Zip exited with ${code}).`}`))
    })
  })
}

/** The folder inside an unpacked archive that is ComfyUI itself, at most two levels down. */
async function locate(at, depth = 2) {
  if (await isInstall(at)) return at
  if (depth <= 0) return undefined
  const entries = await readdir(at, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = await locate(join(at, entry.name), depth - 1)
    if (found) return found
  }
  return undefined
}

/** One install per folder at a time. A button pressed twice must not be two downloads into one `.part`. */
const running = new Map()

/**
 * Install Alexia's own ComfyUI into `own`, the plugin's folder on this computer.
 *
 * Called from the `install` hook, which core calls only after somebody pressed the button
 * beside the requirement — nothing else in the plugin reaches this. Download both files,
 * verify them, unpack into a scratch folder, move the result into place, and only then write
 * the record that makes it an install. A failure at any step leaves what can be resumed and
 * nothing that looks finished.
 *
 * Everything after `own` is for tests: a fake card, a fake platform, a fake server, the
 * extractor run through something other than Windows.
 */
export function installComfy({ own, signal, onProgress, ...rest } = {}) {
  if (!own) return Promise.reject(new Error('Alexia has not given this plugin a folder to work in.'))
  const key = resolve(home(own))
  if (!running.has(key)) {
    running.set(key, put({ own, signal, onProgress, ...rest }).finally(() => running.delete(key)))
  }
  return running.get(key)
}

async function put({ own, signal, onProgress, platform, arch, card, probe = nvidia, fetch = globalThis.fetch, extract = unpack, seven = SEVEN_ZIP, builds }) {
  const already = await installed(own)
  if (already) return { ...already, already: true }
  const status = await comfyStatus({ own, platform, arch, card, probe })
  if (status.state === 'unavailable') throw new Error(status.said)
  const build = builds ? builds.find((one) => one.asset === status.build.asset) ?? builds[0] : status.build

  const base = home(own)
  const downloads = join(base, 'downloads')
  await mkdir(downloads, { recursive: true })
  const report = (done, total, text) => onProgress?.(done, total, text)

  const tool = join(downloads, seven.asset)
  await download(seven, tool, { signal, fetch, label: '7-Zip' })
  // A no-op on Windows, and what lets the same steps run where a test has to execute it.
  await chmod(tool, 0o755).catch(() => {})
  const archive = join(downloads, build.asset)
  await download(build, archive, { signal, fetch, label: `ComfyUI ${build.tag}`, onProgress: report })

  // Unpacked beside its final place and moved in at the end, so a folder at the real path is
  // always a whole one. Whatever an interrupted unpack left is ours and is cleared first.
  const scratch = join(base, 'unpacking')
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })
  report(0, 100, `Unpacking ComfyUI ${build.tag}`)
  await extract(tool, ['x', archive, `-o${scratch}`, '-y', '-bso0', '-bsp1'], {
    signal,
    onProgress: (percent) => report(percent, 100, `Unpacking ComfyUI ${build.tag} — ${percent}%`),
  })
  const inner = await locate(scratch)
  if (!inner) {
    throw new Error(`The ComfyUI ${build.tag} archive unpacked, but there was no ComfyUI inside it. Nothing was installed.`)
  }
  // The top folder of the archive — `ComfyUI_windows_portable`, which holds `ComfyUI` and the
  // `python_embeded` beside it that `launch.js` looks for.
  const top = relative(scratch, inner).split(sep)[0]
  const from = top ? join(scratch, top) : scratch
  const into = join(base, top || 'ComfyUI')
  await rm(into, { recursive: true, force: true })
  await rename(from, into)
  await rm(scratch, { recursive: true, force: true })
  const dir = top ? join(into, relative(from, inner)) : into

  const record = {
    tag: build.tag,
    asset: build.asset,
    url: build.url,
    bytes: build.bytes,
    sha256: build.sha256,
    extractor: { tag: seven.tag, sha256: seven.sha256 },
    dir: relative(base, dir),
    at: new Date().toISOString(),
  }
  await writeFile(join(base, RECORD), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  // Two gigabytes of archive is not worth keeping once it is unpacked and recorded.
  await rm(downloads, { recursive: true, force: true })
  report(100, 100, `ComfyUI ${build.tag} is installed`)
  return { ...record, dir, already: false }
}
