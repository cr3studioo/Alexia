// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The settings screen: what first run asked, and every plugin's chrome (M2-1, M8-3).
 *
 * **A plugin cannot style itself wrong because it never styles itself.** The widgets
 * themselves are drawn by `widgets.ts`, which the control surface uses as well — one
 * renderer, because two would drift on the day one of them was fixed. What lives here is the
 * screen around them: what is installed, what it asked for, and the lifecycle.
 *
 * **Two pages and one card each behind them (M8-3).** General is the three questions first
 * run asked plus the know-how on this machine; Plugins is a grid of cards, one per plugin,
 * and a page of its own behind every card. The list of panes it used to be worked at three
 * plugins and was a scroll at nine — a plugin's settings are the thing you came for, and
 * having to scroll past four other plugins' to reach them is the screen doing the finding
 * badly. Nothing here names a plugin: every card is whatever is in the folder.
 *
 * No Node in here, ever (invariant 6).
 */

import { inApp, installUpdate, updateAvailable, type Update } from './desktop.js'
import { el, widget, type Rendered, type WidgetHost } from './widgets.js'

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
  requires: { cap: string; why: string }[]
  settings: Rendered[]
}

interface Problem {
  dir: string
  reason: string
}

/** One row of the registry (M3-2). The bytes are elsewhere; this says where and what to check. */
interface Listing {
  id: string
  name: string
  summary: string
  version: string
  license: string
  author?: string
  signature?: string
  requires: { cap: string; why: string }[]
  provides: string[]
  installed: boolean
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

/** A skill's index entry (M2-2). There is nothing to configure — it is a folder of text. */
interface Skill {
  name: string
  description: string
  license?: string
  dir: string
  /** Set when it arrived with a plugin, which is what makes it not separately removable. */
  pluginId?: string
}

/** Which page is on screen. A plugin's own page is a state of `plugins`, not a fourth. */
type Page = 'general' | 'plugins' | 'about'

export function mountSettings(token: string): {
  open: (page?: Page, filter?: string) => void
  /** Fed from `/api/state`, because the version and the update preference are core's answer. */
  about: (state: { app?: string; updates?: boolean }) => void
} {
  const view = document.querySelector<HTMLElement>('#settings')!
  const general = document.querySelector<HTMLElement>('#general')!
  const pluginsPage = document.querySelector<HTMLElement>('#plugins-page')!
  const aboutPage = document.querySelector<HTMLElement>('#about-page')!
  const tabGeneral = document.querySelector<HTMLButtonElement>('#settings-tab-general')!
  const tabPlugins = document.querySelector<HTMLButtonElement>('#settings-tab-plugins')!
  const tabAbout = document.querySelector<HTMLButtonElement>('#settings-tab-about')!
  const grids = document.querySelector<HTMLElement>('#plugin-grids')!
  const sheet = document.querySelector<HTMLElement>('#plugin-detail')!
  const installed = document.querySelector<HTMLElement>('#bento')!
  const search = document.querySelector<HTMLInputElement>('#plugin-filter')!
  const broken = document.querySelector<HTMLElement>('#problems')!
  const known = document.querySelector<HTMLElement>('#skills')!
  const toLearn = document.querySelector<HTMLElement>('#skills-library')!
  const shelf = document.querySelector<HTMLElement>('#library')!
  /** Which installed ids came from compatibility mode, so the page can say so (M3-6). */
  let unreviewed = new Set<string>()
  /** The last read of each list, so a redraw is a redraw rather than a second fetch. */
  let panes: Pane[] = []
  let listings: Listing[] = []
  /** Whose page is open. Undefined is the grid, and a plugin that goes takes it with it. */
  let chosen: string | undefined

  const send = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
    (await (
      await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-alexia-token': token },
        body: JSON.stringify(body),
      })
    ).json()) as Record<string, unknown>

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
    fresh: async () => {
      const state = (await (
        await fetch('/api/plugins', { headers: { 'x-alexia-token': token } })
      ).json()) as { panes: Pane[] }
      return state.panes.find((p) => p.id === plugin)?.settings ?? []
    },
  })

  async function load(): Promise<void> {
    const state = (await (
      await fetch('/api/plugins', { headers: { 'x-alexia-token': token } })
    ).json()) as {
      panes: Pane[]
      problems: Problem[]
      skills: Skill[]
      skillProblems: Problem[]
      unreviewed?: string[]
    }
    unreviewed = new Set(state.unreviewed ?? [])
    panes = state.panes
    draw(state.problems)
    drawSkills(state.skills, state.skillProblems)
    // The registry is a network call and the installed list is not. Drawn separately so a
    // registry that is down never stops somebody reaching the plugins they already have.
    void loadLibrary()
  }

  // ---- the two pages ----------------------------------------------------------------------

  function pick(page: Page): void {
    general.hidden = page !== 'general'
    pluginsPage.hidden = page !== 'plugins'
    aboutPage.hidden = page !== 'about'
    for (const [tab, on] of [
      [tabGeneral, page === 'general'],
      [tabPlugins, page === 'plugins'],
      [tabAbout, page === 'about'],
    ] as const) {
      tab.classList.toggle('on', on)
      tab.setAttribute('aria-current', on ? 'page' : 'false')
    }
    view.scrollTop = 0
  }

  tabGeneral.addEventListener('click', () => pick('general'))
  tabAbout.addEventListener('click', () => pick('about'))
  tabPlugins.addEventListener('click', () => pick('plugins'))

  /** Filtering is a redraw of what is already read — there is nothing here to fetch again. */
  search.addEventListener('input', () => draw())

  const matches = (name: string, summary: string): boolean => {
    const asked = search.value.trim().toLowerCase()
    return asked === '' || `${name} ${summary}`.toLowerCase().includes(asked)
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
      // The whole screen, because enabling one plugin can satisfy another's requirement.
      void send('/api/plugin', { id: pane.id, action: box.checked ? 'enable' : 'disable' }).then(() => load())
    })
    row.append(box, track)
    return row
  }

  /** Name, what it does, whether it is here, and — when it is — the switch. */
  function card(
    what: { name: string; summary: string; version: string; license: string; installed: boolean },
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
      el('span', what.installed ? 'pill' : 'pill caution', what.installed ? 'installed' : 'not installed'),
      el('span', 'pane-meta', `${what.version} · ${what.license}`),
    )
    box.append(head, el('p', 'bento-what', what.summary), foot)
    box.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('.switch') === null) press()
    })
    return box
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
        card({ ...pane, installed: true }, [toggle(pane)], () => {
          chosen = pane.id
          draw()
        }),
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

    if (entry.requires.length > 0) {
      const wants = el('ul', 'asks')
      for (const need of entry.requires) {
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
    no.addEventListener('click', () => asked.remove())
    yes.addEventListener('click', () => {
      row.remove()
      // No percentage to show: one POST goes out and comes back with the folder on disk. A
      // bar that sweeps says *this is happening* without claiming to know how far along it
      // is, and silence is what kills a first run rather than time (Alexia.md, first run).
      const bar = el('div', 'bar working')
      bar.append(el('span'))
      asked.append(bar)
      said.className = 'hint'
      said.textContent = `Downloading ${entry.name}…`
      void fetchIn(entry.id, 'plugin', said).then(() => {
        bar.remove()
        // Installed and **not enabled** is where a plugin arrives (D73), so the next thing
        // on screen is its own page — which is the walkthrough, and where the yes is given.
        // A card that flipped itself on would be consent nobody gave.
        if (panes.some((pane) => pane.id === entry.id)) {
          chosen = entry.id
          draw()
        }
      })
    })
    row.append(yes, no)
    asked.append(row, said)
    return asked
  }

  /** Install from the registry, then redraw everything — an install changes both lists. */
  const fetchIn = async (id: string, kind: 'plugin' | 'skill', said: HTMLElement): Promise<void> => {
    const answer = (await send('/api/library/install', { id, kind })) as { ok?: boolean; said?: string }
    said.className = answer.ok === true ? 'hint' : 'error'
    said.textContent = answer.said ?? ''
    if (answer.ok === true) await load()
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
      if (!path.value.trim()) return
      const answer = (await send('/api/install', { path: path.value.trim() })) as { ok?: boolean; said?: string }
      said.className = answer.ok === true ? 'hint' : 'error'
      said.textContent = answer.said ?? ''
      if (answer.ok === true) {
        path.value = ''
        await load()
      }
    }
    add.addEventListener('click', () => void install())
    path.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void install()
    })

    row.append(path, add)
    box.append(el('label', undefined, 'Add a plugin'), row, said)
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
        el('b', undefined, `${pulled.id} has been withdrawn from the registry`),
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
          `This is Alexia ${read.app ?? ''}. They are not shown below, because installing one would put a plugin here that cannot load. Alexia offers its own update when there is one.`,
        ),
      )
      shelf.append(box)
    }

    // A shelf that is down is not an empty shelf, and must not look like one.
    if (!read.ok) shelf.append(el('p', 'hint', read.why ?? `Could not reach ${named(read.registry)}.`))
    else if (listings.every((entry) => entry.installed)) {
      shelf.append(el('p', 'hint', `Everything on ${named(read.registry)} is installed.`))
    }

    shelf.append(adding(), addingServer())
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
      // Split on whitespace, which is what a person pastes. Quoting is a shell's job and
      // there is no shell here — core spawns the program directly.
      const words = command.value.trim().split(/\s+/).filter(Boolean)
      if (!name.value.trim() || words.length === 0) return
      add.disabled = true
      said.className = 'hint'
      said.textContent = 'Starting it once to see what it is…'
      const answer = (await send('/api/server', {
        id: name.value.trim(),
        run: words[0],
        args: words.slice(1),
      })) as { ok?: boolean; said?: string }
      said.className = answer.ok === true ? 'hint' : 'error'
      said.textContent = answer.said ?? ''
      add.disabled = false
      if (answer.ok === true) {
        name.value = ''
        command.value = ''
        await load()
      }
    }
    add.addEventListener('click', () => void submit())

    const row = el('div', 'row')
    row.append(name, command, add)
    box.append(row, said)
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

  // ---- one plugin's own page ----------------------------------------------------------------

  /**
   * One plugin, in whichever of its two states it is in (M2-5) — and on a page of its own.
   *
   * **Not enabled is the walkthrough**: the summary, then what it asked for in its author's
   * own words, then one button. Its settings are not drawn, because configuring something you
   * have not agreed to run is a screen asking two questions at once — and the order in the
   * lifecycle is enable, then configure.
   */
  function drawPage(pane: Pane): void {
    const top = el('div', 'view-top')
    const back = el('button', 'quiet-button', '← All plugins')
    back.type = 'button'
    back.addEventListener('click', () => {
      chosen = undefined
      draw()
    })
    const head = el('div', 'pane-head')
    head.append(
      el('h3', 'step-heading', pane.name),
      el(
        'span',
        pane.enabled ? 'pill' : 'pill caution',
        pane.enabled ? (pane.running ? 'running' : 'stopped') : 'not enabled',
      ),
      el('span', 'pane-meta', `${pane.version} · ${pane.license}`),
    )
    top.append(head, back)

    const box = el('div')
    box.append(top, el('p', 'hint', pane.summary))

    // Compatibility mode (M3-6). The pill is not the whole of it: what matters is *what
    // Alexia does differently*, so the sentence says that, and the way out is a decision
    // with a person's hand on it rather than a setting that drifts.
    if (unreviewed.has(pane.id)) {
      head.append(el('span', 'pill caution', 'not reviewed'))
      box.append(
        el(
          'p',
          'hint',
          'This came from an MCP server, not the Alexia registry. Nobody here has reviewed it, so every tool it offers is treated as if it changes things — Alexia asks first, in every mode but Full trust.',
        ),
      )
      const trust = el('button', 'quiet-button', 'I have read what it does — trust it')
      trust.type = 'button'
      trust.addEventListener('click', () => {
        // Same again: *I have read what it does* is already the second press, said in words.
        void send('/api/server', { id: pane.id, action: 'trust', confirm: true }).then(() => load())
      })
      box.append(trust)
    }

    // The author's own sentences, verbatim. This is what a person reads when deciding
    // whether to keep a plugin, so core never rewrites it and never summarises it.
    if (pane.requires.length > 0) {
      const wants = el('ul', 'asks')
      for (const need of pane.requires) {
        const row = el('li')
        row.append(el('code', undefined, need.cap), el('span', undefined, need.why))
        wants.append(row)
      }
      box.append(
        el('p', 'asks-label', pane.enabled ? 'It asked for:' : 'Before you enable it, it is asking for:'),
        wants,
      )
    }

    if (pane.enabled) for (const declared of pane.settings) box.append(widget(host(pane.id), declared))
    box.append(lifecycle(pane))
    sheet.replaceChildren(box)
    view.scrollTop = 0
  }

  /**
   * Enable, disable, delete.
   *
   * **Disable is offered first and delete sits one step further back**, behind a second press
   * that says what goes. Not caution for its own sake: disable is reversible and costs
   * nothing, and delete takes the twenty-minute download with it.
   */
  function lifecycle(pane: Pane): HTMLElement {
    const wrapper = el('div', 'lifecycle')
    const row = el('div', 'row')
    const said = el('p', 'hint')

    const act = async (action: 'enable' | 'disable' | 'delete') => {
      // Delete is guarded on the wire (M6-1) and the second press is what carries the yes.
      // Two separate things saying the same word: the button, because a person can misclick,
      // and `confirm`, because core refuses a purge that nobody said out loud — including
      // one asked for by something that never read this file.
      const answer = (await send('/api/plugin', {
        id: pane.id,
        action,
        ...(action === 'delete' && { confirm: true }),
      })) as { ok?: boolean; said?: string }
      if (answer.ok === false) {
        said.className = 'error'
        said.textContent = answer.said ?? 'That did not work.'
        return
      }
      // Deleting one takes its bundled skills with it, and a plugin that has gone has no
      // page — `draw` drops the selection rather than leaving a page about nothing.
      if (action === 'delete') chosen = undefined
      await load()
    }

    const first = el('button', pane.enabled ? 'quiet-button' : 'begin', pane.enabled ? 'Disable' : 'Enable')
    first.type = 'button'
    first.addEventListener('click', () => void act(pane.enabled ? 'disable' : 'enable'))
    row.append(first)

    // Two presses, and the second one has already said what it is about to take.
    const remove = el('button', 'quiet-button', 'Delete')
    remove.type = 'button'
    let armed = false
    remove.addEventListener('click', () => {
      if (!armed) {
        armed = true
        remove.textContent = 'Delete for good'
        said.className = 'hint'
        said.textContent = `This removes ${pane.name}, its settings, anything it stored and anything it downloaded. Disabling keeps all of it.`
        return
      }
      void act('delete')
    })
    row.append(remove)

    wrapper.append(row, said)
    return wrapper
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
        'Alexia asks GitHub once, at startup, and shows a strip if there is something newer. It never installs anything on its own — that is always this button, or the one in the strip.'
      : 'Alexia will not look on its own. You stay on this version until you press Check now.'

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
    open: (page?: Page, filter?: string) => {
      view.scrollTop = 0
      // The palette found a plugin and this is the page it lives on; typing its name into
      // the filter is what turns *the right page* into *the right card*.
      if (filter !== undefined) search.value = filter
      if (page !== undefined) {
        // Coming in from outside lands on the grid, never on whichever page was open last.
        if (page === 'plugins') chosen = undefined
        pick(page)
      }
      void load()
    },
  }
}
