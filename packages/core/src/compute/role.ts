// SPDX-License-Identifier: AGPL-3.0-only
import { setTimeout as delay } from 'node:timers/promises'
import { CORE } from '../secrets.js'
import type { Store } from '../store.js'
import { roleOf, type Role } from './types.js'

export const ROLE_KEY = 'compute_role'

export function readRole(store: Pick<Store, 'kvGet'>): Role {
  return roleOf(store.kvGet(CORE, ROLE_KEY))
}

export interface RoleSwitch {
  target: Role
  phase: 'waiting' | 'stopping' | 'restarting' | 'failed'
  message: string
  active?: number
}

export interface RoleSwitcherOptions {
  store: Pick<Store, 'kvGet' | 'kvSet'>
  active(): number
  cancelActive(): Promise<void>
  stop(): Promise<void>
  restart(): void
}

/** Finish or cancel work, stop its owners, then persist the role for the next launch. */
export class RoleSwitcher {
  private current?: RoleSwitch

  constructor(private readonly options: RoleSwitcherOptions) {}

  status(): RoleSwitch | undefined { return this.current && { ...this.current } }

  request(target: Role, options?: { cancel?: boolean }): { ok: boolean; note: string } {
    if (this.current && this.current.phase !== 'failed') return { ok: false, note: 'A role switch is already under way.' }
    if (target === readRole(this.options.store)) return { ok: false, note: 'This computer is already in that role.' }
    const transition: RoleSwitch = { target, phase: 'waiting', message: 'Switching after the current work finishes.' }
    this.current = transition
    void this.perform(transition, options?.cancel === true)
    return { ok: true, note: transition.message }
  }

  private async perform(transition: RoleSwitch, cancel: boolean): Promise<void> {
    try {
      if (cancel) {
        transition.message = 'Cancelling the current work before switching roles…'
        await this.options.cancelActive()
      }
      while (true) {
        const active = this.options.active()
        if (active === 0) break
        transition.active = active
        await delay(100)
      }
      delete transition.active
      transition.phase = 'stopping'
      transition.message = 'Stopping this computer’s services and workers…'
      await this.options.stop()
      this.options.store.kvSet(CORE, ROLE_KEY, transition.target)
      transition.phase = 'restarting'
      transition.message = `Restarting in the ${transition.target} role…`
      this.options.restart()
    } catch (error) {
      delete transition.active
      transition.phase = 'failed'
      transition.message = error instanceof Error ? error.message : String(error)
    }
  }
}
