// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  applies,
  MODELS_CHANGED,
  treeMatches,
  treeNodes,
  treeShape,
  widget,
  type Rendered,
  type Row,
  type WidgetHost,
} from '../src/widgets.js'

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

// ---- the ladder, when a key has gone -----------------------------------------------------

test('a listed model whose provider lost its key stays on the ladder, says why, and survives the next edit', async () => {
  // What core sends after a key is removed (§1 step 4): the listed row, marked `off`.
  const host = fakeHost({
    '/api/rows': {
      ok: true,
      rows: [
        { id: 'stub/free-a', name: 'Free A', provider: 'stub', price: 'free', side: 'free', rank: '1', off: 'not available — no key for Stub' },
        { id: 'floor/one', name: 'Floor One', provider: 'floor', price: 'free', side: 'free', rank: '2', off: '' },
        { id: 'floor/two', name: 'Floor Two', provider: 'floor', price: 'free', side: 'free', rank: '', off: '' },
      ],
    },
  })
  const field = widget(host, {
    type: 'ladder',
    key: 'routing',
    label: 'What may answer',
    rows: 'routing',
    stops: [{ value: 'mixed', label: 'Free, then paid', hint: 'Free first.' }],
    ordered: 'set_order',
  })
  await settled()

  const chips = [...field.querySelectorAll<HTMLElement>('.chip')]
  expect(chips.map((chip) => chip.dataset.id)).toEqual(['stub/free-a', 'floor/one'])
  expect(chips[0]!.classList.contains('off')).toBe(true)
  expect(chips[0]!.querySelector('.chip-meta')?.textContent).toBe('not available — no key for Stub')
  expect(chips[1]!.classList.contains('off')).toBe(false)

  // Taking the other one off the list saves what is left — the unavailable entry included.
  chips[1]!.querySelector<HTMLButtonElement>('.chip-drop')!.click()
  expect(host.sent.at(-1)?.body).toMatchObject({ key: 'set_order', row: 'stub/free-a' })

  // And search offers what can be asked and is not listed — never a model nothing can ask.
  const search = field.querySelector<HTMLInputElement>('.ladder-search')!
  search.value = 'f'
  search.dispatchEvent(new Event('input'))
  expect([...field.querySelectorAll('.ladder-hit .chip-name')].map((one) => one.textContent)).toEqual(['Floor One', 'Floor Two'])
})

// ---- the ladder's speed switch -------------------------------------------------------------

/** The ladder as core declares it, with the speed switch standing where `fastest` says. */
const speedy = (extra: Partial<Rendered> = {}): Rendered => ({
  type: 'ladder',
  key: 'routing',
  label: 'What may answer',
  rows: 'routing',
  stops: [
    { value: 'free', label: 'Free only', hint: 'Nothing is billed.' },
    { value: 'mixed', label: 'Free, then paid', hint: 'Free first.' },
  ],
  value: 'free',
  speed: 'set_speed',
  ...extra,
})

test('the speed switch stands where core says, and says what off means', async () => {
  const off = widget(fakeHost({ '/api/rows': { ok: true, rows: [] } }), speedy({ fastest: false }))
  await settled()
  const box = off.querySelector<HTMLElement>('.speed')!
  expect(box.hidden).toBe(false)
  expect(box.querySelector<HTMLInputElement>('.speed-toggle')!.checked).toBe(false)
  expect(box.querySelector('.speed-label')?.textContent).toBe('Answer as fast as possible (uses more free requests)')
  expect(box.querySelector('.speed-hint')?.textContent).toMatch(/^Off is Balanced: one model at a time/)

  const on = widget(fakeHost({ '/api/rows': { ok: true, rows: [] } }), speedy({ fastest: true }))
  await settled()
  expect(on.querySelector<HTMLInputElement>('.speed-toggle')!.checked).toBe(true)
  // At *free only* as well as *free then paid*: unlike the paid switch, it is not a money question.
  expect(on.querySelector<HTMLElement>('.speed')!.hidden).toBe(false)
})

