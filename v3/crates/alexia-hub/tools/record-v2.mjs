// SPDX-License-Identifier: AGPL-3.0-only
// Records v2's answers into v3/crates/alexia-hub/tests/contract/*.json (P2D-02).
//
//   node v3/crates/alexia-hub/tools/record-v2.mjs            re-record, rewriting the case files
//   node v3/crates/alexia-hub/tools/record-v2.mjs --check    re-record into a temp folder and
//                                                            report any shape change against the
//                                                            committed "source": "v2" cases
//
// It builds nothing: run `pnpm typecheck` first, so `packages/core/dist` is there. It boots v2's
// `serve()` headless on a scratch data folder (LOCALAPPDATA / ALEXIA_DATA_NAME / XDG_DATA_HOME
// all point into it, secrets are in memory, no provider is configured, no local runtime is
// looked for), sends each request below, and writes down what came back as a *shape*: the
// status, the content type, and the JSON with every leaf replaced by its type name.
//
// Cases marked `hand` (the HAND list at the bottom) are not run: they are written from the
// serve.ts / compute/api.ts lines named in `from`, for rows that need a model, a plugin, a GPU,
// a paired computer or the network. A re-record keeps them as they are, and keeps each case's
// `hub` value ("pending" / "answers"), which is the area tasks' to flip.
//
// Needs Node 22+ and nothing from npm.

import http from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..', '..', '..')
const casesDir = resolve(here, '..', 'tests', 'contract')
const dist = join(repo, 'packages', 'core', 'dist', 'src')

const AREAS = ['gate', 'state', 'chat', 'plugins', 'board', 'library', 'local_models', 'compute', 'editor']
const check = process.argv.includes('--check')

// ---- shapes ----

/** v2's JSON with every leaf replaced by its type name; an array by its first element's shape. */
export function shapeOf(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return v.length === 0 ? [] : [shapeOf(v[0])]
  switch (typeof v) {
    case 'string': return 'string'
    case 'number': return 'number'
    case 'boolean': return 'bool'
    case 'object': return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shapeOf(x)]))
    default: throw new Error(`not JSON: ${typeof v}`)
  }
}

// ---- the window the cases are sent to ----

/** The UI folder both v2 and the hub serve in the contract: four files, token in index.html. */
export function uiFiles() {
  return {
    'index.html': '<!doctype html><script type="module" src="/main.js" data-token="__TOKEN__"></script>\n',
    'app.css': 'body { margin: 0 }\n',
    'dist/src/main.js': 'export {}\n',
    'alexia-mark.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1z"/></svg>\n',
  }
}

function writeUi(dir) {
  for (const [name, text] of Object.entries(uiFiles())) {
    const file = join(dir, name)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
}

function send(base, token, req) {
  return new Promise((done) => {
    const query = new URLSearchParams(req.query ?? {}).toString()
    const raw = typeof req.body === 'string'
    const body = req.body == null ? null : raw ? req.body : JSON.stringify(req.body)
    const headers = { host: req.host ?? '127.0.0.1' }
    if (req.token) headers['x-alexia-token'] = token
    if (body !== null) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(Buffer.byteLength(body))
    }
    const u = new URL(base)
    const r = http.request(
      { host: u.hostname, port: u.port, method: req.method, path: req.path + (query ? `?${query}` : ''), headers, timeout: 20_000 },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => done({ status: res.statusCode, type: res.headers['content-type'] ?? null, bytes: Buffer.concat(chunks) }))
      },
    )
    r.on('timeout', () => { r.destroy(); done({ status: 0, type: null, bytes: Buffer.alloc(0), timedOut: true }) })
    r.on('error', (e) => done({ status: 0, type: null, bytes: Buffer.alloc(0), error: String(e) }))
    if (body !== null) r.write(body)
    r.end()
  })
}

/** SSE frames from a `data: <json>\n\n` stream; a run of `delta` frames collapses to one. */
function framesOf(text) {
  const out = []
  for (const block of text.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data: '))
    if (!line) continue
    const frame = { shape: shapeOf(JSON.parse(line.slice(6))) }
    const last = out[out.length - 1]
    const isDelta = (f) => typeof f.shape === 'object' && f.shape !== null && 'delta' in f.shape
    if (last && isDelta(last) && isDelta(frame)) last.repeat = true
    else out.push(frame)
  }
  return out
}

