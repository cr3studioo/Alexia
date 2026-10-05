// SPDX-License-Identifier: AGPL-3.0-only
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * **A log that cannot fill the disk**: lines appended to `path`, and when it passes `most`
 * bytes it becomes `path.1` (replacing the one before) and a fresh file starts.
 *
 * For plugins' own lines. Core's stderr goes nowhere in the desktop app — the shell does not
 * keep it — so a plugin that failed used to leave no trace anybody could read. Nothing here
 * throws: a log that cannot be written is not a reason for anything else to stop.
 */
export function rollingLog(path: string, most = 2_000_000): (line: string) => void {
  let made = false
  return (line) => {
    try {
      if (!made) {
        mkdirSync(dirname(path), { recursive: true })
        made = true
      }
      try {
        if (statSync(path).size > most) renameSync(path, `${path}.1`)
      } catch {
        // Not there yet: the append below makes it.
      }
      appendFileSync(path, `${line.replace(/\r?\n/g, ' ')}\n`)
    } catch {
      // A full disk or a read-only folder: the line is lost, nothing else is.
    }
  }
}
