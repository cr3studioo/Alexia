// SPDX-License-Identifier: AGPL-3.0-only
import { el } from './widgets.js'

/**
 * The command palette (M6-10). Ctrl+K, type, jump.
 *
 * Eight tabs is where a tab bar stops being navigation, and the predecessor added one at
 * exactly that point.
 *
 * **It navigates; it does not execute.** Slash commands already run things (M1-12), and
 * M1-12's rule is that every command also has a control. A palette that ran things would be a
 * second command system with a different permission story — so Enter opens the tab the thing
 * lives on, with its name already typed into that panel's filter.
 *
 * No Node in here, ever (invariant 6).
 */

interface Hit {
  tab: string
  kind: string
  label: string
  detail?: string
}

export function mountPalette(
  token: string,
  go: (tab: string, filter: string) => void,
): { open: () => void } {
  const box = document.querySelector<HTMLElement>('#palette')!
  const input = document.querySelector<HTMLInputElement>('#palette-input')!
  const list = document.querySelector<HTMLElement>('#palette-hits')!

  let hits: Hit[] = []
  let at = 0
  /** Which request this is. A slower answer to an older query must not overwrite a newer one. */
  let asked = 0

  const close = (): void => {
    box.hidden = true
    input.value = ''
    list.replaceChildren()
    hits = []
  }

  const take = (hit: Hit | undefined): void => {
    if (!hit) return
    const filter = input.value.trim()
    close()
    go(hit.tab, filter)
  }

  function draw(): void {
    at = Math.max(0, Math.min(at, hits.length - 1))
    list.replaceChildren(
      ...hits.map((hit, index) => {
        const row = el('li', index === at ? 'hit on' : 'hit')
        row.setAttribute('role', 'option')
        row.setAttribute('aria-selected', index === at ? 'true' : 'false')
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
        return row
      }),
    )
    if (hits.length === 0 && input.value.trim() !== '') {
      list.replaceChildren(el('li', 'hit empty', 'Nothing matches that.'))
    }
  }

  input.addEventListener('input', () => {
    const mine = ++asked
    const query = input.value.trim()
    if (query === '') {
      hits = []
      draw()
      return
    }
    void fetch(`/api/search?q=${encodeURIComponent(query)}`, { headers: { 'x-alexia-token': token } })
      .then(async (answer) => (await answer.json()) as { hits: Hit[] })
      .then((answer) => {
        if (mine !== asked) return
        hits = answer.hits
        at = 0
        draw()
      })
  })

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      at += event.key === 'ArrowDown' ? 1 : -1
      draw()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      take(hits[at])
      return
    }
    // Handled here rather than only on the document, and the event is stopped: Escape also
    // puts the whole overlay away (M5-2), and closing a palette should not close the window
    // with it.
    if (event.key === 'Escape') {
      event.stopPropagation()
      close()
    }
  })

  // Anywhere outside it, which is what a person expects of a thing over the page.
  box.addEventListener('mousedown', (event) => {
    if (event.target === box) close()
  })

  return {
    open: () => {
      box.hidden = false
      input.value = ''
      list.replaceChildren()
      hits = []
      input.focus()
    },
  }
}
