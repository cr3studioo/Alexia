// SPDX-License-Identifier: AGPL-3.0-only

/**
 * **The rail's two switches**: *How she runs* (a glass pill over three icons) and *What she
 * may do* (four stops on a line, a glass knob on the chosen one). They replaced two dropdowns,
 * because both are a choice you make by feel and look at often, and a closed dropdown shows
 * neither the other choices nor how far along the line you are.
 *
 * **They decide nothing.** Each is a picture of one value with an `onPick` that main.ts wires
 * to the same writer the dropdowns had — `/local`, `/combined`, `/cloud` for the mode and
 * `POST /api/permissions` for the permission — and main.ts sets `value` from core's answer.
 * The Settings page keeps its selects; they and these are the same control shown twice.
 *
 * **One behaviour for both** (`drive`): click, drag to snap with the pointer captured, arrow
 * keys and Home/End. While dragging the glass follows the finger one to one; let go and it
 * springs to the nearest stop. Each time the choice lands somewhere new the trackpad clicks
 * (`haptic`, a no-op away from a Mac).
 *
 * **Two kinds of glass.** Alexia's own (`lens.ts`, WebGL bending the painting, and CSS frost if
 * that fails), or Apple's own on macOS 26 — the shell lays a real Liquid Glass exactly over the
 * pill and the knob (`desktop.ts`, `glass`) and the web copy steps aside. Which one is
 * Settings › General › *Glass look*.
 *
 * No Node in here, ever (invariant 6).
 */

import { glass, haptic, type Glass } from './desktop.js'
import { mountLens, rgba } from './lens.js'

/**
 * A damped spring as a CSS `linear()` curve: `ratio` below 1 overshoots a little and settles,
 * and `ms` is how long until it is still. The sheet carries the result as `--spring` (app.css),
 * and the stylesheet test holds the two equal.
 */
export function springCurve(ratio: number, ms: number, points = 24): string {
  const seconds = ms / 1000
  // Still by `ms`: the envelope e^(−ζωt) is down to a thousandth by then.
  const omega = Math.log(1000) / (ratio * seconds)
  const damped = omega * Math.sqrt(1 - ratio * ratio)
  const at = (t: number): number =>
    1 - Math.exp(-ratio * omega * t) * (Math.cos(damped * t) + (ratio / Math.sqrt(1 - ratio * ratio)) * Math.sin(damped * t))
  const stops: string[] = ['0']
  for (let i = 1; i < points; i += 1) {
    const share = i / points
    const value = Math.round(at(share * seconds) * 1000) / 1000
    stops.push(`${String(value)} ${String(Math.round(share * 10000) / 100)}%`)
  }
  stops.push('1')
  return `linear(${stops.join(', ')})`
}

/** The spring the glass moves on: Expo's glass tabs, 420 ms at a damping ratio of 0.82. */
export const SPRING_MS = 420
export const SPRING_RATIO = 0.82

export const clamp = (value: number, count: number): number => Math.max(0, Math.min(count - 1, value))

/**
 * Where a key moves the choice, or `undefined` for a key that is not ours. Up and down are the
 * one place a radio group and a slider disagree: down is *next* in a list of radios and *less*
 * on a slider, and a screen reader tells its user which of the two they are on.
 */
export function keyStep(key: string, at: number, count: number, slider = false): number | undefined {
  const up = slider ? 1 : -1
  const to: Record<string, number> = {
    ArrowLeft: at - 1,
    ArrowRight: at + 1,
    ArrowUp: at + up,
    ArrowDown: at - up,
    Home: 0,
    End: count - 1,
  }
  const next = to[key]
  return next === undefined ? undefined : clamp(next, count)
}

/** How close stop `index` is to the glass at `x`, 1 under it and 0 a whole stop away. */
export const nearness = (index: number, x: number): number => Math.max(0, 1 - Math.abs(index - x))

