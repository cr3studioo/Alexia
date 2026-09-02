// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, expect, test, vi } from 'vitest'
import { widget, type Rendered, type Row, type WidgetHost } from '../src/widgets.js'

/**
 * The renderer, actually rendering — which until now nothing here did.
 *
 * `widgets.ts` is two thousand lines of DOM built by hand, and every check in this folder
 * reads it as *text*: ids that must exist, tokens that must resolve, arithmetic that can be
 * done without a browser. That was the right shape while the file was a straight line from a
 * declaration to a control. It stopped being one when a `choice` grew a second form, a row
 * grew a player and `save` grew a second reason to redraw — three branches whose failure is a
 * control drawn wrong rather than an exception, which no amount of reading the source catches.
 *
 * **The one dependency in this folder, and it is a `devDependency`.** `happy-dom` over
 * `jsdom` on footprint — seven transitive packages against twenty-one — and it is scoped to
 * this file by the pragma above, so the other eighty-eight test files still run in plain Node
 * at no cost. Nothing it provides ships: invariant 6 is about `packages/ui/src`, and this is
 * `test`.
 */

/** A host that answers, and remembers what it was asked. */
function fakeHost(answers: Record<string, unknown> = {}): WidgetHost & {
  sent: { path: string; body: Record<string, unknown> }[]
  redrawn: number
} {
  const sent: { path: string; body: Record<string, unknown> }[] = []
  const root = document.createElement('div')
  document.body.replaceChildren(root)
  const host = {
    plugin: 'demo',
    screen: 'settings',
    sent,
    redrawn: 0,
    send: (path: string, body: unknown) => {
      sent.push({ path, body: body as Record<string, unknown> })
      return Promise.resolve((answers[path] ?? { ok: true }) as Record<string, unknown>)
    },
    fresh: () => Promise.resolve([] as Rendered[]),
    root: () => root,
    redraw: () => {
      host.redrawn += 1
    },
  }
  return host
}

/** Rows arrive over a promise, so a widget that fetches them needs a turn before it is read. */
const settled = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  document.body.replaceChildren()
})

// ---- choice ------------------------------------------------------------------------------

test('bare-string options render exactly as they always did', () => {
  // The regression that would matter most: every other plugin in the repo declares its
  // options as strings, and none of them asked for cards.
  const host = fakeHost()
  const segmented = widget(host, {
    type: 'choice',
    key: 'size',
    label: 'Speech model',
    options: ['tiny', 'base', 'small'],
    value: 'base',
  })
  expect(segmented.querySelector('.segmented')).not.toBeNull()
  expect(segmented.querySelector('.picks')).toBeNull()
  expect([...segmented.querySelectorAll('.segment span')].map((s) => s.textContent)).toEqual(['tiny', 'base', 'small'])
  expect(segmented.querySelector<HTMLInputElement>('input[value="base"]')!.checked).toBe(true)

  // Four or more is still a dropdown, which is core's call and not the author's.
  const dropdown = widget(host, {
    type: 'choice',
    key: 'lang',
    label: 'Language',
    options: ['en', 'es', 'fr', 'de'],
    value: 'es',
  })
  const select = dropdown.querySelector<HTMLSelectElement>('select')!
  expect(select.options.length).toBe(4)
  expect(select.value).toBe('es')
})

