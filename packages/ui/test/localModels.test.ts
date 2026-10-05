// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { modelBytes, mountLocalModels, type Card, type Job, type LocalModelsView, type LocalRequest, type Overview } from '../src/local-models.js'

const GB = 1024 ** 3
const model = (changes: Partial<Card> = {}): Card => ({
  entry: 'qwen', name: 'Qwen', blurb: 'A capable chat model.', publisher: 'Qwen', params: 8,
  quant: 'Q4_K_M', bytes: 5 * GB, needBytes: 8 * GB, verdict: 'fits', tools: true, vision: false,
  licence: { name: 'Apache 2.0', url: 'https://example.org/licence', restrictive: false },
  installed: false, abliterated: false,
  quants: [
    { quant: 'Q4_K_M', bytes: 5 * GB, needBytes: 8 * GB, verdict: 'fits' },
    { quant: 'Q5_K_M', bytes: 6 * GB, needBytes: 10 * GB, verdict: 'tight', note: 'Close other apps.' },
    { quant: 'Q8_0', bytes: 10 * GB, needBytes: 20 * GB, verdict: 'too-big' },
    { quant: 'Q2_K', bytes: 3 * GB, needBytes: 6 * GB, verdict: 'disk' },
  ], ...changes,
})
const job = (changes: Partial<Job> = {}): Job => ({
  id: 'job/1', target: 'qwen:Q5_K_M', name: 'Qwen Q5_K_M', step: 'queued', done: 0, total: 0,
  message: 'Getting ready', startedAt: Date.now(), ...changes,
})
const overview = (changes: Partial<Overview> = {}): Overview => ({
  machine: { summary: 'Apple M2 · 16 GB RAM', ramBytes: 16 * GB, budgetBytes: 12 * GB, freeDiskBytes: 50 * GB, appleSilicon: true, chip: 'M2' },
  runtime: { installed: false, version: '', supported: true },
  picks: { best: model(), fast: model(), tools: model() }, all: [model()],
  uncensored: [model({ entry: 'uncensored', name: 'Uncensored Qwen', abliterated: true })],
  installed: [], jobs: [], mode: 'combined', ...changes,
})
const installed = () => ({ id: 'llama/publisher/qwen:Q4_K_M', name: 'Qwen Q4_K_M', quant: 'Q4_K_M', bytes: 5 * GB, vetted: true, abliterated: false, tools: false, vision: false, context: 8192, pinned: true, tokensPerSecond: 12.5 })
const flush = async (): Promise<void> => { for (let i = 0; i < 30; i++) await Promise.resolve() }
let views: LocalModelsView[] = []
beforeEach(() => { vi.useFakeTimers(); document.body.replaceChildren() })
afterEach(() => { views.forEach((view) => view.close()); views = []; vi.useRealTimers(); vi.unstubAllGlobals() })

function mount(state = overview(), respond?: LocalRequest, extra: { firstRun?: boolean; ready?: (ready: boolean) => void; mode?: () => string } = {}) {
  const root = document.createElement('section')
  document.body.append(root)
  const request = vi.fn<LocalRequest>(respond ?? (async (path) => path === '/api/local-models' ? state : { ok: true }))
  const changed = vi.fn()
  const view = mountLocalModels(root, { request, changed, ...extra })
  views.push(view)
  view.open()
  return { root, request, changed, view }
}
const press = (root: HTMLElement, label: string): HTMLButtonElement => {
  const button = [...root.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent === label)
  expect(button, `Missing button: ${label}`).toBeDefined()
  button!.click()
  return button!
}
const selectQuant = (root: HTMLElement, value: string): void => {
  const select = root.querySelector<HTMLSelectElement>('select')!
  select.value = value
  select.dispatchEvent(new Event('change'))
}

