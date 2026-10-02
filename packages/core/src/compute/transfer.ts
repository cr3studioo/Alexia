// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, type Hash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises'
import { extname, join, posix, win32 } from 'node:path'
import { failureOf, Frames, send, streamError, type Controller } from './controller.js'
import type { ArtifactHead, ArtifactPutResult } from './protocol.js'
import { ComputeError, type ArtifactRef } from './types.js'

const SHA256 = /^[a-f0-9]{64}$/
/** An artifact id is also a file name here, so it may be nothing a path could be made of. */
const ARTIFACT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/

const refused = (message: string): ComputeError => new ComputeError('refused', message)
const cancelled = (): ComputeError => new ComputeError('cancelled', 'The transfer was cancelled.')
const thrown = (failure: unknown): ComputeError => { const { code, message } = failureOf(failure); return new ComputeError(code, message) }

/** The host's name for a file, as one this computer can safely give it: no directory, and never a way out of one. */
function localName(artifact: ArtifactRef): string {
  const name = [...artifact.name.split(posix.sep).join('').split(win32.sep).join('')].filter((char) => char.charCodeAt(0) >= 32 && char !== ':').join('').trim()
  return name === '' || /^\.+$/.test(name) ? artifact.id : name
}

async function hashFile(path: string, into: Hash, signal?: AbortSignal): Promise<number> {
  let bytes = 0
  for await (const chunk of createReadStream(path, { signal })) {
    bytes += (chunk as Buffer).length
    into.update(chunk as Buffer)
  }
  return bytes
}

/**
 * Send one approved file as an input of `jobId`.
 *
 * The host is told the size and the hash before the first byte, so the file is read twice:
 * once to know them, once to send it — each time as a stream, never as one buffer. The second
 * reading is hashed again, and a file that changed in between is refused here rather than
 * handed to the host as something it was not said to be.
 */
export async function upload(controller: Controller, hostId: string, jobId: string, file: { path: string; name: string; mime: string }, signal?: AbortSignal): Promise<ArtifactRef> {
  if (signal?.aborted) throw cancelled()
  let bytes: number, sha256: string
  try {
    const first = createHash('sha256')
    bytes = await hashFile(file.path, first, signal)
    sha256 = first.digest('hex')
  } catch {
    throw signal?.aborted ? cancelled() : refused('That file could not be read.')
  }
  const stream = await controller.stream(hostId, { stream: 'artifact', put: { jobId, name: file.name, mime: file.mime, bytes, sha256 } }, signal)
  const frames = new Frames(stream)
  try {
    const second = createHash('sha256')
    let sent = 0, turned: unknown
    try {
      for await (const chunk of createReadStream(file.path, { signal })) {
        sent += (chunk as Buffer).length
        if (sent > bytes) throw refused('That file changed while it was being sent.')
        second.update(chunk as Buffer)
        await send(stream, chunk as Buffer)
      }
      if (sent !== bytes || second.digest('hex') !== sha256) throw refused('That file changed while it was being sent.')
      stream.end()
    } catch (error) {
      if (signal?.aborted) throw cancelled()
      if (error instanceof ComputeError && error.code === 'refused') throw error
      // The host may have turned the file away before it had all of it. Its reason is worth more than a broken pipe.
      turned = error
    }
    const answer = await frames.next().catch(() => undefined) as ArtifactPutResult | undefined
    if (signal?.aborted) throw cancelled()
    if (typeof answer === 'object' && answer !== null && answer.type === 'refused') throw thrown(answer.failure)
    if (turned !== undefined) throw turned instanceof ComputeError ? turned : streamError(turned)
    const artifact = typeof answer === 'object' && answer !== null && answer.type === 'stored' ? answer.artifact : undefined
    if (!artifact || typeof artifact.id !== 'string' || artifact.jobId !== jobId || artifact.bytes !== bytes || artifact.sha256 !== sha256) {
      throw new ComputeError('interrupted', 'That computer did not confirm the file.')
    }
    return artifact
  } finally { stream.destroy() }
}