/** The stop a pointer at `clientX` is over, as a fraction, on a row `count` stops wide. */
export function stopAt(clientX: number, row: { left: number; width: number }, count: number, inset = 0): number {
  const width = row.width - 2 * inset
  if (width <= 0) return 0
  if (inset > 0) return clamp(((clientX - row.left - inset) / width) * (count - 1), count)
  return clamp(((clientX - row.left) / row.width) * count - 0.5, count)
}

/** The three answers to *Glass look*. */
export type GlassLook = 'auto' | 'apple' | 'alexia'
export const GLASS_LOOKS: readonly GlassLook[] = ['auto', 'apple', 'alexia']
export const isGlassLook = (value: unknown): value is GlassLook => GLASS_LOOKS.includes(value as GlassLook)

/** Apple's glass when it is asked for (or automatic) and this Mac can draw it; ours otherwise. */
export const useApple = (look: GlassLook, supported: boolean): boolean => supported && look !== 'alexia'

// ---- the icons ------------------------------------------------------------------------

/** An outline stroke, and the same shape filled — the chosen one is solid. */
const line = (d: string): string =>
  `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
const solid = (d: string): string =>
  `<path d="${d}" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
const svg = (inner: string, cls: string): string =>
  `<svg class="${cls}" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">${inner}</svg>`

const LAPTOP = 'M4.5 5.5h15v9.5h-15z'
const LAPTOP_BASE = 'M2 18.5h20'
const SMALL = 'M3 9.5h10.5v6.5H3z'
const SMALL_BASE = 'M1.5 19h13.5'
const PUFF = 'M14.5 9.5a3 3 0 0 1 5.8-.8A2.6 2.6 0 0 1 20 14h-3'
const CLOUD = 'M7 18.5a4 4 0 0 1-.6-8A5.5 5.5 0 0 1 17 9a4.8 4.8 0 0 1 .5 9.5z'

/** One mode: its icon both ways, its name, its sentence, and the SF Symbol Apple draws for it. */
interface Mode {
  value: string
  name: string
  means: string
  off: string
  on: string
  symbol: string
}

export const MODES: readonly Mode[] = [
  {
    value: 'local',
    name: 'Local',
    means: 'The AI runs on this computer.',
    off: line(LAPTOP) + line(LAPTOP_BASE),
    on: solid(LAPTOP) + line(LAPTOP_BASE),
    symbol: 'laptopcomputer',
  },
  {
    value: 'combined',
    name: 'Combined',
    means: 'Online AI services think. This computer makes pictures and speech.',
    off: line(SMALL) + line(SMALL_BASE) + line(PUFF),
    on: solid(SMALL) + line(SMALL_BASE) + solid(PUFF),
    // There is no laptop-and-cloud symbol; this one is the laptop with work coming down to it.
    symbol: 'laptopcomputer.and.arrow.down',
  },
  {
    value: 'cloud',
    name: 'Cloud',
    means: 'Everything goes through online AI services.',
    off: line(CLOUD),
    on: solid(CLOUD),
    symbol: 'cloud.fill',
  },
]

/** One permission level's icon and SF Symbol. The name and sentence come from main.ts. */
export const LEVEL_ICONS: Record<string, { icon: string; symbol: string }> = {
  'every-time': {
    icon:
      line('M8 12V6.5a1.5 1.5 0 0 1 3 0V11') +
      line('M11 10.5V5a1.5 1.5 0 0 1 3 0v5.5') +
      line('M14 10.5V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-.5a6 6 0 0 1-4.9-2.6L3.3 14a1.5 1.5 0 0 1 2.4-1.8L8 14.5'),
    symbol: 'hand.raised.fill',
  },
  risky: {
    icon: line('M12 3l7 3v5.5c0 4.3-3 7.8-7 9-4-1.2-7-4.7-7-9V6z') + line('M9 12l2 2 4-4'),
    symbol: 'checkmark.shield.fill',
  },
  watch: {
    icon:
      line('M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z') +
      line('M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z'),
    symbol: 'eye.fill',
  },
  'full-trust': {
    icon: line('M12 3.5L22 20H2z') + line('M12 10v4.5') + solid('M12 17.2a.4.4 0 1 0 0 .8.4.4 0 0 0 0-.8z'),
    symbol: 'exclamationmark.triangle.fill',
  },
}

