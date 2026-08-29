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
  | 'table'

/** A `table`'s column, as its author declared it. */
export interface Column {
  key: string
  label: string
  align?: 'left' | 'right'
  /** Dropped below the narrow breakpoint, so the row actions stay reachable without scrolling. */
  hideNarrow?: boolean
}

export interface RowAction {
  key: string
  label: string
  /** A second press that has already said what goes, with `{column}` filled in from the row. */
  confirm?: string
}

export interface Row {
  id: string
  [field: string]: unknown
}

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
  /** `table`: everything about its shape. The rows themselves are fetched when it is drawn. */
  columns?: Column[]
  rowActions?: RowAction[]
  detail?: string
  filter?: boolean
  groupBy?: string
}

/** Which screen is drawing, and how it answers the two questions a widget asks back. */
export interface WidgetHost {
  /**
   * The plugin whose widget this is, and `''` for one of core's own.
   *
   * It rides on every request this file makes, and core reads the empty string the same way
   * the shell writes it: *nobody's plugin, so core's own data*. One field rather than a flag
   * beside it, because a flag and a name that have to agree is one of them too many.
   */
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

    case 'table': {
      // The hint goes **above** a table and below everything else. On every other widget it
      // explains the control you have just used; on a table it explains the list, and a list
      // is tall — so under it, the sentence telling somebody what the buttons do sat below
      // four hundred rows, where nobody has ever read anything.
      field.append(el('span', 'label', declared.label))
      if (declared.hint) field.append(el('p', 'hint lede', declared.hint))
      field.append(table(host, declared))
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

  if (declared.hint && declared.type !== 'password' && declared.type !== 'table') {
    field.append(el('p', 'hint', declared.hint))
  }
  field.append(problem)
  return field
}

/** Below this, columns marked `hideNarrow` are dropped and the actions get their own row. */
const NARROW = 560

/**
 * The eleventh widget: a list of things with actions on each one (D83, M6-3).
 *
 * **The rows are fetched, not drawn.** Everything above renders from the manifest and the
 * store, which is why a panel draws while its plugin is stopped. A table is the one that
 * needs the process, so it asks for its contents when it appears — once, on open, because a
 * person is looking at it.
 */
function table(host: WidgetHost, declared: Rendered): HTMLElement {
  const box = el('div', 'table-box')
  const said = el('p', 'hint', 'Loading…')
  const scroll = el('div', 'table-scroll')
  const columns = declared.columns ?? []
  let rows: Row[] = []
  let query = ''

  const narrow = (): boolean => window.innerWidth < NARROW
  const shown = (): Column[] => columns.filter((column) => !(narrow() && column.hideNarrow === true))

  /** The filter, over the declared columns only. What is not on screen is not searched. */
  const matching = (): Row[] => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return rows
    return rows.filter((row) =>
      columns.some((column) => String(row[column.key] ?? '').toLowerCase().includes(needle)),
    )
  }

  if (declared.filter === true) {
    const search = el('input', 'table-filter')
    search.type = 'search'
    search.placeholder = `Filter ${declared.label.toLowerCase()}`
    search.setAttribute('aria-label', `Filter ${declared.label}`)
    search.addEventListener('input', () => {
      query = search.value
      paint()
    })
    box.append(search)
  }
  box.append(said, scroll)

  /**
   * What a row action can do to the table it is in: say something that outlives the redraw,
   * and ask for the rows again. Passed down rather than reached for, so a row still knows
   * nothing about the table it is in beyond these two.
   */
  const surface = {
    reload: () => load(),
    say: (text: string, ok: boolean): void => {
      announced = text
      said.hidden = text === ''
      said.className = ok ? 'hint said-ok' : 'error'
      said.textContent = text
    },
  }

  /** The last thing an action said, kept across the redraw that action asked for. */
  let announced = ''

