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
 * - updating itself, because replacing a running program is the one thing a web page cannot
 *   do for itself at any price (D119);
 * - and nothing else. If a sixth appears, it probably belongs on the other side of the port.
 */

/** What the tray says about right now. Four states, because a person reads it at a glance. */
export type TrayState = 'idle' | 'working' | 'attention' | 'error'

interface TauriBridge {
  core?: {
    invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>
    /** Tauri's own event channel, which is how a Rust command reports progress to a page. */
    Channel?: new () => { onmessage: (message: unknown) => void }
  }
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

// ---- updating itself (D119) ----------------------------------------------------------------

/**
 * What the updater found. `rid` is Tauri's handle on the pending update, and the only reason
 * this is two calls: checking and installing are minutes apart, with a person in between.
 */
export interface Update {
  rid: number
  /** What is on the release. */
  version: string
  /** What is running. Read off the binary itself rather than asked for over the port. */
  currentVersion: string
}

/**
 * Is there a newer Alexia? (D119)
 *
 * `tauri-plugin-updater` does the whole of this — it reads `latest.json` off the app's own
 * GitHub Release, compares the version against this build's, and verifies a signature over
 * the installer before a byte of it is run. What is here is two `invoke` calls, because the
 * page is a remote origin and cannot import the plugin's own JS wrapper; the wrapper does
 * exactly this and nothing more.
 *
 * `undefined` means *nothing to do*, and it is deliberately the same answer for **no update**
 * and for **could not ask**. Nobody asked for this check, so nobody is owed an error about
 * it — an assistant that opens with *could not reach the update server* has spent somebody's
 * attention on a problem that is not theirs and that they cannot act on.
 *
 * The cost of that, said plainly: **a check that fails is not retried until the next launch**,
 * and this is a daemon that can be up for weeks. A manual *check now* on the Settings screen
 * is the answer if that ever bites; it is not here because a button nobody has needed yet is
 * a button nobody has needed yet.
 */
export async function updateAvailable(): Promise<Update | undefined> {
  const invoke = bridge()?.invoke
  if (!invoke) return undefined
  try {
    const found = (await invoke('plugin:updater|check')) as Update | null
    return found ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Take it: download in the background, then hand over to the installer.
 *
 * **The last thing this function does is not return.** `installMode: "quiet"` runs the NSIS
 * installer with `/S /R` — silent, then restart — and the plugin exits this process the
 * moment the installer is launched, because a running Alexia holds the files being replaced.
 * So there is no success path to write UI for: the window closes, the install happens without
 * a dialog, and Alexia comes back on its own. The only branch worth writing is the failure
 * one, which is why the error is thrown rather than swallowed the way everything else here is.
 *
 * `onProgress` reports bytes as they arrive. It is the difference between a button that looks
 * broken for ninety seconds and one that is visibly working.
 */
export async function installUpdate(rid: number, onProgress?: (done: number, total?: number) => void): Promise<void> {
  const core = bridge()
  if (!core?.invoke) throw new Error('Alexia can only update itself from the desktop app.')
  let done = 0
  let total: number | undefined
  const channel = core.Channel ? new core.Channel() : undefined
  if (channel) {
    channel.onmessage = (message: unknown) => {
      const said = message as { event?: string; data?: { contentLength?: number; chunkLength?: number } }
      if (said.event === 'Started') total = said.data?.contentLength
      if (said.event === 'Progress') {
        done += said.data?.chunkLength ?? 0
        onProgress?.(done, total)
      }
    }
  }
  await core.invoke('plugin:updater|download_and_install', { rid, onEvent: channel })
}
