// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process'

/**
 * Start a helper, hand it `input` on stdin, and give every line it prints to `onLine`.
 *
 * `exit` resolves (it never rejects) once the process is gone and its last line delivered;
 * `code` is `null` when it was killed or never started. `release` lets the helper carry on
 * without holding this process open.
 *
 * The helper's stderr is thrown away: a script error can quote the notice, which is private.
 */
export function startProcess(command, args, { input, onLine }) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  let rest = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    const lines = (rest + chunk).split('\n')
    rest = lines.pop()
    for (const line of lines) if (line.trim()) onLine(line.trim())
  })
  const exit = new Promise((resolve) => {
    child.on('error', () => resolve({ code: null }))
    child.on('close', (code) => {
      if (rest.trim()) onLine(rest.trim())
      resolve({ code })
    })
  })
  child.stdin.on('error', () => {})
  child.stdin.end(Buffer.from(input, 'utf8'))
  return {
    exit,
    kill: () => void child.kill(),
    release: () => {
      child.unref()
      child.stdout.unref?.()
    },
  }
}
