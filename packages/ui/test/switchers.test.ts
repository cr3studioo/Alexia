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
  HOLD_MS,
  HINT_MS,
  HOLD_SLACK,
  LEAD,
  PLAIN,
  Spring,
  squash,
  TRAIL,
  nearness,
  SAID_MS,
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

test('switchers: the glass glides on transform alone, and a hover draws no box', () => {
  const section = css
    .slice(css.indexOf("/* ---- the rail's switches"), css.indexOf('.more {'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
  // Nothing in the switches animates a property that lays the rail out again every frame.
  for (const rule of section.matchAll(/transition:([^;]*);/g)) {
    expect(rule[1]).not.toMatch(/\b(left|width|top)\b/)
  }
  expect(section).not.toMatch(/:hover[^{]*\{[^}]*(background|border|box-shadow|outline)/)
  // The pill's cells are classed, so the plain button's hover fill cannot reach them.
  mountModeSwitch(host(), around)
  for (const cell of host().querySelectorAll('[role="radio"]')) expect(cell.getAttribute('class')).toBeTruthy()
})

test('switchers: Settings says what the chosen mode and level mean', () => {
  expect(html).toContain('id="mode-said"')
  expect(html).toContain('id="permission-said"')
})

test('switchers: Apple glass is sent once a frame, with its symbol, and the icon steps aside only once it is there', async () => {
  vi.useFakeTimers()
  type Call = { id: string; look?: { symbol: string | null; visible: boolean } }
  const calls: Call[] = []
  const tauri = globalThis as unknown as { __TAURI__?: unknown }
  tauri.__TAURI__ = {
    core: {
      invoke: (command: string, args: Call) => {
        // The trackpad's clicks go the same way; only the glass is counted here.
        if (command === 'glass') calls.push(args)
        return Promise.resolve(true)
      },
    },
  }
  try {
    const mode = mountModeSwitch(host(), around)
    const group = host().querySelector<HTMLElement>('.pill-switch')!
    group.querySelectorAll('[role="radio"]').forEach((cell, i) => sized(cell, i * 100, 100))
    sized(group, 0, 300)
    mode.native(true)
    // Before the shell answers, the page's own icon stays.
    expect(group.classList.contains('placed')).toBe(false)
    press(group, 50, 'pointerdown')
    for (const x of [90, 120, 150, 180, 210]) press(group, x, 'pointermove')
    await vi.advanceTimersByTimeAsync(40)
    // Many moves in one frame are one call, to the latest place, and it carries that place's
    // symbol — from the very first call, not only once the choice changes.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.look!.symbol).toBe('cloud.fill')
    expect(calls[0]!.look!.visible).toBe(true)
    expect(group.classList.contains('placed')).toBe(true)
    mode.native(false)
    expect(group.classList.contains('placed')).toBe(false)
  } finally {
    delete tauri.__TAURI__
  }
})

test('switchers: the rail has no dropdowns left, and Settings keeps both of its own', () => {
  const aside = /<aside id="rail"[\s\S]*?<\/aside>/.exec(html)![0]
  expect(aside).not.toContain('<select')
  expect(aside).toContain('id="mode-switch"')
  expect(aside).toContain('id="permission-switch"')
  expect(html).toContain('<select class="mode" aria-label="How should I run?" aria-describedby="mode-said">')
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
  // No lines of text under it: each word is inside the pill, under its own icon.
  expect(host().querySelector('.pill-word, .pill-means')).toBeNull()
  expect([...group.querySelectorAll('.pill-title')].map((one) => one.textContent)).toEqual(['Local', 'Combined', 'Cloud'])
  // Core setting it is not a choice, so no name pops up for it.
  expect(group.querySelector('[data-said]')).toBeNull()
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
  // The name of the one just chosen shows, on that one alone.
  const said = [...group.querySelectorAll<HTMLElement>('[role="radio"]')].map((one) => one.hasAttribute('data-said'))
  expect(said).toEqual([false, false, true])
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

const keyUp = (el: Element, name: string): void => {
  el.dispatchEvent(new KeyboardEvent('keyup', { key: name, bubbles: true }))
}

const mountLevels = (): { perm: ReturnType<typeof mountLevelSlider>; slider: HTMLElement; picked: string[] } => {
  const perm = mountLevelSlider(host(), around)
  perm.levels(LEVELS)
  perm.value = 'risky'
  const picked: string[] = []
  perm.addEventListener('change', () => picked.push(perm.value))
  return { perm, slider: host().querySelector<HTMLElement>('[role="slider"]')!, picked }
}

test('switchers: What she may do moves freely below Full trust, with no text under it', () => {
  vi.useFakeTimers()
  const { perm, slider, picked } = mountLevels()
  expect(slider.getAttribute('aria-valuetext')).toBe('Ask before anything risky')
  expect(slider.getAttribute('aria-valuemax')).toBe('3')
  expect(host().querySelectorAll('.level-stops svg')).toHaveLength(4)
  expect(host().querySelector('.level-name, .level-means')).toBeNull()
  key(slider, 'ArrowRight')
  expect(picked).toEqual(['watch'])
  expect(perm.value).toBe('watch')
  expect(slider.dataset.tone).toBe('caution')
  // Its name shows under its stop, and goes again after a few seconds.
  const said = host().querySelector<HTMLElement>('.stop-name[data-said]')!
  expect(said.textContent).toBe('Watch and warn me')
  vi.advanceTimersByTime(SAID_MS)
  expect(host().querySelector('.stop-name[data-said]')).toBeNull()
})

test('switchers: Full trust is held to; let go early and nothing changes', () => {
  vi.useFakeTimers()
  const { perm, slider, picked } = mountLevels()
  key(slider, 'ArrowRight')
  keyUp(slider, 'ArrowRight')
  const hint = slider.getAttribute('aria-describedby')!
  expect(document.getElementById(hint)!.textContent).toContain('Hold to turn on full trust')

  key(slider, 'End')
  // Armed: the knob waits on the triangle, red, and nothing is chosen yet.
  expect(slider.classList.contains('arming')).toBe(true)
  expect(slider.style.getPropertyValue('--at')).toBe('3')
  expect(slider.dataset.tone).toBe('danger')
  expect(perm.value).toBe('watch')
  vi.advanceTimersByTime(HOLD_MS / 2)
  keyUp(slider, 'End')
  // Let go too soon: back where it was, and nothing left behind to answer.
  expect(slider.classList.contains('arming')).toBe(false)
  expect(slider.style.getPropertyValue('--at')).toBe('2')
  vi.advanceTimersByTime(HOLD_MS)
  expect(perm.value).toBe('watch')
  expect(picked).toEqual(['watch'])
})

test('switchers: holding the key until the ring closes turns Full trust on', () => {
  vi.useFakeTimers()
  const { perm, slider, picked } = mountLevels()
  key(slider, 'ArrowRight')
  keyUp(slider, 'ArrowRight')
  key(slider, 'End')
  // The key repeats while it is held; that is the same hold, not a new one.
  vi.advanceTimersByTime(300)
  key(slider, 'End')
  vi.advanceTimersByTime(HOLD_MS - 300)
  expect(perm.value).toBe('full-trust')
  expect(picked).toEqual(['watch', 'full-trust'])
  expect(slider.classList.contains('arming')).toBe(false)
  keyUp(slider, 'End')
  expect(perm.value).toBe('full-trust')
})

test('switchers: a press held on the triangle turns Full trust on; a click does not', () => {
  vi.useFakeTimers()
  const { perm, slider, picked } = mountLevels()
  // A line three hundred wide: the triangle's stop is at its right end.
  sized(host().querySelector('.level-track')!, 0, 300)
  press(slider, 290, 'pointerdown')
  expect(slider.classList.contains('arming')).toBe(true)
  press(slider, 290, 'pointerup')
  expect(slider.classList.contains('arming')).toBe(false)
  expect(slider.style.getPropertyValue('--at')).toBe('1')
  expect(perm.value).toBe('risky')
  vi.advanceTimersByTime(1000)
  press(slider, 290, 'pointerdown')
  vi.advanceTimersByTime(HOLD_MS)
  expect(perm.value).toBe('full-trust')
  press(slider, 290, 'pointerup')
  expect(perm.value).toBe('full-trust')
  expect(picked).toEqual(['full-trust'])
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

// ---- the glide: the glass melts from one choice into the next --------------------------

/** Where the page's glass is: its slide, and its stretch and squash. */
const drawn = (el: HTMLElement): { dx: number; sx: number; sy: number } => {
  const [, dx = '0', sx = '1', sy = '1'] = /translate\(([-\d.]+)px, 0\) scale\(([-\d.]+), ([-\d.]+)\)/.exec(el.style.transform) ?? []
  return { dx: Number(dx), sx: Number(sx), sy: Number(sy) }
}

/** A mode switch three cells of a hundred wide, on `local`, with the frames it draws recorded. */
const gliding = async () => {
  vi.useFakeTimers()
  const mode = mountModeSwitch(host(), around)
  const group = host().querySelector<HTMLElement>('.pill-switch')!
  group.querySelectorAll('[role="radio"]').forEach((cell, i) => sized(cell, i * 100, 100))
  sized(group, 0, 300)
  mode.value = 'local'
  await vi.advanceTimersByTimeAsync(100)
  const thumb = group.querySelector<HTMLElement>('.thumb')!
  const record = async (ms: number) => {
    const seen: { dx: number; sx: number; sy: number }[] = []
    for (let t = 0; t < ms; t += 16) {
      await vi.advanceTimersByTimeAsync(16)
      seen.push(drawn(thumb))
    }
    return seen
  }
  return { mode, group, thumb, record }
}

test('switchers: a spring settles on its mark in its time; the lead goes a hair past, the plain slide never', () => {
  const run = (motion: typeof LEAD) => {
    const spring = new Spring(0)
    spring.motion = motion
    spring.target = 100
    let peak = 0
    for (let t = 0; t < motion.ms * 1.2; t += 16) {
      spring.step(0.016)
      peak = Math.max(peak, spring.value)
    }
    return { peak, end: spring.value }
  }
  for (const motion of [LEAD, TRAIL, PLAIN]) expect(run(motion).end).toBeCloseTo(100, 0)
  expect(run(LEAD).peak).toBeGreaterThan(101)
  expect(run(LEAD).peak).toBeLessThan(110)
  expect(run(TRAIL).peak).toBeLessThan(102)
  expect(run(PLAIN).peak).toBeLessThanOrEqual(100)
  // The lead is the quicker of the two, which is what stretches the glass.
  expect(LEAD.ms).toBeLessThan(TRAIL.ms)
  // A long frame is the same curve in more steps, not a leap.
  const slow = new Spring(0)
  slow.target = 100
  slow.step(0.05)
  expect(slow.value).toBeLessThan(100)
})

test('switchers: a stretched glass narrows the other way, but only so far', () => {
  expect(squash(1)).toBe(1)
  expect(squash(1.1)).toBeCloseTo(1 / 1.1)
  expect(squash(3)).toBe(0.7)
  expect(squash(0.9)).toBeLessThanOrEqual(1.1)
})

test('switchers: the pill stretches across both choices, narrows, and gathers into the new one', async () => {
  const { mode, group, thumb, record } = await gliding()
  expect(drawn(thumb)).toEqual({ dx: 0, sx: 1, sy: 1 })
  key(group, 'End')
  expect(mode.value).toBe('cloud')
  expect(group.classList.contains('gliding')).toBe(true)
  const seen = await record(800)
  const widest = seen.reduce((a, b) => (b.sx > a.sx ? b : a))
  // Over a third wider at its widest: the front edge left before the back one did.
  expect(widest.sx).toBeGreaterThan(1.3)
  expect(widest.sy).toBeLessThan(1)
  // Moving the whole way, not appearing there.
  expect(seen.filter((one) => one.dx > 5 && one.dx < 195).length).toBeGreaterThan(4)
  // And still, exactly on the new cell, the same size it started.
  expect(drawn(thumb)).toEqual({ dx: 200, sx: 1, sy: 1 })
  expect(group.classList.contains('gliding')).toBe(false)
})

test('switchers: under reduced motion the pill slides, briefly, with no stretch', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('reduce'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
  try {
    const { group, thumb, record } = await gliding()
    key(group, 'End')
    const seen = await record(400)
    expect(Math.max(...seen.map((one) => one.sx))).toBeCloseTo(1, 2)
    expect(seen.some((one) => one.dx > 5 && one.dx < 195)).toBe(true)
    expect(drawn(thumb).dx).toBe(200)
  } finally {
    vi.unstubAllGlobals()
  }
})

test('switchers: Apple glass is stepped with the glide, stretched, one move a frame and none animated by the shell', async () => {
  type Call = { id: string; look: { rect: number[]; durationMs: number; spring: boolean } }
  const calls: Call[] = []
  const tauri = globalThis as unknown as { __TAURI__?: unknown }
  tauri.__TAURI__ = {
    core: {
      invoke: (command: string, args: Call) => {
        if (command === 'glass' && args.id) calls.push(args)
        return Promise.resolve(true)
      },
    },
  }
  try {
    const { mode, group } = await gliding()
    mode.native(true)
    await vi.advanceTimersByTimeAsync(50)
    calls.length = 0
    key(group, 'End')
    await vi.advanceTimersByTimeAsync(800)
    const widths = calls.map((one) => one.look.rect[2]!)
    // Many frames, each its own call: the shell moves it where the page says, at once.
    expect(calls.length).toBeGreaterThan(10)
    expect(calls.length).toBeLessThanOrEqual(800 / 16 + 1)
    expect(calls.every((one) => one.look.durationMs === 0 && !one.look.spring)).toBe(true)
    // Stretched on the way, pill-sized once there, and centred on the third cell.
    expect(Math.max(...widths)).toBeGreaterThan(130)
    // The pill is 58% of its 100 px cell, centred in it.
    expect(widths.at(-1)).toBeCloseTo(58, 0)
    expect(calls.at(-1)!.look.rect[0]).toBeCloseTo(221, 0)
    // Never squashed: the shell sizes its symbol by the first height it is sent.
    expect(new Set(calls.map((one) => one.look.rect[3]))).toEqual(new Set([40]))
  } finally {
    delete tauri.__TAURI__
  }
})

test('switchers: the knob melts along the line, and the fill and the ring go with it', async () => {
  vi.useFakeTimers()
  const { perm, slider } = mountLevels()
  const track = host().querySelector<HTMLElement>('.level-track')!
  // 300 of line between the first stop and the last: a hundred a stop.
  sized(track, 0, 328)
  key(slider, 'ArrowRight')
  const knob = track.querySelector<HTMLElement>('.knob')!
  let widest = 1
  for (let t = 0; t < 800; t += 16) {
    await vi.advanceTimersByTimeAsync(16)
    widest = Math.max(widest, drawn(knob).sx)
  }
  expect(perm.value).toBe('watch')
  expect(widest).toBeGreaterThan(1.5)
  expect(drawn(knob)).toEqual({ dx: 200, sx: 1, sy: 1 })
  expect(track.querySelector<HTMLElement>('.hold')!.style.transform).toBe('translate(200px, 0)')
  expect(track.querySelector<HTMLElement>('.fill')!.style.transform).toBe('translateX(-33.333%)')
})

test('switchers: the switches glide on no CSS transition of their own', () => {
  const section = css
    .slice(css.indexOf("/* ---- the rail's switches"), css.indexOf('.more {'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
  // The glide moves the pill, the knob, the ring and the fill every frame; a transition on
  // their transform would chase it a frame behind.
  expect(section).not.toMatch(/transition:[^;]*\btransform\b/)
  expect(section).not.toMatch(/\.moving\b|cqw/)
})

// ---- Full trust, held --------------------------------------------------------------------

test('switchers: core saying again what is chosen does not end a hold being made', () => {
  vi.useFakeTimers()
  const { perm, slider, picked } = mountLevels()
  sized(host().querySelector('.level-track')!, 0, 300)
  press(slider, 290, 'pointerdown')
  vi.advanceTimersByTime(HOLD_MS / 3)
  // The window came to the front with this press, and read the level again.
  perm.value = 'risky'
  expect(slider.classList.contains('arming')).toBe(true)
  vi.advanceTimersByTime(HOLD_MS)
  expect(perm.value).toBe('full-trust')
  expect(picked).toEqual(['full-trust'])
  // Anything else from core does end it.
  perm.value = 'risky'
  press(slider, 290, 'pointerup')
  vi.advanceTimersByTime(1000)
  press(slider, 290, 'pointerdown')
  expect(slider.classList.contains('arming')).toBe(true)
  perm.value = 'watch'
  expect(slider.classList.contains('arming')).toBe(false)
})

test('switchers: a finger wobbling between Watch and the triangle keeps the hold going', () => {
  vi.useFakeTimers()
  const { perm, slider, picked } = mountLevels()
  // A hundred a stop, from 14 to 314.
  sized(host().querySelector('.level-track')!, 0, 328)
  press(slider, 214, 'pointerdown')
  press(slider, 290, 'pointermove')
  expect(slider.classList.contains('arming')).toBe(true)
  // Back and forth across the halfway line, where it used to start the ring again each time.
  for (let i = 0; i < 6; i += 1) {
    vi.advanceTimersByTime(HOLD_MS / 8)
    press(slider, i % 2 ? 270 : 250, 'pointermove')
    expect(slider.classList.contains('arming')).toBe(true)
  }
  vi.advanceTimersByTime(HOLD_MS / 4)
  expect(perm.value).toBe('full-trust')
  expect(picked).toEqual(['full-trust'])
})

test('switchers: dragged clearly off the triangle, the hold ends and the knob follows the finger again', () => {
  vi.useFakeTimers()
  const { perm, slider } = mountLevels()
  sized(host().querySelector('.level-track')!, 0, 328)
  press(slider, 214, 'pointerdown')
  press(slider, 310, 'pointermove')
  expect(slider.classList.contains('arming')).toBe(true)
  press(slider, 314 - (HOLD_SLACK + 0.1) * 100, 'pointermove')
  expect(slider.classList.contains('arming')).toBe(false)
  press(slider, 150, 'pointermove')
  expect(Number(slider.style.getPropertyValue('--at'))).toBeCloseTo(1.36)
  vi.advanceTimersByTime(HOLD_MS * 2)
  expect(perm.value).toBe('risky')
})

test('switchers: a click on the triangle teaches the hold, and changes nothing', () => {
  vi.useFakeTimers()
  const { perm, slider, picked } = mountLevels()
  sized(host().querySelector('.level-track')!, 0, 300)
  press(slider, 290, 'pointerdown')
  vi.advanceTimersByTime(80)
  press(slider, 290, 'pointerup')
  const name = host().querySelector<HTMLElement>('.stop-name[data-value="full-trust"]')!
  expect(name.textContent).toBe('Hold to turn on')
  expect(name.hasAttribute('data-hint')).toBe(true)
  expect(css).toMatch(/\.stop-name\[data-hint\]\s*\{\s*opacity: 1;/)
  vi.advanceTimersByTime(HINT_MS)
  expect(name.textContent).toBe('Full trust')
  expect(name.hasAttribute('data-hint')).toBe(false)
  expect(perm.value).toBe('risky')
  expect(picked).toEqual([])
})
