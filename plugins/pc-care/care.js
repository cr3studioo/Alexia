// SPDX-License-Identifier: AGPL-3.0-only
import { oldFiles, safeTemp } from './temp.js'

/**
 * Settings and maintenance, the same on both platforms: what may be asked, and what is said back.
 * Everything that touches the computer is the backend's.
 */

export const SETTINGS = ['volume', 'mute', 'brightness', 'dark_mode', 'focus']
export const CHECKS = ['disk', 'startup', 'updates', 'temp']
const LEVELS = ['volume', 'brightness']

/** Files handed to the platform at a time, and how long one clean-up may run before it stops. */
export const BATCH = 500
export const CLEAN_MS = 90_000

const NAMES = { volume: 'Volume', mute: 'Mute', brightness: 'Brightness', dark_mode: 'Dark mode', focus: 'Do not disturb' }

const say = (what, value) =>
  LEVELS.includes(what) ? `${NAMES[what]} is ${String(value)}%.` : `${NAMES[what]} is ${value ? 'on' : 'off'}.`

export function size(bytes) {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? String(value) : value.toFixed(1)} ${units[unit]}`
}

const files = (count) => `${String(count)} file${count === 1 ? '' : 's'}`

/** How one startup item is shown, and a way to name it when two share a name. */
const label = (item) => `${item.name} (${item.where})`

/** The one startup item `wanted` means, or a refusal saying which ones there are. */
export function pick(items, wanted) {
  const asked = wanted.trim().toLowerCase()
  const short = (name) => name.replace(/\.(lnk|url|bat|cmd|exe)$/i, '')
  let matches = items.filter((item) => label(item).toLowerCase() === asked)
  if (matches.length === 0) matches = items.filter((item) => item.name.toLowerCase() === asked)
  if (matches.length === 0) matches = items.filter((item) => short(item.name).toLowerCase() === asked)
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    throw new Error(`More than one startup item is called that. Say which: ${matches.map(label).join('; ')}.`)
  }
  const there = items.length > 0 ? ` These start now: ${items.map(label).join('; ')}.` : ''
  throw new Error(`Nothing that starts with this computer is called “${wanted}”.${there}`)
}

export function createCare({ backend, temp, home, system, now = Date.now }) {
  const known = (what) => {
    if (!SETTINGS.includes(what)) throw new Error(`I can read and change ${SETTINGS.join(', ')}, not “${String(what)}”.`)
  }

  async function get({ what }, signal) {
    known(what)
    const value = await backend.get(what, signal)
    return { text: say(what, value), data: { what, value } }
  }

  async function set({ what, value }, signal) {
    known(what)
    let wanted = value
    if (LEVELS.includes(what)) {
      if (typeof value !== 'number' || !(value >= 0 && value <= 100)) {
        throw new Error(`${NAMES[what]} is a number from 0 to 100.`)
      }
      wanted = Math.round(value)
    } else if (typeof value !== 'boolean') {
      throw new Error(`${NAMES[what]} is true (on) or false (off).`)
    }
    const found = await backend.set(what, wanted, signal)
    return { text: say(what, found), data: { what, value: found } }
  }

  const report = (check, text, more = {}) => ({ text, data: { check, report: text, ...more } })

  async function disk(signal) {
    const disks = await backend.disks(signal)
    if (disks.length === 0) throw new Error('No disk answered.')
    const rows = disks.map((one) => {
      const name = one.label ? `${one.name} (${one.label})` : one.name
      const share = one.size > 0 ? `, ${String(Math.round((one.free / one.size) * 100))}% free` : ''
      return `${name}: ${size(one.free)} free of ${size(one.size)}${share}`
    })
    return report('disk', rows.join('\n'), { items: rows })
  }

  async function startup(disable, signal) {
    const { items, notes = [] } = await backend.startup(signal)
    if (disable !== undefined) {
      const item = pick(items, disable)
      const text =
        item.enabled ? await backend.disableStartup(item, signal) : `${item.name} is already switched off, so nothing changed.`
      return report('startup', text, { items: [label(item)] })
    }
    const rows = items.map((item) => `${label(item)}: ${item.enabled ? 'on' : 'off'}`)
    const text = [...(rows.length > 0 ? rows : ['Nothing is set to start with this computer.']), ...notes].join('\n')
    return report('startup', text, { items: rows })
  }

  async function updates(signal) {
    const found = await backend.updates(signal)
    const text =
      found.length === 0 ? 'No updates are waiting.'
      : `${String(found.length)} update${found.length === 1 ? ' is' : 's are'} waiting (I have not installed anything):\n${found.join('\n')}`
    return report('updates', text, { items: found })
  }

  async function cleanUp(apply, signal) {
    const root = await safeTemp(temp, { home, system })
    const { files: old, more } = await oldFiles(root, { now: now(), signal })
    const total = old.reduce((sum, one) => sum + one.size, 0)
    const rest = more ? ' There are more files than I look through in one go.' : ''
    if (!apply) {
      const text =
        old.length === 0 ? `Nothing in your temp folder is older than 7 days.${rest}`
        : `${files(old.length)} in your temp folder ${old.length === 1 ? 'is' : 'are'} older than 7 days, ${size(total)} in all. ` +
          `Cleaning up deletes those that are not open.${rest}`
      return report('temp', text)
    }
    const started = now()
    let tried = 0
    let count = 0
    let freed = 0
    while (tried < old.length && now() - started < CLEAN_MS) {
      signal?.throwIfAborted()
      const batch = old.slice(tried, tried + BATCH)
      for (const one of await backend.deleteUnused(batch, signal)) {
        count += 1
        freed += one.size
      }
      tried += batch.length
    }
    const kept = tried - count
    const text = [
      `Deleted ${files(count)} older than 7 days from your temp folder and freed ${size(freed)}.`,
      kept > 0 ? `${files(kept)} stayed: open, or not allowed to be deleted.` : '',
      tried < old.length ? `I stopped there to answer you; ask again for the other ${String(old.length - tried)}.` : '',
      more ? rest.trim() : '',
    ].filter(Boolean).join(' ')
    return report('temp', text, { freed_bytes: freed })
  }

  async function care({ check, apply, disable }, signal) {
    if (!CHECKS.includes(check)) throw new Error(`I can check ${CHECKS.join(', ')}, not “${String(check)}”.`)
    if (check === 'updates' && (apply || disable !== undefined)) {
      throw new Error('I only report updates; I never install them.')
    }
    if (apply && check !== 'temp') throw new Error('Only the temp check can be applied. Nothing was changed.')
    if (disable !== undefined && check !== 'startup') {
      throw new Error('Only a startup item can be disabled. Nothing was changed.')
    }
    if (disable !== undefined && String(disable).trim() === '') throw new Error('Say which startup item to disable.')
    if (check === 'disk') return disk(signal)
    if (check === 'startup') return startup(disable, signal)
    if (check === 'updates') return updates(signal)
    return cleanUp(apply === true, signal)
  }

  return { get, set, care }
}
