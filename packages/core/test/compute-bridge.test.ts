// SPDX-License-Identifier: AGPL-3.0-only
import { request } from 'node:http'
import { afterEach, expect, test, vi } from 'vitest'
import { Bridge, REMOTE, remoteProvider } from '../src/compute/bridge.js'
import { encodeFrame } from '../src/compute/protocol.js'
import { ComputeError, qualify, type ComputeErrorCode, type TargetStatus } from '../src/compute/types.js'
import { chat, type ChatRequest, type Sign } from '../src/provider.js'
import { computeRig, RUNNER_SSE, stubRunner } from './fixtures/compute-host.js'

const closing: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closing.splice(0).reverse()) await close() })

async function rig(maxBodyBytes?: number) {
  const runner = await stubRunner()
  closing.push(runner.close)
  const rig = await computeRig(runner.baseUrl)
  closing.push(rig.close)
  const bridge = new Bridge({ controller: rig.controller, maxBodyBytes })
  closing.push(() => bridge.close())
  return { ...rig, runner, bridge, target: { hostId: rig.host.id, modelId: 'native/model' } }
}

const nativeRequest: ChatRequest = {
  model: 'native/model', maxTokens: 1234,
  messages: [
    { role: 'system', content: 'Keep all fields.' },
    { role: 'user', content: [{ type: 'text', text: 'Describe this.' }, { type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=' }] },
    { role: 'assistant', content: '', calls: [{ id: 'previous', name: 'inspect', arguments: '{"x":1}' }] },
    { role: 'tool', content: 'ok', callId: 'previous' },
  ],
  tools: [{ name: 'inspect', description: 'Inspect', parameters: { type: 'object', properties: { name: { type: 'string' } } } }],
}

test('the existing chat client gets identical text, reasoning signs, tool calls, usage and image inputs', async () => {
  const { runner, bridge, target, script } = await rig()
  const directSigns: Sign[] = [], remoteSigns: Sign[] = []
  const directDeltas: string[] = [], remoteDeltas: string[] = []
  const direct = await chat({ ...REMOTE, baseUrl: runner.baseUrl }, nativeRequest, (text) => directDeltas.push(text), undefined,
    { onSign: (sign) => directSigns.push(sign) })
  const remote = await chat({ ...REMOTE, prepare: () => bridge.prepare(target) }, nativeRequest, (text) => remoteDeltas.push(text), undefined,
    { onSign: (sign) => remoteSigns.push(sign) })
  expect(remote.message).toEqual(direct.message)
  expect(remote.message).toMatchObject({ content: 'Hello, 世界', calls: [{ id: 'call-1', name: 'inspect', arguments: '{"name":"a"}' }] })
  expect(remote.usage).toEqual({ in: 31, out: 17 })
  expect(remote.cut).toBe(direct.cut)
  expect(remoteSigns).toEqual(directSigns)
  expect(remoteSigns).toEqual(['reasoning', 'content', 'call'])
  expect(remoteDeltas).toEqual(directDeltas)
  expect(runner.received[1]).toEqual(runner.received[0])
  expect(script.opened.filter((item) => item.open.stream === 'infer')).toHaveLength(1)
  await vi.waitFor(() => expect(script.leases.size).toBe(0))
  expect(script.errors).toEqual([])
})

test('arbitrary parameters, image bytes and SSE pass through byte-for-byte across stream windows', async () => {
  const { runner, bridge, target } = await rig()
  const lease = await bridge.prepare(target)
  const body = Buffer.from(`{ "model":"native/model", "temperature":0.37,"top_p":0.91,"seed":42,"stop":["fin"],"custom":{"x":"世界"},"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,${'a'.repeat(200_000)}"}}]}] }`)
  const response = await fetch(`${lease.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${lease.key}` }, body })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
  expect(Buffer.from(await response.arrayBuffer())).toEqual(RUNNER_SSE)
  expect(runner.received[0]).toEqual(body)
  lease.release()
})

test('per-preparation bearer keys refuse missing, wrong and another lease’s keys with 401', async () => {
  const { bridge, target, script } = await rig()
  const first = await bridge.prepare(target), second = await bridge.prepare(target)
  expect(first.key).not.toBe(second.key)
  expect(first.baseUrl).not.toBe(second.baseUrl)
  expect(new URL(first.baseUrl).hostname).toBe('127.0.0.1')
  expect(Number(new URL(first.baseUrl).port)).toBeGreaterThan(0)
  for (const key of [undefined, 'wrong', second.key]) {
    const response = await fetch(`${first.baseUrl}/chat/completions`, { method: 'POST', body: '{}',
      headers: key === undefined ? {} : { authorization: `Bearer ${key}` } })
    expect(response.status).toBe(401)
  }
  expect(script.opened.filter((item) => item.open.stream === 'infer')).toEqual([])
  first.release()
  first.release()
  const response = await fetch(`${second.baseUrl}/chat/completions`, { method: 'POST', body: '{}', headers: { authorization: `Bearer ${second.key}` } })
  expect(response.status).toBe(200)
  await response.text()
  second.release()
})

test('release closes the last lease’s port and releases its host preparation exactly once', async () => {
  const { bridge, target, script } = await rig()
  const lease = await bridge.prepare(target)
  lease.release()
  lease.release()
  await expect(fetch(`${lease.baseUrl}/chat/completions`, { method: 'POST', body: '{}' })).rejects.toThrow()
  await vi.waitFor(() => expect(script.requests.filter((item) => item.method === 'release')).toHaveLength(1))
  expect(script.leases.size).toBe(0)
  const later = await bridge.prepare(target)
  const response = await fetch(`${later.baseUrl}/chat/completions`, { method: 'POST', body: '{}', headers: { authorization: `Bearer ${later.key}` } })
  expect(response.ok).toBe(true)
  await response.text()
  later.release()
})

test('an aborted answer resets the one infer stream and the runner observes the abort', async () => {
  const { bridge, runner, target, script } = await rig()
  runner.respond = (_body, response) => { response.write('data: {"choices":[{"delta":{"content":"begun"}}]}\n\n') }
  const abort = new AbortController()
  await expect(chat({ ...REMOTE, prepare: () => bridge.prepare(target) }, { ...nativeRequest, signal: abort.signal }, () => abort.abort())).rejects.toThrow()
  await vi.waitFor(() => expect(runner.aborted).toBe(1))
  expect(script.inferAborted).toBe(1)
  expect(script.opened.filter((item) => item.open.stream === 'infer')).toHaveLength(1)
})

test('a broken answer is dropped with one stream, no resubmission and no tool-call replay', async () => {
  const { bridge, runner, target, script } = await rig()
  runner.respond = (_body, response) => {
    response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"once","function":{"name":"inspect","arguments":"{"}}]}}]}\n\n')
    setTimeout(() => response.destroy(), 30)
  }
  const signs: Sign[] = []
  await expect(chat({ ...REMOTE, prepare: () => bridge.prepare(target) }, nativeRequest, undefined, undefined,
    { onSign: (sign) => signs.push(sign) })).rejects.toMatchObject({ trouble: 'dropped' })
  expect(signs).toEqual(['call'])
  expect(runner.received).toHaveLength(1)
  expect(script.opened.filter((item) => item.open.stream === 'infer')).toHaveLength(1)
  expect(script.opened.filter((item) => item.open.stream === 'job')).toEqual([])
})

