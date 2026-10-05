// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The compute role's only page (`compute.html`): the pairing code, the one computer this one
 * works for, its queue, its own models, the way back to the interaction role, and *Close
 * window*. There is no chat here because there is no assistant behind it.
 *
 * Every block is one of `compute.ts`'s or the local-models view, against the same routes the
 * interaction computer's Settings uses. No Node in here, ever (invariant 6).
 */

import { mountHost, mountHostPicker, mountQueue, mountRole, mountServices, type QueueSnapshot } from './compute.js'
import { mountLocalModels, type LocalRequest } from './local-models.js'
import { el } from './widgets.js'

/** The same request Settings makes: a refusal is an answer with `ok: false`, never a throw. */
export const computeRequest = (token: string): LocalRequest => async (path, body, options) => {
  try {
    const response = await fetch(path, {
      method: options?.method ?? 'POST',
      headers: { 'content-type': 'application/json', 'x-alexia-token': token },
      ...(options?.method !== 'GET' && body !== undefined && { body: JSON.stringify(body) }),
      ...(options?.signal && { signal: options.signal }),
    })
    if (!response.ok) {
      const text = await response.text()
      try { return { ...JSON.parse(text) as Record<string, unknown>, ok: false } }
      catch { return { ok: false, said: text || 'That did not go through. Try again.' } }
    }
    return (await response.json()) as Record<string, unknown>
  } catch {
    return { ok: false, said: 'Alexia did not answer. She may not be running — try again in a moment.' }
  }
}

export function mountComputeSetup(root: HTMLElement, token: string): { close(): void } {
  const request = computeRequest(token)
  root.classList.add('compute-page')
  const section = (): HTMLElement => el('section')
  const paired = section()
  const queueRoot = section()
  const pauseRoot = el('div', 'group')
  const modelsRoot = section()
  const setupRoot = section()
  const roleRoot = section()
  const servicesRoot = section()
  const windowRoot = el('div', 'group')

  const picker = mountHostPicker(paired, request, { role: 'compute' })
  const queue = mountQueue(queueRoot, request)
  const models = mountLocalModels(modelsRoot, { request, selection: false })
  const setup = mountHost(setupRoot, request, { own: true, queue: false, changed: () => void models.refresh() })
  const role = mountRole(roleRoot, request)
  const services = mountServices(servicesRoot, request)

  // Pause is the tray's switch too; this is the same route, for when the window is open.
  const pauseSaid = el('p', 'hint')
  pauseSaid.setAttribute('role', 'status')
  let paused = false
  const pause = el('button', 'quiet-button', 'Pause this computer')
  pause.type = 'button'
  const drawPause = (): void => {
    pause.textContent = paused ? 'Resume this computer' : 'Pause this computer'
    pause.setAttribute('aria-pressed', String(paused))
  }
  pause.addEventListener('click', () => {
    pause.disabled = true
    void request('/api/compute/pause', { paused: !paused }, { method: 'POST' }).then(async (answer) => {
      pause.disabled = false
      const failed = answer as { ok?: boolean; said?: string } | null
      if (failed?.ok === false) { pauseSaid.textContent = failed.said ?? 'That did not go through. Try again.'; pauseSaid.className = 'error'; return }
      paused = !paused
      pauseSaid.className = 'hint'
      pauseSaid.textContent = paused ? 'Paused. Jobs wait in the queue and none starts until you resume.' : ''
      drawPause()
      await queue.refresh()
    })
  })
  pauseRoot.append(pause, pauseSaid)
  void request('/api/compute/queue', undefined, { method: 'GET' }).then((answer) => {
    const got = answer as { queue?: QueueSnapshot } | null
    paused = got?.queue?.paused === true
    drawPause()
  })

  const closeSaid = el('p', 'hint', 'Closing the window leaves this computer working from the menu bar or tray. Open the window again from there.')
  closeSaid.setAttribute('role', 'status')
  const closeWindow = el('button', 'quiet-button', 'Close window')
  closeWindow.type = 'button'
  closeWindow.addEventListener('click', () => {
    closeWindow.disabled = true
    void request('/api/compute/window/close', {}, { method: 'POST' }).then((answer) => {
      closeWindow.disabled = false
      const failed = answer as { ok?: boolean; said?: string } | null
      if (failed?.ok === false) { closeSaid.textContent = failed.said ?? 'That did not go through. Try again.'; closeSaid.className = 'error' }
    })
  })
  windowRoot.append(closeWindow, closeSaid)

  root.replaceChildren(
    el('h1', 'step-heading', 'Alexia — compute'),
    el('p', 'hint', 'This computer runs models and other heavy work for the computer it is paired with. The conversation, the agents and the permissions are on that computer.'),
    servicesRoot, paired, setupRoot, queueRoot, pauseRoot, modelsRoot, roleRoot, windowRoot,
  )
  picker.open()
  queue.open()
  models.open()
  setup.open({ id: 'this', name: 'This computer' })
  role.open()
  services.open()
  drawPause()
  return { close: () => { picker.close(); setup.close(); queue.close(); models.close(); role.close(); services.close() } }
}

// The page itself. A test imports this module with no such element and mounts by hand.
const page = typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('#compute-setup')
if (page) mountComputeSetup(page, document.querySelector<HTMLElement>('[data-token]')?.dataset.token ?? '')