test('flipping the speed switch presses its action with on or off, and a refusal stays on screen', async () => {
  const host = fakeHost({ '/api/rows': { ok: true, rows: [] }, '/api/action': { ok: true, said: 'On. Faster.' } })
  const field = widget(host, speedy())
  await settled()
  const toggle = field.querySelector<HTMLInputElement>('.speed-toggle')!
  const said = field.querySelector<HTMLElement>('.speed-said')!
  expect(said.hidden).toBe(true)
  let changed = 0
  const heard = (): void => {
    changed += 1
  }
  window.addEventListener(MODELS_CHANGED, heard)

  toggle.checked = true
  toggle.dispatchEvent(new Event('change'))
  await settled()
  expect(host.sent.at(-1)).toEqual({ path: '/api/action', body: { plugin: 'demo', key: 'set_speed', row: 'on' } })
  expect(said.hidden).toBe(false)
  expect(said.textContent).toBe('On. Faster.')
  expect(said.classList.contains('error')).toBe(false)
  // It changes when models are asked, not which, so the Models table is not told to redraw.
  window.removeEventListener(MODELS_CHANGED, heard)
  expect(changed).toBe(0)

  const refusing = fakeHost({ '/api/rows': { ok: true, rows: [] }, '/api/action': { ok: false, said: 'Not now.' } })
  const again = widget(refusing, speedy({ fastest: true }))
  await settled()
  const flip = again.querySelector<HTMLInputElement>('.speed-toggle')!
  flip.checked = false
  flip.dispatchEvent(new Event('change'))
  await settled()
  expect(refusing.sent.at(-1)?.body).toEqual({ plugin: 'demo', key: 'set_speed', row: 'off' })
  const refused = again.querySelector<HTMLElement>('.speed-said')!
  expect(refused.textContent).toBe('Not now.')
  expect(refused.classList.contains('error')).toBe(true)
})

test('a ladder that declares no speed switch draws none', async () => {
  const field = widget(fakeHost({ '/api/rows': { ok: true, rows: [] } }), speedy({ speed: undefined }))
  await settled()
  expect(field.querySelector<HTMLElement>('.speed')!.hidden).toBe(true)
})

// ---- a table that explains its own order (alexia_protocol 8) -----------------------------

test('groups come in the declared order, a note sits under the row, and tags are chips in their tone', async () => {
  const host = fakeHost({
    '/api/rows': {
      ok: true,
      rows: [
        { id: 'p', name: 'Paid one', group: 'Paid', tags: [] },
        { id: 'a', name: 'Aside one', group: 'Set aside by Alexia', note: 'Set aside: answers with nothing.', tags: [{ says: 'answers empty', tone: 'danger' }] },
        { id: 'z', name: 'Unnamed group', group: 'Another', tags: 'not a list' },
        { id: 'f', name: 'Free one', group: 'Automatic, free', note: 'First choice.', tags: [{ says: 'busy', tone: 'caution' }, { says: 'router', tone: 'loud' }, 'talk only'] },
      ],
    },
  })
  const field = widget(host, {
    type: 'table',
    key: 'models',
    label: 'Models',
    rows: 'models',
    filter: true,
    groupBy: 'group',
    groupOrder: ['Your list', 'Automatic, free', 'Set aside by Alexia', 'Paid'],
    columns: [
      { key: 'name', label: 'Model' },
      { key: 'tags', label: 'Tags' },
    ],
  })
  await settled()

  // Named groups in their order, an unnamed one after them, and an empty named one not at all.
  expect([...field.querySelectorAll('tr.group th')].map((th) => th.textContent)).toEqual([
    'Automatic, free',
    'Set aside by Alexia',
    'Paid',
    'Another',
  ])
  const free = [...field.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.includes('Free one'))!
  expect(free.querySelector('.row-note')?.textContent).toBe('First choice.')
  // An unknown tone is read as a fact, and a bare string is a quiet tag.
  expect([...free.querySelectorAll('.tag')].map((tag) => `${tag.textContent} ${tag.className}`)).toEqual([
    'busy tag caution',
    'router tag quiet',
    'talk only tag quiet',
  ])
  // Tags that are not a list draw as nothing rather than as "not a list".
  const odd = [...field.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.includes('Unnamed group'))!
  expect(odd.textContent).not.toContain('not a list')

  // The filter finds a row by its note and by what its tags say.
  const filter = field.querySelector<HTMLInputElement>('.table-filter')!
  filter.value = 'answers with nothing'
  filter.dispatchEvent(new Event('input'))
  expect([...field.querySelectorAll('tbody tr:not(.group):not(.detail)')].map((tr) => tr.querySelector('td')?.firstChild?.textContent)).toEqual(['Aside one'])
  filter.value = 'busy'
  filter.dispatchEvent(new Event('input'))
  expect([...field.querySelectorAll('tbody tr:not(.group):not(.detail)')].map((tr) => tr.querySelector('td')?.firstChild?.textContent)).toEqual(['Free one'])
})

