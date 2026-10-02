// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rail: identity, which conversation, and the four things somebody changes.
 *
 * It is the General page on the board (D204), the one page that cannot be taken off it — so
 * what earns a place here is what a person reaches for mid-sentence: a new
 * conversation, an old one, which model answers, where the work happens, and what Alexia may
 * do without asking.
 *
 * **Nothing in this file is a second source of truth.** Every list is core's own — the same
 * `chats` and `models` tables the Activity sheet and Settings draw, the same `/api/plugins` the settings
 * screen reads, the same `/api/action` its row buttons press. The rail is a shorter route to
 * them, never a parallel one, which is what stops it showing a model the Models & money page has
 * already changed. And nothing here names a plugin: it renders whatever is installed.
 */

import { connectionLabel, parseCatalogId, THIS_HOST, type HostView } from './compute.js'
import type { SettingsPage } from './settings.js'

interface ChatRow {
  id: string
  title: string
  turns: string
  when: string
  state: string
  /** When it was last said in, in milliseconds since 1970. Absent from an older core. */
  at?: number
}

interface ModelRow {
  id: string
  name: string
  provider: string
  price: string
  state: string
}

interface Pane {
  id: string
  name: string
  enabled: boolean
  running: boolean
}

export interface Rail {
  /** Re-read every list. Called after anything that could have changed one. */
  refresh(): Promise<void>
  /** Whether the list of models under the model row is unfolded. */
  modelsOpen(): boolean
  /** Fold it, for Escape — which closes this before it would put the window away. */
  closeModels(): void
}

export interface RailOptions {
  openPalette(): void
  openControl(tab?: string, filter?: string): void
  openSettings(page?: SettingsPage, filter?: string): void
  /** Repaint the conversation, because opening another one changes what the log holds. */
  reload(): Promise<void>
  /** The conversation's heading, which lives on the Chat page rather than in this one. */
  heading: HTMLElement
  /**
   * Chat's L size puts every conversation beside the log. The same rows, drawn a second time
   * by the same code, rather than a copy that would open conversations some other way.
   */
  alsoInto?: HTMLElement
  /** Called after every full re-read, because a plugin switched here changes the board. */
  refreshed?(): void
  /** The paired computers, as `/api/state` last listed them, for a model that runs on one. */
  hosts?(): readonly HostView[]
}

/**
 * Which paired computer a model row runs on and how it is reached — `Studio · Direct` — or
 * nothing for a model on this computer or at a provider. The host is in the row's id.
 */
export function railHost(id: string, hosts: readonly HostView[]): string {
  const target = parseCatalogId(id.split('\n').pop() ?? id)
  if (target.hostId === THIS_HOST) return ''
  const view = hosts.find((one) => one.host.id === target.hostId)
  return view ? `${view.host.name} · ${connectionLabel(view.connection)}` : 'Paired computer'
}

/** How many conversations the rail shows before you ask for the rest. */
const RECENT = 3
/**
 * How many more *Show more* adds. The whole list once made the rail two thousand pixels tall;
 * past this, the conversations are Activity's, which has the room and a filter.
 */
export const MORE = 10
/** How many models fit in a column this wide before the list stops being a list. */
const MODELS = 8

/**
 * When a conversation was last said in, the way a Mac's own lists say it: the time for today,
 * *Yesterday*, the weekday for this week, and the date before that — in this Mac's language
 * and clock, never core's. `at` is milliseconds since 1970.
 */
export function recentWhen(at: number, now: Date = new Date(), locale?: string): string {
  const then = new Date(at)
  const midnight = (day: Date): number => new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()
  // Whole days between the two midnights, rounded so a daylight-saving night still counts as one.
  const days = Math.round((midnight(now) - midnight(then)) / 86_400_000)
  if (days <= 0) return then.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
  if (days === 1) {
    const word = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-1, 'day')
    return word.charAt(0).toLocaleUpperCase(locale) + word.slice(1)
  }
  if (days < 7) return then.toLocaleDateString(locale, { weekday: 'short' })
  return then.toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    ...(then.getFullYear() !== now.getFullYear() && { year: 'numeric' }),
  })
}

/** A chat row's date: from its timestamp when core sends one, else core's own text. */
export const whenOf = (chat: { at?: number; when: string }, now?: Date): string =>
  typeof chat.at === 'number' && Number.isFinite(chat.at) && chat.at > 0 ? recentWhen(chat.at, now) : chat.when

