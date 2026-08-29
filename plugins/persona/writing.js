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

/**
 * Is what came back a personality, or is it a model talking about one?
 *
 * The check is deliberately shallow — a heading and a length. Anything stricter starts
 * rejecting perfectly good documents for not matching a template nobody promised, and the
 * user can read the thing before using it.
 */
export const usable = (doc) =>
  doc.length > 40 && doc.length <= LONGEST && /^#{1,2} /m.test(doc)

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
