// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a personality costs, and why it is worth saying out loud.
 *
 * A personality is not paid for once. It goes into the **system prompt**, in front of every
 * decision the loop makes, so it is sent again on every step of every task — which makes a
 * page somebody wrote without thinking about length one of the few things in Alexia whose
 * cost scales with how much work she does. Nothing on the screen said so until now: Adapt
 * reported a saved document and a name, and a 400-word personality and a 1,200-word one
 * looked identical.
 *
 * **Everything here is an estimate and is labelled as one.** Characters ÷ 4 is the sanctioned
 * method (plan-personality.md, improvement 7) — a real tokeniser would be exact for one model
 * and wrong for the next, would have to be shipped and kept current, and would buy precision
 * nobody is making a decision with. The number is here to answer *is this page expensive*,
 * and four characters a token answers that.
 */

/** The estimate, in one place because it is the assumption most likely to be revisited. */
export const CHARS_PER_TOKEN = 4

/** A task's length, as plan-personality.md's improvement 7 frames the question. */
export const STEPS = 15

/**
 * Over this, and Adapt says so.
 *
 * Not an arbitrary round number: `brief()` asks for **under 400 words**, which is roughly
 * 2,600 characters, ~650 tokens a step, ~9,750 across a 15-step task. So the line fires in
 * exactly the case worth firing in — the document overran the length its own brief asked for
 * — rather than at a threshold nobody can account for.
 */
export const BUDGET = 10_000

export const tokensIn = (doc) => Math.ceil(String(doc ?? '').length / CHARS_PER_TOKEN)

/**
 * One document's cost.
 *
 * **One document is the whole of it today, and that is on purpose.** §2's three sizes
 * (small ~100 words, medium ~300, high ~600) do not exist yet — that is plan_final_v2.md's
 * item 15, explicitly beyond this session. When they land, this function does not change:
 * it is called once per size and the three answers are shown together. Building the three
 * sizes into it now would mean inventing two documents that nothing writes.
 */
export const costOf = (doc) => {
  const perStep = tokensIn(doc)
  const perTask = perStep * STEPS
  return { perStep, perTask, over: perTask > BUDGET }
}

const figure = (n) => n.toLocaleString('en-US')

/** The numbers, always shown, always hedged — an estimate presented as a fact is a lie. */
export const costLine = (doc) => {
  const { perStep, perTask } = costOf(doc)
  return (
    `Roughly ${figure(perStep)} tokens per step, or about ${figure(perTask)} across a ` +
    `${STEPS}-step task. An estimate — it is counted as characters ÷ ${CHARS_PER_TOKEN}.`
  )
}

/** And the one extra sentence when it is long enough to be worth a person's attention. */
export const budgetLine = (doc) => {
  const { perTask } = costOf(doc)
  if (perTask <= BUDGET) return ''
  return (
    `That is over the ${figure(BUDGET)} this screen treats as a lot, because a personality is ` +
    'sent again with every step rather than once. It is longer than the 400 words it was ' +
    'asked for — Re-adapt, or shorten it, and everything gets cheaper.'
  )
}
