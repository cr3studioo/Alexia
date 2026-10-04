// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { rollingLog } from '../src/rollingLog.js'

test('lines are kept one per line, and a full log rolls over to one older copy', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'alexia-log-')), 'logs', 'plugins.log')
  const log = rollingLog(path, 40)
  log('[media] first\nwith a break')
  expect(readFileSync(path, 'utf8')).toBe('[media] first with a break\n')
  log('[media] second line that pushes it over')
  log('[media] third')
  expect(readFileSync(`${path}.1`, 'utf8')).toContain('second line')
  expect(readFileSync(path, 'utf8')).toBe('[media] third\n')
  expect(existsSync(`${path}.2`)).toBe(false)
})
