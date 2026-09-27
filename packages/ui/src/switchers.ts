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
 * **The glass melts from one choice to the next** (`glide`). Its two edges are on two springs:
 * the one in front leaves quickly and goes a hair past the mark, the one behind follows on
 * Expo's slower spring. So the glass stretches to span both choices, squashed a little the
 * other way like a drop, and gathers itself into the new one. Under reduced motion both edges
 * move together, briefly, with no stretch.
 *
 * **One clock for everything that moves.** The glide steps once a frame and in that frame puts
 * the page's glass (`transform` only — nothing here animates `left` or `width`), the icons'
 * nearness, the line's fill, Alexia's lens and Apple's glass all in the same place. They used
 * to move on their own: a CSS transition on the compositor, a lens reading the layout behind
 * it a frame late, and Apple's glass animating itself, cut short whenever the page moved.
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

// ---- the glide ------------------------------------------------------------------------

/** How a spring moves: `ms` until it is still, at damping `ratio` (below 1 goes past a little). */
export interface Motion {
  ms: number
  ratio: number
}

/** The edge in front: quick, and a little past the mark. */
export const LEAD: Motion = { ms: 300, ratio: 0.72 }
/** The edge behind: Expo's glass tabs. */
export const TRAIL: Motion = { ms: SPRING_MS, ratio: SPRING_RATIO }
/** Reduced motion: a short slide, both edges together, nothing past the mark. */
export const PLAIN: Motion = { ms: 160, ratio: 1 }
/** The swell under a press. */
const SWELL: Motion = { ms: 200, ratio: 1 }

/** One damped spring, stepped by the frame. The same sum as `springCurve`, one step at a time. */
export class Spring {
  value: number
  target: number
  velocity = 0
  motion: Motion = TRAIL
  constructor(value = 0) {
    this.value = value
    this.target = value
  }
  step(seconds: number): void {
    const { ms, ratio } = this.motion
    const omega = Math.log(1000) / (ratio * (ms / 1000))
    // Small fixed steps, so a slow frame is the same curve and never a spring that flies off.
    for (let left = seconds; left > 1e-9; left -= 1 / 240) {
      const h = Math.min(left, 1 / 240)
      this.velocity += (-omega * omega * (this.value - this.target) - 2 * ratio * omega * this.velocity) * h
      this.value += this.velocity * h
    }
  }
  get still(): boolean {
    return Math.abs(this.value - this.target) < 0.05 && Math.abs(this.velocity) < 3
  }
  settle(): void {
    this.value = this.target
    this.velocity = 0
  }
}

/** How far a stretched glass narrows the other way, so it reads as a drop rather than a bar. */
export const squash = (sx: number): number => Math.min(1.06, Math.max(0.86, 1 / sx))

/** The glass this frame: its two edges and its swell, from the host's left, and its speed. */
export interface Frame {
  left: number
  right: number
  swell: number
  /** CSS pixels a second, for the rainbow at the rim. */
  speed: number
}

interface Glide {
  /** Edges to `left` and `right`: on the springs, or at once (a finger dragging, a first place). */
  to: (left: number, right: number, how: 'spring' | 'now') => void
  swell: (scale: number) => void
  /** Draw where it is, now: the page moved under it, or the glass changed. */
  redraw: () => void
}

/**
 * The glass's motion, and the one frame loop that draws it. Which edge leads is worked out per
 * move, from which way it goes. `root` carries `.gliding` while it springs, which takes the
 * CSS transitions off everything the frame already moves.
 */
