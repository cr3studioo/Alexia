// SPDX-License-Identifier: AGPL-3.0-only
import { lstat, readdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runProgram } from './run.js'

/**
 * macOS, through `osascript` and the system's own command-line tools. Every script is constant;
 * a value travels in `argv`.
 *
 * Dark mode and login items go through System Events, which macOS lets Alexia control only after
 * the owner allows it under *Automation*.
 */

/** Under the hub's two-minute limit on one call. */
export const UPDATES_MS = 110_000

const OSASCRIPT = '/usr/bin/osascript'
const LAUNCHCTL = '/bin/launchctl'

export const SOUND = `
on run argv
  if item 1 of argv is "volume" then set volume output volume ((item 2 of argv) as integer)
  if item 1 of argv is "mute" then set volume output muted ((item 2 of argv) is "true")
  set sound to get volume settings
  return (output volume of sound as text) & linefeed & (output muted of sound as text)
end run
`.trim()

export const DARK = `
on run argv
  tell application "System Events"
    tell appearance preferences
      if (count of argv) > 0 then set dark mode to ((item 1 of argv) is "true")
      return dark mode
    end tell
  end tell
end run
`.trim()

export const LOGIN_ITEMS = `
tell application "System Events"
  set found to ""
  repeat with entry in login items
    set found to found & (name of entry) & tab & (path of entry) & linefeed
  end repeat
  return found
end tell
`.trim()

export const DELETE_LOGIN_ITEM = `
on run argv
  tell application "System Events" to delete login item (item 1 of argv)
end run
`.trim()

export const POWER = {
  // The Lock Screen shortcut; it needs Accessibility.
  lock: 'tell application "System Events" to keystroke "q" using {control down, command down}',
  sleep: 'tell application "System Events" to sleep',
  restart: 'tell application "System Events" to restart',
  shutdown: 'tell application "System Events" to shut down',
}

const CANNOT = {
  brightness: 'macOS does not let a script read or set the screen’s brightness. Use the brightness keys or Control Centre.',
  focus: 'macOS does not let a script turn Do Not Disturb on or off, or read it. Use Control Centre, Focus.',
}

/** A refused permission, said as what to do about it. */
export function explain(complaint) {
  if (/-1743|not authori[sz]ed to send Apple events/i.test(complaint)) {
    return 'macOS has not allowed Alexia to control System Events. Turn it on in System Settings → Privacy & Security → Automation.'
  }
  if (/-1719|-25211|not allowed (assistive access|to send keystrokes)/i.test(complaint)) {
    return 'macOS has not allowed Alexia to press keys. Turn Alexia on in System Settings → Privacy & Security → Accessibility.'
  }
  return complaint.split('\n')[0]?.trim()
}

/** `df -kP`: the volume the owner's files are on, and every volume plugged in or added. */
export function readDisks(text) {
  const rows = []
  for (const line of text.split('\n')) {
    const found = /^(.+?)\s+(\d+)\s+\d+\s+(\d+)\s+\d+%\s+(\/.*)$/.exec(line.trim())
    if (found) rows.push({ name: found[4], label: '', size: Number(found[2]) * 1024, free: Number(found[3]) * 1024 })
  }
  // Since macOS 10.15 the owner's files are on the Data volume; "/" is the sealed system.
  const main = rows.find((one) => one.name === '/System/Volumes/Data') ?? rows.find((one) => one.name === '/')
  const others = rows.filter((one) => one.name.startsWith('/Volumes/'))
  return [...(main ? [{ ...main, name: 'This Mac' }] : []), ...others]
}

/** `softwareupdate -l`, both the labelled form and the older one. */
export function readUpdates(text) {
  const found = []
  for (const line of text.split('\n')) {
    const label = /^\s*\*\s+(?:Label:\s*)?(.+?)\s*$/.exec(line)
    if (label) found.push(label[1])
    const title = /^\s*Title:\s*([^,]+)/.exec(line)
    if (title && found.length > 0) found[found.length - 1] = title[1].trim()
  }
  if (found.length === 0 && !/no new software available/i.test(text)) {
    throw new Error('Software Update did not answer. Check System Settings, General, Software Update.')
  }
  return found
}

/** `lsof -F Di`: a `device:inode` for every open file. */
export function readOpen(text) {
  const open = new Set()
  let device
  for (const line of text.split('\n')) {
    if (line.startsWith('f') || line.startsWith('p')) device = undefined
    else if (line.startsWith('D')) device = BigInt(line.slice(1))
    else if (line.startsWith('i') && device !== undefined && /^\d+$/.test(line.slice(1))) {
      open.add(`${String(device)}:${line.slice(1)}`)
    }
  }
  return open
}

