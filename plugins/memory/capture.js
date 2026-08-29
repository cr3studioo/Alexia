// SPDX-License-Identifier: AGPL-3.0-only
import { words } from './search.js'

/**
 * Noticing, rather than being told (M7-3).
 *
 * `remember` works and always did. **What it cannot do is notice**: everything it holds
 * arrived because the model chose, mid-answer, to call a tool — and a model that is busy
 * answering will not. So core hands over every finished exchange (`memory.capture`), this
 * writes it down raw at no cost, and a timer turns the pile into notes later.
 *
 * **The bar for writing is on the floor; the filtering happens at read time.** A fact never
 * written cannot be recalled; a trivial fact that was written costs almost nothing to skip
 * past. That asymmetry is the whole reason capture is greedy.
 *
 * **One stage, where the predecessor had two.** It ran a cheap model over every five
 * exchanges asking only *is any of this worth keeping*, then a stronger one every twelve
 * minutes on the survivors. The split existed to keep an expensive model off most of the
 * volume — and here a plugin on its own clock cannot reach a paid model at all (G12, D96),
 * so the split buys nothing and costs a second prompt, a second parser and a second queue.
 * The property that mattered survives anyway: **an idle Alexia makes no calls**, because an
 * empty buffer is checked before anything is asked.
 *
 * ponytail: one prompt per tick, whole buffer in. If a batch ever grows past what one
 * prompt can hold, the triage stage goes back in front of this one — not a bigger prompt.
 */

/** How much of the buffer one tick swallows. Enough for a busy hour, small enough to read. */
export const BATCH = 20

/**
 * How many times a batch may fail before its rows are set aside.
 *
 * A candidate whose own content breaks the call is otherwise the head of the queue forever,
 * and nothing behind it ever drains. Set aside, **never discarded**: the rows stay in the
 * table and `remembered` can still be asked about them.
 */
export const TRIES = 3

/**
 * How much two sentences must share before a claimed duplicate is believed.
 *
 * A third of the shorter one's words. Plain overlap and no embeddings, because the answer
 * has to be checkable by a person: *these two share fewer than a third of their words* is
 * something you can look at and agree with.
 */
export const OVERLAP = 1 / 3

/**
 * The prompt. Closed, shaped, and it says exactly what the answer must look like — a small
 * model given room to write prose will write prose instead of answering.
 *
 * The existing note names go in because that is what makes a link possible: the model can
 * only link to a note it has been shown, and inventing links to notes that do not exist is
 * the failure this avoids by construction.
 */
export function prompt(rows, names) {
  return [
    'Below are recent exchanges between a user and their assistant, and the names of notes',
    'already written about this user. Write down anything worth remembering weeks from now:',
    'preferences, people, plans, decisions, facts about their life or work.',
    '',
    'When in doubt, keep it. Skip only small talk and things true of everyone.',
    '',
    'Answer with JSON and nothing else: an array of objects with these fields.',
    '  name        a short noun phrase naming the thing, e.g. "the grant deadline"',
    '  text        one complete sentence that still makes sense on its own in a year',
    '  kind        one of: fact, preference, person, place, task, other',
    '  links       names from the list below that this belongs under. [] if none fit.',
    '  duplicate_of  the name of an existing note this already says. Omit unless it does.',
    '',
    'Write [] if there is nothing worth keeping.',
    '',
    `Existing notes: ${names.length === 0 ? '(none yet)' : names.map((n) => `"${n}"`).join(', ')}`,
    '',
    'Exchanges:',
    ...rows.map((row) => `---\n${String(row.text)}`),
  ].join('\n')
}

