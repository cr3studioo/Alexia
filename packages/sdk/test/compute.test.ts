// SPDX-License-Identifier: Apache-2.0
import { COMPUTE_META, MCP_PINNED, type ManifestInput } from '@alexia/protocol'
import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { plugin, type AlexiaPlugin, type ComputeRequirement } from '../src/index.js'

/**
 * **A plugin as a compute worker** (`alexia_protocol` 13, `docs/spec/remote-compute.md` §4.3).
 *
 * The other end of the pipe here is the wire itself rather than a client library: what core
 * reads is a tool's `_meta` and a result's `structuredContent`, so that is what these look at.
 */

function folder(over: Partial<ManifestInput> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'alexia-sdk-compute-'))
  const manifest: ManifestInput = {
    manifest_version: 1,
    id: 'painter',
    name: 'Painter',
    summary: 'Makes pictures.',
    version: '0.1.0',
    license: 'Apache-2.0',
    entry: { run: 'node', args: ['index.js'] },
    alexia_protocol: 13,
    mcp_protocol: MCP_PINNED,
    provides: ['image.generate', 'image.render'],
    compute: {
      operations: [{ cap: 'image.render', summary: 'Render an image from a prepared workflow' }],
      hooks: ['setup', 'install', 'prepare', 'release'],
    },
    ...over,
  }
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest))
  return dir
}

type Message = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message: string } }
interface Tool { name: string; description?: string; annotations?: Record<string, unknown>; _meta?: Record<string, unknown> }

/** Core's end of the pipe, as far as these tests need one: ask, and answer what the plugin asks. */
async function connect(alexia: AlexiaPlugin, answer: (asked: Message, say: (message: Message) => void) => void = () => {}) {
  const [core, theirs] = InMemoryTransport.createLinkedPair()
  const waiting = new Map<number, (message: Message) => void>()
  const say = (message: Message): void => void core.send({ jsonrpc: '2.0', ...message } as JSONRPCMessage)
  core.onmessage = (raw) => {
    const message = raw as Message
    if (message.method === undefined && message.id !== undefined) waiting.get(message.id)?.(message)
    else answer(message, say)
  }
  await core.start()
  await alexia.server.connect(theirs)

  let next = 0
  const request = (method: string, params: Record<string, unknown> = {}): Promise<Message> =>
    new Promise((resolve) => {
      const id = ++next
      waiting.set(id, resolve)
      say({ id, method, params })
    })
  await request('initialize', { protocolVersion: MCP_PINNED, capabilities: {}, clientInfo: { name: 'core', version: '0' } })
  say({ method: 'notifications/initialized' })

  return {
    tools: async () => (await request('tools/list')).result!.tools as Tool[],
    call: async (name: string, args: Record<string, unknown> = {}, meta?: Record<string, unknown>) =>
      (await request('tools/call', { name, arguments: args, ...(meta && { _meta: meta }) })).result!,
  }
}

const bound = (tools: Tool[], binding: unknown): Tool | undefined =>
  tools.find((tool) => JSON.stringify(tool._meta?.[COMPUTE_META]) === JSON.stringify(binding))

test.each(['operation', 'install'])('%s progress is dispatched before its result closes the token', async (role) => {
  const alexia = plugin({ dir: folder() })
  const report = (_args: unknown, ctx: Parameters<AlexiaPlugin['progress']>[0]) => {
    alexia.progress(ctx, 1, 2, 'Rendering.')
    return Promise.resolve({ text: 'Rendered.' })
  }
  alexia.computeOperation('image.render', report)
  alexia.computeHooks({ install: async (requirementId, ctx) => { await report(requirementId, ctx) } })
  const heard: Message[] = []
  let acknowledge: (() => void) | undefined
  const core = await connect(alexia, (message, say) => {
    heard.push(message)
    if (message.method === 'ping') acknowledge = () => say({ id: message.id, result: {} })
  })
  try {
    let finished = false
    const result = core.call(role === 'operation' ? 'alexia_compute_image.render' : 'alexia_compute_install',
      role === 'operation' ? {} : { requirementId: 'model' }, { progressToken: 7 })
      .then((answer) => { finished = true; return answer })
    await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'))
    expect(heard.map((message) => message.method)).toEqual(['notifications/progress', 'ping'])
    expect(heard[0]!.params).toMatchObject({ progressToken: 7, progress: 1, total: 2, message: 'Rendering.' })
    expect(finished).toBe(false)
    acknowledge!()
    await result
    expect(finished).toBe(true)
  } finally {
    await alexia.server.close()
  }
})

