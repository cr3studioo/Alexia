// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Beacon, neighbours, probe, type Announcement } from '../src/compute/beacon.js'
import { hintStore } from '../src/compute/api.js'
import { HOSTS_KEY } from '../src/compute/hosts.js'
import { ROLE_KEY } from '../src/compute/role.js'
import { computeServe } from '../src/compute/service.js'
import { noShell } from '../src/compute/shell.js'
import { candidates, isTailnet, parseStatus, Tailscale, type TailscaleState } from '../src/compute/tailscale.js'
import type { HostView, PairingStatus } from '../src/compute/types.js'
import { CORE, memorySecrets } from '../src/secrets.js'
import { serve } from '../src/serve.js'
import { Store } from '../src/store.js'
import { LAPTOP_MACHINE, STUDIO_MACHINE } from './fixtures/compute-acceptance.js'
import { noPolling } from './staged.js'

/**
 * **Two computers that find each other and pair with no server in between** — and keep finding
 * each other when one of them leaves home.
 *
 * The real thing end to end where it can be: two real sidecars, the real `serve()` and
 * `computeServe()`, no mailbox, no relay. Tailscale is the one stand-in — it reports this machine
 * as the other computer's private-network address — because a test cannot sign two computers in.
 */

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const temp = (name: string): string => {
  const root = mkdtempSync(join(tmpdir(), `alexia-direct-${name}-`))
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
  return root
}
const uiDir = join(import.meta.dirname, '..', '..', 'ui')
const binary = process.env.ALEXIA_CONNECT_TEST_BIN ?? join(import.meta.dirname, '..', '..', '..', 'connect', 'target', 'debug', process.platform === 'win32' ? 'alexia-connect.exe' : 'alexia-connect')

