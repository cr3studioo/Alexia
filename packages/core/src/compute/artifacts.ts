// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { copyFile, rename, unlink } from 'node:fs/promises'
import { basename, join, posix, resolve, win32 } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ARTIFACT_ARG, type ArtifactPut } from './protocol.js'
import { ARTIFACT_RETENTION_MS, ComputeError, type ArtifactRef } from './types.js'

export const ABANDONED_INPUT_MS = 60 * 60 * 1000
const JOB_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const ARTIFACT_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const SHA256 = /^[a-f0-9]{64}$/
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'
const displayName = (name: string): string => name.split(posix.sep).join('').split(win32.sep).join('').replace(/\0/g, '')
type Kind = 'inputs' | 'outputs'
interface Stored { artifact: ArtifactRef; kind: Kind; createdAt: number }
interface Job { createdAt: number; claimed: boolean; artifacts: Map<string, Stored> }

function directory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const entry = lstatSync(path)
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new ComputeError('refused', 'Artifact storage must use regular directories.')
}

function stored(value: unknown, jobId: string): value is Stored {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Partial<Stored>, artifact = item.artifact
  return (item.kind === 'inputs' || item.kind === 'outputs') && Number.isFinite(item.createdAt) &&
    artifact !== undefined && typeof artifact === 'object' && artifact !== null && typeof artifact.id === 'string' && ARTIFACT_ID.test(artifact.id) && artifact.jobId === jobId &&
    typeof artifact.name === 'string' && artifact.name === displayName(artifact.name) && typeof artifact.mime === 'string' &&
    Number.isSafeInteger(artifact.bytes) && artifact.bytes >= 0 && typeof artifact.sha256 === 'string' && SHA256.test(artifact.sha256) && Number.isFinite(artifact.expiresAt)
}

/** Host-internal paths stay here; only ArtifactRef and streamed bytes cross the connection. */
export class Artifacts {
  readonly #dir: string
  readonly #retentionMs: number
  readonly #now: () => number
  readonly #jobs = new Map<string, Job>()
  readonly #artifacts = new Map<string, Stored>()
  readonly #busy = new Map<string, number>()
  #timer: ReturnType<typeof setTimeout> | undefined
  #sweeping: Promise<number> | undefined