/** A level core added later and nothing here knows: a plain dot, and no symbol. */
const UNKNOWN_LEVEL = { icon: solid('M12 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z'), symbol: 'circle.fill' }

const reduced = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches

// ---- one behaviour for both -----------------------------------------------------------

interface Driven {
  root: HTMLElement
  count: () => number
  /** A slider reads up as *more*; a radio group reads down as *next* (`keyStep`). */
  slider: boolean
  /** The row a pointer is measured against, and how far in its first and last stop sit. */
  row: () => DOMRect
  inset: number
  /** Draw the glass at stop `x`, a fraction while a finger drags it. */
  show: (x: number, dragging: boolean) => void
  /** The choice is `index` now — by a person (`moved`), or because core said so. */
  land: (index: number, moved: boolean) => void
  /** Hold a move back until it is answered (Full trust asks first). False while held. */
  guard?: (index: number, answer: (ok: boolean) => void) => boolean
  /** A person chose `index`. */
  pick: (index: number) => void
}

interface Driving {
  /** Show `index` without it counting as a choice: core's answer, or a focus-refresh. */
  set: (index: number) => void
  /**
   * A click on stop `index` that no pointer made — a screen reader pressing it, or a script.
   * A pointer's own click follows its release, which has already chosen, so it is let pass.
   */
  clicked: (index: number) => void
  at: () => number
}

/**
 * Click, drag to snap, keys. A press that moves more than a few pixels is a drag: the pointer
 * is captured, the glass follows it one to one, and each stop it crosses clicks the trackpad.
 * Let go and it springs to the nearest stop. A press that does not move is a click on a stop.
 */
function drive(d: Driven): Driving {
  const { root } = d
  let at = 0
  let press: { id: number; from: number } | undefined
  let dragging = false
  let near: number | undefined
  /** When a pointer was last let go, so the click that follows it is not a second choice. */
  let released = -Infinity

  // The stretch along the way and the squash on arrival (app.css, `.moving`), restarted for
  // every move so two quick presses are two stretches.
  const stretch = (): void => {
    if (reduced()) return
    root.classList.remove('moving')
    void root.offsetWidth
    root.classList.add('moving')
  }
  const commit = (index: number, felt: boolean): void => {
    at = index
    d.show(at, false)
    d.land(at, true)
    stretch()
    // A drag already clicked when it crossed onto this stop; a second click on release is one
    // too many under a finger.
    if (!felt) haptic('alignment')
    d.pick(at)
  }
  const choose = (wanted: number, felt = false): void => {
    const index = clamp(wanted, d.count())
    if (index === at) {
      d.show(at, false)
      return
    }
    const answer = (ok: boolean): void => {
      if (ok) commit(index, false)
      else d.show(at, false)
    }
    if (d.guard && !d.guard(index, answer)) {
      d.show(at, false)
      return
    }
    commit(index, felt)
  }
  const end = (): void => {
    press = undefined
    dragging = false
    near = undefined
    root.classList.remove('pressing', 'dragging')
  }
  const x = (event: PointerEvent): number => stopAt(event.clientX, d.row(), d.count(), d.inset)

  root.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || d.count() === 0) return
    press = { id: event.pointerId, from: event.clientX }
    near = at
    try {
      root.setPointerCapture(event.pointerId)
    } catch {
      // A pointer the browser no longer knows. The drag still works while it stays inside.
    }
    root.classList.add('pressing')
    d.show(at, false)
  })
  root.addEventListener('pointermove', (event) => {
    if (press?.id !== event.pointerId) return
    if (!dragging && Math.abs(event.clientX - press.from) < 3) return
    dragging = true
    root.classList.add('dragging')
    const here = x(event)
    d.show(here, true)
    const stop = Math.round(here)
    if (stop !== near) {
      near = stop
      haptic('alignment')
    }
  })
  root.addEventListener('pointerup', (event) => {
    if (press?.id !== event.pointerId) return
    const stop = Math.round(x(event))
    const felt = dragging && near === stop
    released = performance.now()
    end()
    choose(stop, felt)
  })
  root.addEventListener('pointercancel', () => {
    end()
    d.show(at, false)
  })
  root.addEventListener('keydown', (event) => {
    const to = keyStep(event.key, at, d.count(), d.slider)
    if (to === undefined) return
    event.preventDefault()
    choose(to)
  })

  return {
    set: (index) => {
      at = clamp(index, d.count())
      d.show(at, false)
      d.land(at, false)
    },
    clicked: (index) => {
      if (performance.now() - released > 400) choose(index)
    },
    at: () => at,
  }
}

