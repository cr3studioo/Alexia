// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The macOS genie: the Settings and Activity sheet pours out of its tab in the dock, and back
 * into it when it closes.
 *
 * The shape is the one in Alex Widua's GenieShader (github.com/alexwidua/genie, MIT, after
 * Janum Trivedi's distortion): the rows nearest the tab narrow first, the narrowing climbs up
 * the sheet, and the whole of it slides into the tab as it goes.
 *
 * **Drawn from a picture, one row at a time.** The shell takes a picture of the sheet
 * (`snapshot` in desktop.ts, WKWebView's own `takeSnapshot`), and every frame draws it onto one
 * canvas as thin rows, each at its own width and place. Copies of the live sheet cut into strips
 * were tried first: two dozen sheets for WebKit to repaint every frame stuttered, and strips
 * showed as steps. A picture costs one draw per row and the curve is smooth. The snapshot
 * leaves out `backdrop-filter`, which is why the sheet's glass is drawn with a plain `filter`
 * instead (`#sheet::before` in app.css).
 *
 * **Closing** takes the picture of the sheet as it is and plays it into the tab. **Opening**
 * has no sheet on screen to take a picture of, so it plays the one kept from the last time that
 * sheet was up, if the window is still the same size; the first time, the sheet just appears and
 * its picture is taken for next time. In a browser there is no shell to take pictures and there
 * is no effect, and with Reduce motion on there is none either.
 *
 * **The arithmetic is {@link shape}** and has no DOM, so it is tested without a browser.
 */

import { snapshot } from './desktop.js'

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** How long one genie takes, open or close. The Dock's own is about this. */
export const GENIE_MS = 520
/** The height of one drawn row, in CSS pixels. */
const ROW = 2

/** Inigo Quilez's smoother step, as in the shader. */
function smoother(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * t * (t * (t * 6 - 15) + 10)
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

/**
 * The sheet at one point of the effect: `p` 0 is the sheet where it sits, 1 is the sheet gone
 * into `to`. Row `u` of the sheet (0 its top, 1 its bottom) is drawn at `top + u * height`,
 * from `left(u)` to `right(u)`.
 *
 * Two phases, as in the shader, run almost together: the squeeze (its bottom first, climbing
 * to the top) over the first 80 %, and the slide into the tab from 10 % on — so the sheet
 * narrows and travels at the same time, both ways, rather than one and then the other.
 */
export function shape(
  sheet: Box,
  to: Box,
  p: number,
): { top: number; height: number; left: (u: number) => number; right: (u: number) => number } {
  const squeeze = ease(Math.min(1, p / 0.8))
  const slide = ease(Math.min(1, Math.max(0, (p - 0.1) / 0.9)))
  // How far a row has narrowed, by where it is on the sheet: the shader's smooth step, whose
  // lower edge starts at the bottom row and climbs past the top as the squeeze goes on — so the
  // rows nearest the tab go first and neighbouring rows are never far apart. The slide finishes
  // the job, so every row ends at the tab's width.
  const edge = lerp(1, -2, squeeze)
  const k = (u: number): number => {
    const shaped = u <= edge ? 0 : smoother(edge, 1, u)
    return shaped + (1 - shaped) * slide * slide
  }
  return {
    // The whole sheet travels into the tab; each row ends at its own place in it.
    top: lerp(sheet.top, to.top, slide),
    height: lerp(sheet.height, to.height, slide),
    left: (u) => lerp(sheet.left, to.left, k(u)),
    right: (u) => lerp(sheet.left + sheet.width, to.left + to.width, k(u)),
  }
}

/** One band of the sheet, `u0`–`u1`, at this point: its drawn top and bottom, and its sides at its middle. */
export function funnel(
  sheet: Box,
  to: Box,
  p: number,
  u0: number,
  u1: number,
): { top: number; bottom: number; left: number; right: number } {
  const at = shape(sheet, to, p)
  const u = (u0 + u1) / 2
  return { top: at.top + u0 * at.height, bottom: at.top + u1 * at.height, left: at.left(u), right: at.right(u) }
}

const boxOf = (el: Element): Box => {
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}
const same = (a: Box, b: Box): boolean =>
  Math.abs(a.left - b.left) < 1 && Math.abs(a.top - b.top) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1

/** The last picture of each sheet, and where it was taken, for the next time it opens. */
const kept = new Map<string, { picture: ImageBitmap; box: Box }>()

let running: { stop: () => void } | undefined
/** Counts every start and stop, so a close still waiting on its picture knows it was overtaken. */
let generation = 0

/** Finish whatever genie is playing now, at once: its canvas gone, its sheet shown. */
export function stopGenie(): void {
  generation++
  running?.stop()
}

const quiet = (): boolean => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

/** Take a picture of the sheet as it is now and keep it for `key`'s next opening. */
async function remember(key: string, sheet: HTMLElement): Promise<void> {
  const box = boxOf(sheet)
  if (box.width === 0 || box.height === 0) return
  const picture = await snapshot(box)
  if (picture) kept.set(key, { picture, box })
}

/**
 * Close: take `sheet` into `tab`. Resolves once it has gone in, or at once when there is no
 * effect to play; the caller then takes the sheet off the screen. Until then the sheet stays
 * laid out, shown only as the picture.
 */
export async function genieIn(key: string, sheet: HTMLElement, tab: HTMLElement): Promise<void> {
  stopGenie()
  const mine = generation
  if (quiet()) return
  const box = boxOf(sheet)
  if (box.width === 0 || box.height === 0) return
  const picture = await snapshot(box)
  if (!picture) return
  kept.set(key, { picture, box })
  if (mine !== generation) return
  await play(picture, box, boxOf(tab), sheet, true)
}

/**
 * Open: bring `sheet` out of `tab`. `open` puts the sheet on screen — the caller's view change —
 * and says whether it still should; it is called once the picture to play is ready, so a sheet
 * opened and then something else asked for before that never appears.
 *
 * The picture is the one kept from the last time this sheet was up. The first time there is
 * none, and none can be taken — WebKit photographs only what is on screen, and anything put on
 * screen to be photographed is seen. So the first time plays the sheet's glass with nothing on
 * it yet, made from a picture of the board where the sheet is about to be (which is on screen),
 * blurred and tinted the way the sheet's own glass is, and what is on the sheet arrives with it.
 */
export function genieOut(key: string, sheet: HTMLElement, tab: HTMLElement, open: () => boolean): void {
  stopGenie()
  const mine = generation
  // Two frames for the screen to be drawn in, then a picture for the next opening.
  const later = (): void => {
    requestAnimationFrame(() => requestAnimationFrame(() => void remember(key, sheet)))
  }
  const box = placed(sheet)
  const last = kept.get(key)
  if (quiet()) {
    if (open()) later()
    return
  }
  if (last && same(last.box, box)) {
    if (!open()) return
    void play(last.picture, boxOf(sheet), boxOf(tab), sheet, false).then(() => remember(key, sheet))
    return
  }
  void snapshot(box).then((ground) => {
    if (mine !== generation || !open()) return
    if (!ground) {
      later()
      return
    }
    void play(glass(ground, box), boxOf(sheet), boxOf(tab), sheet, false).then(() => remember(key, sheet))
  })
}

/** Where the sheet will be when it is shown. It is `display: none` until then, so from its insets. */
function placed(sheet: HTMLElement): Box {
  const style = getComputedStyle(sheet)
  const left = parseFloat(style.left) || 0
  const top = parseFloat(style.top) || 0
  const right = parseFloat(style.right) || 0
  const bottom = parseFloat(style.bottom) || 0
  return { left, top, width: window.innerWidth - left - right, height: window.innerHeight - top - bottom }
}

/**
 * The sheet's glass with nothing on it: the board behind it, blurred by the glass slider's amount
 * and tinted by its colour (`#sheet::before` in app.css), in the sheet's rounded shape. The blur
 * is the picture halved and halved again and drawn back up — near enough to a Gaussian for half a
 * second of motion, and no reading of pixels, which was slow on a big window.
 */
function glass(ground: ImageBitmap, box: Box): HTMLCanvasElement {
  const root = getComputedStyle(document.documentElement)
  const filter = root.getPropertyValue('--glass-filter').trim()
  const radius = filter === 'none' ? 0 : Number(/blur\(([\d.]+)px\)/.exec(filter)?.[1] ?? 30)
  const w = Math.max(1, Math.round(box.width))
  const h = Math.max(1, Math.round(box.height))
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const context = out.getContext('2d')!
  context.beginPath()
  context.roundRect(0, 0, w, h, parseFloat(root.getPropertyValue('--radius-lg')) * parseFloat(root.fontSize) || 12)
  context.clip()
  let source: CanvasImageSource = ground
  let sw = ground.width
  let sh = ground.height
  const smallest = Math.max(1, radius / 2)
  while (radius > 0 && sw / 2 >= w / smallest) {
    const half = document.createElement('canvas')
    half.width = Math.max(1, Math.round(sw / 2))
    half.height = Math.max(1, Math.round(sh / 2))
    half.getContext('2d')!.drawImage(source, 0, 0, half.width, half.height)
    source = half
    sw = half.width
    sh = half.height
  }
  context.imageSmoothingQuality = 'high'
  context.drawImage(source, 0, 0, w, h)
  // The tint, as the stylesheet mixes it — read back from an element, so it is the same colour.
  const probe = document.createElement('div')
  probe.style.background = 'color-mix(in oklab, var(--surface-raised) var(--glass-tint), transparent)'
  document.body.append(probe)
  const tint = getComputedStyle(probe).backgroundColor
  probe.remove()
  context.fillStyle = 'rgba(0, 0, 0, 0)'
  context.fillStyle = tint
  context.fillRect(0, 0, w, h)
  return out
}

function play(picture: CanvasImageSource & { width: number; height: number }, box: Box, tab: Box, sheet: HTMLElement, into: boolean): Promise<void> {
  const canvas = document.createElement('canvas')
  canvas.className = 'genie'
  canvas.setAttribute('aria-hidden', 'true')
  const scale = window.devicePixelRatio || 1
  canvas.width = Math.round(window.innerWidth * scale)
  canvas.height = Math.round(window.innerHeight * scale)
  const context = canvas.getContext('2d')
  if (!context) return Promise.resolve()
  context.scale(scale, scale)
  context.imageSmoothingQuality = 'high'

  const draw = (p: number): void => {
    context.clearRect(0, 0, window.innerWidth, window.innerHeight)
    const at = shape(box, tab, p)
    // The last of it fades into the tab rather than stopping at its size.
    context.globalAlpha = 1 - smoother(0.8, 1, p)
    const rows = Math.max(1, Math.ceil(at.height / ROW))
    const source = picture.height / rows
    for (let i = 0; i < rows; i++) {
      const u = (i + 0.5) / rows
      const left = at.left(u)
      // Half a pixel over the next row, so no line of the board shows between two.
      context.drawImage(picture, 0, i * source, picture.width, source, left, at.top + (i / rows) * at.height, at.right(u) - left, at.height / rows + 0.5)
    }
  }

  // The canvas goes up with the first frame on it before the sheet is hidden, so there is no
  // frame with neither.
  draw(into ? 0 : 1)
  document.body.append(canvas)
  sheet.style.visibility = 'hidden'

  return new Promise((resolve) => {
    const start = performance.now()
    let frame = 0
    const finish = (): void => {
      cancelAnimationFrame(frame)
      canvas.remove()
      if (running === handle) running = undefined
      sheet.style.visibility = ''
      resolve()
    }
    const handle = { stop: finish }
    running = handle
    const tick = (now: number): void => {
      const t = Math.min(1, (now - start) / GENIE_MS)
      draw(into ? t : 1 - t)
      if (t < 1) frame = requestAnimationFrame(tick)
      else finish()
    }
    frame = requestAnimationFrame(tick)
  })
}
