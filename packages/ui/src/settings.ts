// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The settings screen: what first run asked, and every plugin's whole page (M2-1, M8-3, D118).
 *
 * **A plugin cannot style itself wrong because it never styles itself.** The widgets
 * themselves are drawn by `widgets.ts`, which the control surface uses as well — one
 * renderer, because two would drift on the day one of them was fixed. What lives here is the
 * screen around them: what is installed, what it asked for, and the lifecycle.
 *
 * **Settings is what you choose; Activity is what happened (D205).** Six pages: General (her
 * name and how she looks), Models & money, Safety, Skills, Plugins and About. Three of them
 * hold core's own sections — the ladder and the model table, the skills list, and the list
 * of every tool — declared in `panels.ts` with `screen: 'settings'` and drawn here by the
 * same renderer the Activity sheet uses. Plugins is a grid of cards, one per plugin,
 * and a page of its own behind every card. The list of panes it used to be worked at three
 * plugins and was a scroll at nine — a plugin's settings are the thing you came for, and
 * having to scroll past four other plugins' to reach them is the screen doing the finding
 * badly. Nothing here names a plugin: every card is whatever is in the folder.
 *
 * **And one plugin has one page (D118).** A plugin's `panel` used to be a tab on the control
 * surface, so its settings were here and the thing they drove was a screen away — two places
 * to look, and no way to guess which. The panel is drawn below the settings on this page now,
 * assembled from the same manifest by the same renderer, and the control surface is core's.
 *
 * No Node in here, ever (invariant 6).
 */

import { inApp, installUpdate, updateAvailable, type Update } from './desktop.js'
import { arm, el, widget, type Rendered, type WidgetHost } from './widgets.js'

export type { Rendered } from './widgets.js'

export interface Pane {
  id: string
  name: string
  summary: string
  version: string
  license: string
  /** Whether the user has said yes to it (M2-5). Not enabled is where a plugin arrives. */
  enabled: boolean
  running: boolean
  /**
   * `'unhealthy'` when the supervisor switched it off after it kept stopping, with its sentence
   * for why in `reason`. Absent is every other state, including asleep between calls.
   */
  state?: 'unhealthy'
  reason?: string
  requires: { cap: string; why: string }[]
  settings: Rendered[]
  /** What it is *doing*, under the values that drive it. Absent unless it declared a panel. */
  panel?: { label: string; widgets: Rendered[] }
}

interface Problem {
  dir: string
  reason: string
}

/**
 * One row of the registry (M3-2). The bytes are elsewhere; this says where and what to check.
 *
 * **A *Coming soon* row carries only an id, a name and a sentence** (D204), so everything past
 * those is optional here: a placeholder has no version, no licence and no `requires`, and a
 * screen that assumed them printed *undefined · undefined* and threw on the click.
 */
interface Listing {
  id: string
  name: string
  summary: string
  version?: string
  license?: string
  author?: string
  signature?: string
  requires?: { cap: string; why: string }[]
  provides?: string[]
  installed: boolean
  coming_soon?: boolean
}

interface SkillListing {
  id: string
  name: string
  description: string
  license?: string
  author?: string
  installed: boolean
}

interface LibraryState {
  ok: boolean
  registry: string
  why?: string
  /** Whether a signature can be checked at all. False is shown, never quietly assumed fine. */
  verifying?: boolean
  plugins?: Listing[]
  skills?: SkillListing[]
  /** Withdrawn, and on this machine. The only revocations worth putting in front of anyone. */
  revoked?: { id: string; revoked_reason: string }[]
  /** Installed here, with a newer version out and loadable by this Alexia (M5-4). */
  updates?: { id: string; from: string; to: string }[]
  /** What this build is, so the sentence about a newer one can say what it is newer than. */
  app?: string
  /** How much of the shelf is out of reach until Alexia itself is updated (D118). */
  needsNewerApp?: { plugins: number; updates: number }
}

/**
 * Which page is on screen. A plugin's own page is a state of `plugins`, not a page of its own,
 * and `tools` is a way *in*: it opens Plugins with the Advanced fold open on the tool list.
 */
const PAGES = ['general', 'models', 'safety', 'skills', 'plugins', 'about', 'tools'] as const
export type SettingsPage = (typeof PAGES)[number]

/** Whether a palette hit or a rail button names a Settings page rather than an Activity tab. */
export const isSettingsPage = (page: string): page is SettingsPage => (PAGES as readonly string[]).includes(page)

/** One of core's sections (`/api/panels`), as much of it as this screen reads. */
interface Section {
  id: string
  label: string
  widgets?: Rendered[]
  screen?: 'settings'
}