test("an operation's tool carries COMPUTE_META, and calling it runs the handler", async () => {
  const alexia = plugin({ dir: folder() })
  const seen: Record<string, unknown>[] = []
  alexia.computeOperation('image.render', async (args) => {
    seen.push(args)
    return { text: 'Rendered.', files: [join('out', 'picture.png')] }
  })
  const core = await connect(alexia)

  const tool = bound(await core.tools(), { op: 'image.render' })
  expect(tool, 'no tool bound to the operation').toBeDefined()
  expect(tool!.name).toBe('alexia_compute_image.render')
  expect(tool!.description).toBe('Render an image from a prepared workflow')
  // Annotated, so a checker reading them does not report a tool that says nothing about itself.
  expect(tool!.annotations).toMatchObject({ readOnlyHint: false })

  // The arguments are the author's own shape, passed through whole.
  const args = { workflow: { steps: 20 }, source: join('in', 'photo.png') }
  const result = await core.call(tool!.name, args)
  expect(seen).toEqual([args])
  expect(result.isError).not.toBe(true)
  expect(result.structuredContent).toEqual({ text: 'Rendered.', files: [join('out', 'picture.png')] })
  expect(result.content).toEqual([{ type: 'text', text: 'Rendered.' }])
})

test('an operation that made nothing and said nothing still answers with a list of files', async () => {
  const alexia = plugin({ dir: folder() })
  alexia.computeOperation('image.render', async () => ({}))
  const core = await connect(alexia)
  const result = await core.call('alexia_compute_image.render')
  expect(result.structuredContent).toEqual({ files: [] })
})

test('an operation that throws is a failed result, not a dead plugin', async () => {
  const alexia = plugin({ dir: folder() })
  alexia.computeOperation('image.render', async () => {
    throw new Error('out of memory')
  })
  const core = await connect(alexia)
  const result = await core.call('alexia_compute_image.render')
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('out of memory')
})

test('the hooks are tools bound by name of hook, and each is handed what it needs', async () => {
  const alexia = plugin({ dir: folder() })
  const missing: ComputeRequirement = {
    id: 'weights',
    kind: 'model',
    title: 'The picture model',
    bytes: 6_500_000_000,
    action: 'install',
    blocks: ['image.render'],
  }
  const calls: string[] = []
  alexia.computeHooks({
    setup: async () => [missing],
    install: async (requirementId, ctx) => {
      calls.push(`install ${requirementId} ${typeof ctx.mcpReq.notify}`)
    },
    prepare: async (cap) => {
      calls.push(`prepare ${cap}`)
    },
    release: async () => {
      calls.push('release')
    },
  })
  const core = await connect(alexia)
  const tools = await core.tools()

  const hook = (name: string): Tool => {
    const tool = bound(tools, { hook: name })
    expect(tool, `no tool bound to the ${name} hook`).toBeDefined()
    expect(tool!.name).toBe(`alexia_compute_${name}`)
    return tool!
  }
  // Only `setup` may run before anybody agreed to anything, and it says so.
  expect(hook('setup').annotations).toMatchObject({ readOnlyHint: true })
  expect(hook('install').annotations).toMatchObject({ readOnlyHint: false })

  expect((await core.call(hook('setup').name)).structuredContent).toEqual({ requirements: [missing] })
  await core.call(hook('install').name, { requirementId: 'weights' })
  await core.call(hook('prepare').name, { cap: 'image.render' })
  await core.call(hook('release').name)
  expect(calls).toEqual(['install weights function', 'prepare image.render', 'release'])

  // An install that is not told what to install is refused before the handler hears of it.
  expect((await core.call(hook('install').name)).isError).toBe(true)
  expect(calls).toHaveLength(3)
})

