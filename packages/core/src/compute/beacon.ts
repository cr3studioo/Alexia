// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http'
import { networkInterfaces } from 'node:os'
import type { Role } from './types.js'

/**
 * **"Here is an Alexia, and this is where to reach it"** — how two computers find each other
 * without a server in between.
 *
 * The computer that does the computing answers one plain request on its private-network
 * (Tailscale) address, and while it is waiting to pair, on its local-network addresses too: its
 * name, role, endpoint id and the addresses its transport listens at. Nothing secret is said —
 * an endpoint id is a public key, and the pairing code is never in it. Trust is still only what
 * the pairing proves: what this says is a place to dial, nothing more.
 *
 * The other computer asks the computers it can see: the ones Tailscale lists, and the addresses
 * of its own local network.
 */

export const BEACON_PORT = 47219
export const BEACON_PATH = '/alexia/hello'

export interface Announcement {
  app: 'alexia'
  v: 1
  name: string
  role: Role
  platform: string
  endpointId: string
  /** `ip:port` the transport can be dialled at. */
  addresses: string[]
  /** Waiting for a pairing right now. */
  pairing: boolean
}

export interface Found extends Announcement {
  /** Where it answered from. */
  at: string
  /** Over Tailscale rather than the local network. */
  tailnet: boolean
}

const isAnnouncement = (value: unknown): value is Announcement => {
  const one = value as Partial<Announcement> | null
  return typeof one === 'object' && one !== null && one.app === 'alexia' && one.v === 1 && typeof one.name === 'string' && one.name.length <= 128 &&
    (one.role === 'compute' || one.role === 'interaction') && typeof one.platform === 'string' && typeof one.endpointId === 'string' &&
    /^[a-f0-9]{64}$/.test(one.endpointId) && Array.isArray(one.addresses) && one.addresses.length <= 16 &&
    one.addresses.every((a) => typeof a === 'string' && a.length <= 64) && typeof one.pairing === 'boolean'
}

/**
 * Answer on exactly these addresses. Bound per address — never on every interface — so the
 * local network only hears it while a pairing asks it to.
 */
export class Beacon {
  private servers = new Map<string, Server>()

  constructor(private readonly announce: () => Announcement | undefined, private readonly port = BEACON_PORT) {}

  /** Listen on these addresses and no others; addresses no longer listed stop. */
  async listen(ips: readonly string[]): Promise<void> {
    for (const [ip, server] of this.servers) {
      if (!ips.includes(ip)) {
        server.close()
        this.servers.delete(ip)
      }
    }
    for (const ip of ips) {
      if (this.servers.has(ip)) continue
      const server = createServer((request, response) => {
        const said = request.method === 'GET' && request.url === BEACON_PATH ? this.announce() : undefined
        if (!said) {
          response.writeHead(404)
          response.end()
          return
        }
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end(JSON.stringify(said))
      })
      const bound = await new Promise<boolean>((resolve) => {
        server.once('error', () => resolve(false))
        server.listen(this.port, ip, () => resolve(true))
      })
      if (bound) this.servers.set(ip, server)
    }
  }

  listening(): string[] {
    return [...this.servers.keys()]
  }

  close(): void {
    for (const server of this.servers.values()) server.close()
    this.servers.clear()
  }
}

/** Ask each address, at once, for an announcement. Silence and nonsense are just left out. */
export async function probe(ips: readonly string[], options: { timeoutMs?: number; port?: number; tailnet?: (ip: string) => boolean } = {}): Promise<Found[]> {
  const { timeoutMs = 1500, port = BEACON_PORT, tailnet = () => false } = options
  const asked = await Promise.all(ips.map(async (ip): Promise<Found | undefined> => {
    try {
      const host = ip.includes(':') ? `[${ip}]` : ip
      const answered = await fetch(`http://${host}:${String(port)}${BEACON_PATH}`, { signal: AbortSignal.timeout(timeoutMs) })
      if (!answered.ok) return undefined
      const said: unknown = await answered.json()
      return isAnnouncement(said) ? { ...said, at: ip, tailnet: tailnet(ip) } : undefined
    } catch {
      return undefined
    }
  }))
  return asked.filter((one): one is Found => one !== undefined)
}

/** This computer's own local-network IPv4 addresses: private ranges, not loopback, not Tailscale's. */
export function localAddresses(interfaces = networkInterfaces()): string[] {
  return localNetworks(interfaces).map((one) => one.address)
}

/** The same, with each one's netmask: how large the network it is on is. */
export function localNetworks(interfaces = networkInterfaces()): { address: string; netmask: string }[] {
  const out = new Map<string, string>()
  for (const list of Object.values(interfaces)) {
    for (const one of list ?? []) {
      if (one.family !== 'IPv4' || one.internal) continue
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(one.address)) out.set(one.address, one.netmask)
    }
  }
  return [...out].map(([address, netmask]) => ({ address, netmask }))
}

/** Most addresses looked at on one network: a /22. A larger network is looked at around this computer. */
export const MOST_NEIGHBOURS = 1022

const toInt = (ip: string): number => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0)
const toIp = (n: number): string => [24, 16, 8, 0].map((shift) => String(Math.floor(n / 2 ** shift) % 256)).join('.')

/**
 * Every other address of each local network this computer is on: where a computer at home would
 * be. As large as the network's own netmask says — a home router's /24, an office's /20 — but no
 * more than {@link MOST_NEIGHBOURS} addresses, nearest this computer's own first.
 */
export function neighbours(own: readonly (string | { address: string; netmask: string })[]): string[] {
  const out: string[] = []
  for (const entry of own) {
    const { address, netmask } = typeof entry === 'string' ? { address: entry, netmask: '255.255.255.0' } : entry
    const ip = toInt(address)
    const mask = toInt(netmask)
    const size = 2 ** 32 - mask
    const base = ip - (ip % size)
    const hosts: number[] = []
    for (let n = base + 1; n < base + size - 1; n++) if (n !== ip) hosts.push(n)
    hosts.sort((a, b) => Math.abs(a - ip) - Math.abs(b - ip))
    out.push(...hosts.slice(0, MOST_NEIGHBOURS).map(toIp))
  }
  return [...new Set(out)]
}