export function mountSettings(token: string): {
  open: (page?: SettingsPage, filter?: string) => void
  /** A key or the keyless switch changed which models exist: draw Models & money again if it is open. */
  redrawModels: () => void
  /** Fed from `/api/state`, because the version and the update preference are core's answer. */
  about: (state: { app?: string; updates?: boolean }) => void
} {
  const view = document.querySelector<HTMLElement>('#settings')!
  /** Each page's element, by the name its tab carries in `data-page`. */
  const pages: Record<Exclude<SettingsPage, 'tools'>, HTMLElement> = {
    general: document.querySelector<HTMLElement>('#general')!,
    models: document.querySelector<HTMLElement>('#models-page')!,
    safety: document.querySelector<HTMLElement>('#safety-page')!,
    skills: document.querySelector<HTMLElement>('#skills-page')!,
    plugins: document.querySelector<HTMLElement>('#plugins-page')!,
    about: document.querySelector<HTMLElement>('#about-page')!,
  }
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('#settings-tabs [data-settings]')]
  /**
   * Where each of core's sections is drawn. A section with no place here is not drawn at all,
   * which is the honest failure for a section core added before this screen learned of it.
   */
  const places: Record<string, HTMLElement> = {
    models: document.querySelector<HTMLElement>('#models-core')!,
    skills: document.querySelector<HTMLElement>('#skills-core')!,
    tools: document.querySelector<HTMLElement>('#tools-core')!,
  }
  const advanced = document.querySelector<HTMLDetailsElement>('#plugins-advanced')!
  const adders = document.querySelector<HTMLElement>('#plugins-adding')!
  const grids = document.querySelector<HTMLElement>('#plugin-grids')!
  const sheet = document.querySelector<HTMLElement>('#plugin-detail')!
  const installed = document.querySelector<HTMLElement>('#bento')!
  const search = document.querySelector<HTMLInputElement>('#plugin-filter')!
  const broken = document.querySelector<HTMLElement>('#problems')!
  const skillsBroken = document.querySelector<HTMLElement>('#skills')!
  const toLearn = document.querySelector<HTMLElement>('#skills-library')!
  const shelf = document.querySelector<HTMLElement>('#library')!
  /** Which installed ids came from compatibility mode, so the page can say so (M3-6). */
  let unreviewed = new Set<string>()
  /** The last read of each list, so a redraw is a redraw rather than a second fetch. */
  let panes: Pane[] = []
  let listings: Listing[] = []
  /** Whose page is open. Undefined is the grid, and a plugin that goes takes it with it. */
  let chosen: string | undefined
  /** What each MCP server said it offers when it was added, for the page that asks to trust it. */
  let offers: Record<string, { name: string; description?: string }[]> = {}
  /**
   * The sentence an install ended on, kept for the page it opens. *Installed, signature
   * checked — read what it asked for, then enable it* is the instruction for that page, and it
   * was written into the card the redraw threw away.
   */
  let told: { id: string; text: string } | undefined

  /**
   * A POST, and an answer whatever happens to it.
   *
   * A request that never came back used to throw, and every button that had disabled itself
   * for the wait stayed disabled — the MCP *Add*, the card switch, *Install*. So a dropped
   * request is an ordinary refusal here, with a sentence, and the one `ok` check every caller
   * already makes is the whole of the handling.
   */
  const send = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-alexia-token': token },
        body: JSON.stringify(body),
      })
      return (await response.json()) as Record<string, unknown>
    } catch {
      const said = 'Alexia did not answer. She may not be running — try again in a moment.'
      return { ok: false, said, why: said }
    }
  }

  /**
   * What a widget on *this* screen needs: where an edit goes, and where a redraw comes from.
   *
   * `fresh` re-reads `/api/plugins` rather than caching, because the two things it is asked
   * for — a `progress` bar mid-call and a `password` that has just been set — are both cases
   * where the cached copy is the stale one by definition.
   */
  const host = (plugin: string): WidgetHost => ({
    plugin,
    screen: 'settings',
    send,
    // A plugin's widgets are only ever on its own page, which is the only thing on screen
    // when they are drawn — so a redraw looks there rather than anywhere a grid ever was.
    root: () => sheet,
    // Only ever asked for by a widget core marked `gates` — one whose value decides which
    // other widgets are on the page. Re-reads and draws the page again, which is the same
    // thing every other change of shape on this screen does.
    redraw: () => void load(),
    fresh: async () => {
      const state = (await (
        await fetch('/api/plugins', { headers: { 'x-alexia-token': token } })
      ).json()) as { panes: Pane[] }
      const found = state.panes.find((p) => p.id === plugin)
      // Both halves, because a redraw is asked for by key and the two lists are one
      // namespace (D86). Looking in only one of them would leave a `progress` bar declared
      // on the panel frozen while the download it is about is happening.
      return found === undefined ? [] : [...found.settings, ...(found.panel?.widgets ?? [])]
    },
  })

  async function load(): Promise<void> {
    const state = (await (
      await fetch('/api/plugins', { headers: { 'x-alexia-token': token } })
    ).json()) as {
      panes: Pane[]
      problems: Problem[]
      unreviewed?: string[]
      offers?: Record<string, { name: string; description?: string }[]>
    }
    unreviewed = new Set(state.unreviewed ?? [])
    offers = state.offers ?? {}
    panes = state.panes
    draw(state.problems)
    // The skills that did not load are rows in core's skills list, marked ▲ with the reason
    // (D205), so this page no longer draws a second list of them.
    skillsBroken.replaceChildren()
    // The registry is a network call and the installed list is not. Drawn separately so a
    // registry that is down never stops somebody reaching the plugins they already have.
    void loadLibrary()
  }

  // ---- the pages ---------------------------------------------------------------------------

  /** Which page is showing, so a redraw asked for from outside knows whether it is on screen. */
  let showing: Exclude<SettingsPage, 'tools'> = 'general'

  function pick(page: Exclude<SettingsPage, 'tools'>): void {
    showing = page
    for (const [name, element] of Object.entries(pages)) element.hidden = name !== page
    for (const tab of tabs) {
      const on = tab.dataset.settings === page
      tab.classList.toggle('on', on)
      tab.setAttribute('aria-current', on ? 'page' : 'false')
    }
    view.scrollTop = 0
    // A page holding core's sections reads them again every time it is shown, never from an
    // earlier read: the Models slider and its switches are money, and a stale screen there
    // puts the slider back where it was and makes the next press send nothing (FINDINGS A).
    if (page === 'models') void drawSection('models')
    if (page === 'skills') void drawSection('skills')
    if (page === 'plugins' && advanced.open) void drawSection('tools')
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      const page = tab.dataset.settings
      if (page !== undefined && isSettingsPage(page) && page !== 'tools') pick(page)
    })
  }

  // The tool list is drawn when the fold is opened rather than with the page, because nobody
  // who does not open it should pay for sixty rows they will never read.
  advanced.addEventListener('toggle', () => {
    if (advanced.open) void drawSection('tools')
  })

  /** Core's sections, read fresh. The same `/api/panels` the Activity sheet reads. */
  const sections = async (): Promise<Section[]> =>
    ((await (await fetch('/api/panels', { headers: { 'x-alexia-token': token } })).json()) as { tabs: Section[] }).tabs

  /** What the palette asked to be typed into the filter of the section it opened. */
  let seeded: { id: string; filter: string } | undefined

  /** The latest read per section, so a slow read cannot draw over a newer one. */
  const reading: Record<string, number> = {}

  /**
   * One of core's sections, into its place on this screen.
   *
   * **Drawn by the same function that draws a plugin's page and an Activity tab** — only the
   * host differs, and here it is nobody's plugin (`''`), so every press reaches core. The model
   * table goes behind a *See all models* fold under the controls: the slider and the lists
   * are what somebody came to change, and six hundred rows above them would push them away.
   */
  async function drawSection(id: string): Promise<void> {
    const place = places[id]
    if (place === undefined) return
    const mine = (reading[id] = (reading[id] ?? 0) + 1)
    let found: Section | undefined
    try {
      found = (await sections()).find((one) => one.id === id)
    } catch {
      place.replaceChildren(el('p', 'error', 'This could not be read. Alexia may not be running — try again in a moment.'))
      return
    }
    if (mine !== reading[id]) return
    const at: WidgetHost = {
      plugin: '',
      screen: 'section',
      send,
      root: () => place,
      fresh: async () => (await sections()).find((one) => one.id === id)?.widgets ?? [],
    }
    const drawn = (found?.widgets ?? []).map((declared) => ({ declared, element: widget(at, declared) }))
    if (id === 'models') {
      // The controls first, and every table behind one fold.
      const fold = el('details', 'advanced')
      fold.append(el('summary', undefined, 'See all models'))
      for (const one of drawn) if (one.declared.type === 'table') fold.append(one.element)
      place.replaceChildren(...drawn.filter((one) => one.declared.type !== 'table').map((one) => one.element), fold)
      if (seeded?.id === id) fold.open = true
    } else {
      place.replaceChildren(...drawn.map((one) => one.element))
    }
    if (drawn.length === 0) place.replaceChildren(el('p', 'hint', 'There is nothing here yet.'))

    // The palette found a thing on this section; typing its name into the filter is what
    // turns *the right page* into *the right row*. Spent once.
    if (seeded?.id === id) {
      const filter = place.querySelector<HTMLInputElement>('.table-filter')
      if (filter) {
        filter.value = seeded.filter
        filter.dispatchEvent(new Event('input'))
      }
      seeded = undefined
    }
  }

  /** Filtering is a redraw of what is already read — there is nothing here to fetch again. */
  search.addEventListener('input', () => draw())

  /** Every word typed, anywhere in the name or the sentence — not the words as one phrase. */
  const matches = (name: string, summary: string): boolean => {
    const text = `${name} ${summary}`.toLowerCase()
    return search.value.toLowerCase().split(/\s+/).filter(Boolean).every((word) => text.includes(word))
  }

  // ---- the grid ---------------------------------------------------------------------------

  /**
   * The switch, and the only thing on a card that is not the card.
   *
   * Everywhere else on a card is the way in to the plugin's own page, so the click handler
   * asks *what was pressed* rather than every control asking not to bubble — one rule, which
   * still holds on the day a card grows a second control.
   */
  function toggle(pane: Pane): HTMLElement {
    const row = el('label', 'switch')
    const box = el('input')
    box.type = 'checkbox'
    box.checked = pane.enabled
    box.setAttribute('aria-label', `Enable ${pane.name}`)
    const track = el('span', 'track')
    box.addEventListener('change', () => {
      box.disabled = true
      // On a card or at the top of the plugin's own page — the same switch in both places.
      const card = row.closest('.bento-card, .plugin-hero')
      card?.querySelector('.card-error')?.remove()
      void send('/api/plugin', { id: pane.id, action: box.checked ? 'enable' : 'disable' }).then(async (answer) => {
        box.disabled = false
        if (answer.ok !== true) {
          // Put the switch back where it really is, and say why on the card it is on.
          box.checked = !box.checked
          card?.append(el('p', 'error card-error', String(answer.said ?? 'That did not work.')))
          return
        }
        // The whole screen, because enabling one plugin can satisfy another's requirement.
        await load()
      })
    })
    row.append(box, track)
    return row
  }

  /** Name, what it does, whether it is here, and — when it is — the switch. */
  function card(
    what: {
      name: string
      summary: string
      version?: string
      license?: string
      installed: boolean
      coming_soon?: boolean
      state?: 'unhealthy'
    },
    controls: HTMLElement[],
    press: () => void,
  ): HTMLElement {
    const box = el('article', 'bento-card')
    const head = el('div', 'bento-head')
    const name = el('button', 'bento-open', what.name)
    name.type = 'button'
    head.append(name, ...controls)
    const foot = el('div', 'bento-foot')
    foot.append(
      what.coming_soon === true ? el('span', 'pill caution', 'Coming soon')
      // The one state on a card that is about something having gone wrong, so it is the one
      // said here rather than only on the page behind it.
      : what.state === 'unhealthy' ? el('span', 'pill danger', 'Switched off')
      : el('span', what.installed ? 'pill' : 'pill caution', what.installed ? 'installed' : 'not installed'),
    )
    // Only what the row actually says. A placeholder has neither, and a missing one is left
    // out rather than printed as a word nobody should ever read.
    const meta = [what.version, what.license].filter((part): part is string => typeof part === 'string' && part !== '')
    if (meta.length > 0) foot.append(el('span', 'pane-meta', meta.join(' · ')))
    box.append(head, el('p', 'bento-what', what.summary), foot)
    box.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('.switch') === null) press()
    })
    return box
  }

  /**
   * One plugin's page, opened from its card. Focus goes to its heading: the card that had it
   * is gone from the screen, and focus left on nothing starts somebody's Tab again from the top.
   */
  function openPage(id: string): void {
    chosen = id
    arriving = true
    draw()
    sheet.querySelector<HTMLElement>('.pane-head h3')?.focus()
  }

  function draw(problems?: Problem[]): void {
    // A plugin whose folder has gone takes its page with it — the same line the control
    // surface has for a tab, one screen over, and for the same reason.
    if (chosen !== undefined && !panes.some((pane) => pane.id === chosen)) chosen = undefined

    grids.hidden = chosen !== undefined
    sheet.hidden = chosen === undefined
    if (chosen !== undefined) {
      drawPage(panes.find((pane) => pane.id === chosen)!)
      return
    }

    const shown = panes.filter((pane) => matches(pane.name, pane.summary))
    /**
     * What is not here, in the same grid as what is (D120).
     *
     * It used to be a collapsed `details` under the grid, on the argument that this screen is
     * where somebody comes to change something they *have*, and a page opening on forty things
     * they do not is a shop. The argument was sound and the placement was still wrong: the
     * first person to delete a plugin and want it back could not find where plugins come from,
     * which is the one journey that starts on this screen and cannot be completed anywhere
     * else. Dimmed and labelled costs nothing at eleven plugins, and if the shelf ever is
     * forty, the filter box above is already how somebody finds one.
     */
    const available = listings.filter((entry) => !entry.installed && matches(entry.name, entry.summary))
    installed.replaceChildren(
      ...shown.map((pane) =>
        card({ ...pane, installed: true }, [toggle(pane)], () => openPage(pane.id)),
      ),
      // A row of its own across the grid, so the dimming is explained rather than left to be
      // inferred — a card that is merely paler is a card somebody thinks is broken.
      ...(available.length > 0 ?
        [el('p', 'bento-label', available.length === 1 ? 'Not installed — one plugin you can add' : `Not installed — ${String(available.length)} plugins you can add`)]
      : []),
      ...available.map(offer),
    )
    if (panes.length === 0 && available.length === 0) {
      installed.append(el('p', 'hint', 'Nothing is installed yet, and the shelf could not be read. A folder on disk still works.'))
    } else if (shown.length === 0 && available.length === 0) {
      installed.append(el('p', 'hint', `Nothing matches “${search.value.trim()}”.`))
    }

    // A folder that is not a plugin is shown, never swallowed. Somebody put it there on
    // purpose and the reason it did not load is the only useful thing anyone can tell them.
    if (problems !== undefined) {
      broken.replaceChildren(...brokenRows(problems, 'One folder did not load', 'folders did not load'))
    }
  }

  // ---- what is not here yet ----------------------------------------------------------------

  /**
   * A card for something that is not here yet.
   *
   * **The question is asked on the card and answered beside it** — the same rule the chat
   * prompt and every `action` follow, because what is being decided is what is on screen. The
   * author's own `requires` sentences come with it, which is the whole reason the registry
   * carries them: deciding whether to want something should not require already having it.
   */
  function offer(entry: Listing): HTMLElement {
    const box: HTMLElement = card({ ...entry, installed: false }, [], () => {
      // Nothing to download yet, so there is no question to ask. The card already says so.
      if (entry.coming_soon === true) return
      if (box.querySelector('.confirm') !== null) return
      const asked = ask(entry)
      box.append(asked)
      // A question whose answer is below the fold is a question nobody answers.
      asked.scrollIntoView({ block: 'nearest' })
    })
    box.classList.add('dim')
    return box
  }

  function ask(entry: Listing): HTMLElement {
    const asked = el('div', 'confirm')
    asked.append(el('p', undefined, 'This plugin is not installed. Do you want to install it?'))

    const requires = entry.requires ?? []
    if (requires.length > 0) {
      const wants = el('ul', 'asks')
      for (const need of requires) {
        const line = el('li')
        line.append(el('code', undefined, need.cap), el('span', undefined, need.why))
        wants.append(line)
      }
      asked.append(el('p', 'asks-label', 'It will ask for:'), wants)
    }

    // Signed and checkable, signed and not checkable, not signed. Three states and three
    // sentences: an unverified signature is worth exactly as much as none, and a screen that
    // showed them alike would be the lie.
    if (entry.signature !== undefined && entry.signature !== '') {
      asked.append(
        library?.verifying === true ?
          el('span', 'pill', 'signed')
        : el('span', 'pill caution', 'signature not checked'),
      )
    }

    const said = el('p', 'hint')
    const row = el('div', 'row')
    const yes = el('button', undefined, 'Install')
    yes.type = 'button'
    const no = el('button', 'quiet-button', 'Not now')
    no.type = 'button'
    no.addEventListener('click', (event) => {
      event.stopPropagation()
      asked.remove()
    })
    yes.addEventListener('click', (event) => {
      event.stopPropagation()
      // Hidden, not removed: a download that fails has to be one press from trying again,
      // and the question it answered is still the right question.
      row.hidden = true
      // A bar that sweeps until the first bytes arrive, and a real one after. Silence is what
      // kills a first run rather than time (Alexia.md, first run).
      const bar = el('div', 'bar working')
      const fill = el('span')
      bar.append(fill)
      asked.append(bar)
      said.className = 'hint'
      said.textContent = `Downloading ${entry.name}…`
      const watching = window.setInterval(() => {
        void howFar(entry.id).then((far) => {
          if (far === undefined || !bar.isConnected) return
          // A size the server did not say keeps the sweep; only a real fraction is drawn as one.
          if (far.total > 0) {
            bar.classList.remove('working')
            fill.style.width = `${String(Math.round((far.done / far.total) * 100))}%`
          }
          said.textContent =
            far.total > 0 ?
              `Downloading ${entry.name}… ${String(Math.round((far.done / far.total) * 100))}%`
            : `Downloading ${entry.name}… ${(far.done / 1e6).toFixed(1)} MB`
        })
      }, 500)
      void fetchIn(entry.id, 'plugin', said).then((ok) => {
        window.clearInterval(watching)
        bar.remove()
        if (!ok) {
          yes.textContent = 'Try again'
          row.hidden = false
          return
        }
        // Installed and **not enabled** is where a plugin arrives (D73), so the next thing
        // on screen is its own page — which is the walkthrough, and where the yes is given.
        // A card that flipped itself on would be consent nobody gave.
        if (panes.some((pane) => pane.id === entry.id)) {
          told = { id: entry.id, text: said.textContent ?? '' }
          openPage(entry.id)
        }
      })
    })
    row.append(yes, no)
    asked.append(row, said)
    return asked
  }

  /** Install from the registry, then redraw everything — an install changes both lists. */
  const fetchIn = async (id: string, kind: 'plugin' | 'skill', said: HTMLElement): Promise<boolean> => {
    const answer = (await send('/api/library/install', { id, kind })) as { ok?: boolean; said?: string }
    said.className = answer.ok === true ? 'hint' : 'error'
    said.textContent = answer.said ?? (answer.ok === true ? '' : 'That did not install.')
    if (answer.ok === true) await load().catch(() => undefined)
    return answer.ok === true
  }

  /** How much of one download has arrived, or undefined before the first bytes or on no answer. */
  const howFar = async (id: string): Promise<{ done: number; total: number } | undefined> => {
    try {
      const far = (await (
        await fetch(`/api/library/progress?id=${encodeURIComponent(id)}`, { headers: { 'x-alexia-token': token } })
      ).json()) as { done?: number; total?: number }
      return typeof far.done === 'number' && far.done > 0 ? { done: far.done, total: far.total ?? 0 } : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Install: a folder somebody points at.
   *
   * Crude, and named as such — browsing the library is the route above, and this is the one
   * that still works when there is no registry. What it does is real: the folder is checked
   * where it stands, copied in, and left **not enabled**, so the next thing on the screen is
   * what it asked for.
   */
  function adding(): HTMLElement {
    const box = el('div', 'field installing')
    const row = el('div', 'row')
    const path = el('input')
    path.type = 'text'
    path.placeholder = 'The full path of a plugin folder'
    const add = el('button', 'quiet-button', 'Install')
    add.type = 'button'
    const said = el('p', 'hint')

    const install = async () => {
      if (add.disabled) return
      if (!path.value.trim()) {
        said.className = 'error'
        said.textContent = 'Type or paste the path of a plugin folder first.'
        return
      }
      add.disabled = true
      try {
        const answer = (await send('/api/install', { path: path.value.trim() })) as { ok?: boolean; said?: string }
        said.className = answer.ok === true ? 'hint' : 'error'
        said.textContent = answer.said ?? (answer.ok === true ? '' : 'That did not install.')
        if (answer.ok === true) {
          path.value = ''
          await load()
        }
      } finally {
        add.disabled = false
      }
    }
    add.addEventListener('click', () => void install())
    path.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void install()
    })

    row.append(path, add)
    box.append(el('label', undefined, 'Add a plugin from a folder'), row, said)
    return box
  }

  /**
   * The library (M3-2), the skills marketplace (M3-5) and compatibility mode (M3-6).
   *
   * Three ways something gets onto this machine. The plugins go into the grid above, because
   * from the user's side *what can Alexia do* and *what could it do* are one question asked
   * about one kind of thing. What stays down here is what is not a card: something withdrawn,
   * something with an update, a folder on disk, and an MCP server that is neither reviewed
   * nor ours. Skills are on the other page, because a skill is not a plugin.
   */
  async function loadLibrary(): Promise<void> {
    const answer = (await (
      await fetch('/api/library', { headers: { 'x-alexia-token': token } })
    ).json()) as LibraryState
    drawLibrary(answer)
  }

  /** The last library read, for the two sentences a card says about a signature. */
  let library: LibraryState | undefined

  /**
   * What to call the shelf on screen.
   *
   * `github:cr3studioo/Alexia` is how the source is stored and not a thing to put in front of
   * anybody: the two sentences it appears in are both about something having gone wrong or
   * being empty, which is exactly when a person wants somewhere they can go and look.
   */
  const named = (source: string): string =>
    source.startsWith('github:') ? `github.com/${source.slice('github:'.length)}` : source

  function drawLibrary(read: LibraryState): void {
    library = read
    listings = read.plugins ?? []
    // The grid holds the shelf now, so a library read is a redraw of it (D120).
    draw()
    shelf.replaceChildren()

    // Withdrawn, and on this machine. Loudest thing on the screen, above everything else,
    // because it is the one row here that is about something already running.
    for (const pulled of read.revoked ?? []) {
      const row = el('section', 'pane')
      row.append(
        el('b', undefined, `${pulled.id} has been withdrawn from the plugin list`),
        el('p', 'error', `${pulled.revoked_reason}. It is still installed here — disable or delete it on its own page.`),
      )
      shelf.append(row)
    }

    /**
     * Updates (M5-4), above the folder box because they are about something already here.
     *
     * Offered, not applied. An assistant that replaced a plugin's folder while somebody was
     * mid-conversation with it would be an assistant that changed under them, and the only
     * thing an update is allowed to be surprising about is that it exists.
     */
    for (const update of read.updates ?? []) {
      const box = el('section', 'pane')
      const said = el('p', 'hint')
      const get = el('button', 'quiet-button', `Update to ${update.to}`)
      get.type = 'button'
      get.addEventListener('click', () => {
        get.disabled = true
        said.className = 'hint'
        said.textContent = 'Downloading…'
        // The button's own label is the confirmation — it names the version it is replacing.
        void send('/api/library/install', { id: update.id, update: true, confirm: true })
          .then(async (answer) => {
            said.className = answer.ok === true ? 'hint' : 'error'
            said.textContent = String(answer.said ?? '')
            if (answer.ok === true) await load()
          })
          .finally(() => (get.disabled = false))
      })
      box.append(
        el('b', undefined, `${update.id} ${update.from} → ${update.to}`),
        // The sentence that makes an update safe to press: what it keeps.
        el('p', 'hint', 'Its settings and anything it has stored or downloaded are kept.'),
        get,
        said,
      )
      shelf.append(box)
    }

    /**
     * What this build cannot be offered (D118).
     *
     * A count and a reason, never a list of names. Naming plugins somebody cannot install is
     * a shop window for a shop that is shut — and the number is the part that is actionable,
     * because it is what turns *update Alexia* from housekeeping into something that gets
     * them a thing they want. It sits above the shelf for the same reason the update rows do:
     * it is about the state this machine is in, not about anything on offer.
     */
    const behind = read.needsNewerApp
    if (behind && behind.plugins + behind.updates > 0) {
      const count = (n: number, one: string, many: string): string =>
        n === 1 ? `one ${one}` : `${String(n)} ${many}`
      const parts = [
        behind.plugins > 0 ? count(behind.plugins, 'plugin', 'plugins') : '',
        behind.updates > 0 ? count(behind.updates, 'plugin update', 'plugin updates') : '',
      ].filter(Boolean)
      const box = el('section', 'pane')
      box.append(
        el('b', undefined, `${parts.join(' and ')} need a newer Alexia`),
        el(
          'p',
          'hint',
          `This is Alexia ${read.app ?? ''}. They are not shown below, because installing one would put a plugin here that cannot load. Alexia offers her own update when there is one.`,
        ),
      )
      shelf.append(box)
    }

    // A shelf that is down is not an empty shelf, and must not look like one.
    if (!read.ok) shelf.append(el('p', 'hint', read.why ?? `Could not reach ${named(read.registry)}.`))
    else if (listings.every((entry) => entry.installed || entry.coming_soon === true)) {
      shelf.append(el('p', 'hint', `Everything on ${named(read.registry)} is installed.`))
    }

    // Both behind *Advanced* (D205): they are for people who build plugins, and on the grid
    // they read like the way to get one, which is the shelf above.
    adders.replaceChildren(adding(), addingServer())
    drawOfferedSkills(read)
  }

  /**
   * Know-how, kept visibly apart from capability, and on the other page for the same reason.
   * Worst case here is bad advice; worst case on the Plugins page is anything this machine
   * can do.
   */
  function drawOfferedSkills(read: LibraryState): void {
    const available = (read.skills ?? []).filter((entry) => !entry.installed)
    toLearn.replaceChildren()
    if (available.length === 0) return
    toLearn.append(
      el('h3', 'step-heading', 'Skills to install'),
      el(
        'p',
        'hint',
        'A skill is instructions Alexia reads. It runs no code and adds nothing Alexia could not already do.',
      ),
    )
    for (const entry of available) {
      const box = el('section', 'pane')
      const head = el('div', 'pane-head')
      head.append(el('b', undefined, entry.name), el('span', 'pane-meta', entry.license ?? ''))
      const said = el('p', 'hint')
      const get = el('button', 'quiet-button', 'Install')
      get.type = 'button'
      get.addEventListener('click', () => {
        get.disabled = true
        said.className = 'hint'
        said.textContent = 'Downloading…'
        void fetchIn(entry.id, 'skill', said).finally(() => (get.disabled = false))
      })
      box.append(head, el('p', 'hint', entry.description), get, said)
      toLearn.append(box)
    }
  }

  /**
   * Compatibility mode (M3-6): any MCP server, as a tool source.
   *
   * Two fields, because that is all an MCP server is — a name and a command line. The
   * sentence under it is not decoration: what arrives this way is not an Alexia plugin,
   * nobody has reviewed it, and every tool on it is treated as destructive until somebody
   * says otherwise on its own page.
   */
  function addingServer(): HTMLElement {
    const box = el('div', 'field installing')
    box.append(el('label', undefined, 'Add an MCP server'))
    box.append(
      el(
        'p',
        'hint',
        'Any MCP server can be a tool source here. It is not an Alexia plugin and nobody has reviewed it, so Alexia asks before every one of its tools until you say otherwise.',
      ),
    )
    // Said before the press, not after it: the probe runs the program, and somebody pasting a
    // command from a web page should know that *Add* is when it runs.
    const runs = el('p', 'hint', 'Adding runs this command once to see what it offers.')
    const name = el('input')
    name.type = 'text'
    name.placeholder = 'A name, lowercase'
    const command = el('input')
    command.type = 'text'
    command.placeholder = 'The command and its arguments'
    const add = el('button', 'quiet-button', 'Add')
    add.type = 'button'
    const said = el('p', 'hint')

    const submit = async (): Promise<void> => {
      if (add.disabled) return
      // Split on whitespace, which is what a person pastes. Quoting is a shell's job and
      // there is no shell here — core spawns the program directly.
      const words = command.value.trim().split(/\s+/).filter(Boolean)
      if (!name.value.trim() || words.length === 0) {
        said.className = 'error'
        said.textContent =
          !name.value.trim() && words.length === 0 ? 'Give it a name and the command that starts it.'
          : !name.value.trim() ? 'Give it a name first — lowercase letters, digits and hyphens.'
          : 'Type the command that starts it.'
        return
      }
      add.disabled = true
      said.className = 'hint'
      said.textContent = 'Starting it once to see what it is…'
      try {
        const answer = (await send('/api/server', {
          id: name.value.trim(),
          run: words[0],
          args: words.slice(1),
        })) as { ok?: boolean; said?: string }
        said.className = answer.ok === true ? 'hint' : 'error'
        said.textContent = answer.said ?? (answer.ok === true ? '' : 'That did not work.')
        if (answer.ok === true) {
          name.value = ''
          command.value = ''
          await load()
        }
      } finally {
        add.disabled = false
      }
    }
    add.addEventListener('click', () => void submit())
    // Enter in either box is the same as pressing Add, as it is in the folder box above.
    for (const input of [name, command]) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') void submit()
      })
    }

    const row = el('div', 'row')
    row.append(name, command, add)
    box.append(runs, row, said)
    return box
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

  // ---- one plugin's own page ----------------------------------------------------------------

  /**
   * The pill beside a plugin's name: its class and its word.
   *
   * *Stopped* was the word for two different things — asleep between calls, which is how a
   * healthy plugin spends most of its time under lazy spawn, and switched off after crashing,
   * which needs somebody to press Restart. They are *Ready* and *Switched off* now, and only
   * the second is coloured, because only the second needs anything done.
   */
  const state = (pane: Pane): [string, string] =>
    !pane.enabled ? ['pill caution', 'Off']
    : pane.state === 'unhealthy' ? ['pill danger', 'Switched off']
    : pane.running ? ['pill', 'Running']
    : ['pill', 'Ready']

  /** Widgets that are something to look at rather than a value to set. */
  const SHOWN: ReadonlySet<string> = new Set(['table', 'cards', 'tree', 'graph', 'image', 'ladder'])

  /**
   * One plugin's widgets, sorted into the same places on every page.
   *
   * **Where a thing is should not depend on who wrote the plugin.** Drawn in manifest order, a
   * key was the first field on one page and the last on another, the *State* line sat between
   * two switches, and *Forget everything* was a field like any other — so every plugin's page
   * had to be learned on its own. Core sorts by what a widget *is*, which it knows and a plugin
   * cannot get wrong: readings at the top, keys in one place, the values it runs on, the
   * buttons after them, then what it is doing.
   *
   * **Order inside each place is still the author's.** A field and the button that uses it stay
   * one after the other, and the panel — which is a workflow, *search, hear, keep* — is not
   * sorted at all beyond its keys leaving it, so a hint saying *above* is still right there.
   */
  function sort(pane: Pane): {
    readings: Rendered[]
    keys: Rendered[]
    values: Rendered[]
    actions: Rendered[]
    shown: Rendered[]
  } {
    const panel = pane.panel?.widgets ?? []
    return {
      readings: pane.settings.filter((w) => w.type === 'status' || w.type === 'progress'),
      keys: [...pane.settings, ...panel].filter((w) => w.type === 'password'),
      values: pane.settings.filter(
        (w) => !SHOWN.has(w.type) && !['status', 'progress', 'password', 'action'].includes(w.type),
      ),
      actions: pane.settings.filter((w) => w.type === 'action'),
      shown: [...pane.settings.filter((w) => SHOWN.has(w.type)), ...panel.filter((w) => w.type !== 'password')],
    }
  }

  /**
   * One block of a plugin's page: a small name over a raised surface, set in a quieter tray.
   * The name is what somebody scans for, so it is the same word on every plugin that has one.
   */
  function block(name: string | undefined, className: string, ...children: HTMLElement[]): HTMLElement {
    const tray = el('section', `plugin-block ${className}`)
    if (name !== undefined) {
      tray.append(el('h4', 'plugin-eyebrow', name))
      tray.dataset.jump = name
      tray.dataset.icon =
        className.startsWith('notice') ? 'notice'
        : className === 'values' && name === 'Actions' ? 'actions'
        : className
    }
    const core = el('div', 'plugin-block-core')
    core.append(...children)
    tray.append(core)
    return tray
  }

  /** Whether the page being drawn was just opened, so it arrives rather than blinks on a redraw. */
  let arriving = false

  /**
   * One plugin, in whichever of its two states it is in (M2-5) — and on a page of its own.
   *
   * **Off is the walkthrough**: the summary, then what it asks for in its author's own words,
   * then one button. Its settings are not drawn, because configuring something you have not
   * agreed to run is a screen asking two questions at once — the order is turn on, then set up.
   *
   * **On is the whole plugin, and this is the only page there is of it (D118)**, in the same
   * shape for every plugin: the name with its switch, what it is doing right now, its keys,
   * its settings and its buttons, what it has made, and — folded away — what it may reach and
   * the way to remove it.
   */
  function drawPage(pane: Pane): void {
    const back = el('button', 'quiet-button plugin-back', '← All plugins')
    back.type = 'button'
    back.addEventListener('click', () => {
      spying?.disconnect()
      chosen = undefined
      told = undefined
      draw()
      // And back to the card it was opened from, rather than to nothing.
      const cards = [...installed.querySelectorAll<HTMLElement>('.bento-open')]
      cards.find((one) => one.textContent === pane.name)?.focus()
    })

    // The name, the one word for its state, and the one switch — the same switch its card has,
    // so on and off is in one place on both screens and never a button at the foot of a page.
    const hero = el('header', 'plugin-hero')
    const head = el('div', 'pane-head')
    const heading = el('h3', 'step-heading', pane.name)
    heading.tabIndex = -1
    head.append(heading, el('span', ...state(pane)))
    const words = el('div', 'plugin-hero-words')
    words.append(head, el('p', 'plugin-summary', pane.summary))
    // What the install ended on — *read what it asked for, then turn it on* is about this page.
    if (told?.id === pane.id && told.text !== '') words.append(el('p', 'hint', told.text))
    hero.append(words, toggle(pane))

    const box = el('div', 'plugin-page')
    if (arriving) box.classList.add('arriving')
    arriving = false
    box.append(back, hero)

    const { readings, keys, values, actions, shown } = sort(pane)

    // What it is doing right now, as a row of readings under the name — the first thing anybody
    // opening a plugin wants to know, and the thing that was the last line of most pages.
    if (pane.enabled && readings.length > 0) {
      const strip = el('div', 'plugin-readings')
      strip.dataset.jump = 'Now'
      strip.dataset.icon = 'readings'
      for (const declared of readings) strip.append(widget(host(pane.id), declared))
      box.append(strip)
    }

    // Switched off by the supervisor (D204). The same box the board's page draws, because it
    // is the same plugin in the same state: the reason in the supervisor's words, and the one
    // press that clears it.
    if (pane.enabled && pane.state === 'unhealthy') {
      const restarted = el('p', 'hint')
      const again = el('button', undefined, 'Restart')
      again.type = 'button'
      again.addEventListener('click', () => {
        again.disabled = true
        void send('/api/plugin', { id: pane.id, action: 'restart' }).then(async (answer) => {
          again.disabled = false
          if (answer.ok !== true) {
            restarted.className = 'error'
            restarted.textContent = String(answer.said ?? 'That did not work.')
            return
          }
          await load()
        })
      })
      box.append(
        block(
          'Needs you',
          'notice danger',
          el('p', 'error', pane.reason ?? `${pane.name} kept stopping, so Alexia switched it off.`),
          again,
          restarted,
        ),
      )
    }

    // Compatibility mode (M3-6). The pill is not the whole of it: what matters is *what
    // Alexia does differently*, so the sentence says that, and the way out is a decision
    // with a person's hand on it rather than a setting that drifts.
    if (unreviewed.has(pane.id)) {
      head.append(el('span', 'pill caution', 'not reviewed'))
      box.append(block('Not reviewed', 'notice', ...unreviewedParts(pane)))
    }

    if (!pane.enabled) {
      // The walkthrough: what it will be able to do, in its author's words, then the yes.
      const parts: HTMLElement[] = [
        el(
          'p',
          'plugin-lead',
          pane.requires.length > 0 ?
            `${pane.name} is off. Read what it asks for, then turn it on to set it up.`
          : `${pane.name} is off. Turn it on to set it up.`,
        ),
      ]
      if (pane.requires.length > 0) parts.push(asks(pane))
      const on = el('button', 'begin', `Turn on ${pane.name}`)
      on.type = 'button'
      const said = el('p', 'hint')
      on.addEventListener('click', () => {
        on.disabled = true
        void send('/api/plugin', { id: pane.id, action: 'enable' }).then(async (answer) => {
          on.disabled = false
          if (answer.ok !== true) {
            said.className = 'error'
            said.textContent = String(answer.said ?? 'That did not work.')
            return
          }
          told = undefined
          await load()
        })
      })
      parts.push(on, said)
      box.append(block('Before you turn it on', 'consent', ...parts))
    } else {
      // Keys in one place, wherever the author declared them — a key is the thing somebody
      // arrives holding, and it was the first field on one page and the last on another.
      if (keys.length > 0) {
        box.append(
          block(
            keys.length === 1 ? 'Key' : 'Keys',
            'keys',
            ...keys.map((declared) => widget(host(pane.id), declared)),
          ),
        )
      }
      // What it runs on, then what can be pressed. The buttons get a row of their own under a
      // rule, so *Forget everything* no longer reads as one more field to fill in.
      if (values.length > 0 || actions.length > 0) {
        const parts = values.map((declared) => widget(host(pane.id), declared))
        if (actions.length > 0) {
          const row = el('div', 'plugin-actions')
          for (const declared of actions) row.append(widget(host(pane.id), declared))
          parts.push(row)
        }
        box.append(block(values.length > 0 ? 'Settings' : 'Actions', 'values', ...parts))
      }
      // What it is doing and what it has made. Named by the author only where the author called
      // it something the page has not said yet — *Voice* under *Voice* marks nothing.
      if (shown.length > 0) {
        const label = pane.panel?.label
        box.append(
          block(
            label !== undefined && label !== pane.name ? label : 'In use',
            'plugin-panel',
            ...shown.map((declared) => widget(host(pane.id), declared)),
          ),
        )
      }
    }

    box.append(foot(pane))
    // The strip goes in last, once it is known what there is to jump to, and sits under the name.
    const strip = jumps(box)
    if (strip !== undefined) hero.after(strip)
    sheet.replaceChildren(box)
    view.scrollTop = 0
  }

  /**
   * Thin line icons for the section strip, one per kind of block. The same stroke the rail's
   * switches are drawn in, so the two sets read as one hand.
   */
  const JUMP_ICONS: Record<string, string> = {
    readings: 'M3 12h4l2-5 4 10 2-5h6',
    keys: 'M4.5 12a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0M11.5 12h9v3M17 12v2.5',
    values: 'M4 7h9M17 7h3M4 17h4M12 17h8M13 7a2 2 0 1 0 4 0a2 2 0 1 0-4 0M8 17a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
    actions: 'M13 3 5 14h6l-1 7 8-11h-6z',
    'plugin-panel': 'M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM13.5 13.5h6v6h-6z',
    consent: 'M12 3.5l7 3v5c0 4.2-2.9 7.5-7 9-4.1-1.5-7-4.8-7-9v-5zM9 12l2 2 4-4',
    notice: 'M12 4 21 19.5H3zM12 10v4.5M12 17h.01',
    about: 'M3.5 12a8.5 8.5 0 1 0 17 0a8.5 8.5 0 1 0-17 0M12 11v5M12 8h.01',
  }

  const jumpIcon = (kind: string): SVGSVGElement => {
    const ns = 'http://www.w3.org/2000/svg'
    const icon = document.createElementNS(ns, 'svg')
    icon.setAttribute('viewBox', '0 0 24 24')
    icon.setAttribute('width', '16')
    icon.setAttribute('height', '16')
    icon.setAttribute('aria-hidden', 'true')
    const path = document.createElementNS(ns, 'path')
    path.setAttribute('d', JUMP_ICONS[kind] ?? JUMP_ICONS.values!)
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', 'currentColor')
    path.setAttribute('stroke-width', '1.6')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    icon.append(path)
    return icon
  }

  /** Watches which section is under the strip. One per page, so a redraw drops the last one. */
  let spying: IntersectionObserver | undefined

  /**
   * The strip of sections under a plugin's name: scroll to one, or press it and go there.
   *
   * **Built from what the page actually drew**, so a plugin without keys has no Keys tab and
   * the strip can never offer a place that is not there. Fewer than three places is no strip:
   * two tabs for a page that fits on one screen is chrome with nothing to do.
   *
   * The tab that is lit follows the reading position through an `IntersectionObserver` on a
   * band across the top of the screen — never a scroll listener — and a press lights its tab
   * at once rather than waiting for the smooth scroll to arrive and flicker past the others.
   */
  function jumps(page: HTMLElement): HTMLElement | undefined {
    spying?.disconnect()
    spying = undefined
    const targets = [...page.children].filter((one): one is HTMLElement => one instanceof HTMLElement && one.dataset.jump !== undefined)
    if (targets.length < 3) return undefined

    const strip = el('nav', 'plugin-jump')
    strip.setAttribute('aria-label', 'Sections of this plugin')
    const tabs = new Map<HTMLElement, HTMLButtonElement>()
    let held = 0
    const light = (target: HTMLElement): void => {
      for (const [at, tab] of tabs) {
        const on = at === target
        tab.classList.toggle('on', on)
        if (on) tab.setAttribute('aria-current', 'location')
        else tab.removeAttribute('aria-current')
      }
      // Keep the lit tab in view when the strip itself is wider than the screen.
      const tab = tabs.get(target)
      if (tab && strip.scrollWidth > strip.clientWidth) {
        strip.scrollTo({ left: tab.offsetLeft - strip.clientWidth / 2 + tab.offsetWidth / 2, behavior: 'smooth' })
      }
    }

    for (const target of targets) {
      const name = target.dataset.jump!
      const tab = el('button', 'jump')
      tab.type = 'button'
      tab.title = name
      tab.append(jumpIcon(target.dataset.icon ?? ''), el('span', 'jump-name', name))
      tab.addEventListener('click', () => {
        // The foot is a fold: going there means opening it, or the press lands on one line.
        if (target instanceof HTMLDetailsElement) target.open = true
        held = Date.now() + 900
        light(target)
        const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
        target.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' })
      })
      tabs.set(target, tab)
      strip.append(tab)
    }
    light(targets[0]!)

    if (typeof IntersectionObserver !== 'undefined') {
      const seen = new Set<HTMLElement>()
      spying = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) seen.add(entry.target as HTMLElement)
            else seen.delete(entry.target as HTMLElement)
          }
          if (Date.now() < held) return
          const first = targets.find((one) => seen.has(one))
          if (first) light(first)
        },
        // The top part of the screen, under the strip: whatever is there is being read.
        { root: view, rootMargin: '-15% 0px -55% 0px' },
      )
      for (const target of targets) spying.observe(target)
    }
    return strip
  }

  /** What the author asked for, in the author's own words. Core never rewrites or summarises it. */
  function asks(pane: Pane): HTMLElement {
    const wants = el('ul', 'asks')
    for (const need of pane.requires) {
      const row = el('li')
      row.append(el('code', undefined, need.cap), el('span', undefined, need.why))
      wants.append(row)
    }
    return wants
  }

  /** An MCP server's notice: what it is, what it offers, and the two-press way to trust it. */
  function unreviewedParts(pane: Pane): HTMLElement[] {
    const parts: HTMLElement[] = [
      el(
        'p',
        'hint',
        'This came from an MCP server, not the Alexia plugin list. Nobody here has reviewed it, so every tool it offers is treated as if it changes things — Alexia asks first, in every mode but Full trust.',
      ),
    ]
    // What it said it offers, from the probe that added it — the thing the button below
    // claims somebody has read. A trust button with nothing above it to read was a button
    // asking to be pressed on faith.
    const tools = offers[pane.id]
    if (tools !== undefined && tools.length > 0) {
      const list = el('ul', 'asks')
      for (const tool of tools) {
        const line = el('li')
        line.append(el('code', undefined, tool.name), el('span', undefined, tool.description ?? ''))
        list.append(line)
      }
      parts.push(el('p', 'asks-label', tools.length === 1 ? 'It offers one tool:' : `It offers ${String(tools.length)} tools:`), list)
    } else if (tools !== undefined) {
      parts.push(el('p', 'hint', 'It said it offers no tools.'))
    } else {
      parts.push(el('p', 'hint', 'Alexia did not keep what it offers when it was added. Delete it and add it again to see the list here.'))
    }
    const trusted = el('p', 'hint')
    const trust = el('button', 'quiet-button trust-it', 'I have read what it does — trust it')
    trust.type = 'button'
    // Two presses, like Delete: this changes how every one of its tools is treated, now and
    // after it grows new ones, and one stray click should not be able to say that.
    arm(
      trust,
      'Press again to trust it',
      () => {
        trust.disabled = true
        void send('/api/server', { id: pane.id, action: 'trust', confirm: true }).then(async (answer) => {
          trust.disabled = false
          if (answer.ok !== true) {
            trusted.className = 'error'
            trusted.textContent = String(answer.said ?? 'That did not work.')
            return
          }
          await load()
        })
      },
      {
        onArm: () => {
          trusted.className = 'hint'
          trusted.textContent = 'After this, Alexia stops asking before its tools that say they only read.'
        },
        onDisarm: () => (trusted.textContent = ''),
      },
    )
    parts.push(trust, trusted)
    return parts
  }

  /**
   * The foot of the page, folded: which version, what it may reach, and Delete.
   *
   * **Off is the switch at the top; Delete is down here, behind a fold and a second press**
   * that says what goes. Not caution for its own sake: switching off is reversible and costs
   * nothing, and delete takes the twenty-minute download with it. What it may reach is here
   * rather than above once it is on — it was read before the yes, and it is looked up rather
   * than read every visit.
   */
  function foot(pane: Pane): HTMLElement {
    const fold = el('details', 'advanced plugin-about')
    fold.dataset.jump = 'About'
    fold.dataset.icon = 'about'
    fold.append(el('summary', undefined, 'About this plugin'))
    fold.append(el('p', 'pane-meta', `Version ${pane.version} · ${pane.license}`))
    if (pane.enabled && pane.requires.length > 0) {
      fold.append(el('p', 'asks-label', 'What it may reach:'), asks(pane))
    }

    const said = el('p', 'hint')
    // Two presses, and the second one has already said what it is about to take. `arm` is
    // what makes the second press a second decision: one in the first second is ignored, so a
    // double-click no longer deletes, and it goes back to plain *Delete* after five.
    const remove = el('button', 'quiet-button danger-button', 'Delete')
    remove.type = 'button'
    arm(
      remove,
      'Delete for good',
      () => {
        remove.disabled = true
        // Delete is guarded on the wire (M6-1) and the second press is what carries the yes.
        // Two separate things saying the same word: the button, because a person can misclick,
        // and `confirm`, because core refuses a purge that nobody said out loud — including
        // one asked for by something that never read this file.
        void send('/api/plugin', { id: pane.id, action: 'delete', confirm: true })
          .then(async (answer) => {
            if (answer.ok !== true) {
              said.className = 'error'
              said.textContent = String(answer.said ?? 'That did not work.')
              return
            }
            // Deleting one takes its bundled skills with it, and a plugin that has gone has no
            // page — `draw` drops the selection rather than leaving a page about nothing.
            chosen = undefined
            told = undefined
            await load()
          })
          .finally(() => (remove.disabled = false))
      },
      {
        onArm: () => {
          said.className = 'hint'
          said.textContent = `This removes ${pane.name}, its settings, anything it stored and anything it downloaded. Switching it off keeps all of it.`
        },
        onDisarm: () => {
          said.textContent = ''
        },
      },
    )
    const row = el('div', 'lifecycle')
    row.append(remove, said)
    fold.append(row)
    return fold
  }

  // ---- About (D121) -----------------------------------------------------------------------

  /**
   * What this is, who made it, and the one decision about updating that is a person's to take.
   *
   * **The page exists because "which version am I running" had no answer on screen.** It was
   * in the binary, in the release notes and in an error message about plugins needing a newer
   * Alexia, and nowhere a person would look — so the first line of this page is the number,
   * read from `/api/state` rather than from the shelf, because the network being down is
   * exactly when somebody asks.
   *
   * **Three separate things, said as three things.** *Check now* asks GitHub this second, for
   * somebody who has heard there is a release and does not want to restart to find out.
   * *Update now* appears only when there is one. The switch governs **looking**, not
   * installing — nothing here has ever installed itself without a press, and the sentence
   * under the switch says which of the two it is turning off, because "auto-update" is a
   * phrase people reasonably read as *it will change under me*.
   */
  function mountAbout(): { show: (state: { app?: string; updates?: boolean }) => void } {
    const version = document.querySelector<HTMLElement>('#about-version')!
    const said = document.querySelector<HTMLElement>('#about-update-said')!
    const check = document.querySelector<HTMLButtonElement>('#check-updates')!
    const take = document.querySelector<HTMLButtonElement>('#take-update')!
    const auto = document.querySelector<HTMLInputElement>('#auto-updates')!
    const autoRow = document.querySelector<HTMLElement>('#auto-updates-row')!
    const autoHint = document.querySelector<HTMLElement>('#auto-updates-hint')!
    let found: Update | undefined

    /** The whole update block is about a program replacing itself, which a browser tab cannot. */
    const desktop = inApp()

    const offer = (update: Update | undefined, checked: boolean): void => {
      found = update
      take.hidden = update === undefined
      said.className = 'hint'
      said.textContent =
        update ? `Alexia ${update.version} is available. You have ${update.currentVersion}.`
        : checked ? 'This is the newest version.'
        : ''
    }

    check.addEventListener('click', () => {
      check.disabled = true
      said.className = 'hint'
      said.textContent = 'Asking GitHub…'
      void updateAvailable()
        .then((update) => offer(update, true))
        .finally(() => (check.disabled = false))
    })

    take.addEventListener('click', () => {
      if (!found) return
      take.disabled = true
      void installUpdate(found.rid, (done, total) => {
        said.textContent =
          total !== undefined && total > 0 ?
            `Downloading… ${String(Math.round((done / total) * 100))}%`
          : `Downloading… ${String(Math.round(done / 1e6))} MB`
      })
        // No success branch: the installer replaces this program and the window goes with it.
        .catch((error: unknown) => {
          said.className = 'error'
          said.textContent = `The update did not go through: ${error instanceof Error ? error.message : String(error)}. The releases page above has the installer.`
          take.disabled = false
        })
    })

    auto.addEventListener('change', () => {
      autoHint.textContent = wording(auto.checked)
      void send('/api/setup', { updates: auto.checked })
    })

    const wording = (on: boolean): string =>
      on ?
        'Alexia checks once, at startup, and shows a strip if there is something newer. She never installs anything on her own; you press Update now.'
      : 'Alexia will not look on her own. You stay on this version until you press Check now.'

    return {
      show: (state) => {
        version.textContent = state.app ?? '—'
        auto.checked = state.updates !== false
        autoHint.textContent = wording(auto.checked)
        if (!desktop) {
          // In a browser there is no program to replace, and a dead button is worse than none.
          check.hidden = true
          take.hidden = true
          autoRow.hidden = true
          autoHint.textContent = ''
          said.textContent = 'Alexia updates itself in the desktop app. This is a browser tab, so there is nothing here to replace.'
          return
        }
        offer(undefined, false)
      },
    }
  }

  const about = mountAbout()

  return {
    about: about.show,
    redrawModels: () => {
      if (showing === 'models' && !view.hidden) void drawSection('models')
    },
    open: (page?: SettingsPage, filter?: string) => {
      view.scrollTop = 0
      // The palette found a plugin and this is the page it lives on; typing its name into
      // the filter is what turns *the right page* into *the right card*. On a page holding
      // one of core's sections it goes into that section's own filter instead.
      if (page === 'plugins' && filter !== undefined) search.value = filter
      else if (page !== undefined && filter !== undefined && filter !== '' && page in places) seeded = { id: page, filter }
      if (page === 'tools') {
        // The tool list lives in Plugins > Advanced, so that is what opens — the fold's own
        // `toggle` draws it, and a fold already open is drawn again by `pick`.
        chosen = undefined
        advanced.open = true
        pick('plugins')
      } else if (page !== undefined) {
        // Coming in from outside lands on the grid, never on whichever page was open last.
        if (page === 'plugins') chosen = undefined
        pick(page)
      } else pick(showing)
      void load()
    },
  }
}