test('only the hooks given are registered', async () => {
  const alexia = plugin({ dir: folder() })
  alexia.computeHooks({ release: async () => {} })
  const core = await connect(alexia)
  expect((await core.tools()).map((tool) => tool.name)).toEqual(['alexia_compute_release'])
})

test('a tool for something the manifest did not declare is refused where it is registered', () => {
  // Core finds a worker by its manifest, so an undeclared operation is one it would never call.
  const alexia = plugin({ dir: folder({ compute: { operations: [{ cap: 'image.render', summary: 'Render' }], hooks: ['setup'] } }) })
  expect(() => alexia.computeOperation('image.generate', async () => ({}))).toThrow(/compute\.operations/)
  expect(() => alexia.computeHooks({ release: async () => {} })).toThrow(/compute\.hooks/)

  const plain = plugin({ dir: folder({ compute: undefined }) })
  expect(() => plain.computeOperation('image.render', async () => ({}))).toThrow(/compute\.operations/)
})

test('compute.run asks core by capability, hears progress, and is handed the files', async () => {
  const alexia = plugin({ dir: folder() })
  const asked: Message[] = []
  await connect(alexia, (message, say) => {
    if (message.method !== 'alexia/compute/run') return
    asked.push(message)
    const progressToken = (message.params!._meta as { progressToken?: number } | undefined)?.progressToken
    say({ method: 'notifications/progress', params: { progressToken, progress: 3, total: 20, message: 'Sampling' } })
    // On a later turn, as a real job's answer is: MCP hands a notification to its listener a
    // tick after it arrives, and an answer in the same tick would close the token first.
    setImmediate(() => say({ id: message.id, result: { text: 'Rendered.', files: [join('own', 'picture.png')] } }))
  })

  const heard: unknown[] = []
  const inputs = [{ name: 'photo', path: join('in', 'photo.png'), mime: 'image/png' }]
  const result = await alexia.compute.run('image.render', { steps: 20 }, {
    inputs,
    onProgress: (progress, total, message) => heard.push([progress, total, message]),
  })

  expect(result).toEqual({ text: 'Rendered.', files: [join('own', 'picture.png')] })
  expect(heard).toEqual([[3, 20, 'Sampling']])
  expect(asked).toHaveLength(1)
  const { _meta, ...params } = asked[0]!.params!
  expect(params).toEqual({ cap: 'image.render', arguments: { steps: 20 }, inputs })
  expect(_meta).toBeDefined()
})

test('compute.run without a progress callback sends no token, and a refusal is an error', async () => {
  const alexia = plugin({ dir: folder() })
  const asked: Message[] = []
  await connect(alexia, (message, say) => {
    if (message.method !== 'alexia/compute/run') return
    asked.push(message)
    say({ id: message.id, error: { code: -32050, message: 'the paired computer is offline' } as never })
  })
  await expect(alexia.compute.run('image.render')).rejects.toThrow(/offline/)
  expect((asked[0]!.params!._meta as { progressToken?: unknown } | undefined)?.progressToken).toBeUndefined()
})

test('stopping a compute.run tells core, which is what cancels the job', async () => {
  const alexia = plugin({ dir: folder() })
  const stop = new AbortController()
  let running: number | undefined
  let told!: (message: Message) => void
  const cancelled = new Promise<Message>((resolve) => (told = resolve))
  await connect(alexia, (message) => {
    if (message.method === 'alexia/compute/run') {
      running = message.id
      stop.abort()
    }
    if (message.method === 'notifications/cancelled') told(message)
  })
  await expect(alexia.compute.run('image.render', {}, { signal: stop.signal })).rejects.toThrow()
  expect((await cancelled).params).toMatchObject({ requestId: running })
})
