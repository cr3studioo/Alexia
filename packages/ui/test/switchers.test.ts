// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  inside,
  isGlassLook,
  keyStep,
  LEVEL_ICONS,
  lookSaid,
  MODES,
  mountGlassLook,
  mountLevelSlider,
  mountModeSwitch,
  nearness,
  springCurve,
  SPRING_MS,
  SPRING_RATIO,
  stopAt,
  toneOf,
  useApple,
  type Level,
} from '../src/switchers.js'

/**
 * The rail's two switches: the numbers they move by, and the controls themselves in a page
 * with no WebGL — which is also what proves the CSS fallback is what a machine without it gets.
 */

const ui = join(import.meta.dirname, '..')
const css = readFileSync(join(ui, 'app.css'), 'utf8')
const html = readFileSync(join(ui, 'index.html'), 'utf8')

const LEVELS: Level[] = [
  { value: 'every-time', name: 'Ask me every time', means: 'Every action waits for your yes.' },
  { value: 'risky', name: 'Ask before anything risky', means: 'Risky things wait.' },
  { value: 'watch', name: 'Watch and warn me', means: 'Wrong-looking things wait.' },
  { value: 'full-trust', name: 'Full trust', means: 'Nothing asks first.' },
]

const around = { covered: () => false }

beforeEach(() => {
  document.body.innerHTML = '<span id="l">How she runs</span><div id="host" aria-labelledby="l"></div>'
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

// ---- the numbers ------------------------------------------------------------------------

test('switchers: the spring starts at 0, ends at 1, overshoots a little and never much', () => {
  const curve = springCurve(SPRING_RATIO, SPRING_MS)
  const values = [...curve.matchAll(/(?:\(|, )([\d.]+)/g)].map(([, one]) => Number(one))
  expect(values[0]).toBe(0)
  expect(values.at(-1)).toBe(1)
  const peak = Math.max(...values)
  expect(peak).toBeGreaterThan(1)
  expect(peak).toBeLessThan(1.05)
})

test('switchers: the sheet carries the same spring the code works out', () => {
  // Written out in app.css because CSS cannot do the sum. A change to the ratio or the length
  // that forgets the sheet would leave the glass on the old spring with nothing saying so.
  expect(css).toContain(`--spring: ${springCurve(SPRING_RATIO, SPRING_MS)};`)
  expect(css).toContain(`--t-spring: ${String(SPRING_MS)}ms;`)
})

test('switchers: keys move one stop, Home and End go to the ends, and nothing falls off', () => {
  expect(keyStep('ArrowRight', 1, 3)).toBe(2)
  expect(keyStep('ArrowRight', 2, 3)).toBe(2)
  expect(keyStep('ArrowLeft', 0, 3)).toBe(0)
  expect(keyStep('Home', 2, 3)).toBe(0)
  expect(keyStep('End', 0, 4)).toBe(3)
  expect(keyStep('Enter', 1, 3)).toBeUndefined()
  // Down is *next* among radios and *less* on a slider.
  expect(keyStep('ArrowDown', 1, 3)).toBe(2)
  expect(keyStep('ArrowDown', 1, 4, true)).toBe(0)
  expect(keyStep('ArrowUp', 1, 4, true)).toBe(2)
})

test('switchers: a pointer is over the stop under it, on cells and on a line', () => {
  const row = { left: 100, width: 300 }
  // Three cells a hundred wide: the middle of each is its whole number.
  expect(stopAt(150, row, 3)).toBe(0)
  expect(stopAt(250, row, 3)).toBe(1)
  expect(stopAt(350, row, 3)).toBe(2)
  expect(stopAt(9999, row, 3)).toBe(2)
  // Four stops on a line inset 14 each side: the ends are the first and last stop.
  expect(stopAt(114, row, 4, 14)).toBe(0)
  expect(stopAt(386, row, 4, 14)).toBe(3)
  expect(stopAt(250, row, 4, 14)).toBeCloseTo(1.5)
  // A row with no size yet (a hidden tab) is at the start, not NaN.
  expect(stopAt(10, { left: 0, width: 0 }, 3)).toBe(0)
})

test('switchers: an icon is full under the glass and grey a stop away', () => {
  expect(nearness(1, 1)).toBe(1)
  expect(nearness(1, 1.5)).toBe(0.5)
  expect(nearness(0, 2)).toBe(0)
})

test('switchers: Apple glass only where the Mac has it, and never when Alexia glass is asked for', () => {
  expect(useApple('auto', true)).toBe(true)
  expect(useApple('auto', false)).toBe(false)
  expect(useApple('apple', false)).toBe(false)
  expect(useApple('alexia', true)).toBe(false)
  expect(isGlassLook('apple')).toBe(true)
  expect(isGlassLook('liquid')).toBe(false)
  expect(lookSaid('apple', false)).toContain('macOS 26')
})

test('switchers: the line warms at watch and turns red at full trust', () => {
  expect(toneOf('every-time')).toBe('calm')
  expect(toneOf('watch')).toBe('caution')
  expect(toneOf('full-trust')).toBe('danger')
})

test('switchers: Apple glass hides once its place is scrolled out of the rail', () => {
  const rail = { left: 0, top: 0, width: 260, height: 600 }
  expect(inside({ left: 10, top: 100, width: 80, height: 34 }, rail)).toBe(true)
  expect(inside({ left: 10, top: 580, width: 80, height: 34 }, rail)).toBe(false)
  expect(inside({ left: 10, top: 100, width: 0, height: 0 }, rail)).toBe(false)
})

test('switchers: every level core names today has an icon and an SF Symbol', () => {
  for (const value of ['every-time', 'risky', 'watch', 'full-trust']) {
    expect(LEVEL_ICONS[value]?.icon).toContain('<path')
    expect(LEVEL_ICONS[value]?.symbol).toMatch(/^[a-z.]+$/)
  }
  expect(MODES.map((mode) => mode.symbol)).toEqual(['laptopcomputer', 'laptopcomputer.and.arrow.down', 'cloud.fill'])
})

test('switchers: the rail has no dropdowns left, and Settings keeps both of its own', () => {
  const aside = /<aside id="rail"[\s\S]*?<\/aside>/.exec(html)![0]
  expect(aside).not.toContain('<select')
  expect(aside).toContain('id="mode-switch"')
  expect(aside).toContain('id="permission-switch"')
  expect(html).toContain('<select class="mode" aria-label="How should I run?">')
  expect(html).toContain('<select class="permission" aria-label="What she may do">')
})

// ---- the controls ---------------------------------------------------------------------

const host = (): HTMLElement => document.querySelector<HTMLElement>('#host')!

/** Give an element a box, since happy-dom lays nothing out. */
const sized = (el: Element, left: number, width: number): void => {
  el.getBoundingClientRect = () =>
    ({ left, top: 0, width, height: 40, right: left + width, bottom: 40, x: left, y: 0, toJSON: () => ({}) }) as DOMRect
}

const press = (el: Element, x: number, type: string): void => {
  el.dispatchEvent(new PointerEvent(type, { clientX: x, button: 0, pointerId: 1, bubbles: true }))
}

const key = (el: Element, name: string): void => {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }))
}

