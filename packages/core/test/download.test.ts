// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { discard, download, downloadAll, partial, sha256Of, type DownloadProgress } from '../src/download.js'

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) }
})
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, statfs: vi.fn(actual.statfs) }
})

let dir: string
let to: string
const url = 'https://huggingface.co/test/model/resolve/commit/model.gguf'
const content = 'abcdefghij'
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const mockFetch = (fn: (...args: Parameters<typeof fetch>) => Promise<Response>) => vi.fn(fn) as typeof fetch & ReturnType<typeof vi.fn>
const reply = (body = content, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers })
const read = (path = to) => fs.readFileSync(path, 'utf8')

beforeEach(() => {
  dir = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'alexia-download-'))
  to = join(dir, 'model.gguf')
})
afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }) })

test('streams a checked file, forwards authorization, and reports completion after rename', async () => {
  const progress: DownloadProgress[] = []
  const get = mockFetch(async (_, init) => {
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe('Bearer secret')
    expect(headers.get('range')).toBeNull()
    expect(headers.get('accept-encoding')).toBe('identity')
    return reply(content, 200, { 'content-length': '10' })
  })
  await download(url, to, { bytes: 10, sha256: digest(content).toUpperCase(), fetch: get, headers: { authorization: 'Bearer secret' }, onProgress: (p) => {
    progress.push(p)
    if (p.done === 10) expect(fs.existsSync(to)).toBe(true)
  } })
  expect(read()).toBe(content)
  expect(partial(to)).toEqual({ done: 10, part: 0 })
  expect(progress.at(-1)).toMatchObject({ done: 10, total: 10 })
  expect(await sha256Of(to)).toBe(digest(content))
})

test('resumes a validated range and hashes the existing prefix', async () => {
  fs.writeFileSync(`${to}.part`, 'abcd')
  const get = mockFetch(async (_, init) => {
    expect(new Headers(init?.headers).get('range')).toBe('bytes=4-')
    return reply('efghij', 206, { 'content-range': 'bytes 4-9/10', 'content-length': '6' })
  })
  await download(url, to, { bytes: 10, sha256: digest(content), fetch: get })
  expect(read()).toBe(content)
})

test('continues server-capped ranges with one checksum across all segments', async () => {
  fs.writeFileSync(`${to}.part`, 'ab')
  let n = 0
  const get = mockFetch(async (_, init) => {
    const start = n++ === 0 ? 2 : 6
    expect(new Headers(init?.headers).get('range')).toBe(`bytes=${start}-`)
    return reply(content.slice(start, start + 4), 206, { 'content-range': `bytes ${start}-${start + 3}/10` })
  })
  await download(url, to, { sha256: digest(content), fetch: get })
  expect(read()).toBe(content)
  expect(get).toHaveBeenCalledTimes(2)
})

test('an ignored range replaces the partial file and rechecks space for the whole file', async () => {
  fs.writeFileSync(`${to}.part`, 'xxxx')
  const get = mockFetch(async () => reply(content, 200, { 'content-length': '10' }))
  await download(url, to, { bytes: 10, sha256: digest(content), fetch: get })
  expect(read()).toBe(content)
  fs.unlinkSync(to)
  fs.writeFileSync(`${to}.part`, 'abcd')
  vi.spyOn(fsPromises, 'statfs').mockResolvedValue({ bavail: 8, bsize: 1 } as fs.StatsFs)
  await expect(download(url, to, { bytes: 10, fetch: get })).rejects.toMatchObject({ kind: 'disk' })
  expect(read(`${to}.part`)).toBe('abcd')
})

describe('untrustworthy range responses', () => {
  test.each([
    {}, { 'content-range': 'bytes 0-5/10' }, { 'content-range': 'bytes 4-10/10' },
    { 'content-range': 'bytes 4-9/*' }, { 'content-range': 'bytes 4-9/11' },
    { 'content-range': 'bytes 4-9/10', 'content-length': '7' },
    { 'content-range': 'bytes 4-3/10' }, { 'content-range': 'bytes 4-9/9007199254740993' },
  ])('rejects %j before modifying the prefix', async (headers) => {
    fs.writeFileSync(`${to}.part`, 'abcd')
    const get = mockFetch(async () => reply('efghij', 206, headers as Record<string, string>))
    await expect(download(url, to, { bytes: 10, fetch: get })).rejects.toMatchObject({ kind: 'length' })
    expect(read(`${to}.part`)).toBe('abcd')
    expect(fs.existsSync(to)).toBe(false)
  })
})

