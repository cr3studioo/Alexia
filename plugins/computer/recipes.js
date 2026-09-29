// SPDX-License-Identifier: AGPL-3.0-only

/**
 * **Plans for the common goals, written once** (computer use v3).
 *
 * A plan that starts at the page that does the job is two or three steps where clicking through
 * a home page is seven, and every step not taken is one that cannot go wrong. When `run_task` is
 * given a goal and no steps, these are tried before it hands back asking for some. The same
 * shapes are in the skill, so the chat model writes its own plans this way.
 *
 * Each recipe is a pattern over the goal and a function from what it caught to steps. They are
 * matched in order and the first that fits wins; none of them presses anything that commits.
 */
const RECIPES = [
  {
    // *the latest video from Mark Rober*, *newest upload by Veritasium*
    match: /\b(?:latest|newest|most recent|last|new)\s+(?:youtube\s+)?(?:video|upload)s?\b.*?\b(?:from|by|of|on)\s+(.+?)(?:'s)?(?:\s+(?:youtube\s+)?channel)?(?:\s+on\s+youtube)?[.!?]*$/i,
    steps: ([, who]) => channelNewest(who),
  },
  {
    match: /^(?:find\s+|get\s+|open\s+)?(.+?)(?:'s|’s)\s+(?:latest|newest|most recent|last)\s+(?:youtube\s+)?(?:video|upload)\b/i,
    steps: ([, who]) => channelNewest(who),
  },
  {
    // *search YouTube for lofi beats*, *search lofi beats on youtube*
    match: /\bsearch\s+(?:youtube\s+for\s+(.+?)|(?:for\s+)?(.+?)\s+on\s+youtube)[.!?]*$/i,
    steps: ([, a, b]) => [
      { do: 'open_url', url: `https://www.youtube.com/results?search_query=${plus(a ?? b)}`, say: 'Open the search results', expect: 'Filters' },
      { do: 'read', target: 'the first video', as: 'title', say: 'Read the first result' },
      { do: 'answer', text: 'The first result is “{title}”.' },
    ],
  },
  {
    match: /\b(?:search\s+)?amazon\s+for\s+(.+?)[.!?]*$|\bsearch\s+(?:for\s+)?(.+?)\s+on\s+amazon[.!?]*$/i,
    steps: ([, a, b]) => [{ do: 'open_url', url: `https://www.amazon.com/s?k=${plus(a ?? b)}`, say: 'Open the Amazon results' }],
  },
  {
    match: /\b(?:directions|route|how to get)\s+(?:from\s+(.+?)\s+)?to\s+(.+?)[.!?]*$/i,
    steps: ([, from, to]) => [
      {
        do: 'open_url',
        url: `https://www.google.com/maps/dir/?api=1${from ? `&origin=${encodeURIComponent(from)}` : ''}&destination=${encodeURIComponent(to)}`,
        say: 'Open the directions',
      },
    ],
  },
  {
    match: /\b(?:google|search\s+(?:google|the\s+web)\s+for)\s+(.+?)[.!?]*$/i,
    steps: ([, what]) => [{ do: 'open_url', url: `https://www.google.com/search?q=${plus(what)}`, say: 'Open the Google results' }],
  },
]

/** A channel's videos page, which YouTube sorts newest first, and the first title on it. */
function channelNewest(who) {
  const name = String(who).trim().replace(/^the\s+/i, '').replace(/^@/, '')
  return [
    { do: 'open_url', url: `https://www.youtube.com/@${encodeURIComponent(name.replace(/\s+/g, ''))}/videos`, say: `Open ${name}'s videos`, expect: 'Latest' },
    { do: 'read', target: 'the first video', as: 'title', say: 'Read the newest title' },
    { do: 'answer', text: `The newest video from ${name} is “{title}”.` },
  ]
}

const plus = (text) => encodeURIComponent(String(text).trim()).replace(/%20/g, '+')

/** The plan for this goal, when one of the recipes fits it. */
export function recipe(goal) {
  const said = String(goal ?? '').trim()
  for (const one of RECIPES) {
    const caught = one.match.exec(said)
    if (caught) return one.steps(caught)
  }
  return undefined
}