test('a group says what it is, chips narrow the table, and the row itself opens the detail', async () => {
  const host = fakeHost({
    '/api/rows': {
      ok: true,
      rows: [
        { id: 'f', name: 'Free one', group: 'Automatic, free', tags: [{ says: 'busy', tone: 'caution' }] },
        { id: 'n', name: 'New one', group: 'Automatic, free', tags: [{ says: 'new · not tried yet', tone: 'caution' }] },
        { id: 'a', name: 'Aside one', group: 'Set aside by Alexia', tags: [{ says: 'answers empty', tone: 'danger' }] },
      ],
    },
    '/api/detail': { ok: true, text: 'Everything known about it.' },
  })
  const field = widget(host, {
    type: 'table',
    key: 'models',
    label: 'Models',
    rows: 'models',
    filter: true,
    detail: 'model',
    columns: [
      { key: 'name', label: 'Model' },
      { key: 'tags', label: 'Tags' },
    ],
    groupBy: 'group',
    groupOrder: ['Automatic, free', 'Set aside by Alexia'],
    groupNotes: { 'Set aside by Alexia': 'What Alexia has stopped asking on her own.' },
    chips: [
      { key: 'attention', label: 'Needs attention', tags: ['busy'] },
      { key: 'aside', label: 'Set aside', group: 'Set aside by Alexia' },
      // Naming neither a group nor a tag: it would match nothing, so it is never drawn.
      { key: 'dead', label: 'Nothing' },
    ],
  })
  await settled()

  const names = (): (string | null | undefined)[] =>
    [...field.querySelectorAll('tbody tr:not(.group):not(.detail)')].map((tr) => tr.querySelector('td')?.firstChild?.textContent)

  // The line under the heading it belongs to, and no line under the group that has none.
  expect([...field.querySelectorAll('tr.group-note td')].map((td) => td.textContent)).toEqual([
    'What Alexia has stopped asking on her own.',
  ])

  const chips = [...field.querySelectorAll<HTMLButtonElement>('.table-chip')]
  expect(chips.map((chip) => chip.textContent)).toEqual(['Needs attention', 'Set aside'])
  expect(names()).toEqual(['Free one', 'New one', 'Aside one'])

  // A chip on a tag, then the same chip again to put the table back.
  chips[0]!.click()
  expect(chips[0]!.getAttribute('aria-pressed')).toBe('true')
  expect(names()).toEqual(['Free one'])
  chips[0]!.click()
  expect(chips[0]!.getAttribute('aria-pressed')).toBe('false')
  expect(names()).toEqual(['Free one', 'New one', 'Aside one'])

  // A chip on a group, and one chip at a time — pressing the second lets the first go.
  chips[0]!.click()
  chips[1]!.click()
  expect(chips[0]!.getAttribute('aria-pressed')).toBe('false')
  expect(names()).toEqual(['Aside one'])

  // The filter box searches inside what the chip left rather than fighting it.
  const filter = field.querySelector<HTMLInputElement>('.table-filter')!
  filter.value = 'Free'
  filter.dispatchEvent(new Event('input'))
  expect(names()).toEqual([])
  filter.value = ''
  filter.dispatchEvent(new Event('input'))
  chips[1]!.click()

  // Clicking the row opens its detail, the same drawer the button opens.
  const row = [...field.querySelectorAll('tbody tr:not(.group):not(.detail)')].find((tr) =>
    tr.textContent?.includes('Free one'),
  )!
  row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await settled()
  expect(host.sent.some((one) => one.path === '/api/detail' && one.body.row === 'f')).toBe(true)
  expect(row.nextElementSibling?.className).toContain('detail')
  expect((row.nextElementSibling as HTMLElement).hidden).toBe(false)
  expect(row.querySelector('button')?.textContent).toBe('Hide')

  // A press on a row's own button is that button's, not the row's: it does not toggle twice.
  row.querySelector<HTMLButtonElement>('button')!.click()
  expect((row.nextElementSibling as HTMLElement).hidden).toBe(true)
})