test.each<[ComputeErrorCode, number]>([
  ['busy', 503], ['setup-required', 409], ['worker-failure', 502], ['incompatible-version', 426], ['unpaired', 401], ['refused', 500],
])('InferHead refusal %s becomes HTTP %i and keeps its message', async (code, status) => {
  const { bridge, target, script } = await rig()
  script.infer = async (_open, stream) => { stream.end(encodeFrame({ type: 'refused', failure: { code, message: 'Reason from host.' } })) }
  const lease = await bridge.prepare(target)
  const response = await fetch(`${lease.baseUrl}/chat/completions`, { method: 'POST', body: '{}', headers: { authorization: `Bearer ${lease.key}` } })
  expect(response.status).toBe(status)
  expect(await response.text()).toBe('Reason from host.')
  lease.release()
})

test('oversize, chunked and non-POST requests never open an infer stream', async () => {
  const { bridge, target, script } = await rig(4)
  const lease = await bridge.prepare(target)
  const headers = { authorization: `Bearer ${lease.key}` }
  expect((await fetch(`${lease.baseUrl}/chat/completions`, { method: 'POST', headers, body: '12345' })).status).toBe(413)
  expect((await fetch(`${lease.baseUrl}/chat/completions`, { method: 'GET', headers })).status).toBe(405)
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(`${lease.baseUrl}/chat/completions`, { method: 'POST', headers: { ...headers, 'transfer-encoding': 'chunked' } }, (response) => {
      response.resume(); response.once('end', () => resolve(response.statusCode))
    })
    req.on('error', reject)
    req.end('{}')
  })
  expect(status).toBe(411)
  expect(script.opened.filter((item) => item.open.stream === 'infer')).toEqual([])
  lease.release()
})