test('recommendations use native quant controls, disclose licence/tool checks, and block sizes that cannot fit', async () => {
  const { root, request } = mount(overview({ picks: { best: model({ tokensPerSecond: 99 }) } }))
  await flush()
  expect(root.querySelectorAll('.local-model-grid')[0]!.children).toHaveLength(1)
  expect(root.textContent).toContain('Apple M2')
  expect(root.textContent).toContain('Tool use is provisional; checked during install')
  expect(root.textContent).not.toContain('99')
  const card = root.querySelector('.local-model-card')!
  expect(card.querySelector('a')!.href).toBe('https://example.org/licence')
  expect(card.querySelector('a')!.compareDocumentPosition(card.querySelector('button')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect([...root.querySelectorAll('details')].find((one) => one.querySelector('summary')?.textContent === 'Uncensored')!.open).toBe(false)
  selectQuant(root, 'Q8_0')
  expect(card.querySelector('button')!.disabled).toBe(true)
  expect(card.textContent).toContain('Too large')
  selectQuant(root, 'Q2_K')
  expect(card.querySelector('button')!.disabled).toBe(true)
  expect(card.textContent).toContain('Not enough disk')
  expect(request).toHaveBeenCalledWith('/api/local-models', undefined, expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }))
  expect(modelBytes(Infinity)).toBe('unknown')
})

test('cloud installation requires an explicit Local/Combined choice; going back calls no API', async () => {
  const state = overview({ mode: 'cloud' })
  const { root, request } = mount(state, async (path) => path.endsWith('/install') ? job() : state)
  await flush()
  selectQuant(root, 'Q5_K_M')
  press(root, 'Install & use')
  expect(request).toHaveBeenCalledTimes(1)
  press(root, 'Keep Cloud — go back')
  expect(request).toHaveBeenCalledTimes(1)
  press(root, 'Install & use')
  press(root, 'Install and use Combined')
  await flush()
  expect(request).toHaveBeenCalledWith('/api/local-models/install', { entry: 'qwen', quant: 'Q5_K_M', mode: 'combined' }, expect.objectContaining({ method: 'POST' }))
  expect(root.querySelector('.local-mode')!.childElementCount).toBe(0)
  expect(root.querySelector('progress')!.hasAttribute('value')).toBe(false)
})

test('progress survives a network failure, reports each phase, and preserves core’s tool downgrade message', async () => {
  const state = overview()
  const next = [
    new Error('Network offline'),
    job({ step: 'runtime', message: 'Getting the model runner' }),
    job({ step: 'download', done: GB, total: 6 * GB, bytesPerSecond: 2 * 1024 ** 2, message: 'Downloading Qwen' }),
    job({ step: 'verify', message: 'Checking the file' }),
    job({ step: 'start', message: 'Starting Qwen' }),
    job({ step: 'test', message: 'Trying it out' }),
    job({ step: 'done', modelId: installed().id, message: 'Qwen is ready for chat; its tool check did not pass' }),
  ]
  const { root, request, changed } = mount(state, async (path) => {
    if (path.endsWith('/install')) { const started = job(); state.jobs = [started]; return started }
    if (path.includes('/progress?')) {
      const value = next.shift()!
      if (value instanceof Error) throw value
      state.jobs = [value]
      if (value.step === 'done') state.installed = [installed()]
      return value
    }
    return state
  })
  await flush()
  selectQuant(root, 'Q5_K_M')
  press(root, 'Install & use')
  await flush()
  for (const phrase of ['Network offline', 'Getting the model runner', 'Downloading Qwen', 'Checking the file', 'Starting Qwen', 'Trying it out', 'tool check did not pass']) {
    await vi.advanceTimersByTimeAsync(1000)
    await flush()
    expect(root.textContent).toContain(phrase)
    if (phrase === 'Downloading Qwen') {
      expect(root.querySelector('progress')!.value).toBe(GB)
      expect(root.textContent).toContain('2 MB/s')
      expect(root.textContent).toContain('elapsed')
    }
  }
  expect(root.textContent).toContain('12.5 tokens/s measured')
  expect(root.textContent).toContain('For chat')
  expect(changed).toHaveBeenCalledTimes(1)
  const count = request.mock.calls.length
  await vi.advanceTimersByTimeAsync(10_000)
  expect(request).toHaveBeenCalledTimes(count)
})

