// SPDX-License-Identifier: AGPL-3.0-only
import { folded } from './widgets.js'

/**
 * Running now, Steps and Current step: what she is doing, and exactly how.
 *
 * The conversation says `computer.control` and stops. That is deliberate — the trace used to
 * sit in the log and it was the loudest thing in the room, a wall of tool names between two
 * sentences. Everything it used to say is here instead, with more of it: which plugin offers
 * the tool, what that plugin holds and the manifest's own sentence for why, the arguments the
 * model actually sent, and what came back.
 *
 * **Nothing here is invented.** The step name, its arguments and its result are the frames
 * core already streams; the plugin and its capabilities are read from `/api/rows` and
 * `/api/plugins`. Where core does not say something — which single capability a given call
 * used, as opposed to which the plugin holds — this panel does not guess, it says what it
 * knows. A screen whose whole purpose is *this is what happened* cannot afford one confident
 * wrong line.
 */

/**
 * One step of a long job, in the order the plugin runs them.
 *
 * Declared here rather than imported because the shell ships as plain modules with no
 * bundler — the same reason `Moving` restates the wire shape instead of sharing core's.
 */
export interface Stage {
  label?: string
  detail?: string
  state: 'waiting' | 'running' | 'done' | 'failed'
  progress?: number
  total?: number
}

export interface Moving {
  progress: number
  total?: number
  message?: string
  /** A picture of the work while it is still work. A `data:` URL, replaced by the next one. */
  preview?: string
  /** The job's own steps. The plugin's order, drawn left to right and never re-sorted. */
  stages?: Stage[]
  /** The stages are a plan: named points joined in order, rather than a bar. */
  plan?: boolean
  /** Buttons for the person while it runs: the plugin's own declared actions, by key. */
  controls?: { key: string; label: string }[]
}

/** How a finished step went, when its tool said: how long, how many steps, how many model calls. */
export interface Timing {
  ms: number
  steps?: number
  models?: number
}

/**
 * The event a step's button sends up the page: which tool's step it sits on, and which of that
 * plugin's actions to press. The page presses it; this file never talks to core.
 */
export const CONTROL_EVENT = 'step-control'

export interface Live {
  /** A task started, in the conversation named. */
  begin(title: string): void
  /** A call is about to run. Fired before the work, because that is the point of a trace. */
  step(n: number, name: string, args?: Record<string, unknown>): void
  moving(n: number, update: Moving): void
  done(n: number, ok: boolean, text: string, timing?: Timing): void
  /**
   * The task ended, however it ended — and *how*, when the caller knows: core's ending
   * (`answered`, `stopped`, `ceiling`, `paused`, `refused`) or `failed` for an error, with the
   * sentence that explains it. Said once: a second call for the same task changes nothing, so a
   * `finally` can call it as a backstop behind the branch that already did.
   */
  end(ended?: string, why?: string): void
}

interface Held {
  /** What the plugin is called, for a person. */
  plugin: string
  /** What the tool does, in its author's words (core's `toolWords`). */
  words?: string
  /** What it asked for, and the sentence its author had to write for each. */
  requires: { cap: string; why: string }[]
}

interface Row {
  n: number
  name: string
  args?: Record<string, unknown>
  ok?: boolean
  text?: string
  element: HTMLElement
  said: HTMLElement
  /**
   * The second line a step gets once it shows its work: the pipeline, then the picture.
   *
   * Made once, by whichever arrives first, with both elements in place and hidden — so the
   * order on screen is the order decided here rather than whichever message ComfyUI happened
   * to send first.
   */
  work?: { strip: HTMLOListElement; plan: HTMLOListElement; shot: HTMLImageElement; controls: HTMLDivElement }
}

/**
 * A tool's name as a person reads it. `media__image_generate` is how it reaches the model;
 * nobody needs to see the double underscore that made it unique.
 */
const bare = (name: string): string => {
  const cut = name.indexOf('__')
  return cut === -1 ? name : name.slice(cut + 2)
}