function glide(root: HTMLElement, paint: (frame: Frame) => void): Glide {
  const lo = new Spring()
  const hi = new Spring()
  const size = new Spring(1)
  size.motion = SWELL
  let frame: number | undefined
  let clock = 0
  let jumped = false
  let placed = false
  let drawn = { at: 0, center: Number.NaN }
  const draw = (time: number, speed: number): void => {
    drawn = { at: time, center: (lo.value + hi.value) / 2 }
    paint({ left: lo.value, right: hi.value, swell: size.value, speed })
  }
  const tick = (time: number): void => {
    frame = undefined
    const seconds = Math.min(0.05, Math.max(0, (time - clock) / 1000))
    clock = time
    for (const one of [lo, hi, size]) one.step(seconds)
    const still = lo.still && hi.still && size.still
    if (still) for (const one of [lo, hi, size]) one.settle()
    const since = Math.max(1 / 240, Math.min(0.05, (time - drawn.at) / 1000))
    const moved = Math.abs((lo.value + hi.value) / 2 - drawn.center)
    // A frame where nothing moved is drawn with no speed, so the rainbow never stays on at rest.
    draw(time, Number.isNaN(moved) ? 0 : moved / since)
    const again = !still || jumped
    jumped = false
    if (again) frame = requestAnimationFrame(tick)
    else root.classList.remove('gliding')
  }
  const wake = (): void => {
    if (frame !== undefined) return
    clock = performance.now()
    frame = requestAnimationFrame(tick)
  }
  return {
    to: (left, right, how) => {
      lo.target = left
      hi.target = right
      if (how === 'now' || !placed) {
        // Nothing to glide from before the switch has a size: it appears where it belongs.
        placed = right > left
        lo.settle()
        hi.settle()
        jumped = true
        wake()
        return
      }
      const quiet = reduced()
      const ahead = (left + right) / 2 >= (lo.value + hi.value) / 2 ? hi : lo
      ahead.motion = quiet ? PLAIN : LEAD
      ;(ahead === hi ? lo : hi).motion = quiet ? PLAIN : TRAIL
      if (!lo.still || !hi.still || lo.value !== left || hi.value !== right) root.classList.add('gliding')
      wake()
    },
    swell: (scale) => {
      const to = reduced() ? 1 : scale
      if (size.target === to) return
      size.target = to
      wake()
    },
    redraw: () => draw(performance.now(), 0),
  }
}

/**
 * Apple's glass for one frame of the glide: stretched with it, but neither squashed nor
 * swollen. The shell draws the symbol once, at the height it is first sent with (`glass.rs`),
 * so a symbol first sent mid-squash would stay small. In the window's pixels.
 */
const appleBox = (host: { left: number; top: number }, left: number, right: number, top: number, height: number) =>
  (): Box => ({ left: host.left + left, top: host.top + top, width: right - left, height })

/** A number for a style, short: `transform` is written every frame. */
const n3 = (value: number): string => String(Math.round(value * 1000) / 1000)

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
  /**
   * Hold a move back (Full trust is held to, not clicked). False while held; the guard then
   * draws the glass itself, and moves it later with `Driving.commit` or back with `show`.
   * `via` is what asked: a key, or a pointer being let go.
   */
  guard?: (index: number, via: 'key' | 'pointer') => boolean
  /** Where a pressed pointer is, as a fraction of stops, on every move; `undefined` once let go. */
  arm?: (x: number | undefined) => void
  /** A person chose `index`. */
  pick: (index: number) => void
}

/** What the trackpad does when a choice lands: a click, the firmer *level* click, or nothing. */
type Feel = 'alignment' | 'level' | 'none'

interface Driving {
  /** Show `index` without it counting as a choice: core's answer, or a focus-refresh. */
  set: (index: number) => void
  /**
   * A click on stop `index` that no pointer made — a screen reader pressing it, or a script.
   * A pointer's own click follows its release, which has already chosen, so it is let pass.
   */
  clicked: (index: number) => void
  /** Make `index` the choice now, past any guard — the guard's own yes. */
  commit: (index: number, feel: Feel) => void
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

