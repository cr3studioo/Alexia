// SPDX-License-Identifier: Apache-2.0
import { conform, format } from './conform.js'

/**
 * `npx @alexia/conformance <folder>` — what an author runs before submitting, and what
 * review runs on arrival. Same code, same answer, so nobody is surprised by the queue.
 *
 * Exit code 1 on a failure, 0 on warnings. That is deliberate: warnings are things worth
 * fixing and not things worth blocking a CI run over, and a suite that fails on advice is
 * a suite people learn to skip.
 */
const dirs = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
if (dirs.length === 0) {
  console.error('usage: alexia-conformance <plugin folder> [more folders]')
  process.exit(2)
}

let worst = 0
for (const dir of dirs) {
  const report = await conform(dir, { exercise: !process.argv.includes('--no-exercise') })
  console.log(format(report))
  console.log('')
  if (!report.ok) worst = 1
}
process.exit(worst)