/**
 * Bring one of a job's files home: into `toDir`, checked against the size and SHA-256 the job
 * reported, and only then acknowledged so the host may delete its copy.
 *
 * Bytes land in `<id>.part` first. A transfer that breaks leaves that file, and the next call
 * for the same artifact asks the host for the rest from where it stopped. A file whose size or
 * hash is wrong is deleted, refused and **not** acknowledged: the host keeps its copy.
 */
export async function fetchArtifact(controller: Controller, hostId: string, artifact: ArtifactRef, toDir: string, signal?: AbortSignal): Promise<string> {
  if (!ARTIFACT_ID.test(artifact.id) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || !SHA256.test(artifact.sha256) || typeof artifact.name !== 'string') {
    throw refused('That is not an artifact this computer can fetch.')
  }
  if (signal?.aborted) throw cancelled()
  await mkdir(toDir, { recursive: true })
  const partial = join(toDir, `${artifact.id}.part`)
  const hash = createHash('sha256')
  let have: number
  try {
    have = (await stat(partial)).size
    if (have > artifact.bytes) throw new Error('longer than the artifact')
    if (await hashFile(partial, hash, signal) !== have) throw new Error('changed')
  } catch {
    if (signal?.aborted) throw cancelled()
    // No partial file, or one that cannot be the start of this artifact: begin again.
    await unlink(partial).catch(() => {})
    return fetchInto(controller, hostId, artifact, toDir, partial, createHash('sha256'), 0, signal)
  }
  return fetchInto(controller, hostId, artifact, toDir, partial, hash, have, signal)
}

async function fetchInto(controller: Controller, hostId: string, artifact: ArtifactRef, toDir: string, partial: string, hash: Hash, have: number, signal?: AbortSignal): Promise<string> {
  let digest = hash
  if (have < artifact.bytes) {
    const stream = await controller.stream(hostId, { stream: 'artifact', get: artifact.id, ...(have > 0 && { offset: have }) }, signal)
    try {
      const frames = new Frames(stream)
      const head = await frames.next() as ArtifactHead | undefined
      if (typeof head !== 'object' || head === null) throw new ComputeError('interrupted', 'That computer did not send the file.')
      if (head.type === 'refused') throw thrown(head.failure)
      // A host may answer from the start instead of from where this copy stopped; nowhere else.
      if (head.type !== 'head' || (head.offset !== have && head.offset !== 0)) throw refused('That computer answered with a different file.')
      if (head.artifact?.id !== artifact.id || head.artifact.bytes !== artifact.bytes || head.artifact.sha256 !== artifact.sha256) {
        throw refused('That computer answered with a different file.')
      }
      if (head.offset === 0 && have > 0) { have = 0; digest = createHash('sha256') }
      const file = await open(partial, have > 0 ? 'a' : 'w', 0o600)
      try {
        for await (const chunk of frames.bytes()) {
          have += chunk.length
          if (have > artifact.bytes) break
          digest.update(chunk)
          await file.write(chunk)
        }
      } finally { await file.close() }
    } catch (error) {
      if (signal?.aborted) throw cancelled()
      throw error instanceof ComputeError ? error : streamError(error)
    } finally { stream.destroy() }
    // Short is a transfer that stopped: what arrived is kept, and the next fetch resumes it.
    if (have < artifact.bytes) throw new ComputeError('interrupted', 'The file did not finish arriving.')
  }
  if (have !== artifact.bytes || digest.digest('hex') !== artifact.sha256) {
    await unlink(partial).catch(() => {})
    throw refused('The file that arrived does not match its size or checksum.')
  }
  const name = localName(artifact)
  let path = join(toDir, name)
  // Never over a file that is already there: the same name twice is two files.
  if (existsSync(path)) path = join(toDir, `${name.slice(0, name.length - extname(name).length)}-${artifact.id.slice(0, 8)}${extname(name)}`)
  await rename(partial, path)
  // The bytes are home and checked. An acknowledgement that cannot be delivered costs the host
  // a copy it deletes at expiry anyway, so it does not undo a transfer that succeeded.
  await controller.call(hostId, 'artifact.ack', { artifactIds: [artifact.id] }, signal).catch(() => {})
  return path
}