/**
 * The models the rail lists, each once, in an order that does not move when one is picked.
 *
 * The Models table lists one model once per provider and per group (D161), and puts the
 * chosen one first in a group of its own. A pin names the model, so the rail lists each model
 * once — and skips that leading *chosen* row when the model is also further down, so the row
 * somebody just pressed stays where it was rather than jumping to the top under the pointer.
 * The ◆ travels with the model either way, because core marks every copy of it.
 */
export function railModels<T extends { id: string; state: string }>(rows: readonly T[]): T[] {
  const name = (row: T): string => row.id.split('\n').pop() ?? row.id
  const first = rows[0]
  const lifted = first !== undefined && first.state.startsWith('◆') && rows.slice(1).some((row) => name(row) === name(first))
  const rest = lifted ? rows.slice(1) : [...rows]
  return rest.filter((row, at) => rest.findIndex((other) => name(other) === name(row)) === at)
}

/**
 * Mounted into the page it is handed rather than reaching into the document: since D204 a
 * page is one of several on a board, and a module that looked things up by id anywhere would
 * be one duplicated page away from wiring up the wrong one.
 */
export function mountRail(root: HTMLElement, token: string, options: RailOptions): Rail {
  const recent = root.querySelector<HTMLElement>('#recent')!
  const recentCount = root.querySelector<HTMLElement>('#recent-count')!
  const more = root.querySelector<HTMLButtonElement>('#recent-more')!
  const all = root.querySelector<HTMLButtonElement>('#recent-all')!
  const title = options.heading
  const modelRow = root.querySelector<HTMLButtonElement>('#model-row')!
  const modelValue = root.querySelector<HTMLElement>('#model-value')!
  const modelDrop = root.querySelector<HTMLElement>('#model-drop')!
  const modelSaid = root.querySelector<HTMLElement>('#model-said')!
  const setup = root.querySelector<HTMLElement>('#rail-setup')!
  const plugins = root.querySelector<HTMLElement>('#rail-plugins')!
  const tabSetup = root.querySelector<HTMLButtonElement>('#tab-setup')!
  const tabPlugins = root.querySelector<HTMLButtonElement>('#tab-plugins')!

  let expanded = false
  /** How many of the recent rows fit under Setup right now. {@link fitRecent} sets it. */
  let room = RECENT
  let chats: ChatRow[] = []
  let models: ModelRow[] = []
  /** What went wrong with the last plugin switch, kept across the redraw that flips it back. */
  let pluginSaid = ''

  const post = async (path: string, sent: unknown): Promise<Record<string, unknown>> => {
    try {
      const answer = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-alexia-token': token },
        body: JSON.stringify(sent),
      })
      return answer.ok ? ((await answer.json()) as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }

  /** Core's sentence, or one of ours when core did not get to say one. */
  const saidOf = (answer: Record<string, unknown>, otherwise: string): string =>
    typeof answer.said === 'string' && answer.said !== '' ? answer.said : otherwise

  const rowsOf = async <T>(key: string): Promise<T[]> => ((await post('/api/rows', { key })).rows ?? []) as T[]

  /** A row in the rail: a button, a label that truncates, and something small on the right. */
  const railRow = (what: string, right: string, press?: () => void): HTMLElement => {
    const element = document.createElement(press ? 'button' : 'div')
    element.className = 'rail-row'
    if (element instanceof HTMLButtonElement) {
      element.type = 'button'
      element.addEventListener('click', press!)
    }
    const label = document.createElement('span')
    label.className = 'what'
    label.textContent = what
    element.append(label)
    if (right !== '') {
      const side = document.createElement('span')
      side.className = 'when'
      side.textContent = right
      element.append(side)
    }
    return element
  }

  // ---- the conversations ----------------------------------------------------------------

  const drawChats = (): void => {
    const open = chats.find((chat) => chat.state.includes('open'))
    // The conversation's own name, which is the first thing you said in it. An empty one has
    // not been said in yet, and says so rather than showing a blank heading.
    title.textContent = open?.title.trim() ?? 'New chat'
    if ((title.textContent ?? '') === '') title.textContent = 'New chat'

    const now = new Date()
    const rowOf = (chat: ChatRow): HTMLElement => {
      const named = chat.title.trim() === '' ? 'Nothing said yet' : chat.title
      const row = railRow(named, whenOf(chat, now), () => {
        void post('/api/action', { key: 'open_chat', row: chat.id }).then(async () => {
          await options.reload()
          await refresh()
        })
      })
      // The whole name, for the ones the column cuts short.
      row.title = named
      if (chat.state.includes('open')) {
        row.classList.add('on')
        row.setAttribute('aria-current', 'true')
      }
      return row
    }
    const shown = chats.slice(0, expanded ? RECENT + MORE : room)
    recent.replaceChildren(...shown.map(rowOf))
    options.alsoInto?.replaceChildren(...chats.map(rowOf))
    recentCount.textContent = `${String(shown.length)} of ${String(chats.length)}`
    const left = chats.length - shown.length
    more.hidden = !expanded && left === 0
    more.textContent = expanded ? 'Show fewer' : `Show ${String(Math.min(MORE, left))} more`
    all.hidden = !expanded || left === 0
    all.textContent = `See all ${String(chats.length)} chats`
  }

  /**
   * As many recent rows as fit, down to one. Setup sits above them, so at the page's smallest
   * size the rows are what give way — never the model or the permission control, which were
   * the ones hidden below the page edge when Recent came first. Up to three; a person who
   * wants more asks for them, and then the page scrolls because they asked it to.
   */
  const fitRecent = (): void => {
    room = RECENT
    drawChats()
    if (expanded) return
    while (room > 1 && root.scrollHeight > root.clientHeight + 1) {
      room -= 1
      drawChats()
    }
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => fitRecent()).observe(root)

  more.addEventListener('click', () => {
    expanded = !expanded
    fitRecent()
  })

  // Activity's Chats tab: every conversation, with a filter and Forget.
  all.addEventListener('click', () => options.openControl('chats'))

  root.querySelector<HTMLButtonElement>('#new-chat')!.addEventListener('click', () => {
    void post('/api/action', { key: 'new_chat' }).then(async () => {
      await options.reload()
      await refresh()
    })
  })

  root.querySelector<HTMLButtonElement>('#find')!.addEventListener('click', () => options.openPalette())
  // In the dock in the bottom-left corner, not in this page: they are there whatever is on the board.
  document.querySelector<HTMLButtonElement>('#open-control')!.addEventListener('click', () => options.openControl())
  document.querySelector<HTMLButtonElement>('#open-settings')!.addEventListener('click', () => options.openSettings())

  // ---- which model ------------------------------------------------------------------------

  /** Open or close the list, and give the rows it pushed down back to Recent when it closes. */
  const setDrop = (open: boolean): void => {
    if (modelDrop.hidden === !open) return
    modelDrop.hidden = !open
    modelRow.setAttribute('aria-expanded', String(open))
    fitRecent()
  }

  /**
   * A pick, and core's sentence about it under the Model row. Picking one model turns off
   * falling back to the others (D155), and a pick can be refused — a model with no key — and
   * both used to be said to nobody. The list closes either way: the choice is made, and the
   * sentence is what is left to read.
   */
  const choose = (sent: { key: string; row?: string }): void => {
    setDrop(false)
    void post('/api/action', sent).then(async (answer) => {
      modelSaid.textContent = saidOf(answer, 'Alexia could not be reached, so nothing changed.')
      modelSaid.classList.toggle('refused', answer.ok !== true)
      modelSaid.hidden = false
      await refresh()
    })
  }

  const drawModels = (): void => {
    const pinned = models.find((model) => model.state.startsWith('◆'))
    const hosts = options.hosts?.() ?? []
    // A model on a paired computer says where it runs and how that computer is reached.
    modelValue.textContent = pinned ? [pinned.name, railHost(pinned.id, hosts)].filter(Boolean).join(' · ') : 'Automatic'
    modelRow.title = `Model: ${modelValue.textContent}`

    const chosen = document.createElement('button')
    chosen.type = 'button'
    chosen.className = `opt${pinned === undefined ? ' on' : ''}`
    // Which one is chosen, said as well as drawn: `on` is only a colour.
    if (pinned === undefined) chosen.setAttribute('aria-current', 'true')
    const star = document.createElement('span')
    star.className = 'star'
    const label = document.createElement('span')
    label.textContent = 'Automatic'
    const meta = document.createElement('span')
    meta.className = 'meta'
    meta.textContent = 'per request'
    chosen.append(star, label, meta)
    chosen.addEventListener('click', () => choose({ key: 'automatic' }))

    const note = document.createElement('p')
    note.className = 'drop-note'
    note.textContent = '★ is the one Automatic would pick right now.'

    // The chosen one stays in the list even when it ranks below the first few, at the end
    // rather than on top, so the rows above it do not move.
    const listed = models.slice(0, MODELS)
    if (pinned !== undefined && !listed.includes(pinned)) listed.push(pinned)
    const rows = listed.map((model) => {
      const option = document.createElement('button')
      option.type = 'button'
      option.className = `opt${model.state.startsWith('◆') ? ' on' : ''}`
      const mark = document.createElement('span')
      mark.className = 'star'
      mark.textContent = model.state.startsWith('★') ? '★' : ''
      // Read as what it means rather than as *black star*.
      if (mark.textContent !== '') {
        mark.setAttribute('role', 'img')
        mark.setAttribute('aria-label', "Automatic's pick")
      }
      if (model.state.startsWith('◆')) option.setAttribute('aria-current', 'true')
      const name = document.createElement('span')
      name.textContent = model.name
      const price = document.createElement('span')
      price.className = 'meta'
      price.textContent = railHost(model.id, hosts) || model.price
      option.append(mark, name, price)
      option.addEventListener('click', () => choose({ key: 'use_model', row: model.id }))
      return option
    })

    const rest = document.createElement('button')
    rest.type = 'button'
    rest.className = 'more'
    rest.textContent =
      models.length > MODELS ? `All ${String(models.length)} models` : 'Every model and its price'
    rest.addEventListener('click', () => {
      setDrop(false)
      options.openSettings('models')
    })

    // A model that runs here is one press away in Settings, where its size and licence are
    // on the card before anything is downloaded — so this only opens that page, it never
    // starts a download from a dropdown.
    const local = document.createElement('button')
    local.type = 'button'
    local.className = 'more'
    local.textContent = 'Install a local model…'
    local.addEventListener('click', () => {
      setDrop(false)
      options.openSettings('models')
    })

    modelDrop.replaceChildren(note, chosen, ...rows, rest, local)
    // A provider with no key publishes nothing here, so an empty list is a real answer — and
    // the way out of it is a key, which lives in Settings, so that is where the button goes.
    if (models.length === 0) {
      const none = document.createElement('p')
      none.className = 'drop-note'
      none.textContent = 'No AI service is connected yet, so there is nothing to choose between.'
      const keys = document.createElement('button')
      keys.type = 'button'
      keys.className = 'more'
      keys.textContent = 'Add a key in Settings'
      keys.addEventListener('click', () => {
        setDrop(false)
        options.openSettings('models')
      })
      modelDrop.replaceChildren(none, keys, local)
    }
  }

  modelRow.addEventListener('click', () => {
    const opening = modelDrop.hidden === true
    // The last pick's sentence goes when the list opens: it was about that pick, not this one.
    if (opening) modelSaid.hidden = true
    setDrop(opening)
  })

  // Closed by a click anywhere else, and by Escape — which stops here, because the same key
  // one step further out puts the whole window away (main.ts), and closing a list is not
  // meant to do that. Captured on the window, so it is heard before main.ts's handler is.
  document.addEventListener('click', (event) => {
    if (modelDrop.hidden) return
    const target = event.target as Node | null
    if (target !== null && (modelRow.contains(target) || modelDrop.contains(target))) return
    setDrop(false)
  })
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || modelDrop.hidden) return
      event.preventDefault()
      event.stopPropagation()
      setDrop(false)
      modelRow.focus()
    },
    true,
  )

  /** Folded again by Escape, and the focus goes back to the row that opened it. */
  const closeModels = (): void => {
    modelDrop.hidden = true
    modelRow.setAttribute('aria-expanded', 'false')
    modelRow.focus()
  }

  // ---- the plugins ------------------------------------------------------------------------

  /** The way to the grid, which is where installing, configuring and deleting live (M8-3). */
  const manage = (label: string): HTMLElement => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'more'
    button.textContent = label
    button.addEventListener('click', () => options.openSettings('plugins'))
    return button
  }

  const drawPlugins = (panes: Pane[]): void => {
    if (panes.length === 0) {
      const none = document.createElement('p')
      none.className = 'nothing'
      none.textContent = 'No plugins installed.'
      plugins.replaceChildren(none, manage('Find one'))
      return
    }
    // A switch that did not take flips back on the redraw, and without this line that was all
    // anybody saw of it.
    const said = document.createElement('p')
    said.className = 'rail-said refused'
    said.setAttribute('role', 'status')
    said.textContent = pluginSaid
    said.hidden = pluginSaid === ''
    plugins.replaceChildren(
      ...panes.map((pane) => {
        const row = document.createElement('label')
        row.className = 'rail-row'
        row.title = 'Off stops it. Its data is kept.'
        const what = document.createElement('span')
        what.className = 'what'
        what.textContent = pane.name
        const box = document.createElement('input')
        box.type = 'checkbox'
        box.checked = pane.enabled
        const track = document.createElement('span')
        track.className = 'track'
        box.addEventListener('change', () => {
          box.disabled = true
          const on = box.checked
          void post('/api/plugin', { id: pane.id, action: on ? 'enable' : 'disable' }).then(async (answer) => {
            pluginSaid =
              answer.ok === true ? '' : saidOf(answer, `${pane.name} could not be turned ${on ? 'on' : 'off'}. Try again in a moment.`)
            await refresh()
          })
        })
        row.append(what, box, track)
        row.classList.add('switch')
        return row
      }),
      said,
      // The rail is the switch and nothing else. Everything a plugin can be asked — what it
      // needs, what it stores, whether it stays — is one press away rather than crammed into
      // a column this narrow.
      manage('All plugins'),
    )
  }

  const pick = (which: 'setup' | 'plugins'): void => {
    const onSetup = which === 'setup'
    setup.hidden = !onSetup
    plugins.hidden = onSetup
    tabSetup.classList.toggle('on', onSetup)
    tabPlugins.classList.toggle('on', !onSetup)
    tabSetup.setAttribute('aria-selected', String(onSetup))
    tabPlugins.setAttribute('aria-selected', String(!onSetup))
    // Only the chosen tab is a Tab stop; the arrow keys move between the two (below).
    tabSetup.tabIndex = onSetup ? 0 : -1
    tabPlugins.tabIndex = onSetup ? -1 : 0
    // The two tabs are different heights, and Recent has whatever is left under them.
    fitRecent()
  }

  tabSetup.addEventListener('click', () => pick('setup'))
  tabPlugins.addEventListener('click', () => pick('plugins'))
  // Real tabs, the way a screen reader expects them: the arrow keys, Home and End change which
  // is chosen and take focus with them, rather than two buttons that only say they are tabs.
  for (const tab of [tabSetup, tabPlugins]) {
    tab.addEventListener('keydown', (event) => {
      const to =
        event.key === 'Home' ? 'setup'
        : event.key === 'End' ? 'plugins'
        : event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? (tab === tabSetup ? 'plugins' : 'setup')
        : undefined
      if (to === undefined) return
      event.preventDefault()
      pick(to)
      ;(to === 'setup' ? tabSetup : tabPlugins).focus()
    })
  }

  // ---- reading it all ----------------------------------------------------------------------

  async function refresh(): Promise<void> {
    const [gotChats, gotModels, gotPlugins] = await Promise.all([
      rowsOf<ChatRow>('chats'),
      rowsOf<ModelRow>('models'),
      fetch('/api/plugins', { headers: { 'x-alexia-token': token } })
        .then((answer) => answer.json() as Promise<{ panes?: Pane[] }>)
        .catch(() => ({ panes: [] })),
    ])
    chats = gotChats
    models = railModels(gotModels)
    drawModels()
    drawPlugins(gotPlugins.panes ?? [])
    // Last, because how many conversations fit depends on how tall the two above came out.
    fitRecent()
    options.refreshed?.()
  }

  /**
   * The conversations, on their own, on a timer.
   *
   * **A conversation can now change while nobody is typing.** `refresh()` runs when a task
   * finishes *in this window*, which was every way a conversation could change until a
   * message from a phone became one — so a Telegram chat appeared in this list only after
   * something else happened to redraw it, which is how it looked like it was not appearing
   * at all. The list is one SQLite read, and nothing else here is polled.
   *
   * Only while the window is on screen: a tray icon costing a query every three seconds all
   * day is the sort of thing that gets an app uninstalled.
   *
   * ponytail: a poll, because core has no channel that pushes to an idle shell — `/api/chat`
   * is a stream per request and nothing else streams. A push beats three seconds; add one
   * when something else needs it too.
   */
  const watch = (): void => {
    window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void rowsOf<ChatRow>('chats').then((got) => {
        // Redrawn only when it actually changed, so a list somebody is reading does not
        // rebuild itself under them every three seconds.
        if (JSON.stringify(got) === JSON.stringify(chats)) return
        chats = got
        drawChats()
      })
    }, 3000)
  }
  watch()

  return { refresh, modelsOpen: () => !modelDrop.hidden, closeModels }
}