function recorded(res, stream) {
  const type = res.type === null ? null : res.type.split(';')[0].trim()
  const text = res.bytes.toString('utf8')
  const response = { status: res.status, type }
  if (stream) return { response, stream: framesOf(text) }
  if (type === 'application/json') response.shape = shapeOf(JSON.parse(text))
  else if (type === 'text/plain') response.text = text
  else response.shape = null
  return { response, stream: null }
}

// ---- booting v2 ----

async function boot(root, setup) {
  process.env.LOCALAPPDATA = root
  process.env.XDG_DATA_HOME = root
  process.env.ALEXIA_DATA_NAME = 'record'
  process.env.HOME = root
  process.env.USERPROFILE = root
  const data = join(root, 'record')
  mkdirSync(data, { recursive: true })
  const ui = join(root, 'ui')
  writeUi(ui)
  const { Store } = await import(pathToFileURL(join(dist, 'store.js')))
  const { memorySecrets } = await import(pathToFileURL(join(dist, 'secrets.js')))
  const { serve } = await import(pathToFileURL(join(dist, 'serve.js')))
  if (setup.includes('chat')) {
    const store = new Store(join(data, 'alexia.db'))
    const id = store.createSession()
    store.append(id, { role: 'user', content: 'Hello there.' })
    store.append(id, { role: 'assistant', content: 'Hello. How can I help?' })
    store.close()
  }
  return serve({ dataDir: data, uiDir: ui, port: 0, providers: [], local: false, secrets: memorySecrets() })
}

async function record(cases) {
  const groups = new Map()
  for (const c of cases) {
    const key = c.setup.join('+')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(c)
  }
  const out = []
  for (const [, group] of groups) {
    const root = mkdtempSync(join(tmpdir(), 'alexia-record-'))
    const serving = await boot(root, group[0].setup)
    try {
      for (const c of group) {
        const res = await send(serving.url, serving.token, c.request)
        if (res.status === 0) throw new Error(`${c.row} “${c.name}”: no answer (${res.error ?? 'timed out'}); write it as a hand case`)
        const { response, stream } = recorded(res, c.stream === true)
        const kept = { ...(c.ignore && { ignore: c.ignore }), ...(c.optional && { optional: c.optional }) }
        out.push({
          area: c.area, row: c.row, name: c.name, source: 'v2', hub: 'pending',
          request: normal(c.request), setup: c.setup,
          response: { ...response, ...kept }, stream,
        })
      }
    } finally {
      await serving.close().catch(() => {})
      rmSync(root, { recursive: true, force: true })
    }
  }
  return out
}

function normal(r) {
  return { method: r.method, path: r.path, query: r.query ?? {}, body: r.body ?? null, token: r.token ?? true, host: r.host ?? '127.0.0.1' }
}

// ---- the cases ----

const T = { token: true }
const get = (path, query = {}) => ({ method: 'GET', path, query, body: null, ...T })
const post = (path, body = {}) => ({ method: 'POST', path, query: {}, body, ...T })
const area = (a) => (row, name, request, extra = {}) => ({ area: a, row, name, request, setup: ['fresh'], ...extra })

const gate = area('gate')
const state = area('state')
const chat = area('chat')
const plugins = area('plugins')
const board = area('board')
const library = area('library')
const local = area('local_models')
const compute = area('compute')
const editor = area('editor')

