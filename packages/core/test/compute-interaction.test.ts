// SPDX-License-Identifier: AGPL-3.0-only
import { ErrorCode } from '@alexia/protocol'
import { ProtocolError, type CallToolResult } from '@modelcontextprotocol/client'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, test, vi } from 'vitest'
import { hintStore, HINTS_KEY } from '../src/compute/api.js'
import { HOSTS_KEY } from '../src/compute/hosts.js'
import { chosenHostRefusal, interactionCompute, type InteractionOptions } from '../src/compute/interaction.js'
import { ComputeError, REMOTE_PROVIDER, type HostView, type PairedHost } from '../src/compute/types.js'
import type { Plugins } from '../src/plugins.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { serve } from '../src/serve.js'
import { Store } from '../src/store.js'
import { noPolling } from './staged.js'

/**
 * The one seam into `serve.ts`, on a computer with no sidecar: everything is still there, it
 * says it is not available, and nothing else in Alexia notices.
 */

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function temp(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `alexia-interaction-${name}-`))
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
  return root
}

/** A checkout with no sidecar built: the path names nothing. */
const noSidecar = (): void => { vi.stubEnv('ALEXIA_CONNECT_BIN', join(tmpdir(), 'alexia-connect-is-not-here')) }

const paired: PairedHost = { id: 'studio0000aa', name: 'Studio', endpointId: 'a'.repeat(64), peerRole: 'compute', pairedAt: 1 }

/** As much of `Plugins` as the seam uses: one worker that declares `demo.render`, and a directory per plugin. */
function fakePlugins(root: string) {
  const calls: { handle: string; role: string; args: Record<string, unknown> }[] = []
  const state = { hold: undefined as (() => void) | undefined, wait: false }
  const plugins = {
    computeWorkers: () => [{ handle: 'opaque-handle', operations: [{ cap: 'demo.render', summary: 'Render.' }], hooks: [] }],
    computeCall: async (handle: string, role: string, args: Record<string, unknown>): Promise<CallToolResult> => {
      calls.push({ handle, role, args })
      if (state.wait) await new Promise<void>((resolve) => { state.hold = resolve })
      return { content: [{ type: 'text', text: 'Rendered.' }], structuredContent: { text: 'Rendered.', files: [join(root, 'plugins', 'caller', 'out.png')] } }
    },
    ownDir: (id: string) => join(root, 'plugins', id),
  } as unknown as Plugins
  return { plugins, calls, state }
}

async function compute(root: string, more: Partial<InteractionOptions> = {}) {
  const store = new Store(':memory:')
  const fake = fakePlugins(root)
  const made = await interactionCompute({ store, dataDir: root, plugins: fake.plugins, busy: () => false, stop: async () => {}, restart: () => {}, ...more })
  cleanups.push(async () => { await made.close(); store.close() })
  return { store, ...fake, compute: made }
}

