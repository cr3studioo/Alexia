// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process'

export const HELPER_MS = 20_000
const MOST_BYTES = 4 * 1024 * 1024

/**
 * Run one of the system's helpers to its end and collect what it prints.
 *
 * Resolves (it never rejects) to `{ code, out, cut }`. `code` is `null` when the helper did not
 * start, was stopped or took too long. `cut` is true when it printed more than `maxBytes`; it is
 * stopped then, and `out` holds the first `maxBytes`.
 *
 * Its stderr is thrown away: an error there can quote what was searched for.
 */
export function runHelper(command, args, { input = '', timeoutMs = HELPER_MS, maxBytes = MOST_BYTES, signal } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ code: null, out: Buffer.alloc(0), cut: false })
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    const chunks = []
    let size = 0
    let cut = false
    let stopped = false
    const stop = () => {
      stopped = true
      child.kill()
    }
    const timer = setTimeout(stop, timeoutMs)
    signal?.addEventListener('abort', stop, { once: true })
    const done = (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      resolve({ code: stopped ? null : code, out: Buffer.concat(chunks).subarray(0, maxBytes), cut })
    }
    child.stdout.on('data', (chunk) => {
      if (cut) return
      chunks.push(chunk)
      size += chunk.length
      if (size > maxBytes) {
        cut = true
        child.kill()
      }
    })
    child.on('error', () => done(null))
    child.on('close', (code) => done(code))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

/**
 * Run a constant PowerShell script. The script is the only thing on the command line; whatever it
 * works on goes in as base64 on stdin, so no value is ever read as PowerShell.
 *
 * The script prints one base64 line for each result and `done` as its last line. Resolves to the
 * decoded results, or null when it did not get to `done`.
 */
export async function runPowerShell(script, input, { run = runHelper, signal } = {}) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]
  const { code, out } = await run('powershell.exe', args, { input: Buffer.from(input, 'utf8').toString('base64'), signal })
  const lines = out
    .toString('utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (code !== 0 || lines.pop() !== 'done') return null
  return lines.map((line) => Buffer.from(line, 'base64').toString('utf8'))
}
