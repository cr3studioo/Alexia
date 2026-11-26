// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process'

/** How much of a helper's complaint is kept. */
const SAID = 300

/**
 * Start a long-lived helper: `send` writes it a line, and every line it prints goes to `onLine`.
 *
 * `exit` resolves (it never rejects) once the process is gone, with its `code` (`null` when it
 * was killed or never started) and `said`, the last line it complained of on stderr.
 *
 * `close` ends its stdin, which is also what happens when this process dies however it dies, and
 * both helpers quit on it: no overlay is left on screen with nobody to take it down.
 */
export function startProcess(command, args, { onLine }) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let rest = ''
  let complaint = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    const lines = (rest + chunk).split('\n')
    rest = lines.pop()
    for (const line of lines) if (line.trim()) onLine(line.trim())
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => (complaint = (complaint + chunk).slice(-4_000)))
  const exit = new Promise((resolve) => {
    const gone = (code) => resolve({ code, said: complaint.trim().split('\n').at(-1).trim().slice(0, SAID) })
    child.on('error', () => gone(null))
    child.on('close', gone)
  })
  child.stdin.on('error', () => {})
  return {
    exit,
    send: (line) => void (child.stdin.writable && child.stdin.write(`${line}\n`)),
    close: () => void child.stdin.end(),
    kill: () => void child.kill(),
  }
}
