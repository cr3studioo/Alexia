// SPDX-License-Identifier: AGPL-3.0-only
const MESSAGE_MAX = 300

/** A failure's first line, with paths on that computer removed and URLs left intact. */
export function scrub(message: string): string {
  const line = (message.trim().split(/\r?\n/)[0] ?? '').slice(0, MESSAGE_MAX)
  // The punctuation that ended the path belongs to the sentence, and stays in it.
  return line.replace(/(?:(?<![A-Za-z0-9])[A-Za-z]:[\\/]|\\\\|~[\\/]|(?<![\w.:/])\/(?=[^\s/]+[\\/]))[^\s'"`<>()]*/g,
    (path) => `a file on that computer${/[:;,.!?]+$/.exec(path)?.[0] ?? ''}`)
}
