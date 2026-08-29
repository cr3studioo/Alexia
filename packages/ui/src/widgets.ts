// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The widgets, rendered by core, declared by plugins (M2-1) — and now on two screens.
 *
 * **A plugin cannot style itself wrong because it never styles itself.** Everything drawn
 * here comes out of a manifest core validated before the plugin process existed, which is
 * also why both screens work while every plugin is stopped — with lazy spawn, that is the
 * ordinary case rather than the corner one.
 *
 * This file exists because the control surface (M6-2) draws the same declarations the
 * settings pane does. A second renderer would be a second set of rules about where a
 * `password` goes and when an `action` may be pressed, and the two would drift on the day
 * one of them was fixed. So there is one, and the screen it is drawing for arrives as
 * {@link WidgetHost} — where an edit goes, and where a redraw comes from.
 *
 * No Node in here, ever (invariant 6). The types below mirror `packages/core/src/settings.ts`
 * and are duplicated rather than imported for exactly that reason.
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

/** Which screen is drawing, and how it answers the two questions a widget asks back. */
export interface WidgetHost {
  /** The plugin whose widget this is. Both write paths are keyed by it. */
  plugin: string
  /**
   * Which screen. It only distinguishes `data-field` attributes — the settings pane and a
   * panel can be in the same document showing the same plugin, and a redraw that found the
   * other one's node would replace the wrong thing.
   */
  screen: string
  /** A POST carrying the token, and the parsed answer. */
  send(path: string, body: unknown): Promise<Record<string, unknown>>
  /** This plugin's widgets as they are now, re-read from whichever screen this is. */
  fresh(): Promise<Rendered[]>
  /** Where a redrawn widget is looked for. */
  root(): HTMLElement
}

export const el = <K extends keyof HTMLElementTagNameMap>(
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

/**
 * The two widgets a plugin drives, re-drawn while it is working.
 *
 * Without this the bar would only ever be seen at rest, which is a spinner with extra steps
 * — and *a bar that moves is the difference between waiting and quitting* is the entire
 * argument for `progress` being one of the ten. Only those fields are replaced, so nothing
 * the user is typing into elsewhere is thrown away mid-keystroke.
 */
export async function refreshDriven(host: WidgetHost): Promise<void> {
  for (const declared of await host.fresh()) {
    if (declared.type !== 'progress' && declared.type !== 'status') continue
    const node = host.root().querySelector<HTMLElement>(`[data-field="${fieldId(host, declared.key)}"]`)
    node?.replaceWith(widget(host, declared))
  }
}

const fieldId = (host: WidgetHost, key: string): string => `${host.screen}:${host.plugin}:${key}`

export function widget(host: WidgetHost, declared: Rendered): HTMLElement {
  const field = el('div', 'field')
  field.dataset.field = fieldId(host, declared.key)
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
    const answer = await host.send('/api/settings', { plugin: host.plugin, key: declared.key, value })
    if (answer.ok !== true) {
      problem.textContent = String(answer.why ?? 'That did not save.')
      problem.hidden = false
      return
    }
    problem.hidden = true
    if (declared.type !== 'password') return
    const now = (await host.fresh()).find((s) => s.key === declared.key)
    if (now) field.replaceWith(widget(host, now))
  }

  const labelled = (control: HTMLElement, forId?: string): HTMLElement => {
    const label = el('label', 'label', declared.label)
    if (forId) label.htmlFor = forId
    field.append(label, control)
    return field
  }

  const id = `${host.screen}-${host.plugin}-${declared.key}`

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
        const watching = window.setInterval(() => void refreshDriven(host), 400)
        try {
          const answer = await host.send('/api/action', {
            plugin: host.plugin,
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
          await refreshDriven(host)
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
export function confirm(why: string, again: (approved: boolean) => Promise<void>): HTMLElement {
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
