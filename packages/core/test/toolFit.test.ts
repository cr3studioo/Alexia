// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import type { ToolSpec } from '../src/provider.js'
import type { Message } from '../src/store.js'
import { fitTools, TOOL_SHARE } from '../src/toolFit.js'
import { PER_TOKEN } from '../src/trim.js'

/**
 * A model on this machine is handed the tools that fit its window.
 *
 * The case that made it: eight plugins, a hundred and twenty tools, twenty thousand tokens of
 * definitions, and an 8B model on an 8 GB card that could hold sixteen thousand tokens at most.
 */

const tool = (name: string, description: string, padding = 0): ToolSpec => ({
  name,
  description,
  parameters: { type: 'object', properties: { note: { type: 'string', description: 'x'.repeat(padding) } } },
})
const cost = (tools: ToolSpec[]): number => tools.reduce((sum, one) => sum + Math.ceil(JSON.stringify(one).length / PER_TOKEN), 0)
const said = (content: string): Message => ({ role: 'user', content })

const shelf: ToolSpec[] = [
  tool('media__make_picture', 'Paint a picture from a description with ComfyUI.', 400),
  tool('media__library', 'List the picture workflows that can be installed.', 400),
  tool('computer__screenshot', 'Take a screenshot of the screen.', 400),
  tool('computer__click', 'Click at a place on the screen.', 400),
  tool('memory__recall', 'Look something up in long-term memory.', 400),
  tool('memory__remember', 'Keep a fact about the user.', 400),
  tool('telegram__send', 'Send a message to a Telegram chat.', 400),
  tool('voice__speak', 'Say something aloud.', 400),
  tool('documents__read', 'Read a document the person has.', 400),
  tool('web__search', 'Search the web.', 400),
]

test('a window that holds every tool is sent every tool, unchanged', () => {
  expect(fitTools(shelf, [said('hello')], 100_000)).toEqual(shelf)
  // And a model with no stated window is left alone rather than guessed at.
  expect(fitTools(shelf, [said('hello')], 0)).toEqual(shelf)
  expect(fitTools([], [said('hello')], 4096)).toEqual([])
})

test('a window that cannot is sent the ones that fit, within its share', () => {
  const context = 2000
  const sent = fitTools(shelf, [said('hello')], context)
  expect(sent.length).toBeGreaterThan(0)
  expect(sent.length).toBeLessThan(shelf.length)
  expect(cost(sent)).toBeLessThanOrEqual(context * TOOL_SHARE)
})

test('the tools that match what was asked are the ones kept', () => {
  const context = 1200
  const names = (asked: string): string[] => fitTools(shelf, [said(asked)], context).map((one) => one.name)
  expect(names('paint me a picture of a cat')).toContain('media__make_picture')
  expect(names('take a screenshot of my screen')).toContain('computer__screenshot')
  expect(names('send a telegram message to mum')).toContain('telegram__send')
  // Plurals find the singular a tool is written in.
  expect(names('make some pictures')).toContain('media__make_picture')
  // Only the latest two requests count: an old one does not hold a tool in place.
  const old = [said('paint a picture'), said('ok'), said('send a telegram message')]
  expect(fitTools(shelf, old, context).map((one) => one.name)).not.toContain('media__make_picture')
})

test('the recall tool the system prompt names is always there, and so is any tool already called', () => {
  const calling: Message = { role: 'assistant', content: '', calls: [{ id: '1', name: 'voice__speak', arguments: '{}' }] }
  const sent = fitTools(shelf, [said('take a screenshot'), calling, { role: 'tool', content: 'ok', callId: '1' }], 2000).map((one) => one.name)
  expect(sent).toContain('memory__recall')
  expect(sent).toContain('voice__speak')
  expect(sent).toContain('computer__screenshot')
})

test('the same request is the same prompt twice, in the order the tools were given', () => {
  const messages = [said('paint a picture of a screenshot')]
  const first = fitTools(shelf, messages, 1500)
  expect(fitTools(shelf, messages, 1500)).toEqual(first)
  const order = first.map((one) => shelf.indexOf(one))
  expect(order).toEqual([...order].sort((a, b) => a - b))
})

test('the plugin a request is about brings its first tool, whatever words were used', () => {
  // The case: `media__generate` is the dearest tool, so *list my pictures* filled the room with the cheap
  // tools that list them, and *draw a dog* or a request in Czech matched it on no word at all.
  const big = [tool('media__make_picture', 'Paint a picture from a description with ComfyUI.', 1500), ...shelf.slice(1)]
  const names = (messages: Message[], context = 4000): string[] => fitTools(big, messages, context).map((one) => one.name)
  expect(names([said('list my pictures')])).toContain('media__make_picture')
  // A request in another language, or one the words do not catch, still has every plugin's front door.
  expect(names([said('udělej obrázek kočky')])).toContain('media__make_picture')
  expect(names([said('another one please')])).toContain('media__make_picture')
  expect(names([said('another one please')])).toContain('telegram__send')
  expect(cost(fitTools(big, [said('another one please')], 4000))).toBeLessThanOrEqual(4000 * TOOL_SHARE)
})