// ---- tree (`alexia_protocol` 11) ---------------------------------------------------------

/** What `memory_tree` answers, per the contract — the rows core hands the shell. */
const memoryTree = (
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'memory-tree.json'), 'utf8')) as { nodes: Row[] }
).nodes

/** The memory panel's own declaration, near enough: the actions, with where each one applies. */
const treeWidget: Rendered = {
  type: 'tree',
  key: 'remembered_tree',
  label: 'The shape of it',
  rows: 'memory_tree',
  detail: 'about_memory',
  filter: true,
  rowActions: [
    { key: 'note_pin', label: 'Always know this', unless: { tag: 'always known' } },
    { key: 'note_unpin', label: 'Stop always knowing', when: { tag: 'always known' } },
    { key: 'note_accept_suggestion', label: 'Accept suggestion', when: { tag: 'suggestion' } },
    { key: 'note_still_true', label: 'Still true', when: { tag: 'may be out of date' } },
    { key: 'note_no_longer_true', label: 'No longer true', unless: { tag: 'no longer true' } },
    { key: 'note_history', label: 'History' },
    { key: 'note_forget', label: 'Forget', confirm: 'Forget it, and every earlier version of it?' },
  ],
}

const treeHost = () =>
  fakeHost({ '/api/rows': { ok: true, rows: memoryTree }, '/api/detail': { ok: true, text: 'The whole of it.' } })

/** Every item a person could see right now — inside no closed branch — by its label. */
const visibleLabels = (field: HTMLElement): string[] =>
  [...field.querySelectorAll<HTMLElement>('[role="treeitem"]')]
    .filter((item) => item.parentElement?.closest('[hidden]') === null)
    .map((item) => item.querySelector(':scope > .tree-row .tree-label')?.textContent ?? '')

const itemFor = (field: HTMLElement, label: string, nth = 0): HTMLElement =>
  [...field.querySelectorAll<HTMLElement>('[role="treeitem"]')].filter(
    (item) => item.querySelector(':scope > .tree-row .tree-label')?.textContent === label,
  )[nth]!

/**
 * A fresh store for every test. Stubbed rather than borrowed: under this runner `localStorage`
 * is Node's own, which is absent without a flag — and the tree must work either way.
 */
beforeEach(() => {
  const held = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
  })
  return () => {
    vi.unstubAllGlobals()
  }
})