test('cancellation and failed installs can be resumed/retried with the original quant', async () => {
  const state = overview()
  let current = job()
  const { root, request } = mount(state, async (path) => {
    if (path.endsWith('/install')) { current = job(); state.jobs = [current]; return current }
    if (path.endsWith('/cancel')) { current = job({ step: 'cancelled', message: 'Cancelled; parts kept.' }); state.jobs = [current]; return { ok: true } }
    if (path.includes('/progress?')) return current
    return state
  })
  await flush()
  selectQuant(root, 'Q5_K_M')
  press(root, 'Install & use')
  await flush()
  press(root, 'Cancel download')
  await flush()
  expect(request).toHaveBeenCalledWith('/api/local-models/cancel', { job: 'job/1' }, expect.objectContaining({ method: 'POST' }))
  await vi.advanceTimersByTimeAsync(1000)
  press(root, 'Resume download')
  await flush()
  current = job({ step: 'failed', error: 'Checksum did not match', message: 'It did not finish' })
  state.jobs = [current]
  await vi.advanceTimersByTimeAsync(1000)
  expect(root.textContent).toContain('Checksum did not match')
  press(root, 'Retry install')
  await flush()
  expect(request.mock.calls.filter(([path]) => path.endsWith('/install')).map(([, body]) => body)).toEqual(Array(3).fill({ entry: 'qwen', quant: 'Q5_K_M' }))
})

