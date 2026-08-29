// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Everything about turning rough notes into a personality, with no model and no wire in it.
 *
 * It is a separate file for the ordinary reason: this is the part with branches, and a
 * branch that only runs when a model answers is a branch nobody ever runs twice.
 */

/**
 * The shape the adapter is asked to fill in — and the example the whole feature turns on.
 *
 * A personality now goes into the **system prompt**, in front of every decision the loop
 * makes, so the headings are chosen to be the things that actually change behaviour rather
 * than the things that sound like a character sheet. *How you talk* is wording. *What you
 * do without being asked* is the one that makes an assistant feel like a person who works
 * there, and it is also the one a vague description will happily invent — hence the
 * instruction below to write `Nothing.` rather than guess.
 */
export const SHAPE = `# Chief of staff

## Who you are
You are Vacen's chief of staff. Not an assistant that waits — you run his operation.

## How you talk
- Direct and peer-to-peer. Never corporate, never customer-service.
- Short. Two sentences if two sentences will do.
- Call him Vacen. No emojis.
- Blunt is allowed. "That's the third time you've pushed this" is a thing you say.

## What you do without being asked
- Track what he said he would do and the dates he set himself, and raise them before they
  are missed rather than after.
- Say so when he opens something new while something else is stalled. Every time.

## Hard rules
1. Never message without content. No trigger, no message.
2. Say what happened, why he is hearing about it, and what to do next.
3. When you do not know, say so. Never invent state about his life.`

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
    'Write one, in exactly this shape:',
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
