// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Everything about turning rough notes into a personality, with no model and no wire in it.
 *
 * It is a separate file for the ordinary reason: this is the part with branches, and a
 * branch that only runs when a model answers is a branch nobody ever runs twice.
 */

/**
 * The shape the adapter fills in — **a skeleton, and it used to be a worked example.**
 *
 * The first version was a complete chief-of-staff personality, on the theory that a model
 * shown a good one writes a good one. What it actually does is *copy it*: asked for a
 * Victorian butler, a free model returned the example's headline, its role sentence and both
 * of its bullets, with only *How you talk* replaced. The invented name it was told never to
 * invent came from the instructions rather than from the description — and every personality
 * anybody adapted would have been the same person underneath.
 *
 * So there is nothing here to lift. Angle brackets say what belongs under each heading and
 * name nobody.
 *
 * The headings are chosen for what changes behaviour, because a personality now goes into
 * the **system prompt** in front of every decision the loop makes. *How you talk* is
 * wording. *What you do without being asked* is the one that makes an assistant feel like
 * someone who works there — and the one a thin description will happily invent, hence
 * `Nothing.` as an allowed answer rather than a guess.
 */
export const SHAPE = `# <a short name for this personality>

## Who you are
<one or two sentences: what role she plays for this person, in their words>

## How you talk
<bullets: register, length, what to call them, what is banned>

## What you do without being asked
<bullets: things she raises or chases on her own. "Nothing." if the description says none>

## Hard rules
<numbered: the lines that must hold every time. "Nothing." if the description gives none>`

/**
 * What the adapter is told, and the two sentences carrying the weight.
 *
 * **Use only what the description says**, because the failure mode of this feature is a
 * model handed four words writing a confident page about somebody it invented. And **write
 * it to Alexia**, second person — a document in the third person describes a character, and
 * what goes into a system prompt has to instruct one.
 */
export const brief = (description) =>
  [
    'You write personality documents for Alexia, an assistant that runs on the user’s own machine.',
    'The document you write is put directly into her system prompt, so it is read as instructions to her.',
    '',
    'Fill in this shape. The angle brackets say what belongs under each heading — replace each',
    'one, keep the headings, and write a real name of your own on the first line:',
    '',
    SHAPE,
    '',
    'Rules:',
    '- Use only what the description below says or plainly implies. Invent nothing about the user’s life, work, name, or relationships.',
    '- Address Alexia directly, as "you". Never describe her in the third person.',
    '- If the description says nothing about a section, write "Nothing." under it rather than filling it in.',
    '- Keep it under 400 words. Every line must be something she could act on.',
    '- Never write a rule that tells her to skip asking permission, hide what she did, or ignore a safety limit. Those are not hers to grant.',
    '- Reply with the document and nothing else. No preamble, no code fences, no explanation.',
    '',
    'The description:',
    description,
  ].join('\n')

/** Code fences and stray preamble, off. A model told six times still adds them sometimes. */
export const clean = (said) => {
  const text = String(said ?? '').trim()
  const fenced = /^```[a-z]*\n([\s\S]*?)\n?```$/i.exec(text)
  return (fenced ? fenced[1] : text).trim()
}

/** Long enough to be a personality, short enough to be one. Roughly 400 words either way. */
export const LONGEST = 4000

/** The reply budget for Adapt: a 400-word document, plus what a reasoning model thinks first. */
export const ROOM = 4000

/** How long Adapt waits for that reply: under core's 120 s on a button, over the SDK's 60 s. */
export const WAIT = 110_000

/** The four headings {@link SHAPE} promises, which is what makes checking for them fair. */
export const SECTIONS = SHAPE.split('\n')
  .filter((line) => line.startsWith('## '))
  .map((line) => line.slice(3))

const heading = (line) => /^#{2,3}\s+(.+?)[\s:]*$/.exec(line)?.[1]?.toLowerCase()

/**
 * Is what came back a personality, or is it a model talking about one — or half of one?
 *
 * **It used to be a heading and a length**, on the grounds that anything stricter rejects
 * good documents for not matching a template nobody promised. The brief does promise it, and
 * the shallow check is what let half a document through (2026-09-15): a title, one sentence
 * under *Who you are*, and `## How` where the answer ran out of room. It passed, it saved, and
 * she behaved as if no personality was set.
 *
 * So every heading has to be there with something under it. `Nothing.` counts, because it is
 * an answer. Case, a trailing colon and one extra `#` are forgiven; a missing section is not.
 */
