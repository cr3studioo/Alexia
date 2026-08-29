// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The settings screen: every plugin's chrome, and its declared widgets (M2-1).
 *
 * **A plugin cannot style itself wrong because it never styles itself.** The widgets
 * themselves are drawn by `widgets.ts`, which the control surface uses as well — one
 * renderer, because two would drift on the day one of them was fixed. What lives here is the
 * screen around them: what is installed, what it asked for, and the lifecycle.
 *
 * No Node in here, ever (invariant 6).
 */

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

export function mountSettings(token: string): { open: () => void } {
  const view = document.querySelector<HTMLElement>('#settings')!
  const list = document.querySelector<HTMLElement>('#panes')!
  const broken = document.querySelector<HTMLElement>('#problems')!
  const known = document.querySelector<HTMLElement>('#skills')!
  const shelf = document.querySelector<HTMLElement>('#library')!
  /** Which installed ids came from compatibility mode, so the pane can say so (M3-6). */
  let unreviewed = new Set<string>()

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
    root: () => list,
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
    draw(state.panes, state.problems)
    drawSkills(state.skills, state.skillProblems)
    // The registry is a network call and the installed list is not. Drawn separately so a
    // registry that is down never stops somebody reaching the plugins they already have.
    void loadLibrary()
  }

  /**
   * Install: a folder somebody points at.
   *
   * Crude, and named as such — browsing a library is M3-2, and until there is a registry
   * there is nowhere else for a plugin to come from. What it does is real: the folder is
   * checked where it stands, copied in, and left **not enabled**, so the next thing on the
   * screen is what it asked for.
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
   * Three ways something gets onto this machine and one screen holding all of them, because
   * from the user's side they are one question: *what can Alexia do, and how do I get more
   * of it?* What is deliberately not shared is the **word for each**: a plugin is code that
   * runs here, a skill is text the model reads, an MCP server is neither reviewed nor ours.
   * A badge nobody reads would be the wrong way to carry that difference, so each list says
   * it in a sentence instead.
   */
  async function loadLibrary(): Promise<void> {
    const state = (await (
      await fetch('/api/library', { headers: { 'x-alexia-token': token } })
    ).json()) as LibraryState
    drawLibrary(state)
  }

  /** Install from the registry, then redraw everything — an install changes both lists. */
  const fetchIn = async (id: string, kind: 'plugin' | 'skill', said: HTMLElement): Promise<void> => {
    said.className = 'hint'
    said.textContent = 'Downloading…'
    const answer = (await send('/api/library/install', { id, kind })) as { ok?: boolean; said?: string }
    said.className = answer.ok === true ? 'hint' : 'error'
    said.textContent = answer.said ?? ''
    if (answer.ok === true) await load()
  }

  function drawLibrary(state: LibraryState): void {
    shelf.replaceChildren(el('h3', 'step-heading', 'Library'))

    // Withdrawn, and on this machine. Loudest thing on the screen, above browsing, because
    // it is the one row here that is about something already running.
    for (const pulled of state.revoked ?? []) {
      const row = el('section', 'pane')
      row.append(
        el('b', undefined, `${pulled.id} has been withdrawn from the registry`),
        el('p', 'error', `${pulled.revoked_reason}. It is still installed here — disable or delete it below.`),
      )
      shelf.append(row)
    }

    if (!state.ok) {
      // A registry that is down is not an empty registry, and must not look like one.
      shelf.append(el('p', 'hint', state.why ?? `Could not reach ${state.registry}.`))
      shelf.append(addingServer())
      return
    }

    /**
     * Updates (M5-4), above browsing because they are about something already here.
     *
     * Offered, not applied. An assistant that replaced a plugin's folder while somebody was
     * mid-conversation with it would be an assistant that changed under them, and the only
     * thing an update is allowed to be surprising about is that it exists.
     */
    for (const update of state.updates ?? []) {
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

    const available = (state.plugins ?? []).filter((entry) => !entry.installed)
    if (available.length === 0) {
      shelf.append(el('p', 'hint', `Nothing new at ${state.registry}.`))
    }
    for (const entry of available) {
      const box = el('section', 'pane')
      const head = el('div', 'pane-head')
      head.append(
        el('b', undefined, entry.name),
        el('span', 'pane-meta', `${entry.version} · ${entry.license}${entry.author ? ` · ${entry.author}` : ''}`),
      )
      box.append(head, el('p', 'hint', entry.summary))

      // Its author's own sentences, **before the download** rather than after it. The
      // registry carries `requires` for exactly this reason: deciding whether to want
      // something should not require already having it.
      if (entry.requires.length > 0) {
        const asked = el('ul', 'asks')
        for (const need of entry.requires) {
          const line = el('li')
          line.append(el('code', undefined, need.cap), el('span', undefined, need.why))
          asked.append(line)
        }
        box.append(el('p', 'asks-label', 'It will ask for:'), asked)
      }

      const said = el('p', 'hint')
      const get = el('button', 'quiet-button', 'Install')
      get.type = 'button'
      get.addEventListener('click', () => {
        get.disabled = true
        void fetchIn(entry.id, 'plugin', said).finally(() => (get.disabled = false))
      })
      const row = el('div', 'row')
      row.append(get)
      // Signed and checkable, signed and not checkable, not signed. Three states and three
      // sentences: an unverified signature is worth exactly as much as none, and a screen
      // that showed them alike would be the lie.
      if (entry.signature && state.verifying !== true) {
        row.append(el('span', 'pill caution', 'signature not checked'))
      } else if (entry.signature) {
        row.append(el('span', 'pill', 'signed'))
      }
      box.append(row, said)
      shelf.append(box)
    }

    // Know-how, kept visibly apart from capability. Worst case here is bad advice; worst
    // case above is anything this machine can do.
    const offered = (state.skills ?? []).filter((entry) => !entry.installed)
    if (offered.length > 0) {
      shelf.append(
        el('h3', 'step-heading', 'Skills to install'),
        el('p', 'hint', 'A skill is instructions Alexia reads. It runs no code and adds nothing Alexia could not already do.'),
      )
      for (const entry of offered) {
        const box = el('section', 'pane')
        const head = el('div', 'pane-head')
        head.append(el('b', undefined, entry.name), el('span', 'pane-meta', entry.license ?? ''))
        const said = el('p', 'hint')
        const get = el('button', 'quiet-button', 'Install')
        get.type = 'button'
        get.addEventListener('click', () => {
          get.disabled = true
          void fetchIn(entry.id, 'skill', said).finally(() => (get.disabled = false))
        })
        box.append(head, el('p', 'hint', entry.description), get, said)
        shelf.append(box)
      }
    }

    shelf.append(addingServer())
  }

  /**
   * Compatibility mode (M3-6): any MCP server, as a tool source.
   *
   * Two fields, because that is all an MCP server is — a name and a command line. The
   * sentence under it is not decoration: what arrives this way is not an Alexia plugin,
   * nobody has reviewed it, and every tool on it is treated as destructive until somebody
   * says otherwise on its own pane.
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

  function draw(panes: Pane[], problems: Problem[]): void {
    list.replaceChildren(...panes.map(paneOf))
    if (panes.length === 0 && problems.length === 0) {
      list.append(el('p', 'hint', 'Nothing is installed yet. A plugin is a folder — point at one below.'))
    }
    list.append(adding())

    // A folder that is not a plugin is shown, never swallowed. Somebody put it there on
    // purpose and the reason it did not load is the only useful thing anyone can tell them.
    broken.replaceChildren(...brokenRows(problems, 'One folder did not load', 'folders did not load'))
  }

  /**
   * One plugin, in whichever of its two states it is in (M2-5).
   *
   * **Not enabled is the walkthrough**: the summary, then what it asked for in its author's
   * own words, then one button. Its settings are not drawn, because configuring something you
   * have not agreed to run is a screen asking two questions at once — and the order in the
   * lifecycle is enable, then configure.
   */
  function paneOf(pane: Pane): HTMLElement {
    const box = el('section', 'pane')
    const head = el('div', 'pane-head')
    head.append(
      el('b', undefined, pane.name),
      el(
        'span',
        pane.enabled ? 'pill' : 'pill caution',
        pane.enabled ? (pane.running ? 'running' : 'stopped') : 'not enabled',
      ),
      el('span', 'pane-meta', `${pane.version} · ${pane.license}`),
    )
    box.append(head, el('p', 'hint', pane.summary))

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
      const asked = el('ul', 'asks')
      for (const need of pane.requires) {
        const row = el('li')
        row.append(el('code', undefined, need.cap), el('span', undefined, need.why))
        asked.append(row)
      }
      box.append(
        el('p', 'asks-label', pane.enabled ? 'It asked for:' : 'Before you enable it, it is asking for:'),
        asked,
      )
    }

    if (pane.enabled) for (const declared of pane.settings) box.append(widget(host(pane.id), declared))
    box.append(lifecycle(pane))
    return box
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
      // The whole screen, because enabling one plugin can satisfy another's requirement and
      // deleting one takes its bundled skills with it.
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


  return {
    open: () => {
      view.scrollTop = 0
      void load()
    },
  }
}
