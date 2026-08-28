// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The settings screen: ten widgets, rendered by core, declared by plugins (M2-1).
 *
 * **A plugin cannot style itself wrong because it never styles itself.** Everything drawn
 * here comes out of a manifest core validated before the plugin process existed — which is
 * also why this screen works while every plugin is stopped, and with lazy spawn that is the
 * ordinary case rather than the corner one.
 *
 * No Node in here, ever (invariant 6). The types below mirror `packages/core/src/settings.ts`
 * and are duplicated rather than imported for exactly that reason — the same trade the stream
 * frames in `main.ts` make.
 */

export type WidgetType =
  | 'text'
  | 'password'
  | 'number'
  | 'toggle'
  | 'choice'
  | 'multi-choice'
  | 'path'
  | 'status'
  | 'progress'
  | 'action'

export interface Rendered {
  type: WidgetType
  key: string
  label: string
  hint?: string
  value?: unknown
  placeholder?: string
  min?: number
  max?: number
  step?: number
  options?: string[]
  kind?: 'file' | 'dir'
  tool?: string
  /** `password`: whether one is stored, and core's own sentence about where it went. */
  set?: boolean
  stored?: string
  /** `action`: whether the tool is there, and why not. */
  available?: boolean
  reason?: string
  /** `progress`: what the plugin last reported. Absent means nothing is in flight. */
  live?: { progress: number; total?: number; message?: string }
}

export interface Pane {
  id: string
  name: string
  summary: string
  version: string
  license: string
  running: boolean
  requires: { cap: string; why: string }[]
  settings: Rendered[]
}

interface Problem {
  dir: string
  reason: string
}

/** A skill's index entry (M2-2). There is nothing to configure — it is a folder of text. */
interface Skill {
  name: string
  description: string
  license?: string
  dir: string
  /** Set when it arrived with a plugin, which is what makes it not separately removable. */
  pluginId?: string
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const made = document.createElement(tag)
  if (className) made.className = className
  if (text !== undefined) made.textContent = text
  return made
}

/** Four or more options is a dropdown; two or three is a segmented control. Core's call. */
const SEGMENTED_UP_TO = 3

