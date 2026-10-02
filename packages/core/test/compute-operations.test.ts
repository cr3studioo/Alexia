// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { Operations } from '../src/compute/operations.js'
import { rememberTarget } from '../src/compute/target.js'
import type { JobCancel } from '../src/compute/protocol.js'
import { computeRig } from './fixtures/compute-host.js'

const closing: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closing.splice(0).reverse()) await close() })

async function rig() {
  const directory = await mkdtemp(join(tmpdir(), 'alexia-compute-operations-'))
  closing.push(() => rm(directory, { recursive: true, force: true }))
  const rig = await computeRig()
  closing.push(rig.close)
  const local = vi.fn<ConstructorParameters<typeof Operations>[0]['local']>(async () => ({
    content: [{ type: 'text' as const, text: 'Local result.' }], structuredContent: { text: 'Local result.', files: [join(directory, 'local.bin')] },
  }))
  const operations = new Operations({ ...rig, local })
  const request = { cap: 'demo.render', args: { prompt: 'Make this.' }, inputs: [], toDir: join(directory, 'outputs') }
  const selectRemote = () => rememberTarget(rig.store, { hostId: rig.host.id, modelId: 'native/model' })
  return { ...rig, directory, local, operations, request, selectRemote }
}

test('this computer uses the same local capability with unchanged arguments and cancellation signal', async () => {
  const { local, operations, request, directory, script } = await rig()
  const signal = new AbortController().signal
  const input = { name: 'input', path: join(directory, 'input.bin'), mime: 'application/octet-stream' }
  const args = { nested: { path: input.path }, count: 2 }
  await expect(operations.run({ ...request, args, inputs: [input] }, { signal })).resolves.toEqual({ text: 'Local result.', files: [join(directory, 'local.bin')] })
  expect(local).toHaveBeenCalledWith('demo.render', args, signal)
  expect(script.opened).toEqual([])
})

test('local MCP text is used when structuredContent is absent and an error result fails', async () => {
  const { operations, controller, jobs, store, request } = await rig()
  const text = new Operations({ controller, jobs, store, local: async () => ({ content: [{ type: 'text', text: 'First.' }, { type: 'text', text: 'Second.' }] }) })
  await expect(text.run(request, {})).resolves.toEqual({ text: 'First.\nSecond.', files: [] })
  const error = new Operations({ controller, jobs, store, local: async () => ({ isError: true, content: [{ type: 'text', text: 'Worker stopped.' }] }) })
  await expect(error.run(request, {})).rejects.toMatchObject({ code: 'worker-failure', message: 'Worker stopped.' })
  await expect(operations.run(request, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'cancelled' })
})

test('remote input paths are staged recursively and outputs are fetched, verified and acknowledged', async () => {
  const { operations, request, directory, script, selectRemote, local, jobs, host } = await rig()
  selectRemote()
  const inputPath = join(directory, 'approved.bin')
  const inputBytes = Buffer.alloc(200_000, 37)
  await writeFile(inputPath, inputBytes)
  const args = { file: inputPath, nested: [{ path: inputPath }], prompt: 'Make this.', option: 0.5 }
  const progress = vi.fn()
  const outputBytes = Buffer.alloc(300_000, 42)
  let outputId: string | undefined
  script.job = async (open, stream) => {
    const inputId = open.submit.inputs![0]!
    const input = script.artifacts.get(inputId)!
    expect(input.bytes).toEqual(inputBytes)
    expect(open.submit).toEqual({ jobId: input.artifact.jobId, cap: 'demo.render',
      arguments: { file: { $artifact: inputId }, nested: [{ path: { $artifact: inputId } }], prompt: 'Make this.', option: 0.5 }, inputs: [inputId] })
    script.jobEvent(stream, { type: 'progress', seq: 1, progress: { progress: 1, total: 2, message: 'Rendering.' } })
    script.jobEvent(stream, { type: 'output', seq: 2, output: { type: 'text', text: 'Made ' } })
    script.jobEvent(stream, { type: 'output', seq: 3, output: { type: 'text', text: 'it.' } })
    const artifact = script.output(open.submit.jobId, outputBytes, 'result.bin')
    outputId = artifact.id
    script.jobEvent(stream, { type: 'output', seq: 4, output: { type: 'artifact', artifact } })
    script.jobEvent(stream, { type: 'done', seq: 5, job: script.snapshot(open.submit.jobId, 'succeeded', [artifact]) })
    stream.end()
  }
  const result = await operations.run({ ...request, args, inputs: [{ name: 'approved.bin', path: inputPath, mime: 'application/octet-stream' }] }, { onProgress: progress })
  expect(result).toEqual({ text: 'Made it.', files: [join(request.toDir, 'result.bin')] })
  expect(await readFile(result.files[0]!)).toEqual(outputBytes)
  expect(progress).toHaveBeenCalledWith({ progress: 1, total: 2, message: 'Rendering.' })
  expect(script.requests).toContainEqual({ id: expect.any(Number), method: 'artifact.ack', params: { artifactIds: [outputId] } })
  expect(script.artifacts.has(outputId!)).toBe(false)
  expect(script.opened.map((item) => item.open.stream)).toEqual(['control', 'artifact', 'job', 'artifact'])
  expect(jobs.outstanding(host.id)).toEqual([])
  expect(local).not.toHaveBeenCalled()
  expect(args.file).toBe(inputPath)
  expect(args.nested[0]).toEqual({ path: inputPath })
  expect(script.errors).toEqual([])
})

