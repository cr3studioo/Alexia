// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rail: identity, which conversation, and the four things somebody changes.
 *
 * It is the one panel that never goes away — Settings and Control swap the middle out from
 * under it — so what earns a place here is what a person reaches for mid-sentence: a new
 * conversation, an old one, which model answers, where the work happens, and what Alexia may
 * do without asking.
 *
 * **Nothing in this file is a second source of truth.** Every list is core's own — the same
 * `chats` and `models` tables the Control surface draws, the same `/api/plugins` the settings
 * screen reads, the same `/api/action` its row buttons press. The rail is a shorter route to
 * them, never a parallel one, which is what stops it showing a model the Models tab has
 * already changed. And nothing here names a plugin: it renders whatever is installed.
 */

interface ChatRow {
  id: string
  title: string
  turns: string
  when: string
  state: string
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
}

export interface RailOptions {
  openPalette(): void
  openControl(tab?: string, filter?: string): void
  openSettings(page?: 'general' | 'plugins'): void
  /** Repaint the conversation, because opening another one changes what the log holds. */
  reload(): Promise<void>
}

/** How many conversations the rail shows before you ask for the rest. */
const RECENT = 3
/** How many models fit in a column this wide before the list stops being a list. */
const MODELS = 8

export function mountRail(token: string, options: RailOptions): Rail {
  const recent = document.querySelector<HTMLElement>('#recent')!
  const recentCount = document.querySelector<HTMLElement>('#recent-count')!
  const more = document.querySelector<HTMLButtonElement>('#recent-more')!
  const title = document.querySelector<HTMLElement>('#chat-title')!
  const modelRow = document.querySelector<HTMLButtonElement>('#model-row')!
  const modelValue = document.querySelector<HTMLElement>('#model-value')!
  const modelDrop = document.querySelector<HTMLElement>('#model-drop')!
  const setup = document.querySelector<HTMLElement>('#rail-setup')!
  const plugins = document.querySelector<HTMLElement>('#rail-plugins')!
  const tabSetup = document.querySelector<HTMLButtonElement>('#tab-setup')!
  const tabPlugins = document.querySelector<HTMLButtonElement>('#tab-plugins')!

  let expanded = false
  let chats: ChatRow[] = []
  let models: ModelRow[] = []

  const post = async (path: string, sent: unknown): Promise<Record<string, unknown>> => {
    const answer = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alexia-token': token },
      body: JSON.stringify(sent),
    })
    return answer.ok ? ((await answer.json()) as Record<string, unknown>) : {}
  }

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

    const shown = expanded ? chats : chats.slice(0, RECENT)
    recent.replaceChildren(
      ...shown.map((chat) => {
        const row = railRow(chat.title.trim() === '' ? 'Nothing said yet' : chat.title, chat.when, () => {
          void post('/api/action', { key: 'open_chat', row: chat.id }).then(async () => {
            await options.reload()
            await refresh()
          })
        })
        if (chat.state.includes('open')) row.classList.add('on')
        return row
      }),
    )
    recentCount.textContent = expanded ? String(chats.length) : `${String(Math.min(RECENT, chats.length))} of ${String(chats.length)}`
    more.hidden = chats.length <= RECENT
    more.textContent = expanded ? 'Show fewer' : `Show ${String(chats.length - RECENT)} more`
  }

  more.addEventListener('click', () => {
    expanded = !expanded
    drawChats()
  })

  document.querySelector<HTMLButtonElement>('#new-chat')!.addEventListener('click', () => {
    void post('/api/action', { key: 'new_chat' }).then(async () => {
      await options.reload()
      await refresh()
    })
  })

  document.querySelector<HTMLButtonElement>('#find')!.addEventListener('click', () => options.openPalette())
  document.querySelector<HTMLButtonElement>('#open-control')!.addEventListener('click', () => options.openControl())
  document.querySelector<HTMLButtonElement>('#open-settings')!.addEventListener('click', () => options.openSettings())

  // ---- which model ------------------------------------------------------------------------

  const drawModels = (): void => {
    const pinned = models.find((model) => model.state.startsWith('◆'))
    modelValue.textContent = pinned?.name ?? 'Automatic'

    const chosen = document.createElement('button')
    chosen.type = 'button'
    chosen.className = `opt${pinned === undefined ? ' on' : ''}`
    const star = document.createElement('span')
    star.className = 'star'
    const label = document.createElement('span')
    label.textContent = 'Automatic'
    const meta = document.createElement('span')
    meta.className = 'meta'
    meta.textContent = 'per request'
    chosen.append(star, label, meta)
    chosen.addEventListener('click', () => {
      void post('/api/action', { key: 'automatic' }).then(() => refresh())
    })

    const note = document.createElement('p')
    note.className = 'drop-note'
    note.textContent = '★ is the one Automatic would pick right now.'

    const rows = models.slice(0, MODELS).map((model) => {
      const option = document.createElement('button')
      option.type = 'button'
      option.className = `opt${model.state.startsWith('◆') ? ' on' : ''}`
      const mark = document.createElement('span')
      mark.className = 'star'
      mark.textContent = model.state.startsWith('★') ? '★' : ''
      const name = document.createElement('span')
      name.textContent = model.name
      const price = document.createElement('span')
      price.className = 'meta'
      price.textContent = model.price
      option.append(mark, name, price)
      option.addEventListener('click', () => {
        void post('/api/action', { key: 'use_model', row: model.id }).then(() => refresh())
      })
      return option
    })

    const rest = document.createElement('button')
    rest.type = 'button'
    rest.className = 'more'
    rest.textContent =
      models.length > MODELS ? `All ${String(models.length)} models` : 'Every model, with what each costs'
    rest.addEventListener('click', () => options.openControl('models'))

    modelDrop.replaceChildren(note, chosen, ...rows, rest)
    // A provider with no key publishes nothing here, so an empty list is a real answer.
    if (models.length === 0) {
      const none = document.createElement('p')
      none.className = 'drop-note'
      none.textContent = 'No provider is connected yet, so there is nothing to choose between. Add a key in Settings.'
      modelDrop.replaceChildren(none, rest)
    }
  }

  modelRow.addEventListener('click', () => {
    const opening = modelDrop.hidden
    modelDrop.hidden = !opening
    modelRow.setAttribute('aria-expanded', String(opening))
  })

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
    plugins.replaceChildren(
      ...panes.map((pane) => {
        const row = document.createElement('label')
        row.className = 'rail-row'
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
          void post('/api/plugin', { id: pane.id, action: box.checked ? 'enable' : 'disable' }).then(() => refresh())
        })
        row.append(what, box, track)
        row.classList.add('switch')
        return row
      }),
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
  }

  tabSetup.addEventListener('click', () => pick('setup'))
  tabPlugins.addEventListener('click', () => pick('plugins'))

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
    models = gotModels
    drawChats()
    drawModels()
    drawPlugins(gotPlugins.panes ?? [])
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

  return { refresh }
}