/**
 * The second line of a step that is showing its work, made on demand.
 *
 * Both elements exist from the first call and start hidden, so *pipeline above picture* is
 * settled here rather than by whichever of the two messages happens to arrive first. It is
 * appended to the row, after the words, because a rail row is a line of text and a picture
 * set beside the name shrinks the name to nothing.
 */
const working = (row: Row): { strip: HTMLOListElement; plan: HTMLOListElement; shot: HTMLImageElement; controls: HTMLDivElement } =>
  (row.work ??= (() => {
    const box = document.createElement('div')
    box.className = 'step-work'
    const strip = document.createElement('ol')
    strip.className = 'step-stages'
    strip.hidden = true
    const plan = document.createElement('ol')
    plan.className = 'step-plan'
    plan.hidden = true
    const shot = document.createElement('img')
    shot.className = 'step-preview'
    shot.alt = 'What this step has made so far'
    shot.decoding = 'async'
    shot.hidden = true
    const controls = document.createElement('div')
    controls.className = 'step-controls'
    controls.hidden = true
    box.append(strip, plan, controls, shot)
    row.element.append(box)
    return { strip, plan, shot, controls }
  })())

/**
 * One stage of the strip.
 *
 * The name goes on `title` and nowhere else: five names fit across this rail and twenty-five
 * do not, and the line above already says which stage is running. What the strip adds is the
 * shape — how many there are, which one is live, and how far that one has got.
 */
const segment = (stage: Stage): HTMLLIElement => {
  const li = document.createElement('li')
  // `waiting` is the empty bar itself, so it needs no class of its own.
  if (stage.state !== 'waiting') li.className = stage.state
  if (stage.label !== undefined) li.title = stage.label
  const total = stage.total ?? 0
  if (stage.state === 'running' && total > 0) {
    const far = Math.max(0, Math.min(100, Math.round(((stage.progress ?? 0) / total) * 100)))
    li.style.setProperty('--fill', `${String(far)}%`)
  }
  return li
}

/** A finished step's line: how long, how many steps, and whether any model was asked. */
export const timingLine = (timing: Timing): string =>
  [
    timing.ms < 1000 ? `${String(timing.ms)} ms` : `${(timing.ms / 1000).toFixed(1)} s`,
    ...(timing.steps !== undefined ? [`${String(timing.steps)} step${timing.steps === 1 ? '' : 's'}`] : []),
    ...(timing.models !== undefined ? [timing.models === 0 ? 'no model' : `${String(timing.models)} model call${timing.models === 1 ? '' : 's'}`] : []),
  ].join(' · ')

/**
 * One point of a plan: a circle, the step's words beside it, and a line on to the next.
 *
 * Unlike a pipeline's segment the words are shown, because a plan has a handful of steps and
 * their names are what a person is watching for — *open the results*, *press Like*. The line
 * between two points is the circle's own `::after`, so the last one simply has none.
 */
const point = (stage: Stage, at: number): HTMLLIElement => {
  const li = document.createElement('li')
  li.className = `plan-point ${stage.state}`
  const dot = document.createElement('span')
  dot.className = 'plan-dot'
  dot.textContent = stage.state === 'done' ? '✓' : stage.state === 'failed' ? '!' : String(at + 1)
  const words = document.createElement('span')
  words.className = 'plan-words'
  const label = document.createElement('span')
  label.className = 'plan-label'
  label.textContent = stage.label ?? `Step ${String(at + 1)}`
  words.append(label)
  if (stage.detail !== undefined && stage.detail !== '') {
    const detail = document.createElement('span')
    detail.className = 'plan-detail'
    detail.textContent = stage.detail
    words.append(detail)
  }
  li.append(dot, words)
  if (stage.state === 'running') li.setAttribute('aria-current', 'step')
  return li
}

/**
 * The three pages this draws into (D204). They used to be one column and are three pages on
 * the board now, each of which can be moved, sized or taken off — so each is handed over
 * rather than looked up in the document. A page that is off the board is still in the
 * markup, hidden, and keeps being written to: putting it back shows the task as it is now.
 */
