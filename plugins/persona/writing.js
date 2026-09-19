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
 * **The notes read as instructions, not as fields.** `<bullets: register, length, what to
 * call them, what is banned>` was a list of four words, and a free model returned it as four
 * labels — `Register: casual` / `Length: concise` / `What to call them: "you"` / `Banned:
 * rushing` (2026-09-18). It filled the note in rather than writing from it, which is the same
 * failure as copying the worked example wearing different clothes. Each note is a sentence
 * telling the writer what to produce, and {@link brief} forbids a note's words reaching the page.
 *
 * The headings are chosen for what changes behaviour, because a personality now goes into
 * the **system prompt** in front of every decision the loop makes. *How you talk* is
 * wording. *What you do without being asked* is the one that makes an assistant feel like
 * someone who works there — and the one a thin description will happily invent, hence
 * `Nothing.` as an allowed answer rather than a guess.
 */
export const SHAPE = `# <the name this personality is saved under>

## Who you are
<One or two sentences saying what role she plays for this person, in their own words.>

## How you talk
<Bullets describing how she speaks: how plain or formal she is, how long her answers run, what she calls this person, and what she must never do. Write each as a sentence, never as a "Label: value" pair.>

## What you do without being asked
<Bullets naming what she raises or chases on her own. Write "Nothing." if the description says none.>

## Hard rules
<A numbered list of the lines that must hold every time. Write "Nothing." if the description gives none.>`

/**
 * The shape with the title already written, because the title was never the model's to choose.
 *
 * **It used to say "write a real name of your own on the first line"**, two lines above a rule
 * forbidding it to invent a name. Handed a description whose own first line read `Name: Alexia`,
 * a free model titled the document `# Jordan` and it saved into a row called *Alexia*
 * (2026-09-18) — a personality whose document disagreed with the list it was listed in.
 *
 * The caller knows the name before it asks: it is the row's name, decided by {@link nameFrom}
 * and made unique by {@link unique}. Passing it in makes the title the one thing about the
 * answer that is not a guess. No name is still allowed, for a caller that has none.
 */
