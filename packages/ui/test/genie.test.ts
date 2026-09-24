// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { funnel } from '../src/genie.js'

const sheet = { left: 16, top: 16, width: 1400, height: 860 }
const tab = { left: 0, top: 820, width: 18, height: 30 }

test('at the start every band is where it is on the sheet, at full width', () => {
  for (let i = 0; i < 10; i++) {
    const at = funnel(sheet, tab, 0, i / 10, (i + 1) / 10)
    expect(at.top).toBeCloseTo(sheet.top + (i / 10) * sheet.height)
    expect(at.left).toBeCloseTo(sheet.left)
    expect(at.right).toBeCloseTo(sheet.left + sheet.width)
  }
})

test('at the end every band is inside the tab', () => {
  for (let i = 0; i < 10; i++) {
    const at = funnel(sheet, tab, 1, i / 10, (i + 1) / 10)
    expect(at.top).toBeGreaterThanOrEqual(tab.top - 0.001)
    expect(at.bottom).toBeLessThanOrEqual(tab.top + tab.height + 0.001)
    expect(at.left).toBeCloseTo(tab.left)
    expect(at.right).toBeCloseTo(tab.left + tab.width)
  }
})

test('the bottom narrows first: partway through, a lower band is narrower than a higher one', () => {
  const high = funnel(sheet, tab, 0.3, 0.1, 0.2)
  const low = funnel(sheet, tab, 0.3, 0.8, 0.9)
  expect(low.right - low.left).toBeLessThan(high.right - high.left)
  // And the bands stay in order, top to bottom, all the way through.
  for (const p of [0.2, 0.5, 0.8]) {
    const a = funnel(sheet, tab, p, 0.4, 0.5)
    const b = funnel(sheet, tab, p, 0.5, 0.6)
    expect(a.bottom).toBeCloseTo(b.top)
  }
})
