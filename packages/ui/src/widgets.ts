// SPDX-License-Identifier: AGPL-3.0-only
import { COLD, DISTANCE, HELD, type Link, type Node, place, radius, settle, step, WARM } from './force.js'

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
  /**
   * The twelfth (D115). A `table` says what is there; this says **what points at what**, for
   * a plugin whose rows carry links somebody authored rather than links a model guessed.
   */
  | 'graph'
  /**
   * The thirteenth. A `graph` says what points at what; this says **what it looks like**, for a
   * plugin that has made something there was previously nowhere to put.
   */
  | 'image'
  /**
   * Core's own, and **not one a plugin may declare** (D112). The bar in `ui-schema.md` is
   * *more than one user*, and this has exactly one — so it is not in the manifest schema and
   * no plugin can ask for it. It is here because it is drawn by this file like everything
   * else: one renderer, and the control surface still names no tab and no plugin.
   */
  | 'ladder'

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
  /** `image`: one picture rather than a grid — *the thing happening now* rather than *everything*. */
  single?: boolean
  /** `ladder`: the slider's stops, and the two actions it presses. `rows` is shared with `table`. */
  rows?: string
  stops?: { value: string; label: string; hint: string }[]
  chose?: string
  ordered?: string
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

    case 'ladder': {
      // Same rule as a table's hint, and for the same reason: this widget is tall, and a
      // sentence explaining a control does nothing under the thing it explains.
      field.append(el('span', 'label', declared.label))
      if (declared.hint) field.append(el('p', 'hint lede', declared.hint))
      field.append(ladder(host, declared))
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

    case 'graph': {
      // Above the picture for the same reason it is above a table: the sentence saying what
      // the ring means is no use underneath something 60vh tall.
      field.append(el('span', 'label', declared.label))
      if (declared.hint) field.append(el('p', 'hint lede', declared.hint))
      field.append(graph(host, declared))
      break
    }

    case 'image': {
      field.append(el('span', 'label', declared.label))
      if (declared.hint) field.append(el('p', 'hint lede', declared.hint))
      field.append(pictures(host, declared))
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
          // And every list on this screen, because a button that changes what a list holds
          // is most of what a button on these screens is for — *New chat* above the
          // conversations, *Clone* above the voices, *Search* above the results. Each of
          // those left the list beside it showing the answer to a question nobody was
          // asking any more. Asking again is the table's own `load`, so the sentence this
          // press just wrote survives it.
          reloadTables(host)
          button.disabled = declared.available === false
        }
      }
      button.addEventListener('click', () => void press())
      field.append(button, said)
      break
    }
  }

  if (
    declared.hint &&
    declared.type !== 'password' &&
    declared.type !== 'table' &&
    declared.type !== 'graph' &&
    declared.type !== 'image' &&
    declared.type !== 'ladder'
  ) {
    field.append(el('p', 'hint', declared.hint))
  }
  field.append(problem)
  return field
}

/**
 * *Ask for your rows again.* Dispatched at every table and map on the screen an `action` was
 * pressed on — which is one plugin's page or one panel tab, never the whole window.
 *
 * An event rather than a registry: a table that has been drawn over is gone from the DOM and
 * so hears nothing, which is the correct behaviour and is free here rather than being a list
 * somebody has to remember to remove things from.
 */
const RELOAD = 'alexia:rows'

const reloadTables = (host: WidgetHost): void => {
  for (const box of host.root().querySelectorAll('.table-box')) box.dispatchEvent(new Event(RELOAD))
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

  box.addEventListener(RELOAD, () => void load())
  void load()
  return box
}

/**
 * The twelfth widget: things that point at each other, on a canvas (D115, M6-11).
 *
 * **The only widget that draws pixels, and it still declares nothing about them.** A plugin
 * names the tool that answers with the nodes and, if it has one, the tool that says more
 * about one of them; the colours, the physics, the labels and the reach of the pointer are
 * core's, exactly as they are for a `table`. Which is the whole reason this is a widget
 * rather than the two other answers M6-7 weighed: a bespoke canvas in the shell would have
 * put one plugin's name in this file, and an iframe would have handed a plugin the pixels.
 *
 * The arithmetic is `force.ts`, where it can be tested without a browser. What is here is
 * the canvas, the pointer and the paint.
 */
/**
 * The thirteenth widget: pictures a plugin has made (`alexia_protocol` 5).
 *
 * **A plugin says what the pictures are. Everything about how they look is here.** Size, fit,
 * the shape of the gap while one loads, what happens to one that has been deleted since, and
 * what any of it does in the dark — those are the decisions that make a page look like one
 * page, and a widget that let an author choose them would be a sandboxed iframe with extra
 * steps.
 *
 * **A source is a path or it is nothing.** A `data:` URL is passed through for something held
 * in memory; anything else is fetched through `/api/plugin-file`, which will only read inside
 * the asking plugin’s own folder. So a row pointing at somebody’s documents does not draw a
 * picture of them — it draws the gap, with its caption, which is the same thing a deleted file
 * draws and needs no separate explaining.
 */