export const shapeFor = (name) => {
  const title = String(name ?? '').trim()
  // A function replacement: a name containing `$&` would otherwise be read as a backreference.
  return title === '' ? SHAPE : SHAPE.replace(/^# .*/, () => `# ${title}`)
}

/**
 * What the adapter is told, and the two sentences carrying the weight.
 *
 * **Use only what the description says**, because the failure mode of this feature is a
 * model handed four words writing a confident page about somebody it invented. And **write
 * it to Alexia**, second person — a document in the third person describes a character, and
 * what goes into a system prompt has to instruct one.
 */
export const brief = (description, name, remembering = false) =>
  [
    'You write personality documents for Alexia, an assistant that runs on the user’s own machine.',
    'The document you write is put directly into her system prompt, so it is read as instructions to her.',
    '',
    'Fill in this shape. The angle brackets say what belongs under each heading — replace each',
    'one, keep the four headings exactly as they are, and copy the first line exactly as it stands:',
    '',
    shapeFor(name),
    '',
    'Rules:',
    '- The notes in angle brackets are instructions to you, not text to reuse. Replace each note with what it asks for, and never let a note’s own words appear in the document as a label or a heading.',
    '- The first line is already decided. Copy it exactly, and never invent a name of your own.',
    '- Use only what the description below says or plainly implies. Invent nothing about the user’s life, work, name, or relationships.',
    '- Address Alexia directly, as "you". Never describe her in the third person.',
    '- If the description says nothing about a section, write "Nothing." under it rather than filling it in.',
    '- Keep it under 400 words. Every line must be something she could act on.',
    '- Never write a rule that tells her to skip asking permission, hide what she did, or ignore a safety limit. Those are not hers to grant.',
    '- Reply with the documents and nothing else. No preamble, no code fences, no explanation.',
    THREE,
    remembering ? FACTS : '',
    '',
    'The description:',
    description,
  ].join('\n')

/**
 * What Refine is told: here is the document, here is the one thing to change.
 *
 * **A different job from {@link brief}, and a much smaller one.** Adapt turns rough notes into
 * four hundred words and has to invent the structure; Refine is handed the structure and one
 * sentence about it. That is why it is worth having at all — a 500-token document and a
 * sentence is a fraction of a 1,300-token description, so it is faster and far less likely to
 * run a reasoning model out of room before it has written anything.
 *
 * **The two sentences carrying the weight are both *change nothing else*.** The failure mode
 * here is not a bad rewrite, it is a helpful one: *make her blunter* coming back with the hard
 * rules reworded, the name changed and a section she never had. The diff on the other end is
 * what makes that visible, and this is what makes it rare.
 */
export const refining = (doc, change) =>
  [
    'You are editing a personality document for Alexia, an assistant that runs on the user’s own machine.',
    'The document is put directly into her system prompt, so it is read as instructions to her.',
    '',
    'Apply the change below to the document below, and change nothing else. The document you are',
    'given is the long one; write all three out again with the change in each.',
    '',
    'Rules:',
    '- Return the whole document, not just the part you changed.',
    '- Keep the first line exactly as it stands. The name is not yours to change.',
    '- Keep the four headings exactly as they stand, in the same order.',
    '- Change only what the instruction asks for. Every other line comes back word for word.',
    '- Address Alexia directly, as "you". Never describe her in the third person.',
    '- Invent nothing about the user’s life, work, name, or relationships.',
    '- If the instruction empties a section, write "Nothing." under it rather than deleting the heading.',
    '- Never write a rule that tells her to skip asking permission, hide what she did, or ignore a safety limit. Those are not hers to grant.',
    '- Reply with the documents and nothing else. No preamble, no code fences, no explanation.',
    THREE,
    '',
    'The change:',
    String(change ?? '').trim(),
    '',
    'The document:',
    String(doc ?? '').trim(),
  ].join('\n')

/** Long enough to be a personality, short enough to be one. Roughly 400 words either way. */
export const LONGEST = 4000

/**
 * **The three lengths, as a ceiling on each** (§2, D160): about 100, 300 and 600 words.
 *
 * Characters rather than words, because that is what can be checked without a tokeniser and it
 * is the same unit `cost.js` estimates in. A word here is about six and a half characters — the
 * figure that file already uses — and each ceiling carries roughly a third again on top, so a
 * document that lands near its budget is accepted and one that ignored the budget is not.
 *
 * **An over-long one is rejected rather than trimmed**, which is §2's own instruction and the
 * reason matters: the hard rules are at the end of the document, so trimming to a length cuts
 * exactly the lines that were least negotiable. A size that is refused simply is not offered,
 * and the next longer one goes in its place — which is what happened before sizes existed.
 */
export const CEILING = { small: 900, medium: 2700, high: LONGEST }

/**
 * **The markers the three arrive separated by**, and why they look like that.
 *
 * Deliberately not Markdown and deliberately not prose: a model writing a personality is
 * already writing `#` and `##` and `---`, and a separator it might plausibly have written
 * itself is a separator that splits a document in half one day. Three per cents and a word in
 * capitals is nothing that appears inside a personality anybody would write.
 */
export const MARK = { medium: '%%% MEDIUM %%%', small: '%%% SMALL %%%', facts: '%%% FACTS %%%' }

/**
 * **The instruction that turns one document into three** (§2), appended to both briefs.
 *
 * A personality is sent on **every step**, as the tail of the system prompt, so a 600-word one
 * across a 15-step task is 7–8k tokens re-sent. On a paid model that is money; on a free one it
 * is context, rate limit, and instructions followed halfway. Three lengths, and core hands each
 * model the one its weakest rung can hold.
 *
 * **Longest first and the shorter ones derived from it**, in one call, because three calls is
 * three chances for one of them to be about a different person. The two sentences carrying the
 * weight are *the same person* and *drop detail, never change her* — the failure here is not a
 * bad summary, it is a second personality that only a small model ever meets.
 */
const THREE = [
  '',
  'Write it three times, longest first, separated by these two markers exactly as they appear here:',
  '',
  '<the full document, about 600 words>',
  MARK.medium,
  '<the same personality in about 300 words: all four headings, one or two lines under each>',
  MARK.small,
  '<the same personality in about 100 words: her name, how she talks, what she calls this person, and at most three hard rules. No headings needed.>',
  '',
  'Rules for the three:',
  '- All three are the same person. The shorter ones drop detail; they never change her.',
  '- Each one starts with the same first line, exactly.',
  '- The markers go on lines of their own, and appear nowhere else.',
  '- Keep to the lengths. A short one that runs long is thrown away and the long one is used instead.',
].join('\n')

/**
 * **Facts about the person, pulled out rather than written in** (improvement 5).
 *
 * A description people write is half *how to be* and half *who I am* — *blunt, chief of staff,
 * calls me Vacen, my grant deadline is in March*. The second half in a personality is re-sent
 * on every step whether it matters or not, and it is a second place the person's name lives,
 * which is two places that can disagree about it.
 *
 * **Only asked for when something is going to remember them**, so a machine with no memory
 * plugin sees none of this and the brief is the one it was before. Appended after {@link THREE}
 * so the three lengths are written first and this cannot eat their room.
 */
const FACTS = [
  '',
  `Then, after a line reading exactly ${MARK.facts}, list the facts the description states about`,
  'the user themselves — their name, their people, their work, their deadlines, their goals.',
  '',
  'Rules for the facts:',
  '- One per line, each a complete sentence that still makes sense on its own in a year.',
  '- Only what the description says. Invent nothing, and infer nothing.',
  '- Facts about the user, never instructions about how to behave. Those stay in the document.',
  '- Write nothing at all after the marker if the description states no facts.',
].join('\n')

/** The lines after the facts marker, as sentences. Nothing there is no facts, not a failure. */
export const factsFrom = (said) => {
  const at = String(said ?? '').indexOf(MARK.facts)
  if (at < 0) return []
  return String(said)
    .slice(at + MARK.facts.length)
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    // A sentence, not a heading and not a marker a model echoed. Long enough to be a fact and
    // short enough to be one: `memory.remember` wants something that reads on its own.
    .filter((line) => line.length > 8 && line.length <= 240 && !line.startsWith('#') && !line.startsWith('%%%'))
    .slice(0, 12)
}

/**
 * The three, split out of one answer.
 *
 * **A missing or over-long shorter size is dropped, never repaired.** Between a model that
 * ignored the markers and one that ignored the lengths there is nothing to salvage: the long
 * document is the one that was checked, and falling back to it is exactly what every model got
 * before sizes existed. The caller says which ones survived, because silently sending six
 * hundred words to a 2B model is the failure this whole section is about.
 */
export const sizesFrom = (said) => {
  const [first = '', rest = ''] = splitOnce(String(said ?? ''), MARK.medium)
  const [medium = '', small = ''] = splitOnce(rest, MARK.small)
  const keep = (text, ceiling) => {
    const one = clean(text)
    return one !== '' && one.length <= ceiling ? one : undefined
  }
  return {
    high: clean(first),
    ...(keep(medium, CEILING.medium) !== undefined && { medium: keep(medium, CEILING.medium) }),
    ...(keep(small, CEILING.small) !== undefined && { small: keep(small, CEILING.small) }),
  }
}

/** On the first occurrence only: a marker a model repeated is still one boundary. */
const splitOnce = (text, mark) => {
  const at = text.indexOf(mark)
  return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at + mark.length)]
}