  constructor(options: { dir: string; retentionMs?: number; now?(): number }) {
    this.#retentionMs = options.retentionMs ?? ARTIFACT_RETENTION_MS
    this.#now = options.now ?? Date.now
    if (!Number.isFinite(this.#retentionMs) || this.#retentionMs < 0) throw new ComputeError('refused', 'Artifact retention must be a nonnegative duration.')
    try {
      mkdirSync(resolve(options.dir), { recursive: true, mode: 0o700 })
      this.#dir = realpathSync(options.dir)
      this.#scan()
      this.#arm()
    } catch (error) { throw this.#error(error, 'refused', 'Artifact storage is unavailable.') }
  }

  /** Only a staged or claimed job has a directory a worker may use. */
  jobDir(jobId: string): string {
    this.#job(jobId)
    try {
      const path = join(this.#dir, jobId), entry = lstatSync(path)
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new ComputeError('not-found', 'That job is unavailable.')
      return path
    } catch (error) { throw this.#error(error, 'not-found', 'That job is unavailable.') }
  }

  async put(meta: ArtifactPut, bytes: Readable, signal?: AbortSignal): Promise<ArtifactRef> {
    meta = { ...meta }
    this.#validateJobId(meta.jobId)
    if (!Number.isSafeInteger(meta.bytes) || meta.bytes < 0 || !SHA256.test(meta.sha256) || typeof meta.name !== 'string' || typeof meta.mime !== 'string') {
      throw new ComputeError('refused', 'The input metadata is invalid.')
    }
    if (signal?.aborted) throw new ComputeError('cancelled', 'The input transfer was cancelled.')
    const id = randomUUID(), hash = createHash('sha256')
    let size = 0, temporary: string | undefined, target: string | undefined
    this.#begin(meta.jobId)
    try {
      const job = this.#ensure(meta.jobId), dir = this.jobDir(meta.jobId)
      directory(join(dir, 'inputs'))
      temporary = join(dir, 'inputs', `${id}.part`)
      target = join(dir, 'inputs', id)
      const verify = new Transform({ transform(chunk: Buffer, _encoding, done) {
        size += chunk.length
        if (size > meta.bytes) { done(new ComputeError('refused', 'The input size does not match.')); return }
        hash.update(chunk)
        done(null, chunk)
      } })
      await pipeline(bytes, verify, createWriteStream('', { fd: openSync(temporary, 'wx', 0o600), autoClose: true }), { signal })
      if (size !== meta.bytes || hash.digest('hex') !== meta.sha256) throw new ComputeError('refused', 'The input size or checksum does not match.')
      if (signal?.aborted) throw new ComputeError('cancelled', 'The input transfer was cancelled.')
      renameSync(temporary, target)
      const createdAt = this.#now(), artifact: ArtifactRef = { id, jobId: meta.jobId, name: displayName(meta.name), mime: meta.mime, bytes: size, sha256: meta.sha256, expiresAt: createdAt + this.#retentionMs }
      utimesSync(target, createdAt / 1000, createdAt / 1000)
      this.#add(job, { artifact, kind: 'inputs', createdAt })
      try { this.#save(meta.jobId) } catch (error) { this.#forget(id); throw error }
      return { ...artifact }
    } catch (error) {
      if (temporary) this.#remove(temporary)
      if (target) this.#remove(target)
      throw signal?.aborted ? new ComputeError('cancelled', 'The input transfer was cancelled.') : this.#error(error, 'refused', 'The input could not be stored.')
    } finally { this.#end(meta.jobId); this.#removeEmpty(meta.jobId); this.#arm() }
  }

  async adopt(jobId: string, path: string, about?: { name?: string; mime?: string }): Promise<ArtifactRef> {
    const job = this.#job(jobId), id = randomUUID()
    let temporary: string | undefined, target: string | undefined
    this.#begin(jobId)
    try {
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new ComputeError('refused', 'An output must be a regular file.')
      const dir = this.jobDir(jobId)
      directory(join(dir, 'outputs'))
      temporary = join(dir, 'outputs', `${id}.part`)
      target = join(dir, 'outputs', id)
      // Workers can write on another volume. Keep their source until the copy is indexed.
      await copyFile(path, temporary, constants.COPYFILE_EXCL)
      const { bytes, sha256 } = await this.#hash(temporary)
      await rename(temporary, target)
      const createdAt = this.#now(), artifact: ArtifactRef = { id, jobId, name: displayName(about?.name ?? basename(path)), mime: about?.mime ?? 'application/octet-stream', bytes, sha256, expiresAt: createdAt + this.#retentionMs }
      utimesSync(target, createdAt / 1000, createdAt / 1000)
      this.#add(job, { artifact, kind: 'outputs', createdAt })
      try { this.#save(jobId); await unlink(path) } catch (error) { this.#forget(id); this.#save(jobId); throw error }
      return { ...artifact }
    } catch (error) {
      if (temporary) this.#remove(temporary)
      if (target) this.#remove(target)
      throw this.#error(error, 'worker-failure', 'The output could not be stored.')
    } finally { this.#end(jobId); this.#arm() }
  }

  open(artifactId: string, offset = 0): { artifact: ArtifactRef; bytes: Readable } {
    const item = this.#item(artifactId)
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > item.artifact.bytes) throw new ComputeError('refused', 'That artifact offset is invalid.')
    try {
      const path = this.#path(item)
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new ComputeError('not-found', 'That artifact is unavailable.')
      const bytes = createReadStream('', { fd: openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)), autoClose: true, start: offset })
      return { artifact: { ...item.artifact }, bytes }
    } catch (error) { throw this.#error(error, 'not-found', 'That artifact is unavailable.') }
  }

  resolve(jobId: string, args: Record<string, unknown>): Record<string, unknown> {
    this.#job(jobId)
    const visit = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(visit)
      if (typeof value !== 'object' || value === null) return value
      const object = value as Record<string, unknown>
      if (ARTIFACT_ARG in object) {
        if (Object.keys(object).length !== 1 || typeof object[ARTIFACT_ARG] !== 'string') throw new ComputeError('refused', 'An input reference is invalid.')
        const item = this.#item(object[ARTIFACT_ARG])
        if (item.kind !== 'inputs' || item.artifact.jobId !== jobId) throw new ComputeError('refused', 'That input does not belong to this job.')
        try {
          const path = this.#path(item), entry = lstatSync(path)
          if (!entry.isFile() || entry.isSymbolicLink()) throw new ComputeError('not-found', 'That input is unavailable.')
          return path
        } catch (error) { throw this.#error(error, 'not-found', 'That input is unavailable.') }
      }
      return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, visit(child)]))
    }
    return visit(args) as Record<string, unknown>
  }

  claimed(jobId: string): void {
    try { const job = this.#ensure(jobId); job.claimed = true; this.#save(jobId); this.#arm() }
    catch (error) { throw this.#error(error, 'refused', 'The job inputs could not be claimed.') }
  }

  async ack(artifactIds: readonly string[]): Promise<void> {
    try {
      const jobs = new Set<string>()
      for (const id of artifactIds) {
        const item = this.#artifacts.get(id)
        if (!item) continue
        this.#remove(this.#path(item))
        jobs.add(item.artifact.jobId)
        this.#forget(id)
      }
      for (const id of jobs) { this.#save(id); this.#removeEmpty(id) }
    } catch (error) { throw this.#error(error, 'worker-failure', 'The acknowledged artifacts could not be removed.') }
    finally { this.#arm() }
  }

  /** Counts removed files and job folders; the two storage subfolders are not counted. */
  sweep(): Promise<number> {
    if (this.#sweeping) return this.#sweeping
    this.#sweeping = this.#sweep().catch(error => { throw this.#error(error, 'worker-failure', 'Artifact cleanup could not finish.') }).finally(() => { this.#sweeping = undefined; this.#arm() })
    return this.#sweeping
  }

  async #sweep(): Promise<number> {
    if (!existsSync(this.#dir)) { this.#jobs.clear(); this.#artifacts.clear(); return 0 }
    this.#scan()
    let removed = 0
    for (const [jobId, job] of this.#jobs) {
      if (this.#busy.has(jobId)) continue
      const dir = this.jobDir(jobId)
      for (const kind of ['inputs', 'outputs'] as const) {
        const folder = join(dir, kind)
        if (!existsSync(folder)) continue
        directory(folder)
        for (const file of readdirSync(folder)) {
          const path = join(folder, file), entry = lstatSync(path)
          if (!entry.isFile()) continue
          const known = job.artifacts.get(file)
          if (known?.kind === kind) continue
          const createdAt = entry.mtimeMs
          if (file.endsWith('.part') || this.#now() >= createdAt + this.#retentionMs || (kind === 'inputs' && !job.claimed && this.#now() >= createdAt + ABANDONED_INPUT_MS)) {
            this.#remove(path); removed++; continue
          }
          const id = ARTIFACT_ID.test(file) && !this.#artifacts.has(file) ? file : randomUUID()
          const { bytes, sha256 } = await this.#hash(path)
          if (file !== id) renameSync(path, join(folder, id))
          this.#add(job, { kind, createdAt, artifact: { id, jobId, name: displayName(file), mime: 'application/octet-stream', bytes, sha256, expiresAt: createdAt + this.#retentionMs } })
        }
      }
      for (const item of [...job.artifacts.values()]) {
        const path = join(dir, item.kind, item.artifact.id)
        if (this.#now() >= item.artifact.expiresAt || (item.kind === 'inputs' && !job.claimed && this.#now() >= item.createdAt + ABANDONED_INPUT_MS)) {
          this.#remove(path); this.#forget(item.artifact.id); removed++
        } else if (!existsSync(path)) this.#forget(item.artifact.id)
      }
      for (const file of readdirSync(dir)) {
        if (file.endsWith('.index') && ARTIFACT_ID.test(file.slice(0, -6))) { this.#remove(join(dir, file)); removed++ }
      }
      this.#save(jobId)
      if (this.#removeEmpty(jobId)) removed++
    }
    return removed
  }

  #scan(): void {
    for (const jobId of readdirSync(this.#dir)) {
      if (!JOB_ID.test(jobId) || this.#jobs.has(jobId)) continue
      const dir = join(this.#dir, jobId), entry = lstatSync(dir)
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const job: Job = { createdAt: entry.mtimeMs, claimed: false, artifacts: new Map() }
      const index = join(dir, 'index.json')
      try {
        if (lstatSync(index).isFile()) {
          const value: unknown = JSON.parse(readFileSync(index, 'utf8'))
          if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SyntaxError('Invalid artifact index.')
          const saved = value as { createdAt?: unknown; claimed?: unknown; artifacts?: unknown }
          if (typeof saved.createdAt === 'number' && Number.isFinite(saved.createdAt)) job.createdAt = saved.createdAt
          job.claimed = saved.claimed === true
          if (Array.isArray(saved.artifacts)) for (const item of saved.artifacts) {
            if (stored(item, jobId) && !this.#artifacts.has(item.artifact.id)) {
              const { id, name, mime, bytes, sha256, expiresAt } = item.artifact
              this.#add(job, { kind: item.kind, createdAt: item.createdAt, artifact: { id, jobId, name, mime, bytes, sha256, expiresAt } })
            }
          }
        }
      } catch (error) { if (!missing(error) && !(error instanceof SyntaxError)) throw error }
      this.#jobs.set(jobId, job)
    }
  }

  #ensure(jobId: string): Job {
    this.#validateJobId(jobId)
    let job = this.#jobs.get(jobId)
    if (!job) {
      directory(join(this.#dir, jobId))
      job = { createdAt: this.#now(), claimed: false, artifacts: new Map() }
      this.#jobs.set(jobId, job)
    }
    return job
  }

  #validateJobId(jobId: string): void { if (!JOB_ID.test(jobId)) throw new ComputeError('refused', 'That job id is invalid.') }
  #job(jobId: string): Job {
    const job = this.#jobs.get(jobId)
    if (!job) throw new ComputeError('not-found', 'That job is unknown.')
    return job
  }
  #item(id: string): Stored {
    const item = this.#artifacts.get(id)
    if (!item) throw new ComputeError('not-found', 'That artifact is unknown.')
    const job = this.#job(item.artifact.jobId)
    if (this.#now() >= item.artifact.expiresAt || (item.kind === 'inputs' && !job.claimed && this.#now() >= item.createdAt + ABANDONED_INPUT_MS)) throw new ComputeError('expired', 'That artifact has expired.')
    return item
  }
  #path(item: Stored): string {
    const dir = this.jobDir(item.artifact.jobId), folder = join(dir, item.kind)
    const entry = lstatSync(folder)
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new ComputeError('not-found', 'That artifact is unavailable.')
    return join(folder, item.artifact.id)
  }
  #add(job: Job, item: Stored): void { job.artifacts.set(item.artifact.id, item); this.#artifacts.set(item.artifact.id, item) }
  #forget(id: string): void {
    const item = this.#artifacts.get(id)
    if (item) this.#jobs.get(item.artifact.jobId)?.artifacts.delete(id)
    this.#artifacts.delete(id)
  }
  #save(jobId: string): void {
    const job = this.#job(jobId), dir = this.jobDir(jobId), temporary = join(dir, `${randomUUID()}.index`)
    try {
      writeFileSync(temporary, JSON.stringify({ createdAt: job.createdAt, claimed: job.claimed, artifacts: [...job.artifacts.values()] }), { flag: 'wx', mode: 0o600 })
      renameSync(temporary, join(dir, 'index.json'))
    } finally { this.#remove(temporary) }
  }
  #remove(path: string): void { try { unlinkSync(path) } catch (error) { if (!missing(error)) throw new ComputeError('worker-failure', 'An artifact copy could not be removed.') } }
  #removeEmpty(jobId: string): boolean {
    try { return this.#prune(jobId) }
    catch (error) { throw this.#error(error, 'worker-failure', 'An empty job folder could not be removed.') }
  }
  #prune(jobId: string): boolean {
    const job = this.#jobs.get(jobId)
    if (!job || job.artifacts.size || this.#busy.has(jobId)) return false
    const dir = this.jobDir(jobId)
    for (const kind of ['inputs', 'outputs']) {
      const folder = join(dir, kind)
      if (existsSync(folder)) {
        const entry = lstatSync(folder)
        if (!entry.isDirectory() || entry.isSymbolicLink() || readdirSync(folder).length) return false
      }
    }
    if (readdirSync(dir).some(file => !['inputs', 'outputs', 'index.json'].includes(file))) return false
    for (const kind of ['inputs', 'outputs']) { const folder = join(dir, kind); if (existsSync(folder)) rmdirSync(folder) }
    this.#remove(join(dir, 'index.json'))
    rmdirSync(dir)
    this.#jobs.delete(jobId)
    return true
  }
  async #hash(path: string): Promise<{ bytes: number; sha256: string }> {
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of createReadStream('', { fd: openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)), autoClose: true })) { bytes += (chunk as Buffer).length; hash.update(chunk as Buffer) }
    return { bytes, sha256: hash.digest('hex') }
  }
  #begin(jobId: string): void { this.#busy.set(jobId, (this.#busy.get(jobId) ?? 0) + 1) }
  #end(jobId: string): void { const n = this.#busy.get(jobId)! - 1; if (n) this.#busy.set(jobId, n); else this.#busy.delete(jobId) }
  #arm(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    let next = Infinity
    for (const item of this.#artifacts.values()) next = Math.min(next, item.artifact.expiresAt)
    if (next !== Infinity) {
      this.#timer = setTimeout(() => { void this.sweep().catch(() => undefined) }, Math.max(1, next - this.#now()))
      this.#timer.unref()
    }
  }
  #error(error: unknown, code: 'refused' | 'not-found' | 'worker-failure', message: string): ComputeError {
    return error instanceof ComputeError ? error : new ComputeError(code, message)
  }
}