test('checks 206 ranges even without an existing partial file', async () => {
  await expect(download(url, to, { fetch: mockFetch(async () => reply('bc', 206, { 'content-range': 'bytes 1-2/3' })) })).rejects.toMatchObject({ kind: 'length' })
  expect(fs.existsSync(`${to}.part`)).toBe(false)
})

test.each(['-1', 'garbage', '1.5', '9007199254740993'])('rejects an invalid length %s', async (length) => {
  await expect(download(url, to, { fetch: mockFetch(async () => reply(content, 200, { 'content-length': length })) })).rejects.toMatchObject({ kind: 'length' })
})

test('rejects encoded bodies, mismatched full lengths, and unexpected statuses', async () => {
  await expect(download(url, to, { fetch: mockFetch(async () => reply(content, 200, { 'content-encoding': 'gzip' })) })).rejects.toMatchObject({ kind: 'http' })
  await expect(download(url, to, { bytes: 11, fetch: mockFetch(async () => reply(content, 200, { 'content-length': '10' })) })).rejects.toMatchObject({ kind: 'length' })
  await expect(download(url, to, { fetch: mockFetch(async () => new Response(null, { status: 204 })) })).rejects.toMatchObject({ kind: 'http' })
})

test('keeps a truncated file to resume, but removes an oversized file', async () => {
  await expect(download(url, to, { bytes: 10, fetch: mockFetch(async () => reply('abcd')) })).rejects.toMatchObject({ kind: 'length' })
  expect(read(`${to}.part`)).toBe('abcd')
  await expect(download(url, to, { bytes: 10, fetch: mockFetch(async () => reply(content + 'k')) })).rejects.toMatchObject({ kind: 'length' })
  expect(fs.existsSync(`${to}.part`)).toBe(false)
  expect(fs.existsSync(to)).toBe(false)
})

test('a bad checksum removes the partial file; a complete partial verifies without fetching', async () => {
  const get = mockFetch(async () => reply('xxxxxxxxxx'))
  await expect(download(url, to, { bytes: 10, sha256: digest(content), fetch: get })).rejects.toMatchObject({ kind: 'hash' })
  expect(fs.existsSync(`${to}.part`)).toBe(false)
  fs.writeFileSync(`${to}.part`, content)
  await download(url, to, { bytes: 10, sha256: digest(content), fetch: get })
  expect(get).toHaveBeenCalledTimes(1)
  expect(read()).toBe(content)
})

test('verifies an installed file on every install and rejects same-sized corruption', async () => {
  const get = mockFetch(async () => reply(content))
  fs.writeFileSync(to, content)
  await downloadAll([{ url, to, bytes: 10, sha256: digest(content) }], { fetch: get })
  expect(get).not.toHaveBeenCalled()
  fs.writeFileSync(to, 'xxxxxxxxxx')
  await expect(downloadAll([{ url, to, bytes: 10, sha256: digest(content) }], { fetch: get })).rejects.toMatchObject({ kind: 'hash' })
  expect(fs.existsSync(to)).toBe(false)
  expect(get).not.toHaveBeenCalled()
})

test('supports empty files and replaces wrong-sized installed files and oversized partials', async () => {
  await download(url, to, { bytes: 0, sha256: digest(''), fetch: mockFetch(async () => reply('', 200, { 'content-length': '0' })) })
  expect(read()).toBe('')
  fs.writeFileSync(`${to}.part`, content.repeat(2))
  await download(url, to, { bytes: 10, fetch: mockFetch(async (_, init) => {
    expect(new Headers(init?.headers).get('range')).toBeNull()
    return reply()
  }) })
  expect(read()).toBe(content)
})

test('416 finalizes a complete unknown-size partial after verifying its checksum', async () => {
  fs.writeFileSync(`${to}.part`, content)
  await download(url, to, { sha256: digest(content), fetch: mockFetch(async () => reply('', 416, { 'content-range': 'bytes */10' })) })
  expect(read()).toBe(content)
})