// ---- Apple's glass ----------------------------------------------------------------------

/** What a switch needs to know about the page around it. */
export interface Around {
  /** True while something is laid over the rail — a sheet, the palette. Apple's glass is not
      part of the page, so it would float on top of them; it hides instead. */
  covered: () => boolean
}

type Box = { left: number; top: number; width: number; height: number }

/** Whether `box` is wholly on screen inside `clip` — not scrolled out of the rail. */
export const inside = (box: Box, clip: Box): boolean =>
  box.width > 0 &&
  box.height > 0 &&
  box.left >= clip.left - 1 &&
  box.top >= clip.top - 1 &&
  box.left + box.width <= clip.left + clip.width + 1 &&
  box.top + box.height <= clip.top + clip.height + 1

/**
 * One of Apple's glasses, for one switch. `lay` puts it over `box`; a spring when the choice
 * changed, at once while a finger drags. It hides whenever it could not be where it belongs.
 * A shell that answers *no* while it should be showing means this Mac cannot after all, and
 * `failed` hands the switch back to Alexia's own glass.
 */
function appleGlass(id: string, root: HTMLElement, around: Around, style: Glass['style'], failed: () => void) {
  let on = false
  const lay = (box: Box, symbol: string, how: 'spring' | 'now', tint?: Glass['tint']): void => {
    if (!on) return
    const clip = root.closest<HTMLElement>('.panel')?.getBoundingClientRect() ?? box
    const visible = !around.covered() && inside(box, clip)
    const spring = how === 'spring' && !reduced()
    void glass(id, {
      box,
      radius: box.height / 2,
      style,
      visible,
      durationMs: how === 'now' ? 0 : spring ? SPRING_MS : 160,
      spring,
      symbol,
      ...(tint && { tint }),
    }).then((ok) => {
      if (!ok && visible && on) failed()
    })
  }
  const box0 = { left: 0, top: 0, width: 0, height: 0 }
  return {
    lay,
    get on() {
      return on
    },
    set on(yes: boolean) {
      if (on && !yes) void glass(id, { box: box0, radius: 0, style, visible: false, durationMs: 0 })
      on = yes
    },
  }
}

/** Two of these on the rail. `value` is set from core; `change` fires when a person chooses. */
export interface Switcher extends EventTarget {
  value: string
  /** Apple's glass (`true`) or Alexia's own. */
  native: (on: boolean) => void
  /** Lay Apple's glass again, because the page moved under it. */
  place: () => void
}

interface Parts {
  read: () => string
  write: (value: string) => void
  native: (on: boolean) => void
  place: () => void
}

/** The `Switcher` a caller holds: an event target with the switch's value on it. */
class Switch extends EventTarget implements Switcher {
  readonly native: (on: boolean) => void
  readonly place: () => void
  readonly #parts: Parts
  constructor(parts: Parts) {
    super()
    this.#parts = parts
    this.native = parts.native
    this.place = parts.place
  }
  get value(): string {
    return this.#parts.read()
  }
  set value(value: string) {
    this.#parts.write(value)
  }
}

