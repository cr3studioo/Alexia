// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The chat shell. No Node in here, ever (invariant 6) — at M5 Tauri wraps this page as it
 * stands, and anything that reached for a Node builtin would be a rewrite scheduled for the
 * worst possible moment.
 *
 * It talks to core over loopback, with a token the server injected into the page. Two things
 * are always on screen and neither is decoration: **which model answered**, so you know
 * where your words went, and **what the month has cost**, so nobody is ever surprised by a
 * bill.
 */

interface Turn {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  model?: string
}

interface Provider {
  id: string
  name: string
  terms?: string
  trainsOnYourData: 'yes' | 'no' | 'unknown'
  free: boolean
}

interface Command {
  name: string
  summary: string
  alias?: string
  plugin?: string
  shadowed?: boolean
}

interface State {
  setup: { done: boolean; name: string; mode: string }
  messages: Turn[]
  spent: number
  cap?: number
  warning?: string
  providers: Provider[]
  commands: Command[]
}

const token = document.querySelector<HTMLElement>('[data-token]')?.dataset.token ?? ''
const log = document.querySelector<HTMLElement>('#log')!
const note = document.querySelector<HTMLElement>('#note')!
const modelBadge = document.querySelector<HTMLElement>('#model')!
const spendBadge = document.querySelector<HTMLElement>('#spend')!
const form = document.querySelector<HTMLFormElement>('#ask')!
const text = document.querySelector<HTMLTextAreaElement>('#text')!
const button = form.querySelector('button')!

const money = (n: number): string => `$${n.toFixed(2)}`

function bubble(kind: 'user' | 'assistant' | 'refusal', content = ''): HTMLElement {
  const element = document.createElement('div')
  element.className = `turn ${kind}`
  element.textContent = content
  log.append(element)
  log.scrollTop = log.scrollHeight
  return element
}

function say(line?: string): void {
  note.textContent = line ?? ''
  note.hidden = !line
}

/**
 * First run, steps 2 to 4a: what to call it, where the work happens, and — only if that
 * answer involves somebody else's computer — a key. Nothing else. No account, no tour, no
 * permission questions, because asking which folders an assistant may read before it has
 * been given a single task is a question with no meaning yet.
 */
function firstRun(state: State): void {
  const setup = document.querySelector<HTMLElement>('#setup')!
  const connect = document.querySelector<HTMLElement>('#connect')!
  const provider = document.querySelector<HTMLSelectElement>('#provider')!
  const terms = document.querySelector<HTMLElement>('#terms')!
  const name = document.querySelector<HTMLInputElement>('#name')!
  const key = document.querySelector<HTMLInputElement>('#key')!
  setup.hidden = false
  form.hidden = true
  name.value = state.setup.name

  for (const option of state.providers) {
    provider.add(new Option(option.free ? `${option.name} — free tier` : option.name, option.id))
  }

  // The honest trade, said out loud on the card that recommends itself. Nobody has read
  // these terms yet, and "we have not checked" beats a confident wrong answer.
  const unchecked = state.providers.filter((p) => p.trainsOnYourData === 'unknown').length
  document.querySelector<HTMLElement>('#training')!.textContent =
    unchecked > 0 ?
      `Whether these providers train on what you send them is not yet checked — ${unchecked} of ${state.providers.length}. Alexia will say so rather than guess.`
    : ''

  const chosen = (): string =>
    document.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.value ?? 'combined'

  const showTerms = (): void => {
    const picked = state.providers.find((p) => p.id === provider.value)
    // Local mode asks nobody for a key, so the whole step goes away rather than sitting
    // there greyed out looking like something you got wrong.
    connect.hidden = chosen() === 'local'
    terms.textContent = picked?.terms ? `Terms: ${picked.terms}` : ''
  }
  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.addEventListener('change', showTerms)
  }
  provider.addEventListener('change', showTerms)
  showTerms()

  document.querySelector<HTMLElement>('#begin')!.addEventListener('click', () => {
    void fetch('/api/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alexia-token': token },
      body: JSON.stringify({
        name: name.value.trim() || 'Alexia',
        mode: chosen(),
        ...(key.value.trim() && { provider: { id: provider.value, key: key.value.trim() } }),
      }),
    }).then(() => {
      setup.hidden = true
      form.hidden = false
      document.querySelector<HTMLElement>('.name')!.textContent = name.value.trim() || 'Alexia'
      text.focus()
    })
  })
}

