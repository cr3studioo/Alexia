// SPDX-License-Identifier: AGPL-3.0-only
import { connectionLabel, stateSentence, THIS_HOST, type ExecutionTarget, type TargetStatus } from './compute.js'

export interface ModeTransition {
  id: string
  targetMode: string
  selectedModel?: { id: string; name: string }
  alternative?: { id: string; name: string }
  phase: 'waiting' | 'loading' | 'unloading' | 'ready' | 'failed'
  message: string
  picker?: boolean
  /** Where the chosen model runs, and where that stands, when it is on a paired computer. */
  target?: ExecutionTarget
  targetStatus?: TargetStatus
}

/**
 * The line under the switch for a model on a paired computer: the host, the model, how it is
 * reached, and its phase. A phase that is one of the shown states gets that state's own
 * sentence; anything else is core's line. Undefined for a model on this computer.
 */
export function targetLine(transition: ModeTransition, hostName?: (id: string) => string | undefined): string | undefined {
  const status = transition.targetStatus
  if (!status || status.target.hostId === THIS_HOST) return undefined
  const host = hostName?.(status.target.hostId) ?? 'Paired computer'
  const phase = stateSentence(status.phase, host)
    ?? (status.phase === 'ready' ? 'Ready'
      : status.phase === 'queued' && status.position !== undefined ? `Waiting in its queue, number ${String(status.position)}`
      : status.message || transition.message)
  return `${host} · ${transition.selectedModel?.name ?? status.target.modelId} · ${connectionLabel(status.connection)} — ${phase}`
}
export interface ModeState {
  setup: { mode: string }
  modeTransition?: ModeTransition
}

/** Confirmed controls stay put while the host loads, waits, or unloads. */
export function mountModeTransition(options: {
  hosts: HTMLElement[]
  read(): Promise<ModeState>
  mode(value: string): void
  blocked(value: boolean): void
  refresh(): Promise<void>
  picker(message: string, alternative?: ModeTransition['alternative']): void
  failed(message: string): void
  /** A paired host's name by its id, for the line about a model that runs there. */
  hostName?(id: string): string | undefined
}) {
  const lines = options.hosts.map((host) => {
    const line = document.createElement('p')
    line.className = 'hint mode-transition'
    line.setAttribute('role', 'status')
    line.setAttribute('aria-live', 'polite')
    line.hidden = true
    host.after(line)
    return line
  })
  let confirmed = 'combined'
  let ticket = 0
  let waitingForCommand = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let completed = ''
  let generation = 0
  let closed = false

  const say = (message: string, failed = false): void => {
    for (const line of lines) {
      line.textContent = message
      line.hidden = !message
      line.classList.toggle('refused', failed)
    }
  }
  const poll = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      const request = ticket
      void options.read().then((state) => observe(state, request)).catch(() => {
        if (closed || request !== ticket) return
        say('Waiting for Alexia to confirm the mode switch…')
        poll()
      })
    }, 1000)
  }
  const observe = async (state: ModeState, request = ticket): Promise<void> => {
    if (closed || request !== ticket) return
    waitingForCommand = false
    const mine = ++generation
    clearTimeout(timer)
    const transition = state.modeTransition
    confirmed = state.setup.mode
    options.mode(confirmed)
    const pending = transition !== undefined && !['ready', 'failed'].includes(transition.phase)
    options.blocked(pending)
    const line = transition === undefined ? '' : targetLine(transition, options.hostName) ?? transition.message
    say(line, transition?.phase === 'failed')
    if (pending) { poll(); return }
    await options.refresh()
    if (closed || request !== ticket || mine !== generation) return
    options.mode(confirmed)
    if (transition?.phase === 'failed' && completed !== transition.id) {
      completed = transition.id
      // A paired computer that cannot serve is answered by the picker, where it is still listed
      // with its reason. Nothing else is switched to.
      if (transition.picker || line !== transition.message) {
        if (transition.alternative) options.picker(line, transition.alternative)
        else options.picker(line)
      }
      else options.failed(line)
    }
  }

  return {
    observe,
    /** Start holding submissions immediately, before the command's HTTP response. */
    begin(): number {
      ticket++
      generation++
      waitingForCommand = true
      clearTimeout(timer)
      options.mode(confirmed)
      options.blocked(true)
      say('Switching…')
      return ticket
    },
    fail(message: string, request: number): void {
      if (closed || request !== ticket) return
      waitingForCommand = false
      options.blocked(false)
      options.mode(confirmed)
      say(message, true)
      options.failed(message)
    },
    /** A background state read cannot settle a command whose response is still pending. */
    sync(state: ModeState): Promise<void> { return waitingForCommand ? Promise.resolve() : observe(state) },
    close(): void { closed = true; generation++; clearTimeout(timer) },
  }
}
