// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto'
import { CORE } from '../secrets.js'
import type { Store } from '../store.js'
import { TARGET_KEY } from './target.js'
import { ComputeError, isHostId, migrateSelection, type PairedHost, type Role } from './types.js'

export const HOSTS_KEY = 'compute_hosts'

export function mintHostId(random: (bytes: number) => Uint8Array = randomBytes): string {
  const bytes = random(12)
  if (bytes.length !== 12) throw new Error('A host id needs twelve random bytes.')
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')
}

/** Public pairing records only; trust has already been proved by the sidecar. */
export class Hosts {
  private readonly listeners = new Set<() => void>()

  constructor(private readonly store: Pick<Store, 'kvGet' | 'kvSet'>, private readonly role: Role) {}

  list(): PairedHost[] {
    const saved = this.store.kvGet(CORE, HOSTS_KEY)
    return Array.isArray(saved) ? saved.flatMap((value) => { const host = readHost(value); return host ? [host] : [] }) : []
  }

  get(id: string): PairedHost | undefined { return this.list().find((host) => host.id === id) }
  byEndpoint(endpointId: string): PairedHost | undefined { return this.list().find((host) => host.endpointId === endpointId) }

  add(peer: Omit<PairedHost, 'id' | 'pairedAt'>, at: number = Date.now()): PairedHost {
    const all = this.list()
    if (this.role === 'compute' && all.length > 0) throw new ComputeError('refused', 'Unpair the current computer first.')
    const existing = all.find((host) => host.endpointId === peer.endpointId)
    if (existing) return existing
    let id = mintHostId()
    while (all.some((host) => host.id === id)) id = mintHostId()
    const host = readHost({ ...peer, id, pairedAt: at })
    if (!host) throw new ComputeError('refused', 'That is not a paired computer record.')
    this.write([...all, host])
    return { ...host }
  }

  touch(id: string, change: Partial<Pick<PairedHost, 'name' | 'lastSeenAt' | 'platform' | 'appVersion'>>): void {
    const all = this.list()
    const host = all.find((one) => one.id === id)
    if (!host) return
    const updated = {
      ...host,
      ...(change.name !== undefined && { name: change.name }),
      ...(change.lastSeenAt !== undefined && { lastSeenAt: change.lastSeenAt }),
      ...(change.platform !== undefined && { platform: change.platform }),
      ...(change.appVersion !== undefined && { appVersion: change.appVersion }),
    }
    if (Object.keys(updated).every((key) => updated[key as keyof PairedHost] === host[key as keyof PairedHost])) return
    this.write(all.map((one) => one.id === id ? updated : one))
  }

  remove(id: string): PairedHost | undefined {
    const all = this.list()
    const host = all.find((one) => one.id === id)
    if (!host) return undefined
    if (migrateSelection(this.store.kvGet(CORE, TARGET_KEY))?.hostId === id) {
      // null is a saved, cleared target: an absent key would migrate the old local choice again.
      this.store.kvSet(CORE, TARGET_KEY, null)
      const pin = this.store.kvGet(CORE, 'pins') as Record<string, unknown> | undefined | null
      if (pin && typeof pin === 'object' && !Array.isArray(pin)) {
        const kept = { ...pin }
        delete kept.model
        delete kept.order
        this.store.kvSet(CORE, 'pins', kept)
      }
    }
    this.write(all.filter((one) => one.id !== id))
    return host
  }

  allowlist(): string[] { return this.list().map((host) => host.endpointId) }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private write(hosts: PairedHost[]): void {
    this.store.kvSet(CORE, HOSTS_KEY, hosts)
    for (const listener of this.listeners) listener()
  }
}

function readHost(saved: unknown): PairedHost | undefined {
  if (typeof saved !== 'object' || saved === null) return undefined
  const host = saved as Partial<PairedHost>
  if (!isHostId(host.id) || typeof host.name !== 'string' || typeof host.endpointId !== 'string' || host.endpointId === '' ||
    (host.peerRole !== 'interaction' && host.peerRole !== 'compute') || typeof host.pairedAt !== 'number' || !Number.isFinite(host.pairedAt)) return undefined
  return {
    id: host.id, name: host.name, endpointId: host.endpointId, peerRole: host.peerRole, pairedAt: host.pairedAt,
    ...(typeof host.lastSeenAt === 'number' && Number.isFinite(host.lastSeenAt) && { lastSeenAt: host.lastSeenAt }),
    ...(typeof host.platform === 'string' && { platform: host.platform }),
    ...(typeof host.appVersion === 'string' && { appVersion: host.appVersion }),
  }
}