test('switchers: How she runs is a radio group of three, named, with one checked', () => {
  const mode = mountModeSwitch(host(), around)
  const group = host().querySelector('[role="radiogroup"]')!
  expect(group.getAttribute('aria-labelledby')).toBe('l')
  const radios = [...group.querySelectorAll<HTMLElement>('[role="radio"]')]
  expect(radios.map((one) => one.getAttribute('aria-label'))).toEqual(['Local', 'Combined', 'Cloud'])
  mode.value = 'cloud'
  expect(mode.value).toBe('cloud')
  expect(radios.map((one) => one.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true'])
  // The one the keyboard lands on is the checked one.
  expect(radios.map((one) => one.tabIndex)).toEqual([-1, -1, 0])
  expect(host().querySelector('.pill-word')!.textContent).toBe('Cloud')
  expect(host().querySelector('.pill-means')!.textContent).toContain('online')
  // No WebGL here, so the pill is CSS glass.
  expect(group.classList.contains('no-gl')).toBe(true)
  // A screen reader presses a radio with a click and nothing else.
  const picked: string[] = []
  mode.addEventListener('change', () => picked.push(mode.value))
  radios[0]!.click()
  expect(picked).toEqual(['local'])
})

test('switchers: setting the value from core is not a choice; keys and clicks are', () => {
  const mode = mountModeSwitch(host(), around)
  const picked: string[] = []
  mode.addEventListener('change', () => picked.push(mode.value))
  mode.value = 'local'
  expect(picked).toEqual([])
  const group = host().querySelector('.pill-switch')!
  key(group, 'ArrowRight')
  key(group, 'End')
  key(group, 'End')
  expect(picked).toEqual(['combined', 'cloud'])
  // A click on the first cell of a row three hundred wide.
  sized(group, 0, 300)
  press(group, 40, 'pointerdown')
  press(group, 40, 'pointerup')
  expect(picked).toEqual(['combined', 'cloud', 'local'])
})

test('switchers: a drag follows the finger and lands on the nearest stop', () => {
  const mode = mountModeSwitch(host(), around)
  mode.value = 'local'
  const picked: string[] = []
  mode.addEventListener('change', () => picked.push(mode.value))
  const group = host().querySelector<HTMLElement>('.pill-switch')!
  sized(group, 0, 300)
  press(group, 50, 'pointerdown')
  press(group, 180, 'pointermove')
  expect(group.classList.contains('dragging')).toBe(true)
  // One to one: the pill is between the first and the second stop, where the finger is.
  expect(Number(group.style.getPropertyValue('--at'))).toBeCloseTo(1.3)
  press(group, 180, 'pointerup')
  expect(group.classList.contains('dragging')).toBe(false)
  expect(picked).toEqual(['combined'])
  expect(group.style.getPropertyValue('--at')).toBe('1')
})

test('switchers: Full trust asks in place, and Keep asking changes nothing', () => {
  vi.useFakeTimers()
  const perm = mountLevelSlider(host(), around)
  perm.levels(LEVELS)
  perm.value = 'risky'
  const picked: string[] = []
  perm.addEventListener('change', () => picked.push(perm.value))
  const slider = host().querySelector<HTMLElement>('[role="slider"]')!
  expect(slider.getAttribute('aria-valuetext')).toBe('Ask before anything risky')
  expect(slider.getAttribute('aria-valuemax')).toBe('3')
  expect(host().querySelectorAll('.level-stops svg')).toHaveLength(4)

  key(slider, 'ArrowRight')
  expect(picked).toEqual(['watch'])
  expect(slider.dataset.tone).toBe('caution')

  key(slider, 'End')
  const ask = host().querySelector('.level-ask')!
  expect(ask.textContent).toContain('Turn on full trust?')
  expect(perm.value).toBe('watch')
  expect(picked).toEqual(['watch'])
  ask.querySelector<HTMLButtonElement>('.no')!.click()
  expect(host().querySelector('.level-ask')).toBeNull()
  expect(perm.value).toBe('watch')

  key(slider, 'End')
  host().querySelector<HTMLButtonElement>('.level-ask .yes')!.click()
  expect(perm.value).toBe('full-trust')
  expect(picked).toEqual(['watch', 'full-trust'])
  expect(slider.dataset.tone).toBe('danger')
  // The name fades out and back in with the new one.
  vi.advanceTimersByTime(200)
  expect(host().querySelector('.level-name')!.textContent).toBe('Full trust')
})

test('switchers: a value that arrives before the levels is shown once they do', () => {
  const perm = mountLevelSlider(host(), around)
  perm.value = 'watch'
  perm.levels(LEVELS)
  expect(perm.value).toBe('watch')
  expect(host().querySelector('[role="slider"]')!.getAttribute('aria-valuenow')).toBe('2')
})

const LOOKS =
  '<select id="glass-look"><option value="auto">Automatic</option><option value="apple">Apple glass</option>' +
  '<option value="alexia">Alexia glass</option></select><p id="glass-look-said"></p>'

const fakeSwitch = (natives: boolean[]) =>
  Object.assign(new EventTarget(), { value: '', native: (on: boolean) => void natives.push(on), place: () => undefined })

test('switchers: Glass look greys out Apple glass where the Mac cannot draw it', async () => {
  document.body.innerHTML = LOOKS
  const natives: boolean[] = []
  const kept: string[] = []
  mountGlassLook(undefined, [fakeSwitch(natives)], Promise.resolve(false), (look) => kept.push(look))
  await Promise.resolve()
  await Promise.resolve()
  const select = document.querySelector<HTMLSelectElement>('#glass-look')!
  const apple = select.querySelector<HTMLOptionElement>('option[value="apple"]')!
  expect(select.value).toBe('auto')
  expect(apple.disabled).toBe(true)
  expect(apple.textContent).toContain('needs macOS 26 or later')
  expect(natives.every((on) => !on)).toBe(true)
  select.value = 'alexia'
  select.dispatchEvent(new Event('change'))
  expect(kept).toEqual(['alexia'])
})

test('switchers: Automatic is Apple glass where the Mac has it', async () => {
  document.body.innerHTML = LOOKS
  const natives: boolean[] = []
  mountGlassLook('auto', [fakeSwitch(natives)], Promise.resolve(true), () => undefined)
  await Promise.resolve()
  await Promise.resolve()
  expect(natives.at(-1)).toBe(true)
  expect(document.querySelector<HTMLOptionElement>('option[value="apple"]')!.disabled).toBe(false)
  expect(document.querySelector('#glass-look-said')!.textContent).toContain('Apple’s own glass')
})