test('a refusal before a large body is consumed still reaches the HTTP client', async () => {
  const { bridge, target, script } = await rig()
  script.infer = async (_open, stream) => {
    stream.end(encodeFrame({ type: 'refused', failure: { code: 'busy', message: 'Another job is running.' } }))
  }
  const lease = await bridge.prepare(target)
  const response = await fetch(`${lease.baseUrl}/chat/completions`, { method: 'POST', body: Buffer.alloc(2 * 1024 * 1024, 65),
    headers: { authorization: `Bearer ${lease.key}` } })
  expect(response.status).toBe(503)
  expect(await response.text()).toBe('Another job is running.')
  expect(script.opened.filter((item) => item.open.stream === 'infer')).toHaveLength(1)
  lease.release()
})

test('select reports connecting, queued, loading and ready for the exact target', async () => {
  const { bridge, target, script } = await rig()
  script.prepare = (request) => ({ ...request.params, phase: 'queued', position: 2, message: 'Waiting.' })
  const statuses: TargetStatus[] = [], observed: TargetStatus[] = []
  const off = bridge.onStatus((status) => observed.push(status))
  const selecting = bridge.select(target, new AbortController().signal, (status) => statuses.push(status))
  await vi.waitFor(() => expect(bridge.status()?.phase).toBe('queued'))
  const lease = [...script.leases.values()][0]!
  script.say({ event: 'lease', lease: { ...lease, phase: 'loading', message: 'Loading.' } })
  script.say({ event: 'lease', lease: { ...lease, phase: 'ready', message: 'Ready.' } })
  await expect(selecting).resolves.toEqual({ id: 'native/model', name: 'Native model' })
  expect(statuses.map((status) => status.phase)).toEqual(['connecting', 'queued', 'loading', 'ready'])
  expect(statuses.every((status) => status.target.hostId === target.hostId)).toBe(true)
  expect(observed.at(-1)).toEqual(bridge.status())
  expect(bridge.status()?.connection).toBe('direct')
  off()
  await bridge.deselect()
  expect(script.leases.size).toBe(0)
  expect(bridge.status()).toBeUndefined()
})

test('select failure settles its phase, releases the host lease and preserves the pairing', async () => {
  const { bridge, target, script, hosts } = await rig()
  script.prepare = (request) => ({ ...request.params, phase: 'setup-required', message: 'Install the model.' })
  await expect(bridge.select(target, new AbortController().signal)).rejects.toMatchObject({ code: 'setup-required' })
  expect(bridge.status()).toMatchObject({ target, phase: 'setup-required', message: 'Install the model.' })
  expect(hosts.get(target.hostId)).toBeDefined()
  expect(script.leases.size).toBe(0)
})

test('cancelling queued preparation releases it without inference', async () => {
  const { bridge, target, script } = await rig()
  script.prepare = (request) => ({ ...request.params, phase: 'queued', message: 'Waiting.' })
  const abort = new AbortController()
  const result = bridge.select(target, abort.signal)
  const rejected = expect(result).rejects.toMatchObject({ code: 'cancelled' })
  await vi.waitFor(() => expect(bridge.status()?.phase).toBe('queued'))
  abort.abort()
  await rejected
  expect(script.leases.size).toBe(0)
  expect(script.opened.filter((item) => item.open.stream === 'infer')).toEqual([])
})

test('deselect cancels a pending selection and waits for its host release', async () => {
  const { bridge, target, script } = await rig()
  script.prepare = (request) => ({ ...request.params, phase: 'queued', message: 'Waiting.' })
  const selecting = bridge.select(target, new AbortController().signal)
  const rejected = expect(selecting).rejects.toMatchObject({ code: 'cancelled' })
  await vi.waitFor(() => expect(bridge.status()?.phase).toBe('queued'))
  await bridge.deselect()
  await rejected
  expect(script.leases.size).toBe(0)
  expect(bridge.status()).toBeUndefined()
})