const V2 = [
  gate('S1', 'the page', { method: 'GET', path: '/', query: {}, body: null, token: false }),
  gate('S1', 'the stylesheet', { method: 'GET', path: '/app.css', query: {}, body: null, token: false }),
  gate('S1', 'the main module', { method: 'GET', path: '/main.js', query: {}, body: null, token: false }),
  gate('S1', 'a picture', { method: 'GET', path: '/alexia-mark.svg', query: {}, body: null, token: false }),
  gate('S2', 'no token', { method: 'GET', path: '/api/state', query: {}, body: null, token: false }),
  gate('S2', 'a Host that is not 127.0.0.1', { method: 'GET', path: '/api/state', query: {}, body: null, token: true, host: 'localhost' }),
  gate('S3', 'a body that is not JSON', post('/api/stop', 'not json')),
  gate('S3', 'a risky route without confirm', post('/api/plugin', { id: 'demo', action: 'delete' })),
  gate('S3', 'a route that only reads, sent a POST', post('/api/state', {})),
  gate('S3', 'a route nobody serves, sent a POST', post('/api/nothing-here', {})),
  gate('S4', 'an unknown path', get('/api/nothing-here')),

  state('A1', 'state on a fresh data folder', get('/api/state'), { optional: ['/cap', '/warning', '/modeTransition', '/personality', '/pins/placement'] }),
  state('A1', 'state with one chat open', get('/api/state'), { setup: ['chat'], optional: ['/cap', '/warning', '/modeTransition', '/personality', '/pins/placement'] }),
  state('A2', 'set the name and the theme', post('/api/setup', { name: 'Ada', theme: 'dark', glass: 70, updates: false })),
  state('A2', 'a name that is too long', post('/api/setup', { name: 'x'.repeat(200) })),
  state('A3', 'permissions: the mode', post('/api/permissions', { mode: 'full-trust' })),
  state('A4', 'ceilings', post('/api/ceilings', { steps: 12, askAbove: 1, daily: 0 })),
  state('A5', 'adult on without the 18+ confirm', post('/api/adult', { enabled: true, confirm: true })),
  state('A5', 'adult on with the confirm', post('/api/adult', { enabled: true, adult: true, confirm: true })),
  state('A5', 'adult off', post('/api/adult', { enabled: false, confirm: true })),
  state('A6', 'the board\'s core tabs', get('/api/panels')),
  state('A7', 'search', get('/api/search', { q: 'chat' })),

  chat('C2', 'stop with nothing running', post('/api/stop', {})),
  chat('C3', 'approve with nothing waiting', post('/api/approve', { allowed: true })),
  chat('C4', 'a slash command: /help', post('/api/command', { input: '/help' })),
  chat('C4', 'text that is not a command', post('/api/command', { input: 'hello' })),
  chat('C5', 'not her, with no persona plugin', post('/api/not-her', {})),
  chat('C6', 'a file that was never offered', get('/api/file', { id: 'nope' })),
  chat('C7', 'show in folder for a file that was never offered', post('/api/file', { id: 'nope', action: 'reveal', confirm: true })),

  plugins('P1', 'no plugins installed', get('/api/plugins')),
  plugins('P2', 'enable a plugin that is not installed', post('/api/plugin', { id: 'demo', action: 'enable' })),
  plugins('P3', 'install from a folder that is not there', post('/api/install', { path: join(tmpdir(), 'alexia-no-such-folder'), confirm: true })),
  plugins('P4', 'trust a server that is not added', post('/api/server', { id: 'demo', action: 'trust', confirm: true })),
  plugins('P5', 'a setting of a plugin that is not installed', post('/api/settings', { plugin: 'demo', key: 'k', value: 'v' })),
  plugins('P6', 'an upload for a plugin that is not installed', post('/api/upload', { plugin: 'demo', key: 'k', name: 'a.txt', data: 'aGk=' })),
  plugins('P7', 'a file of a plugin that is not installed', get('/api/plugin-file', { plugin: 'demo', path: 'a.png' })),

  board('B1', 'rows: chats', post('/api/rows', { plugin: '', key: 'chats' }), { setup: ['chat'] }),
  board('B1', 'rows: models', post('/api/rows', { plugin: '', key: 'models' })),
  board('B1', 'rows: routing', post('/api/rows', { plugin: '', key: 'routing' })),
  board('B1', 'rows: activity', post('/api/rows', { plugin: '', key: 'activity' })),
  board('B1', 'rows: last_run', post('/api/rows', { plugin: '', key: 'last_run' })),
  board('B1', 'rows: skills', post('/api/rows', { plugin: '', key: 'skills' })),
  board('B1', 'rows: learned', post('/api/rows', { plugin: '', key: 'learned' })),
  board('B1', 'rows: tools', post('/api/rows', { plugin: '', key: 'tools' })),
  board('B1', 'rows: library', post('/api/rows', { plugin: '', key: 'library' })),
  board('B2', 'detail of a chat', post('/api/detail', { plugin: '', key: 'chats', row: '1' }), { setup: ['chat'] }),
  board('B3', 'action: new_chat', post('/api/action', { plugin: '', key: 'new_chat', row: '' }), { setup: ['chat'] }),
  board('B3', 'action: set_spend', post('/api/action', { plugin: '', key: 'set_spend', row: 'free', confirm: true })),
  board('B3', 'action that does not exist', post('/api/action', { plugin: '', key: 'no_such_action', row: '', confirm: true })),
  board('B4', 'learn: save with nothing waiting', post('/api/learn', { action: 'save', name: 'x', text: 'y', confirm: true })),
  board('B4', 'learn: forget one', post('/api/learn', { action: 'forget', name: 'nothing', confirm: true })),

  library('L1', 'the library', get('/api/library')),
  library('L2', 'download progress with nothing downloading', get('/api/library/progress', { id: 'voice' })),
  library('L3', 'install something the registry does not have', post('/api/library/install', { id: 'nope', kind: 'plugin', confirm: true })),

  local('M1', 'overview', get('/api/local-models')),
  local('M4', 'context settings', get('/api/local-models/context', { id: 'none' })),
  local('M5', 'set context settings', post('/api/local-models/context', { id: 'none', context: 4096 })),
  local('M6', 'maintenance', get('/api/local-models/maintenance')),
  local('M7', 'import preview of a missing file', get('/api/local-models/import-preview', { path: join(tmpdir(), 'alexia-none.gguf') })),
  local('M8', 'progress with nothing running', get('/api/local-models/progress')),
  local('M10', 'cancel a job that is not there', post('/api/local-models/cancel', { job: 'none' })),
  local('M9', 'install an entry that is not on the list', post('/api/local-models/install', { entry: 'none', quant: 'Q4', confirm: true })),
  local('M11', 'import a file that is not there', post('/api/local-models/import', { path: join(tmpdir(), 'alexia-none.gguf'), confirm: true })),
  local('M12', 'benchmark a model that is not installed', post('/api/local-models/benchmark', { id: 'none', confirm: true })),
  local('M13', 'use a model that is not installed', post('/api/local-models/use', { id: 'none', mode: 'local' })),
  local('M14', 'remove a model that is not installed', post('/api/local-models/remove', { id: 'none', confirm: true })),
  local('M15', 'DELETE a model that is not installed', { method: 'DELETE', path: '/api/local-models/none', query: {}, body: { confirm: true }, ...T }),
  local('M16', 'a Hugging Face token', post('/api/local-models/token', { token: 'x'.repeat(8) })),
  local('M17', 'local stats', get('/api/local-stats')),

  compute('R1', 'the role', get('/api/compute/role')),
  compute('R2', 'switch the role asks first', post('/api/compute/role', { role: 'compute' })),
  compute('R3', 'cancel a role switch that is not waiting', post('/api/compute/role/cancel', {})),
  compute('R4', 'paired computers', get('/api/compute/hosts')),
  compute('R7', 'find a computer waiting to pair', get('/api/compute/discover')),
  compute('R8', 'open pairing without a code', post('/api/compute/pair/start', {})),
  compute('R9', 'pairing state', get('/api/compute/pair')),
  compute('R10', 'cancel pairing that is not open', post('/api/compute/pair/cancel', {})),
  compute('R11', 'unpair a computer that is not paired', post('/api/compute/unpair', { host: 'nobody', confirm: true })),
  compute('R12', 'this computer\'s inventory', get('/api/compute/inventory')),
  compute('R13', 'how this computer is reached', get('/api/compute/status')),
  compute('R14', 'choose this computer', post('/api/compute/select', { host: 'this' })),
  compute('R15', 'install a requirement with no computer chosen', post('/api/compute/setup/install', { requirement: 'x' })),
  compute('R16', 'the queue', get('/api/compute/queue')),
  compute('R17', 'a job that is not there', get('/api/compute/job', { job: 'none' })),
  compute('R18', 'jobs heard about', get('/api/compute/jobs')),
  compute('R19', 'cancel a job that is not there', post('/api/compute/jobs/cancel', { job: 'none' })),
  compute('R20', 'pause', post('/api/compute/pause', { paused: true })),
  compute('R21', 'relay and mailbox addresses', get('/api/compute/services')),
  compute('R22', 'set the relay address', post('/api/compute/services', { relay: 'https://relay.example.com' })),
  compute('R23', 'close the compute window on the computer you talk to', post('/api/compute/window/close', {})),

  editor('E1', 'the editor with no editor plugin', post('/api/editor', { op: 'open' })),
  editor('E2', 'a shared file that was never shared', get('/api/editor/file', { token: 'none' })),
  editor('E3', 'a picture the conversation does not own', get('/api/editor/picture', { id: 'none' })),
  editor('E5', 'upload a picture with no conversation', post('/api/editor/upload', { name: 'a.png', data: 'aGk=' })),
  editor('E4', 'forget editor pictures', post('/api/editor/forget', { confirm: true })),
  editor('E6', 'research snapshot of a plugin that is not there', post('/api/research', { plugin: 'demo' })),
  editor('E7', 'a research file that is not there', get('/api/research-file', { plugin: 'demo', run: 'r', source: 's', kind: 'preview' })),
]

