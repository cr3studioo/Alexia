// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process'

/**
 * The one way this plugin starts a program. The tests fake this function and nothing below it,
 * so no test can reach a real power action.
 *
 * A value never becomes script text: it goes on standard input (PowerShell) or in `argv`
 * (`osascript`, `launchctl`), so nothing a model or a startup item's name says is ever code.
 */

/** Longer than any ordinary script takes; a hung one is killed rather than waited on. */
export const SCRIPT_MS = 60_000

/** Run `file` and give back `{stdout, stderr}` as UTF-8, or throw the first thing it complained of. */
export function runProgram(file, args, { input, env, signal, timeout = SCRIPT_MS, okCodes = [0], explain } = {}) {
  return new Promise((resolve, reject) => {
    const stdin = input === undefined ? 'ignore' : 'pipe'
    const child = spawn(file, args, { stdio: [stdin, 'pipe', 'pipe'], env, signal, timeout, windowsHide: true })
    const out = []
    const said = []
    child.stdout.on('data', (chunk) => out.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => said.push(Buffer.from(chunk)))
    child.on('error', reject)
    child.on('close', (code) => {
      // Joined before decoding: a character split across two chunks stays one character.
      const stdout = Buffer.concat(out).toString('utf8').trim()
      const stderr = Buffer.concat(said).toString('utf8').trim()
      if (okCodes.includes(code)) return resolve({ stdout, stderr })
      const why = code === null ? 'It took too long, so it was stopped.' : (explain?.(stderr) ?? stderr.split('\n')[0]?.trim())
      reject(new Error(why || `The helper exited ${String(code)}.`))
    })
    if (input !== undefined) {
      // A program that exits without reading breaks the pipe; its exit code says what happened.
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
  })
}
