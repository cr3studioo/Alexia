// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a change did to a personality, line by line.
 *
 * **Why this exists at all.** Refine sends a whole document and a sentence and gets a whole
 * document back, so *what actually changed* is not something the model reports — it is
 * something you have to work out by looking. Without that, *more blunt* is a press that
 * returns four hundred words, and the only way to know whether it did the one thing you asked
 * or quietly rewrote her hard rules is to read both versions side by side. Improvement 2's own
 * line: *the change is shown line by line before it saves.*
 *
 * **No dependency, and none wanted.** A personality is forty lines; a diff library is a
 * dependency in a plugin whose whole argument is that it is a folder you can delete. The
 * longest common subsequence over lines is fifteen lines of code and is exact.
 */

/**
 * How many lines each side may have before this stops trying.
 *
 * The table is quadratic, and `usable()` already caps a document at 4,000 characters — so a
 * document that reaches this is not a personality, it is something that got past a check.
 * Saying *the whole thing changed* is the honest answer there, and a cheap one.
 */
export const LINES = 400

/**
 * The longest common subsequence of two line arrays, as the lines they share.
 *
 * Classic table, walked back from the corner. Nothing clever: exactness matters more than
 * speed at this size, and a heuristic diff that occasionally mis-pairs two lines would be
 * worse than none — the whole point is that a person trusts what it says changed.
 */
const shared = (before, after) => {
  const table = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1))
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i][j] =
        before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const both = []
  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      both.push({ at: i, to: j })
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) i++
    else j++
  }
  return both
}

/**
 * Every line, marked `same`, `out` or `in`, oldest first.
 *
 * A changed line comes back as an `out` and an `in` rather than as one *changed* entry, which
 * is deliberate: a model asked to make her blunter rewrites a sentence into two, or two into
 * one, and pretending every change pairs up one-to-one would draw that wrong.
 */
export const marks = (before, after) => {
  const was = String(before ?? '').split('\n')
  const now = String(after ?? '').split('\n')
  if (was.length > LINES || now.length > LINES) return undefined
  const both = shared(was, now)
  const out = []
  let i = 0
  let j = 0
  for (const pair of [...both, { at: was.length, to: now.length }]) {
    for (; i < pair.at; i++) out.push({ kind: 'out', text: was[i] })
    for (; j < pair.to; j++) out.push({ kind: 'in', text: now[j] })
    if (pair.at < was.length) {
      out.push({ kind: 'same', text: was[pair.at] })
      i = pair.at + 1
      j = pair.to + 1
    }
  }
  return out
}

/** How many lines either side of a change are shown, so a `- ` line is not floating alone. */
const AROUND = 1

/**
 * The change, written out — and **only the change**, with a line either side of it.
 *
 * A diff that reprints the whole document is the whole document, which is the thing the person
 * already has and the reason they cannot see what happened. Runs of untouched lines collapse
 * to `…`, and a blank line is never shown as context on its own because it says nothing.
 */
export const changed = (before, after) => {
  const was = String(before ?? '')
  const now = String(after ?? '')
  if (was === now) return 'Nothing changed — the model returned the document it was given.'
  const all = marks(was, now)
  if (all === undefined) return 'The whole document was rewritten.'
  const keep = new Set()
  all.forEach((one, at) => {
    if (one.kind === 'same') return
    for (let n = at - AROUND; n <= at + AROUND; n++) if (n >= 0 && n < all.length) keep.add(n)
  })
  const lines = []
  let skipped = false
  all.forEach((one, at) => {
    if (!keep.has(at) || (one.kind === 'same' && one.text.trim() === '')) {
      skipped = true
      return
    }
    // Including at the top, where it is the only thing saying *there is more above this that
    // did not change* — without it, a change to the last section reads as the whole document.
    if (skipped) lines.push('  …')
    skipped = false
    lines.push(`${one.kind === 'out' ? '- ' : one.kind === 'in' ? '+ ' : '  '}${one.text}`)
  })
  return lines.join('\n')
}

/** *Two lines out, three in* — the size of the change, for the sentence above the diff. */
export const sizeOf = (before, after) => {
  const all = marks(before, after)
  if (all === undefined) return 'every line'
  const out = all.filter((one) => one.kind === 'out' && one.text.trim() !== '').length
  const into = all.filter((one) => one.kind === 'in' && one.text.trim() !== '').length
  const said = []
  if (out > 0) said.push(`${String(out)} line${out === 1 ? '' : 's'} out`)
  if (into > 0) said.push(`${String(into)} line${into === 1 ? '' : 's'} in`)
  return said.length === 0 ? 'nothing' : said.join(', ')
}