test('416 retries from zero once and never loops on a repeatedly refusing server', async () => {
  fs.writeFileSync(`${to}.part`, 'abcd')
  let calls = 0
  await download(url, to, { bytes: 10, fetch: mockFetch(async (_, init) => {
    if (calls++ === 0) return reply('', 416, { 'content-range': 'bytes */3' })
    expect(new Headers(init?.headers).get('range')).toBeNull()
    return reply()
  }) })
  expect(read()).toBe(content)
  fs.unlinkSync(to)
  fs.writeFileSync(`${to}.part`, 'ab')
  const get = mockFetch(async () => reply('', 416))
  await expect(download(url, to, { fetch: get })).rejects.toMatchObject({ kind: 'http' })
  expect(get).toHaveBeenCalledTimes(2)
})

test('checks disk before fetching and checks the combined size before fetching any shard', async () => {
  vi.spyOn(fsPromises, 'statfs').mockResolvedValue({ bavail: 15, bsize: 1 } as fs.StatsFs)
  const get = mockFetch(async () => reply())
  await expect(download(url, to, { bytes: 10, minFreeBytes: 6, fetch: get })).rejects.toMatchObject({ kind: 'disk' })
  await expect(downloadAll([{ url, to, bytes: 10 }, { url, to: join(dir, 'other.gguf'), bytes: 10 }], { fetch: get })).rejects.toMatchObject({ kind: 'disk' })
  expect(get).not.toHaveBeenCalled()
})

test('counts oversized partials as needing a complete replacement in the disk check', async () => {
  fs.writeFileSync(`${to}.part`, content.repeat(2))
  vi.spyOn(fsPromises, 'statfs').mockResolvedValue({ bavail: 9, bsize: 1 } as fs.StatsFs)
  const get = mockFetch(async () => reply())
  await expect(downloadAll([{ url, to, bytes: 10 }], { fetch: get })).rejects.toMatchObject({ kind: 'disk' })
  expect(get).not.toHaveBeenCalled()
})

test('aggregates resumed, reused and downloaded files in one progress bar', async () => {
  fs.writeFileSync(to, content)
  const second = join(dir, 'second.gguf')
  fs.writeFileSync(`${second}.part`, 'abcd')
  const progress: DownloadProgress[] = []
  await downloadAll([{ url, to, bytes: 10, sha256: digest(content) }, { url, to: second, bytes: 10, sha256: digest(content) }], {
    fetch: mockFetch(async () => reply('efghij', 206, { 'content-range': 'bytes 4-9/10' })), onProgress: (p) => progress.push(p),
  })
  expect(progress.some((p) => p.done === 14 && p.total === 20)).toBe(true)
  expect(progress.at(-1)).toMatchObject({ done: 20, total: 20 })
})

test('a noncooperative fetch times out or cancels and receives an aborted signal', async () => {
  let received: AbortSignal | undefined
  const get = mockFetch(async (_, init) => { received = init?.signal ?? undefined; return new Promise<Response>(() => {}) })
  await expect(download(url, to, { fetch: get, timeoutMs: 20 })).rejects.toMatchObject({ kind: 'timeout' })
  expect(received?.aborted).toBe(true)
  const controller = new AbortController()
  const task = download(url, to, { fetch: get, signal: controller.signal })
  setTimeout(() => controller.abort(), 20)
  await expect(task).rejects.toMatchObject({ kind: 'aborted' })
})

test.each(['timeout', 'aborted'])('a stalled stream ends with %s even when cancel hangs, retaining its prefix', async (kind) => {
  const controller = new AbortController()
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from('abcd')) }, cancel() { return new Promise<void>(() => {}) } })
  const task = download(url, to, { bytes: 10, signal: controller.signal, timeoutMs: kind === 'timeout' ? 35 : 1000, fetch: mockFetch(async () => new Response(body)) })
  if (kind === 'aborted') setTimeout(() => controller.abort(), 35)
  await expect(task).rejects.toMatchObject({ kind })
  expect(read(`${to}.part`)).toBe('abcd')
  expect(fs.existsSync(to)).toBe(false)
})

test('a live stream resets the inactivity timeout instead of timing out on total duration', async () => {
  let timer: ReturnType<typeof setInterval>
  const body = new ReadableStream<Uint8Array>({
    start(c) { let sent = 0; timer = setInterval(() => { c.enqueue(Buffer.from('ab')); if (++sent === 5) { clearInterval(timer); c.close() } }, 20) },
    cancel() { clearInterval(timer) },
  })
  await download(url, to, { bytes: 10, timeoutMs: 70, fetch: mockFetch(async () => new Response(body)) })
  expect(read()).toBe('ababababab')
})