  /** One `<tbody>` per group, or one for everything when nothing groups it. */
  function paint(): void {
    const visible = matching()
    said.hidden = announced === '' && rows.length > 0 && visible.length > 0
    if (rows.length > 0 && visible.length === 0) {
      said.hidden = false
      said.textContent = 'Nothing matches that.'
    }

    const grid = el('table', 'grid')
    const head = el('thead')
    const headRow = el('tr')
    for (const column of shown()) {
      const cell = el('th', column.align === 'right' ? 'right' : undefined, column.label)
      headRow.append(cell)
    }
    // One header cell for every action, unlabelled: the buttons say what they do.
    if ((declared.rowActions ?? []).length > 0 || declared.detail !== undefined) headRow.append(el('th'))
    head.append(headRow)
    grid.append(head)

    const groups =
      declared.groupBy === undefined ?
        [['', visible] as const]
      : [
          ...visible
            .reduce((into, row) => {
              const name = String(row[declared.groupBy!] ?? '—')
              into.set(name, [...(into.get(name) ?? []), row])
              return into
            }, new Map<string, Row[]>())
            .entries(),
        ].sort(([a], [b]) => a.localeCompare(b))

    for (const [name, group] of groups) {
      const body = el('tbody')
      if (name !== '') {
        const heading = el('tr', 'group')
        const cell = el('th', undefined, name)
        cell.colSpan = shown().length + 1
        heading.append(cell)
        body.append(heading)
      }
      for (const row of group) body.append(rowOf(host, declared, row, shown(), surface))
      grid.append(body)
    }

    scroll.replaceChildren(grid)
  }

  async function load(): Promise<void> {
    const answer = (await host.send('/api/rows', { plugin: host.plugin, key: declared.key })) as {
      ok?: boolean
      rows?: Row[]
      said?: string
      ask?: string
    }
    if (typeof answer.ask === 'string') {
      // The same two steps an `action` takes. A list that needs permission asks for it in
      // the place the list would have been, not somewhere else on the page.
      said.textContent = ''
      scroll.replaceChildren(
        confirm(answer.ask, async (approved) => {
          if (!approved) {
            said.textContent = 'Not shown.'
            return
          }
          const again = (await host.send('/api/rows', {
            plugin: host.plugin,
            key: declared.key,
            approved: true,
          })) as { ok?: boolean; rows?: Row[]; said?: string }
          rows = again.ok === true ? (again.rows ?? []) : []
          said.textContent = again.ok === true ? '' : String(again.said ?? 'That did not work.')
          said.className = again.ok === true ? 'hint' : 'error'
          paint()
        }),
      )
      return
    }
    if (answer.ok !== true) {
      said.className = 'error'
      said.textContent = String(answer.said ?? 'That did not work.')
      said.hidden = false
      return
    }
    rows = answer.rows ?? []
    if (announced !== '') {
      // Whatever the last action said stays on screen: it is the answer to the press that
      // asked for this very reload, and blanking it here would make the press look silent.
      said.className = 'hint said-ok'
      said.textContent = announced
      said.hidden = false
    } else {
      said.className = 'hint'
      said.textContent = rows.length === 0 ? 'Nothing here yet.' : ''
    }
    paint()
  }

  void load()
  return box
}

/**
 * The marks a state column speaks in, and what each one means on screen.
 *
 * Read off the cell's first character rather than from any knowledge of which table this is
 * — the same rule `status` already follows, applied to the eleventh widget. A column that
 * says `▲ waiting for you` is telling the reader something is wrong with that row, and it
 * said so in every core table long before anything coloured it.
 *
 * `●` is deliberately absent. *Ready* is the normal state of a working thing, and colouring
 * the normal state is how a screen teaches people that its colours mean nothing.
 */
const MARKS: Record<string, string> = {
  '▲': 'is-caution',
  '■': 'is-idle',
  // The one somebody picked. Not a warning and not an error — the third meaning, which is
  // *this is the row that is doing something*, and the only one worth a colour on a good day.
  '◆': 'is-chosen',
  // The one that would be picked if nobody had. Same family as `◆` because it means the same
  // kind of thing — look here — and the glyph carries the difference between *is* and *would*.
  '★': 'is-suggested',
}