async function load(): Promise<void> {
  const state = (await (await fetch('/api/state', { headers: { 'x-alexia-token': token } })).json()) as State
  document.querySelector<HTMLElement>('.name')!.textContent = state.setup.name
  known = state.commands
  document.querySelector<HTMLSelectElement>('#mode')!.value = state.setup.mode
  if (!state.setup.done) firstRun(state)

  for (const turn of state.messages) {
    if (turn.role !== 'user' && turn.role !== 'assistant') continue
    bubble(turn.role, turn.content)
    if (turn.model) modelBadge.textContent = turn.model
  }
  spendBadge.textContent = state.cap === undefined ? money(state.spent) : `${money(state.spent)} of ${money(state.cap)}`
  say(state.warning)
}

/**
 * The `data:` frames of a stream, as they arrive. The same shape core's provider client
 * parses on the other side — duplicated rather than shared, because this file cannot import
 * anything that has ever seen a Node builtin.
 */
async function* frames(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    let cut = buffer.indexOf('\n')
    while (cut !== -1) {
      const line = buffer.slice(0, cut).trim()
      buffer = buffer.slice(cut + 1)
      if (line.startsWith('data:')) yield JSON.parse(line.slice(5).trim()) as Record<string, unknown>
      cut = buffer.indexOf('\n')
    }
  }
}

async function ask(question: string): Promise<void> {
  bubble('user', question)
  const answer = bubble('assistant')
  answer.textContent = '…'
  let started = false

  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-alexia-token': token },
    body: JSON.stringify({ text: question }),
  })
  if (!response.body) {
    answer.textContent = 'Alexia is not answering.'
    return
  }

  for await (const event of frames(response.body)) {
    if (typeof event.delta === 'string') {
      if (!started) {
        answer.textContent = ''
        started = true
      }
      answer.textContent += event.delta
      log.scrollTop = log.scrollHeight
    }
    // The one plain line before a charge, and the monthly warning, land in the same place.
    if (typeof event.note === 'string') say(event.note)
    if (typeof event.error === 'string') {
      answer.remove()
      bubble('refusal', event.error)
    }
    const done = event.done as { model?: string; spent?: number; warning?: string } | undefined
    if (done) {
      if (done.model) modelBadge.textContent = done.model
      if (typeof done.spent === 'number') {
        const shown = spendBadge.textContent ?? ''
        const cap = shown.includes(' of ') ? shown.slice(shown.indexOf(' of ')) : ''
        spendBadge.textContent = money(done.spent) + cap
      }
      if (done.warning) say(done.warning)
    }
  }
}

// ---- commands: the shortcut half -----------------------------------------------------

const menu = document.querySelector<HTMLElement>('#menu')!
const mode = document.querySelector<HTMLSelectElement>('#mode')!
let known: Command[] = []

/** Run one, from the input or from a control. Both go the same way in. */
async function command(input: string): Promise<void> {
  const ran = (await (
    await fetch('/api/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alexia-token': token },
      body: JSON.stringify({ input }),
    })
  ).json()) as { ok: boolean; note: string; setup: { mode: string } }
  bubble('refusal', ran.note)
  mode.value = ran.setup.mode
}

function showMenu(): void {
  const typed = text.value
  if (!typed.startsWith('/')) {
    menu.hidden = true
    return
  }
  const prefix = typed.slice(1).split(/\s/)[0] ?? ''
  const matches = known.filter((c) => c.name.startsWith(prefix)).slice(0, 8)
  menu.replaceChildren(
    ...matches.map((c) => {
      const item = document.createElement('li')
      if (c.shadowed) item.className = 'shadowed'
      const name = document.createElement('b')
      // A shadowed command still works; it is just longer than its author hoped, and the
      // list says so rather than leaving somebody typing a word that does nothing.
      name.textContent = `/${c.name}`
      const summary = document.createElement('span')
      summary.textContent = c.shadowed ? `${c.summary} — the short name was taken` : c.summary
      item.append(name, summary)
      item.addEventListener('mousedown', (event) => {
        event.preventDefault()
        text.value = `/${c.name}`
        menu.hidden = true
        form.requestSubmit()
      })
      return item
    }),
  )
  menu.hidden = matches.length === 0
}

text.addEventListener('input', showMenu)
mode.addEventListener('change', () => void command(`/${mode.value}`))

form.addEventListener('submit', (event) => {
  event.preventDefault()
  const question = text.value.trim()
  if (!question) return
  text.value = ''
  menu.hidden = true
  if (question.startsWith('/')) {
    void command(question)
    return
  }
  button.disabled = true
  void ask(question)
    .catch((error: unknown) => bubble('refusal', String(error)))
    .finally(() => {
      button.disabled = false
      text.focus()
    })
})

// Enter sends, Shift+Enter is a newline — the shape every chat window has, so nobody has
// to be told.
text.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    form.requestSubmit()
  }
})

await load()