/** Swap a line of text with a short fade, so a new word does not simply blink in. */
function swapText(el: HTMLElement, text: string, animate: boolean): void {
  if (el.textContent === text) return
  if (!animate || reduced()) {
    el.textContent = text
    return
  }
  el.classList.add('swap')
  setTimeout(() => {
    el.textContent = text
    el.classList.remove('swap')
  }, 140)
}

// ---- How she runs -----------------------------------------------------------------------

/**
 * *How she runs*: three icons in a track and a glass pill over the chosen one, the chosen
 * word small underneath and its sentence under that. A radio group to the keyboard and to a
 * screen reader — each icon is a radio named by its word.
 */
export function mountModeSwitch(host: HTMLElement, around: Around): Switcher {
  const labelled = host.getAttribute('aria-labelledby') ?? ''
  host.removeAttribute('aria-labelledby')
  host.innerHTML =
    `<div class="pill-switch" role="radiogroup" aria-labelledby="${labelled}">` +
    '<span class="thumb" aria-hidden="true"></span>' +
    MODES.map(
      (mode) =>
        `<button type="button" role="radio" aria-checked="false" tabindex="-1" aria-label="${mode.name}" data-value="${mode.value}">` +
        `${svg(mode.off, 'off')}${svg(mode.on, 'on')}</button>`,
    ).join('') +
    '</div><p class="pill-word" aria-hidden="true"></p><p class="pill-means"></p>'
  const seg = host.querySelector<HTMLElement>('.pill-switch')!
  const thumb = seg.querySelector<HTMLElement>('.thumb')!
  const word = host.querySelector<HTMLElement>('.pill-word')!
  const means = host.querySelector<HTMLElement>('.pill-means')!
  const buttons = [...seg.querySelectorAll<HTMLButtonElement>('button')]

  const lens = mountLens(seg, () => (seg.classList.contains('native') ? undefined : thumb.getBoundingClientRect()), {
    blur: 5,
    mix: 0.18,
    pressed: () => seg.classList.contains('pressing'),
  })
  if (!lens) seg.classList.add('no-gl')

  /** Where the pill is at stop `x`: one cell, slid along by whole cells. */
  const boxAt = (x: number): Box => {
    const first = buttons[0]!.getBoundingClientRect()
    const step = buttons.length > 1 ? buttons[1]!.getBoundingClientRect().left - first.left : 0
    return { left: first.left + x * step, top: first.top, width: first.width, height: first.height }
  }
  let shown = 0
  // Built last, once everything it reads exists; the glass and the drive reach it through here.
  const self: { switcher?: Switch } = {}
  const apple = appleGlass('mode-pill', seg, around, 'clear', () => self.switcher?.native(false))

  const show = (x: number, dragging: boolean): void => {
    shown = x
    seg.style.setProperty('--at', String(x))
    const under = Math.round(x)
    buttons.forEach((button, i) => {
      button.style.setProperty('--near', String(nearness(i, x)))
      button.toggleAttribute('data-under', i === under)
    })
    if (lens) {
      lens.hold(dragging)
      if (!dragging) lens.run(SPRING_MS + 120)
    }
    apple.lay(boxAt(x), MODES[under]!.symbol, dragging ? 'now' : 'spring')
  }
  const land = (index: number, moved: boolean): void => {
    buttons.forEach((button, i) => {
      button.setAttribute('aria-checked', String(i === index))
      button.tabIndex = i === index ? 0 : -1
    })
    swapText(word, MODES[index]!.name, moved)
    swapText(means, MODES[index]!.means, moved)
  }
  const driving = drive({
    root: seg,
    count: () => MODES.length,
    slider: false,
    row: () => seg.getBoundingClientRect(),
    inset: 0,
    show,
    land,
    pick: (index) => {
      // Roving focus: the chosen radio is the one the keyboard is on.
      if (seg.contains(document.activeElement)) buttons[index]!.focus()
      self.switcher?.dispatchEvent(new Event('change'))
    },
  })

  // A screen reader presses a radio with a click and no pointer behind it.
  buttons.forEach((button, i) => {
    button.addEventListener('click', () => driving.clicked(i))
  })

  const switcher = (self.switcher = new Switch({
    read: () => MODES[driving.at()]!.value,
    write: (value) => {
      const index = MODES.findIndex((mode) => mode.value === value)
      if (index >= 0) driving.set(index)
    },
    native: (on) => {
      apple.on = on
      seg.classList.toggle('native', on)
      if (on) apple.lay(boxAt(shown), MODES[Math.round(shown)]!.symbol, 'now')
      else lens?.draw()
    },
    place: () => {
      apple.lay(boxAt(shown), MODES[Math.round(shown)]!.symbol, 'now')
      lens?.draw()
    },
  }))
  driving.set(1)
  return switcher
}