export interface LiveRoots {
  running: HTMLElement
  steps: HTMLElement
  current: HTMLElement
}

/**
 * **What each permission lets a plugin do**, in words — the closed list from the protocol
 * (`PERMISSIONS`), so there is nothing here a plugin could add to. `screen.capture` is how a
 * manifest spells it; *see your screen* is what it means to the person watching. A name this
 * list does not know is shown as it is, rather than guessed at.
 */
export const CAN: Readonly<Record<string, string>> = {
  'fs.own_dir': 'keep files in its own folder',
  'fs.read_scoped': 'read files in folders you chose',
  'fs.write_scoped': 'change files in folders you chose',
  'net.download': 'download files',
  'net.request': 'reach the internet',
  'audio.input': 'hear your microphone',
  'audio.output': 'play sound',
  'screen.capture': 'see your screen',
  'input.control': 'move the mouse and type',
  'proc.spawn': 'run programs on this Mac',
  notify: 'show notifications',
}

/**
 * **How a task ended, as the last line of Steps.** Core's own endings, and `failed` for an
 * answer that ended in an error. The reason goes after a colon when there is one, because
 * *Couldn't finish* alone is the sentence that sends somebody looking for the reason.
 */
export function endingLine(ended: string, why?: string): string {
  const reason = why !== undefined && why.trim() !== '' ? `: ${why.trim()}` : ''
  switch (ended) {
    case 'answered':
      return 'Finished'
    case 'stopped':
      return 'Stopped'
    case 'ceiling':
      return 'Stopped at the step limit'
    case 'paused':
      return `Paused${reason === '' ? ', waiting for your yes to a paid model' : reason}`
    default:
      return `Couldn't finish${reason}`
  }
}