function pictures(host: WidgetHost, declared: Rendered): HTMLElement {
  // `table-box` for the same reason `graph` uses it: *ask for your rows again* is addressed to
  // this class, and a second one would be a second thing to remember in `reloadTables`.
  const box = el('div', 'table-box')
  const said = el('p', 'hint', 'Loading…')
  const grid = el('div', declared.single === true ? 'image-one' : 'image-grid')
  const drawer = el('div', 'graph-note')
  drawer.hidden = true
  const noteTitle = el('p', 'graph-note-title')
  const noteBody = el('p', 'detail-text')
  const close = el('button', 'quiet-button', 'Close')
  close.type = 'button'
  close.addEventListener('click', () => {
    drawer.hidden = true
  })
  drawer.append(noteTitle, noteBody, close)
  box.append(said, grid, drawer)

  let rows: Row[] = []

  /** Where the shell should fetch this one from, or nothing if it is not a picture at all. */
  const source = (row: Row): string | undefined => {
    const src = String(row.src ?? '').trim()
    if (src === '') return undefined
    if (src.startsWith('data:')) return src
    return `/api/plugin-file?plugin=${encodeURIComponent(host.plugin)}&path=${encodeURIComponent(src)}`
  }

  const paint = (): void => {
    grid.replaceChildren()
    if (rows.length === 0) {
      said.textContent = 'Nothing here yet.'
      said.hidden = false
      return
    }
    said.hidden = true
    for (const row of rows) {
      const cell = el('figure', 'image-cell')
      const from = source(row)
      const caption = String(row.caption ?? '')
      if (from === undefined) {
        cell.append(el('div', 'image-gap'))
      } else {
        const picture = el('img', 'image-shot') as HTMLImageElement
        picture.loading = 'lazy'
        picture.decoding = 'async'
        picture.src = from
        // Its own words where there are any. A caption is what a person reads; `alt` is what
        // somebody who cannot see it reads, and they are not always the same sentence.
        picture.alt = String(row.alt ?? caption ?? '')
        // **A file that has gone is a gap, not a broken picture.** It was there when the plugin
        // listed it; it is not now. That is a fact about the file rather than an error, and a
        // torn-page icon says neither.
        picture.addEventListener('error', () => {
          const gap = el('div', 'image-gap')
          gap.title = 'This file is no longer where it was made.'
          picture.replaceWith(gap)
        })
        cell.append(picture)
      }
      if (caption !== '') cell.append(el('figcaption', 'image-caption', caption))
      if (declared.detail !== undefined) {
        cell.classList.add('image-openable')
        cell.tabIndex = 0
        cell.setAttribute('role', 'button')
        const open = (): void => {
          void (async () => {
            noteTitle.textContent = caption || 'This one'
            noteBody.textContent = 'Loading…'
            drawer.hidden = false
            const answer = await host.send('/api/detail', {
              plugin: host.plugin,
              key: declared.detail ?? '',
              row: String(row.id ?? ''),
            })
            noteBody.textContent = String(answer.text ?? answer.said ?? 'There is nothing more to say about that.')
          })()
        }
        cell.addEventListener('click', open)
        cell.addEventListener('keydown', (event) => {
          if ((event as KeyboardEvent).key === 'Enter' || (event as KeyboardEvent).key === ' ') {
            event.preventDefault()
            open()
          }
        })
      }
      grid.append(cell)
    }
  }

  const load = async (): Promise<void> => {
    const answer = await host.send('/api/rows', { plugin: host.plugin, key: declared.rows ?? '' })
    rows = (answer.rows ?? []) as Row[]
    if (answer.ok === false) {
      said.textContent = String(answer.said ?? 'That did not answer.')
      said.hidden = false
      grid.replaceChildren()
      return
    }
    paint()
  }

  box.addEventListener(RELOAD, () => void load())
  void load()
  return box
}

