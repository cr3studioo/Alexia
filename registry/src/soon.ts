// SPDX-License-Identifier: AGPL-3.0-only

/**
 * **Plugins that are coming, listed before there is anything to download** (D199).
 *
 * The board's *Add page* list shows what a person could put on it, and a page that is being
 * built is worth showing greyed with *Coming soon* — it answers *can Alexia do that?* with
 * *not yet* instead of with silence. The row has to come from somewhere that is not core,
 * because core naming a plugin is the one thing this project is built not to do (invariant 1),
 * and a plugin that does not exist yet is no exception. So it is a registry row like any
 * other, with `coming_soon: true` and no archive, checksum or protocol behind it.
 *
 * Kept in code rather than in the table: there is nothing to revoke, nothing to hash and
 * nobody submitting it, and a row with no bytes would need every column made optional for
 * its sake. A real submission under the same id replaces the placeholder, which is how one
 * stops being a promise.
 *
 * A GitHub-releases shelf (`scripts/publish.mjs`) carries the same row as a release whose
 * ```alexia block says `"coming_soon": true` and has nothing attached.
 */
export interface SoonEntry {
  id: string
  name: string
  summary: string
  coming_soon: true
}

export const SOON: readonly SoonEntry[] = [
  {
    id: 'vtuber',
    name: 'Vtuber model',
    summary: 'A face for Alexia that moves while she talks.',
    coming_soon: true,
  },
]