// ---- What she may do --------------------------------------------------------------------

/** One permission level, as core names it and main.ts explains it. */
export interface Level {
  value: string
  name: string
  means: string
}

export interface LevelSwitcher extends Switcher {
  /** The levels, in order from careful to free. Core's own list, filled once it answers. */
  levels: (list: Level[]) => void
}

/** Which colour the line warms to: caution for *watch*, danger for *full trust*. */
export const toneOf = (value: string | undefined): string =>
  value === 'full-trust' ? 'danger' : value === 'watch' ? 'caution' : 'calm'

/** The knob's size, and how far in the first and last stop sit (the knob's half). */
const KNOB = 28

/**
 * *What she may do*: four stops on a line from careful to free, an icon over each, a glass
 * knob on the chosen one, and the line filling towards it — warmer the freer it gets. The
 * level's full name and sentence sit underneath. A slider to the keyboard and to a screen
 * reader, whose value is read out by name.
 *
 * **Full trust asks first**, in place — *Turn on full trust? [Turn it on] [Keep asking]* —
 * and nothing changes until it is answered. Not `confirm()`, which stops the whole window.
 */
export function mountLevelSlider(host: HTMLElement, around: Around): LevelSwitcher {
  const labelled = host.getAttribute('aria-labelledby') ?? ''
  host.removeAttribute('aria-labelledby')
  host.innerHTML =
    `<div class="level-slider" role="slider" tabindex="0" aria-labelledby="${labelled}" aria-valuemin="0">` +
    '<div class="level-stops" aria-hidden="true"></div>' +
    '<div class="level-track" aria-hidden="true"><span class="bar"></span><span class="fill"></span>' +
    '<span class="dots"></span><span class="knob"></span></div></div>' +
    '<p class="level-name" aria-hidden="true"></p><p class="level-means"></p>'
  const slider = host.querySelector<HTMLElement>('.level-slider')!
  const stops = slider.querySelector<HTMLElement>('.level-stops')!
  const track = slider.querySelector<HTMLElement>('.level-track')!
  const dots = track.querySelector<HTMLElement>('.dots')!
  const knob = track.querySelector<HTMLElement>('.knob')!
  const name = host.querySelector<HTMLElement>('.level-name')!
  const means = host.querySelector<HTMLElement>('.level-means')!

  let list: Level[] = []
  let icons: HTMLElement[] = []
  let shown = 0
  let wanted: string | undefined
  // Built last, once everything it reads exists; the glass and the drive reach it through here.
  const self: { switcher?: Switch } = {}

  const lens = mountLens(track, () => (slider.classList.contains('native') ? undefined : knob.getBoundingClientRect()), {
    blur: 4,
    mix: 0.15,
    pressed: () => slider.classList.contains('pressing'),
  })
  if (!lens) slider.classList.add('no-gl')

  const boxAt = (x: number): Box => {
    const row = track.getBoundingClientRect()
    const span = list.length > 1 ? (row.width - KNOB) / (list.length - 1) : 0
    return { left: row.left + x * span, top: row.top + (row.height - KNOB) / 2, width: KNOB, height: KNOB }
  }
  const iconOf = (value: string | undefined): { icon: string; symbol: string } =>
    (value !== undefined && LEVEL_ICONS[value]) || UNKNOWN_LEVEL
  const tint = (value: string | undefined): Glass['tint'] => {
    if (value !== 'full-trust') return undefined
    const [r, g, b] = rgba(getComputedStyle(slider).getPropertyValue('--danger').trim() || 'red').map((n) => Math.round(n * 255))
    return `rgba(${String(r)}, ${String(g)}, ${String(b)}, 0.45)`
  }
  const apple = appleGlass('perm-knob', slider, around, 'regular', () => self.switcher?.native(false))
  const layApple = (x: number, how: 'spring' | 'now'): void => {
    const value = list[Math.round(x)]?.value
    if (list.length > 0) apple.lay(boxAt(x), iconOf(value).symbol, how, tint(value))
  }

  const show = (x: number, dragging: boolean): void => {
    shown = x
    slider.style.setProperty('--at', String(x))
    const under = Math.round(x)
    slider.dataset.tone = toneOf(list[under]?.value)
    icons.forEach((icon, i) => icon.style.setProperty('--near', String(nearness(i, x))))
    if (lens) {
      lens.hold(dragging)
      if (!dragging) lens.run(SPRING_MS + 120)
    }
    layApple(x, dragging ? 'now' : 'spring')
  }
  const land = (index: number, moved: boolean): void => {
    const level = list[index]
    if (!level) return
    slider.setAttribute('aria-valuenow', String(index))
    slider.setAttribute('aria-valuetext', level.name)
    icons.forEach((icon, i) => icon.toggleAttribute('data-on', i === index))
    slider.dataset.level = level.value
    swapText(name, level.name, moved)
    swapText(means, level.means, moved)
  }

  /** The question before Full trust, under the slider. One at a time. */
  const askFirst = (index: number, answer: (ok: boolean) => void): boolean => {
    if (list[index]?.value !== 'full-trust') return true
    host.querySelector('.level-ask')?.remove()
    const box = document.createElement('div')
    box.className = 'level-ask'
    box.setAttribute('role', 'group')
    box.setAttribute('aria-label', 'Turn on full trust?')
    box.innerHTML =
      '<p>Turn on full trust? Nothing will ask you first.</p>' +
      '<div class="row"><button class="yes" type="button">Turn it on</button><button class="no" type="button">Keep asking</button></div>'
    const settle = (ok: boolean): void => {
      box.remove()
      slider.focus()
      answer(ok)
    }
    box.querySelector('.yes')!.addEventListener('click', () => settle(true))
    box.querySelector('.no')!.addEventListener('click', () => settle(false))
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') settle(false)
    })
    host.append(box)
    box.querySelector<HTMLButtonElement>('.no')!.focus()
    return false
  }

  const driving = drive({
    root: slider,
    count: () => list.length,
    slider: true,
    row: () => track.getBoundingClientRect(),
    inset: KNOB / 2,
    show,
    land,
    guard: askFirst,
    pick: () => self.switcher?.dispatchEvent(new Event('change')),
  })

  const put = (value: string): void => {
    wanted = value
    const index = list.findIndex((level) => level.value === value)
    if (index < 0) return
    // Core's answer settles any question still open: it is no longer the one on the table.
    host.querySelector('.level-ask')?.remove()
    driving.set(index)
  }

  const switcher = (self.switcher = new Switch({
    read: () => list[driving.at()]?.value ?? wanted ?? '',
    write: put,
    native: (on) => {
      apple.on = on
      slider.classList.toggle('native', on)
      if (on) layApple(shown, 'now')
      else lens?.draw()
    },
    place: () => {
      layApple(shown, 'now')
      lens?.draw()
    },
  }))

  const levels = (next: Level[]): void => {
    list = next
    slider.style.setProperty('--n', String(Math.max(2, list.length)))
    slider.setAttribute('aria-valuemax', String(list.length - 1))
    stops.innerHTML = list
      .map((level, i) => `<span style="--i:${String(i)}" data-value="${level.value}" title="${level.name}">${svg(iconOf(level.value).icon, 'icon')}</span>`)
      .join('')
    dots.innerHTML = list.map((_, i) => `<span class="dot" style="--i:${String(i)}"></span>`).join('')
    icons = [...stops.querySelectorAll<HTMLElement>('span')]
    if (wanted !== undefined) put(wanted)
  }

  return Object.assign(switcher, { levels })
}

