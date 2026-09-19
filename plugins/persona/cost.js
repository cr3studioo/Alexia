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
 * **One document, called once per size** — which is what it was built for, and what it now
 * does: §2's three lengths landed (item 15) and this function did not have to change. The
 * three answers are shown together by {@link costLine}.
 */
export const costOf = (doc) => {
  const perStep = tokensIn(doc)
  const perTask = perStep * STEPS
  return { perStep, perTask, over: perTask > BUDGET }
}

const figure = (n) => n.toLocaleString('en-US')

/**
 * The numbers, always shown, always hedged — an estimate presented as a fact is a lie.
 *
 * **Three of them once there are three lengths** (§2). The long one is what a paid model gets
 * and is the figure that was always here; the shorter two are what a weaker model gets, and
 * putting them side by side is the whole of what makes the sizes visible — *this is what she
 * costs* against *this is what she costs on the model that will actually answer*.
 */
export const costLine = (doc, shorter = {}) => {
  const { perStep, perTask } = costOf(doc)
  const also = ['medium', 'small']
    .filter((name) => String(shorter[name] ?? '').trim() !== '')
    .map((name) => `${figure(costOf(shorter[name]).perTask)} on the ${name} one`)
  return (
    `Roughly ${figure(perStep)} tokens per step, or about ${figure(perTask)} across a ` +
    `${STEPS}-step task${also.length === 0 ? '' : ` — ${also.join(', ')}`}. ` +
    `An estimate — it is counted as characters ÷ ${CHARS_PER_TOKEN}.`
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
