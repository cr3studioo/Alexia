// SPDX-License-Identifier: AGPL-3.0-only
/**
 * How long the desktop takes to answer, measured on this machine (manual, not part of `pnpm test`).
 *
 *     node plugins/computer/test/bench.mjs [app name, default Calculator] [rounds, default 10]
 *
 * Reads only: windows, elements and cursor. Nothing is pressed.
 */
import { desktop } from '../desktop.js'

const app = process.argv[2] ?? 'Calculator'
const rounds = Number(process.argv[3] ?? 10)
const list = await desktop.windows()
const pid = list.find((w) => w.ProcessName === app)?.Id
if (!pid) throw new Error(`${app} is not running: ${JSON.stringify(list.map((w) => w.ProcessName))}`)

const time = async (label, call) => {
  const ms = []
  for (let n = 0; n < rounds; n += 1) {
    const at = performance.now()
    await call()
    ms.push(performance.now() - at)
  }
  ms.sort((a, b) => a - b)
  console.log(`${label.padEnd(22)} median ${ms[Math.floor(ms.length / 2)].toFixed(0).padStart(5)} ms   best ${ms[0].toFixed(0).padStart(5)} ms`)
}

await time('cursor', () => desktop.cursor())
await time('windows', () => desktop.windows())
await time(`elements ${app} (60)`, () => desktop.elements({ pid, limit: 60 }))
await time(`elements ${app} (200)`, () => desktop.elements({ pid, limit: 200 }))
desktop.close?.()