/** A copy of the choice, for a core too old to keep it. Core's answer wins when it has one. */
export const REMEMBERED_LOOK = 'alexia.glassLook'

/** The sentence under *Glass look*: what is in use, and why when it is not what was asked. */
export function lookSaid(look: GlassLook, supported: boolean): string {
  if (useApple(look, supported)) return 'The switches on the left are Apple’s own glass.'
  if (look === 'alexia') return 'The switches on the left are Alexia’s own glass.'
  return 'Alexia’s own glass. Apple glass needs macOS 26 or later.'
}

/**
 * Settings › General › *Glass look*: Automatic, Apple glass or Alexia glass. Automatic is
 * Apple's wherever this Mac can draw it. Apple glass stays in the list where it cannot, greyed
 * out with the reason beside it, because an option that vanishes is one nobody can ask about.
 */
export function mountGlassLook(
  chosen: string | undefined,
  switchers: Switcher[],
  supported: Promise<boolean>,
  keep: (look: GlassLook) => void,
): void {
  let remembered: string | null = null
  try {
    remembered = localStorage.getItem(REMEMBERED_LOOK)
  } catch {
    // Storage can be off. Automatic is a fine answer until core has one.
  }
  let look: GlassLook = isGlassLook(chosen) ? chosen : isGlassLook(remembered) ? remembered : 'auto'
  let can = false
  const select = document.querySelector<HTMLSelectElement>('#glass-look')
  const said = document.querySelector<HTMLElement>('#glass-look-said')
  const apply = (): void => {
    const apple = useApple(look, can)
    for (const one of switchers) one.native(apple)
    if (said) said.textContent = lookSaid(look, can)
  }
  if (select) {
    select.value = look
    select.addEventListener('change', () => {
      if (!isGlassLook(select.value)) return
      look = select.value
      try {
        localStorage.setItem(REMEMBERED_LOOK, look)
      } catch {
        // A copy. Core has the real one.
      }
      apply()
      keep(look)
    })
  }
  apply()
  void supported.then((yes) => {
    can = yes
    const apple = select?.querySelector<HTMLOptionElement>('option[value="apple"]')
    if (apple) {
      apple.disabled = !yes
      apple.textContent = yes ? 'Apple glass' : 'Apple glass — needs macOS 26 or later'
    }
    apply()
  })
}

