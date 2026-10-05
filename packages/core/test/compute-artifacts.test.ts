// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ABANDONED_INPUT_MS, Artifacts } from '../src/compute/artifacts.js'
import { ARTIFACT_ARG, type ArtifactPut } from '../src/compute/protocol.js'
import { ARTIFACT_RETENTION_MS, ComputeError } from '../src/compute/types.js'

const dirs: string[] = [], stores: Artifacts[] = []
const temp = (): string => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'compute-artifacts-test-'))); dirs.push(dir); return dir }
const sha256 = (bytes: string): string => createHash('sha256').update(bytes).digest('hex')
const meta = (jobId: string, bytes = 'input', name = 'input.txt'): ArtifactPut => ({ jobId, name, mime: 'text/plain', bytes: Buffer.byteLength(bytes), sha256: sha256(bytes) })
const store = (options: { dir?: string; retentionMs?: number; now?(): number } = {}): Artifacts => {
  const artifacts = new Artifacts({ ...options, dir: options.dir ?? join(temp(), 'jobs') })
  stores.push(artifacts)
  return artifacts
}
const text = async (bytes: Readable): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of bytes) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString()
}
const output = (bytes = 'output'): string => { const path = join(temp(), 'worker.txt'); writeFileSync(path, bytes); return path }

afterEach(async () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const artifacts of stores.splice(0)) await artifacts.sweep()
  vi.useRealTimers()
})

