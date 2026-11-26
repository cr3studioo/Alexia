// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { expect, test, vi } from 'vitest'
import { actFirst, ASK_EVERY_MS, CAP, ghost, WAIT_MS } from '../ghost.js'

/**
 * Her cursor is a nicety: shown only when something provides `cursor.show` and the owner has
 * not turned it off, and never waited on for longer than 200 ms. Each `ghost` here is handed
 * fakes for the three ways it asks core, so what it called and when is all visible.
 */
const fakes = ({ answers = true, settings = {}, capability = () => Promise.resolve({ content: [] }) } = {}) => ({
  answers: vi.fn(() => Promise.resolve({ answers, here: false })),
  capability: vi.fn(capability),
  settings: vi.fn(() => Promise.resolve(settings)),
})

test('no_provider_no_call', async () => {
  const ask = fakes({ answers: false })
  const her = ghost(ask)
  await expect(her.show(10, 20)).resolves.toBe('none')
  expect(ask.answers).toHaveBeenCalledWith(CAP)
  expect(ask.capability).not.toHaveBeenCalled()
})

test('slow_provider_ignored_after_200ms', async () => {
  expect(WAIT_MS).toBe(200)
  let finish
  const ask = fakes({ capability: () => new Promise((resolve) => (finish = resolve)) })
  const her = ghost(ask)
  const started = performance.now()
  await expect(her.show(10, 20)).resolves.toBe('slow')
  const took = performance.now() - started
  // Let go at its 200 ms deadline, not when the provider answers (it never has, yet). The upper
  // bound is generous for a loaded machine; the provider here would otherwise never return.
  expect(took).toBeGreaterThanOrEqual(150)
  expect(took).toBeLessThan(10_000)
  expect(ask.capability).toHaveBeenCalledTimes(1)
  // A late answer changes nothing and throws nothing.
  finish({ content: [] })
})

test('setting_off_no_call', async () => {
  const ask = fakes({ settings: { show_cursor: false } })
  const her = ghost(ask)
  await expect(her.show(10, 20)).resolves.toBe('off')
  expect(ask.answers).not.toHaveBeenCalled()
  expect(ask.capability).not.toHaveBeenCalled()
})

test('with a provider and the setting left at its default, the spot is shown, labelled Alexia', async () => {
  const ask = fakes()
  const her = ghost(ask)
  await expect(her.show(10.4, 19.6)).resolves.toBe('shown')
  expect(ask.capability).toHaveBeenCalledWith(CAP, { x: 10, y: 20, label: 'Alexia' })
})

test('whether anything provides it is asked once a minute, not once a show', async () => {
  let now = 1_000
  const ask = fakes()
  const her = ghost({ ...ask, now: () => now })
  await her.show(1, 1)
  await her.show(2, 2)
  now += ASK_EVERY_MS - 1
  await her.show(3, 3)
  expect(ask.answers).toHaveBeenCalledTimes(1)
  now += 1
  await her.show(4, 4)
  expect(ask.answers).toHaveBeenCalledTimes(2)
  expect(ask.capability).toHaveBeenCalledTimes(4)
})

test('a provider that fails, or answers asked that fail, never reach the action', async () => {
  const failing = fakes({ capability: () => Promise.reject(new Error('screen ink went away')) })
  await expect(ghost(failing).show(1, 1)).resolves.toBe('failed')
  const unsure = { ...fakes(), answers: vi.fn(() => Promise.reject(new Error('core is busy'))) }
  await expect(ghost(unsure).show(1, 1)).resolves.toBe('none')
  expect(unsure.capability).not.toHaveBeenCalled()
})

test('a point that is not a number shows nothing and asks nothing', async () => {
  const ask = fakes()
  await expect(ghost(ask).show(Number.NaN, 4)).resolves.toBe('none')
  expect(ask.answers).not.toHaveBeenCalled()
})

/**
 * The host refuses any capability a plugin did not list in `requires`, so without this entry
 * every `cursor.show` call is turned away and her cursor never appears. And `show_cursor` has to
 * be declared for the owner to be able to turn it off.
 */
test('manifest_requires_cursor_show_and_declares_show_cursor', () => {
  const manifest = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'))
  const wanted = manifest.requires.find((one) => one.cap === CAP)
  expect(wanted).toBeDefined()
  expect(typeof wanted.why).toBe('string')
  expect(wanted.why.length).toBeGreaterThan(0)
  expect(wanted.why.length).toBeLessThanOrEqual(120)
  const setting = manifest.settings.find((one) => one.key === 'show_cursor')
  expect(setting).toMatchObject({ type: 'toggle', default: true })
  expect(typeof setting.label).toBe('string')
})

