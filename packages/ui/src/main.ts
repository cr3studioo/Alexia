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

interface Permissions {
  mode: string
  modes: Record<string, string>
  roots: string[]
  everywhere: boolean
  boundaries: { said: string; blocks: string }[]
}

interface State {
  setup: { done: boolean; name: string; mode: string }
  permissions: Permissions
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
const prompt = document.querySelector<HTMLElement>('#prompt')!
const promptWhy = document.querySelector<HTMLElement>('#prompt-why')!
const permission = document.querySelector<HTMLSelectElement>('#permission')!
const stop = document.querySelector<HTMLButtonElement>('#stop')!

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
/**
 * The chosen name, everywhere it is written down. Alexia.md is explicit that whatever gets
 * typed at step 2 "becomes the name they see everywhere" — and the composer, which is the
 * box a renamer looks at most, was the one place still saying "Ask Alexia" out loud.
 */
function called(name: string): void {
  document.querySelector<HTMLElement>('.name')!.textContent = name
  text.placeholder = `Ask ${name}`
}

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
      called(name.value.trim() || 'Alexia')
      text.focus()
    })
  })
}

async function load(): Promise<void> {
  const state = (await (await fetch('/api/state', { headers: { 'x-alexia-token': token } })).json()) as State
  called(state.setup.name)
  known = state.commands
  document.querySelector<HTMLSelectElement>('#mode')!.value = state.setup.mode
  if (!state.setup.done) firstRun(state)

  for (const turn of state.messages) {
    if (turn.role !== 'user' && turn.role !== 'assistant') continue
    bubble(turn.role, turn.content)
    if (turn.model) modelBadge.textContent = turn.model
  }
  spendBadge.textContent = state.cap === undefined ? money(state.spent) : `${money(state.spent)} of ${money(state.cap)}`
  showPermissions(state.permissions)
  say(state.warning)
}

/**
 * The permission control, filled from core's own labels rather than a copy of them here —
 * two lists of four modes that have to agree is one list too many.
 */
function showPermissions(state: Permissions): void {
  if (permission.options.length === 0) {
    for (const [value, label] of Object.entries(state.modes)) permission.add(new Option(label, value))
    permission.addEventListener('change', () => {
      void fetch('/api/permissions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-alexia-token': token },
        body: JSON.stringify({ mode: permission.value }),
      })
    })
  }
  permission.value = state.mode

  // A standing boundary is the user's own sentence holding things back. It stays on screen
  // while it applies, because a rule you cannot see is a rule you cannot find the end of.
  const boundary = state.boundaries[0]
  if (boundary) say(`Holding: “${boundary.said}”. Say so and I will lift it.`)
}

/** The permission prompt. One question at a time, and the answer goes straight back. */
function askPermission(why: string): void {
  promptWhy.textContent = why
  prompt.hidden = false
  const answer = (allowed: boolean) => () => {
    prompt.hidden = true
    void fetch('/api/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alexia-token': token },
      body: JSON.stringify({ allowed }),
    })
  }
  // `once` on both, because the pair is replaced wholesale for the next question.
  document.querySelector('#allow')!.addEventListener('click', answer(true), { once: true })
  document.querySelector('#deny')!.addEventListener('click', answer(false), { once: true })
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

/**
 * The trace. One panel per task, one row per step, and the row appears **before** the work
 * rather than after it — a step nobody can see until it finishes is a spinner with extra
 * steps, and a spinner during a five-minute run is how trust goes.
 */
function trace(): { step(n: number, name: string): void; done(n: number, ok: boolean, text: string): void } {
  let panel: HTMLElement | undefined
  const rows = new Map<number, HTMLElement>()
  return {
    step(n, name) {
      panel ??= (() => {
        const made = document.createElement('div')
        made.className = 'trace'
        log.append(made)
        return made
      })()
      const row = document.createElement('div')
      row.className = 'step running'
      const count = document.createElement('span')
      count.className = 'n'
      count.textContent = String(n)
      const what = document.createElement('span')
      what.className = 'what'
      what.textContent = name
      const said = document.createElement('span')
      said.className = 'said'
      row.append(count, what, said)
      panel.append(row)
      rows.set(n, row)
      log.scrollTop = log.scrollHeight
    },
    done(n, ok, text) {
      const row = rows.get(n)
      if (!row) return
      row.className = ok ? 'step' : 'step failed'
      // What came back, on one line. The full text is in the conversation the model reads;
      // this is the glance version, and a glance that scrolls is not a glance.
      const said = row.querySelector('.said')
      if (said) said.textContent = text.replace(/\s+/g, ' ').slice(0, 120)
      log.scrollTop = log.scrollHeight
    },
  }
}

async function ask(question: string): Promise<void> {
  bubble('user', question)
  const steps = trace()
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
    if (typeof event.ask === 'string') askPermission(event.ask)
    const step = event.step as { n: number; name: string; ok?: boolean; text?: string } | undefined
    if (step) {
      if (step.ok === undefined) {
        steps.step(step.n, step.name)
        // The answer bubble moves below the steps it came from, so the trace reads in the
        // order it happened rather than the order the elements were created.
        log.append(answer)
      } else {
        steps.done(step.n, step.ok, step.text ?? '')
      }
    }
    if (typeof event.error === 'string') {
      answer.remove()
      bubble('refusal', event.error)
    }
    const done = event.done as
      | { model?: string; spent?: number; warning?: string; ended?: string; steps?: number }
      | undefined
    if (done) {
      if (done.model) modelBadge.textContent = done.model
      if (typeof done.spent === 'number') {
        const shown = spendBadge.textContent ?? ''
        const cap = shown.includes(' of ') ? shown.slice(shown.indexOf(' of ')) : ''
        spendBadge.textContent = money(done.spent) + cap
      }
      if (done.warning) say(done.warning)
      prompt.hidden = true
      // A task that hit a limit says which one. Silence after a stop looks like a crash.
      if (done.ended === 'stopped') say('Stopped.')
      if (done.ended === 'ceiling') say(`Stopped after ${String(done.steps ?? 0)} steps — that is the ceiling, not the end of the task.`)
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

// Mid-step, always — including while a tool call is in flight. The button does not wait
// for the step to finish and then pretend it stopped it.
stop.addEventListener('click', () => {
  stop.disabled = true
  void fetch('/api/stop', { method: 'POST', headers: { 'x-alexia-token': token } }).finally(() => {
    stop.disabled = false
  })
})

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
  stop.hidden = false
  void ask(question)
    .catch((error: unknown) => bubble('refusal', String(error)))
    .finally(() => {
      button.disabled = false
      stop.hidden = true
      prompt.hidden = true
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