/** `14:03`, the local time a task started. */
const clock = (at: number): string => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/** Is this text a program's data rather than a sentence? Then it belongs in the fold. */
const looksRaw = (text: string): boolean => /^\s*[[{]/.test(text)

export function mountLive(token: string, roots: LiveRoots): Live {
  const runningBox = roots.running.querySelector<HTMLElement>('#running')!
  const runningCount = roots.running.querySelector<HTMLElement>('#running-count')!
  const traceBox = roots.steps.querySelector<HTMLElement>('#trace')!
  const stepCount = roots.steps.querySelector<HTMLElement>('#step-count')!
  const head = roots.current.querySelector<HTMLElement>('#detail-head')!
  const body = roots.current.querySelector<HTMLElement>('#detail')!

  const rows = new Map<number, Row>()
  let open = 0
  /** Whether a task is on screen as running — what makes a second `end()` a no-op. */
  let running = false
  /** Whether anything has been drawn since the page loaded, so the saved run never paints over it. */
  let touched = false

  const ask = async (path: string, sent: unknown): Promise<Record<string, unknown>> => {
    const answer = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alexia-token': token },
      body: JSON.stringify(sent),
    })
    return answer.ok ? ((await answer.json()) as Record<string, unknown>) : {}
  }

  /**
   * Which plugin offers which tool, what that plugin holds, and what the tool does in words.
   *
   * Read once and kept, because it changes when a plugin is installed or disabled and not
   * between two steps of one task. Nothing in here is a list of plugin names typed out: it is
   * whatever is installed, grouped by whatever that turns out to be called.
   */
  let known: Promise<Map<string, Held>> | undefined
  const facts = (): Promise<Map<string, Held>> =>
    (known ??= (async () => {
      const map = new Map<string, Held>()
      try {
        const [tools, plugins] = await Promise.all([
          ask('/api/rows', { key: 'tools' }),
          fetch('/api/plugins', { headers: { 'x-alexia-token': token } }).then(
            (answer) => answer.json() as Promise<Record<string, unknown>>,
          ),
        ])
        const panes = (plugins.panes ?? []) as { id: string; name: string; requires?: { cap: string; why: string }[] }[]
        const byId = new Map(panes.map((pane) => [pane.id, pane]))
        for (const tool of (tools.rows ?? []) as { id: string; plugin?: string; words?: string }[]) {
          const pane = tool.plugin === undefined ? undefined : byId.get(tool.plugin)
          map.set(tool.id, {
            plugin: pane?.name ?? tool.plugin ?? 'Alexia',
            requires: pane?.requires ?? [],
            ...(typeof tool.words === 'string' && tool.words !== '' && { words: tool.words }),
          })
        }
      } catch {
        // A panel that cannot say where a tool came from still shows the call and the result,
        // which is the half that matters. It does not show a guess.
      }
      return map
    })())

  /** A step's name in words once they are known, and the tool's short name until then. */
  const wordsFor = async (name: string): Promise<string> => (await facts()).get(name)?.words ?? bare(name)

  const nothing = (where: HTMLElement, line: string): void => {
    const said = document.createElement('p')
    said.className = 'nothing'
    said.textContent = line
    where.replaceChildren(said)
  }

  /**
   * The open step, in full. Re-rendered rather than patched: it is one card, not a log.
   *
   * **Words first, data behind a fold.** It used to open on a capability id and a block of JSON,
   * which is exactly what the person watching cannot read. Now it says what the step does, who
   * offers it, what that is allowed to do and how it went — and what was sent and what came
   * back, as they were, are one press away under *Details*.
   */
  const paint = async (n: number): Promise<void> => {
    const row = rows.get(n)
    if (!row) return
    open = n

    for (const [at, other] of rows) other.element.classList.toggle('on', at === n)

    const held = (await facts()).get(row.name)
    // Another step may have opened while the facts were read. The newest one wins.
    if (open !== n) return

    const state =
      row.ok === undefined ? { text: 'working', cls: 'badge' }
      : row.ok ? { text: 'done', cls: 'badge flat' }
      : { text: 'failed', cls: 'badge warn' }

    const number = document.createElement('span')
    number.className = 'n'
    number.textContent = String(row.n)
    const tool = document.createElement('span')
    tool.className = 'tool'
    tool.textContent = held?.words ?? bare(row.name)
    const badge = document.createElement('span')
    badge.className = state.cls
    badge.textContent = state.text
    head.replaceChildren(number, tool, badge)

    const list = document.createElement('dl')
    list.className = 'facts'

    const fact = (term: string, fill: (dd: HTMLElement) => void): void => {
      const dt = document.createElement('dt')
      dt.textContent = term
      const dd = document.createElement('dd')
      fill(dd)
      list.append(dt, dd)
    }

    fact('From', (dd) => {
      const who = document.createElement('b')
      who.textContent = held?.plugin ?? 'Alexia'
      dd.append(who)
    })

    // What the plugin is allowed to do — not what this one call used, because core does not
    // say which and a panel that guessed would be wrong on exactly the calls somebody checks.
    fact('It may', (dd) => {
      if (!held || held.requires.length === 0) {
        dd.textContent = 'nothing outside Alexia'
        return
      }
      for (const need of held.requires) {
        const cap = document.createElement('span')
        cap.className = 'cap'
        cap.textContent = CAN[need.cap] ?? need.cap
        const why = document.createElement('span')
        why.className = 'why'
        why.textContent = need.why
        dd.append(cap, why)
      }
    })

    const said = (row.text ?? '').trim()
    fact('How it went', (dd) => {
      dd.textContent =
        row.ok === undefined ? 'Still working…'
        : row.ok === false ? `It failed${said === '' || looksRaw(said) ? '.' : `: ${said.split('\n')[0]!.slice(0, 200)}`}`
        : said === '' ? 'Done. It said nothing back.'
        : looksRaw(said) ? 'Done. What it sent back is under Details.'
        : `Done: ${said.split('\n')[0]!.slice(0, 200)}`
    })

    const sent = row.args === undefined || Object.keys(row.args).length === 0 ? 'Nothing was sent.' : JSON.stringify(row.args, undefined, 2)
    const back = row.ok === undefined ? 'Still working…' : said === '' ? 'It said nothing.' : row.text!
    body.replaceChildren(list, folded('Details', `What was sent\n${sent}\n\nWhat came back\n${back}`))
  }

  /** The line under the last step that says how the task ended. */
  const ended = (line: string): void => {
    if (rows.size === 0) traceBox.replaceChildren()
    const last = document.createElement('p')
    last.className = 'nothing ending'
    last.textContent = line
    traceBox.append(last)
  }

  const empty = (): void => {
    nothing(runningBox, 'Nothing is running.')
    runningCount.textContent = ''
    nothing(traceBox, 'No steps yet.')
    stepCount.textContent = ''
    head.replaceChildren()
    nothing(body, 'Ask her something, and every step she takes shows up here — what she did, who helped, and how it went.')
  }

  /** One step's row in Steps. Its words arrive when the facts do; its short name stands in until then. */
  const addRow = (n: number, name: string, args?: Record<string, unknown>): Row => {
    if (rows.size === 0) traceBox.replaceChildren()
    const element = document.createElement('button')
    element.type = 'button'
    element.className = 'rail-row'
    const number = document.createElement('span')
    number.className = 'when'
    number.textContent = String(n)
    const tool = document.createElement('span')
    tool.className = 'what'
    tool.textContent = bare(name)
    void wordsFor(name).then((words) => (tool.textContent = words))
    const said = document.createElement('span')
    said.className = 'when'
    element.append(number, tool, said)
    element.addEventListener('click', () => void paint(n))
    traceBox.append(element)

    const row: Row = { n, name, element, said }
    if (args !== undefined) row.args = args
    rows.set(n, row)
    stepCount.textContent = String(rows.size)
    return row
  }

  const finished = (n: number, ok: boolean, text: string): void => {
    const row = rows.get(n)
    if (!row) return
    row.ok = ok
    row.text = text
    row.element.classList.toggle('failed', !ok)
    // The glance version, on one line. The whole of it is in the card, which is the point
    // of there being a card.
    row.said.textContent = text.replace(/\s+/g, ' ').slice(0, 40)
  }

  /**
   * **The last run, after a reload**, from the saved history (`last_run`), so the pages open on
   * what just happened rather than on *No steps yet* while the Activity screen lists it. Only
   * when nothing has been drawn since the page loaded: a task that started meanwhile wins.
   */
  const restore = async (): Promise<void> => {
    let last: Record<string, unknown> | undefined
    try {
      last = ((await ask('/api/rows', { key: 'last_run' })).rows as Record<string, unknown>[] | undefined)?.[0]
    } catch {
      return
    }
    if (last === undefined || touched) return
    const steps = (last.steps ?? []) as { n: number; name: string; args?: Record<string, unknown>; ok?: boolean; text?: string }[]
    for (const step of steps) {
      addRow(step.n, step.name, step.args)
      if (step.ok !== undefined) finished(step.n, step.ok, step.text ?? '')
    }
    if (last.over === true) ended(String(last.ended ?? 'Finished') + (typeof last.why === 'string' && last.why !== '' ? `: ${last.why}` : ''))
    const shown = steps.at(-1)
    if (shown !== undefined) void paint(shown.n)
    else nothing(body, `Last time: “${String(last.task ?? '')}”. She used no tools for it.`)
  }

  empty()
  void restore()

  return {
    begin(title) {
      touched = true
      running = true
      rows.clear()
      open = 0
      traceBox.replaceChildren()
      stepCount.textContent = ''
      head.replaceChildren()
      nothing(body, 'Waiting for the first step.')

      const run = document.createElement('div')
      run.className = 'rail-row on'
      const dot = document.createElement('span')
      dot.className = 'dot'
      const what = document.createElement('span')
      what.className = 'what'
      what.textContent = title
      // When it started, which is the one thing about a running task worth a column.
      const when = document.createElement('span')
      when.className = 'when'
      when.textContent = `since ${clock(Date.now())}`
      run.append(dot, what, when)
      runningBox.replaceChildren(run)
      runningCount.textContent = '1'
    },

    step(n, name, args) {
      touched = true
      addRow(n, name, args)
      // The newest step is the one somebody is watching, so it opens itself.
      void paint(n)
    },

    /**
     * The row, moving (M2-6). A tool that reports a fraction gets a bar; one that only says
     * where it is gets its own words. Both are better than the row sitting still.
     */
    moving(n, update) {
      const row = rows.get(n)
      if (!row) return
      // **The work, while it is still work.** One element, reused: a render sends one of these
      // a second, and appending them would build a filmstrip of a thing that has one current
      // state. Only ever a `data:` URL, checked here as well as at the boundary, because this
      // is the one place a plugin's string becomes something the shell loads.
      if (update.preview?.startsWith('data:image/')) {
        const { shot } = working(row)
        shot.src = update.preview
        shot.hidden = false
      }
      // **The shape of the job**, in the plugin's own order. Rebuilt rather than patched: it
      // is a handful of elements once a second, and a strip that is rebuilt cannot hold a
      // stale state from a stage that has gone away.
      if (update.plan === true && update.stages !== undefined && update.stages.length > 0) {
        const { plan } = working(row)
        plan.replaceChildren(...update.stages.map(point))
        const done = update.stages.filter((stage) => stage.state === 'done').length
        plan.setAttribute('aria-label', `Plan: ${String(update.stages.length)} steps, ${String(done)} done.`)
        plan.hidden = false
      }
      // The buttons a plugin offers while this runs — *Take over*, *Continue*. Rebuilt with the
      // plan, so the one on screen is always the one that applies now.
      if (update.controls !== undefined) {
        const { controls } = working(row)
        controls.replaceChildren(
          ...update.controls.map((one) => {
            const button = document.createElement('button')
            button.type = 'button'
            button.className = 'quiet-button'
            button.textContent = one.label
            button.addEventListener('click', () => {
              button.disabled = true
              row.element.dispatchEvent(new CustomEvent(CONTROL_EVENT, { bubbles: true, detail: { tool: row.name, key: one.key } }))
            })
            return button
          }),
        )
        controls.hidden = update.controls.length === 0
      } else if (update.stages !== undefined && update.stages.length > 0) {
        const { strip } = working(row)
        strip.replaceChildren(...update.stages.map(segment))
        const done = update.stages.filter((stage) => stage.state === 'done').length
        strip.setAttribute(
          'aria-label',
          `${String(update.stages.length)} stages, ${String(done)} done.`,
        )
        strip.hidden = false
      }
      if (update.message !== undefined) row.said.textContent = update.message
      if (update.total === undefined || update.total <= 0) return
      const done = Math.max(0, Math.min(100, Math.round((update.progress / update.total) * 100)))
      // Both, when there is both. A percentage alone replaced sentences a plugin had gone to
      // some trouble for — *KSampler — step 12 of 28* says which stage of somebody's own
      // pipeline is running, and `43%` says only how much of it is left.
      row.said.textContent = update.message ? `${update.message} · ${String(done)}%` : `${String(done)}%`
    },

    done(n, ok, text, timing) {
      finished(n, ok, text)
      const row = rows.get(n)
      // Nothing to press once it is over.
      if (row?.work) row.work.controls.hidden = true
      // How it went, under it (B4): *6.2 s · 2 steps · no model*.
      if (row && timing !== undefined) {
        const line = document.createElement('p')
        line.className = 'step-timing'
        line.textContent = timingLine(timing)
        row.element.append(line)
      }
      if (open === n) void paint(n)
    },

    /**
     * **Every ending clears Running now**, and says how it ended under the steps. It used to be
     * called only for an answer that finished, so an error, a pause or a refusal left the task
     * *running* on screen until the next one started.
     */
    end(how, why) {
      if (!running) return
      running = false
      nothing(runningBox, 'Nothing is running.')
      runningCount.textContent = ''
      if (how !== undefined) ended(endingLine(how, why))
      // A task that ended before its first step leaves the card saying *waiting* for nothing.
      if (rows.size === 0) nothing(body, how === 'answered' ? 'She answered without using any tools.' : 'No steps were taken.')
    },
  }
}