// ---- the hand-written cases: from the serve.ts / compute/api.ts lines named in `from` ----

const sse = { status: 200, type: 'text/event-stream' }
const frame = (shape, more = {}) => ({ shape, ...more })
const DELTA = frame({ delta: 'string' }, { repeat: true })
const PHASE = frame({ phase: { kind: 'string' } }, { optional: true })
const DONE = frame(
  { done: { model: 'string', spent: 'number', today: { spent: 'number', allowance: 'number' }, steps: 'number', ended: 'string' } },
  { optional_keys: ['/done/bubble', '/done/cap', '/done/warning'] },
)
const OUTCOME = (n = 'number') => frame({ step: { n, name: 'string', text: 'string', ok: 'bool' } }, { optional_keys: ['/step/final', '/step/timing', '/step/card', '/step/files'] })
const hand = (area, row, name, from, request, response, extra = {}) => ({ area, row, name, from, request, response, ...extra })
const chatPost = (text) => ({ method: 'POST', path: '/api/chat', query: {}, body: { text }, token: true })
const GETR = (path, query = {}) => ({ method: 'GET', path, query, body: null, token: true })
const ok = (shape, more = {}) => ({ status: 200, type: 'application/json', shape, ...more })

const HAND_RAW = [
  hand('gate', 'T4', 'start-core-again: after the restart the window answers again', 'src-tauri/src/main.rs (event start-core-again); replayed by P2D-13',
    { method: 'GET', path: '/', query: {}, body: null, token: false }, { status: 200, type: 'text/html', shape: null }),

  hand('chat', 'C1', 'a plain answer', 'serve.ts:3577-3975 (frames at 3797-3815, 3873-3945)', chatPost('Say hello.'),
    sse, { setup: ['scripted'], stream: [PHASE, DELTA, DONE] }),
  hand('chat', 'C1', 'a tool step with progress', 'serve.ts:3826-3860 (step, progress, outcome frames)', chatPost('Do some work.'),
    sse, {
      setup: ['scripted'],
      stream: [
        PHASE,
        frame({ step: { n: 'number', name: 'string', args: { ms: 'number' } } }),
        frame({ step: { n: 'number', name: 'string', progress: { progress: 'number', total: 'number', message: 'string' } } }, { optional_keys: ['/step/progress/total', '/step/progress/message'] }),
        OUTCOME(),
        DELTA, DONE,
      ],
    }),
  hand('chat', 'C1', 'an ask, then /api/approve', 'serve.ts:3797-3799 (ask), 2516-2527 (approve)', chatPost('Please ask before you set it.'),
    sse, {
      setup: ['scripted'],
      during: [{ method: 'POST', path: '/api/approve', query: {}, body: { allowed: true }, token: true }],
      stream: [
        PHASE,
        frame({ ask: 'string' }),
        frame({ step: { n: 'number', name: 'string', args: { key: 'string', value: 'string' } } }),
        OUTCOME(),
        DELTA, DONE,
      ],
    }),
  hand('chat', 'C1', '423 while another answer is running', 'serve.ts:3281-3290',
    chatPost('A second message.'), { status: 423, type: 'application/json', shape: { ok: 'bool', busy: 'bool', said: 'string' } },
    { setup: ['scripted'], behind: chatPost('Please ask before you set it.') }),

  hand('plugins', 'P1', 'a plugin with every kind of widget', 'serve.ts:2534-2547, settings.ts:140-160', GETR('/api/plugins'),
    ok({
      panes: [{
        id: 'string', name: 'string', summary: 'string', version: 'string', license: 'string', enabled: 'bool', running: 'bool',
        requires: [], settings: [{ type: 'string', key: 'string', label: 'string' }],
        panel: { label: 'string', widgets: [{ type: 'string', key: 'string', label: 'string' }] }, page: 'null',
      }],
      problems: [], skills: [], unreviewed: [], offers: {}, skillProblems: [],
    }, {
      optional: ['/panes/0/state', '/panes/0/reason', '/panes/0/panel', '/panes/0/page',
        ...['settings', 'panel/widgets'].flatMap((where) => ['hint', 'value', 'set', 'stored', 'available', 'reason', 'live', 'gates'].map((k) => `/panes/0/${where}/0/${k}`))],
    }), { setup: ['plugins'] }),

  hand('local_models', 'M2', 'search (needs Hugging Face)', 'serve.ts:2150; localModels.search', GETR('/api/local-models/search', { q: 'llama' }),
    ok({ results: [{ repo: 'string' }] })),
  hand('local_models', 'M3', 'repo preview (needs Hugging Face)', 'serve.ts:2151; localModels.hf', GETR('/api/local-models/repo', { repo: 'owner/name' }),
    ok({ repo: 'string' })),

  hand('compute', 'R5', 'Tailscale state', 'compute/api.ts:519-523', GETR('/api/compute/tailscale'),
    ok({ tailscale: { phase: 'string', said: 'string' } }, { optional: ['/tailscale/self', '/tailscale/peers'] })),
  hand('compute', 'R6', 'tailscale: an action it does not know', 'compute/api.ts:524-534',
    { method: 'POST', path: '/api/compute/tailscale', query: {}, body: { action: 'nothing' }, token: true },
    { status: 400, type: 'application/json', shape: { ok: 'bool', said: 'string', code: 'string' } }),
  hand('compute', 'R12', 'inventory of a paired computer', 'compute/api.ts:567-579', GETR('/api/compute/inventory', { host: 'paired' }),
    ok({ connection: { state: 'string' }, inventory: {} }, { optional: ['/inventory', '/failure'] })),
]

