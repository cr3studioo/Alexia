// SPDX-License-Identifier: AGPL-3.0-only
import { el, widget, type Rendered, type WidgetHost } from './widgets.js'

/**
 * The control surface (M6-2): what has this been doing, what did I say yes to, what does it
 * know, which of these did I install.
 *
 * **Nothing in this file names a tab.** The strip is whatever `/api/panels` sends back, and
 * that is core's own tabs plus one for every enabled plugin that declared a panel in its
 * manifest. If you are about to type a plugin's name in here, you have found a missing
 * capability — the same rule M0 set for core, one screen later, and the one M6-G tests by
 * deleting a plugin folder with this screen open.
 *
 * No Node in here, ever (invariant 6).
 */

interface Tab {
  id: string
  label: string
  from: 'core' | 'plugin'
  plugin?: string
  /** A plugin tab: whether its process is up. Enabled and not running is normal. */
  running?: boolean
  widgets?: Rendered[]
  /** A core tab whose panel is not built yet: what it will hold, and which task builds it. */
  soon?: string
}

/** Below this, the strip is one button showing the active tab's name. */
const NARROW = 560

export function mountControl(token: string): { open: (tab?: string, filter?: string) => void } {
  const view = document.querySelector<HTMLElement>('#control')!
  const strip = document.querySelector<HTMLElement>('#tabs')!
  const current = document.querySelector<HTMLButtonElement>('#tab-current')!
  const body = document.querySelector<HTMLElement>('#panel')!

  /** Which tab is open, by id. Kept across redraws — and dropped when the tab is. */
  let chosen: string | undefined
  let tabs: Tab[] = []

  const send = async (path: string, request: unknown): Promise<Record<string, unknown>> =>
    (await (
      await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-alexia-token': token },
        body: JSON.stringify(request),
      })
    ).json()) as Record<string, unknown>

  const read = async (): Promise<Tab[]> =>
    ((await (await fetch('/api/panels', { headers: { 'x-alexia-token': token } })).json()) as { tabs: Tab[] }).tabs

  /** What the palette asked to be typed into the first filter on the panel it opened. */
  let seeded: string | undefined

  async function load(): Promise<void> {
    tabs = await read()
    // A tab that has gone takes the selection with it. This is the line M6-G is about: a
    // plugin deleted while this screen is open leaves nothing behind to select.
    if (chosen !== undefined && !tabs.some((tab) => tab.id === chosen)) chosen = undefined
    chosen ??= tabs[0]?.id
    draw()
  }

  /**
   * What a widget on *this* screen needs.
   *
   * `fresh` re-reads the whole tab list, because the two things it is asked for — a
   * `progress` bar mid-call and a `password` that has just been set — are exactly the cases
   * where anything cached is stale by definition.
   */
  const host = (plugin: string): WidgetHost => ({
    plugin,
    screen: 'panel',
    send,
    root: () => body,
    fresh: async () =>
      (await read()).find((tab) => (plugin === '' ? tab.id === chosen : tab.plugin === plugin))?.widgets ?? [],
  })

  function draw(): void {
    const open = tabs.find((tab) => tab.id === chosen)

    strip.replaceChildren(
      ...tabs.map((tab) => {
        const button = el('button', tab.id === chosen ? 'tab on' : 'tab', tab.label)
        button.type = 'button'
        button.setAttribute('aria-current', tab.id === chosen ? 'page' : 'false')
        button.addEventListener('click', () => {
          chosen = tab.id
          strip.dataset.open = 'false'
          draw()
        })
        return button
      }),
    )

    // Narrow (D67's viewport, and the old dashboard's own lesson): the strip is replaced by
    // the active tab's name, and tapping that name is what opens the list.
    const narrow = window.innerWidth < NARROW
    current.hidden = !narrow
    current.textContent = open ? `${open.label} ▾` : ''
    current.setAttribute('aria-expanded', strip.dataset.open === 'true' ? 'true' : 'false')
    strip.hidden = narrow && strip.dataset.open !== 'true'

    body.replaceChildren(...(open ? panel(open) : [el('p', 'hint', 'There is nothing here yet.')]))

    // The palette found a thing and opened the tab it lives on; typing its name into the
    // filter is what turns *the right tab* into *the right row*. Spent once, so switching
    // tabs afterwards does not carry somebody's old search with them.
    if (seeded !== undefined) {
      const filter = body.querySelector<HTMLInputElement>('.table-filter')
      if (filter) {
        filter.value = seeded
        filter.dispatchEvent(new Event('input'))
      }
      seeded = undefined
    }
  }

  /**
   * One tab's contents.
   *
   * **Core's tabs and a plugin's go through the same function**, which is the whole of what
   * M6-4 was watching for: if either had needed a line of its own here, `table` would have
   * been the wrong widget. Neither did. The only difference between them is whose name goes
   * on the requests the widgets make, and for core's own that name is nobody's.
   */
  function panel(tab: Tab): HTMLElement[] {
    if (tab.soon !== undefined) return [el('p', 'hint', tab.soon)]

    const drawn: HTMLElement[] = []
    // Enabled and not running is the ordinary state under lazy spawn, and it reads as one
    // rather than as a warning — a tab that looked broken whenever nothing had called the
    // plugin lately would teach people to ignore the one that is actually broken.
    if (tab.running === false) drawn.push(el('p', 'hint', 'Not running. It starts when something needs it.'))

    const at = host(tab.plugin ?? '')
    drawn.push(...(tab.widgets ?? []).map((declared) => widget(at, declared)))
    return drawn
  }

  current.addEventListener('click', () => {
    strip.dataset.open = strip.dataset.open === 'true' ? 'false' : 'true'
    draw()
  })

  // The strip has to be able to change shape without a reload: the overlay and the window
  // are two different widths of the same page (M5-2).
  window.addEventListener('resize', () => {
    if (view.checkVisibility()) draw()
  })

  return {
    open: (tab?: string, filter?: string) => {
      view.scrollTop = 0
      if (tab !== undefined) chosen = tab
      seeded = filter
      void load()
    },
  }
}
