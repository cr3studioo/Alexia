// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The by-hand check of the screen-state probe (P3-34): what no automated test may do, because
 * it means locking the PC or making a window full screen. Run during P3-33, by the owner.
 *
 *   node plugins/computer/test/screen-check.mjs full   F11 a browser in, then out again
 *   node plugins/computer/test/screen-check.mjs lock   Win+L, then unlock
 *
 * Each mode prints one `screenState()` line per second for 20 seconds. This script itself only
 * looks: it presses nothing, locks nothing and opens nothing.
 */
import { desktop } from '../desktop.js'

const SECONDS = 20

const MODES = {
  full:
    'Open a browser and bring it to the front. Within 5 seconds press F11, a few seconds later press F11 again.\n' +
    'Expected: fullscreen:false, then fullscreen:true with titleBar:false, then back to fullscreen:false.',
  lock:
    'Within 5 seconds press Win+L. Unlock again after about 10 seconds.\n' +
    'Expected: while locked, every line reads {"locked":true} with no front.',
}

const USAGE = [
  'Usage: node plugins/computer/test/screen-check.mjs <mode>',
  '',
  'Prints what computer.screenshot would report about the screen, once a second for 20 seconds.',
  '',
  'Modes:',
  ...Object.entries(MODES).map(([mode, what]) => `  ${mode.padEnd(5)} ${what.split('\n')[0]}`),
].join('\n')

const mode = process.argv[2]
if (!(mode in MODES)) {
  console.log(USAGE)
  process.exit(mode === undefined || mode === '--help' || mode === '-h' ? 0 : 2)
}
if (!desktop.supported()) {
  console.error(`The screen-state probe runs on Windows and macOS, and this is ${process.platform}.`)
  process.exit(1)
}

console.log(MODES[mode])
const start = Date.now()
for (let second = 0; second < SECONDS; second += 1) {
  const state = await desktop.screenState()
  const at = ((Date.now() - start) / 1000).toFixed(1).padStart(5)
  console.log(`${at}s  ${JSON.stringify(state)}`)
  const next = start + (second + 1) * 1000
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, next - Date.now())))
}
desktop.close()
