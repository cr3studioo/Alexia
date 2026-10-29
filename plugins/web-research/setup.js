// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const UV = '0.9.5'
const BUILDS = {
  'darwin-arm64': ['aarch64-apple-darwin.tar.gz', 'dc098ff224d78ed418e121fd374f655949d2c7031a70f6f6604eaf016a130433'],
  'darwin-x64': ['x86_64-apple-darwin.tar.gz', '58b1d4a25aa8ff99147c2550b33dcf730207fe7e0f9a0d5d36a1bbf36b845aca'],
  'win32-x64': ['x86_64-pc-windows-msvc.zip', '515dc53d7553f1357d0abc1f70acd921fbb9e30230b1d9a08737236daa6ee920'],
}
export function run(command, args, { signal, env, progress = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal })
    let tail = ''
    const read = (chunk) => { tail = (tail + chunk.toString()).slice(-2000); progress(tail.split('\n').filter(Boolean).at(-1) ?? '') }
    child.stdout.on('data', read); child.stderr.on('data', read)
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Research setup failed (${code}): ${tail}`)))
  })
}

/** Never calls a shell installer, system Python, or a personal browser. */
export async function setup(own, bundled, { signal, progress = () => {} } = {}) {
  const build = BUILDS[`${process.platform}-${process.arch}`]
  if (!build) throw new Error('Research supports macOS (Apple Silicon/Intel) and Windows x64.')
  const runtime = join(own, 'runtime')
  const env = { ...process.env, UV_PYTHON_INSTALL_DIR: join(runtime, 'python'), UV_CACHE_DIR: join(runtime, 'cache'), UV_PYTHON_PREFERENCE: 'only-managed', UV_NO_PROGRESS: '1', PLAYWRIGHT_BROWSERS_PATH: join(runtime, 'browsers') }
  const python = join(runtime, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const requirements = join(bundled, 'requirements.txt')
  const revision = createHash('sha256').update(await readFile(requirements)).digest('hex')
  const stamp = join(runtime, 'ready')
  if (existsSync(python) && await readFile(stamp, 'utf8').catch(() => '') === revision) return { python, env }
  await mkdir(runtime, { recursive: true })
  const uv = join(runtime, 'uv', process.platform === 'win32' ? 'uv.exe' : 'uv')
  if (!existsSync(uv)) {
    progress('Downloading private uv runtime')
    const [target, digest] = build
    const file = `uv-${target}`
    const response = await fetch(`https://github.com/astral-sh/uv/releases/download/${UV}/${file}`, { signal })
    if (!response.ok || !response.body) throw new Error(`uv download failed (${response.status})`)
    const chunks = []; let size = 0
    for await (const chunk of response.body) {
      chunks.push(chunk); size += chunk.length
      if (size > 80 * 1024 * 1024) throw new Error('uv archive exceeds download limit')
      progress(`Downloading research runtime · ${(size / 1024 / 1024).toFixed(1)} MB`)
    }
    const bytes = Buffer.concat(chunks)
    if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('uv download checksum did not match')
    const archive = join(runtime, file)
    const unpack = join(runtime, 'unpack')
    await writeFile(archive, bytes); await mkdir(unpack, { recursive: true })
    if (process.platform === 'win32') {
      const script = `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${unpack.replace(/'/g, "''")}' -Force`
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { signal, env, progress })
    } else await run('/usr/bin/tar', ['-xzf', archive, '-C', unpack], { signal, env, progress })
    // uv archives have a single platform directory on Unix, and loose executables on Windows.
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(unpack, { recursive: true })
    const executableName = process.platform === 'win32' ? 'uv.exe' : 'uv'
    const executable = entries.find((name) => name.split(/[\\/]/).at(-1) === executableName)
    if (!executable) throw new Error('uv archive contained no executable')
    await mkdir(join(runtime, 'uv'), { recursive: true })
    await rename(join(unpack, executable), uv)
    if (process.platform !== 'win32') await chmod(uv, 0o700)
    await rm(archive, { force: true }); await rm(unpack, { force: true, recursive: true })
  }
  progress('Installing private Python 3.12')
  await run(uv, ['python', 'install', '3.12.12'], { signal, env, progress })
  await run(uv, ['venv', '--allow-existing', '--python', '3.12.12', join(runtime, 'venv')], { signal, env, progress })
  progress('Installing pinned research dependencies')
  await run(uv, ['pip', 'sync', '--python', python, '--require-hashes', requirements], { signal, env, progress })
  progress('Downloading isolated Chromium browser')
  await run(python, ['-m', 'playwright', 'install', 'chromium'], { signal, env, progress })
  await writeFile(stamp, revision)
  return { python, env }
}