test.each(['installed', 'complete partial', 'resume prefix'])('cancellation interrupts hashing the %s', async (kind) => {
  const path = kind === 'installed' ? to : `${to}.part`
  fs.writeFileSync(path, 'abcd')
  const controller = new AbortController()
  const realRead = fs.createReadStream
  vi.spyOn(fs, 'createReadStream').mockImplementation(((file, opts) => {
    if (String(file) !== path) return realRead(file, opts)
    if (typeof opts === 'object' && typeof opts.fd === 'number') fs.closeSync(opts.fd)
    const stream = new Readable({ read() {} })
    const signal = typeof opts === 'object' ? opts?.signal : undefined
    signal?.addEventListener('abort', () => stream.destroy(Object.assign(new Error('stopped'), { name: 'AbortError' })), { once: true })
    setTimeout(() => controller.abort(), 20)
    return stream as fs.ReadStream
  }) as typeof fs.createReadStream)
  const get = mockFetch(async () => reply('efghij', 206, { 'content-range': 'bytes 4-9/10' }))
  await expect(download(url, to, { bytes: kind === 'resume prefix' ? 10 : 4, sha256: digest('abcd'), signal: controller.signal, fetch: get })).rejects.toMatchObject({ kind: 'aborted' })
  expect(read(path)).toBe('abcd')
})

test('an already-aborted install never accepts an existing file', async () => {
  fs.writeFileSync(to, content)
  const signal = AbortSignal.abort()
  await expect(download(url, to, { signal })).rejects.toMatchObject({ kind: 'aborted' })
  await expect(downloadAll([], { signal })).rejects.toMatchObject({ kind: 'aborted' })
})

test.each(['destination', 'part', 'parent', 'dangling'])('rejects a %s symlink before reading, deleting, or fetching', async (kind) => {
  const victim = join(dir, 'victim')
  fs.writeFileSync(victim, 'safe')
  let target = to
  if (kind === 'parent') {
    fs.mkdirSync(join(dir, 'real'))
    fs.symlinkSync(join(dir, 'real'), join(dir, 'link'))
    target = join(dir, 'link', 'model.gguf')
  } else fs.symlinkSync(kind === 'dangling' ? join(dir, 'absent') : victim, kind === 'part' ? `${to}.part` : to)
  const get = mockFetch(async () => reply())
  await expect(download(url, target, { bytes: 10, fetch: get })).rejects.toMatchObject({ kind: 'disk' })
  await expect(downloadAll([{ url, to: target, bytes: 10 }], { fetch: get })).rejects.toMatchObject({ kind: 'disk' })
  expect(() => partial(target)).toThrow()
  expect(() => discard(target)).toThrow()
  expect(read(victim)).toBe('safe')
  expect(get).not.toHaveBeenCalled()
})

test('rejects symlinks when hashing and supports explicit partial discard', async () => {
  fs.writeFileSync(`${to}.part`, content)
  expect(partial(to)).toEqual({ done: 0, part: 10 })
  discard(to)
  expect(partial(to)).toEqual({ done: 0, part: 0 })
  fs.writeFileSync(join(dir, 'victim'), content)
  fs.symlinkSync(join(dir, 'victim'), to)
  await expect(sha256Of(to)).rejects.toMatchObject({ kind: 'disk' })
})

test('accepts the macOS system temp alias but rejects a managed symlink beneath it', async () => {
  const native = fs.mkdtempSync(join(tmpdir(), 'alexia-download-native-'))
  try {
    const target = join(native, 'model.gguf')
    await download(url, target, { bytes: 10, sha256: digest(content), fetch: mockFetch(async () => reply()) })
    expect(read(target)).toBe(content)
    fs.symlinkSync(fs.realpathSync(native), join(native, 'managed-link'))
    await expect(download(url, join(native, 'managed-link', 'other.gguf'), { fetch: mockFetch(async () => reply()) })).rejects.toMatchObject({ kind: 'disk' })
  } finally { fs.rmSync(native, { recursive: true, force: true }) }
})

