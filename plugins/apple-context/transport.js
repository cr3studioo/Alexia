// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { open, readdir, realpath, stat, unlink } from 'node:fs/promises'
import { constants, watch } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DAY } from './schema.js'
import { hash } from './store.js'
const HEALTH_LIMIT = 8 * 1024 * 1024
function authorized(header, token) {
  if (typeof token !== 'string' || token.length < 32 || typeof header !== 'string') return false
  const got = Buffer.from(header), expected = Buffer.from(`Bearer ${token}`)
  return got.length === expected.length && timingSafeEqual(got, expected)
}
export async function receiver({ store, settings, port = 0, changed = () => {} }) {
  const server = createServer(async (req, res) => {
    const send = (status, data) => { if (!res.writableEnded) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)) } }
    try {
      const config = await settings()
      const event = req.url === '/v1/events', health = req.url === '/v1/health/hozz', status = req.url === '/v1/status'
      if ((!event && !health && !status) || req.method !== (status ? 'GET' : 'POST')) return send(404, { error: 'not_found' })
      if (!authorized(req.headers.authorization, health ? config.health_token : config.event_token)) return send(401, { error: 'unauthorized' })
      if (config.paused) return send(503, { error: 'paused' })
      if (status) return send(200, { ready: true, lastHealthReceived: store.get('lastHealthReceived') ?? null, lastEventReceived: store.get('lastEventReceived') ?? null })
      const limit = event ? 16384 : HEALTH_LIMIT
      if (Number(req.headers['content-length'] ?? 0) > limit) return send(413, { error: 'too_large' })
      const chunks = []; let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > limit) { send(413, { error: 'too_large' }); req.destroy(); return }
        chunks.push(chunk)
      }
      const text = Buffer.concat(chunks).toString('utf8')
      const result = event ? store.ingestEvent(JSON.parse(text), config.device_id, config.places) : store.ingestHealth(text)
      changed()
      send(200, result)
    } catch { send(422, { error: 'invalid_payload', hint: 'Expected the configured device event or Hozz v1 lossless JSON/NDJSON. No data was accepted.' }) }
  })
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxConnections = 8
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  return { port: server.address().port, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }) }
}
export async function scopedFolder(folder, roots) {
  const path = await realpath(folder)
  const permitted = await Promise.all(roots.map(async (root) => {
    try {
      const base = await realpath(root.uri ? fileURLToPath(root.uri) : root)
      const tail = relative(base, path)
      return tail === '' || (!tail.startsWith('..') && !isAbsolute(tail))
    } catch { return false }
  }))
  if (!permitted.some(Boolean)) throw new Error('Inbox is outside the folders opened in Alexia')
  return path
}
export class Inbox {
  constructor({ store, settings, roots, download = async () => {}, changed = () => {} }) {
    Object.assign(this, { store, settings, roots, download, changed })
    this.state = 'Not configured'; this.running = false; this.watchers = []; this.offset = 0
  }
  async scan() {
    if (this.running) return
    this.running = true
    try {
      const config = await this.settings()
      if (config.paused || !config.inbox) { this.state = config.paused ? 'Paused' : 'Choose an inbox folder'; return }
      const folder = await scopedFolder(config.inbox, await this.roots())
      const entries = []
      for (const kind of ['events', 'health']) {
        const sub = await scopedFolder(join(folder, kind), [{ uri: pathToFileURL(folder).href }])
        for (const file of await readdir(sub, { withFileTypes: true })) {
          if (file.isFile() && /\.(json|ndjson|icloud)$/.test(file.name)) entries.push({ path: join(sub, file.name), kind, name: file.name })
        }
      }
      entries.sort((a, b) => a.path.localeCompare(b.path))
      const page = entries.slice(this.offset, this.offset + 100)
      this.offset = this.offset + 100 >= entries.length ? 0 : this.offset + 100
      let pending = 0, failed = 0
      for (const entry of page) {
        if (entry.name.endsWith('.icloud')) { await this.download(entry.path).catch(() => {}); pending++; continue }
        let handle
        try {
          handle = await open(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW)
          const before = await handle.stat()
          if (!before.isFile() || Date.now() - before.mtimeMs < 1500) { pending++; continue }
          if (before.size > (entry.kind === 'events' ? 16384 : HEALTH_LIMIT)) { failed++; continue }
          const bytes = Buffer.alloc(before.size + 1)
          let count = 0
          while (count < bytes.length) {
            const { bytesRead } = await handle.read(bytes, count, bytes.length - count, null)
            if (!bytesRead) break
            count += bytesRead
          }
          if (count !== before.size) { pending++; continue }
          const text = bytes.subarray(0, count).toString('utf8')
          const after = await handle.stat()
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) { pending++; continue }
          const digest = hash(text), key = `file:${hash(entry.path)}`
          const prior = this.store.get(key)
          const replay = (this.store.get('allowReimportAt') ?? 0) > (prior?.at ?? 0)
          if (!prior || prior.digest !== digest || replay) {
            if (entry.kind === 'events') this.store.ingestEvent(JSON.parse(text), config.device_id, config.places)
            else this.store.ingestHealth(text)
            this.store.set(key, { digest, at: Date.now() })
          } else if (config.cleanup && Date.now() - prior.at > 7 * DAY) {
            // Recheck both configured scope and file identity before removing an acknowledged file.
            await scopedFolder(config.inbox, await this.roots())
            const current = await stat(entry.path)
            if (current.ino === before.ino && current.mtimeMs === before.mtimeMs && current.size === before.size) await unlink(entry.path)
          }
        } catch { failed++ } finally { await handle?.close() }
      }
      this.state = `${entries.length} inbox files; ${pending} pending; ${failed} need attention in this scan`
    } catch { this.state = 'Inbox unavailable or outside the selected folders' } finally { this.running = false; this.changed() }
  }
  async start() {
    await this.scan()
    const { inbox } = await this.settings()
    if (inbox) for (const kind of ['events', 'health']) {
      try {
        const watcher = watch(join(inbox, kind), () => { clearTimeout(this.debounce); this.debounce = setTimeout(() => void this.scan(), 2000) })
        watcher.on('error', () => { watcher.close(); this.state = 'Folder watcher unavailable; periodic reconciliation remains active' })
        this.watchers.push(watcher)
      } catch { /* reconciliation also handles a missing folder */ }
    }
    this.timer = setInterval(() => void this.scan(), 60000)
  }
  close() { clearInterval(this.timer); clearTimeout(this.debounce); for (const watcher of this.watchers) watcher.close() }
}
