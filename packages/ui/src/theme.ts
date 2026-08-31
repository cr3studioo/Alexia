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

/**
 * How opaque the frosted panels are, as a `--glass-tint` percentage. Same story as the theme:
 * the store is the truth, `localStorage` is the copy the head script paints from before the
 * network answers, and `index.html` carries the key a second time.
 *
 * The floor is 40 rather than 0 because below it the conversation is text on a photograph —
 * `contrast.test.ts` guarantees the palette, not the wallpaper behind a see-through panel.
 */
export const GLASS_MIN = 40
export const GLASS_MAX = 100
export const GLASS_DEFAULT = 78

/** Where the head script looks. Written down twice; `index.html` is the other. */
export const REMEMBERED_GLASS = 'alexia.glass'

export const clampGlass = (pct: number): number =>
  Math.min(GLASS_MAX, Math.max(GLASS_MIN, Math.round(Number.isFinite(pct) ? pct : GLASS_DEFAULT)))

export function applyGlass(pct: number): void {
  const clamped = clampGlass(pct)
  document.documentElement.style.setProperty('--glass-tint', `${clamped}%`)
  try {
    localStorage.setItem(REMEMBERED_GLASS, String(clamped))
  } catch {
    // A cache. One frame of the default frost on the next launch is the whole cost.
  }
}

/**
 * The slider, beside the theme cards it paints through. `input` applies it live — the screen
 * is the preview — and `change` (pointer released, arrow key settled) is the one that writes,
 * so a drag is one save and not one per pixel.
 */
export function mountGlass(chosen: number, keep: (pct: number) => void): void {
  applyGlass(chosen)
  const slider = document.querySelector<HTMLInputElement>('#glass')
  if (!slider) return
  slider.value = String(clampGlass(chosen))
  slider.addEventListener('input', () => applyGlass(Number(slider.value)))
  slider.addEventListener('change', () => keep(clampGlass(Number(slider.value))))
}