test('a tree opens at the top, with each section closed and saying how much is in it', async () => {
  const field = widget(treeHost(), treeWidget)
  await settled()

  const tree = field.querySelector('[role="tree"]')!
  expect(tree.getAttribute('aria-label')).toBe('The shape of it')
  // The root is open and the sections under it are shut, so the first screen is a table of contents.
  expect(visibleLabels(field)).toEqual(['You', 'People', 'Studies', 'Projects & code', 'Identity & how to talk to me'])
  expect(itemFor(field, 'You').getAttribute('aria-expanded')).toBe('true')
  expect(itemFor(field, 'People').getAttribute('aria-expanded')).toBe('false')
  expect(itemFor(field, 'People').getAttribute('aria-level')).toBe('2')

  // The count the tool said, or — where it said none — the notes actually under it.
  const count = (label: string): string | null | undefined =>
    itemFor(field, label).querySelector(':scope > .tree-row .tree-count')?.textContent
  expect(count('People')).toBe('2')
  expect(count('Studies')).toBe('2')
  expect(count('Family')).toBe('1')
  // And its summary as a quiet line under it.
  expect(itemFor(field, 'People').querySelector(':scope > .tree-row .tree-summary')?.textContent).toBe(
    'Who is who in your life.',
  )

  // A note's tags are a table's tags.
  const ted = itemFor(field, 'Ted is his flatmate, not the Czech teacher')
  expect([...ted.querySelectorAll('.tag')].map((tag) => `${tag.textContent} ${tag.className}`)).toEqual([
    'worked out tag quiet',
    'may be out of date tag quiet',
  ])

  // One tab stop in the whole tree.
  expect([...field.querySelectorAll<HTMLElement>('[role="treeitem"]')].filter((item) => item.tabIndex === 0)).toHaveLength(1)
})

test('a note filed in two places is under both, and each says where else it lives', async () => {
  const field = widget(treeHost(), treeWidget)
  await settled()

  const grant = 'The grant deadline is in March'
  const underStudies = itemFor(field, grant, 0)
  const underProjects = itemFor(field, grant, 1)
  expect(underStudies.closest('.is-branch')?.querySelector('.tree-label')?.textContent).toBe('Studies')
  expect(underProjects.closest('.is-branch')?.querySelector('.tree-label')?.textContent).toBe('Projects & code')
  expect(underStudies.querySelector('.tree-also')?.textContent).toBe('also filed under Projects & code')
  expect(underProjects.querySelector('.tree-also')?.textContent).toBe('also filed under Studies')
  // A note filed once says nothing about it.
  expect(itemFor(field, 'Alexia is written in TypeScript').querySelector('.tree-also')).toBeNull()
})

test('the filter keeps the notes that match and every branch they are filed under', async () => {
  const field = widget(treeHost(), treeWidget)
  await settled()
  const filter = field.querySelector<HTMLInputElement>('.table-filter')!

  filter.value = 'marta'
  filter.dispatchEvent(new Event('input'))
  // Three levels up to the root, all opened, and nothing else.
  expect(visibleLabels(field)).toEqual(['You', 'People', 'Family', 'His sister is called Marta'])

  // A tag is something a note says about itself, so it is searched too — and a note in two
  // places is kept in both.
  filter.value = 'suggestion'
  filter.dispatchEvent(new Event('input'))
  expect(visibleLabels(field)).toEqual([
    'You',
    'Studies',
    'The grant deadline is in March',
    'Projects & code',
    'The grant deadline is in March',
  ])

  // A branch whose own name matches brings what is in it.
  filter.value = 'family'
  filter.dispatchEvent(new Event('input'))
  expect(visibleLabels(field)).toEqual(['You', 'People', 'Family', 'His sister is called Marta'])

  filter.value = 'nothing like this'
  filter.dispatchEvent(new Event('input'))
  expect(visibleLabels(field)).toEqual([])
  expect(field.querySelector('.hint:not([hidden])')?.textContent).toBe('Nothing matches that.')

  // Clearing it puts the tree back as it was left, rather than as the filter opened it.
  filter.value = ''
  filter.dispatchEvent(new Event('input'))
  expect(visibleLabels(field)).toEqual(['You', 'People', 'Studies', 'Projects & code', 'Identity & how to talk to me'])
})

