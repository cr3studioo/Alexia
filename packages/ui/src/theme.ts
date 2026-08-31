// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which painting is on the wall.
 *
 * `docs/design.md` used to say there was no theme toggle, deliberately, on the grounds that a
 * tray-resident daemon should look like the desktop it is sitting in. That reasoning is still
 * good and it is still the default — what changed is that it was an opinion about the usual
 * case, and a person whose desktop is dark at every hour and who wants champagne anyway is
 * not wrong, they are just not the usual case. The hook the sheet left for exactly this
 * (`[data-theme]` on the root element) is what this module drives.
 *
 * **Three states, because two would be a lie.** *Follow the desktop* has to stay sayable
 * after somebody has forced a theme once, or the switch is one-way and the only route back is
 * remembering which way the desktop happened to be pointing.
 *
 * **The store is the truth and `localStorage` is the copy that beats the network.** Core
 * answers in milliseconds and the page still paints before the answer lands, so a preference
 * read from `/api/state` is a flash of the other theme on every launch — the one bug a theme
 * control is guaranteed to have if nobody writes this paragraph. The mirror is written here
 * and read by a small script in `index.html`'s head, which is the only place early enough to
 * matter.
 *
 * No Node in here, ever (invariant 6).
 */

export type Theme = 'system' | 'light' | 'dark'

/** The three, in the order their cards are drawn. */
export const THEMES: readonly Theme[] = ['system', 'light', 'dark']

/** Where the head script looks. This string is written down twice; `index.html` is the other. */
export const REMEMBERED = 'alexia.theme'

export const isTheme = (value: unknown): value is Theme => THEMES.includes(value as Theme)

/**
 * Put it on the root element, and leave a copy for the next launch to paint from.
 *
 * `system` **removes** the attribute rather than setting it to a third word: the sheet spells
 * dark as `:root:not([data-theme='light'])` inside a `prefers-color-scheme` query, so the
 * absence of the attribute *is* how following the desktop is written. `data-theme="system"`
 * would match neither override and quietly mean light on a dark machine.
 */
export function apply(theme: Theme): void {
  if (theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
  try {
    localStorage.setItem(REMEMBERED, theme)
  } catch {
    // Storage can be off, and this is a cache. What breaks is one frame of the wrong theme on
    // the next launch, after which the answer from core corrects it — not worth throwing over.
  }
}

/**
 * The three cards, wired to the radios inside them.
 *
 * The radio is what the keyboard and the screen reader are actually operating — the card is
 * a label around it and the plate is a picture with no alt text, because the theme's own name
 * is already the accessible one and *a painting of the light theme* helps nobody who cannot
 * see it.
 *
 * It applies on `change` rather than on save: the whole screen is the preview, and a theme
 * that arrived a round trip later would be a control that feels broken while it works.
 */
export function mountTheme(chosen: Theme, keep: (theme: Theme) => void): void {
  apply(chosen)
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="theme"]')) {
    radio.checked = radio.value === chosen
    radio.addEventListener('change', () => {
      if (!radio.checked || !isTheme(radio.value)) return
      apply(radio.value)
      keep(radio.value)
    })
  }
}