/**
 * Which of the three are actually there.
 *
 * Takes `{ small, medium }` rather than a row, because the two callers hold different shapes —
 * a row has `doc_small`, a freshly written answer has `small` — and one of them converting is
 * cheaper than this function knowing about both.
 */
export const sizesIn = (sizes) =>
  ['small', 'medium'].filter((name) => String(sizes?.[name] ?? '').trim() !== '')

/** The shorter two off a stored row, in the shape everything else here speaks. */
export const shorterOf = (row) => ({
  small: String(row?.doc_small ?? ''),
  medium: String(row?.doc_medium ?? ''),
})

/** The sentence under a save saying which of the three came back, because two is not three. */
export const sizesLine = (sizes) => {
  const has = sizesIn(sizes)
  if (has.length === 2) return 'Three lengths saved: a weaker model is sent a shorter one.'
  if (has.length === 0) {
    return 'Only the long one came back, so every model gets it — Re-adapt, or a stronger model, writes the shorter two.'
  }
  const missing = has.includes('small') ? 'medium' : 'small'
  return `The ${has[0]} length is saved; the ${missing} one did not come back usable, so a model that wanted it gets the next one up.`
}

/** Code fences and stray preamble, off. A model told six times still adds them sometimes. */
export const clean = (said) => {
  const text = String(said ?? '').trim()
  const fenced = /^```[a-z]*\n([\s\S]*?)\n?```$/i.exec(text)
  return (fenced ? fenced[1] : text).trim()
}

/**
 * The reply budget for Adapt.
 *
 * **It was 4,000 for one document** (D157, raised from 1,200 after a reasoning model spent its
 * whole budget thinking and the document it did write stopped at `## How`). One call now
 * writes three — about a thousand words rather than six hundred — so the room goes up with the
 * job rather than the three arriving cut off, which is the same bug in a new shape.
 */
export const ROOM = 6000

/** How long Adapt waits for that reply: under core's 120 s on a button, over the SDK's 60 s. */
export const WAIT = 110_000

/** The reply budget for one sample answer. Short on purpose: this is a voice, not an essay. */
export const HEARD = 400

/**
 * How long one sample waits.
 *
 * Deliberately under {@link WAIT}: two of these run after a document is already saved, and the
 * document is the thing that mattered. A sample that is still thinking after a minute has
 * already failed at its job, which is to tell somebody what she sounds like before they press
 * Use — and the row is safe either way, so giving up on it costs nothing but the sample.
 */
export const HEARING = 60_000