test('the keyboard walks what is visible, opens branches, and opens a note', async () => {
  const host = treeHost()
  const field = widget(host, treeWidget)
  host.root().append(field)
  await settled()
  const press = (key: string): void => {
    ;(document.activeElement ?? field).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  }
  const focused = (): string | null | undefined =>
    (document.activeElement as HTMLElement | null)?.querySelector(':scope > .tree-row .tree-label')?.textContent

  itemFor(field, 'You').focus()
  press('ArrowDown')
  expect(focused()).toBe('People')
  press('ArrowRight')
  expect(itemFor(field, 'People').getAttribute('aria-expanded')).toBe('true')
  press('ArrowRight')
  expect(focused()).toBe('Family')
  press('ArrowDown')
  // Family is shut, so the next thing is the note beside it.
  expect(focused()).toBe('Ted is his flatmate, not the Czech teacher')
  press('ArrowLeft')
  expect(focused()).toBe('People')
  press('ArrowLeft')
  expect(itemFor(field, 'People').getAttribute('aria-expanded')).toBe('false')
  press('End')
  expect(focused()).toBe('Identity & how to talk to me')
  press('Enter')
  press('ArrowDown')
  expect(focused()).toBe('Call him Vaclav')
  press('Enter')
  await settled()
  expect(host.sent.some((one) => one.path === '/api/detail' && one.body.row === '15')).toBe(true)
  expect(itemFor(field, 'Call him Vaclav').getAttribute('aria-expanded')).toBe('true')
  expect(itemFor(field, 'Call him Vaclav').querySelector('.detail-text')?.textContent).toBe('The whole of it.')
})

test('which branches are open is remembered for the next time the tree is drawn', async () => {
  const first = widget(treeHost(), treeWidget)
  await settled()
  itemFor(first, 'Studies').querySelector<HTMLElement>(':scope > .tree-row')!.click()
  itemFor(first, 'You').querySelector<HTMLElement>(':scope > .tree-row')!.click()
  expect(visibleLabels(first)).toEqual(['You'])

  const again = widget(treeHost(), treeWidget)
  await settled()
  expect(itemFor(again, 'You').getAttribute('aria-expanded')).toBe('false')
  itemFor(again, 'You').querySelector<HTMLElement>(':scope > .tree-row')!.click()
  expect(visibleLabels(again)).toEqual([
    'You',
    'People',
    'Studies',
    'The grant deadline is in March',
    'Studied physics in Brno',
    'Projects & code',
    'Identity & how to talk to me',
  ])
})

test('a tree still draws when this browser will not remember anything', async () => {
  // A private window, a blocked site: every read and write throws.
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('denied')
    },
    setItem: () => {
      throw new Error('denied')
    },
  })
  const field = widget(treeHost(), treeWidget)
  await settled()
  expect(visibleLabels(field)[0]).toBe('You')
  itemFor(field, 'People').querySelector<HTMLElement>(':scope > .tree-row')!.click()
  expect(itemFor(field, 'People').getAttribute('aria-expanded')).toBe('true')

  // And a browser with no storage at all, which is what this test runner is.
  vi.stubGlobal('localStorage', undefined)
  const bare = widget(treeHost(), treeWidget)
  await settled()
  expect(visibleLabels(bare)[0]).toBe('You')
})