  const commit = (index: number, feel: Feel): void => {
    at = index
    d.show(at, false)
    d.land(at, true)
    if (feel !== 'none') haptic(feel)
    d.pick(at)
  }
  const choose = (wanted: number, via: 'key' | 'pointer', felt = false): void => {
    const index = clamp(wanted, d.count())
    if (index === at) {
      d.show(at, false)
      return
    }
    if (d.guard && !d.guard(index, via)) return
    // A drag already clicked when it crossed onto this stop; a second click on release is one
    // too many under a finger.
    commit(index, felt ? 'none' : 'alignment')
  }
  const end = (): void => {
    press = undefined
    dragging = false
    near = undefined
    root.classList.remove('pressing', 'dragging')
    d.arm?.(undefined)
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
    d.arm?.(x(event))
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
    d.arm?.(here)
  })
  root.addEventListener('pointerup', (event) => {
    if (press?.id !== event.pointerId) return
    const stop = Math.round(x(event))
    const felt = dragging && near === stop
    released = performance.now()
    end()
    choose(stop, 'pointer', felt)
  })
  root.addEventListener('pointercancel', () => {
    end()
    d.show(at, false)
  })
  root.addEventListener('keydown', (event) => {
    const to = keyStep(event.key, at, d.count(), d.slider)
    if (to === undefined) return
    event.preventDefault()
    choose(to, 'key')
  })

  return {
    set: (index) => {
      at = clamp(index, d.count())
      d.show(at, false)
      d.land(at, false)
    },
    clicked: (index) => {
      if (performance.now() - released > 400) choose(index, 'key')
    },
    commit,
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
 * One of Apple's glasses, for one switch. `lay` puts it over `box`. The switches lay it at once,
 * every frame their glide moves (`glide`), so Apple's glass melts along the same curve as the
 * page's rather than on an animation of the shell's own — which the next move of the page cut
 * short, and which could not stretch. It hides whenever it could not be where it belongs.
 * A shell that answers *no* while it should be showing means this Mac cannot after all, and
 * `failed` hands the switch back to Alexia's own glass.
 *
 * **At most once a frame.** A finger dragging on a trackpad sends far more moves than the
 * screen draws, and each call crosses to the shell and moves an AppKit view on the main thread
 * — the thread the page is drawn on too. So `lay` only notes where the glass should go, and one
 * call a frame sends the latest. Measuring waits for that frame as well.
 *
 * `root` carries `.placed` while the glass is really there — the shell said yes and it is
 * showing — and only then does the page's own icon under it step aside (app.css).
 */
function appleGlass(id: string, root: HTMLElement, around: Around, style: Glass['style'], failed: () => void) {
  let on = false
  let wanted: { box: () => Box; symbol: string; how: 'spring' | 'now'; tint?: Glass['tint'] } | undefined
  let frame: number | undefined
  /** Which call is the latest, so an answer that arrives late does not undo a newer one. */
  let sent = 0
  const placed = (yes: boolean): void => {
    root.classList.toggle('placed', yes)
  }
  const send = (): void => {
    frame = undefined
    const next = wanted
    wanted = undefined
    if (!on || !next) return
    const box = next.box()
    const clip = root.closest<HTMLElement>('.panel')?.getBoundingClientRect() ?? box
    const visible = !around.covered() && inside(box, clip)
    const spring = next.how === 'spring' && !reduced()
    const call = (sent += 1)
    void glass(id, {
      box,
      radius: box.height / 2,
      style,
      visible,
      durationMs: next.how === 'now' ? 0 : spring ? SPRING_MS : 160,
      spring,
      // A glass with no size yet (the rail before its first layout) is sent no symbol: the
      // shell draws a symbol once, at the size of the glass it is given, and keeps it until the
      // name changes — one drawn at nothing would stay at nothing. Sent with every call after.
      ...(box.width > 0 && box.height > 0 && { symbol: next.symbol }),
      ...(next.tint && { tint: next.tint }),
    }).then((ok) => {
      if (call !== sent || !on) return
      placed(ok && visible)
      if (!ok && visible) failed()
    })
  }
  const lay = (box: () => Box, symbol: string, how: 'spring' | 'now', tint?: Glass['tint']): void => {
    if (!on) return
    // A spring stays a spring when a re-placing (`place`, which is at once) lands in the same
    // frame after it; otherwise the jump would cut the spring short.
    const kind = wanted?.how === 'spring' ? 'spring' : how
    wanted = { box, symbol, how: kind, ...(tint && { tint }) }
    frame ??= requestAnimationFrame(send)
  }
  const box0 = { left: 0, top: 0, width: 0, height: 0 }
  return {
    lay,
    get on() {
      return on
    },
    set on(yes: boolean) {
      if (on && !yes) {
        if (frame !== undefined) cancelAnimationFrame(frame)
        frame = undefined
        wanted = undefined
        sent += 1
        void glass(id, { box: box0, radius: 0, style, visible: false, durationMs: 0 })
        placed(false)
      }
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

/** How long a new choice's name stays up before it fades: long enough to read, then gone. */
export const SAID_MS = 5000

/**
 * The name of a choice just made, shown on its own stop (`data-said`, app.css pops it in) and
 * taken away again after `SAID_MS`. The names are otherwise hidden; a hover, a drag or keyboard
 * focus shows them too, in CSS.
 */
function sayer(): (items: HTMLElement[], index: number) => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  return (items, index) => {
    clearTimeout(timer)
    items.forEach((item, i) => item.toggleAttribute('data-said', i === index))
    timer = setTimeout(() => items[index]?.removeAttribute('data-said'), SAID_MS)
  }
}

// ---- How she runs -----------------------------------------------------------------------

/**
 * *How she runs*: three icons in a track and a glass pill over the chosen one. Each icon's
 * word sits inside the track under it, hidden until a hover, a drag or the keyboard is on it,
 * or for a few seconds after it is chosen (`sayer`). What each mode means is said on Settings ›
 * Models & money, not here. A radio group to the keyboard and to a screen reader — each icon is
 * a radio named by its word.
 */
export function mountModeSwitch(host: HTMLElement, around: Around): Switcher {
  const labelled = host.getAttribute('aria-labelledby') ?? ''
  host.removeAttribute('aria-labelledby')
  host.innerHTML =
    `<div class="pill-switch" role="radiogroup" aria-labelledby="${labelled}">` +
    '<span class="thumb" aria-hidden="true"></span>' +
    MODES.map(
      (mode) =>
        // Classed, so the plain button's hover fill never reaches it (app.css, *buttons*).
        `<button class="pill-cell" type="button" role="radio" aria-checked="false" tabindex="-1" aria-label="${mode.name}" data-value="${mode.value}">` +
        `<span class="pill-icon">${svg(mode.off, 'off')}${svg(mode.on, 'on')}</span>` +
        `<span class="pill-title" aria-hidden="true">${mode.name}</span></button>`,
    ).join('') +
    '</div>'
  const seg = host.querySelector<HTMLElement>('.pill-switch')!
  const thumb = seg.querySelector<HTMLElement>('.thumb')!
  const buttons = [...seg.querySelectorAll<HTMLButtonElement>('button')]
  const say = sayer()

  /** The pill as drawn this frame, from the track's top left: what the lens bends. */
  let shape: Box | undefined
  const lens = mountLens(seg, () => (seg.classList.contains('native') ? undefined : shape), {
    mix: 0.18,
    pressed: () => seg.classList.contains('pressing'),
  })
  if (!lens) seg.classList.add('no-gl')

  /**
   * Where the cells are, read when a move starts or the page moves — never per frame. The pill
   * is one cell wide and slides by whole cells; `host` is where the track is in the window.
   */
  let geo = { host: { left: 0, top: 0 }, left: 0, top: 0, width: 0, height: 0, step: 0 }
  const measure = (): void => {
    const box = seg.getBoundingClientRect()
    const first = buttons[0]!.getBoundingClientRect()
    const step = buttons.length > 1 ? buttons[1]!.getBoundingClientRect().left - first.left : 0
    geo = { host: { left: box.left, top: box.top }, left: first.left - box.left, top: first.top - box.top, width: first.width, height: first.height, step }
    lens?.measure()
  }
  let shown = 0
  // Built last, once everything it reads exists; the glass and the drive reach it through here.
  const self: { switcher?: Switch } = {}
  const apple = appleGlass('mode-pill', seg, around, 'clear', () => self.switcher?.native(false))

  let under = -1
  const paint = (frame: Frame): void => {
    if (geo.width <= 0) return
    const home = geo.left + geo.width / 2
    const center = (frame.left + frame.right) / 2
    const sx = (frame.right - frame.left) / geo.width
    const sy = squash(sx)
    thumb.style.transform = `translate(${n3(center - home)}px, 0) scale(${n3(sx * frame.swell)}, ${n3(sy * frame.swell)})`
    const width = (frame.right - frame.left) * frame.swell
    const height = geo.height * sy * frame.swell
    shape = { left: center - width / 2, top: geo.top + (geo.height - height) / 2, width, height }
    // The icons light by how near the glass is, frame by frame, as Expo's tabs do.
    const x = geo.step > 0 ? (center - home) / geo.step : 0
    buttons.forEach((button, i) => button.style.setProperty('--near', n3(nearness(i, x))))
    const now = clamp(Math.round(x), buttons.length)
    if (now !== under) {
      under = now
      buttons.forEach((button, i) => button.toggleAttribute('data-under', i === now))
    }
    // One glass at a time: Apple's, stepped with this frame, or Alexia's own lens.
    if (apple.on) apple.lay(appleBox(geo.host, frame.left, frame.right, geo.top, geo.height), MODES[now]!.symbol, 'now')
    else lens?.draw(frame.speed / 1500 + (sx - 1))
  }
  const glass = glide(seg, paint)

  const show = (x: number, dragging: boolean): void => {
    measure()
    shown = x
    seg.style.setProperty('--at', String(x))
    const left = geo.left + x * geo.step
    glass.swell(seg.classList.contains('pressing') ? 1.04 : 1)
    glass.to(left, left + geo.width, dragging ? 'now' : 'spring')
  }
  // The rail laid out anew — shown for the first time, or resized: the pill goes where it now belongs.
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => show(shown, true)).observe(seg)
  const land = (index: number, moved: boolean): void => {
    buttons.forEach((button, i) => {
      button.setAttribute('aria-checked', String(i === index))
      button.tabIndex = i === index ? 0 : -1
    })
    if (moved) say(buttons, index)
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
      measure()
      glass.redraw()
    },
    place: () => {
      measure()
      glass.redraw()
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

/** How long Full trust is held before it is on: the ring round the knob takes this to close. */
export const HOLD_MS = 900

/** How long *Hold to turn on* stays under the triangle after a press let go too soon. */
export const HINT_MS = 2500

/** Once armed, how far a finger drifts back off the triangle, in stops, before the hold ends. */
export const HOLD_SLACK = 0.75

/**
 * *What she may do*: four stops on a line from careful to free, an icon over each, a glass
 * knob on the chosen one, and the line filling towards it — warmer the freer it gets. A stop's
 * name shows small under it on a hover, a drag or keyboard focus, and for a few seconds after
 * it is chosen; what each level means is said on Settings › Safety, not here. A slider to the
 * keyboard and to a screen reader, whose value is read out by name.
 *
 * **Full trust is held to, not clicked.** Bringing the knob to the warning triangle — a press
 * on it, a drag onto it, or End or → from the stop before — *arms* it there: the knob turns red
 * and a thin ring closes round it over `HOLD_MS` while the pointer or the key stays down. A
 * closed ring turns it on, with the trackpad's firmer click; letting go sooner springs the knob
 * back to where it was, and nothing changed. No question, no buttons, and nothing to answer
 * later. Not `confirm()` either, which stops the whole window.
 *
 * **A click has to teach the hold.** Let go early and the ring shows how far it got as it winds
 * back, and the name under the triangle says *Hold to turn on* for a moment (`HINT_MS`). A hold
 * once started is forgiving: a finger drifting towards Watch does not end it until it is
 * clearly on another stop, and core repeating the level that is still chosen (the window
 * coming to the front reads it again) does not end it either. It used to do both — a hold was
 * cancelled by the very click that brought the window forward, and restarted from nothing by
 * a finger wobbling on the line halfway between two stops.
 */
export function mountLevelSlider(host: HTMLElement, around: Around): LevelSwitcher {
  const labelled = host.getAttribute('aria-labelledby') ?? ''
  host.removeAttribute('aria-labelledby')
  const hint = `${host.id || 'level'}-hold`
  host.innerHTML =
    `<div class="level-slider" role="slider" tabindex="0" aria-labelledby="${labelled}" aria-describedby="${hint}" aria-valuemin="0">` +
    '<div class="level-stops" aria-hidden="true"></div>' +
    '<div class="level-track" aria-hidden="true"><span class="bar"><span class="fill"></span></span>' +
    '<span class="dots"></span><span class="knob"></span>' +
    '<svg class="hold" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18.5" pathLength="100"/></svg></div>' +
    '<div class="level-names" aria-hidden="true"></div></div>' +
    `<span class="visually-hidden" id="${hint}">Hold to turn on full trust.</span>`
  const slider = host.querySelector<HTMLElement>('.level-slider')!
  const stops = slider.querySelector<HTMLElement>('.level-stops')!
  const track = slider.querySelector<HTMLElement>('.level-track')!
  const dots = track.querySelector<HTMLElement>('.dots')!
  const knob = track.querySelector<HTMLElement>('.knob')!
  const namesRow = slider.querySelector<HTMLElement>('.level-names')!

  let list: Level[] = []
  let icons: HTMLElement[] = []
  let names: HTMLElement[] = []
  let shown = 0
  let wanted: string | undefined
  const say = sayer()
  // Built last, once everything it reads exists; the glass and the drive reach it through here.
  const self: { switcher?: Switch } = {}

  const fill = track.querySelector<HTMLElement>('.fill')!
  const ring = track.querySelector<SVGSVGElement>('.hold')!

  /** The knob as drawn this frame, from the line's top left: what the lens bends. */
  let shape: Box | undefined
  const lens = mountLens(track, () => (slider.classList.contains('native') ? undefined : shape), {
    mix: 0.15,
    pressed: () => slider.classList.contains('pressing'),
  })
  if (!lens) slider.classList.add('no-gl')

  /** Where the line is, read when a move starts or the page moves — never per frame. */
  let geo = { host: { left: 0, top: 0 }, span: 0 }
  const measure = (): void => {
    const row = track.getBoundingClientRect()
    geo = { host: { left: row.left, top: row.top }, span: list.length > 1 ? (row.width - KNOB) / (list.length - 1) : 0 }
    lens?.measure()
  }
  const iconOf = (value: string | undefined): { icon: string; symbol: string } =>
    (value !== undefined && LEVEL_ICONS[value]) || UNKNOWN_LEVEL
  /** Apple's glass leans red on the triangle. The colour is read once, not every frame. */
  let danger: Glass['tint']
  const tint = (value: string | undefined): Glass['tint'] => {
    if (value !== 'full-trust') return undefined
    if (danger) return danger
    const [r, g, b] = rgba(getComputedStyle(slider).getPropertyValue('--danger').trim() || 'red').map((n) => Math.round(n * 255))
    return (danger = `rgba(${String(r)}, ${String(g)}, ${String(b)}, 0.45)`)
  }
  const apple = appleGlass('perm-knob', slider, around, 'regular', () => self.switcher?.native(false))

  /** Full trust being held to: at which stop, by what, since when, and the ring's end. */
  let arming: { index: number; via: 'key' | 'pointer'; since: number; timer: ReturnType<typeof setTimeout> } | undefined
  const isTrust = (index: number): boolean => list[index]?.value === 'full-trust'

  let under = -1
  const paint = (frame: Frame): void => {
    if (list.length === 0) return
    const center = (frame.left + frame.right) / 2
    const sx = (frame.right - frame.left) / KNOB
    const sy = squash(sx)
    const dx = center - KNOB / 2
    knob.style.transform = `translate(${n3(dx)}px, 0) scale(${n3(sx * frame.swell)}, ${n3(sy * frame.swell)})`
    ring.style.transform = `translate(${n3(dx)}px, 0)`
    const x = geo.span > 0 ? dx / geo.span : 0
    fill.style.transform = `translateX(${n3((x / Math.max(1, list.length - 1) - 1) * 100)}%)`
    const width = (frame.right - frame.left) * frame.swell
    const height = KNOB * sy * frame.swell
    // The knob sits a pixel down the line (app.css), its middle on the line's.
    shape = { left: center - width / 2, top: 1 + (KNOB - height) / 2, width, height }
    icons.forEach((icon, i) => icon.style.setProperty('--near', n3(nearness(i, x))))
    const now = clamp(Math.round(x), list.length)
    if (now !== under) {
      under = now
      names.forEach((one, i) => one.toggleAttribute('data-under', i === now))
    }
    const value = list[now]?.value
    if (apple.on) apple.lay(appleBox(geo.host, frame.left, frame.right, 1, KNOB), iconOf(value).symbol, 'now', tint(value))
    else lens?.draw(frame.speed / 1500 + (sx - 1))
  }
  const glass = glide(slider, paint)

  const show = (x: number, dragging: boolean): void => {
    if (arming) {
      // The knob waits on the triangle while it is held; a finger still moving on it does not
      // pull it about.
      if (dragging) return
      x = arming.index
    }
    measure()
    shown = x
    slider.style.setProperty('--at', String(x))
    slider.dataset.tone = toneOf(list[Math.round(x)]?.value)
    glass.swell(slider.classList.contains('pressing') ? 1.14 : 1)
    const left = x * geo.span
    glass.to(left, left + KNOB, dragging ? 'now' : 'spring')
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => show(shown, true)).observe(track)
  const land = (index: number, moved: boolean): void => {
    const level = list[index]
    if (!level) return
    slider.setAttribute('aria-valuenow', String(index))
    slider.setAttribute('aria-valuetext', level.name)
    icons.forEach((icon, i) => icon.toggleAttribute('data-on', i === index))
    names.forEach((one, i) => one.toggleAttribute('data-on', i === index))
    slider.dataset.level = level.value
    if (moved) say(names, index)
  }

  /**
   * A hold let go too soon, taught: the ring winds back from as far as it got — a quarter at
   * least, so a click shows it too — and the triangle's name says what it wants for a moment.
   */
  let hinting: ReturnType<typeof setTimeout> | undefined
  const teach = (index: number, reached: number): void => {
    const from = 100 - Math.max(0.25, Math.min(1, reached)) * 100
    const back = { duration: 620, easing: 'cubic-bezier(0.55, 0, 0.45, 1)' }
    ring.querySelector('circle')?.animate?.([{ strokeDashoffset: String(from) }, { strokeDashoffset: '100' }], back)
    ring.animate?.([{ opacity: 1 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }], back)
    const name = names[index]
    if (!name) return
    clearTimeout(hinting)
    name.textContent = 'Hold to turn on'
    name.setAttribute('data-hint', '')
    hinting = setTimeout(() => {
      name.textContent = list[index]?.name ?? ''
      name.removeAttribute('data-hint')
    }, HINT_MS)
  }
  /** Stop holding. `back` springs the knob home to the level that is still the choice. */
  const disarm = (back: boolean): void => {
    if (!arming) return
    clearTimeout(arming.timer)
    const { index, since } = arming
    arming = undefined
    slider.classList.remove('arming')
    if (!back) return
    show(driving.at(), false)
    teach(index, (performance.now() - since) / HOLD_MS)
  }
  const startArming = (index: number, via: 'key' | 'pointer'): void => {
    if (arming?.index === index) return
    disarm(false)
    const timer = setTimeout(() => {
      arming = undefined
      slider.classList.remove('arming')
      driving.commit(index, 'level')
    }, HOLD_MS)
    arming = { index, via, since: performance.now(), timer }
    slider.classList.add('arming')
    show(index, false)
  }
  /** Every move is let through except onto Full trust, which is armed instead. */
  const guard = (index: number, via: 'key' | 'pointer'): boolean => {
    if (!isTrust(index)) {
      disarm(false)
      return true
    }
    if (via === 'key') startArming(index, 'key')
    // A pointer let go on the triangle before the ring closed (a closed ring has already chosen).
    else show(driving.at(), false)
    return false
  }
  /**
   * A pointer pressed on the triangle, or dragged onto it, arms it. Armed, it stays armed until
   * the pointer is let go or is clearly on another stop (`HOLD_SLACK`), so a finger wobbling on
   * the line between Watch and the triangle does not start the ring again and again.
   */
  const arm = (x: number | undefined): void => {
    if (arming?.via === 'pointer') {
      if (x === undefined) disarm(true)
      else if (x < arming.index - HOLD_SLACK) disarm(false)
      return
    }
    if (x === undefined) return
    const index = Math.round(x)
    if (isTrust(index) && driving.at() !== index) startArming(index, 'pointer')
  }

  // Keys held, for a hold made with the keyboard: End or → brought it there, and it stays armed
  // while that key — or Space or Enter — is down. Registered before the drive's own, so a key
  // that moves somewhere else lets go first.
  const held = new Set<string>()
  slider.addEventListener('keydown', (event) => {
    held.add(event.key)
    if (!arming) return
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
      return
    }
    const to = keyStep(event.key, driving.at(), list.length, true)
    if (to !== undefined && to !== arming.index) disarm(true)
  })
  slider.addEventListener('keyup', (event) => {
    held.delete(event.key)
    if (arming?.via === 'key' && held.size === 0) disarm(true)
  })
  slider.addEventListener('blur', () => {
    held.clear()
    if (arming?.via === 'key') disarm(true)
  })

  // A hover shows the name of the stop under the pointer, and brightens its icon.
  let hovered: number | undefined
  const hover = (index: number | undefined): void => {
    if (index === hovered) return
    hovered = index
    icons.forEach((icon, i) => icon.toggleAttribute('data-hover', i === index))
    names.forEach((one, i) => one.toggleAttribute('data-hover', i === index))
  }
  slider.addEventListener('pointermove', (event) => {
    if (list.length === 0 || slider.classList.contains('pressing')) return
    hover(Math.round(stopAt(event.clientX, track.getBoundingClientRect(), list.length, KNOB / 2)))
  })
  slider.addEventListener('pointerleave', () => hover(undefined))

  const driving = drive({
    root: slider,
    count: () => list.length,
    slider: true,
    row: () => track.getBoundingClientRect(),
    inset: KNOB / 2,
    show,
    land,
    guard,
    arm,
    pick: () => self.switcher?.dispatchEvent(new Event('change')),
  })

  const put = (value: string): void => {
    wanted = value
    const index = list.findIndex((level) => level.value === value)
    if (index < 0) return
    // Core repeating the level that is still chosen changes nothing, and must not end a hold
    // being made: the window reads it again whenever it comes to the front, which is exactly
    // what a press on a window in the back does.
    if (arming && index === driving.at()) return
    // Any other answer settles the hold: it is no longer the one on the table.
    disarm(false)
    driving.set(index)
  }

  const switcher = (self.switcher = new Switch({
    read: () => list[driving.at()]?.value ?? wanted ?? '',
    write: put,
    native: (on) => {
      apple.on = on
      slider.classList.toggle('native', on)
      danger = undefined
      measure()
      glass.redraw()
    },
    place: () => {
      danger = undefined
      measure()
      glass.redraw()
    },
  }))

  const levels = (next: Level[]): void => {
    list = next
    slider.style.setProperty('--n', String(Math.max(2, list.length)))
    slider.setAttribute('aria-valuemax', String(list.length - 1))
    stops.innerHTML = list
      .map((level, i) => {
        const title = level.value === 'full-trust' ? ' title="Hold to turn on full trust"' : ''
        return `<span style="--i:${String(i)}" data-value="${level.value}"${title}>${svg(iconOf(level.value).icon, 'icon')}</span>`
      })
      .join('')
    dots.innerHTML = list.map((_, i) => `<span class="dot" style="--i:${String(i)}"></span>`).join('')
    // Each name under its own stop; the two at the ends keep inside the line rather than
    // hanging off the rail.
    namesRow.innerHTML = list
      .map((level, i) => {
        const edge = i === 0 ? ' data-edge="start"' : i === list.length - 1 ? ' data-edge="end"' : ''
        return `<span class="stop-name" style="--i:${String(i)}" data-value="${level.value}"${edge}></span>`
      })
      .join('')
    names = [...namesRow.querySelectorAll<HTMLElement>('.stop-name')]
    names.forEach((one, i) => (one.textContent = list[i]!.name))
    icons = [...stops.querySelectorAll<HTMLElement>('span')]
    hovered = undefined
    under = -1
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