test('closing aborts requests and timers; a late response cannot redraw a reopened view', async () => {
  const state = overview({ jobs: [job()] })
  let resolve!: (value: unknown) => void
  const { root, request, view } = mount(state, async (path) => {
    if (path.includes('/progress?')) return new Promise((done) => { resolve = done })
    return state
  })
  await flush()
  await vi.advanceTimersByTimeAsync(1000)
  const signal = request.mock.calls.at(-1)![2]!.signal!
  view.close()
  expect(signal.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
  state.jobs = []
  view.open()
  await flush()
  resolve(job({ step: 'failed', error: 'Old failure' }))
  await flush()
  expect(root.textContent).not.toContain('Old failure')
  expect(root.querySelector('.local-job')).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})

test('installed actions pass core’s namespaced IDs, keep Cloud without a request, and confirm removal', async () => {
  const state = overview({ mode: 'cloud', installed: [installed()] })
  const { root, request } = mount(state, async (path, body) => {
    if (path.endsWith('/use')) { state.mode = (body as { mode: 'local' }).mode; return { ok: true, said: 'Local selected' } }
    if (path.includes('/llama%2F')) { state.installed = []; return { ok: true, said: 'Removed' } }
    return state
  })
  await flush()
  press(root, 'Use this')
  press(root, 'Keep Cloud — go back')
  expect(request).toHaveBeenCalledTimes(1)
  press(root, 'Use this')
  press(root, 'Use Local')
  await flush()
  expect(request).toHaveBeenCalledWith('/api/local-models/use', { id: installed().id, mode: 'local' }, expect.objectContaining({ method: 'POST' }))
  press(root, 'Remove')
  expect(request.mock.calls.some(([, , init]) => init?.method === 'DELETE')).toBe(false)
  press(root, 'Keep it')
  press(root, 'Remove')
  press(root, 'Remove 5 GB from disk?')
  await flush()
  expect(request).toHaveBeenCalledWith(`/api/local-models/${encodeURIComponent(installed().id)}`, undefined, expect.objectContaining({ method: 'DELETE' }))
  expect(root.textContent).toContain('No local models installed yet.')
})

test('a rejected install leaves controls usable and can be retried', async () => {
  const state = overview()
  let tries = 0
  const { root } = mount(state, async (path) => path.endsWith('/install') ? ++tries === 1 ? { ok: false, said: 'Runtime not reachable', error: 'network' } : job() : state)
  await flush()
  const install = press(root, 'Install & use')
  await flush()
  expect(root.textContent).toContain('Runtime not reachable')
  expect(install.disabled).toBe(false)
  press(root, 'Install & use')
  await flush()
  expect(root.querySelector('.local-job')).not.toBeNull()
})

test('a mode changed while the page is open is used for the explicit download choice', async () => {
  let mode = 'combined'
  const { root, request } = mount(overview(), undefined, { mode: () => mode })
  await flush()
  mode = 'cloud'
  press(root, 'Install & use')
  expect(root.textContent).toContain('Choose a mode before downloading')
  expect(request).toHaveBeenCalledTimes(1)
})

test('a timed out install aborts its request, reports the problem, and enables retry', async () => {
  const state = overview()
  const { root, request } = mount(state, async (path, _body, init) => {
    if (!path.endsWith('/install')) return state
    return new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('Aborted')), { once: true })
    })
  })
  await flush()
  const install = press(root, 'Install & use')
  await flush()
  await vi.advanceTimersByTimeAsync(20_000)
  expect(root.textContent).toContain('did not answer in time')
  expect(install.disabled).toBe(false)
  expect(request.mock.calls.at(-1)![2]!.signal!.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

test('Hugging Face results, metadata and errors are text; retry retains the selected repository revision', async () => {
  const state = overview()
  const repo = 'owner/<img src=x onerror=alert(1)>'
  let repoTries = 0
  let searchTries = 0
  const { root, request } = mount(state, async (path) => {
    if (path.includes('/search?')) {
      if (++searchTries === 1) throw new Error('Search is offline')
      return [{ repo, downloads: 10, likes: 2, gated: true }]
    }
    if (path.includes('/repo?')) {
      if (++repoTries === 1) throw new Error('Repository needs access')
      return { repo, revision: 'abcdef123456', licence: '<script>bad()</script>', gated: true, quants: model().quants }
    }
    if (path.endsWith('/install')) {
      const failed = job({ target: `${repo}:Q5_K_M`, step: 'failed', error: '<img src=x onerror=alert(2)>', message: 'It did not finish' })
      state.jobs = [failed]
      return failed
    }
    return state
  })
  await flush()
  const form = root.querySelector<HTMLFormElement>('.local-search')!
  form.querySelector('input')!.value = 'Qwen & tools'
  press(root, 'Search')
  await flush()
  expect(root.textContent).toContain('Search is offline')
  expect(form.querySelector('button')!.disabled).toBe(false)
  press(root, 'Search')
  await flush()
  expect(request).toHaveBeenCalledWith('/api/local-models/search?q=Qwen%20%26%20tools&format=gguf', undefined, expect.objectContaining({ method: 'GET' }))
  press(root, repo)
  await flush()
  press(root, 'Retry repository')
  await flush()
  const picker = root.querySelector<HTMLElement>('.local-repo')!
  expect(picker.textContent).toContain('Not reviewed by Alexia')
  expect(picker.textContent).toContain('<script>bad()</script>')
  expect(picker.querySelector('a')!.href).toContain('https://huggingface.co/owner/%3Cimg')
  selectQuant(picker, 'Q5_K_M')
  press(picker, 'Install & use')
  await flush()
  press(root, 'Retry install')
  await flush()
  const sent = request.mock.calls.filter(([path]) => path.endsWith('/install')).map(([, body]) => body)
  expect(sent).toEqual(Array(2).fill({ repo, revision: 'abcdef123456', quant: 'Q5_K_M', format: 'gguf' }))
  expect(root.querySelector('img, script')).toBeNull()
  expect(root.textContent).toContain('<img src=x onerror=alert(2)>')
})

test('tokens only go to the authenticated parent helper; failures clear the secret and allow another save', async () => {
  const state = overview()
  let saves = 0
  const { root, request } = mount(state, async (path) => path.endsWith('/token') ? ++saves === 1 ? { ok: false, said: 'Keychain locked' } : { ok: true } : state)
  await flush()
  const token = root.querySelector<HTMLInputElement>('input[type="password"]')!
  token.value = 'hf_secret_one'
  const save = press(root, 'Save token')
  await flush()
  expect(root.textContent).toContain('Keychain locked')
  expect(root.textContent).not.toContain('hf_secret_one')
  expect(token.value).toBe('')
  expect(save.disabled).toBe(false)
  token.value = 'hf_secret_two'
  press(root, 'Save token')
  await flush()
  expect(request).toHaveBeenCalledWith('/api/local-models/token', { token: 'hf_secret_two' }, expect.objectContaining({ method: 'POST' }))
  expect(root.textContent).toContain('Token saved in the system keychain')
})

test('unsafe licence schemes never become links, and unsupported machines do not offer installs', async () => {
  const state = overview({ runtime: { installed: false, version: '', supported: false }, picks: { best: model({ licence: { name: 'Custom', url: 'javascript:alert(1)', restrictive: true } }) } })
  const { root } = mount(state)
  await flush()
  const card = root.querySelector('.local-model-card')!
  expect(card.querySelector('a')).toBeNull()
  expect(card.textContent).toContain('restrictions apply')
  expect([...root.querySelectorAll<HTMLButtonElement>('button[data-install]')].every((one) => one.disabled)).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

test('first run offers already installed Ollama models and uses their existing action IDs', async () => {
  const state = overview()
  const ready = vi.fn()
  const { root, request } = mount(state, async (path) => path === '/api/rows' ? { rows: [{ id: 'ollama\nqwen:8b', name: 'Qwen in Ollama' }, { id: 'cloud\nqwen', name: 'Cloud model' }] } : path === '/api/action' ? { ok: true, said: 'Ollama model chosen' } : state, { firstRun: true, ready })
  await flush()
  expect(root.textContent).toContain('without another download')
  expect(ready).toHaveBeenLastCalledWith(false)
  press(root, 'Use Qwen in Ollama from Ollama')
  await flush()
  expect(request).toHaveBeenCalledWith('/api/action', { key: 'use_model', row: 'ollama\nqwen:8b' }, expect.objectContaining({ method: 'POST' }))
  expect(ready).toHaveBeenLastCalledWith(true)
  expect(request.mock.calls.some(([path]) => path.endsWith('/install'))).toBe(false)
})

test('first run sends the explicitly chosen Local mode when core still has Cloud saved', async () => {
  const state = overview({ mode: 'cloud' })
  const { root, request } = mount(state, async (path) => path.endsWith('/install') ? job() : path === '/api/rows' ? { rows: [] } : state, { firstRun: true, mode: () => 'local' })
  await flush()
  press(root, 'Install & use')
  await flush()
  expect(request).toHaveBeenCalledWith('/api/local-models/install', { entry: 'qwen', quant: 'Q4_K_M', mode: 'local' }, expect.objectContaining({ method: 'POST' }))
})

test('overview failures recover with Refresh, and an installed selected quant cannot be downloaded again', async () => {
  const state = overview({ picks: { best: model({ installed: true }) }, installed: [installed()] })
  let reads = 0
  const { root } = mount(state, async () => {
    if (++reads === 1) throw new Error('Overview unavailable')
    return state
  })
  await flush()
  expect(root.textContent).toContain('Overview unavailable')
  press(root, 'Refresh')
  await flush()
  expect(root.querySelector<HTMLButtonElement>('.local-model-card button')!.disabled).toBe(true)
  selectQuant(root, 'Q5_K_M')
  expect(root.querySelector<HTMLButtonElement>('.local-model-card button')!.disabled).toBe(false)
})

const dualRuntimes = (mlxInstalled = false) => ({
  llama: { installed: false, version: '', supported: true },
  mlx: { installed: mlxInstalled, version: '1.0', supported: true },
})
const expand = async (root: HTMLElement, selector: string): Promise<HTMLElement> => {
  const fold = root.querySelector<HTMLDetailsElement>(selector)!
  fold.open = true
  await vi.advanceTimersByTimeAsync(0)
  return fold
}

test.each([false, true])('format selection filters curated models and drives repository installs (MLX installed: %s)', async (mlxInstalled) => {
  const mlx = model({ entry: 'qwen-mlx', name: 'Qwen MLX', format: 'mlx' })
  const state = overview({ runtimes: dualRuntimes(mlxInstalled), picks: { best: model(), fast: mlx }, all: [model(), mlx], uncensored: [model({ entry: 'uncensored-mlx', name: 'Uncensored MLX', format: 'mlx', abliterated: true })] })
  const { root, request, view } = mount(state, async (path) => {
    if (path.includes('/search?')) return [{ repo: 'owner/mlx-model' }]
    if (path.includes('/repo?')) return { repo: 'owner/mlx-model', revision: 'fixed-revision', quants: mlx.quants, gated: false }
    if (path.endsWith('/install')) return job({ step: 'failed', message: 'Try again' })
    return state
  })
  await flush()
  expect(root.querySelector('.local-format [aria-pressed="true"]')!.textContent).toBe(mlxInstalled ? 'MLX · Apple Silicon' : 'GGUF')
  press(root, 'MLX · Apple Silicon')
  expect([...root.querySelectorAll('.local-model-card h3')].map((one) => one.textContent)).toEqual(['Qwen MLX', 'Uncensored MLX'])
  const form = root.querySelector<HTMLFormElement>('.local-search')!
  form.querySelector('input')!.value = 'Qwen'
  press(root, 'Search')
  await flush()
  press(root, 'owner/mlx-model')
  await flush()
  press(root.querySelector<HTMLElement>('.local-repo')!, 'Install & use')
  await flush()
  press(root, 'Retry install')
  await flush()
  expect(request).toHaveBeenCalledWith('/api/local-models/search?q=Qwen&format=mlx', undefined, expect.anything())
  expect(request).toHaveBeenCalledWith('/api/local-models/repo?repo=owner%2Fmlx-model&format=mlx', undefined, expect.anything())
  expect(request.mock.calls.filter(([path]) => path.endsWith('/install')).map(([, body]) => body)).toEqual(Array(2).fill({ repo: 'owner/mlx-model', revision: 'fixed-revision', quant: 'Q4_K_M', format: 'mlx' }))
  press(root, 'GGUF')
  await view.refresh()
  expect(root.querySelector('.local-format [aria-pressed="true"]')!.textContent).toBe('GGUF')
  expect([...root.querySelectorAll('.local-model-card h3')].map((one) => one.textContent)).toEqual(['Qwen'])
})

test('unsupported MLX is hidden and a supported format without curated picks remains searchable', async () => {
  const state = overview({ runtimes: dualRuntimes(), picks: {}, all: [], uncensored: [] })
  const { root, view } = mount(state)
  await flush()
  press(root, 'MLX · Apple Silicon')
  expect(root.textContent).toContain('No curated MLX models are available')
  expect(root.textContent).toContain('Find MLX repositories')
  state.machine.appleSilicon = false
  await view.refresh()
  expect(root.querySelector<HTMLElement>('.local-format')!.hidden).toBe(true)
  expect(root.textContent).not.toContain('MLX · Apple Silicon')
  expect(root.textContent).toContain('Find GGUF repositories')
})

test('import previews a path, preserves reference storage on retry, and asks for a fresh Cloud mode choice', async () => {
  const state = overview({ mode: 'cloud' })
  const path = '/Users/me/My model:Q4.gguf'
  const { root, request } = mount(state, async (url) => {
    if (url.includes('/import-preview?')) return { name: 'My model', quant: 'Q4_K_M', bytes: 5 * GB, contextMax: 32768 }
    if (url.endsWith('/import')) return job({ target: `import:${path}`, step: 'failed', message: 'Import failed' })
    return state
  })
  await flush()
  const fold = await expand(root, '.local-import')
  fold.querySelector('input')!.value = path
  const storage = fold.querySelector('select')!
  storage.value = 'reference'
  storage.dispatchEvent(new Event('change'))
  expect(fold.textContent).toContain('does not delete the source file')
  press(fold, 'Check file')
  await flush()
  expect(fold.textContent).toContain('My model · Q4_K_M · 5 GB')
  press(fold, 'Import & use')
  expect(request.mock.calls.some(([url]) => url.endsWith('/import'))).toBe(false)
  press(root, 'Import and use Local')
  await flush()
  press(root, 'Retry import')
  press(root, 'Import and use Combined')
  await flush()
  expect(request.mock.calls.filter(([url]) => url.endsWith('/import')).map(([, body]) => body)).toEqual([
    { path, storage: 'reference', mode: 'local' }, { path, storage: 'reference', mode: 'combined' },
  ])
  expect(request.mock.calls.some(([url]) => url.endsWith('/install'))).toBe(false)
})

test('benchmark cancellation and retry use the model ID without changing Cloud mode', async () => {
  const state = overview({ mode: 'cloud', installed: [installed()] })
  let current = job({ target: `benchmark:${installed().id}` })
  const { root, request } = mount(state, async (path) => {
    if (path.endsWith('/benchmark')) { state.jobs = [current]; return current }
    if (path.endsWith('/cancel')) { current = { ...current, step: 'cancelled', message: 'Cancelled' }; state.jobs = [current]; return { ok: true } }
    if (path.includes('/progress?')) return current
    return state
  })
  await flush()
  press(root, 'Measure speed')
  await flush()
  expect(root.querySelector('.local-mode')!.childElementCount).toBe(0)
  press(root, 'Cancel benchmark')
  await flush()
  await vi.advanceTimersByTimeAsync(1000)
  press(root, 'Retry benchmark')
  await flush()
  expect(request.mock.calls.filter(([path]) => path.endsWith('/benchmark')).map(([, body]) => body)).toEqual(Array(2).fill({ id: installed().id }))
  expect(request.mock.calls.some(([path]) => path.endsWith('/install'))).toBe(false)
})

test('restored benchmark jobs retry correctly and restored imports never become repository installs', async () => {
  const state = overview({ jobs: [job({ target: `benchmark:${installed().id}`, step: 'failed' }), job({ id: 'import-job', target: 'import:/models/model:Q4.gguf', step: 'failed' })] })
  const { root, request } = mount(state, async (path) => path.endsWith('/benchmark') ? job({ target: `benchmark:${installed().id}` }) : state)
  await flush()
  expect(root.textContent).toContain('choose the file and storage option again')
  expect(root.textContent).not.toContain('Retry install')
  press(root, 'Retry benchmark')
  await flush()
  expect(request).toHaveBeenCalledWith('/api/local-models/benchmark', { id: installed().id }, expect.objectContaining({ method: 'POST' }))
})

test('context previews include the saved draft, reject stale results, and allow removing the draft before saving', async () => {
  const draftId = 'llama/owner/draft:Q4'
  const state = overview({ installed: [{ ...installed(), contextMax: 32768, draftModelId: draftId }] })
  const preview = { context: 8192, contextMax: 32768, needBytes: 8 * GB, verdict: 'fits', drafts: [{ id: draftId, name: 'Small draft' }], kvOptions: ['f16', 'q8_0'] }
  let resolve!: (value: unknown) => void
  let reads = 0
  const { root, request, changed } = mount(state, async (path) => {
    if (path.includes('/context?')) {
      if (++reads === 2) return new Promise((done) => { resolve = done })
      return preview
    }
    if (path.endsWith('/context')) return { ok: true, said: 'Configuration saved.' }
    return state
  })
  await flush()
  const fold = await expand(root, '.local-context')
  await flush()
  const [kv, draft] = fold.querySelectorAll('select')
  const save = [...fold.querySelectorAll('button')].find((one) => one.textContent === 'Save configuration')!
  expect(draft!.value).toBe(draftId)
  expect(new URL(request.mock.calls.at(-1)![0], 'http://localhost').searchParams.get('draftModelId')).toBe(draftId)
  kv!.value = 'q8_0'
  kv!.dispatchEvent(new Event('change'))
  await vi.advanceTimersByTimeAsync(200)
  expect(save.disabled).toBe(true)
  draft!.value = ''
  draft!.dispatchEvent(new Event('change'))
  await vi.advanceTimersByTimeAsync(200)
  expect(save.disabled).toBe(false)
  expect(new URL(request.mock.calls.at(-1)![0], 'http://localhost').searchParams.get('draftModelId')).toBe('')
  resolve({ ...preview, verdict: 'too-big', needBytes: 40 * GB })
  await flush()
  expect(save.disabled).toBe(false)
  expect(draft!.value).toBe('')
  press(fold, 'Save configuration')
  await flush()
  expect(request).toHaveBeenCalledWith('/api/local-models/context', { id: installed().id, context: 8192, kvCache: 'q8_0', draftModelId: null }, expect.objectContaining({ method: 'POST' }))
  expect(changed).toHaveBeenCalledTimes(1)
})

test('selecting a draft checks its extra memory and blocks saving a configuration that cannot fit', async () => {
  const state = overview({ installed: [{ ...installed(), contextMax: 32768 }] })
  const { root, request, view } = mount(state, async (path) => {
    if (path.includes('/context?')) {
      const draft = new URL(path, 'http://localhost').searchParams.get('draftModelId')
      return { context: 8192, contextMax: 32768, needBytes: (draft ? 30 : 8) * GB, verdict: draft ? 'too-big' : 'fits', drafts: [{ id: 'draft/1', name: 'Draft' }], kvOptions: ['f16'] }
    }
    return state
  })
  await flush()
  const fold = await expand(root, '.local-context')
  await flush()
  const draft = fold.querySelectorAll('select')[1]!
  draft.value = 'draft/1'
  draft.dispatchEvent(new Event('change'))
  const save = press(fold, 'Save configuration')
  expect(save.disabled).toBe(true)
  await vi.advanceTimersByTimeAsync(200)
  expect(fold.textContent).toContain('Too large for this machine')
  expect(save.disabled).toBe(true)
  expect(request.mock.calls.some(([path]) => path.endsWith('/context'))).toBe(false)
  draft.value = ''
  draft.dispatchEvent(new Event('change'))
  view.close()
  expect(vi.getTimerCount()).toBe(0)
})

test('maintenance offers an installed model update and confirms reference removal without deleting its source', async () => {
  const held = { ...installed(), imported: true, owned: false }
  const state = overview({ installed: [held], all: [model({ installed: true })] })
  const { root, request } = mount(state, async (path) => {
    if (path.endsWith('/maintenance')) return { updates: [{ installedId: held.id, entry: 'qwen', name: 'Qwen update', reason: 'New revision' }], cleanup: [{ id: held.id, name: held.name, bytes: 0, reason: 'Unused' }], reclaimableBytes: 0 }
    if (path.endsWith('/install')) return job({ step: 'failed' })
    if (path.endsWith(encodeURIComponent(held.id))) { state.installed = []; return { ok: true } }
    return state
  })
  await flush()
  const fold = await expand(root, '.local-maintenance')
  await flush()
  expect(fold.textContent).toContain('New revision')
  const update = press(fold, 'Install & use')
  expect(update.disabled).toBe(true)
  await flush()
  expect(request).toHaveBeenCalledWith('/api/local-models/install', { entry: 'qwen', quant: 'Q4_K_M' }, expect.objectContaining({ method: 'POST' }))
  press(fold, 'Remove')
  expect(request.mock.calls.some(([, , init]) => init?.method === 'DELETE')).toBe(false)
  press(fold, 'Remove reference? Source file stays.')
  await flush()
  expect(request).toHaveBeenCalledWith(`/api/local-models/${encodeURIComponent(held.id)}`, undefined, expect.objectContaining({ method: 'DELETE' }))
})