test('an open note shows only the actions that apply to it, and they press with its id', async () => {
  const host = treeHost()
  const field = widget(host, treeWidget)
  await settled()
  const actionsOn = (label: string): string[] => {
    const item = itemFor(field, label)
    if (item.getAttribute('aria-expanded') !== 'true') item.querySelector<HTMLElement>(':scope > .tree-row')!.click()
    return [...item.querySelectorAll('.tree-actions button')].map((button) => button.textContent ?? '')
  }

  itemFor(field, 'Identity & how to talk to me').querySelector<HTMLElement>(':scope > .tree-row')!.click()
  expect(actionsOn('Call him Vaclav')).toEqual(['Stop always knowing', 'No longer true', 'History', 'Forget'])

  itemFor(field, 'Studies').querySelector<HTMLElement>(':scope > .tree-row')!.click()
  expect(actionsOn('The grant deadline is in March')).toEqual([
    'Always know this',
    'Accept suggestion',
    'No longer true',
    'History',
    'Forget',
  ])
  expect(actionsOn('Studied physics in Brno')).toEqual(['Always know this', 'History', 'Forget'])

  itemFor(field, 'People').querySelector<HTMLElement>(':scope > .tree-row')!.click()
  expect(actionsOn('Ted is his flatmate, not the Czech teacher')).toEqual([
    'Always know this',
    'Still true',
    'No longer true',
    'History',
    'Forget',
  ])

  // A press carries the note's own id — the one `about_memory` and the table's actions take —
  // and does not close the note it was pressed in.
  const ted = itemFor(field, 'Ted is his flatmate, not the Czech teacher')
  const still = [...ted.querySelectorAll<HTMLButtonElement>('.tree-actions button')].find((b) => b.textContent === 'Still true')!
  still.click()
  await settled()
  expect(host.sent.find((one) => one.path === '/api/action')?.body).toMatchObject({ key: 'note_still_true', row: '12' })

  // Branches have no actions: they are where things are filed, not things.
  expect(itemFor(field, 'People').querySelector(':scope > .tree-body')).toBeNull()
})

test('the tree’s shape is worked out without a document', () => {
  const nodes = treeNodes(memoryTree)
  const shape = treeShape(nodes)
  expect(shape.roots.map((node) => node.id)).toEqual(['b1'])
  expect(shape.children.get('b4')?.map((node) => node.id)).toEqual(['13', '14'])
  expect(shape.notesUnder('b1')).toBe(6)

  // A parent that is not there, or that is a note, is no parent: the node goes to the top.
  const odd = treeShape(
    treeNodes([
      { id: 'b1', parent: null, kind: 'branch', label: 'Root' },
      { id: '2', parent: 'b9', kind: 'note', label: 'Orphan' },
      { id: '3', parent: '2', kind: 'note', label: 'Under a note' },
      // And a branch filed inside itself is counted, not recursed into forever.
      { id: 'b4', parent: 'b5', kind: 'branch', label: 'Loop A' },
      { id: 'b5', parent: 'b4', kind: 'branch', label: 'Loop B' },
      { id: '6', parent: 'b4', kind: 'note', label: 'In the loop' },
    ]),
  )
  expect(odd.roots.map((node) => node.id)).toEqual(['b1', '2', '3'])
  expect(odd.notesUnder('b4')).toBe(1)
  expect(odd.notesUnder('b5')).toBe(1)

  expect(treeMatches(nodes, '  ')).toBeUndefined()
  expect([...treeMatches(nodes, 'typescript')!].sort()).toEqual(['14', 'b1', 'b4'])
})

test('a branch loop is drawn once rather than until the stack runs out', async () => {
  const host = fakeHost({
    '/api/rows': {
      ok: true,
      rows: [
        { id: 'b1', parent: null, kind: 'branch', label: 'Root' },
        { id: 'b2', parent: 'b1', kind: 'branch', label: 'A', also: ['b3'] },
        { id: 'b3', parent: 'b2', kind: 'branch', label: 'B' },
      ],
    },
  })
  const field = widget(host, { ...treeWidget, filter: false })
  await settled()
  expect(field.querySelectorAll('[role="treeitem"]').length).toBeLessThan(10)
})

// ---- row actions that apply (`alexia_protocol` 11) ------------------------------------------