test('an option with a sentence turns the whole group into cards', () => {
  const host = fakeHost()
  const field = widget(host, {
    type: 'choice',
    key: 'engine',
    label: 'Voice engine',
    value: 'here',
    options: [
      { value: 'here', label: 'Piper', hint: 'Fast, on this machine.' },
      { value: 'away', label: 'A service', hint: 'It can clone.', available: false, reason: 'Add a key below.' },
    ],
  })

  expect(field.querySelector('.segmented')).toBeNull()
  const picks = [...field.querySelectorAll('.pick')]
  expect(picks).toHaveLength(2)
  expect(picks[0]!.querySelector('.pick-name')!.textContent).toBe('Piper')
  expect(picks[0]!.querySelector('.pick-hint')!.textContent).toBe('Fast, on this machine.')
  expect(picks[0]!.querySelector<HTMLInputElement>('input')!.checked).toBe(true)

  // Dimmed and explained rather than missing: the person who cannot pick it is the one who
  // needs to know what to do about that.
  expect(picks[1]!.className).toBe('pick off')
  expect(picks[1]!.querySelector<HTMLInputElement>('input')!.disabled).toBe(true)
  expect(picks[1]!.querySelector('.pick-why')!.textContent).toBe('Add a key below.')
  // And the label is what a person reads while the value is what is stored.
  expect(picks[1]!.querySelector<HTMLInputElement>('input')!.value).toBe('away')
})

test('choosing a card saves the value, not the label somebody read', async () => {
  const host = fakeHost()
  const field = widget(host, {
    type: 'choice',
    key: 'engine',
    label: 'Voice engine',
    options: [
      { value: 'fish_plain', label: 'fish.audio', hint: 'Cloud.' },
      { value: 'piper', label: 'Piper', hint: 'Local.' },
    ],
  })
  field.querySelectorAll<HTMLInputElement>('input')[0]!.dispatchEvent(new Event('change'))
  await settled()
  expect(host.sent).toEqual([{ path: '/api/settings', body: { plugin: 'demo', key: 'engine', value: 'fish_plain' } }])
})

// ---- gating ------------------------------------------------------------------------------

test('saving a widget that decides the page redraws it, and an ordinary one does not', async () => {
  const gating = fakeHost()
  widget(gating, { type: 'choice', key: 'engine', label: 'Engine', options: ['a', 'b'], gates: true })
    .querySelector<HTMLInputElement>('input')!
    .dispatchEvent(new Event('change'))
  await settled()
  expect(gating.redrawn).toBe(1)

  // The rule this is the exception to: a redraw takes focus off whoever is mid-keystroke, so
  // an ordinary save deliberately leaves the page alone.
  const plain = fakeHost()
  const box = widget(plain, { type: 'text', key: 'find', label: 'Find a voice' })
  const input = box.querySelector<HTMLInputElement>('input')!
  input.value = 'spongebob'
  input.dispatchEvent(new Event('change'))
  await settled()
  expect(plain.redrawn).toBe(0)
  expect(plain.sent[0]!.body.value).toBe('spongebob')
})

test('a text box that says it is long gets one', () => {
  const host = fakeHost()
  const one = widget(host, { type: 'text', key: 'clip_text', label: 'What it says', multiline: true, value: 'said' })
  const area = one.querySelector<HTMLTextAreaElement>('textarea')!
  expect(area.value).toBe('said')
  // Same value, same event, same save — the only difference is how much of it is visible.
  expect(widget(host, { type: 'text', key: 'find', label: 'Find' }).querySelector('textarea')).toBeNull()
})

// ---- file --------------------------------------------------------------------------------

test('a chosen file goes up as base64 and comes back as a path', async () => {
  const host = fakeHost({ '/api/upload': { ok: true, path: 'C:/data/plugins/demo/uploads/clip/my voice.wav' } })
  const field = widget(host, { type: 'file', key: 'clip', label: 'A recording', accept: '.wav,.mp3', gates: true })
  const input = field.querySelector<HTMLInputElement>('input[type="file"]')!
  expect(input.accept).toBe('.wav,.mp3')

  const file = new File([new Uint8Array([1, 2, 3, 4])], 'my voice.wav', { type: 'audio/wav' })
  Object.defineProperty(input, 'files', { value: [file] })
  input.dispatchEvent(new Event('change'))
  await vi.waitFor(() => expect(host.sent).toHaveLength(1))

  const { path, body } = host.sent[0]!
  expect(path).toBe('/api/upload')
  expect(body).toMatchObject({ plugin: 'demo', key: 'clip', name: 'my voice.wav' })
  // Base64 of the bytes, and nothing about where on the disk they came from — because the
  // page was never told, and core is what makes the path.
  expect(Buffer.from(String(body.data), 'base64')).toEqual(Buffer.from([1, 2, 3, 4]))

  // The name the person chose, not the path core wrote: a temp filename tells them nothing.
  await vi.waitFor(() => expect(field.querySelector('.hint')!.textContent).toBe('Holding my voice.wav.'))
  // A `file` gates the button under it exactly as a `choice` gates a section.
  expect(host.redrawn).toBe(1)
})