// ---- files ----

function load(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { area: null, cases: [] }
}

function build(recordedCases, dir) {
  const files = {}
  for (const a of AREAS) {
    const old = load(join(dir, `${a}.json`))
    const hubOf = new Map(old.cases.map((c) => [`${c.row}|${c.name}`, c.hub]))
    const mine = [...recordedCases, ...HAND].filter((c) => c.area === a)
    files[a] = {
      area: a,
      cases: mine.map((m) => {
        const c = { ...m }
        delete c.area
        return { ...c, hub: hubOf.get(`${c.row}|${c.name}`) ?? c.hub ?? 'pending' }
      }),
    }
  }
  return files
}

const HAND = HAND_RAW.map((c) => ({ ...c, source: 'hand', hub: 'pending', setup: c.setup ?? ['fresh'], request: normal(c.request), stream: c.stream ?? null }))

if (!existsSync(join(dist, 'serve.js'))) {
  console.error('packages/core/dist is missing: run `pnpm typecheck` first.')
  process.exit(2)
}

const recordedCases = await record(V2)
const files = build(recordedCases, casesDir)

if (check) {
  let changed = 0
  for (const a of AREAS) {
    const committed = load(join(casesDir, `${a}.json`)).cases.filter((c) => c.source === 'v2')
    const fresh = files[a].cases.filter((c) => c.source === 'v2')
    const key = (c) => `${c.row}|${c.name}`
    const mine = new Map(committed.map((c) => [key(c), c]))
    for (const c of fresh) {
      const was = mine.get(key(c))
      mine.delete(key(c))
      const strip = (o) => {
        const rest = { ...o }
        delete rest.hub
        return JSON.stringify(rest)
      }
      if (!was) { changed++; console.log(`new case in ${a}: ${key(c)}`) }
      else if (strip(was) !== strip(c)) { changed++; console.log(`shape changed in ${a}: ${key(c)}\n  was ${JSON.stringify(was.response)}\n  now ${JSON.stringify(c.response)}`) }
    }
    for (const k of mine.keys()) { changed++; console.log(`case no longer recorded in ${a}: ${k}`) }
  }
  console.log(changed === 0 ? 'no shape change against the committed v2 cases' : `${changed} change(s)`)
  process.exit(changed === 0 ? 0 : 1)
}

mkdirSync(casesDir, { recursive: true })
for (const a of AREAS) writeFileSync(join(casesDir, `${a}.json`), `${JSON.stringify(files[a], null, 2)}\n`)
const total = AREAS.reduce((n, a) => n + files[a].cases.length, 0)
console.log(`wrote ${total} cases to ${casesDir}`)