test('a table row shows only the actions that apply, and a table that says nothing shows them all', async () => {
  const rows = [
    { id: '1', text: 'Pinned one', pinned: 'always known', tags: [] },
    { id: '2', text: 'Doubtful one', pinned: '', tags: [{ says: 'may be out of date', tone: 'caution' }] },
    { id: '3', text: 'Gone one', pinned: '', tags: [{ says: 'no longer true', tone: 'quiet' }] },
    { id: '4', text: 'Suggested one', pinned: 'suggested', tags: [{ says: 'suggestion', tone: 'quiet' }] },
  ]
  const declared: Rendered = {
    type: 'table',
    key: 'remembered_list',
    label: 'Remembered',
    rows: 'memories',
    columns: [{ key: 'text', label: 'What' }],
    rowActions: [
      { key: 'still_true', label: 'Still true', when: { tag: 'may be out of date' } },
      { key: 'no_longer_true', label: 'No longer true', unless: { tag: 'no longer true' } },
      { key: 'accept_suggestion', label: 'Accept suggestion', when: { tag: 'suggestion' } },
      { key: 'history', label: 'History' },
      { key: 'pin', label: 'Always know this', unless: { field: 'pinned', is: 'always known' } },
      { key: 'unpin', label: 'Stop always knowing', when: { field: 'pinned', is: 'always known' } },
      { key: 'forget_one', label: 'Forget', confirm: 'Forget it?' },
    ],
  }
  const field = widget(fakeHost({ '/api/rows': { ok: true, rows } }), declared)
  await settled()
  const buttons = (text: string): string[] => {
    const row = [...field.querySelectorAll('tbody tr')].find((tr) => tr.querySelector('td')?.textContent === text)!
    return [...row.querySelectorAll('.row-actions button')].map((button) => button.textContent ?? '')
  }
  expect(buttons('Pinned one')).toEqual(['No longer true', 'History', 'Stop always knowing', 'Forget'])
  expect(buttons('Doubtful one')).toEqual(['Still true', 'No longer true', 'History', 'Always know this', 'Forget'])
  expect(buttons('Gone one')).toEqual(['History', 'Always know this', 'Forget'])
  expect(buttons('Suggested one')).toEqual(['No longer true', 'Accept suggestion', 'History', 'Always know this', 'Forget'])

  // An older plugin, with no `when` anywhere: every action on every row, exactly as before.
  const plain = widget(fakeHost({ '/api/rows': { ok: true, rows } }), {
    ...declared,
    rowActions: declared.rowActions!.map(({ key, label }) => ({ key, label })),
  })
  await settled()
  for (const row of plain.querySelectorAll('tbody tr')) expect(row.querySelectorAll('.row-actions button')).toHaveLength(7)
})

test('a field condition without a value means the field is there and not empty', () => {
  const action = { key: 'k', label: 'K', when: { field: 'owner' } }
  expect(applies(action, { id: '1', owner: 'Marta' })).toBe(true)
  expect(applies(action, { id: '1', owner: '' })).toBe(false)
  expect(applies(action, { id: '1', owner: [] })).toBe(false)
  expect(applies(action, { id: '1' })).toBe(false)
  // Tags as bare strings — a tree's — are read the same as a table's.
  expect(applies({ key: 'k', label: 'K', when: { tag: 'x' } }, { id: '1', tags: ['x'] })).toBe(true)
  // `when` and `unless` together: both must hold.
  expect(applies({ key: 'k', label: 'K', when: { tag: 'x' }, unless: { tag: 'y' } }, { id: '1', tags: ['x', 'y'] })).toBe(false)
  // And a card's bare `state` still means what it always did.
  expect(applies({ key: 'k', label: 'K', when: 'installed' }, { id: '1', state: 'installed' })).toBe(true)
  expect(applies({ key: 'k', label: 'K', when: 'installed' }, { id: '1', state: 'available' })).toBe(false)
})