function graph(host: WidgetHost, declared: Rendered): HTMLElement {
  // `table-box` because that is what *asks for its rows again* is addressed to, and a map is
  // asking the same question of the same tool. A second class would be a second thing to
  // remember in `reloadTables`.
  const box = el('div', 'table-box')
  const said = el('p', 'hint', 'Loading…')
  const frame = el('div', 'graph-frame')
  const canvas = el('canvas', 'graph-canvas')
  // A picture of a person's own memory, described for somebody who cannot see it. The reach
  // of it is honest: what the canvas can say is how much is in it, and the detail beneath
  // says the rest in words.
  canvas.setAttribute('role', 'img')
  const drawer = el('div', 'graph-note')
  drawer.hidden = true
  const noteTitle = el('p', 'graph-note-title')
  const noteBody = el('p', 'detail-text')
  const close = el('button', 'quiet-button', 'Close')
  close.type = 'button'
  close.addEventListener('click', () => {
    drawer.hidden = true
    chosen = undefined
    paint()
  })
  drawer.append(noteTitle, noteBody, close)
  frame.append(canvas, drawer)

  let query = ''
  if (declared.filter === true) {
    const search = el('input', 'table-filter')
    search.type = 'search'
    search.placeholder = `Filter ${declared.label.toLowerCase()}`
    search.setAttribute('aria-label', `Filter ${declared.label}`)
    search.addEventListener('input', () => {
      query = search.value.trim().toLowerCase()
      build()
    })
    box.append(search)
  }
  box.append(said, frame)

  /** Everything the tool last answered with, before the filter has had its say. */
  let rows: Row[] = []
  let nodes: Node[] = []
  let links: Link[] = []
  let alpha = 0
  /** World → screen: a scale and an offset, moved by the wheel and by dragging the ground. */
  let scale = 1
  let panX = 0
  let panY = 0
  let hovered: Node | undefined
  let chosen: Node | undefined
  let held: Node | undefined
  let panning: { x: number; y: number } | undefined
  let drawing = false
  /** Each node's neighbours, for the quietening on hover. */
  const near = new Map<string, string[]>()
  /** Whether somebody has moved the camera themselves. After that it is theirs, not ours. */
  let touched = false
  /** Whether the settled layout has been framed once. A spiral is not the shape it ends up. */
  let framed = false
  /** Somebody has asked not to be shown motion: settle it in one go and paint the answer. */
  const still = window.matchMedia('(prefers-reduced-motion: reduce)')

  const linksOf = (row: Row): string[] =>
    Array.isArray(row.links) ? row.links.map((one) => String(one)) : []

  /** The rows, as a graph — filtered, and with any link to something not shown dropped. */
  function build(): void {
    const kept =
      query === '' ? rows : (
        rows.filter((row) => String(row.label ?? row.id).toLowerCase().includes(query))
      )
    const shown = new Set(kept.map((row) => String(row.id)))
    // Positions survive a filter: a node that was on screen before stays where the eye left
    // it, which is what makes typing into the filter read as *fewer things* rather than as a
    // different picture each keystroke.
    const before = new Map(nodes.map((node) => [node.id, node]))
    nodes = kept.map((row) => {
      const id = String(row.id)
      const was = before.get(id)
      return {
        id,
        label: String(row.label ?? id),
        mark: row.mark === true,
        x: was?.x ?? 0,
        y: was?.y ?? 0,
        vx: 0,
        vy: 0,
        degree: 0,
      }
    })
    const by = new Map(nodes.map((node) => [node.id, node]))
    links = []
    // One edge per pair. Two notes that name each other are one link on the screen, and
    // counting it twice pulled every spring twice as hard as the physics was tuned for.
    const drawn = new Set<string>()
    for (const row of kept) {
      const source = by.get(String(row.id))!
      for (const id of linksOf(row)) {
        const target = by.get(id)
        // A link to something the filter is hiding, or to a row that is not there at all, is
        // dropped rather than drawn to nowhere. Half an edge is a lie about the shape.
        if (!target || !shown.has(id) || target === source) continue
        const pair = source.id < target.id ? `${source.id}:${target.id}` : `${target.id}:${source.id}`
        if (drawn.has(pair)) continue
        drawn.add(pair)
        source.degree += 1
        target.degree += 1
        links.push({ source, target })
      }
    }
    // Who touches whom, so hovering one thing can quieten everything it has nothing to do
    // with. Built once here rather than searched for on every frame.
    near.clear()
    for (const { source, target } of links) {
      near.set(source.id, [...(near.get(source.id) ?? []), target.id])
      near.set(target.id, [...(near.get(target.id) ?? []), source.id])
    }
    if (before.size === 0 || nodes.every((node) => before.has(node.id) === false)) place(nodes)

    chosen = chosen && by.get(chosen.id)
    hovered = undefined
    held = undefined
    drawer.hidden = chosen === undefined
    canvas.setAttribute(
      'aria-label',
      `${declared.label}: ${String(nodes.length)} things and ${String(links.length)} links, drawn as a map.`,
    )
    said.hidden = nodes.length > 0
    said.textContent =
      rows.length === 0 ? 'Nothing here yet.'
      : nodes.length === 0 ? 'Nothing matches that.'
      : ''
    // Not once somebody has moved the camera themselves: a filter is *fewer things*, and
    // reframing the view under a person typing into a box is the picture jumping at them.
    if (!touched) fit()
    warm()
  }

  /** How much wider than tall the canvas is. The layout is told, so it fills the frame. */
  function shape(): number {
    const box = canvas.getBoundingClientRect()
    return box.height > 0 ? Math.min(4, Math.max(0.25, box.width / box.height)) : 1
  }

  /** Everything in view, with room around it. Run once a layout has somewhere to be. */
  function fit(): void {
    if (nodes.length === 0) return
    if (still.matches) settle(nodes, links)
    const xs = nodes.map((node) => node.x)
    const ys = nodes.map((node) => node.y)
    const width = Math.max(...xs) - Math.min(...xs) + DISTANCE * 2
    const height = Math.max(...ys) - Math.min(...ys) + DISTANCE * 2
    const box = canvas.getBoundingClientRect()
    scale = Math.min(3, Math.max(0.15, Math.min(box.width / width, box.height / height)))
    panX = box.width / 2
    panY = box.height / 2
  }

  /** Set it moving again — new data, a drag, a release. Nothing happens if motion is off. */
  function warm(reheat = WARM): void {
    if (still.matches) {
      // Not while a node is under a finger: settling the whole graph on every pointermove is
      // hundreds of ticks per pixel. It settles once, on release.
      if (held === undefined) settle(nodes, links)
      paint()
      return
    }
    alpha = Math.max(alpha, reheat)
    if (drawing) return
    drawing = true
    const tick = (): void => {
      // Heading for a standstill, unless a hand is on it — d3's `alphaTarget`, and the whole
      // difference between a graph that follows your hand and one that stiffens under it.
      if (alpha > COLD) alpha = step(nodes, links, alpha, held === undefined ? 0 : HELD, shape())
      // The spiral it starts from is not the shape it ends in, so it frames itself once when
      // it stops moving — and never again, because after that the view is somebody else's.
      if (alpha <= COLD && !framed && !touched) {
        framed = true
        fit()
      }
      paint()
      // The canvas is gone from the document the moment a tab is switched, and a loop that
      // kept painting into it would be this screen's only permanent cost.
      if (canvas.isConnected && (alpha > COLD || held !== undefined)) {
        requestAnimationFrame(tick)
        return
      }
      drawing = false
    }
    requestAnimationFrame(tick)
  }

  /** The page's own palette, read off the canvas so the theme's switch needs no listener. */
  const inks = (): ((name: string) => string) => {
    const style = getComputedStyle(canvas)
    return (name) => style.getPropertyValue(name).trim()
  }
  const at = (event: PointerEvent | WheelEvent): { x: number; y: number } => {
    const box = canvas.getBoundingClientRect()
    return { x: event.clientX - box.left, y: event.clientY - box.top }
  }
  const world = (point: { x: number; y: number }): { x: number; y: number } => ({
    x: (point.x - panX) / scale,
    y: (point.y - panY) / scale,
  })
  /** How big a node is drawn — the same radius the layout keeps its neighbours clear of. */
  const sizeOf = (node: Node): number => radius(node)
  /** Where a node is on the screen rather than in the world. Labels are measured in pixels. */
  const project = (node: Node): { x: number; y: number } => ({ x: node.x * scale + panX, y: node.y * scale + panY })
  /** A name long enough to cross the whole map is a name nobody reads to the end of anyway. */
  const trim = (label: string): string => (label.length > 34 ? `${label.slice(0, 33)}…` : label)
  const LABEL = 12

  function paint(): void {
    const box = canvas.getBoundingClientRect()
    const ratio = window.devicePixelRatio || 1
    if (canvas.width !== Math.round(box.width * ratio) || canvas.height !== Math.round(box.height * ratio)) {
      canvas.width = Math.round(box.width * ratio)
      canvas.height = Math.round(box.height * ratio)
    }
    const pen = canvas.getContext('2d')
    if (!pen) return
    pen.setTransform(ratio, 0, 0, ratio, 0, 0)
    pen.clearRect(0, 0, box.width, box.height)

    const ink = inks()
    const accent = ink('--accent')
    const marked = ink('--chosen')

    /**
     * What is being looked at, and what it touches.
     *
     * The thing a reader actually wants from a picture like this is *what is this one joined
     * to*, and on sixty-three notes with a hub through the middle no amount of layout answers
     * it. Pointing at something does: its own links come forward and everything else goes
     * quiet, which costs one set and two extra paths.
     */
    const lit = hovered ?? chosen
    const family = lit === undefined ? undefined : new Set([lit.id, ...(near.get(lit.id) ?? [])])

    pen.save()
    pen.translate(panX, panY)
    pen.scale(scale, scale)

    // Two paths rather than one per link: the quiet ones, then the ones being looked at.
    pen.lineWidth = 1 / scale
    pen.strokeStyle = ink('--line-strong')
    pen.globalAlpha = family === undefined ? 0.4 : 0.12
    pen.beginPath()
    for (const { source, target } of links) {
      if (lit !== undefined && (source === lit || target === lit)) continue
      pen.moveTo(source.x, source.y)
      pen.lineTo(target.x, target.y)
    }
    pen.stroke()
    if (lit !== undefined) {
      pen.strokeStyle = accent
      pen.globalAlpha = 0.9
      pen.lineWidth = 1.5 / scale
      pen.beginPath()
      for (const { source, target } of links) {
        if (source !== lit && target !== lit) continue
        pen.moveTo(source.x, source.y)
        pen.lineTo(target.x, target.y)
      }
      pen.stroke()
    }

    for (const node of nodes) {
      pen.globalAlpha = family === undefined || family.has(node.id) ? 1 : 0.25
      pen.beginPath()
      pen.arc(node.x, node.y, sizeOf(node), 0, 2 * Math.PI)
      pen.fillStyle = accent
      pen.fill()
      // The ring is drawn *after* the node rather than instead of it, so *what sort of thing
      // is this* and *where did it come from* stay two signals rather than fighting over one
      // pixel — the predecessor's own lesson, and the reason its rings were rings.
      if (node.mark === true) {
        pen.beginPath()
        pen.arc(node.x, node.y, sizeOf(node) + 3.5, 0, 2 * Math.PI)
        pen.strokeStyle = marked
        pen.lineWidth = 1.5 / scale
        pen.stroke()
      }
      if (node === chosen || node === lit) {
        pen.beginPath()
        pen.arc(node.x, node.y, sizeOf(node) + 7, 0, 2 * Math.PI)
        pen.strokeStyle = accent
        pen.lineWidth = 1.5 / scale
        pen.stroke()
      }
    }
    pen.globalAlpha = 1
    pen.restore()

    /**
     * The names, in screen pixels and only where one fits.
     *
     * **Drawing every label is the same as drawing none**, which is what the first pass did
     * and what a screenshot of sixty-three notes shows: a grey smear with a graph behind it.
     * So each name claims a rectangle, and a name whose rectangle is taken is not drawn — in
     * an order that decides who wins: whatever is being pointed at, then what it touches, then
     * the busiest. Zooming in spreads the rectangles and the rest appear, which is the same
     * gesture somebody makes to read one anyway.
     */
    pen.font = `${String(LABEL)}px system-ui, -apple-system, sans-serif`
    pen.textAlign = 'center'
    pen.textBaseline = 'bottom'
    pen.lineJoin = 'round'
    const ground = ink('--surface-raised')
    const bright = ink('--ink')
    const quiet = ink('--ink-quiet')
    const rank = (node: Node): number =>
      (node === lit ? 1e6 : 0) + (family?.has(node.id) === true ? 1e5 : 0) + node.degree
    const taken: { left: number; right: number; top: number; bottom: number }[] = []
    for (const node of [...nodes].sort((a, b) => rank(b) - rank(a))) {
      const spot = project(node)
      const label = trim(node.label)
      const width = pen.measureText(label).width
      const bottom = spot.y - sizeOf(node) * scale - 5
      const room = { left: spot.x - width / 2 - 3, right: spot.x + width / 2 + 3, top: bottom - LABEL, bottom }
      if (room.right < 0 || room.left > box.width || room.bottom < 0 || room.top > box.height) continue
      if (
        taken.some(
          (one) => room.left < one.right && room.right > one.left && room.top < one.bottom && room.bottom > one.top,
        )
      ) {
        continue
      }
      taken.push(room)
      pen.globalAlpha = family === undefined || family.has(node.id) ? 1 : 0.3
      // The ground, painted round the letters rather than behind them: a filled box would
      // cover the links it sits on, and a name over a line is unreadable without one.
      pen.strokeStyle = ground
      pen.lineWidth = 3
      pen.strokeText(label, spot.x, bottom)
      pen.fillStyle = node === lit || node === chosen ? bright : quiet
      pen.fillText(label, spot.x, bottom)
    }
    pen.globalAlpha = 1
  }

  /** The node under a point, or nothing. Generous by a few pixels, because a dot is small. */
  function nodeAt(point: { x: number; y: number }): Node | undefined {
    const spot = world(point)
    let best: Node | undefined
    let nearest = Infinity
    for (const node of nodes) {
      const away = Math.hypot(node.x - spot.x, node.y - spot.y)
      if (away < nearest && away < sizeOf(node) + 6 / scale) {
        nearest = away
        best = node
      }
    }
    return best
  }

  canvas.addEventListener('pointerdown', (event) => {
    const point = at(event)
    const found = nodeAt(point)
    canvas.setPointerCapture(event.pointerId)
    if (found) {
      held = found
      found.held = true
      canvas.style.cursor = 'grabbing'
      // HELD rather than a one-off nudge: the loop keeps handing this back to `step` as the
      // temperature it is heading for, so a long drag ends as lively as it started.
      warm(HELD)
      return
    }
    panning = { x: point.x - panX, y: point.y - panY }
    canvas.style.cursor = 'grabbing'
  })

  canvas.addEventListener('pointermove', (event) => {
    const point = at(event)
    if (held) {
      const spot = world(point)
      held.x = spot.x
      held.y = spot.y
      warm(HELD)
      return
    }
    if (panning) {
      panX = point.x - panning.x
      panY = point.y - panning.y
      // Somebody has framed it themselves now, so nothing here reframes it again.
      touched = true
      paint()
      return
    }
    const found = nodeAt(point)
    if (found === hovered) return
    hovered = found
    canvas.style.cursor = found ? 'pointer' : 'grab'
    paint()
  })

  const release = (event: PointerEvent): void => {
    const wasHeld = held
    if (wasHeld) {
      wasHeld.held = false
      // Let go and the rest of the graph settles around where it was put, rather than
      // snapping back — the same behaviour as dragging a node in the old dashboard.
      held = undefined
      warm(HELD)
    }
    panning = undefined
    canvas.style.cursor = hovered === undefined ? 'grab' : 'pointer'
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
  }
  canvas.addEventListener('pointerup', release)
  canvas.addEventListener('pointercancel', release)

  canvas.addEventListener('click', (event) => {
    const found = nodeAt(at(event))
    if (!found || declared.detail === undefined) return
    chosen = found
    drawer.hidden = false
    noteTitle.textContent = found.label
    noteBody.className = 'detail-text'
    noteBody.textContent = 'Loading…'
    paint()
    void host.send('/api/detail', { plugin: host.plugin, key: declared.key, row: found.id }).then((answer) => {
      noteBody.className = answer.ok === true ? 'detail-text' : 'detail-text error'
      noteBody.textContent = String((answer.ok === true ? answer.text : answer.said) ?? '')
    })
  })

  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault()
      const point = at(event)
      const before = world(point)
      touched = true
      scale = Math.min(6, Math.max(0.1, scale * Math.exp(-event.deltaY * 0.002)))
      // Whatever was under the pointer stays under the pointer, which is what makes a wheel
      // feel like zooming rather than like the picture running away.
      panX = point.x - before.x * scale
      panY = point.y - before.y * scale
      paint()
    },
    { passive: false },
  )

  const onResize = (): void => {
    // The canvas is replaced whenever the panel is redrawn, and the listener would otherwise
    // outlive every one of them.
    if (canvas.isConnected) paint()
    else window.removeEventListener('resize', onResize)
  }
  window.addEventListener('resize', onResize)

  async function load(): Promise<void> {
    const answer = (await host.send('/api/rows', { plugin: host.plugin, key: declared.key })) as {
      ok?: boolean
      rows?: Row[]
      said?: string
      ask?: string
    }
    if (answer.ok !== true) {
      said.hidden = false
      said.className = 'error'
      // A map behind a permission question is a map nobody asked to see yet. It says so and
      // stops, rather than half-drawing something — `table` is where the yes is given.
      said.textContent = String(answer.ask ?? answer.said ?? 'That did not work.')
      return
    }
    said.className = 'hint'
    rows = answer.rows ?? []
    build()
  }

  box.addEventListener(RELOAD, () => void load())
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

