// SPDX-License-Identifier: AGPL-3.0-only
import { el } from './widgets.js'

/**
 * The command palette (M6-10). ⌘K (Ctrl K off a Mac), type, jump.
 *
 * Eight tabs is where a tab bar stops being navigation, and the predecessor added one at
 * exactly that point.
 *
 * **It navigates; it does not execute.** Slash commands already run things (M1-12), and
 * M1-12's rule is that every command also has a control. A palette that ran things would be a
 * second command system with a different permission story — so Enter opens the place the
 * thing lives, with its own name already typed into that list's filter.
 *
 * No Node in here, ever (invariant 6).
 */

/** One row of what core found (`/api/search`), and where it goes. */
export interface Hit {
  /** A tab or Settings page, or `chat` for one conversation. */
  tab: string
  kind: string
  label: string
  detail?: string
  /** What to type into the list it lives in — its own name there. Absent for a page. */
  filter?: string
  /** For a chat, which one. */
  id?: string
  /** A thing the shell does itself rather than a place to go. Only ever one of `local`. */
  run?: () => void
}

/**
 * Something the shell itself can do, found by typing any of its words — *Edit layout* is the
 * first (D204). It changes how the window is arranged and nothing else, which is why it may
 * sit in a palette that otherwise only navigates: it runs no command and asks no permission.
 */
export interface Local {
  label: string
  detail?: string
  words: string[]
  run: () => void
}

/** Whether this is a Mac, where the shortcut is ⌘K and not Ctrl K. */
export const onMac = (): boolean => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** The palette's shortcut as this machine's keyboard writes it. */
export const shortcut = (mac: boolean = onMac()): string => (mac ? '⌘K' : 'Ctrl K')

/** What an empty palette says, so a person knows what it can find before typing. */
export const EMPTY_HINT = 'Search chats, settings, skills and plugins.'

/**
 * Whether one of the shell's own entries answers what was typed: **every word typed starts one
 * of its words**. Not *contains* — *edit* is inside *credit*, and typing *credit* used to
 * offer to rearrange the window.
 */
export function localMatches(query: string, one: Local): boolean {
  const typed = query.toLowerCase().split(/\s+/).filter((word) => word !== '')
  const words = [...one.label.toLowerCase().split(/\s+/), ...one.words.map((word) => word.toLowerCase())]
  return typed.length > 0 && typed.every((word) => words.some((own) => own.startsWith(word)))
}