test('a file that will not save says so where the control is', async () => {
  const host = fakeHost({ '/api/upload': { ok: false, why: 'my voice.wav is 40 MB, and 25 MB is the most one file may be.' } })
  const field = widget(host, { type: 'file', key: 'clip', label: 'A recording' })
  const input = field.querySelector<HTMLInputElement>('input[type="file"]')!
  Object.defineProperty(input, 'files', { value: [new File([new Uint8Array([9])], 'my voice.wav')] })
  input.dispatchEvent(new Event('change'))
  // The line under the control, not the empty refusal paragraph every widget carries: a
  // `file` never goes through `save()`, so that one stays blank and this is the one to read.
  const spoken = (): string =>
    [...field.querySelectorAll('p')].find((p) => p.className === 'error')?.textContent ?? ''
  await vi.waitFor(() => expect(spoken()).toContain('25 MB is the most'))
  expect(host.redrawn).toBe(0)
})

// ---- a row with something to listen to ---------------------------------------------------

const voices: Row[] = [
  { id: 'lessac', name: 'lessac', summary: 'Published for Piper.', state: '● speaking' },
  { id: 'cloud:a', name: 'SpongeBob', summary: 'A high-pitched voice.', state: '● ready', preview: 'https://r2.example.invalid/a.mp3' },
  { id: 'cloud:b', name: 'Reze', summary: 'Cloned by you.', state: '● ready', preview: 'data:audio/mpeg;base64,//uQx' },
]

test('a card carrying a preview gets a player, and one without gets nothing', async () => {
  const host = fakeHost({ '/api/rows': { ok: true, rows: voices } })
  const field = widget(host, { type: 'cards', key: 'voices', label: 'Your voices', rows: 'voices' })
  await settled()

  const cards = [...field.querySelectorAll('.bento-card')]
  expect(cards).toHaveLength(3)
  expect(cards[0]!.querySelector('audio')).toBeNull()

  const audio = cards[1]!.querySelector<HTMLAudioElement>('audio.row-audio')!
  expect(audio.controls).toBe(true)
  // The whole reason a list of forty voices is affordable: nothing is fetched until play.
  expect(audio.getAttribute('preload')).toBe('none')
  expect(audio.getAttribute('src')).toBe('https://r2.example.invalid/a.mp3')
  // A generated preview is the same node with a `data:` source — no second path to keep.
  expect(cards[2]!.querySelector('audio')!.getAttribute('src')).toBe('data:audio/mpeg;base64,//uQx')
})

test('a table row carrying a preview gets the same player, and the column to put it in', async () => {
  const host = fakeHost({ '/api/rows': { ok: true, rows: voices } })
  const field = widget(host, {
    type: 'table',
    key: 'voices',
    label: 'Your voices',
    rows: 'voices',
    columns: [{ key: 'name', label: 'Voice' }],
  })
  await settled()

  // No row actions and no detail on this table, so the extra cell exists only because a row
  // asked for one — which is why the header is decided from the rows and not the declaration.
  expect(field.querySelectorAll('thead th')).toHaveLength(2)
  const players = [...field.querySelectorAll<HTMLAudioElement>('audio.row-audio')]
  expect(players).toHaveLength(2)
  expect(players[0]!.getAttribute('preload')).toBe('none')
})
