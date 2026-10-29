// SPDX-License-Identifier: AGPL-3.0-only
import type { ResearchUpdate, ResearchSource } from '../../core/src/research.js'
import { ResearchSpider, type Point } from './research-spider.js'
import { ReadingText, type ReadingWord, type Letter } from './research-text.js'

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** An observer only: pinning, hiding and animation never send commands to a provider. */
export function researchViewer(host: { plugin: string; send(path: string, body: unknown): Promise<Record<string, unknown>> }): HTMLElement {
  const root = make('section', 'research-viewer')
  root.setAttribute('aria-label', 'Research activity')
  const heading = make('div', 'research-heading')
  const topic = make('strong', 'research-topic', 'Ready for research')
  const stage = make('span', 'research-stage', 'Waiting')
  stage.setAttribute('role', 'status')
  heading.append(topic, stage)
  const toolbar = make('div', 'research-toolbar')
  const currentTitle = make('span', 'research-source-title', 'Sources appear as Alexia reads them.')
  const follow = make('button', 'quiet-button', 'Follow latest')
  follow.type = 'button'
  follow.hidden = true
  toolbar.append(currentTitle, follow)
  const frame = make('div', 'research-frame')
  const preview = make('div', 'research-preview')
  const canvas = make('canvas', 'research-spider')
  canvas.setAttribute('aria-hidden', 'true')
  frame.append(preview, canvas)
  const counters = make('p', 'research-counters', '0 read · 0 in progress · 0 unavailable')
  const history = make('div', 'research-history')
  history.setAttribute('aria-label', 'Source history')
  const footer = make('div', 'research-footer')
  root.append(heading, toolbar, frame, counters, history, footer)
  let snapshot: ResearchUpdate | undefined
  let pinned: string | undefined
  let shown = ''
  let raf = 0
  let lastFrame = 0
  let lastSequence = -1
  let visible = false
  let dead = false
  let timer: number | undefined
  let previewRequest: AbortController | undefined
  let previewURL: string | undefined
  let reportRequest: AbortController | undefined
  let spider: ResearchSpider | undefined
  let pointer: Point | undefined
  let reading: ReadingText | undefined
  let layoutDirty = true
  let cursor = 0
  let phase: 'land' | 'walk' = 'land'
  let started = false
  let wasWalking = false
  let scroll = 0
  let routeKey = ''
  let dwell = 0
  let activeMarker: HTMLElement | undefined
  let autoScrollUntil = 0
  let manualScrollUntil = 0
  let plucks: { word: ReadingWord; from: Point; at: number }[] = []
  const picked = new Set<string>()
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const url = (source?: string): string => `/api/research-file?${new URLSearchParams({ plugin: host.plugin, run: snapshot?.runId ?? '', ...(source === undefined ? { kind: 'report' } : { source }) })}`
  const file = async (path: string, signal: AbortSignal): Promise<Blob> => {
    const token = document.querySelector<HTMLElement>('[data-token]')?.dataset.token ?? ''
    const response = await fetch(path, { headers: { 'x-alexia-token': token }, signal })
    if (!response.ok) throw new Error('Research file unavailable')
    return response.blob()
  }
  const clearPreview = (): void => {
    previewRequest?.abort(); previewRequest = undefined
    if (previewURL) URL.revokeObjectURL(previewURL)
    previewURL = undefined
  }

  const highlight = (marker?: HTMLElement): void => {
    if (marker === activeMarker) return
    activeMarker?.removeAttribute('data-spider-active')
    activeMarker = marker
    marker?.setAttribute('data-spider-active', '')
  }
  function passages(): void {
    const markers = [...preview.querySelectorAll<HTMLElement>('.research-marker:not(.research-page-marker)[data-passage]')]
    const key = `${snapshot?.runId}:${preview.dataset.source}:${markers.map((m) => `${m.dataset.passage}:${m.textContent || m.title}`).join('|')}`
    if (key !== routeKey) {
      routeKey = key; dwell = 0; plucks = []; pointer = undefined; highlight()
      reading = undefined; cursor = 0; phase = 'land'; started = false; wasWalking = false; picked.clear()
      scroll = preview.scrollTop
    }
    layoutDirty = true
    animate()
  }
  function draw(time: number): void {
    raf = 0
    const ctx = canvas.getContext('2d')
    if (!ctx || !visible || document.hidden || dead || !root.isConnected) return
    const box = frame.getBoundingClientRect()
    if (!box.width || !box.height) return
    const scale = Math.min(window.devicePixelRatio || 1, 2)
    if (canvas.width !== Math.round(box.width * scale)) canvas.width = Math.round(box.width * scale)
    if (canvas.height !== Math.round(box.height * scale)) canvas.height = Math.round(box.height * scale)
    ctx.setTransform(scale, 0, 0, scale, 0, 0); ctx.clearRect(0, 0, box.width, box.height)
    const style = getComputedStyle(root)
    const accent = style.getPropertyValue('--accent').trim() || style.color
    const surface = style.getPropertyValue('--surface-sunken').trim() || getComputedStyle(frame).backgroundColor
    const bound = (p: Point): Point => ({ x: Math.min(Math.max(p.x, Math.min(36, box.width / 2)), Math.max(box.width - 36, box.width / 2)), y: Math.min(Math.max(p.y, Math.min(36, box.height / 2)), Math.max(box.height - 36, box.height / 2)) })
    const dock = bound({ x: box.width - 32, y: box.height - 32 })
    spider ??= new ResearchSpider(dock)
    const viewport = preview.getBoundingClientRect()
    if (layoutDirty) {
      const previous = reading?.steps[cursor]?.word.id
      reading = new ReadingText(preview, snapshot?.topic ?? '', `${snapshot?.runId}:${preview.dataset.source}`)
      if (previous) { const next = reading.steps.findIndex((s) => s.word.id === previous); cursor = next < 0 ? Math.min(cursor, reading.steps.length) : next }
      layoutDirty = false; started = false; phase = 'land'; dwell = 0
    }
    const running = snapshot?.completion === 'running'
    const step = running && !pointer && !motion.matches ? reading?.steps[cursor] : undefined
    let target = dock
    let marker: HTMLElement | undefined
    let offset = { x: viewport.left - box.left - preview.scrollLeft, y: viewport.top - box.top - preview.scrollTop }
    if (step) {
      marker = step.word.passage
      const top = step.first.top + offset.y
      if (time > manualScrollUntil && (top < 12 || top > viewport.height - 40)) {
        autoScrollUntil = time + 100
        preview.scrollTop += top - 36
        offset = { x: viewport.left - box.left - preview.scrollLeft, y: viewport.top - box.top - preview.scrollTop }
      }
    }
    if (wasWalking && !pointer && scroll !== preview.scrollTop) spider.shift({ x: 0, y: scroll - preview.scrollTop })
    scroll = preview.scrollTop
    const onPage = (letter: Letter): Point => ({ x: letter.x + offset.x, y: letter.y + offset.y })
    const ground: Point[] = []
    for (const letter of reading?.letters ?? []) {
      const point = onPage(letter)
      if (point.x >= 0 && point.x <= box.width && point.y >= 0 && point.y <= box.height) ground.push(point)
    }
    if (pointer) {
      target = bound(pointer)
      marker = [...preview.querySelectorAll<HTMLElement>('.research-marker')].find((m) => {
        const r = m.getBoundingClientRect()
        return pointer!.x + box.left >= r.left && pointer!.x + box.left <= r.right && pointer!.y + box.top >= r.top && pointer!.y + box.top <= r.bottom
      })
      spider.ground(marker && !marker.classList.contains('research-page-marker') ? ground : undefined, false)
      wasWalking = false
    } else if (step) {
      const letter = phase === 'land' ? step.first : step.last
      const point = onPage(letter)
      // The chassis rides above the text; its contact pads use actual character boxes.
      target = { x: point.x, y: Math.max(18, point.y - 10) }
      spider.ground(ground)
      if (!started) {
        if (phase === 'land' && step.jump) spider.jump(target, time)
        started = true
      }
      wasWalking = true
    } else {
      spider.ground(undefined)
      if (wasWalking && running && !motion.matches) spider.jump(dock, time)
      wasWalking = false
    }
    highlight(marker)
    if (!running && !pointer) { spider.stop(); target = spider.position }
    spider.move(target)
    const moving = spider.advance(time, motion.matches)
    spider.grip = 0
    if (step && spider.arrived && !spider.airborne) {
      if (phase === 'land') { phase = 'walk'; started = false }
      else {
        const pick = step.pick && !picked.has(step.word.id)
        if (pick && !dwell) dwell = time + 150
        spider.grip = pick ? Math.min(1, 1 - (dwell - time) / 150) : 0
        if (!pick || time >= dwell) {
          if (pick) {
            const letter = step.last
            plucks.push({ word: step.word, from: { x: letter.left + letter.width + offset.x, y: letter.top + letter.height / 2 + offset.y }, at: time })
            picked.add(step.word.id)
          }
          cursor++; phase = 'land'; started = false; dwell = 0
        }
      }
    }
    // A word is picked from its real text position. The original evidence stays readable.
    const markedWords = motion.matches ? reading?.words.filter((word) => word.interesting) ?? [] : step?.pick && !picked.has(step.word.id) ? [step.word] : []
    for (const word of markedWords) {
      for (const letter of word.letters) {
        ctx.fillStyle = accent; ctx.globalAlpha = .18
        ctx.fillRect(letter.left + offset.x, letter.top + offset.y, letter.width, letter.height)
      }
      ctx.globalAlpha = 1
    }
    plucks = motion.matches ? [] : plucks.filter((p) => time - p.at < 750)
    for (const pick of plucks) {
      const p = Math.min(1, (time - pick.at) / 750)
      const ease = p * p * (3 - 2 * p)
      const x = pick.from.x + (dock.x - pick.from.x) * ease
      const y = pick.from.y + (dock.y - pick.from.y) * ease - Math.sin(p * Math.PI) * 38
      ctx.save(); ctx.font = pick.word.font; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
      ctx.translate(x, y); ctx.scale(1 - p * .3, 1 - p * .3); ctx.globalAlpha = 1 - p * .65
      const width = ctx.measureText(pick.word.text).width
      ctx.fillStyle = surface; ctx.fillRect(-width - 5, -10, width + 10, 20)
      ctx.strokeStyle = accent; ctx.lineWidth = 1; ctx.strokeRect(-width - 5, -10, width + 10, 20)
      ctx.fillStyle = accent; ctx.fillText(pick.word.text, 0, 0); ctx.restore()
    }
    ctx.strokeStyle = accent; ctx.globalAlpha = .65; ctx.strokeRect(dock.x - 5, dock.y - 5, 10, 10); ctx.globalAlpha = 1
    spider.draw(ctx, accent, surface, style.color)
    if (!motion.matches && (moving || (running && (reading?.steps.length ?? 0) > cursor && !pointer) || plucks.length > 0)) raf = requestAnimationFrame(tick)
  }
  function tick(time: number): void {
    if (time - lastFrame < 1000 / 30) { raf = requestAnimationFrame(tick); return }
    lastFrame = time
    draw(time)
  }
  function animate(): void {
    if (dead || !visible || document.hidden) return
    if (motion.matches) { cancelAnimationFrame(raf); draw(performance.now()) }
    else if (!raf) raf = requestAnimationFrame(tick)
  }

  function show(source: ResearchSource | undefined): void {
    const key = `${snapshot?.runId ?? ''}:${source?.id ?? ''}:${source?.preview ?? ''}:${source?.state ?? ''}:${JSON.stringify(source?.passages)}`
    if (key === shown) return
    const changedSource = source?.id !== preview.dataset.source
    if (changedSource && preview.childNodes.length && !motion.matches) {
      const old = preview.cloneNode(true) as HTMLElement
      old.classList.add('research-leaving')
      old.setAttribute('aria-hidden', 'true')
      frame.querySelector('.research-leaving')?.remove()
      frame.append(old)
      window.setTimeout(() => old.remove(), 220)
    }
    shown = key
    clearPreview()
    preview.dataset.source = source?.id ?? ''
    preview.replaceChildren()
    if (!source) { reading = undefined; cursor = 0; routeKey = ''; plucks = []; highlight(); currentTitle.textContent = 'Discovering sources…'; preview.append(make('p', 'hint', snapshot?.stage === 'searching' ? 'Searching the public web…' : 'Waiting for a source.')); return }
    let domain = ''
    try { domain = new URL(source.url).hostname } catch { /* validated by host */ }
    currentTitle.textContent = `${source.title || domain} · ${domain}`
    const readingView = (): void => {
      preview.replaceChildren(make('span', 'research-reading-label', 'Reading view · snapshot unavailable'))
      if (!source.passages.length) preview.append(make('p', 'hint', source.error ?? 'Fetching page content…'))
      for (const passage of source.passages) {
        const mark = make('mark', 'research-marker', passage.text)
        mark.dataset.passage = passage.id
        preview.append(mark)
      }
      passages()
    }
    if (!source.preview) { readingView(); return }
    const image = make('img', 'research-snapshot')
    image.alt = `Captured page: ${source.title}`
    image.addEventListener('error', () => { if (!dead && shown === key) readingView() }, { once: true })
    image.addEventListener('load', passages, { once: true })
    const capture = make('div', 'research-capture')
    capture.append(image)
    preview.append(capture)
    for (const passage of source.passages) if (passage.box) {
      const mark = make('span', 'research-marker research-page-marker')
      mark.dataset.passage = passage.id
      mark.title = passage.text
      mark.setAttribute('aria-label', passage.text)
      Object.assign(mark.style, { left: `${passage.box.x * 100}%`, top: `${passage.box.y * 100}%`, width: `${passage.box.width * 100}%`, height: `${passage.box.height * 100}%` })
      capture.append(mark)
    }
    // The labelled reading text supplies real glyph geometry; screenshots remain images.
    if (source.passages.length) {
      preview.append(make('span', 'research-reading-label', 'Selected passages · reading view'))
      for (const p of source.passages) {
        const mark = make('mark', 'research-marker', p.text); mark.dataset.passage = p.id; preview.append(mark)
      }
    }
    const request = new AbortController()
    previewRequest = request
    void file(url(source.id), request.signal).then((blob) => {
      if (dead || shown !== key || request.signal.aborted || !root.isConnected) return
      previewURL = URL.createObjectURL(blob)
      image.src = previewURL
    }).catch(() => { if (!dead && shown === key && !request.signal.aborted) readingView() })
    passages()
  }

  function paint(): void {
    if (!snapshot) return
    topic.textContent = snapshot.topic
    const labels = { searching: 'Searching', reading: 'Reading', writing: 'Writing', finished: 'Finished' }
    const elapsed = snapshot.completion === 'running' ? Date.now() - snapshot.startedAt : snapshot.elapsedMs
    stage.textContent = `${snapshot.completion === 'failed' ? 'Failed' : snapshot.completion === 'cancelled' ? 'Cancelled' : labels[snapshot.stage]} · ${Math.max(0, Math.floor(elapsed / 1000))}s`
    const c = snapshot.counters
    counters.textContent = `${c.read} read · ${c.inProgress} in progress · ${c.failed} unavailable`
    follow.hidden = pinned === undefined
    const selected = snapshot.sources.find((s) => s.id === (pinned ?? snapshot?.currentSourceId)) ?? snapshot.sources.at(-1)
    show(selected)
    history.replaceChildren()
    for (const source of [...snapshot.sources].reverse()) {
      const row = make('button', 'research-history-entry')
      row.type = 'button'
      row.setAttribute('aria-pressed', String(source.id === selected?.id))
      row.append(make('span', 'research-history-title', source.title || source.url), make('span', 'research-source-state', source.state === 'complete' ? 'Read' : source.state === 'fetching' ? 'Fetching' : 'Unavailable'))
      row.title = source.error ?? source.url
      row.addEventListener('click', () => { pinned = source.id; paint() })
      history.append(row)
    }
    footer.replaceChildren()
    if (snapshot.report) {
      const link = make('a', 'quiet-button', 'Download Markdown report')
      link.href = url(); link.download = snapshot.report.name
      const runId = snapshot.runId
      link.addEventListener('click', (event) => {
        event.preventDefault()
        if (reportRequest) return
        const request = new AbortController()
        reportRequest = request
        void file(link.getAttribute('href')!, request.signal).then((blob) => {
          if (dead || snapshot?.runId !== runId || request.signal.aborted) return
          const objectURL = URL.createObjectURL(blob)
          const save = document.createElement('a')
          save.href = objectURL; save.download = link.download
          document.body.append(save); save.click(); save.remove()
          window.setTimeout(() => URL.revokeObjectURL(objectURL), 1000)
        }).catch(() => { if (!request.signal.aborted) link.textContent = 'Download unavailable · retry' })
          .finally(() => { if (reportRequest === request) reportRequest = undefined })
      })
      footer.append(link)
    }
    for (const gap of snapshot.gaps) footer.append(make('p', 'hint', gap))
    animate()
  }
  follow.addEventListener('click', () => { pinned = undefined; paint() })
  const observer = new IntersectionObserver((entries) => { visible = entries.some((e) => e.isIntersecting); if (visible) animate(); else { cancelAnimationFrame(raf); raf = 0 } })
  observer.observe(root)
  const visibility = (): void => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0 } else animate() }
  document.addEventListener('visibilitychange', visibility)
  motion.addEventListener('change', animate)
  preview.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch') return
    const r = frame.getBoundingClientRect()
    pointer = { x: event.clientX - r.left, y: event.clientY - r.top }
    dwell = 0; animate()
  }, { passive: true })
  preview.addEventListener('pointerleave', () => { pointer = undefined; animate() })
  preview.addEventListener('scroll', () => {
    const now = performance.now()
    if (now > autoScrollUntil) manualScrollUntil = now + 1000
    animate()
  }, { passive: true })
  const resize = new ResizeObserver(() => { layoutDirty = true; animate() })
  resize.observe(frame); resize.observe(preview)
  const fontsReady = (): void => { layoutDirty = true; animate() }
  document.fonts?.addEventListener('loadingdone', fontsReady)
  void document.fonts?.ready.then(() => { if (!dead) fontsReady() })
  function dispose(): void {
    dead = true; cancelAnimationFrame(raf); window.clearTimeout(timer)
    clearPreview(); reportRequest?.abort()
    observer.disconnect(); resize.disconnect()
    document.removeEventListener('visibilitychange', visibility)
    motion.removeEventListener('change', animate)
    document.fonts?.removeEventListener('loadingdone', fontsReady)
  }
  async function poll(): Promise<void> {
    if (!root.isConnected) { dispose(); return }
    if (!document.hidden && visible) {
      try {
        const answer = await host.send('/api/research', { plugin: host.plugin })
        if (dead) return
        if (!root.isConnected) { dispose(); return }
        const next = answer.snapshot as ResearchUpdate | null
        if (next === null) {
          if (snapshot !== undefined) {
            clearPreview(); reportRequest?.abort()
            spider = undefined; reading = undefined; cursor = 0; routeKey = ''; plucks = []; picked.clear(); highlight()
            snapshot = undefined; pinned = undefined; shown = ''; lastSequence = -1
            topic.textContent = 'Ready for research'; stage.textContent = 'Waiting'
            preview.replaceChildren(); history.replaceChildren(); footer.replaceChildren()
            counters.textContent = '0 read · 0 in progress · 0 unavailable'
            currentTitle.textContent = 'Sources appear as Alexia reads them.'
            cancelAnimationFrame(raf); raf = 0; animate()
          }
        } else if (next.runId !== snapshot?.runId || next.conversationId !== snapshot.conversationId || next.sequence > lastSequence) {
          if (next.runId !== snapshot?.runId) { pinned = undefined; shown = ''; reportRequest?.abort() }
          snapshot = next; lastSequence = next.sequence; paint()
        } else if (snapshot?.completion === 'running') {
          stage.textContent = `${{ searching: 'Searching', reading: 'Reading', writing: 'Writing', finished: 'Finished' }[snapshot.stage]} · ${Math.max(0, Math.floor((Date.now() - snapshot.startedAt) / 1000))}s`
        }
      } catch { /* A reconnect keeps the last honest snapshot. */ }
    }
    if (!dead) timer = window.setTimeout(() => void poll(), snapshot?.completion === 'running' ? 350 : 1000)
  }
  timer = window.setTimeout(() => void poll(), 0)
  return root
}