/**
 * Keep Apple's glass where it belongs as the page moves: a resize, the rail scrolling or
 * changing size (a list opening above the switches), a sheet or the palette opening over it.
 */
export function keepPlaced(switchers: Switcher[], rail: HTMLElement): void {
  const place = (): void => switchers.forEach((one) => one.place())
  // Anything above the switches that grows moves them without resizing them, so every row
  // of the rail is watched, not only the switches.
  const sizes = new ResizeObserver(place)
  sizes.observe(rail)
  for (const row of rail.querySelectorAll(':scope > *, .rail-group > *, #rail-setup > *')) sizes.observe(row)
  new MutationObserver(place).observe(document.body, { attributes: true, attributeFilter: ['data-view'] })
  const palette = document.querySelector('#palette')
  if (palette) new MutationObserver(place).observe(palette, { attributes: true, attributeFilter: ['hidden'] })
  // The rail is a page on the board: dragged by its grip (`style`), packed somewhere else, or
  // scrolled with the board. A move that animates is placed again once it has arrived.
  new MutationObserver(place).observe(rail, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] })
  rail.addEventListener('transitionend', (event) => {
    if (event.target === rail) place()
  })
  addEventListener('resize', place)
  document.addEventListener('scroll', place, { capture: true, passive: true })
}
