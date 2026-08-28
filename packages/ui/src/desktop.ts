// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The desktop app, seen from the page (M5-2).
 *
 * This shell is the same web page whether it is open in a browser or inside the Tauri
 * window, and **everything here is optional by construction**: in a browser `invoke` is
 * simply absent, every call below is a no-op, and the conversation works exactly as it did
 * before M5. That is what keeps the Tauri port a port rather than a rewrite (invariant 6) —
 * there is still no Node in here, and no import that only resolves inside the app.
 *
 * Four things cross this boundary, and they are the four Rust exists for:
 *
 * - the tray's state, because it is the only answer to *is it running?* anyone gets;
 * - Escape, because dismissing the overlay is a keypress the page sees and the window does not;
 * - autostart, because Alexia is a daemon and *with an obvious way to turn it off*;
 * - and nothing else. If a fifth appears, it probably belongs on the other side of the port.
 */

/** What the tray says about right now. Four states, because a person reads it at a glance. */
export type TrayState = 'idle' | 'working' | 'attention' | 'error'

interface TauriBridge {
  core?: { invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown> }
}

/**
 * `withGlobalTauri`, and the reason for it.
 *
 * The page is served by core over loopback, so from Tauri's side it is a *remote origin* —
 * it cannot import `@tauri-apps/api`, because nothing bundles it into a page core generated.
 * The global is how a remote origin reaches IPC at all, and the capability file narrows what
 * that buys to hiding a window, setting a tooltip and toggling autostart.
 */
const bridge = (): TauriBridge['core'] | undefined =>
  (globalThis as unknown as { __TAURI__?: TauriBridge }).__TAURI__?.core

/** True inside the app, false in a browser. Everything below is a no-op when it is false. */
export const inApp = (): boolean => bridge()?.invoke !== undefined

const call = (command: string, args?: Record<string, unknown>): void => {
  // Failures are swallowed on purpose. A tooltip that did not update is not worth an error
  // in front of somebody having a conversation, and there is nothing they could do about it.
  void bridge()?.invoke?.(command, args)?.catch(() => undefined)
}

let showing: TrayState = 'idle'

/**
 * Tell the tray what is happening.
 *
 * De-duplicated because this is called from the middle of a stream: a task emitting forty
 * step events would otherwise be forty IPC round trips to set the same tooltip.
 */
export function tray(state: TrayState): void {
  if (state === showing) return
  showing = state
  call('tray_state', { state })
}

/** Put the overlay away. It hides a window and nothing else — a running task keeps running. */
export const dismiss = (): void => call('hide_overlay')

/** Whether Alexia starts when you sign in. `undefined` in a browser, where it means nothing. */
export async function autostart(): Promise<boolean | undefined> {
  const invoke = bridge()?.invoke
  if (!invoke) return undefined
  try {
    return (await invoke('plugin:autostart|is_enabled')) === true
  } catch {
    return undefined
  }
}

export function setAutostart(on: boolean): void {
  call(on ? 'plugin:autostart|enable' : 'plugin:autostart|disable')
}

/** Said once, at first run, and then never again. */
export const HOTKEY = 'Ctrl + Alt + Space'
