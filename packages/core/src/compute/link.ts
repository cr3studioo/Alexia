// SPDX-License-Identifier: AGPL-3.0-only
import { Beacon, localAddresses, localNetworks, neighbours, probe, type Announcement, type Found } from './beacon.js'
import type { Connect, ConnectHints } from './connect.js'
import type { Hosts } from './hosts.js'
import { isTailnet, type Tailscale, type TailscaleState } from './tailscale.js'
import type { Role } from './types.js'

/**
 * **How two paired computers keep finding each other**, at home and away.
 *
 * At home both are on one physical network and iroh connects them directly, over its address
 * there. Away, that address answers nobody — so each computer's Tailscale address is kept among
 * the places to try as well. iroh tries every address it knows at once and keeps the one that
 * answers best: at home the direct one wins, away only Tailscale's answers. Nothing switches by
 * hand, and no traffic is sent through Tailscale that could go direct.
 *
 * What this does, every little while:
 *
 * - tells the transport this computer's own Tailscale addresses, so a pairing says them;
 * - on the computer that does the computing, answers on its Tailscale address (and, while a
 *   pairing waits, on its local-network addresses) with where it can be dialled (`beacon.ts`);
 * - on the computer you talk to, finds each paired computer on Tailscale and adds its addresses
 *   there to what the transport knows — including for a computer paired before Tailscale was.
 */

export const LINK_EVERY_MS = 30_000

export interface LinkDeps {
  role: Role
  /** What is operated: the real thing, or a stand-in in a test. */
  tailscale: Pick<Tailscale, 'status' | 'install' | 'start' | 'login'>
  connect(): Connect | undefined
  hosts: Hosts
  hints: { load(hostId: string): ConnectHints | undefined; save(hostId: string, hints: ConnectHints): void }
  name(): string
  platform?: string
  /** For tests: where the beacon listens and is asked. */
  port?: number
}

export class Link {
  readonly beacon: Beacon
  private timer: NodeJS.Timeout | undefined
  private pairing = false
  private own: { endpointId: string; addresses: string[] } | undefined
  private last: TailscaleState | undefined
  private ticking: Promise<void> | undefined

  constructor(private readonly options: LinkDeps) {
    this.beacon = new Beacon(() => this.announcement(), options.port)
  }

  start(): void {
    void this.tick()
    this.timer = setInterval(() => { void this.tick() }, LINK_EVERY_MS)
    this.timer.unref()
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.beacon.close()
  }

  /** What it was built with — the API reads the Tailscale it operates through this. */
  deps(): LinkDeps {
    return this.options
  }

  /** The last Tailscale state seen, without asking again. */
  tailscale(): TailscaleState | undefined {
    return this.last
  }

  /** A direct pairing is open (compute role): answer on the local network too, until it settles. */
  async pairingOpen(open: boolean): Promise<void> {
    this.pairing = open
    await this.tick()
  }

  private announcement(): Announcement | undefined {
    if (!this.own || this.options.role !== 'compute') return undefined
    return {
      app: 'alexia', v: 1, name: this.options.name().slice(0, 60), role: this.options.role, platform: this.options.platform ?? process.platform,
      endpointId: this.own.endpointId, addresses: this.own.addresses.slice(0, 16), pairing: this.pairing,
    }
  }

  /** One round. Never throws: a computer with no Tailscale and no transport is a quiet round. */
  tick(): Promise<void> {
    this.ticking ??= this.round().catch(() => {}).finally(() => { this.ticking = undefined })
    return this.ticking
  }

  private async round(): Promise<void> {
    const deps = this.options
    const state = await deps.tailscale.status().catch(() => undefined)
    if (state) this.last = state
    const tailIps = state?.phase === 'running' ? state.self?.ips ?? [] : []
    const connect = deps.connect()
    if (connect) {
      await connect.ownAddresses?.(tailIps).catch(() => {})
      const id = await connect.identity().catch(() => undefined)
      const hints = await connect.ownHints?.().catch(() => undefined)
      if (id) this.own = { endpointId: id, addresses: [...(hints?.directAddresses ?? [])] }
    }
    if (deps.role === 'compute') {
      await this.beacon.listen(this.own ? [...tailIps, ...(this.pairing ? localAddresses() : [])] : [])
      return
    }
    if (state?.phase === 'running' && connect) await this.refresh(connect, state)
  }

  /**
   * Each paired computer that Tailscale can see: its addresses there, added to the places the
   * transport tries. Found by asking, and matched by endpoint id — a name on Tailscale proves
   * nothing, and iroh still checks the identity on every connection.
   */
  private async refresh(connect: Connect, state: TailscaleState): Promise<void> {
    const deps = this.options
    const hosts = deps.hosts.list()
    if (hosts.length === 0) return
    const online = state.peers.filter((peer) => peer.online).flatMap((peer) => peer.ips.filter((ip) => ip.includes('.')))
    const found = await probe(online, { tailnet: isTailnet, ...(deps.port !== undefined && { port: deps.port }) })
    for (const host of hosts) {
      const there = found.find((one) => one.endpointId === host.endpointId)
      if (!there) continue
      const saved = deps.hints.load(host.id)
      const merged = [...new Set([...(saved?.directAddresses ?? []), ...there.addresses.filter((address) => isTailnet(address.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')))])].slice(0, 16)
      if (saved && merged.length === (saved.directAddresses?.length ?? 0)) continue
      const next = { relayUrl: saved?.relayUrl ?? null, directAddresses: merged }
      deps.hints.save(host.id, next)
      await connect.hints?.(host.endpointId, next).catch(() => {})
    }
  }

  /**
   * The computers waiting to pair that this one can see: on Tailscale first, then the local
   * network. For the computer you talk to.
   */
  async discover(): Promise<Found[]> {
    const state = await this.options.tailscale.status().catch(() => undefined)
    if (state) this.last = state
    const tail = state?.phase === 'running' ? state.peers.filter((peer) => peer.online).flatMap((peer) => peer.ips.filter((ip) => ip.includes('.'))) : []
    const port = this.options.port !== undefined ? { port: this.options.port } : {}
    const [onTail, onLan] = await Promise.all([
      probe(tail, { tailnet: isTailnet, ...port }),
      probe(neighbours(localNetworks()), { timeoutMs: 800, ...port }),
    ])
    const seen = new Set<string>()
    return [...onLan, ...onTail].filter((one) => one.pairing && one.role === 'compute' && !seen.has(one.endpointId) && seen.add(one.endpointId))
  }
}
