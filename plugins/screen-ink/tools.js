// SPDX-License-Identifier: AGPL-3.0-only
import { fromJsonSchema, log } from '@alexia/sdk'
import { COLORS, DEFAULT_TTL_MS, KINDS, MAX_SHAPES, MAX_TTL_MS, parseCursor, parseDraw } from './shapes.js'

/**
 * The three tools. A shape's text and her cursor's label are what is on somebody's screen, so
 * nothing here logs them.
 */

/** What a caller is told when nothing can be shown (docs/spec/capabilities.md). */
export const CANNOT = 'I can’t draw on that screen.'

const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })
const said = (text, structuredContent) => ({ content: [{ type: 'text', text }], structuredContent })

/** It shows something on the owner's own screen and changes nothing else. */
const HINTS = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }

const number = (description) => ({ type: 'number', description })

/**
 * Register the tools on `alexia`. `ink` is the overlay; without one (a computer with no way to
 * draw) the tools are bound to no capability, so the hub looks further, and say they cannot.
 */
export function register(alexia, ink) {
  const bind = (cap) => (ink ? { 'alexia/provides': [cap] } : {})

  /** Run one thing on the overlay, and turn any failure into the one sentence. */
  async function onScreen(what) {
    if (!ink) return refuse(CANNOT)
    try {
      return await what()
    } catch (error) {
      // Only ever the overlay's own words: never a shape or a label.
      log.warn(`screen ink: ${error instanceof Error ? error.message : 'something failed'}`)
      return refuse(CANNOT)
    }
  }

  alexia.tool(
    'screen_draw',
    {
      description:
        'Point at things on the owner’s screen: boxes, arrows, short labels and dots, on a see-through layer that never takes a click. ' +
        `Coordinates are screen pixels, as computer.screenshot reports them. Each drawing disappears by itself after ttl_ms (${DEFAULT_TTL_MS / 1000} s unless said, at most ${MAX_TTL_MS / 1000} s) and is added to what is already there.`,
      inputSchema: fromJsonSchema({
        type: 'object',
        properties: {
          shapes: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_SHAPES,
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: KINDS, description: 'box around something, arrow pointing at it, text label, or dot.' },
                x: number('Left edge of a box, tail of an arrow, left of a text, middle of a dot.'),
                y: number('Top edge of a box, tail of an arrow, top of a text, middle of a dot.'),
                w: number('Width of a box (required), or of a dot across.'),
                h: number('Height of a box (required).'),
                to: {
                  type: 'object',
                  properties: { x: number('Pixels from the left.'), y: number('Pixels from the top.') },
                  required: ['x', 'y'],
                  description: 'Where an arrow points (required for an arrow).',
                },
                text: { type: 'string', description: 'A short label. Required for text; optional on the others.' },
                color: { type: 'string', description: `#RRGGBB or ${Object.keys(COLORS).join(', ')}. Red unless said.` },
              },
              required: ['kind', 'x', 'y'],
            },
          },
          ttl_ms: number(`How long it stays, in milliseconds. Longer than ${MAX_TTL_MS} is cut to ${MAX_TTL_MS}.`),
        },
        required: ['shapes'],
      }),
      annotations: HINTS,
      _meta: bind('screen.draw'),
    },
    async (args) => {
      const { shapes, ttlMs, error } = parseDraw(args)
      if (error) return refuse(error)
      return onScreen(async () => {
        const drawn = await ink.draw({ shapes, ttlMs })
        return said(`Drawn: ${drawn} ${drawn === 1 ? 'shape' : 'shapes'}, for ${ttlMs / 1000} s.`, { drawn })
      })
    },
  )

  alexia.tool(
    'screen_clear',
    {
      description: 'Remove everything drawn on the owner’s screen, her cursor included.',
      annotations: HINTS,
      _meta: bind('screen.clear'),
    },
    async () =>
      onScreen(async () => {
        await ink.clear()
        return said('Cleared.', {})
      }),
  )

  alexia.tool(
    'cursor_show',
    {
      description:
        'Show her own cursor (a coloured dot with her name) at a point on the owner’s screen, gliding there from where it last was. ' +
        'The owner’s pointer does not move. It hides again after 3 s idle.',
      inputSchema: fromJsonSchema({
        type: 'object',
        properties: {
          x: number('Screen pixels from the left, as computer.screenshot reports them.'),
          y: number('Screen pixels from the top.'),
          label: { type: 'string', description: 'The name beside the dot. Defaults to Alexia.' },
        },
        required: ['x', 'y'],
      }),
      annotations: HINTS,
      _meta: bind('cursor.show'),
    },
    async (args) => {
      const { x, y, label, error } = parseCursor(args)
      if (error) return refuse(error)
      return onScreen(async () => {
        await ink.cursor({ x, y, label })
        return said('Shown.', {})
      })
    },
  )
}
