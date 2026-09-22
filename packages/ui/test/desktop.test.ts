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

/**
 * **Registered is not allowed** — the half the test above could not see. The page is served by
 * core over loopback, which Tauri treats as a remote origin, and a remote origin may call a
 * command only where a capability grants it by name. `relaunch` was registered and never
 * granted, so every Mac update installed and then failed with *Command relaunch not allowed by
 * ACL*, and the new version appeared only after somebody quit and reopened Alexia. So every
 * command the page calls is held to all three: registered in `main.rs`, given a permission in
 * `build.rs`, and granted in the capability both windows share, for the loopback origin.
 */
test('every command the page calls is one the shell registers, and one the capability grants', () => {
  const tauri = join(import.meta.dirname, '..', '..', '..', 'src-tauri')
  const build = readFileSync(join(tauri, 'build.rs'), 'utf8')
  const capability = JSON.parse(readFileSync(join(tauri, 'capabilities', 'default.json'), 'utf8')) as {
    windows: string[]
    remote?: { urls: string[] }
    permissions: string[]
  }
  const page = ['desktop.ts', 'main.ts']
    .map((file) => readFileSync(join(import.meta.dirname, '..', 'src', file), 'utf8'))
    .join('\n')
  const called = [...new Set([...page.matchAll(/(?:invoke|call)\('([a-z_:|]+)'/g)].map(([, name]) => name!))]
  expect(called).toContain('relaunch')

  const registered = /generate_handler!\[([^\]]*)\]/.exec(shell)?.[1]?.split(',').map((one) => one.trim()) ?? []
  const declared = /\.commands\(&\[([^\]]*)\]\)/.exec(build)?.[1]?.split(',').map((one) => one.trim().replace(/"/g, '')) ?? []
  const kebab = (name: string): string => name.replace(/_/g, '-')

  for (const name of called) {
    if (name.startsWith('plugin:')) {
      // A plugin's command, granted by the plugin's own set or by its one permission.
      const [plugin, command] = name.slice('plugin:'.length).split('|') as [string, string]
      expect(capability.permissions.some((one) => one === `${plugin}:default` || one === `${plugin}:allow-${kebab(command)}`), name).toBe(true)
      continue
    }
    expect(registered, `${name} is called by the page and not registered in main.rs`).toContain(name)
    expect(declared, `${name} has no permission, because build.rs does not name it`).toContain(name)
    expect(capability.permissions, `${name} is not granted`).toContain(`allow-${kebab(name)}`)
  }
  // Every registered command is granted too: one registered and not granted is only refused later.
  for (const name of registered) expect(capability.permissions).toContain(`allow-${kebab(name)}`)
  // For both windows, and for the origin the page is actually served from.
  expect(capability.windows).toEqual(expect.arrayContaining(['main', 'overlay']))
  expect(capability.remote?.urls).toContain('http://127.0.0.1:*')
})