test.each(['absent', 'unready'] as const)('a selected host with an %s capability fails setup-required without local fallback', async (kind) => {
  const { operations, request, script, selectRemote, local } = await rig()
  selectRemote()
  if (kind === 'absent') script.inventory.capabilities = []
  else script.inventory.capabilities[0]!.ready = false
  await expect(operations.run(request, {})).rejects.toMatchObject({ code: 'setup-required' })
  expect(script.opened.map((item) => item.open.stream)).toEqual(['control'])
  expect(local).not.toHaveBeenCalled()
})

test('an offline selected host never falls back to this computer', async () => {
  const { operations, request, selectRemote, local, b, hosts, host } = await rig()
  selectRemote()
  await b.close()
  await expect(operations.run(request, {})).rejects.toMatchObject({ code: 'offline' })
  expect(local).not.toHaveBeenCalled()
  expect(hosts.get(host.id)).toBeDefined()
})

test('cancellation reaches the submitted job and the operation rejects cancelled', async () => {
  const { operations, request, script, selectRemote, local } = await rig()
  selectRemote()
  let sawCancel = false
  script.job = async (open, stream, frames) => {
    script.jobEvent(stream, { type: 'state', seq: 1, job: script.snapshot(open.submit.jobId, 'running') })
    const cancel = await frames.next() as JobCancel
    sawCancel = cancel.type === 'cancel'
    script.jobEvent(stream, { type: 'done', seq: 2, job: script.snapshot(open.submit.jobId, 'cancelled') })
    stream.end()
  }
  const abort = new AbortController()
  const running = operations.run(request, { signal: abort.signal })
  const rejected = expect(running).rejects.toMatchObject({ code: 'cancelled' })
  await vi.waitFor(() => expect(script.opened.filter((item) => item.open.stream === 'job')).toHaveLength(1))
  abort.abort()
  await rejected
  expect(sawCancel).toBe(true)
  expect(local).not.toHaveBeenCalled()
  expect(script.opened.filter((item) => item.open.stream === 'job')).toHaveLength(1)
})

test.each(['failed', 'interrupted'] as const)('a %s operation keeps its failure and is never resubmitted', async (state) => {
  const { operations, request, script, selectRemote, local } = await rig()
  selectRemote()
  script.job = async (open, stream) => {
    script.jobEvent(stream, { type: 'done', seq: 1, job: { ...script.snapshot(open.submit.jobId, state),
      failure: { code: state === 'failed' ? 'worker-failure' : 'interrupted', message: 'The host stopped.' } } })
    stream.end()
  }
  await expect(operations.run(request, {})).rejects.toMatchObject({ code: state === 'failed' ? 'worker-failure' : 'interrupted', message: 'The host stopped.' })
  expect(script.opened.filter((item) => item.open.stream === 'job')).toHaveLength(1)
  expect(local).not.toHaveBeenCalled()
})

test('the selected host is captured once so changing the selection cannot move a running job', async () => {
  const { operations, request, script, selectRemote, local, store } = await rig()
  selectRemote()
  script.job = async (open, stream) => {
    rememberTarget(store, { hostId: 'this', modelId: 'another-model' })
    const artifact = script.output(open.submit.jobId, Buffer.from('done'))
    script.jobEvent(stream, { type: 'done', seq: 1, job: script.snapshot(open.submit.jobId, 'succeeded', [artifact]) })
    stream.end()
  }
  const result = await operations.run(request, {})
  expect(await readFile(result.files[0]!, 'utf8')).toBe('done')
  expect(local).not.toHaveBeenCalled()
  expect(script.opened.map((item) => item.open.stream)).toEqual(['control', 'job', 'artifact'])
})

test('an output from another job is refused before any fetch', async () => {
  const { operations, request, script, selectRemote } = await rig()
  selectRemote()
  script.job = async (open, stream) => {
    const artifact = script.output('someone-elses-job', Buffer.from('private'))
    script.jobEvent(stream, { type: 'done', seq: 1, job: script.snapshot(open.submit.jobId, 'succeeded', [artifact]) })
    stream.end()
  }
  await expect(operations.run(request, {})).rejects.toMatchObject({ code: 'refused' })
  expect(script.opened.map((item) => item.open.stream)).toEqual(['control', 'job'])
})

test('an unreadable input fails before submission and an output with a bad hash is not acknowledged', async () => {
  const { operations, request, script, selectRemote, directory } = await rig()
  selectRemote()
  await expect(operations.run({ ...request, inputs: [{ name: 'missing', path: join(directory, 'missing'), mime: 'text/plain' }] }, {})).rejects.toMatchObject({ code: 'refused' })
  expect(script.opened.map((item) => item.open.stream)).toEqual(['control'])
  script.job = async (open, stream) => {
    const artifact = script.output(open.submit.jobId, Buffer.from('bad'))
    artifact.sha256 = '0'.repeat(64)
    script.jobEvent(stream, { type: 'done', seq: 1, job: script.snapshot(open.submit.jobId, 'succeeded', [artifact]) })
    stream.end()
  }
  await expect(operations.run(request, {})).rejects.toMatchObject({ code: 'refused' })
  expect(script.requests.some((item) => item.method === 'artifact.ack')).toBe(false)
})