describe('compute artifacts', () => {
  test.each(['hash', 'short', 'long'] as const)('a %s mismatch is refused and leaves no file or registered job', async mismatch => {
    const dir = temp(), artifacts = store({ dir }), input = meta('job-1')
    if (mismatch === 'hash') input.sha256 = sha256('different')
    if (mismatch === 'short') input.bytes++
    if (mismatch === 'long') input.bytes--
    await expect(artifacts.put(input, Readable.from(['in', 'put']))).rejects.toMatchObject({ code: 'refused' })
    expect(readdirSync(dir)).toEqual([])
    expect(() => artifacts.jobDir('job-1')).toThrow(ComputeError)
  })

  test('input metadata and bytes contain no host path; only a worker resolves the staged input', async () => {
    const dir = temp(), artifacts = store({ dir, now: () => 1000 })
    const input = await artifacts.put(meta('job-1'), Readable.from(['in', 'put']))
    expect(input).toEqual({ ...meta('job-1'), id: expect.stringMatching(/^[a-f0-9-]{36}$/), expiresAt: 1000 + ARTIFACT_RETENTION_MS })
    expect(JSON.stringify(input)).not.toContain(dir)
    const args = { nested: [{ file: { [ARTIFACT_ARG]: input.id } }], untouched: 1 }
    const resolved = artifacts.resolve('job-1', args)
    expect(resolved).toEqual({ nested: [{ file: join(dir, 'job-1', 'inputs', input.id) }], untouched: 1 })
    expect(args.nested[0]!.file).toEqual({ [ARTIFACT_ARG]: input.id })
    expect(readFileSync((resolved.nested as { file: string }[])[0]!.file, 'utf8')).toBe('input')
    const opened = artifacts.open(input.id)
    expect(JSON.stringify(opened.artifact)).not.toContain(dir)
    expect(await text(opened.bytes)).toBe('input')
    input.name = 'changed'
    const again = artifacts.open(input.id)
    expect(again.artifact.name).toBe('input.txt')
    await text(again.bytes)
  })

  test('unknown jobs and artifacts never return paths or create directories', async () => {
    const dir = temp(), artifacts = store({ dir }), path = output()
    expect(() => artifacts.jobDir('unknown')).toThrow(ComputeError)
    expect(() => artifacts.resolve('unknown', {})).toThrow(ComputeError)
    expect(() => artifacts.open('unknown')).toThrow(ComputeError)
    await expect(artifacts.adopt('unknown', path)).rejects.toMatchObject({ code: 'not-found' })
    await artifacts.ack(['unknown'])
    expect(readdirSync(dir)).toEqual([])
    expect(existsSync(path)).toBe(true)
    for (const id of [posix.join('parent', 'child'), win32.join('parent', 'child'), '..', '']) {
      await expect(artifacts.put(meta(id), Readable.from(['input']))).rejects.toMatchObject({ code: 'refused' })
      expect(() => artifacts.claimed(id)).toThrow(ComputeError)
    }
    expect(readdirSync(dir)).toEqual([])
  })

  test('a job without inputs is enrolled by claimed before a worker can use its folder', () => {
    const dir = temp(), artifacts = store({ dir })
    artifacts.claimed('job-1')
    expect(artifacts.jobDir('job-1')).toBe(join(dir, 'job-1'))
    expect(JSON.parse(readFileSync(join(dir, 'job-1', 'index.json'), 'utf8'))).toMatchObject({ claimed: true, artifacts: [] })
  })

  test('every separator is stripped from input and output display names', async () => {
    const artifacts = store(), name = `parent${posix.sep}nested${win32.sep}result.txt`
    const input = await artifacts.put(meta('job-1', 'input', name), Readable.from(['input']))
    const adopted = await artifacts.adopt('job-1', output(), { name })
    expect(input.name).toBe('parentnestedresult.txt')
    expect(adopted.name).toBe('parentnestedresult.txt')
  })

  test('outputs are moved into storage, hashed, streamed from an offset and deleted on acknowledgment', async () => {
    const dir = temp(), artifacts = store({ dir, now: () => 1000 }), path = output('generated bytes')
    artifacts.claimed('job-1')
    const artifact = await artifacts.adopt('job-1', path, { name: 'answer.txt', mime: 'text/plain' })
    expect(existsSync(path)).toBe(false)
    expect(artifact).toMatchObject({ jobId: 'job-1', name: 'answer.txt', mime: 'text/plain', bytes: 15, sha256: sha256('generated bytes'), expiresAt: 1000 + ARTIFACT_RETENTION_MS })
    expect(JSON.stringify(artifact)).not.toContain(dir)
    const copy = join(dir, 'job-1', 'outputs', artifact.id)
    expect(existsSync(copy)).toBe(true)
    expect(await text(artifacts.open(artifact.id, 10).bytes)).toBe('bytes')
    expect(await text(artifacts.open(artifact.id, artifact.bytes).bytes)).toBe('')
    for (const offset of [-1, 1.5, 16, NaN]) expect(() => artifacts.open(artifact.id, offset)).toThrow(ComputeError)
    // The controller calls ack only after receiving and checking the complete transfer.
    expect(sha256(await text(artifacts.open(artifact.id).bytes))).toBe(artifact.sha256)
    await artifacts.ack([artifact.id, artifact.id, 'unknown'])
    expect(existsSync(copy)).toBe(false)
    expect(existsSync(join(dir, 'job-1'))).toBe(false)
    expect(() => artifacts.open(artifact.id)).toThrow(ComputeError)
    await artifacts.ack([artifact.id])
  })

  test('a worker may only resolve inputs of its own job', async () => {
    const artifacts = store(), input = await artifacts.put(meta('first'), Readable.from(['input']))
    artifacts.claimed('second')
    expect(() => artifacts.resolve('second', { file: { [ARTIFACT_ARG]: input.id } })).toThrow(ComputeError)
    const adopted = await artifacts.adopt('first', output())
    expect(() => artifacts.resolve('first', { file: { [ARTIFACT_ARG]: adopted.id } })).toThrow(ComputeError)
    expect(() => artifacts.resolve('first', { file: { [ARTIFACT_ARG]: input.id, extra: true } })).toThrow(ComputeError)
  })

  test('sweep removes a 24-hour-old artifact, an abandoned input and empty job folders', async () => {
    const dir = temp()
    let now = 1000
    const artifacts = store({ dir, now: () => now })
    artifacts.claimed('finished')
    const adopted = await artifacts.adopt('finished', output())
    now += ARTIFACT_RETENTION_MS - 1
    expect((await artifacts.sweep())).toBe(0)
    const beforeExpiry = artifacts.open(adopted.id)
    await text(beforeExpiry.bytes)
    const input = await artifacts.put(meta('abandoned'), Readable.from(['input']))
    mkdirSync(join(dir, 'empty'))
    now += ABANDONED_INPUT_MS
    expect(() => artifacts.open(adopted.id)).toThrow(ComputeError)
    expect(() => artifacts.open(input.id)).toThrow(ComputeError)
    expect(await artifacts.sweep()).toBe(5)
    expect(readdirSync(dir)).toEqual([])
    expect(await artifacts.sweep()).toBe(0)
  })

  test('claimed inputs survive the abandoned-input boundary and keep their claim after restart', async () => {
    const dir = temp()
    let now = 1000
    const artifacts = store({ dir, now: () => now }), input = await artifacts.put(meta('job-1'), Readable.from(['input']))
    artifacts.claimed('job-1')
    now += ABANDONED_INPUT_MS
    const restarted = store({ dir, now: () => now })
    expect(await restarted.sweep()).toBe(0)
    expect(await text(restarted.open(input.id).bytes)).toBe('input')
    now = input.expiresAt
    expect(await restarted.sweep()).toBe(2)
    expect(readdirSync(dir)).toEqual([])
  })

  test('restart recovers output metadata from the index and from scanning when it is missing', async () => {
    const dir = temp(), artifacts = store({ dir })
    artifacts.claimed('job-1')
    const artifact = await artifacts.adopt('job-1', output(), { name: 'saved.txt', mime: 'text/plain' })
    const indexed = store({ dir }), opened = indexed.open(artifact.id)
    expect(opened.artifact).toEqual(artifact)
    expect(await text(opened.bytes)).toBe('output')
    rmSync(join(dir, 'job-1', 'index.json'))
    const recovered = store({ dir })
    expect(await recovered.sweep()).toBe(0)
    const rebuilt = recovered.open(artifact.id)
    expect(rebuilt.artifact).toMatchObject({ id: artifact.id, bytes: artifact.bytes, sha256: artifact.sha256 })
    expect(await text(rebuilt.bytes)).toBe('output')
    expect(existsSync(join(dir, 'job-1', 'index.json'))).toBe(true)
  })

  test('a crash without an index leaves expired files and abandoned partial inputs sweep can remove', async () => {
    const dir = temp(), now = Date.now()
    const inputs = join(dir, 'abandoned', 'inputs'), outputs = join(dir, 'expired', 'outputs')
    mkdirSync(inputs, { recursive: true }); mkdirSync(outputs, { recursive: true })
    for (const [path, age] of [[join(inputs, 'orphan'), ABANDONED_INPUT_MS], [join(inputs, 'unfinished.part'), 0], [join(outputs, 'orphan'), ARTIFACT_RETENTION_MS]] as const) {
      writeFileSync(path, 'left by a crash')
      utimesSync(path, (now - age) / 1000, (now - age) / 1000)
    }
    mkdirSync(join(dir, 'empty', 'inputs'), { recursive: true })
    const artifacts = store({ dir, now: () => now + 1 })
    expect(await artifacts.sweep()).toBe(6)
    expect(readdirSync(dir)).toEqual([])
  })

  test.each(['null', '{invalid'])('a damaged index (%s) and interrupted index write are rebuilt and cleaned', async damaged => {
    const dir = temp(), artifacts = store({ dir })
    artifacts.claimed('job-1')
    const artifact = await artifacts.adopt('job-1', output())
    writeFileSync(join(dir, 'job-1', 'index.json'), damaged)
    writeFileSync(join(dir, 'job-1', `${randomUUID()}.index`), 'interrupted write')
    const restarted = store({ dir })
    expect(await restarted.sweep()).toBe(1)
    expect(await text(restarted.open(artifact.id).bytes)).toBe('output')
    expect(readdirSync(join(dir, 'job-1')).sort()).toEqual(['index.json', 'outputs'])
  })

  test('cleanup removes stale index entries when a whole artifact subfolder was lost', async () => {
    const dir = temp(), artifacts = store({ dir })
    const input = await artifacts.put(meta('job-1'), Readable.from(['input']))
    rmSync(join(dir, 'job-1', 'inputs'), { recursive: true })
    expect(await artifacts.sweep()).toBe(1)
    expect(readdirSync(dir)).toEqual([])
    expect(() => artifacts.open(input.id)).toThrow(ComputeError)
  })

  test('aborting a transfer cleans its partial file and refuses it with a path-free error', async () => {
    const dir = temp(), artifacts = store({ dir }), cancel = new AbortController(), bytes = new PassThrough()
    const put = artifacts.put(meta('job-1'), bytes, cancel.signal)
    bytes.write('in')
    cancel.abort()
    await expect(put).rejects.toMatchObject({ code: 'cancelled' })
    expect(readdirSync(dir)).toEqual([])
    await expect(artifacts.put(meta('job-1'), Readable.from(['input']), AbortSignal.abort())).rejects.toMatchObject({ code: 'cancelled' })
    expect(readdirSync(dir)).toEqual([])
  })

  test('stream and filesystem failures do not expose host paths', async () => {
    const dir = temp(), artifacts = store({ dir }), bytes = new Readable({ read() { this.destroy(new Error(`failed in ${dir}`)) } })
    await expect(artifacts.put(meta('job-1'), bytes)).rejects.toMatchObject({ code: 'refused', message: 'The input could not be stored.' })
    artifacts.claimed('job-1')
    await expect(artifacts.adopt('job-1', join(dir, 'missing'))).rejects.toMatchObject({ code: 'worker-failure', message: 'The output could not be stored.' })
    const input = await artifacts.put(meta('job-1'), Readable.from(['input']))
    rmSync(join(dir, 'job-1', 'inputs', input.id))
    expect(() => artifacts.open(input.id)).toThrow('That artifact is unavailable.')
    expect(() => artifacts.resolve('job-1', { file: { [ARTIFACT_ARG]: input.id } })).toThrow('That input is unavailable.')
  })

  test('linked job folders, storage subfolders and output files cannot escape storage', async () => {
    const dir = temp(), outside = temp(), artifacts = store({ dir }), path = join(outside, 'keep.txt')
    writeFileSync(path, 'keep')
    symlinkSync(outside, join(dir, 'linked'), 'dir')
    await expect(artifacts.put(meta('linked'), Readable.from(['input']))).rejects.toMatchObject({ code: 'refused' })
    expect(() => artifacts.jobDir('linked')).toThrow(ComputeError)
    artifacts.claimed('job-1')
    symlinkSync(outside, join(dir, 'job-1', 'inputs'), 'dir')
    await expect(artifacts.put(meta('job-1'), Readable.from(['input']))).rejects.toMatchObject({ code: 'refused' })
    const link = join(temp(), 'linked.txt')
    symlinkSync(path, link)
    await expect(artifacts.adopt('job-1', link)).rejects.toMatchObject({ code: 'refused' })
    expect(readdirSync(outside)).toEqual(['keep.txt'])
    expect(readFileSync(path, 'utf8')).toBe('keep')
  })

  test('one timer follows the earliest artifact expiry and no timer remains when empty', async () => {
    vi.useFakeTimers()
    const artifacts = store()
    expect(vi.getTimerCount()).toBe(0)
    const first = await artifacts.put(meta('first'), Readable.from(['input']))
    artifacts.claimed('first')
    expect(vi.getTimerCount()).toBe(1)
    await artifacts.put(meta('second'), Readable.from(['input']))
    artifacts.claimed('second')
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(ARTIFACT_RETENTION_MS - 1)
    expect(await text(artifacts.open(first.id).bytes)).toBe('input')
    await vi.advanceTimersByTimeAsync(1)
    await artifacts.sweep()
    expect(() => artifacts.open(first.id)).toThrow(ComputeError)
    expect(vi.getTimerCount()).toBe(0)
    artifacts.claimed('finished')
    await artifacts.adopt('finished', output())
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(ARTIFACT_RETENTION_MS)
    await artifacts.sweep()
    expect(vi.getTimerCount()).toBe(0)
  })
})
