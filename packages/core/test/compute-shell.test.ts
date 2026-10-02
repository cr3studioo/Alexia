// SPDX-License-Identifier: AGPL-3.0-only
import { PassThrough } from 'node:stream'
import { expect, test, vi } from 'vitest'
import { noShell, shellPipe, statusLine, trayAction, type TrayAction } from '../src/compute/shell.js'

/**
 * The lines `src-tauri/src/main.rs` matches, byte for byte (T15): what core writes on stdout,
 * and what the shell writes down core's stdin after the vault line.
 */

function pipes() {
  const output = new PassThrough()
  const input = new PassThrough()
  let written = ''
  output.on('data', (chunk: Buffer) => { written += chunk.toString('utf8') })
  return { output, input, written: () => written }
}

test('core writes exactly the three @shell lines the shell parses', () => {
  const p = pipes()
  const shell = shellPipe(p.output, p.input)
  shell.computeReady('Paired with MacBook · Idle')
  shell.status('Paired with MacBook · Working', false)
  shell.status('Paired with MacBook · Paused', true)
  shell.relaunch()
  expect(p.written()).toBe([
    '@shell compute Paired with MacBook · Idle\n',
    '@shell status 0 Paired with MacBook · Working\n',
    '@shell status 1 Paired with MacBook · Paused\n',
    '@shell relaunch\n',
  ].join(''))
})

test('a status is always one non-empty line, so it can never forge a second command', () => {
  const p = pipes()
  const shell = shellPipe(p.output, p.input)
  shell.status('Studio\n@shell relaunch', false)
  shell.computeReady('  \r\n ')
  expect(p.written()).toBe('@shell status 0 Studio @shell relaunch\n@shell compute Alexia\n')
  expect(p.written().split('\n').filter((line) => line === '@shell relaunch')).toEqual([])
  expect(statusLine('a\u0007b')).toBe('a b')
  expect(statusLine('x'.repeat(500))).toHaveLength(120)
})

test('each of the five tray lines reaches its listener, and nothing else does', async () => {
  const p = pipes()
  const shell = shellPipe(p.output, p.input)
  const heard: TrayAction[] = []
  const off = shell.onTray((action) => { heard.push(action) })
  // Split across chunks, with a stray line, a near miss and a CRLF among them.
  p.input.write('tray pa')
  p.input.write('use\ntray resume\ntray unpair\r\nsomething else\ntray quit\ntray  role\ntray role\n')
  p.input.write('tray window\n')
  await vi.waitFor(() => { expect(heard).toEqual(['pause', 'resume', 'unpair', 'role', 'window']) })
  off()
  p.input.write('tray pause\n')
  await new Promise((resolve) => setImmediate(resolve))
  expect(heard).toHaveLength(5)
  expect(p.input.listenerCount('data')).toBe(0)
})

test('trayAction accepts exactly the lines main.rs writes', () => {
  for (const action of ['pause', 'resume', 'unpair', 'role', 'window'] as const) expect(trayAction(`tray ${action}`)).toBe(action)
  for (const line of ['tray', 'tray ', 'tray Pause', ' tray pause', 'tray pause now', 'tray quit', '@shell relaunch']) expect(trayAction(line)).toBeUndefined()
})

test('run from a checkout, the shell does nothing and relaunch leaves', () => {
  const exit = vi.fn()
  const shell = noShell(exit)
  shell.computeReady('x')
  shell.status('x', true)
  expect(exit).not.toHaveBeenCalled()
  shell.onTray(() => { throw new Error('never') })()
  shell.relaunch()
  expect(exit).toHaveBeenCalledTimes(1)
})
