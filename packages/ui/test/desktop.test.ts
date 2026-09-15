// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { hotkeyFor, installUpdate } from '../src/desktop.js'

/**
 * The hotkey is said in two places — registered in `main.rs`, named on screen here — and the
 * two only agree because somebody kept them agreeing (D145). A page naming a combination the
 * shell never registered sends somebody hunting for a key that does nothing.
 */

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Edg/140.0'

const shell = readFileSync(join(import.meta.dirname, '..', '..', '..', 'src-tauri', 'src', 'main.rs'), 'utf8')

/** The modifiers `main.rs` registers under a given `cfg`, as it spells them. */
const registered = (cfg: string): string | undefined =>
  new RegExp(`#\\[cfg\\(${cfg}\\)\\]\\s*const HOTKEY: \\(Modifiers, Code\\) = \\(([^,]+(?:\\([^)]*\\))?), Code::Space\\);`).exec(
    shell,
  )?.[1]

test('the page names the hotkey the shell registers on a Mac', () => {
  // WebKit on Apple Silicon still says "Intel Mac OS X" — the check has to read that as a Mac.
  expect(hotkeyFor(MAC)).toBe('Option + Space')
  expect(registered('target_os = "macos"')).toBe('Modifiers::ALT')
})

test('the page names the hotkey the shell registers everywhere else', () => {
  expect(hotkeyFor(WINDOWS)).toBe('Ctrl + Alt + Space')
  expect(registered('not\\(target_os = "macos"\\)')).toBe('Modifiers::CONTROL.union(Modifiers::ALT)')
})

/**
 * A Mac update that finished and then sat at 100% (D152). The updater replaces the bundle and
 * returns there, so the page has to ask for the relaunch — and the shell has to have a command
 * by that name, or the ask fails into the same silence the bar was already sitting in.
 */
test('after the updater installs, the page asks the shell to come back as the new version', async () => {
  const asked: string[] = []
  const tauri = globalThis as unknown as { __TAURI__?: unknown }
  tauri.__TAURI__ = {
    core: {
      invoke: (command: string) => {
        asked.push(command)
        return Promise.resolve(null)
      },
    },
  }
  try {
    await installUpdate(7)
  } finally {
    delete tauri.__TAURI__
  }
  expect(asked).toEqual(['plugin:updater|download_and_install', 'relaunch'])
  expect(/generate_handler!\[[^\]]*\brelaunch\b[^\]]*\]/.test(shell)).toBe(true)
  expect(shell).toMatch(/fn relaunch\(app: AppHandle\) \{\s*app\.request_restart\(\);/)
})