describe('Tailscale, as read', () => {
  const status = (over: object): string => JSON.stringify({ BackendState: 'Running', Self: { HostName: 'laptop', TailscaleIPs: ['100.101.1.2', 'fd7a:115c:a1e0::1'] },
    Peer: { a: { HostName: 'studio', OS: 'windows', TailscaleIPs: ['100.101.1.9'], Online: true }, b: { HostName: 'old-phone', OS: 'iOS', TailscaleIPs: ['100.64.0.5'], Online: false } }, ...over })

  test('running: who this is and who else is there', () => {
    const said = parseStatus(status({}))
    expect(said).toMatchObject({ phase: 'running', self: { name: 'laptop', ips: ['100.101.1.2', 'fd7a:115c:a1e0::1'] } })
    expect(said.peers).toEqual([{ name: 'studio', os: 'windows', ips: ['100.101.1.9'], online: true }, { name: 'old-phone', os: 'iOS', ips: ['100.64.0.5'], online: false }])
    expect(said.said).toMatch(/1 other computer is online/)
  })

  test('needing a sign-in gives the page — only an https one', () => {
    expect(parseStatus(status({ BackendState: 'NeedsLogin', AuthURL: 'https://login.tailscale.com/a/abc' }))).toMatchObject({ phase: 'needs-login', loginUrl: 'https://login.tailscale.com/a/abc' })
    expect(parseStatus(status({ BackendState: 'NeedsLogin', AuthURL: 'file:///etc/passwd' })).loginUrl).toBeUndefined()
    expect(parseStatus(status({ BackendState: 'Stopped' })).phase).toBe('stopped')
    expect(parseStatus('not json').phase).toBe('unavailable')
  })

  test('private-network addresses are told apart from every other kind', () => {
    for (const ip of ['100.64.0.1', '100.127.255.254', 'fd7a:115c:a1e0:ab12::1']) expect(isTailnet(ip)).toBe(true)
    for (const ip of ['100.63.0.1', '100.128.0.1', '192.168.1.5', '10.0.0.1', '127.0.0.1']) expect(isTailnet(ip)).toBe(false)
  })

  test('not installed: where it would be, and how it would be installed', async () => {
    const opened: string[] = []
    const ts = new Tailscale({ downloads: temp('dl'), platform: 'darwin', exists: () => false, open: (t) => opened.push(t),
      fetch: (async () => new Response('pkg bytes')) as unknown as typeof fetch })
    expect(candidates('darwin', { PATH: '/opt/homebrew/bin:/usr/bin' })).toEqual(['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/bin/tailscale'])
    expect(candidates('linux', { PATH: '' })).toEqual([])
    expect((await ts.status()).phase).toBe('not-installed')
    const installing = await ts.install()
    expect(installing.phase).toBe('installing')
    expect(opened[0]).toMatch(/Tailscale\.pkg$/)
    const linux = new Tailscale({ downloads: temp('dl2'), platform: 'linux', exists: () => false })
    expect((await linux.install()).instructions).toMatch(/install\.sh/)
  })

  test('signing in opens Tailscale’s own page and nothing else', async () => {
    const opened: string[] = []
    let calls = 0
    const ts = new Tailscale({
      downloads: temp('dl3'), platform: 'darwin', exists: () => true, open: (t) => opened.push(t),
      run: async (_file, args) => {
        if (args[0] === 'status') return { code: 1, stdout: ++calls < 2 ? JSON.stringify({ BackendState: 'NeedsLogin' }) : JSON.stringify({ BackendState: 'NeedsLogin', AuthURL: 'https://login.tailscale.com/a/x' }), stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    })
    const said = await ts.login()
    expect(opened).toEqual(['https://login.tailscale.com/a/x'])
    expect(said.said).toMatch(/same account on both computers/)
  })
})

describe('the announcement', () => {
  test('answers on the addresses it is given, says nothing secret, and is found', async () => {
    const port = 47_300 + Math.floor(Math.random() * 500)
    const said: Announcement = { app: 'alexia', v: 1, name: 'Studio', role: 'compute', platform: 'win32', endpointId: 'a'.repeat(64), addresses: ['100.101.1.9:50000'], pairing: true }
    const beacon = new Beacon(() => said, port)
    cleanups.push(() => beacon.close())
    await beacon.listen(['127.0.0.1'])
    expect(beacon.listening()).toEqual(['127.0.0.1'])
    const found = await probe(['127.0.0.1', '127.0.0.2'], { port, timeoutMs: 500 })
    expect(found).toEqual([{ ...said, at: '127.0.0.1', tailnet: false }])
    await beacon.listen([])
    expect(await probe(['127.0.0.1'], { port, timeoutMs: 500 })).toEqual([])
  })

  test('the local network to look on is as large as its netmask, nearest first, and bounded', () => {
    const near = neighbours(['192.168.1.20'])
    expect(near).toHaveLength(253)
    expect(near).not.toContain('192.168.1.20')
    expect(near.slice(0, 2)).toEqual(['192.168.1.19', '192.168.1.21'])
    // An office /20: the computer at the other end of it is looked at too, within the bound.
    const office = neighbours([{ address: '172.16.189.201', netmask: '255.255.240.0' }])
    expect(office).toHaveLength(1022)
    expect(office).toContain('172.16.188.10')
    expect(office).not.toContain('172.16.189.201')
  })
})

const client = (base: string, token: string) => async <T = Record<string, unknown>>(path: string, body?: unknown): Promise<{ status: number; body: T }> => {
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-alexia-token': token },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: (await response.json()) as T }
}

describe.runIf(existsSync(binary))('two computers, no server', () => {
  test('the host is found, paired by four words alone, and saved hints gain its private-network address', async () => {
    const port = 47_800 + Math.floor(Math.random() * 500)
    // Each side's Tailscale says the other computer is this machine. The studio says it is also
    // reachable at a private-network address, the one the laptop's hints should gain.
    const tailnet = (self: string, ips: string[]): Pick<Tailscale, 'status' | 'install' | 'start' | 'login'> => {
      const state: TailscaleState = { phase: 'running', said: 'Connected to Tailscale.', self: { name: self, ips }, peers: [{ name: 'other', os: 'test', ips: ['127.0.0.1'], online: true }] }
      return { status: async () => state, install: async () => state, start: async () => state, login: async () => state }
    }

    const studioRoot = temp('studio')
    const seeded = new Store(join(studioRoot, 'alexia.db'))
    seeded.kvSet(CORE, ROLE_KEY, 'compute')
    seeded.close()
    const service = await computeServe({
      dataDir: studioRoot, uiDir, secrets: memorySecrets(), binary, shell: noShell(), machine: async () => STUDIO_MACHINE,
      link: { tailscale: tailnet('studio', ['127.0.0.1', '100.100.7.7']), port },
    })
    cleanups.push(() => service.close())
    const there = client(service.url, service.token)
    const deskRoot = temp('desk')
    noPolling(deskRoot)
    const alexia = await serve({
      dataDir: deskRoot, uiDir, local: false, providers: [], secrets: memorySecrets(), pluginsDir: join(deskRoot, 'extensions'),
      modeTransitions: { available: () => true, machine: async () => LAPTOP_MACHINE },
      compute: { binary, name: () => 'Laptop', restart: () => {}, link: { tailscale: tailnet('laptop', []), port } },
    })
    cleanups.push(() => alexia.close())
    const here = client(alexia.url, alexia.token)

    // The studio waits with four words — no mailbox number, because there is no mailbox.
    const opened = await there<{ pairing: PairingStatus }>('/api/compute/pair/start', {})
    expect(opened.status).toBe(200)
    const code = opened.body.pairing.code!
    expect(code.split('-')).toHaveLength(4)

    // The laptop finds it — with no address typed — and pairs by the words alone.
    let found: { name: string; endpointId: string; addresses: string[] }[] = []
    await vi.waitFor(async () => {
      found = (await here<{ found: typeof found }>('/api/compute/discover')).body.found
      expect(found).toHaveLength(1)
    }, { timeout: 20_000, interval: 300 })
    const studio = found[0]!
    expect(studio.addresses.some((address) => address.startsWith('100.100.7.7:'))).toBe(true)
    // Without the list's choice, the code alone is not enough: there is nobody to dial.
    expect((await here('/api/compute/pair/start', { code })).status).toBe(400)
    const joined = await here<{ pairing: PairingStatus }>('/api/compute/pair/start', { code, target: { endpointId: studio.endpointId, addresses: studio.addresses } })
    expect(joined.status).toBe(200)
    let hostId = ''
    await vi.waitFor(async () => {
      const mine = (await here<{ pairing?: PairingStatus }>('/api/compute/pair')).body.pairing
      expect(mine).toMatchObject({ phase: 'paired' })
      hostId = mine!.hostId!
    }, { timeout: 30_000, interval: 200 })
    await vi.waitFor(async () => { expect((await there<{ pairing?: PairingStatus }>('/api/compute/pair')).body.pairing).toMatchObject({ phase: 'paired', peerName: 'Laptop' }) }, { timeout: 30_000, interval: 200 })
    expect(JSON.stringify(alexia.store.kvGet(CORE, HOSTS_KEY))).not.toContain(code)

    // And they talk, directly.
    await vi.waitFor(async () => {
      const [view] = (await here<{ hosts: HostView[] }>('/api/compute/hosts')).body.hosts
      expect(view).toMatchObject({ host: { id: hostId }, connection: 'direct' })
    }, { timeout: 30_000, interval: 300 })

    // The studio's private-network address is among the places the laptop will try — so it is
    // still found away from home, with nothing switched by hand.
    await here('/api/compute/tailscale', { action: 'start' })
    await vi.waitFor(() => {
      const saved = hintStore(alexia.store).load(hostId)
      expect(saved?.directAddresses?.some((address) => address.startsWith('100.100.7.7:'))).toBe(true)
    }, { timeout: 20_000, interval: 300 })
  }, 120_000)
})