export function macosBackend({ run = runProgram, home = homedir(), uid = process.getuid?.() ?? 501 } = {}) {
  const osascript = async (text, args = [], signal) =>
    (await run(OSASCRIPT, ['-e', text, ...args], { signal, explain })).stdout

  async function sound(args, signal) {
    const [volume, muted] = (await osascript(SOUND, args, signal)).split('\n')
    return { volume, muted }
  }

  async function setting(what, value, signal) {
    const writing = value !== undefined
    if (what === 'volume' || what === 'mute') {
      const found = await sound(writing ? [what, String(value)] : ['read'], signal)
      const got = what === 'volume' ? found.volume : found.muted
      // An output such as HDMI has no volume of its own.
      if (got === undefined || got === 'missing value') {
        throw new Error('The sound output in use has no volume the Mac can change.')
      }
      return what === 'volume' ? Number(got) : got === 'true'
    }
    if (what === 'dark_mode') return (await osascript(DARK, writing ? [String(value)] : [], signal)) === 'true'
    throw new Error(CANNOT[what])
  }

  /** The owner's launch agents: what apps add to start by themselves, besides login items. */
  async function agents(signal) {
    const folder = join(home, 'Library', 'LaunchAgents')
    const names = (await readdir(folder).catch(() => [])).filter((name) => name.endsWith('.plist')).sort()
    if (names.length === 0) return []
    const { stdout } = await run(LAUNCHCTL, ['print-disabled', `gui/${String(uid)}`], { signal })
    const off = new Set([...stdout.matchAll(/"([^"]+)"\s*=>\s*(?:disabled|true)/g)].map((found) => found[1]))
    return Promise.all(
      names.map(async (file) => {
        const path = join(folder, file)
        const read = await run('/usr/bin/plutil', ['-extract', 'Label', 'raw', '-o', '-', path], { signal }).catch(() => undefined)
        const name = read?.stdout || file.slice(0, -'.plist'.length)
        return { name, command: path, where: 'launch agent', enabled: !off.has(name) }
      }),
    )
  }

  return {
    get: (what, signal) => setting(what, undefined, signal),
    set: (what, value, signal) => setting(what, value, signal),
    disks: async (signal) => readDisks((await run('/bin/df', ['-kP', '-l'], { signal, okCodes: [0, 1] })).stdout),

    async startup(signal) {
      const items = []
      const notes = []
      try {
        for (const line of (await osascript(LOGIN_ITEMS, [], signal)).split('\n')) {
          const [name, command = ''] = line.split('\t')
          if (name) items.push({ name, command, where: 'login item', enabled: true })
        }
      } catch (error) {
        notes.push(`Login items could not be read. ${error.message}`)
      }
      items.push(...(await agents(signal)))
      return { items, notes }
    },

    async disableStartup({ name, where, command }, signal) {
      if (where === 'login item') {
        await osascript(DELETE_LOGIN_ITEM, [name], signal)
        return `${name} was removed from your login items. To bring it back, add ${command || name} in System Settings → General → Login Items.`
      }
      await run(LAUNCHCTL, ['disable', `gui/${String(uid)}/${name}`], { signal })
      return `${name} will not start at your next login. “launchctl enable gui/${String(uid)}/${name}” switches it on again.`
    },

    async updates(signal) {
      const { stdout, stderr } = await run('/usr/sbin/softwareupdate', ['-l'], { signal, timeout: UPDATES_MS })
      return readUpdates(`${stdout}\n${stderr}`)
    },

    async deleteUnused(files, signal) {
      // lsof exits 1 for any warning. No answer at all means nothing can be proved free.
      const { stdout } = await run('/usr/sbin/lsof', ['-w', '-n', '-P', '-u', String(uid), '-F', 'Di'], { signal, okCodes: [0, 1] })
      const open = readOpen(stdout)
      if (open.size === 0) throw new Error('I could not tell which files are open, so nothing was deleted.')
      const deleted = []
      for (const file of files) {
        try {
          const found = await lstat(file.path, { bigint: true })
          if (!found.isFile() || open.has(`${String(found.dev)}:${String(found.ino)}`)) continue
          await unlink(file.path)
          deleted.push(file)
        } catch {
          // Gone already, or not ours to delete.
        }
      }
      return deleted
    },

    power: async (action, signal) => void (await osascript(POWER[action], [], signal)),
  }
}
