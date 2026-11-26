// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Lock, sleep, restart and shut down, now or later.
 *
 * Anything later waits **here**, on a timer in this process, which is why the plugin is resident:
 * `power_cancel` only has to drop the timer, and if Alexia quits or this plugin is switched off
 * the action is forgotten rather than carried out unannounced. One thing waits at a time.
 */

export const ACTIONS = ['lock', 'sleep', 'restart', 'shutdown']
/** The shortest warning before a restart or a shutdown. */
export const WARNING_S = 60
/** Long enough for the answer to reach the owner before the computer sleeps. */
export const SETTLE_S = 5
export const MOST_S = 24 * 60 * 60
/** A timer this far past its time means the computer slept through it. */
export const LATE_MS = 2 * 60 * 1000

const NOUN = { lock: 'lock', sleep: 'sleep', restart: 'restart', shutdown: 'shutdown' }
const DOING = { lock: 'Locking', sleep: 'Going to sleep', restart: 'Restarting', shutdown: 'Shutting down' }

export function wait(seconds) {
  if (seconds < 120) return `${String(seconds)} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 120) return `${String(minutes)} minutes`
  return `${String(Math.round((minutes / 60) * 10) / 10)} hours`
}

const realTimers = {
  // unref'd: a waiting action never keeps a plugin that was told to stop alive.
  set: (run, ms) => setTimeout(run, ms).unref(),
  clear: (timer) => clearTimeout(timer),
}

export function createPower({ backend, now = Date.now, timers = realTimers, log = () => {} }) {
  let pending

  async function fire(mine) {
    if (pending !== mine) return
    pending = undefined
    if (now() - mine.at > LATE_MS) {
      log(`the waiting ${NOUN[mine.action]} was dropped: the computer slept through its time`)
      return
    }
    try {
      await backend.power(mine.action)
    } catch (error) {
      log(`the ${NOUN[mine.action]} failed: ${error.message}`)
    }
  }

  async function run({ action, in_s }, signal) {
    if (!ACTIONS.includes(action)) throw new Error(`I can ${ACTIONS.join(', ')}, not “${String(action)}”.`)
    if (in_s !== undefined && !(Number.isInteger(in_s) && in_s >= 0 && in_s <= MOST_S)) {
      throw new Error('in_s is a whole number of seconds, from 0 to one day (86400).')
    }
    const announced = action === 'restart' || action === 'shutdown'
    const asked = in_s ?? 0
    // Locking loses nothing, so it happens at once unless a time was given.
    if (action === 'lock' && asked === 0) {
      await backend.power('lock', signal)
      return { text: 'Locked.', data: { action, at: now() } }
    }
    const seconds = Math.max(asked, announced ? WARNING_S : action === 'sleep' ? SETTLE_S : 0)
    const replaced = pending
    if (replaced) timers.clear(replaced.timer)
    const mine = { action, at: now() + seconds * 1000 }
    pending = mine
    mine.timer = timers.set(() => fire(mine), seconds * 1000)
    const text = [
      `${DOING[action]} in ${wait(seconds)}.`,
      announced && in_s !== undefined && asked < WARNING_S ? 'I always give a minute’s warning.' : '',
      replaced ? `This replaces the ${NOUN[replaced.action]} that was waiting.` : '',
      'Say cancel to stop it.',
    ].filter(Boolean).join(' ')
    return { text, data: { action, at: mine.at } }
  }

  function cancel() {
    const was = pending
    if (!was) return { text: 'Nothing is waiting to happen, so there was nothing to cancel.', data: { cancelled: false } }
    timers.clear(was.timer)
    pending = undefined
    return { text: `Cancelled the ${NOUN[was.action]}.`, data: { cancelled: true, action: was.action } }
  }

  return { run, cancel }
}