test('native fetch resumes a real HTTP response and strips authorization on a CDN redirect', async () => {
  let cdnAuthorization: string | undefined
  const cdn = createServer((request, response) => {
    cdnAuthorization = request.headers.authorization
    expect(request.headers.range).toBe('bytes=4-')
    response.writeHead(206, { 'content-range': 'bytes 4-9/10', 'content-length': '6' })
    response.end('efghij')
  })
  await new Promise<void>((resolve) => cdn.listen(0, '127.0.0.1', resolve))
  const origin = createServer((request, response) => {
    expect(request.headers.authorization).toBe('Bearer secret')
    response.writeHead(302, { location: `http://127.0.0.1:${(cdn.address() as AddressInfo).port}/model.gguf` })
    response.end()
  })
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve))
  try {
    fs.writeFileSync(`${to}.part`, 'abcd')
    await download(`http://127.0.0.1:${(origin.address() as AddressInfo).port}/model.gguf`, to, { bytes: 10, sha256: digest(content), headers: { authorization: 'Bearer secret' } })
    expect(read()).toBe(content)
    expect(cdnAuthorization).toBeUndefined()
  } finally {
    origin.closeAllConnections(); cdn.closeAllConnections()
    await Promise.all([new Promise<void>((resolve) => origin.close(() => resolve())), new Promise<void>((resolve) => cdn.close(() => resolve()))])
  }
})

test('a real HTTP body stall times out with its persisted bytes available for a retry', async () => {
  let response: ServerResponse | undefined
  const server = createServer((_, res) => {
    response = res
    res.writeHead(200, { 'content-length': '10' })
    res.write('abcd')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await expect(download(`http://127.0.0.1:${(server.address() as AddressInfo).port}/model.gguf`, to, { timeoutMs: 100 })).rejects.toMatchObject({ kind: 'timeout' })
    expect(read(`${to}.part`)).toBe('abcd')
    expect(fs.existsSync(to)).toBe(false)
  } finally {
    response?.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('combined disk checks can be cancelled or time out even if statfs never settles', async () => {
  vi.spyOn(fsPromises, 'statfs').mockImplementation(() => new Promise<fs.StatsFs>(() => {}))
  const get = mockFetch(async () => reply())
  await expect(downloadAll([{ url, to, bytes: 10 }], { timeoutMs: 20, fetch: get })).rejects.toMatchObject({ kind: 'timeout' })
  const controller = new AbortController()
  const task = downloadAll([{ url, to, bytes: 10 }], { signal: controller.signal, fetch: get })
  setTimeout(() => controller.abort(), 20)
  await expect(task).rejects.toMatchObject({ kind: 'aborted' })
  expect(get).not.toHaveBeenCalled()
})

test('unknown-length streams maintain the free-space reserve as bytes arrive', async () => {
  vi.spyOn(fsPromises, 'statfs').mockResolvedValue({ bavail: 12, bsize: 1 } as fs.StatsFs)
  await expect(download(url, to, { minFreeBytes: 5, fetch: mockFetch(async () => reply()) })).rejects.toMatchObject({ kind: 'disk' })
  expect(fs.existsSync(to)).toBe(false)
})

test('filesystems without statfs still download; write failures report disk errors', async () => {
  vi.spyOn(fsPromises, 'statfs').mockRejectedValue(Object.assign(new Error('unsupported'), { code: 'ENOSYS' }))
  await download(url, to, { bytes: 10, fetch: mockFetch(async () => reply()) })
  expect(read()).toBe(content)
  fs.unlinkSync(to)
  const body = new ReadableStream<Uint8Array>({ start(c) { c.error(Object.assign(new Error('no space'), { code: 'ENOSPC' })) } })
  await expect(download(url, to, { fetch: mockFetch(async () => new Response(body)) })).rejects.toMatchObject({ kind: 'disk' })
})

test('invalid sizes, hashes and timeout settings fail before any I/O', async () => {
  const get = mockFetch(async () => reply())
  await expect(download(url, to, { bytes: -1, fetch: get })).rejects.toMatchObject({ kind: 'length' })
  await expect(download(url, to, { sha256: 'invalid', fetch: get })).rejects.toMatchObject({ kind: 'hash' })
  await expect(download(url, to, { timeoutMs: 0, fetch: get })).rejects.toMatchObject({ kind: 'timeout' })
  expect(get).not.toHaveBeenCalled()
})