test('with no sidecar binary serve() starts, says compute is not available, and everything else answers', async () => {
  noSidecar()
  const root = temp('serve')
  noPolling(root)
  const alexia = await serve({ dataDir: root, uiDir: join(import.meta.dirname, '..', '..', 'ui'), local: false, providers: [], secrets: memorySecrets(), pluginsDir: join(root, 'extensions') })
  cleanups.push(() => alexia.close())
  const ask = async (path: string, body?: unknown) => {
    const response = await fetch(new URL(path, alexia.url), { method: body === undefined ? 'GET' : 'POST', headers: { 'x-alexia-token': alexia.token, 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  const state = await ask('/api/state')
  expect(state.status).toBe(200)
  expect(state.body.compute).toEqual({ role: 'interaction', available: false, hosts: [] })
  expect((await ask('/api/compute/hosts')).body).toEqual({ hosts: [], selected: 'this', available: false })
  // Pairing says what is missing rather than failing some other way.
  expect(await ask('/api/compute/pair/start', { code: '7-alpha-bravo-charlie-delta' })).toMatchObject({ status: 409, body: { ok: false, code: 'setup-required' } })
  expect((await ask('/api/compute/pair')).body).toEqual({})
  expect((await ask('/api/compute/role')).body).toEqual({ role: 'interaction', active: 0 })
  // The local picker is the one it always was.
  expect((await ask('/api/local-models')).status).toBe(200)
  expect(await ask('/api/local-models?host=studio0000aa')).toMatchObject({ status: 404, body: { code: 'unpaired' } })
})

test('a computer paired earlier stays listed as offline when there is no sidecar, and its models are not offered', async () => {
  noSidecar()
  const root = temp('offline')
  const store = new Store(':memory:')
  store.kvSet(CORE, HOSTS_KEY, [paired])
  store.kvSet(CORE, 'local_target', { hostId: paired.id, modelId: 'llama/test' })
  const fake = fakePlugins(root)
  const made = await interactionCompute({ store, dataDir: root, plugins: fake.plugins, busy: () => false, stop: async () => {}, restart: () => {} })
  cleanups.push(async () => { await made.close(); store.close() })

  const state = made.api.state()
  expect(state.available).toBe(false)
  expect(state.hosts).toEqual([{ host: paired, connection: 'offline', failure: { code: 'offline', message: expect.any(String) } } satisfies HostView])
  expect(made.models()).toEqual([])
  expect(made.remote.status()).toBeUndefined()
  expect(made.remote.hostName(paired.id)).toBe('Studio')
  expect(made.remote.hostName('nobody000000')).toBeUndefined()
  expect(made.provider.id).toBe(REMOTE_PROVIDER)
  // The selected target is strict: it is refused as offline, and nothing else is tried in its place.
  await expect(made.provider.prepare!(`@${paired.id}/llama/test`)).rejects.toMatchObject({ code: 'offline' })
  await expect(made.remote.select({ hostId: paired.id, modelId: 'llama/test' }, new AbortController().signal)).rejects.toMatchObject({ code: 'offline' })
  // A plugin's operation goes where the person chose, and that computer cannot be reached: it does not run here instead.
  await expect(made.run('caller', { cap: 'demo.render' })).rejects.toMatchObject({ code: 'offline' })
  expect(fake.calls).toEqual([])
})

/**
 * The adapters run a job in their own process only when core says, with `-32050` and the
 * words *compute is not available*, that it has no compute seam, or with `-32601` that it has
 * no such method (T17). A paired computer that cannot serve must never be told that way.
 */
const takenAsNoCompute = (error: unknown): boolean => {
  const { code, message } = error as { code?: unknown; message?: unknown }
  return code === -32601 || (code === ErrorCode.CAPABILITY_NOT_AVAILABLE && /compute is not available/i.test(String(message ?? '')))
}

test('a paired computer that cannot serve is never told to a plugin as “no compute here”', async () => {
  noSidecar()
  const root = temp('refusal')
  const store = new Store(':memory:')
  store.kvSet(CORE, HOSTS_KEY, [paired])
  store.kvSet(CORE, 'local_target', { hostId: paired.id, modelId: 'llama/test' })
  const fake = fakePlugins(root)
  const made = await interactionCompute({ store, dataDir: root, plugins: fake.plugins, busy: () => false, stop: async () => {}, restart: () => {} })
  cleanups.push(async () => { await made.close(); store.close() })

  // The chosen computer is offline: the plugin hears that, as that, and runs nothing here.
  const offline = await made.run('caller', { cap: 'demo.render' }).catch((error: unknown) => error)
  expect(offline).toBeInstanceOf(ComputeError)
  expect(offline).toMatchObject({ code: 'offline' })
  expect(takenAsNoCompute(offline)).toBe(false)
  expect(fake.calls).toEqual([])

  // Whatever a paired computer's refusal says or carries — busy, not set up, unpaired, or the very
  // code and words that mean no compute — what leaves is a named state and not that pair.
  for (const failure of [
    new ComputeError('busy', 'That computer is busy.'),
    new ComputeError('setup-required', 'That computer is not ready to run this capability.'),
    new ComputeError('unpaired', 'That computer is not paired.'),
    new ComputeError('worker-failure', 'compute is not available for demo.render'),
    new ProtocolError(ErrorCode.CAPABILITY_NOT_AVAILABLE, 'compute is not available for demo.render'),
    new ProtocolError(-32601, 'alexia/compute/run is not an Alexia method'),
    new Error('Compute is not available'),
  ]) {
    const told = chosenHostRefusal(failure)
    expect(told).toBeInstanceOf(ComputeError)
    expect(takenAsNoCompute(told), failure.message).toBe(false)
    expect(told.message).not.toMatch(/compute is not available/i)
  }
  expect(chosenHostRefusal(new ComputeError('busy', 'That computer is busy.'))).toMatchObject({ code: 'busy', message: 'That computer is busy.' })

  // With this computer as the target the same call runs here, through the plugin's own operation.
  store.kvSet(CORE, 'local_target', { hostId: 'this', modelId: 'llama/local' })
  await expect(made.run('caller', { cap: 'demo.render' })).resolves.toMatchObject({ text: 'Rendered.' })
  expect(fake.calls).toHaveLength(1)
})

test.skipIf(process.platform === 'win32')('a sidecar that will not start is not a startup failure, and pairing is not offered', async () => {
  const root = temp('broken')
  const binary = join(root, 'alexia-connect')
  writeFileSync(binary, '#!/bin/sh\nexit 1\n')
  chmodSync(binary, 0o755)
  const store = new Store(':memory:')
  store.kvSet(CORE, HOSTS_KEY, [paired])
  const made = await interactionCompute({ store, dataDir: root, plugins: fakePlugins(root).plugins, busy: () => false, stop: async () => {}, restart: () => {}, binary })
  cleanups.push(async () => { await made.close(); store.close() })
  expect(made.api.state()).toMatchObject({ available: false, hosts: [{ connection: 'offline' }] })
})

test('with nothing paired the sidecar is not started at launch, even when it is installed', async () => {
  const root = temp('lazy')
  const binary = join(root, 'alexia-connect')
  // A file that is there. Had it been spawned, it would have failed and `available` would read false.
  writeFileSync(binary, 'not a program')
  const { compute: made } = await compute(root, { binary })
  expect(made.api.state()).toEqual({ role: 'interaction', available: true, hosts: [] })
})

test('a plugin’s operation runs on this computer when this computer is chosen, by capability', async () => {
  const root = temp('local')
  const { compute: made, calls, state } = await compute(root)
  state.wait = true
  const running = made.run('caller', { cap: 'demo.render', arguments: { scale: 2 } })
  await vi.waitFor(() => { expect(calls).toHaveLength(1) })
  // The worker was found by what it declares; the handle is whatever `Plugins` handed out.
  expect(calls[0]).toEqual({ handle: 'opaque-handle', role: 'run', args: { cap: 'demo.render', arguments: { scale: 2 } } })
  // While it runs, this computer is busy: a mode switch or a role switch waits for it.
  expect(made.active()).toBe(1)
  state.hold!()
  expect(await running).toEqual({ text: 'Rendered.', files: [join(root, 'plugins', 'caller', 'out.png')] })
  expect(made.active()).toBe(0)
  await expect(made.run('caller', { cap: 'demo.unknown' })).rejects.toMatchObject({ code: 'setup-required' })
})

test('a plugin may send a paired computer only a file it was given leave to read: its own, an attachment, or one in scope', async () => {
  noSidecar()
  const root = temp('inputs')
  const scoped = join(root, 'documents')
  const elsewhere = join(root, 'private')
  const own = join(root, 'plugins', 'caller')
  const attached = join(root, 'uploads')
  for (const dir of [scoped, elsewhere, own, attached]) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'file.txt'), 'x')
  }
  const store = new Store(':memory:')
  store.kvSet(CORE, HOSTS_KEY, [paired])
  store.kvSet(CORE, 'local_target', { hostId: paired.id, modelId: 'llama/test' })
  const fake = fakePlugins(root)
  const made = await interactionCompute({
    store, dataDir: root, plugins: fake.plugins, busy: () => false, stop: async () => {}, restart: () => {},
    roots: () => [{ uri: pathToFileURL(scoped).href }],
  })
  cleanups.push(async () => { await made.close(); store.close() })
  const send = (...paths: string[]) => made.run('caller', { cap: 'demo.render', inputs: paths.map((path) => ({ name: 'file.txt', path, mime: 'text/plain' })) })

  await expect(send(join(elsewhere, 'file.txt'))).rejects.toMatchObject({ code: 'refused' })
  await expect(send(join(scoped, '..', 'private', 'file.txt'))).rejects.toMatchObject({ code: 'refused' })
  await expect(send(join(root, 'plugins', 'another', 'file.txt'))).rejects.toMatchObject({ code: 'refused' })
  await expect(send(join(scoped, 'missing.txt'))).rejects.toMatchObject({ code: 'refused' })
  // These pass the check, and go on to find that the computer they are for cannot be reached.
  await expect(send(join(scoped, 'file.txt'), join(own, 'file.txt'), join(attached, 'file.txt'))).rejects.toMatchObject({ code: 'offline' })
  expect(fake.calls).toEqual([])

  // With this computer chosen no file is moved, so the plugin reads what it always could.
  store.kvSet(CORE, 'local_target', { hostId: 'this', modelId: 'llama/local' })
  await send(join(elsewhere, 'file.txt'))
  expect(fake.calls).toHaveLength(1)
})

test('a paired host’s address hints are kept between launches, and forgotten with it', () => {
  const store = new Store(':memory:')
  cleanups.push(() => store.close())
  const hints = hintStore(store)
  expect(hints.load('studio0000aa')).toBeUndefined()
  hints.save('studio0000aa', { relayUrl: 'https://relay.example.org', directAddresses: ['192.168.1.20:4433'] })
  hints.save('other0000000', { relayUrl: null, directAddresses: [] })
  // A second store over the same values reads what the first wrote: this is what a restart does.
  expect(hintStore(store).load('studio0000aa')).toEqual({ relayUrl: 'https://relay.example.org', directAddresses: ['192.168.1.20:4433'] })
  // Nothing learned is nothing to supply.
  expect(hints.load('other0000000')).toBeUndefined()
  hints.forget('studio0000aa')
  expect(hints.load('studio0000aa')).toBeUndefined()
  expect(store.kvGet(CORE, HINTS_KEY)).toEqual({ other0000000: { relayUrl: null, directAddresses: [] } })
})
