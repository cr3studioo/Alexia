// SPDX-License-Identifier: AGPL-3.0-only

/**
 * **Where the pages sit on the board** (D199), as core keeps it.
 *
 * Stored the way the theme is — one kv entry, written through `/api/setup` and read back on
 * `/api/state` — because it is the same kind of fact: an answer about this install, and the
 * window and a tab pointed at the same core should not disagree about where Chat is.
 *
 * **Core checks the shape and reads nothing else.** A page id is the shell's word for a page,
 * and some of those words are plugin ids: a layout naming one is a person having put that
 * plugin's page somewhere, and core learning what the id means would be core naming a plugin
 * by the back door (invariant 1). So an id here is an opaque string, an unknown one is kept,
 * and the shell is what decides a page whose plugin went away is not drawn.
 */
export interface Layout {
  v: 1
  /** How many dot columns the board had when this was saved, so a wider window can rescale. */
  cols: number
  /** The two column boundaries, in dots — what the grips between the columns drag. */
  guides: [number, number]
  pages: { id: string; w: number; h: number; anchor?: { x: number; y: number } }[]
}

/**
 * Sixty-four pages. Every core page and every plugin anybody has is well under that; the
 * ceiling is here so a shell bug that appends on every save cannot grow a kv row forever.
 */
export const MAX_PAGES = 64

const whole = (n: unknown, least: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= least
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

/**
 * The layout as it may be stored, or the sentence saying why not.
 *
 * Only what was checked is kept: a field the shell sends that is not in the shape is dropped
 * rather than stored, so what `/api/state` hands back is always exactly {@link Layout}.
 */
export function readLayout(sent: unknown): { ok: true; layout: Layout } | { ok: false; why: string } {
  const no = (why: string) => ({ ok: false as const, why: `That layout cannot be kept: ${why}.` })
  if (typeof sent !== 'object' || sent === null || Array.isArray(sent)) return no('it is not an object')
  const l = sent as Record<string, unknown>
  if (l.v !== 1) return no('it is not version 1')
  if (!finite(l.cols) || l.cols <= 0) return no('cols must be a number above 0')
  const guides = l.guides
  if (!Array.isArray(guides) || guides.length !== 2 || !guides.every(finite)) {
    return no('guides must be two numbers')
  }
  if (!Array.isArray(l.pages)) return no('pages must be a list')
  if (l.pages.length > MAX_PAGES) return no(`there are more than ${String(MAX_PAGES)} pages`)
  const pages: Layout['pages'] = []
  const seen = new Set<string>()
  for (const [i, one] of (l.pages as unknown[]).entries()) {
    const at = `page ${String(i + 1)}`
    if (typeof one !== 'object' || one === null) return no(`${at} is not an object`)
    const p = one as Record<string, unknown>
    if (typeof p.id !== 'string' || p.id === '' || p.id.length > 64) return no(`${at} has no id`)
    // Each page is on the board once — the shell draws one element per id, and two entries
    // for one id would be two places for one page with no saying which is true.
    if (seen.has(p.id)) return no(`${at} (${p.id}) is on the board twice`)
    seen.add(p.id)
    if (!whole(p.w, 1) || !whole(p.h, 1)) return no(`${at} (${p.id}) needs a whole width and height of at least 1`)
    let anchor: { x: number; y: number } | undefined
    if (p.anchor !== undefined) {
      const a = p.anchor as Record<string, unknown> | null
      if (typeof a !== 'object' || a === null || !whole(a.x, 0) || !whole(a.y, 0)) {
        return no(`${at} (${p.id}) has an anchor that is not two whole numbers from 0`)
      }
      anchor = { x: a.x, y: a.y }
    }
    pages.push({ id: p.id, w: p.w, h: p.h, ...(anchor && { anchor }) })
  }
  return { ok: true, layout: { v: 1, cols: l.cols, guides: [guides[0] as number, guides[1] as number], pages } }
}