/**
 * The routing ladder: what may answer, and in what order (D112).
 *
 * **Two controls, and the first one is a wall.** *Recommended* was a word covering a rule —
 * cheapest that fits — and everybody read their own meaning into it, so the slider says the
 * money question out loud and the ladder under it says the running order. Neither is a new
 * mechanism: the slider presses an `action` with its value, the ladder presses one with the
 * whole list, and both land on pins the router already reads.
 *
 * **The list is a shortlist, not the catalog.** Four hundred rows is not a thing anybody
 * drags into order, and a screen that asks them to is a screen nobody finishes — so the
 * columns start empty, everything unlisted still answers behind whatever is listed, and the
 * only way in is the search box. The ordering is one flat list, free first and then paid,
 * which is exactly the shape the router reads: the group is a property of the model, so a
 * paid row dragged to the top of its own column is still behind every free one unless the
 * slider says otherwise.
 */
function ladder(host: WidgetHost, declared: Rendered): HTMLElement {
  const box = el('div', 'ladder')
  const stops = declared.stops ?? []
  const sides = [
    { id: 'free', label: 'Free', empty: 'Nothing listed. The free models answer cheapest first.' },
    { id: 'paid', label: 'Paid', empty: 'Nothing listed. The paid models answer cheapest first when it gets to them.' },
  ]

  let spend = typeof declared.value === 'string' ? declared.value : (stops[0]?.value ?? '')
  let rows: Row[] = []
  /** The user's own running order, by id — free ids first, then paid, which is what core stores. */
  let order: string[] = []

  const said = el('p', 'ladder-said')
  said.hidden = true
  const say = (text: string, ok: boolean): void => {
    said.textContent = text
    said.className = ok ? 'ladder-said' : 'ladder-said error'
    said.hidden = text === ''
  }

  const press = async (key: string | undefined, value: string): Promise<void> => {
    if (key === undefined) return
    const answer = await host.send('/api/action', { plugin: host.plugin, key, row: value })
    say(String(answer.said ?? ''), answer.ok === true)
  }

  const columns = new Map<string, HTMLElement>()
  const lists = new Map<string, HTMLElement>()
  const grid = el('div', 'ladder-cols')

  for (const side of sides) {
    const column = el('section', 'ladder-col')
    column.dataset.side = side.id
    const head = el('header', 'ladder-head')
    head.append(el('span', 'ladder-name', side.label), el('span', 'ladder-count'))
    const list = el('ol', 'ladder-list')
    list.setAttribute('aria-label', `${side.label} models, in the order they are tried`)
    const empty = el('p', 'ladder-empty', side.empty)
    column.append(head, list, empty)
    columns.set(side.id, column)
    lists.set(side.id, list)
    grid.append(column)
  }

  // ---- the slider --------------------------------------------------------------------------

  /**
   * Named stops on one track, with the pill sliding between them.
   *
   * Radios rather than a `range` input, because the three positions are three different
   * decisions and not three amounts — and because a radio group is the one control that
   * arrives with arrow keys, a screen reader and a label per stop already attached.
   */
  const track = el('div', 'grade')
  track.setAttribute('role', 'radiogroup')
  track.setAttribute('aria-label', declared.label)
  track.style.setProperty('--stops', String(stops.length))
  const thumb = el('span', 'grade-thumb')
  thumb.setAttribute('aria-hidden', 'true')
  track.append(thumb)

  const explains = el('p', 'grade-hint')
  const name = `${host.screen}-${host.plugin}-${declared.key}`

  const slide = (): void => {
    const at = Math.max(0, stops.findIndex((stop) => stop.value === spend))
    // One custom property, and the transition is on the pill's transform. Nothing else about
    // the control changes, so nothing reflows while it moves.
    track.style.setProperty('--at', String(at))
    explains.textContent = stops[at]?.hint ?? ''
    // The side that is out of play is dimmed rather than removed: what you ordered is still
    // what you ordered, and a column that vanished would read as the list being thrown away.
    for (const [side, column] of columns) column.dataset.off = String(spend !== 'mixed' && spend !== side)
  }

  for (const stop of stops) {
    const choice = el('label', 'grade-stop')
    const input = el('input')
    input.type = 'radio'
    input.name = name
    input.value = stop.value
    input.checked = stop.value === spend
    input.addEventListener('change', () => {
      spend = stop.value
      slide()
      void press(declared.chose, stop.value)
    })
    choice.append(input, el('span', undefined, stop.label))
    track.append(choice)
  }

  // ---- dragging ----------------------------------------------------------------------------

  /** The chip being dragged, so a list knows whether the thing over it is one of its own. */
  let held: HTMLElement | undefined

  /** The first chip whose middle is below the pointer — the one the held chip goes in front of. */
  const before = (list: HTMLElement, y: number): HTMLElement | undefined =>
    [...list.querySelectorAll<HTMLElement>('.chip:not(.held)')].find((chip) => {
      const at = chip.getBoundingClientRect()
      return y < at.top + at.height / 2
    })

  for (const [side, list] of lists) {
    list.addEventListener('dragover', (event) => {
      // A chip belongs to the side its price puts it on, so a list only ever takes its own.
      // Dropping across would be the screen offering to make a paid model free.
      if (!held || held.dataset.side !== side) return
      event.preventDefault()
      const next = before(list, event.clientY)
      if (next) list.insertBefore(held, next)
      else list.append(held)
    })
  }

  /** What the columns say now, read back out of the DOM after a drag has moved things. */
  const readBack = (): string[] =>
    sides.flatMap((side) =>
      [...(lists.get(side.id)?.querySelectorAll<HTMLElement>('.chip') ?? [])].map((chip) => chip.dataset.id ?? ''),
    )

  /** One reorder, sent once. Four swaps would be four chances to land somewhere nobody asked for. */
  const moved = (): void => {
    order = readBack().filter((id) => id !== '')
    paint()
    void press(declared.ordered, order.join(','))
  }

  // ---- one chip ----------------------------------------------------------------------------

  const chip = (row: Row, at: number): HTMLElement => {
    const item = el('li', 'chip')
    item.dataset.id = row.id
    item.dataset.side = String(row.side)
    item.draggable = true
    item.tabIndex = 0
    // The grip leads, because that is where a drag handle is on every list anybody has
    // dragged before. Beside the × it read as a second button rather than an affordance.
    item.append(el('span', 'chip-grip', '⠿'), el('span', 'chip-rank', String(at + 1)))
    const what = el('span', 'chip-what')
    what.append(
      el('span', 'chip-name', String(row.name)),
      el('span', 'chip-meta', `${String(row.provider)} · ${String(row.price)}`),
    )
    item.append(what)

    const drop = el('button', 'chip-drop', '×')
    drop.type = 'button'
    drop.title = `Take ${String(row.name)} off the list`
    drop.setAttribute('aria-label', `Take ${String(row.name)} off the list`)
    drop.addEventListener('click', () => {
      order = order.filter((id) => id !== row.id)
      paint()
      void press(declared.ordered, order.join(','))
    })
    item.append(drop)

    item.addEventListener('dragstart', (event) => {
      held = item
      item.classList.add('held')
      // Firefox and WebKit refuse to start a drag at all unless something is on the
      // transfer. Nothing reads it — the held chip is the state — but without it this
      // control simply does not move on two of the three engines the shell runs in.
      event.dataTransfer?.setData('text/plain', row.id)
    })
    item.addEventListener('dragend', () => {
      item.classList.remove('held')
      held = undefined
      moved()
    })

    /**
     * The same reorder without a mouse.
     *
     * Not optional and not a nicety: drag-and-drop is the fast way and the arrow keys are the
     * only way for some people. The focus follows the row, because a keyboard reorder that
     * drops focus is a keyboard reorder you can do exactly once.
     */
    item.addEventListener('keydown', (event) => {
      const step = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
      if (step === 0) return
      const list = item.parentElement
      const siblings = [...(list?.querySelectorAll<HTMLElement>('.chip') ?? [])]
      const now = siblings.indexOf(item)
      const next = now + step
      if (list === null || next < 0 || next >= siblings.length) return
      event.preventDefault()
      if (step === -1) list.insertBefore(item, siblings[next] ?? null)
      else list.insertBefore(item, siblings[next]?.nextElementSibling ?? null)
      moved()
      lists.get(String(row.side))?.querySelector<HTMLElement>(`[data-id="${CSS.escape(row.id)}"]`)?.focus()
    })
    return item
  }

  // ---- adding one ---------------------------------------------------------------------------

  const search = el('input', 'ladder-search')
  search.type = 'search'
  search.placeholder = 'Search what you can reach, and add it to the order'
  search.setAttribute('aria-label', 'Add a model to the order')
  const hits = el('div', 'ladder-hits')
  hits.hidden = true

  /** Up to this many results. A search box that answers with three hundred rows is the list. */
  const HITS = 6

  const suggest = (): void => {
    const needle = search.value.trim().toLowerCase()
    if (needle === '') {
      hits.replaceChildren()
      hits.hidden = true
      return
    }
    const found = rows
      .filter((row) => !order.includes(row.id))
      .filter((row) => `${String(row.name)} ${String(row.provider)}`.toLowerCase().includes(needle))
      .slice(0, HITS)
    hits.replaceChildren(
      ...found.map((row) => {
        const option = el('button', 'ladder-hit')
        option.type = 'button'
        option.append(
          el('span', 'chip-name', String(row.name)),
          // Which column it lands in, said as the thing that is about to happen. The side
          // printed beside the price read as "free · free" on every free model — the same
          // word twice, meaning two different things.
          el(
            'span',
            'chip-meta',
            `${String(row.provider)} · ${String(row.price)} · goes to ${row.side === 'paid' ? 'Paid' : 'Free'}`,
          ),
        )
        option.addEventListener('click', () => {
          // Appended to the end of its own side, which is the only place it can go: an entry
          // that put itself at the front would be the screen choosing for you again.
          order = [...order, row.id]
          search.value = ''
          suggest()
          paint()
          void press(declared.ordered, order.join(','))
        })
        return option
      }),
    )
    if (found.length === 0) {
      hits.append(el('p', 'ladder-empty', 'Nothing matches, or everything that does is already listed.'))
    }
    hits.hidden = false
  }
  search.addEventListener('input', suggest)

  const clear = el('button', 'more', 'Clear the order')
  clear.type = 'button'
  clear.hidden = true
  clear.addEventListener('click', () => {
    order = []
    paint()
    void press(declared.ordered, '')
  })

  // ---- drawing it ---------------------------------------------------------------------------

  function paint(): void {
    const known = new Map(rows.map((row) => [row.id, row]))
    // Whatever core kept, minus anything that has left the catalog since. This screen shows
    // what will actually happen, and a row naming a model no provider offers will not.
    order = order.filter((id) => known.has(id))
    for (const side of sides) {
      const mine = order
        .map((id) => known.get(id))
        .filter((row): row is Row => row !== undefined && String(row.side) === side.id)
      const list = lists.get(side.id)
      const column = columns.get(side.id)
      list?.replaceChildren(...mine.map((row, at) => chip(row, at)))
      const count = column?.querySelector('.ladder-count')
      if (count) count.textContent = mine.length === 0 ? '' : String(mine.length)
      const empty = column?.querySelector<HTMLElement>('.ladder-empty')
      if (empty) empty.hidden = mine.length > 0
    }
    clear.hidden = order.length === 0
  }

  const load = async (): Promise<void> => {
    const answer = await host.send('/api/rows', { plugin: host.plugin, key: declared.rows ?? '' })
    rows = (answer.rows ?? []) as Row[]
    // The order core is holding, read off the ranks it already puts on the rows — one read
    // rather than a second endpoint saying the same thing in a different shape.
    order = rows
      .filter((row) => String(row.rank ?? '') !== '')
      .sort((a, b) => Number(a.rank) - Number(b.rank))
      .map((row) => row.id)
    paint()
    slide()
  }

  const adding = el('div', 'ladder-add')
  adding.append(search, hits)
  box.append(track, explains, grid, adding, clear, said)
  slide()
  void load()
  return box
}
