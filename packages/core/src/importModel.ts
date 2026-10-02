// SPDX-License-Identifier: AGPL-3.0-only
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, open, realpath, rename, rmdir, statfs, unlink } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { assertGgufUnchanged, checkGgufSignal, GgufError, hashGgufFile, readGguf, sameGgufFile, type GgufMetadata, type GgufOptions, type GgufPart } from './gguf.js'
import type { Installed } from './installed.js'

export interface ImportGgufOptions extends GgufOptions { mode?: 'copy' | 'reference' }
const RESERVE = 1024 ** 3
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) { if (missing(error)) return false; throw error }
}
/** Canonicalize the caller's data root, but refuse links inside managed model storage. */
async function importDirectory(dataDir: string): Promise<string> {
  await mkdir(resolve(dataDir), { recursive: true })
  let path = await realpath(dataDir)
  for (const component of ['models', 'text', 'import']) {
    path = join(path, component)
    try { await mkdir(path, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const s = await lstat(path)
    if (!s.isDirectory() || s.isSymbolicLink() || await realpath(path) !== path) throw new GgufError('Import storage must be regular directories without symbolic links.')
  }
  return path
}
async function disk(path: string, remaining: number): Promise<void> {
  const s = await statfs(path, { bigint: true })
  if (s.bavail * s.bsize < BigInt(remaining + RESERVE)) throw new GgufError('Not enough disk space to import this model and leave 1 GiB free.')
}
async function verifySources(metadata: GgufMetadata): Promise<void> {
  for (const part of metadata.parts) await assertGgufUnchanged(part.path, part.fingerprint)
}
async function copyPart(part: GgufPart, to: string, options: ImportGgufOptions, base: number, total: number): Promise<void> {
  checkGgufSignal(options.signal)
  await assertGgufUnchanged(part.path, part.fingerprint)
  // FORCE avoids an uncancellable fallback copy: unsupported cloning uses our bounded loop.
  let cloned = false
  try {
    await copyFile(part.path, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE)
    cloned = true
  } catch (error) {
    if (!['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EINVAL', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    try { await unlink(to) } catch (e) { if (!missing(e)) throw e }
  }
  if (!cloned) {
    const input = await open(part.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK)
    try {
      const before = await input.stat({ bigint: true })
      if (!before.isFile() || !sameGgufFile(before, part.fingerprint)) throw new GgufError('GGUF source changed before copying.')
      const output = await open(to, 'wx', 0o600)
      try {
        const buffer = Buffer.alloc(1024 * 1024)
        let done = 0
        while (done < part.bytes) {
          checkGgufSignal(options.signal)
          const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, part.bytes - done), done)
          if (!bytesRead) throw new GgufError('GGUF source was truncated while copying.')
          let written = 0
          while (written < bytesRead) {
            checkGgufSignal(options.signal)
            const result = await output.write(buffer, written, bytesRead - written, done + written)
            if (!result.bytesWritten) throw new GgufError('Could not write imported model.')
            written += result.bytesWritten
          }
          done += bytesRead
          options.onProgress?.({ done: base + done, total, phase: 'copy' })
        }
        await output.sync()
        if (!sameGgufFile(await input.stat({ bigint: true }), part.fingerprint)) throw new GgufError('GGUF source changed while copying.')
      } finally { await output.close() }
    } finally { await input.close() }
  } else options.onProgress?.({ done: base + part.bytes, total, phase: 'copy' })
  checkGgufSignal(options.signal)
  await assertGgufUnchanged(part.path, part.fingerprint)
}
async function verifyCopies(metadata: GgufMetadata, files: string[], options: ImportGgufOptions): Promise<void> {
  let done = 0
  for (let i = 0; i < files.length; i++) {
    const path = files[i]!, part = metadata.parts[i]!, s = await lstat(path, { bigint: true })
    if (!s.isFile() || s.isSymbolicLink() || Number(s.size) !== part.bytes) throw new GgufError('Imported GGUF copy is not a complete regular file.')
    const sha = await hashGgufFile(path, s, { signal: options.signal, onProgress: p => options.onProgress?.({ phase: 'verify', done: done + p.done, total: metadata.bytes }) })
    if (sha !== part.sha256) throw new GgufError('Imported GGUF checksum does not match the source.')
    done += part.bytes
  }
}
function record(metadata: GgufMetadata, files: string[], owned: boolean): Installed {
  return {
    id: `llama/import-${metadata.sha256.slice(0, 24)}:${metadata.quant.toLowerCase()}`,
    name: metadata.name, repo: 'local/import', revision: metadata.sha256, quant: metadata.quant,
    format: 'gguf', imported: true, owned, files, bytes: metadata.bytes, sha256: metadata.sha256,
    architecture: metadata.architecture, tokenizerFingerprint: metadata.tokenizerFingerprint,
    params: metadata.params, contextMax: metadata.contextMax, kvBytesPerToken: metadata.kvBytesPerToken,
    context: Math.min(metadata.contextMax ?? 2048, 8192),
    tools: false, vision: false, abliterated: false, nsfwOk: 'unknown', vetted: false, ready: false, installedAt: Date.now(),
  }
}
async function cleanStaging(staging: string, created: string[]): Promise<void> {
  // Unlink only files this operation created; never recurse into another import.
  for (const file of created) { try { await unlink(file) } catch (error) { if (!missing(error)) throw error } }
  try { await rmdir(staging) } catch (error) { if (!missing(error) && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error }
}

/** Returns an unprobed record; the caller owns registry, runtime smoke check and pinning. */
export async function importGguf(path: string, dataDir: string, options: ImportGgufOptions = {}): Promise<Installed> {
  const mode = options.mode ?? 'copy'
  if (mode !== 'copy' && mode !== 'reference') throw new GgufError('Import mode must be copy or reference.')
  const metadata = await readGguf(path, options)
  checkGgufSignal(options.signal)
  if (mode === 'reference') { await verifySources(metadata); return record(metadata, metadata.files, false) }
  const directory = await importDirectory(dataDir), final = join(directory, metadata.sha256)
  const lock = `${final}.lock`
  // Exclusive lock also prevents two importers from overwriting each other's staging work.
  try { await mkdir(lock, { mode: 0o700 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new GgufError('This model is already being imported. Retry when that import finishes.')
    throw error
  }
  let staging: string | undefined
  const created: string[] = []
  try {
    const files = metadata.files.map(file => join(final, basename(file)))
    if (await exists(final)) {
      if (!(await lstat(final)).isDirectory() || await realpath(final) !== final) throw new GgufError('Unsafe existing import directory.')
      await verifyCopies(metadata, files, options)
      await verifySources(metadata)
      checkGgufSignal(options.signal)
      return record(metadata, files, true)
    }
    await disk(directory, metadata.bytes)
    staging = await mkdtemp(join(directory, '.import-'))
    let done = 0
    for (const part of metadata.parts) {
      await disk(staging, metadata.bytes - done)
      const to = join(staging, basename(part.path))
      created.push(to)
      await copyPart(part, to, options, done, metadata.bytes)
      done += part.bytes
    }
    await verifyCopies(metadata, created, options)
    await verifySources(metadata)
    checkGgufSignal(options.signal)
    if (await realpath(directory) !== directory || await realpath(staging) !== staging || await exists(final)) throw new GgufError('Import destination changed during copying.')
    await rename(staging, final)
    staging = undefined
    return record(metadata, files, true)
  } finally {
    try { if (staging) await cleanStaging(staging, created) }
    finally { await rmdir(lock) }
  }
}
