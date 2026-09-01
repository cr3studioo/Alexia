// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The live panel: what she is doing, and exactly how.
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
}

export interface Live {
  /** A task started, in the conversation named. */
  begin(title: string): void
  /** A call is about to run. Fired before the work, because that is the point of a trace. */
  step(n: number, name: string, args?: Record<string, unknown>): void
  moving(n: number, update: Moving): void
  done(n: number, ok: boolean, text: string): void
  /** The task ended, however it ended. */
  end(): void
}

interface Held {
  /** What the plugin is called, for a person. */
  plugin: string
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
  work?: { strip: HTMLOListElement; shot: HTMLImageElement }
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
const working = (row: Row): { strip: HTMLOListElement; shot: HTMLImageElement } =>
  (row.work ??= (() => {
    const box = document.createElement('div')
    box.className = 'step-work'
    const strip = document.createElement('ol')
    strip.className = 'step-stages'
    strip.hidden = true
    const shot = document.createElement('img')
    shot.className = 'step-preview'
    shot.alt = 'What this step has made so far'
    shot.decoding = 'async'
    shot.hidden = true
    box.append(strip, shot)
    row.element.append(box)
    return { strip, shot }
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

export function mountLive(token: string): Live {
  const runningBox = document.querySelector<HTMLElement>('#running')!
  const runningCount = document.querySelector<HTMLElement>('#running-count')!
  const traceBox = document.querySelector<HTMLElement>('#trace')!
  const stepCount = document.querySelector<HTMLElement>('#step-count')!
  const head = document.querySelector<HTMLElement>('#detail-head')!
  const body = document.querySelector<HTMLElement>('#detail')!

  const rows = new Map<number, Row>()
  let open = 0

  const ask = async (path: string, sent: unknown): Promise<Record<string, unknown>> => {
    const answer = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alexia-token': token },
      body: JSON.stringify(sent),
    })
    return answer.ok ? ((await answer.json()) as Record<string, unknown>) : {}
  }

  /**
   * Which plugin offers which tool, and what that plugin holds.
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
        for (const tool of (tools.rows ?? []) as { id: string; plugin?: string }[]) {
          const pane = tool.plugin === undefined ? undefined : byId.get(tool.plugin)
          map.set(tool.id, {
            plugin: pane?.name ?? tool.plugin ?? 'Alexia',
            requires: pane?.requires ?? [],
          })
        }
      } catch {
        // A panel that cannot say where a tool came from still shows the call and the result,
        // which is the half that matters. It does not show a guess.
      }
      return map
    })())

  const nothing = (where: HTMLElement, line: string): void => {
    const said = document.createElement('p')
    said.className = 'nothing'
    said.textContent = line
    where.replaceChildren(said)
  }

  /** The open step, in full. Re-rendered rather than patched: it is one card, not a log. */
  const paint = async (n: number): Promise<void> => {
    const row = rows.get(n)
    if (!row) return
    open = n

    for (const [at, other] of rows) other.element.classList.toggle('on', at === n)

    const state =
      row.ok === undefined ? { text: 'running', cls: 'badge' }
      : row.ok ? { text: 'done', cls: 'badge flat' }
      : { text: 'failed', cls: 'badge warn' }

    const number = document.createElement('span')
    number.className = 'n'
    number.textContent = String(row.n)
    const tool = document.createElement('span')
    tool.className = 'tool'
    tool.textContent = bare(row.name)
    const badge = document.createElement('span')
    badge.className = state.cls
    badge.textContent = state.text
    head.replaceChildren(number, tool, badge)

    const held = (await facts()).get(row.name)
    const list = document.createElement('dl')
    list.className = 'facts'

    const fact = (term: string, fill: (dd: HTMLElement) => void): void => {
      const dt = document.createElement('dt')
      dt.textContent = term
      const dd = document.createElement('dd')
      fill(dd)
      list.append(dt, dd)
    }

    fact('from', (dd) => {
      const who = document.createElement('b')
      who.textContent = held?.plugin ?? 'Alexia'
      dd.append(who)
    })

    // What the plugin holds — not what this one call used, because core does not say which
    // and a panel that guessed would be wrong on exactly the calls somebody is checking.
    fact('holds', (dd) => {
      if (!held || held.requires.length === 0) {
        dd.textContent = 'nothing — it reaches nothing outside Alexia'
        return
      }
      for (const need of held.requires) {
        const cap = document.createElement('span')
        cap.className = 'cap'
        cap.textContent = need.cap
        const why = document.createElement('span')
        why.className = 'why'
        why.textContent = need.why
        dd.append(cap, why)
      }
    })

    const call = document.createElement('div')
    call.className = 'code'
    call.textContent = row.args === undefined ? 'nothing was sent' : JSON.stringify(row.args, undefined, 2)

    const result = document.createElement('div')
    result.className = 'code'
    result.textContent =
      row.ok === undefined ? 'still running…'
      : (row.text ?? '').trim() === '' ? 'it said nothing'
      : row.text!

    const label = (word: string, right = ''): HTMLElement => {
      const p = document.createElement('p')
      p.className = 'block-label'
      const what = document.createElement('span')
      what.textContent = word
      p.append(what)
      if (right !== '') {
        const r = document.createElement('span')
        r.className = 'r'
        r.textContent = right
        p.append(r)
      }
      return p
    }

    body.replaceChildren(
      list,
      label('What was sent'),
      call,
      label('What came back', row.ok === false ? 'it failed' : ''),
      result,
    )
  }

  const empty = (): void => {
    nothing(runningBox, 'Nothing is running.')
    runningCount.textContent = ''
    nothing(traceBox, 'No steps yet.')
    stepCount.textContent = ''
    head.replaceChildren()
    nothing(body, 'Ask her something, and every step she takes shows up here — the tool, what was sent to it, and what it said back.')
  }

  empty()

  return {
    begin(title) {
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
      const when = document.createElement('span')
      when.className = 'when'
      when.textContent = 'this one'
      run.append(dot, what, when)
      runningBox.replaceChildren(run)
      runningCount.textContent = '1'
    },

    step(n, name, args) {
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
      const said = document.createElement('span')
      said.className = 'when'
      element.append(number, tool, said)
      element.addEventListener('click', () => void paint(n))
      traceBox.append(element)

      const row: Row = { n, name, element, said }
      if (args !== undefined) row.args = args
      rows.set(n, row)
      stepCount.textContent = String(rows.size)
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
      if (update.stages !== undefined && update.stages.length > 0) {
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

    done(n, ok, text) {
      const row = rows.get(n)
      if (!row) return
      row.ok = ok
      row.text = text
      row.element.classList.toggle('failed', !ok)
      // The glance version, on one line. The whole of it is in the card, which is the point
      // of there being a card.
      row.said.textContent = text.replace(/\s+/g, ' ').slice(0, 40)
      if (open === n) void paint(n)
    },

    end() {
      nothing(runningBox, 'Nothing is running.')
      runningCount.textContent = ''
    },
  }
}