/**
 * The model's answer, as candidates. `null` means *ask again*.
 *
 * Tolerant of the wrapper — a small model will put a JSON array inside a sentence, or in a
 * fenced block — and strict about the shape once it has one. A candidate with no text is
 * not a candidate.
 *
 * **`[]` and `null` are not the same answer and confusing them loses an hour.** An empty
 * array is the model saying *nothing here was worth keeping*, and the buffer drains on it.
 * Anything else — prose with no array in it, an array cut off by the token limit, an object
 * where an array was asked for — is the model not answering, and the rows keep their turn.
 * The prompt asks for `[]` explicitly so that saying nothing is something the model can do
 * *in the format*, which is what makes treating everything else as a failure safe.
 */
export function parse(said) {
  const text = String(said ?? '')
  const from = text.indexOf('[')
  const to = text.lastIndexOf(']')
  if (from === -1 || to <= from) return null
  let raw
  try {
    raw = JSON.parse(text.slice(from, to + 1))
  } catch {
    // Not JSON at all. The batch counts as a failure so the rows get another turn, which is
    // what `TRIES` is for — a model having a bad minute is not a reason to lose an hour.
    return null
  }
  if (!Array.isArray(raw)) return null
  return raw
    .map((one) => ({
      name: String(one?.name ?? '').trim(),
      text: String(one?.text ?? '').trim(),
      kind: String(one?.kind ?? 'other').trim(),
      links: Array.isArray(one?.links) ? one.links.map((l) => String(l).trim()).filter(Boolean) : [],
      duplicateOf: typeof one?.duplicate_of === 'string' ? one.duplicate_of.trim() : '',
    }))
    .filter((one) => one.text !== '')
    .map((one) => ({ ...one, name: one.name === '' ? one.text.slice(0, 60) : one.name }))
}

/**
 * Is this candidate really a duplicate of that note?
 *
 * **Code overrules the model, and this is why.** Live, 2026-08-10 on the predecessor: a
 * batch of twenty-four real candidates came back marked duplicate, every one of them. Valid
 * JSON, nothing written, nothing crashed — the worst shape a failure can take, because
 * there is nothing to notice. So the model must *name* the note it means, and this compares
 * the two texts before believing it.
 *
 * A claim naming a note that does not exist is not a duplicate claim at all.
 */
export function duplicate(candidate, note) {
  if (!note) return false
  const mine = new Set(words(candidate.text))
  const theirs = words(String(note.text ?? ''))
  if (mine.size === 0 || theirs.length === 0) return false
  const shared = theirs.filter((word) => mine.has(word)).length
  return shared / Math.min(mine.size, theirs.length) >= OVERLAP
}

/**
 * What to write, given what came back and what is already held.
 *
 * All of the judgement and none of the storage, which is what makes the four rules this
 * carries testable without a database or a model:
 *
 * - a duplicate claim is checked against the named note's real text, and overruled when the
 *   two do not actually say the same thing;
 * - a claim naming a note that does not exist is not a claim;
 * - a link to a note the model was not shown is dropped, because a link to nothing reads on
 *   screen as a memory that has gone missing;
 * - and a sentence already held is not written twice, whatever the model said about it.
 *
 * What is held grows as it goes, so a note written earlier in the same batch can be linked
 * to, and claimed as a duplicate of, by a later one — which is the case a pass that only
 * looked at the database would get wrong once per batch, forever.
 */
export function plan(candidates, held) {
  const known = [...held]
  const names = new Set(known.map(named))
  const texts = new Set(known.map((row) => String(row.text ?? '')))
  const write = []
  for (const candidate of candidates) {
    if (candidate.duplicateOf !== '') {
      const claimed = known.find((row) => named(row) === candidate.duplicateOf)
      if (duplicate(candidate, claimed)) continue
    }
    if (texts.has(candidate.text)) continue
    const links = candidate.links.filter((name) => names.has(name))
    const one = { name: candidate.name, text: candidate.text, kind: candidate.kind, links }
    write.push(one)
    known.push(one)
    names.add(one.name)
    texts.add(one.text)
  }
  return write
}

/** What a link points at. Notes written before M7-3 have no name, so their text is one. */
const named = (row) => String(row.name ?? row.text ?? '').trim()
