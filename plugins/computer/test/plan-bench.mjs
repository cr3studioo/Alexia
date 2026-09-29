// SPDX-License-Identifier: AGPL-3.0-only
/**
 * How long the plan-runner takes, with no screen and the real Laya (manual, not part of `pnpm test`).
 *
 *     node plugins/computer/test/plan-bench.mjs [rounds, default 20]
 *
 * Runs the newest-video recipe against a recorded YouTube channel page (session 96), and a step
 * only Laya can settle, against laya-serve on 127.0.0.1:8000. Nothing is pressed or opened: the
 * screen is a recording, and opening the page is timed as zero. Add the page's own load time
 * (`bench.mjs` times a real read of the window) for the whole of a task.
 */
import { askLaya, table } from '../decide.js'
import { recipe } from '../recipes.js'
import { ground, runTask } from '../task.js'

const rounds = Number(process.argv[2] ?? 20)
const page = [
  ['Mark Rober - YouTube - Comet', 'Window', 735, 495, false],
  ['Search', 'ComboBox', 555, 187, true],
  ['Search', 'Button', 863, 187, true],
  ['YouTube Home', 'Link', 118, 187, true],
  ['Latest', 'Tab', 347, 687, true],
  ['Popular', 'Tab', 423, 687, true],
  ['34:23', 'Link', 482, 831, true],
  ['Last Cheater Standing Wins $10,000! 34 minutes', 'Link', 417, 947, true],
  ['25:20', 'Link', 848, 831, true],
  ['I Outsmarted Pro Car Thieves 25 minutes', 'Link', 791, 947, true],
  ['Subscribe to Mark Rober.', 'Button', 247, 400, true],
  ['Mark Rober', 'Link', 111, 400, true],
].map(([name, type, x, y, web]) => ({ name, type, x, y, web, id: '', off: false }))

const laya = (body) => askLaya({ body, model: 'typed-decisions' })
const time = async (label, call) => {
  const ms = []
  let last
  for (let n = 0; n < rounds; n += 1) {
    const at = performance.now()
    last = await call()
    ms.push(performance.now() - at)
  }
  ms.sort((a, b) => a - b)
  console.log(`${label.padEnd(34)} median ${ms[Math.floor(ms.length / 2)].toFixed(1).padStart(7)} ms   worst ${ms.at(-1).toFixed(1).padStart(7)} ms   → ${last}`)
}

await laya({ state: {}, questions: { target: { type: 'choice', instructions: 'warm', criteria: { 1: 'a', 2: 'b' } } } }).catch(() => {})
await time('newest-video recipe, whole plan', async () => {
  const done = await runTask('the latest video from Mark Rober', { look: async () => page, openUrl: async () => {}, note: async () => {}, laya }, { steps: recipe('the latest video from Mark Rober') })
  return done.answer
})
const rows = table(page)
await time('a step Laya must settle', async () => {
  const found = await ground({ goal: 'subscribe', window: 'YouTube', step: { do: 'press', target: 'follow this channel' }, rows }, { laya })
  return found.row ? `${found.by}: ${found.row.name}` : `handed back: ${found.why}`
})
