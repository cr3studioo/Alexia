// SPDX-License-Identifier: AGPL-3.0-only

/**
 * **The Settings and Activity sheet as a dialog**, for somebody on a keyboard or a screen
 * reader (FINDINGS, accessibility 3). The sheet covers the board, so what is under it is made
 * `inert` while it is open — it can be neither tabbed to nor read — and Tab goes round the
 * sheet rather than out of it. Focus moves to the sheet's heading on the way in and goes back
 * to whatever opened it on the way out, so closing it does not drop somebody at the top of
 * the window.
 *
 * No Node in here, ever (invariant 6).
 */

/** What a Tab key can land on. Hidden ones are left out when the ring is worked out. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Whether an element is on screen as far as markup can tell: not inside anything `hidden`. */
const shown = (one: HTMLElement): boolean => one.closest('[hidden]') === null

export interface Modal {
  /** Open over what is behind, focusing `heading`. Opening again only moves focus. */
  open: (heading: HTMLElement) => void
  /** Close, give the board back, and return focus to whatever opened it — or `fallback`. */
  close: (fallback?: HTMLElement) => void
}

export function modal(sheet: HTMLElement, behind: () => HTMLElement[]): Modal {
  sheet.setAttribute('role', 'dialog')
  sheet.setAttribute('aria-modal', 'true')
  let opener: HTMLElement | undefined
  let open = false

  // Tab and Shift-Tab wrap at the ends of what the sheet shows, so focus stays in it.
  sheet.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || !open) return
    const ring = [...sheet.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(shown)
    const first = ring[0]
    const last = ring[ring.length - 1]
    if (first === undefined || last === undefined) return
    const at = document.activeElement
    if (event.shiftKey && (at === first || !sheet.contains(at))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (at === last || !sheet.contains(at))) {
      event.preventDefault()
      first.focus()
    }
  })

  return {
    open(heading) {
      if (!open) {
        const at = document.activeElement
        opener = at instanceof HTMLElement && at !== document.body ? at : undefined
        for (const one of behind()) one.inert = true
        open = true
      }
      if (heading.id !== '') sheet.setAttribute('aria-labelledby', heading.id)
      heading.tabIndex = -1
      heading.focus()
    },
    close(fallback) {
      if (!open) return
      open = false
      for (const one of behind()) one.inert = false
      const back = opener !== undefined && opener.isConnected && shown(opener) ? opener : fallback
      opener = undefined
      back?.focus()
    },
  }
}

/** The question the permission prompt is waiting on, so a new one can take its buttons over. */
let asking: AbortController | undefined

/**
 * **One answer per question from the permission prompt** (FINDINGS, accessibility 7). Its two
 * buttons are the same two for every question, and each question used to add a `once`
 * listener to both: a Deny spent Deny's and left Allow's waiting, so the next Allow answered
 * twice — the old question and the new one. Each question's listeners now go together, when
 * either button is pressed or when the next question arrives. Focus goes to *Allow once*, so
 * the question is where somebody on a keyboard is, and the prompt says itself as it appears.
 */
export function answerPrompt(prompt: HTMLElement, settled: (allowed: boolean) => void, after?: () => void): void {
  asking?.abort()
  const mine = new AbortController()
  asking = mine
  const answer = (allowed: boolean) => (): void => {
    mine.abort()
    prompt.hidden = true
    after?.()
    settled(allowed)
  }
  const allow = prompt.querySelector<HTMLElement>('#allow')!
  allow.addEventListener('click', answer(true), { signal: mine.signal })
  prompt.querySelector('#deny')!.addEventListener('click', answer(false), { signal: mine.signal })
  allow.focus()
}