/** One row, its cells, and whatever can be done to it. */
function rowOf(
  host: WidgetHost,
  declared: Rendered,
  row: Row,
  columns: Column[],
  table: { reload(): Promise<void>; say(text: string, ok: boolean): void },
): DocumentFragment {
  const out = document.createDocumentFragment()
  const line = el('tr')
  for (const column of columns) {
    const text = String(row[column.key] ?? '')
    const state = MARKS[text.slice(0, 1)]
    const cell = el(
      'td',
      [column.align === 'right' ? 'right tabular' : '', state ?? ''].filter(Boolean).join(' ') || undefined,
      text,
    )
    line.append(cell)
  }
  out.append(line)
  if ((declared.rowActions ?? []).length === 0 && declared.detail === undefined) return out
  // A row carrying the chosen mark anywhere is the chosen row, and reads like one.
  if (columns.some((column) => String(row[column.key] ?? '').startsWith('◆'))) line.classList.add('chosen')

  const cell = el('td', 'row-actions')
  const said = el('p', 'hint')
  said.hidden = true

  if (declared.detail !== undefined) {
    /**
     * What expands under a row, as a row of its own across the full width.
     *
     * It used to be a paragraph inside the actions cell, which is the narrowest column on
     * the screen and right-aligned — so six lines about a model arrived as a ragged stripe
     * down the last inch of the table. Nothing about that was specific to one panel: every
     * detail any table has ever shown was rendered there.
     */
    const drawer = el('tr', 'detail')
    const into = el('td')
    into.colSpan = columns.length + 1
    const body = el('p', 'detail-text')
    into.append(body)
    drawer.append(into)
    drawer.hidden = true
    out.append(drawer)

    const more = el('button', 'quiet-button', 'Details')
    more.type = 'button'
    more.setAttribute('aria-expanded', 'false')
    let open = false
    more.addEventListener('click', () => {
      open = !open
      more.textContent = open ? 'Hide' : 'Details'
      more.setAttribute('aria-expanded', String(open))
      drawer.hidden = !open
      if (!open) return
      body.className = 'detail-text'
      body.textContent = 'Loading…'
      void host
        .send('/api/detail', { plugin: host.plugin, key: declared.key, row: row.id })
        .then((answer) => {
          body.className = answer.ok === true ? 'detail-text' : 'detail-text error'
          body.textContent = String((answer.ok === true ? answer.text : answer.said) ?? '')
        })
    })
    cell.append(more)
  }

  for (const action of declared.rowActions ?? []) {
    const button = el('button', 'quiet-button', action.label)
    button.type = 'button'
    let armed = action.confirm === undefined

    /** Press it. The question — permission, or the author's own confirm — is beside the row. */
    const press = async (approved?: boolean): Promise<void> => {
      button.disabled = true
      try {
        const answer = await host.send('/api/action', {
          plugin: host.plugin,
          key: action.key,
          row: row.id,
          // The arming above *is* the confirm, so it is what carries it (M6-1). A press
          // that was never armed carries nothing, and core's own destructive rows are
          // refused — which is the guard doing its job to a caller that skipped the button.
          ...(armed && { confirm: true }),
          ...(approved === true && { approved: true }),
        })
        if (typeof answer.ask === 'string') {
          cell.append(confirm(answer.ask, press))
          return
        }
        if (answer.ok === true) {
          /**
           * The list, re-read. It used to fade the row to 55% and stop there, which said
           * *something happened here* and nothing else: no way to tell what, no way to
           * undo it, and a state column still showing what was true before the press. On a
           * list where the action is a **choice** rather than a removal, that fade was the
           * only feedback there was, and it looked like the row had been switched off.
           *
           * The sentence goes above the table, where it survives the redraw — the row it
           * was written into may not exist a moment later.
           */
          table.say(String(answer.said ?? ''), true)
          await table.reload()
          return
        }
        said.hidden = false
        said.className = 'error'
        said.textContent = String(answer.said ?? '')
      } finally {
        button.disabled = false
      }
    }

    button.addEventListener('click', () => {
      // The author's own confirm, which is the destructive half of M6-1 on this screen: the
      // first press costs nothing and the second one has already said what goes.
      if (!armed) {
        armed = true
        button.textContent = fill(action.confirm ?? '', row)
        button.classList.add('armed')
        return
      }
      void press()
    })
    cell.append(button)
  }

  cell.append(said)
  line.append(cell)
  return out
}

/** `Remove {name}?` with the row's own values in it. An unknown field is left as it was. */
export const fill = (template: string, row: Row): string =>
  template.replace(/\{([a-z][a-z0-9_]*)\}/gi, (whole, field: string) =>
    row[field] === undefined ? whole : String(row[field]),
  )

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
