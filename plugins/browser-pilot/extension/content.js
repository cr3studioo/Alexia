// SPDX-License-Identifier: AGPL-3.0-only
/* global Event */
/**
 * The page side of browser-pilot. `background.js` injects this file into one tab when Alexia asks
 * for something there, then calls `globalThis.__alexiaPilot.run({ do, args })`.
 *
 * It reads the page as text and lists the controls on it, each tagged with a `ref`
 * (`data-alexia-ref`) that stays put for the life of the page. It never reads what a password
 * field holds, and never puts any field's value into the text or the controls.
 *
 * Injected more than once into the same page, it keeps its first copy: the guard below means the
 * refs it handed out stay valid.
 */
globalThis.__alexiaPilot ??= (() => {
  const REF = 'data-alexia-ref'
  const MAX_TEXT = 200 * 1024
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION'])
  const BLOCK = new Set([
    'P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'NAV', 'ASIDE', 'LI', 'UL', 'OL', 'TR', 'TABLE',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BR', 'HR', 'FORM', 'FIELDSET', 'BLOCKQUOTE', 'PRE', 'DT', 'DD',
  ])
  const CONTROLS =
    'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [role="menuitem"], [contenteditable="true"]'
  const BUTTON_INPUTS = new Set(['submit', 'button', 'reset', 'image'])
  let nextRef = 1

  const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
  const attr = (el, name) => squash(el.getAttribute?.(name))

  /** Shown on screen: not `hidden`, not aria-hidden, and laid out (where the browser can say). */
  function visible(el) {
    if (el.hidden || el.getAttribute?.('aria-hidden') === 'true') return false
    if (el.tagName === 'INPUT' && el.type === 'hidden') return false
    return typeof el.checkVisibility === 'function' ? el.checkVisibility({ visibilityProperty: true }) : true
  }

  /** The page as text: what is shown, with block elements on their own lines. No field values. */
  function pageText(doc) {
    const out = []
    const walk = (node) => {
      if (node.nodeType === 3) return void out.push(node.nodeValue)
      if (node.nodeType !== 1 || SKIP.has(node.tagName) || !visible(node)) return
      const block = BLOCK.has(node.tagName)
      if (block) out.push('\n')
      for (const child of node.childNodes ?? []) walk(child)
      if (block) out.push('\n')
    }
    if (doc.body) walk(doc.body)
    const text = out.join('').split('\n').map(squash).filter(Boolean).join('\n')
    return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text
  }

  function role(el) {
    const given = attr(el, 'role')
    if (given) return given
    if (el.isContentEditable || el.getAttribute?.('contenteditable') === 'true') return 'textbox'
    switch (el.tagName) {
      case 'A': return 'link'
      case 'BUTTON': case 'SUMMARY': return 'button'
      case 'SELECT': return 'combobox'
      case 'TEXTAREA': return 'textbox'
      case 'INPUT': {
        const type = String(el.type || 'text').toLowerCase()
        if (BUTTON_INPUTS.has(type)) return 'button'
        if (type === 'checkbox' || type === 'radio') return type
        return 'textbox'
      }
      default: return 'generic'
    }
  }

  /**
   * What a control says, the way the owner would name it. A field's value is never its name —
   * except a button input, whose value *is* its caption. A password field's value never is.
   */
  function name(el) {
    const label = attr(el, 'aria-label')
    if (label) return label
    const labelledBy = attr(el, 'aria-labelledby')
    if (labelledBy) {
      const text = labelledBy.split(' ').map((id) => squash(el.ownerDocument?.getElementById?.(id)?.textContent)).filter(Boolean).join(' ')
      if (text) return text
    }
    const labels = [...(el.labels ?? [])].map((l) => squash(l.textContent)).filter(Boolean)
    if (labels.length > 0) return labels.join(' ')
    if (el.tagName === 'INPUT') {
      const type = String(el.type || 'text').toLowerCase()
      if (BUTTON_INPUTS.has(type)) return squash(el.value) || attr(el, 'alt') || attr(el, 'title')
      return attr(el, 'placeholder') || attr(el, 'title') || attr(el, 'name')
    }
    if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return attr(el, 'placeholder') || attr(el, 'title') || attr(el, 'name')
    return squash(el.textContent) || attr(el, 'title') || attr(el, 'alt')
  }

  const fillable = (el) =>
    el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable || el.getAttribute?.('contenteditable') === 'true' ||
    (el.tagName === 'INPUT' && !BUTTON_INPUTS.has(String(el.type || 'text').toLowerCase()) && el.type !== 'checkbox' && el.type !== 'radio')

  /** Every visible control, tagged with its ref (given once, then kept). */
  function controls(doc) {
    return [...doc.querySelectorAll(CONTROLS)].filter(visible).map((el) => {
      let ref = el.getAttribute(REF)
      if (!ref) {
        ref = `e${nextRef++}`
        el.setAttribute(REF, ref)
      }
      return { ref, role: role(el), name: name(el), el }
    })
  }

  /**
   * The one control `wanted` names among `list` ({ name, el }): the exact name first, then a
   * case-insensitive part of it. More than one match is refused, never guessed between.
   */
  function pick(list, wanted, what) {
    const want = squash(wanted)
    if (!want) return { error: `Say which ${what}.` }
    const lower = want.toLowerCase()
    for (const match of [(c) => c.name === want, (c) => c.name.toLowerCase().includes(lower)]) {
      const found = list.filter(match)
      if (found.length === 1) return { el: found[0].el }
      if (found.length > 1) return { error: `${found.length} ${what}s on the page match "${want}". Use its ref from browser_read instead.` }
    }
    return { error: `No ${what} on the page matches "${want}".` }
  }

  /** The element `by` points at: `{ ref }`, `{ text }` (click) or `{ label }` (fill). */
  function find(doc, by, forFill = false) {
    const what = forFill ? 'field' : 'control'
    if (typeof by.ref === 'string') {
      // Refs are ours: `e` and a number. Anything else would be a selector smuggled in.
      if (!/^e\d+$/.test(by.ref)) return { error: `There is no ${what} with ref ${by.ref}.` }
      const el = doc.querySelector(`[${REF}="${by.ref}"]`)
      if (!el || !visible(el)) return { error: `There is no ${what} with ref ${by.ref} on the page now. Read the page again.` }
      return { el }
    }
    const list = controls(doc).filter((c) => !forFill || fillable(c.el))
    return pick(list, forFill ? by.label : by.text, what)
  }

  /** The small "Alexia" mark in the corner while she acts on the page. */
  function badge(doc) {
    if (!doc.documentElement || !doc.createElement) return
    const mark = doc.createElement('div')
    mark.textContent = 'Alexia'
    mark.setAttribute('aria-live', 'polite')
    mark.setAttribute('style', 'position:fixed;top:8px;right:8px;z-index:2147483647;padding:3px 9px;border-radius:9px;background:#5b3df5;color:#fff;font:600 12px system-ui,sans-serif;pointer-events:none;box-shadow:0 1px 4px rgba(0,0,0,.3)')
    doc.documentElement.appendChild(mark)
    setTimeout(() => mark.remove?.(), 1500)
  }

  function setValue(el, value) {
    if (el.tagName === 'SELECT') {
      const option = [...el.options].find((o) => squash(o.textContent) === squash(value) || o.value === value)
      if (!option) return `That list has no choice "${value}".`
      el.value = option.value
    } else if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
      el.textContent = value
    } else {
      // Through the prototype's setter, so a page that tracks its own fields (React) sees it.
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set
      if (setter) setter.call(el, value)
      else el.value = value
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  const here = (doc) => ({ title: String(doc.title ?? ''), url: String(doc.location?.href ?? '') })

  /** One request from the background: `{ ok, result }` or `{ ok: false, error }`. */
  function run(request, doc = globalThis.document) {
    const args = request?.args ?? {}
    switch (request?.do) {
      case 'read':
        return { ok: true, result: { ...here(doc), text: pageText(doc), controls: controls(doc).map(({ ref, role, name }) => ({ ref, role, name })) } }
      case 'click': {
        const { el, error } = find(doc, args)
        if (error) return { ok: false, error }
        badge(doc)
        el.scrollIntoView?.({ block: 'center' })
        el.click()
        return { ok: true, result: here(doc) }
      }
      case 'fill': {
        if (typeof args.value !== 'string') return { ok: false, error: 'Say what to type.' }
        const { el, error } = find(doc, args, true)
        if (error) return { ok: false, error }
        if (!fillable(el)) return { ok: false, error: "That control can't be typed into." }
        badge(doc)
        el.scrollIntoView?.({ block: 'center' })
        el.focus?.()
        const refused = setValue(el, args.value)
        return refused ? { ok: false, error: refused } : { ok: true, result: {} }
      }
      default:
        return { ok: false, error: 'The page cannot do that.' }
    }
  }

  return { run, pageText, controls, find, pick, name, role }
})()
