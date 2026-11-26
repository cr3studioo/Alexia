// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What may be drawn, and how a caller's arguments become it.
 *
 * Everything that reaches an overlay has been through here: numbers are whole and within reach,
 * a colour is `#RRGGBB`, a label is one short line. So the overlays read what they are sent and
 * check nothing twice.
 */

export const KINDS = ['box', 'arrow', 'text', 'dot']

export const DEFAULT_TTL_MS = 8_000
export const MAX_TTL_MS = 60_000

export const MAX_SHAPES = 50
export const MAX_TEXT = 200
export const MAX_LABEL = 40

/** Further from the corner than any desk of screens reaches. */
export const FARTHEST = 100_000

/** A dot's width across, in pixels. */
export const DOT = { least: 4, usual: 18, most: 400 }

export const DEFAULT_COLOR = '#FF3B30'

export const COLORS = {
  red: DEFAULT_COLOR,
  orange: '#FF9500',
  yellow: '#FFCC00',
  green: '#34C759',
  blue: '#007AFF',
  purple: '#7C5CFF',
  black: '#000000',
  white: '#FFFFFF',
}

const reachable = (value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= FARTHEST

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** One line of at most `most` characters; control characters and line breaks become spaces. */
export function oneLine(value, most) {
  const line = String(value)
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .trim()
  const letters = [...line]
  return letters.length > most ? `${letters.slice(0, most - 1).join('')}…` : line
}

/** `#RGB`, `#RRGGBB` or a name, as `#RRGGBB`; undefined when it is none of those. */
export function color(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_COLOR
  if (typeof value !== 'string') return undefined
  const said = value.trim()
  if (Object.hasOwn(COLORS, said.toLowerCase())) return COLORS[said.toLowerCase()]
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(said)
  if (short) return `#${short.slice(1).map((digit) => digit + digit).join('')}`.toUpperCase()
  return /^#[0-9a-f]{6}$/i.test(said) ? said.toUpperCase() : undefined
}

/** Black or white, whichever reads on this `#RRGGBB`. */
export function readableOn(hex) {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16))
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55 ? '#000000' : '#FFFFFF'
}

/** One shape as an overlay takes it, or `{ error }` in a sentence a model can act on. */
function shape(raw, which) {
  const wrong = (why) => ({ error: `Shape ${which}: ${why}` })
  if (!isObject(raw)) return wrong('it must be an object.')
  if (!KINDS.includes(raw.kind)) return wrong(`kind must be one of ${KINDS.join(', ')}.`)
  if (!reachable(raw.x) || !reachable(raw.y)) return wrong('x and y must be screen pixels.')
  const paint = color(raw.color)
  if (!paint) return wrong(`color must be #RRGGBB or one of ${Object.keys(COLORS).join(', ')}.`)
  if (raw.text !== undefined && typeof raw.text !== 'string') return wrong('text must be a string.')

  const one = { kind: raw.kind, x: Math.round(raw.x), y: Math.round(raw.y), color: paint, on: readableOn(paint) }
  const text = raw.text === undefined ? '' : oneLine(raw.text, MAX_TEXT)
  if (text) one.text = text

  if (raw.kind === 'box') {
    const { w, h } = raw
    if (!reachable(w) || !reachable(h) || Math.round(w) < 1 || Math.round(h) < 1) {
      return wrong('a box needs w and h, both at least 1 pixel.')
    }
    Object.assign(one, { w: Math.round(w), h: Math.round(h) })
  }
  if (raw.kind === 'arrow') {
    if (!isObject(raw.to) || !reachable(raw.to.x) || !reachable(raw.to.y)) {
      return wrong('an arrow needs to: { x, y }, the point it points at.')
    }
    one.to = { x: Math.round(raw.to.x), y: Math.round(raw.to.y) }
    if (one.to.x === one.x && one.to.y === one.y) return wrong('an arrow must point somewhere other than where it starts.')
  }
  if (raw.kind === 'dot') {
    if (raw.w !== undefined && !(reachable(raw.w) && raw.w > 0)) return wrong('a dot’s w is its width in pixels.')
    one.w = raw.w === undefined ? DOT.usual : Math.min(DOT.most, Math.max(DOT.least, Math.round(raw.w)))
  }
  if (raw.kind === 'text' && !one.text) return wrong('a text shape needs text.')
  return { shape: one }
}

/**
 * `screen.draw`'s arguments as `{ shapes, ttlMs }`, or `{ error }`. One bad shape refuses the
 * whole call: half a drawing would point at the wrong thing. A time over the limit is cut to it.
 */
export function parseDraw(args) {
  const raw = args?.shapes
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'shapes must be a list with at least one shape.' }
  if (raw.length > MAX_SHAPES) return { error: `At most ${MAX_SHAPES} shapes can be drawn at once.` }
  const shapes = []
  for (const [index, each] of raw.entries()) {
    const { shape: one, error } = shape(each, index + 1)
    if (error) return { error }
    shapes.push(one)
  }
  const ttl = args.ttl_ms
  if (ttl === undefined || ttl === null) return { shapes, ttlMs: DEFAULT_TTL_MS }
  if (typeof ttl !== 'number' || !(ttl >= 1)) return { error: 'ttl_ms must be a number of milliseconds, at least 1.' }
  return { shapes, ttlMs: Math.min(MAX_TTL_MS, Math.round(ttl)) }
}

/** `cursor.show`'s arguments as `{ x, y, label }`, or `{ error }`. */
export function parseCursor(args) {
  if (!reachable(args?.x) || !reachable(args?.y)) return { error: 'x and y must be screen pixels.' }
  if (args.label !== undefined && typeof args.label !== 'string') return { error: 'label must be a string.' }
  const label = oneLine(args.label ?? '', MAX_LABEL) || 'Alexia'
  return { x: Math.round(args.x), y: Math.round(args.y), label }
}