export function mountPalette(
  token: string,
  go: (hit: Hit) => void,
  local: readonly Local[] = [],
): { open: () => void } {
  const box = document.querySelector<HTMLElement>('#palette')!
  const dialog = box.querySelector<HTMLElement>('.palette-box') ?? box
  const input = document.querySelector<HTMLInputElement>('#palette-input')!
  const list = document.querySelector<HTMLElement>('#palette-hits')!

  // A combobox over a listbox, which is what a screen reader expects of a search box whose
  // arrow keys move through what it found (FINDINGS, accessibility 4). The rows are never
  // focused themselves: focus stays in the box and `aria-activedescendant` says which row.
  input.setAttribute('role', 'combobox')
  input.setAttribute('aria-controls', list.id)
  input.setAttribute('aria-autocomplete', 'list')
  input.setAttribute('aria-expanded', 'false')
  if (!input.hasAttribute('aria-label')) input.setAttribute('aria-label', 'Find')
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', 'What was found')

  // The shortcut as this keyboard writes it, wherever the page names it.
  for (const key of document.querySelectorAll<HTMLElement>('[data-shortcut="palette"]')) key.textContent = shortcut()

  let hits: Hit[] = []
  let at = 0
  /** Which request this is. A slower answer to an older query must not overwrite a newer one. */
  let asked = 0
  /** Which request the list on screen answers. Behind `asked` while an answer is on its way. */
  let answered = 0
  /** Enter was pressed before the answer to what is typed came back: take it when it does. */
  let waiting = false
  /** Where focus was before the palette opened, to go back to when it closes. */
  let before: HTMLElement | undefined

  const optionId = (index: number): string => `palette-hit-${String(index)}`

  const close = (): void => {
    box.hidden = true
    // The rows and the words stay drawn while the box fades out (app.css) — emptied here, it
    // shrank to a bare search field on its way out. `open` redraws both before anything shows.
    hits = []
    waiting = false
    input.setAttribute('aria-expanded', 'false')
    input.removeAttribute('aria-activedescendant')
  }

  /** Back to where it was, if that is still on screen — a pick may have moved the view away. */
  const giveBack = (): void => {
    const to = before
    before = undefined
    if (to !== undefined && to.isConnected && to.checkVisibility()) to.focus()
  }

  const take = (hit: Hit | undefined): void => {
    if (!hit) return
    close()
    if (hit.run) hit.run()
    else go(hit)
    giveBack()
  }

  /** Only the highlight, so a row under the mouse is not replaced out from under it. */
  function mark(): void {
    for (const [index, row] of [...list.children].entries()) {
      if (!row.classList.contains('hit') || row.classList.contains('empty')) continue
      row.classList.toggle('on', index === at)
      row.setAttribute('aria-selected', index === at ? 'true' : 'false')
    }
    if (hits.length > 0) {
      input.setAttribute('aria-activedescendant', optionId(at))
      list.children[at]?.scrollIntoView?.({ block: 'nearest' })
    } else input.removeAttribute('aria-activedescendant')
  }

  function draw(): void {
    at = Math.max(0, Math.min(at, hits.length - 1))
    const typed = input.value.trim()
    list.replaceChildren(
      ...hits.map((hit, index) => {
        const row = el('li', 'hit')
        row.id = optionId(index)
        row.setAttribute('role', 'option')
        // What sort of thing, then what it is called, then enough to tell two of the same
        // name apart. The kind first because it is what somebody scans down.
        row.append(el('span', 'hit-kind', hit.kind), el('b', undefined, hit.label))
        if (hit.detail !== undefined) row.append(el('span', 'hit-detail', hit.detail))
        // `mousedown`, not `click`: the input still has focus and losing it first would
        // close the palette out from under the press.
        row.addEventListener('mousedown', (event) => {
          event.preventDefault()
          take(hit)
        })
        // The mouse moves the highlight as the arrow keys do, so Enter always takes the row
        // that looks chosen.
        row.addEventListener('mousemove', () => {
          if (at === index) return
          at = index
          mark()
        })
        return row
      }),
    )
    if (hits.length === 0) {
      const empty = el('li', 'hit empty', typed === '' ? `${EMPTY_HINT} ${shortcut()} opens this from anywhere.` : `Nothing matches “${typed}”.`)
      empty.setAttribute('role', 'presentation')
      list.replaceChildren(empty)
    }
    input.setAttribute('aria-expanded', hits.length > 0 ? 'true' : 'false')
    mark()
  }

  input.addEventListener('input', () => {
    const mine = ++asked
    const query = input.value.trim()
    if (query === '') {
      answered = mine
      waiting = false
      hits = []
      draw()
      return
    }
    const ours: Hit[] = local
      .filter((one) => localMatches(query, one))
      .map((one) => ({ tab: '', kind: 'layout', label: one.label, run: one.run, ...(one.detail !== undefined && { detail: one.detail }) }))
    void fetch(`/api/search?q=${encodeURIComponent(query)}`, { headers: { 'x-alexia-token': token } })
      .then(async (answer) => (await answer.json()) as { hits: Hit[] })
      .catch(() => ({ hits: [] as Hit[] }))
      .then((answer) => {
        if (mine !== asked || box.hidden) return
        answered = mine
        hits = [...ours, ...answer.hits]
        at = 0
        draw()
        // Enter was pressed while this was on its way: it meant *the first of these*, not
        // whatever the list said a keystroke ago.
        if (waiting) {
          waiting = false
          take(hits[at])
        }
      })
  })

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (hits.length === 0) return
      at = (at + (event.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length
      mark()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      // The list on screen may answer what was typed two letters ago. Enter means the answer
      // to what is typed now, so it waits for it rather than taking a stale row.
      if (answered !== asked) waiting = true
      else take(hits[at])
      return
    }
    // Focus stays in the palette: the box is the only thing in it to be on, and Tab walking
    // off into the page behind a modal is walking somewhere nobody can see.
    if (event.key === 'Tab') {
      event.preventDefault()
      return
    }
    // Handled here rather than only on the document, and the event is stopped: Escape also
    // puts the whole overlay away (M5-2), and closing a palette should not close the window
    // with it.
    if (event.key === 'Escape') {
      event.stopPropagation()
      close()
      giveBack()
    }
  })

  // Anywhere outside it, which is what a person expects of a thing over the page.
  box.addEventListener('mousedown', (event) => {
    if (event.target === box) {
      close()
      giveBack()
    }
  })
  // A press inside the box but not on the input would take focus off it — onto nothing that
  // can be typed into. Keep it where the keys work.
  dialog.addEventListener('mousedown', (event) => {
    if (event.target !== input) event.preventDefault()
  })

  return {
    open: () => {
      if (box.hidden) {
        const was = document.activeElement
        before = was instanceof HTMLElement && was !== document.body ? was : undefined
      }
      box.hidden = false
      input.value = ''
      hits = []
      waiting = false
      answered = asked
      draw()
      input.focus()
    },
  }
}