test('close cancels queued preparation and releases its host lease', async () => {
  const { bridge, target, script } = await rig()
  script.prepare = (request) => ({ ...request.params, phase: 'queued', message: 'Waiting.' })
  const preparing = bridge.prepare(target)
  const rejected = expect(preparing).rejects.toMatchObject({ code: 'cancelled' })
  await vi.waitFor(() => expect(script.leases.size).toBe(1))
  await bridge.close()
  await rejected
  expect(script.leases.size).toBe(0)
})

test('concurrent preparations share the listener and closing one lease preserves the other', async () => {
  const { bridge, target, script } = await rig()
  const [first, second] = await Promise.all([bridge.prepare(target), bridge.prepare(target)])
  expect(new URL(first.baseUrl).origin).toBe(new URL(second.baseUrl).origin)
  first.release()
  const response = await fetch(`${second.baseUrl}/chat/completions`, { method: 'POST', body: '{}', headers: { authorization: `Bearer ${second.key}` } })
  expect(response.ok).toBe(true)
  await response.text()
  expect(script.leases.size).toBe(1)
  second.release()
})

test('deselect releases only the selection and an in-flight answer finishes', async () => {
  const { bridge, target, script, runner } = await rig()
  let finish!: () => void
  runner.respond = (_body, response) => {
    response.write('data: {"choices":[{"delta":{"content":"started"}}]}\n\n')
    finish = () => response.end('data: {"choices":[{"delta":{"content":" done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  }
  await bridge.select(target, new AbortController().signal)
  const delta = vi.fn()
  const answer = chat({ ...REMOTE, prepare: () => bridge.prepare(target) }, nativeRequest, delta)
  await vi.waitFor(() => expect(delta).toHaveBeenCalledWith('started'))
  await bridge.deselect()
  expect(script.leases.size).toBe(1)
  expect(runner.aborted).toBe(0)
  finish()
  await expect(answer).resolves.toMatchObject({ message: { content: 'started done' } })
  await vi.waitFor(() => expect(script.leases.size).toBe(0))
})

test('each request re-prepares after a released idle selection; remoteProvider parses the catalog target', async () => {
  const { bridge, target, script } = await rig()
  await bridge.select(target, new AbortController().signal)
  const selected = [...script.leases.values()][0]!
  script.leases.delete(selected.leaseId)
  script.say({ event: 'lease', lease: { ...selected, phase: 'released', message: 'Stopped while idle.' } })
  const provider = remoteProvider(bridge)
  expect(provider).toMatchObject(REMOTE)
  const prepared = await provider.prepare!(qualify(target))
  expect(typeof prepared).toBe('object')
  expect(prepared).toMatchObject({ model: 'native/model' })
  expect(script.requests.filter((item) => item.method === 'prepare')).toHaveLength(2)
  if (typeof prepared !== 'string') prepared.release?.()
})

test('an offline preparation reaches chat as unreachable and never selects another host', async () => {
  const { bridge, target, b, hosts } = await rig()
  await b.close()
  await expect(chat({ ...REMOTE, prepare: () => bridge.prepare(target) }, nativeRequest)).rejects.toMatchObject({ trouble: 'unreachable' })
  expect(hosts.get(target.hostId)).toBeDefined()
  await expect(bridge.prepare({ hostId: 'this', modelId: 'native/model' })).rejects.toBeInstanceOf(ComputeError)
})

test('close resets an active answer, releases all leases and closes the bridge', async () => {
  const { bridge, target, runner, script } = await rig()
  runner.respond = (_body, response) => { response.write(': started\n\n') }
  const lease = await bridge.prepare(target)
  const response = await fetch(`${lease.baseUrl}/chat/completions`, { method: 'POST', body: '{}', headers: { authorization: `Bearer ${lease.key}` } })
  const body = response.text()
  const rejected = expect(body).rejects.toThrow()
  await bridge.close()
  await rejected
  await vi.waitFor(() => expect(runner.aborted).toBe(1))
  expect(script.leases.size).toBe(0)
  await expect(fetch(lease.baseUrl)).rejects.toThrow()
  await expect(bridge.prepare(target)).rejects.toMatchObject({ code: 'cancelled' })
})