export const usable = (doc) => {
  if (doc.length <= 40 || doc.length > LONGEST || !/^# /m.test(doc)) return false
  const known = new Set(SECTIONS.map((name) => name.toLowerCase()))
  const under = new Map()
  let at
  for (const line of doc.split('\n')) {
    // Only the four open a section. A sub-heading a model adds inside one is content of it.
    const name = heading(line)
    if (name !== undefined && known.has(name)) under.set((at = name), '')
    else if (at !== undefined) under.set(at, under.get(at) + line.trim())
  }
  return [...known].every((name) => (under.get(name) ?? '') !== '')
}

/**
 * The name, when the user did not type one.
 *
 * Their own words, trimmed to something that fits a column — never the model's, because a
 * name that appeared out of nowhere is a name nobody recognises in a list a week later.
 */
export const nameFrom = (typed, description) => {
  const said = String(typed ?? '').trim()
  if (said !== '') return said.slice(0, 40)
  const words = String(description ?? '')
    .replace(/[#*_`]/g, ' ')
    .split(/[\s,.;:!?\n]+/)
    .filter((word) => word !== '')
    .slice(0, 4)
    .join(' ')
  const short = words.slice(0, 40).trim()
  if (short === '') return 'Personality'
  return short[0].toUpperCase() + short.slice(1)
}

/** `Chief of staff`, `Chief of staff 2`, `Chief of staff 3`. Two rows with one name is a trap. */
export const unique = (name, taken) => {
  if (!taken.includes(name)) return name
  for (let n = 2; ; n++) if (!taken.includes(`${name} ${n}`)) return `${name} ${n}`
}

/**
 * Which saved personality somebody meant by what they typed after `/persona`.
 *
 * Exact name first, then a unique prefix, then a unique substring — and **nothing at all when
 * two could be meant**, because switching to the wrong personality is silent: the next answer
 * is simply in the wrong voice, with nothing on screen saying why. Ambiguity is returned as
 * the list of candidates so the caller can say which ones it was torn between.
 */
export const matchName = (rows, typed) => {
  const want = String(typed ?? '').trim().toLowerCase()
  if (want === '') return { none: true }
  const named = rows.map((row) => ({ row, name: String(row.name ?? '').toLowerCase() }))
  const exact = named.filter((one) => one.name === want)
  if (exact.length === 1) return { row: exact[0].row }
  const starts = named.filter((one) => one.name.startsWith(want))
  if (starts.length === 1) return { row: starts[0].row }
  const has = named.filter((one) => one.name.includes(want))
  if (has.length === 1) return { row: has[0].row }
  const among = (starts.length > 0 ? starts : has).map((one) => String(one.row.name))
  return among.length > 1 ? { among } : { none: true }
}

/** The day, as a person writes it. */
const day = (at) => (Number(at) > 0 ? new Date(Number(at)).toISOString().slice(0, 10) : '')

/**
 * One saved version, pulled off a row.
 *
 * Rows written before any of this existed have none of these columns — a plugin table grows a
 * column the first time a key appears, so everything older reads back `undefined`. That is the
 * normal case on this Mac, not an error, and every reader below has to survive it.
 */
export const versionOf = (row) => ({
  doc: String(row?.doc ?? ''),
  described: String(row?.described ?? ''),
  wrote: String(row?.wrote ?? ''),
  at: Number(row?.at ?? 0),
})

/** The kept previous version, or nothing. Stored as JSON text, which is what storage.md promises. */
export const priorOf = (row) => {
  const raw = row?.previous
  if (raw === undefined || raw === null || raw === '') return undefined
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return parsed && typeof parsed === 'object' ? versionOf(parsed) : undefined
  } catch {
    return undefined
  }
}

/**
 * Where a personality came from, in the words of whoever reads the row a month later.
 *
 * **The description is the part worth keeping.** Adapt turns four words into a page, and until
 * now the four words were thrown away the moment the page existed — so *Re-adapt* had nothing
 * to re-adapt from, and nobody could tell what the page had been asked to be. Kept beside the
 * document, it is both the provenance and the input for writing it again.
 */
export const provenance = (row) => {
  const { described, wrote, at } = versionOf(row)
  const lines = []
  if (described !== '') lines.push(`Adapted from your words: “${described}”`)
  const when = day(at)
  if (wrote !== '' && when !== '') lines.push(`Written by ${wrote} on ${when}`)
  else if (wrote !== '') lines.push(`Written by ${wrote}`)
  else if (when !== '') lines.push(`Written on ${when}`)
  const prior = priorOf(row)
  if (prior) {
    const then = day(prior.at)
    lines.push(
      then === '' ?
        'A previous version is kept — Undo restores it.'
      : `A previous version from ${then} is kept — Undo restores it.`,
    )
  }
  return lines.join('\n')
}