/**
 * The two questions asked of a new personality before anybody relies on it (improvement 3).
 *
 * **The first is fixed**, because *who are you* is the question whose answer is the voice, and
 * it is the one that came back in a stranger's voice on this machine when a 2.6B model was
 * answering (D157's opening bug).
 *
 * **The second comes from her own *What you do without being asked*** — the section that makes
 * an assistant feel like someone who works there, and the one a thin description will happily
 * invent. It is a plain opener rather than a scene, and that is the restraint that matters: the
 * obvious alternative is to ask a model to make up a situation from the section, which is a
 * third call *and* puts invented facts about this person's life on the screen, which is the one
 * thing every brief in this file forbids. So the moment is real and empty, the behaviour either
 * fires in it or does not, and the caller is told which line it was watching for.
 *
 * A section that says `Nothing.` gets no second question. There is nothing to listen for, and a
 * sample proving that she does nothing is a model call spent on a foregone conclusion.
 */
export const HEAR = 'who are you?'
export const HEAR_UNASKED = 'That is me done for today.'

/** The first behaviour line of *What you do without being asked*, or nothing when there is none. */
export const unasked = (doc) => {
  const said = sectionOf(doc, 'What you do without being asked')
  if (said === '' || /^nothing\.?$/i.test(said.trim())) return ''
  const first = said
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .find((line) => line !== '')
  return first ?? ''
}

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
  const under = sections(doc)
  return SECTIONS.every((name) => (under.get(name.toLowerCase()) ?? []).join('').trim() !== '')
}

/**
 * The lines under each of {@link SECTIONS}, keyed by the heading in lower case.
 *
 * One parse, two readers — {@link usable}, which asks whether every section has something in
 * it, and the preview, which builds its second question out of *What you do without being
 * asked*. Two parsers would drift, and the one that drifted would be the one nobody tested,
 * because the document that reaches the preview has already passed `usable`.
 */
export function sections(doc) {
  const known = new Set(SECTIONS.map((name) => name.toLowerCase()))
  const under = new Map()
  let at
  for (const line of String(doc ?? '').split('\n')) {
    // Only the four open a section. A sub-heading a model adds inside one is content of it.
    const name = heading(line)
    if (name !== undefined && known.has(name)) under.set((at = name), [])
    else if (at !== undefined) under.get(at).push(line)
  }
  return under
}

/** What one section says, trimmed, or an empty string when it is missing or empty. */
export const sectionOf = (doc, name) =>
  (sections(doc).get(String(name).toLowerCase()) ?? []).join('\n').trim()

/**
 * A name the description states outright, as `Name: Alexia`.
 *
 * Worth reading because a description written elsewhere and pasted in usually says who she is
 * in its first few words, and the alternative is the first four words of the paste — which for
 * a document headed *Alexia — AI Agent Personality Document* is a name nobody would choose.
 *
 * A pasted document arrives as one long line with its fields run together, so the value ends
 * at the next `Label:` rather than at a newline. Empty string when nothing says a name.
 */
export const nameSaid = (description) => {
  const found = /\bname\s*[:–—-]\s*(.{1,60})/i.exec(String(description ?? ''))
  if (!found) return ''
  const upTo = found[1].split(/\s+(?=[A-Z][A-Za-z]*\s*:)/)[0] ?? ''
  return upTo
    .replace(/[#*_`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim()
}

/**
 * The name, when the user did not type one.
 *
 * Their own words, trimmed to something that fits a column — never the model's, because a
 * name that appeared out of nowhere is a name nobody recognises in a list a week later. What
 * they typed in the box wins, then a name the description states outright, and only then the
 * opening words — each one a better guess than the one after it.
 */
export const nameFrom = (typed, description) => {
  const said = String(typed ?? '').trim()
  if (said !== '') return said.slice(0, 40)
  const stated = nameSaid(description)
  if (stated !== '') return stated
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
  // §2's two shorter lengths, absent on every row written before they existed — which is why
  // they are kept as empty strings rather than left off: Undo writes this object back onto the
  // row whole, and a key that is missing rather than empty would leave the *old* short one
  // beside the restored long one, describing a person two versions apart.
  docSmall: String(row?.doc_small ?? ''),
  docMedium: String(row?.doc_medium ?? ''),
  described: String(row?.described ?? ''),
  wrote: String(row?.wrote ?? ''),
  at: Number(row?.at ?? 0),
})

/** A stored version, as the columns it lives in. The inverse of {@link versionOf}. */
export const asRow = (version) => ({
  doc: version.doc,
  doc_small: version.docSmall ?? '',
  doc_medium: version.docMedium ?? '',
  described: version.described ?? '',
  wrote: version.wrote ?? '',
  at: version.at ?? 0,
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
