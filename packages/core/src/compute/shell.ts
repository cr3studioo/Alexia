// SPDX-License-Identifier: AGPL-3.0-only

/**
 * **The desktop shell, without a webview** (`docs/spec/remote-compute.md` §1.7).
 *
 * In the compute role the windows are destroyed, so no page is left to relay tray state or
 * hear a tray click. Core and the shell already share two pipes, and after the vault line
 * this module is their only user. The lines are plain text so `main.rs` needs no parser, and
 * they are matched there byte for byte:
 *
 * - core → shell, on stdout: `@shell compute <status>` · `@shell status 0|1 <status>` · `@shell relaunch`
 * - shell → core, on stdin: `tray pause` · `tray resume` · `tray unpair` · `tray role` · `tray window`
 */

export type TrayAction = 'pause' | 'resume' | 'unpair' | 'role' | 'window'
export const TRAY_ACTIONS: readonly TrayAction[] = ['pause', 'resume', 'unpair', 'role', 'window']

export interface Shell {
  /** Windows may go: setup is finished. The shell destroys them, unregisters hotkeys, and shows the compute menu. */
  computeReady(status: string): void
  /** The one status line in the tray menu and tooltip: `Paired with MacBook · Idle`. */
  status(line: string, paused: boolean): void
  /** Restart the whole app (windows included). Used by a role switch and by *Open window*. */
  relaunch(): void
  onTray(listener: (action: TrayAction) => void): () => void
}

/** The longest status the tray is handed. A menu item is one short line. */
const STATUS_MAX = 120

/** A status as one line the shell can take whole: no line break, no control character, never empty. */
export function statusLine(text: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what must not reach the pipe
  const line = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, STATUS_MAX)
  return line || 'Alexia'
}

/** One line from the shell, as the action it names, or undefined for anything else. */
export function trayAction(line: string): TrayAction | undefined {
  const found = /^tray ([a-z]+)\r?$/.exec(line)
  return found && (TRAY_ACTIONS as readonly string[]).includes(found[1]!) ? found[1] as TrayAction : undefined
}

/**
 * Under the app (`ALEXIA_TAURI`): writes `@shell …` lines to stdout, reads `tray …` lines from
 * stdin. Stdin is read only once somebody listens, and after the vault line has been taken by
 * `fromShell`, so the two never compete for a byte.
 */
export function shellPipe(output: NodeJS.WritableStream = process.stdout, input: NodeJS.ReadableStream = process.stdin): Shell {
  const listeners = new Set<(action: TrayAction) => void>()
  let said = ''
  const heard = (chunk: Buffer | string): void => {
    said += String(chunk)
    let end: number
    while ((end = said.indexOf('\n')) !== -1) {
      const action = trayAction(said.slice(0, end))
      said = said.slice(end + 1)
      if (action) for (const listener of [...listeners]) { try { listener(action) } catch { /* A listener cannot stop the others hearing. */ } }
    }
    // A line longer than any tray line is not one. Kept short, so nothing grows without end.
    if (said.length > 256) said = ''
  }
  const write = (line: string): void => { output.write(`${line}\n`) }
  return {
    computeReady: (status) => { write(`@shell compute ${statusLine(status)}`) },
    status: (line, paused) => { write(`@shell status ${paused ? 1 : 0} ${statusLine(line)}`) },
    relaunch: () => { write('@shell relaunch') },
    onTray: (listener) => {
      if (listeners.size === 0) {
        input.on('data', heard)
        input.resume()
      }
      listeners.add(listener)
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return
        input.off('data', heard)
      }
    },
  }
}

/** Run from a checkout: does nothing, and `relaunch` exits the process (`exit` is a test's seam). */
export function noShell(exit: () => void = () => process.exit(0)): Shell {
  return {
    computeReady: () => {},
    status: () => {},
    relaunch: exit,
    onTray: () => () => {},
  }
}
