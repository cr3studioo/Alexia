// SPDX-License-Identifier: AGPL-3.0-only
import { fromJsonSchema } from '@alexia/sdk'
import { ACTIONS } from './deck.js'

/**
 * The five tools, one per capability, shaped to the contracts in `docs/spec/capabilities.md`.
 * `deck` is undefined on a computer this cannot work on: the tools then say so, and claim no
 * capability.
 */

const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })

/** One line a window, for a model that reads only the text. */
export function describe({ windows, monitors }) {
  const screens = monitors.map(
    (m) => `monitor ${String(m.id)}: ${String(m.w)}×${String(m.h)} at ${String(m.x)},${String(m.y)}${m.primary ? ' (primary)' : ''}`,
  )
  const rows = windows.map(
    (w) =>
      `id=${w.id} | ${w.app} | “${w.title}” | ${String(w.w)}×${String(w.h)} at ${String(w.x)},${String(w.y)} on monitor ${String(w.monitor)}` +
      (w.minimized ? ' (minimised)' : ''),
  )
  return [...screens, ...(rows.length > 0 ? rows : ['No windows are open.'])].join('\n')
}

export function registerTools(alexia, deck) {
  function tool(name, cap, config, work) {
    const handler = async (...given) => {
      if (!deck) return refuse(`Arranging windows is not available on ${process.platform} yet.`)
      // A tool with an input schema is called (args, ctx); one without is called (ctx).
      const [args, ctx] = config.inputSchema ? given : [{}, given[0]]
      try {
        const { text, data = {} } = await work(args ?? {}, ctx?.mcpReq?.signal)
        return { content: [{ type: 'text', text }], structuredContent: data }
      } catch (error) {
        return refuse(error.message)
      }
    }
    alexia.tool(name, { ...config, ...(deck && { _meta: { 'alexia/provides': [cap] } }) }, handler)
  }

  const changes = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  const input = (properties, required) => fromJsonSchema({ type: 'object', properties, required })
  const layout = { type: 'string', description: 'The layout’s name, like “study”.' }

  tool(
    'window_list',
    'window.list',
    {
      description:
        'The open windows on this computer (id, app, title, place and size in screen pixels, minimised or not) and its monitors.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_args, signal) => {
      const found = await deck.list(signal)
      return { text: describe(found), data: found }
    },
  )

  tool(
    'window_arrange',
    'window.arrange',
    {
      description:
        'Move, resize, snap to the left or right half, maximise, minimise, restore or close one window. Get its id from ' +
        'window_list. Close asks the window to close, so the app can still ask to save.',
      inputSchema: input(
        {
          id: { type: 'string', description: 'The window’s id, exactly as window_list gave it.' },
          do: { type: 'string', enum: ACTIONS, description: 'What to do with it.' },
          x: { type: 'integer', description: 'For move: the left edge, in screen pixels.' },
          y: { type: 'integer', description: 'For move: the top edge, in screen pixels.' },
          w: { type: 'integer', minimum: 1, description: 'For resize: the width in pixels.' },
          h: { type: 'integer', minimum: 1, description: 'For resize: the height in pixels.' },
          monitor: { type: 'integer', minimum: 1, description: 'For move, snap or maximise: the monitor to put it on.' },
        },
        ['id', 'do'],
      ),
      annotations: changes,
    },
    async (args, signal) => ({ text: await deck.arrange(args, signal) }),
  )

  tool(
    'window_layout_save',
    'window.layout.save',
    {
      description: 'Remember where every open window is now, under a name, to put back later. Saving a name again replaces it.',
      inputSchema: input({ name: layout }, ['name']),
      annotations: changes,
    },
    async ({ name }, signal) => {
      const done = await deck.save(name, signal)
      return { text: `Saved “${done.saved}” with ${String(done.windows)} window${done.windows === 1 ? '' : 's'}.`, data: done }
    },
  )

  tool(
    'window_layout_apply',
    'window.layout.apply',
    {
      description:
        'Put windows back the way a saved layout had them. Apps that are not running are listed, and opened only with ' +
        'open_missing true.',
      inputSchema: input(
        { name: layout, open_missing: { type: 'boolean', description: 'Also open the apps that are not running.' } },
        ['name'],
      ),
      annotations: changes,
    },
    async (args, signal) => {
      const { text, placed, missing } = await deck.apply(args, signal)
      return { text, data: { placed, missing } }
    },
  )

  tool(
    'app_quit',
    'app.quit',
    {
      description:
        'Quit an app. It is asked to close, so it can ask to save. force ends it at once and loses unsaved work: use it ' +
        'only when the owner has said to force it.',
      inputSchema: input(
        {
          app: { type: 'string', description: 'The app’s name as window_list gives it.' },
          force: { type: 'boolean', description: 'End it without asking. Only when the owner said so. Defaults to false.' },
        },
        ['app'],
      ),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args, signal) => ({ text: await deck.quit(args, signal) }),
  )
}