export function mountSettings(token: string): { open: () => void } {
  const view = document.querySelector<HTMLElement>('#settings')!
  const list = document.querySelector<HTMLElement>('#panes')!
  const broken = document.querySelector<HTMLElement>('#problems')!
  const known = document.querySelector<HTMLElement>('#skills')!

  const send = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
    (await (
      await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-alexia-token': token },
        body: JSON.stringify(body),
      })
    ).json()) as Record<string, unknown>

  async function load(): Promise<void> {
    const state = (await (
      await fetch('/api/plugins', { headers: { 'x-alexia-token': token } })
    ).json()) as { panes: Pane[]; problems: Problem[]; skills: Skill[]; skillProblems: Problem[] }
    draw(state.panes, state.problems)
    drawSkills(state.skills, state.skillProblems)
  }

  /** A folder that is there and doing nothing, and the only useful thing to say about it. */
  function brokenRows(problems: Problem[], one: string, many: string): HTMLElement[] {
    if (problems.length === 0) return []
    return [
      el('h3', 'step-heading', problems.length === 1 ? one : `${problems.length} ${many}`),
      ...problems.map((problem) => {
        const row = el('div', 'pane')
        row.append(el('b', undefined, problem.dir), el('p', 'error', problem.reason))
        return row
      }),
    ]
  }

  /**
   * What Alexia knows how to do well, and what is sitting in the folder failing to load.
   *
   * The description is shown in full because it is the whole of a skill's discoverability —
   * it is the sentence the model reads when deciding whether to open the skill at all, so
   * whoever wrote it should be able to see exactly what the model sees.
   */
  function drawSkills(skills: Skill[], problems: Problem[]): void {
    known.replaceChildren()
    if (skills.length === 0 && problems.length === 0) return
    known.append(el('h3', 'step-heading', 'Skills'))
    for (const skill of skills) {
      const row = el('section', 'pane')
      const head = el('div', 'pane-head')
      head.append(
        el('b', undefined, skill.name),
        ...(skill.pluginId === undefined ? [] : [el('span', 'pill', `with ${skill.pluginId}`)]),
        ...(skill.license === undefined ? [] : [el('span', 'pane-meta', skill.license)]),
      )
      row.append(head, el('p', 'hint', skill.description))
      known.append(row)
    }
    // A skill that is not firing and is not visibly broken is the hardest thing here to
    // debug, so a folder that failed to load says so rather than simply not appearing.
    known.append(...brokenRows(problems, 'One skill did not load', 'skills did not load'))
  }

  function draw(panes: Pane[], problems: Problem[]): void {
    list.replaceChildren(...panes.map(paneOf))
    if (panes.length === 0 && problems.length === 0) {
      list.append(el('p', 'hint', 'Nothing is installed yet. A plugin is a folder; adding one is M2-5.'))
    }

    // A folder that is not a plugin is shown, never swallowed. Somebody put it there on
    // purpose and the reason it did not load is the only useful thing anyone can tell them.
    broken.replaceChildren(...brokenRows(problems, 'One folder did not load', 'folders did not load'))
  }

  /** One plugin: core's chrome, then its declared widgets in manifest order. */
  function paneOf(pane: Pane): HTMLElement {
    const box = el('section', 'pane')
    const head = el('div', 'pane-head')
    head.append(
      el('b', undefined, pane.name),
      el('span', 'pill', pane.running ? 'running' : 'stopped'),
      el('span', 'pane-meta', `${pane.version} · ${pane.license}`),
    )
    box.append(head, el('p', 'hint', pane.summary))

    // The author's own sentences, verbatim. This is what a person reads when deciding
    // whether to keep a plugin, so core never rewrites it and never summarises it.
    if (pane.requires.length > 0) {
      const asked = el('ul', 'asks')
      for (const need of pane.requires) {
        const row = el('li')
        row.append(el('code', undefined, need.cap), el('span', undefined, need.why))
        asked.append(row)
      }
      box.append(el('p', 'asks-label', 'It asked for:'), asked)
    }

    for (const declared of pane.settings) box.append(widget(pane, declared))
    return box
  }

  /**
   * The two widgets a plugin drives, re-drawn while it is working.
   *
   * Without this the bar would only ever be seen at rest, which is a spinner with extra
   * steps — and *a bar that moves is the difference between waiting and quitting* is the
   * entire argument for `progress` being one of the ten. Only those fields are replaced, so
   * nothing the user is typing into elsewhere is thrown away mid-keystroke.
   */
  async function refreshDriven(pluginId: string): Promise<void> {
    const state = (await (
      await fetch('/api/plugins', { headers: { 'x-alexia-token': token } })
    ).json()) as { panes: Pane[] }
    const fresh = state.panes.find((p) => p.id === pluginId)
    if (!fresh) return
    for (const declared of fresh.settings) {
      if (declared.type !== 'progress' && declared.type !== 'status') continue
      const node = list.querySelector<HTMLElement>(`[data-field="${pluginId}:${declared.key}"]`)
      node?.replaceWith(widget(fresh, declared))
    }
  }

  function widget(pane: Pane, declared: Rendered): HTMLElement {
    const field = el('div', 'field')
    field.dataset.field = `${pane.id}:${declared.key}`
    const problem = el('p', 'error')
    problem.hidden = true

    /**
     * Send one edit. On a refusal the sentence goes under the control that produced it; on a
     * success nothing is redrawn.
     *
     * Redrawing was the obvious thing and it was wrong twice over: `change` fires while the
     * control still has focus, so replacing it takes the focus away from whoever is using the
     * keyboard, and the control already shows what they just set. The one exception is
     * `password`, which genuinely looks different once there is one — a changed placeholder
     * and a way to forget it — so that is the only widget drawn again.
     */
    const save = async (value: unknown): Promise<void> => {
      const answer = await send('/api/settings', { plugin: pane.id, key: declared.key, value })
      if (answer.ok !== true) {
        problem.textContent = String(answer.why ?? 'That did not save.')
        problem.hidden = false
        return
      }
      problem.hidden = true
      if (declared.type !== 'password') return
      const fresh = (answer.panes as Pane[]).find((p) => p.id === pane.id)
      const now = fresh?.settings.find((s) => s.key === declared.key)
      if (fresh && now) field.replaceWith(widget(fresh, now))
    }

    const labelled = (control: HTMLElement, forId?: string): HTMLElement => {
      const label = el('label', 'label', declared.label)
      if (forId) label.htmlFor = forId
      field.append(label, control)
      return field
    }

    const id = `s-${pane.id}-${declared.key}`

    switch (declared.type) {
      case 'text':
      case 'path': {
        const input = el('input')
        input.id = id
        input.type = 'text'
        input.value = typeof declared.value === 'string' ? declared.value : ''
        if (declared.placeholder) input.placeholder = declared.placeholder
        input.addEventListener('change', () => void save(input.value))
        if (declared.type === 'text') {
          labelled(input, id)
          break
        }
        // A folder picker is a native dialog, and this is a web page. Said out loud rather
        // than drawn as a button that does nothing: the field takes a typed path today, and
        // core checks it is really there and really the right kind before keeping it.
        const pair = el('div', 'pair')
        const browse = el('button', 'quiet-button', 'Browse…')
        browse.type = 'button'
        browse.disabled = true
        browse.title = 'A folder picker needs the desktop app (M5). Type or paste the path for now.'
        pair.append(input, browse)
        labelled(pair, id)
        break
      }

      case 'password': {
        const input = el('input')
        input.id = id
        input.type = 'password'
        input.autocomplete = 'off'
        input.placeholder = declared.set === true ? '••••••••••••' : 'Not set'
        input.addEventListener('change', () => void save(input.value))
        const row = el('div', 'pair')
        row.append(input)
        // A screen where a secret can be replaced but never removed is a screen that keeps
        // secrets the person has decided to stop trusting it with.
        if (declared.set === true) {
          const forget = el('button', 'quiet-button', 'Forget it')
          forget.type = 'button'
          forget.addEventListener('click', () => void save(''))
          row.append(forget)
        }
        labelled(row, id)
        // Core writes this line, not the author: a plugin promising the wrong store would be
        // lying on core's screen, in core's voice.
        if (declared.stored) field.append(el('p', 'hint', declared.stored))
        break
      }

      case 'number': {
        const input = el('input')
        input.id = id
        input.type = 'number'
        if (typeof declared.value === 'number') input.value = String(declared.value)
        if (declared.min !== undefined) input.min = String(declared.min)
        if (declared.max !== undefined) input.max = String(declared.max)
        if (declared.step !== undefined) input.step = String(declared.step)
        input.addEventListener('change', () => void save(input.valueAsNumber))
        const row = el('div', 'pair')
        row.append(input)
        if (declared.min !== undefined && declared.max !== undefined) {
          row.append(el('span', 'range tabular', `${declared.min}–${declared.max}`))
        }
        labelled(row, id)
        break
      }

      case 'toggle': {
        // The label is a statement that is true when it is on, so the control reads as one
        // sentence and the label goes beside it rather than above.
        const wrap = el('label', 'switch')
        const input = el('input')
        input.type = 'checkbox'
        input.checked = declared.value === true
        input.addEventListener('change', () => void save(input.checked))
        wrap.append(input, el('span', 'track'), el('span', undefined, declared.label))
        field.append(wrap)
        break
      }

      case 'choice': {
        const options = declared.options ?? []
        if (options.length <= SEGMENTED_UP_TO) {
          const group = el('div', 'segmented')
          group.setAttribute('role', 'radiogroup')
          group.setAttribute('aria-label', declared.label)
          for (const option of options) {
            const choice = el('label', 'segment')
            const input = el('input')
            input.type = 'radio'
            input.name = id
            input.value = option
            input.checked = declared.value === option
            input.addEventListener('change', () => void save(option))
            choice.append(input, el('span', undefined, option))
            group.append(choice)
          }
          field.append(el('span', 'label', declared.label), group)
          break
        }
        const select = el('select')
        select.id = id
        for (const option of options) select.add(new Option(option, option, false, declared.value === option))
        select.addEventListener('change', () => void save(select.value))
        labelled(select, id)
        break
      }

      case 'multi-choice': {
        const chosen = new Set(Array.isArray(declared.value) ? (declared.value as string[]) : [])
        const group = el('div', 'checks')
        group.setAttribute('role', 'group')
        group.setAttribute('aria-label', declared.label)
        for (const option of declared.options ?? []) {
          const box = el('label', 'check')
          const input = el('input')
          input.type = 'checkbox'
          input.checked = chosen.has(option)
          input.addEventListener('change', () => {
            if (input.checked) chosen.add(option)
            else chosen.delete(option)
            void save([...chosen])
          })
          box.append(input, el('span', undefined, option))
          group.append(box)
        }
        field.append(el('span', 'label', declared.label), group)
        break
      }

      case 'status': {
        // Three states and no legend. `●` is ready and is *not* green: docs/design.md settled
        // that a colour here means something happened, and ready is the normal state of a
        // working plugin. The one that needs looking at is the one already coloured.
        const said = typeof declared.value === 'string' ? declared.value : '—'
        const state = said.startsWith('▲') ? 'caution' : said.startsWith('■') ? 'idle' : 'ready'
        const row = el('div', 'reading')
        row.append(el('span', 'label', declared.label), el('span', `said ${state}`, said))
        field.append(row)
        break
      }

      case 'progress': {
        // Hidden entirely when nothing is in flight. A bar that is always there, at zero, is
        // a bar nobody believes when it finally moves.
        if (!declared.live) {
          field.hidden = true
          break
        }
        const { progress, total, message } = declared.live
        const done = total === undefined ? undefined : Math.round((progress / total) * 100)
        field.append(el('span', 'label', declared.label))
        const bar = el('div', 'bar')
        const fill = el('span')
        fill.style.width = done === undefined ? '100%' : `${done}%`
        bar.append(fill)
        const row = el('div', 'reading')
        row.append(bar)
        if (done !== undefined) row.append(el('span', 'tabular', `${done}%`))
        field.append(row)
        if (message) field.append(el('p', 'hint', message))
        break
      }

      case 'action': {
        const button = el('button', 'quiet-button', declared.label)
        button.type = 'button'
        if (declared.available === false) {
          button.disabled = true
          button.title = declared.reason ?? 'That tool is not there right now.'
        }
        const said = el('p', 'hint')
        said.hidden = true

        /** Press it, and put the permission question where the thing being decided is. */
        const press = async (approved?: boolean): Promise<void> => {
          button.disabled = true
          // The bar above this button is fed by the call this button is making, so it has to
          // be looked at while the call is in flight rather than after it.
          const watching = window.setInterval(() => void refreshDriven(pane.id), 400)
          try {
            const answer = await send('/api/action', {
              plugin: pane.id,
              key: declared.key,
              ...(approved === true && { approved: true }),
            })
            if (typeof answer.ask === 'string') {
              field.append(confirm(answer.ask, press))
              return
            }
            said.textContent = String(answer.said ?? '')
            said.hidden = said.textContent === ''
            said.className = answer.ok === true ? 'hint' : 'error'
            // Deliberately not a redraw. The first version drew the whole list from the
            // answer and so threw away the sentence it had just written into it — the one
            // thing the person who pressed the button is waiting to read. What did change
            // while the tool ran is the status and the bar, and those are refreshed below.
          } finally {
            window.clearInterval(watching)
            await refreshDriven(pane.id)
            button.disabled = declared.available === false
          }
        }
        button.addEventListener('click', () => void press())
        field.append(button, said)
        break
      }
    }

    if (declared.hint && declared.type !== 'password') field.append(el('p', 'hint', declared.hint))
    field.append(problem)
    return field
  }

  /**
   * The permission question for an `action`, asked beside the button rather than over the
   * page — the same rule the chat prompt follows. What is being decided is what is on screen.
   */
  function confirm(why: string, again: (approved: boolean) => Promise<void>): HTMLElement {
    const box = el('div', 'confirm')
    box.append(el('p', undefined, why))
    const row = el('div', 'row')
    const allow = el('button', undefined, 'Allow once')
    allow.type = 'button'
    const deny = el('button', 'quiet-button', 'Not this time')
    deny.type = 'button'
    allow.addEventListener('click', () => {
      box.remove()
      void again(true)
    })
    deny.addEventListener('click', () => box.remove())
    row.append(allow, deny)
    box.append(row)
    return box
  }

  return {
    open: () => {
      view.scrollTop = 0
      void load()
    },
  }
}
