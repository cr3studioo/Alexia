// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { measure, round64, tight, wants } from '../sizing.js'

test('what was asked for beats what was last used beats the default', () => {
  const last = { width: 1024, height: 512, seed: 4242 }
  // Nothing asked, not a follow-up: the default, and a fresh seed.
  const fresh = measure({}, last)
  expect([fresh.width, fresh.height]).toEqual([768, 768])
  expect(fresh.reused).toBe(false)
  // A follow-up: the last size and — the point of the whole thing — the last seed.
  const again = measure({ again: true }, last)
  expect([again.width, again.height, again.seed]).toEqual([1024, 512, 4242])
  expect(again.reused).toBe(true)
  // A follow-up that names one thing: that thing wins, the rest is carried.
  const bigger = measure({ again: true, width: 1536 }, last)
  expect([bigger.width, bigger.height, bigger.seed]).toEqual([1536, 512, 4242])
})

test('a seed that was asked for is never quietly replaced by the last one', () => {
  // Naming a seed is how somebody says they meant it, and *again* must not override that.
  const one = measure({ again: true, seed: 7 }, { seed: 4242 })
  expect(one.seed).toBe(7)
  expect(one.reused).toBe(false)
})

test('`again` with nothing to remember still makes a picture', () => {
  // A first run, a purged store, a fresh install. It must not throw and must not reuse nothing.
  for (const last of [undefined, {}, { seed: 'not a number' }]) {
    const one = measure({ again: true }, last)
    expect(one.reused).toBe(false)
    expect(Number.isFinite(one.seed)).toBe(true)
    expect([one.width, one.height]).toEqual([768, 768])
  }
})

test('sizes are rounded to 64 and clamped', () => {
  // A model handed 1000x1000 makes something subtly wrong rather than refusing.
  expect(round64(1000)).toBe(1024)
  expect(round64(1)).toBe(256)
  expect(round64(9999)).toBe(2048)
  expect(measure({ width: 1000, height: 999 }).width).toBe(1024)
})

test('the card warning stays quiet on an ordinary picture and speaks on a big one', () => {
  const eight = 8.5e9
  // 768x768 with 8.5 GB free: nothing to say, which is almost always the case.
  expect(tight({ width: 768, height: 768 }, eight)).toBeUndefined()
  // And 2048x2048 with 8.5 GB free is *also* fine — asserting a warning here was this test
  // being wrong rather than the estimate. Crying wolf on a picture that would have worked is
  // the failure this is designed against, so it has to be allowed to stay quiet.
  expect(tight({ width: 2048, height: 2048 }, eight)).toBeUndefined()
  // Two gigabytes free and a four-megapixel picture: worth a sentence before the wait.
  expect(tight({ width: 2048, height: 2048 }, 2e9)).toMatch(/2\.0 GB free/)
  expect(tight({ width: 2048, height: 2048 }, 2e9)).toMatch(/come back black/)
  // The measured reading from this machine while something else held the card.
  expect(tight({ width: 1024, height: 1024 }, 897_129_170)).toMatch(/0\.9 GB free/)
})

test('a machine that cannot answer the question is not warned about', () => {
  // No card, no ComfyUI, a shape this does not recognise: say nothing rather than guess.
  // `null` is the one that mattered: `Number(null)` is 0, so it used to read as an empty card.
  for (const free of [undefined, null, NaN, 'lots', '8500000000']) {
    expect(tight({ width: 2048, height: 2048 }, free)).toBeUndefined()
  }
})

test('the estimate is monotonic in pixels, which is the only property it promises', () => {
  // Deliberately rough — it decides whether to say a sentence, not what to allocate. What it
  // must never do is claim a bigger picture is cheaper than a smaller one.
  expect(wants(1024, 1024)).toBeGreaterThan(wants(768, 768))
  expect(wants(2048, 2048)).toBeGreaterThan(wants(1024, 1024))
})