// ---- accessibility first, the mouse only when nothing was attempted ---------------------------

/** `actFirst` with `act` answering `answer`, and every other way it reaches out recorded. */
function acting(answer) {
  const seen = { clicks: [], shown: [], then: 0, info: [], warn: [] }
  const accessibly = actFirst({
    act: vi.fn(() => Promise.resolve(answer)),
    clickBack: vi.fn((x, y, button, double, _signal, pid) => {
      seen.clicks.push({ x, y, button, double, pid })
      return Promise.resolve('')
    }),
    show: vi.fn((x, y) => {
      seen.shown.push({ x, y })
      return Promise.resolve('shown')
    }),
    log: { info: (said) => seen.info.push(said), warn: (said) => seen.warn.push(said) },
  })
  const then = () => {
    seen.then += 1
    return Promise.resolve()
  }
  return { accessibly, seen, then }
}

test('act_first_pattern_threw_is_an_error_and_never_a_mouse_click', async () => {
  const { accessibly, seen, then } = acting({ done: false, found: true, failed: 'invoke', error: 'the app said no', x: 5, y: 6 })
  await expect(accessibly({ match: 'Save' }, ['invoke'], undefined, { named: 'Save', then, pid: 7 })).rejects.toThrow(
    /“Save”: pressing it through accessibility failed \(the app said no\).*did not click it with the mouse/,
  )
  expect(seen.clicks).toEqual([])
  expect(seen.then).toBe(0)
  // The log says which way failed, never the control's name nor what the app said.
  expect(seen.warn.join(' ')).toContain('invoke')
  expect(seen.warn.join(' ')).not.toContain('Save')
  expect(seen.warn.join(' ')).not.toContain('the app said no')
  // A point given by the caller does not turn a failed attempt into a click either.
  const atPoint = acting({ done: false, found: true, failed: 'toggle', error: 'nope' })
  await expect(atPoint.accessibly({ x: 40, y: 50 }, ['toggle'], undefined, {})).rejects.toThrow(/ticking it through accessibility failed/)
  expect(atPoint.seen.clicks).toEqual([])
})

test('act_first_no_pattern_falls_back_to_the_mouse_and_puts_the_pointer_back', async () => {
  const { accessibly, seen, then } = acting({ done: false, found: true, x: 5, y: 6 })
  await expect(accessibly({ match: 'Save' }, ['invoke'], undefined, { named: 'Save', then, pid: 7 })).resolves.toMatchObject({ way: 'mouse', x: 5, y: 6 })
  expect(seen.clicks).toEqual([{ x: 5, y: 6, button: 'left', double: false, pid: 7 }])
  expect(seen.shown).toEqual([{ x: 5, y: 6 }])
  expect(seen.then).toBe(1)
  expect(seen.info.join(' ')).toContain('clicked with the mouse')
})

test('act_first_nothing_found_under_a_point_clicks_the_point', async () => {
  const { accessibly, seen } = acting({ done: false, found: false })
  await expect(accessibly({ x: 40, y: 50 }, ['invoke'], undefined, {})).resolves.toMatchObject({ way: 'mouse', x: 40, y: 50 })
  expect(seen.clicks).toEqual([{ x: 40, y: 50, button: 'left', double: false, pid: undefined }])
})

test('act_first_done_through_accessibility_moves_nothing', async () => {
  const { accessibly, seen, then } = acting({ done: true, via: 'uia', how: 'invoke', x: 5, y: 6 })
  await expect(accessibly({ match: 'Save' }, ['invoke'], undefined, { named: 'Save', then })).resolves.toMatchObject({ way: 'accessibility' })
  expect(seen.clicks).toEqual([])
  expect(seen.then).toBe(0)
  expect(seen.shown).toEqual([{ x: 5, y: 6 }])
})

test('act_first_missing_or_greyed_out_is_an_error_not_a_click', async () => {
  const missing = acting({ done: false, found: false })
  await expect(missing.accessibly({ match: 'Save' }, ['invoke'], undefined, { named: 'Save' })).rejects.toThrow(/There is no “Save” on screen/)
  const grey = acting({ done: false, found: true, disabled: true, x: 5, y: 6 })
  await expect(grey.accessibly({ match: 'Save' }, ['invoke'], undefined, { named: 'Save' })).rejects.toThrow(/greyed out/)
  const nowhere = acting({ done: false, found: true })
  await expect(nowhere.accessibly({ match: 'Save' }, ['invoke'], undefined, { named: 'Save' })).rejects.toThrow(/no place to click/)
  for (const one of [missing, grey, nowhere]) expect(one.seen.clicks).toEqual([])
})
