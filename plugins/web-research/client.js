// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'

/** One worker across runs. Responses and late previews route by immutable run id. */
export class WorkerClient {
  constructor(runtime, bundled, own) {
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject })
    this.ready.catch(() => {})
    this.child = spawn(runtime.python, ['-u', join(bundled, 'worker.py'), own], { env: { ...runtime.env, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
    this.stderr = ''
    this.child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-2000) })
    const lines = createInterface({ input: this.child.stdout })
    lines.on('line', (line) => {
      let message
      try { message = JSON.parse(line) } catch { return }
      if (message.type === 'ready') { this.readyResolve(); return }
      const waiting = this.pending.get(message.requestId)
      if (!waiting) return
      if (message.type === 'update') waiting.update(message)
      if (message.type === 'result') { waiting.settled = true; waiting.resolve(message) }
      if (message.type === 'error') { waiting.settled = true; waiting.reject(new Error(message.message)) }
    })
    const failed = (error) => {
      this.dead = true
      this.readyReject(error)
      for (const one of this.pending.values()) one.reject(error)
      this.pending.clear()
    }
    this.child.on('error', failed)
    this.child.on('exit', () => failed(new Error(`Research worker stopped: ${this.stderr}`)))
    this.child.stdin.on('error', failed)
  }
  request(request, signal, update) {
    if (this.dead) return Promise.reject(new Error('Research worker is not running'))
    if (signal?.aborted) return Promise.reject(new Error('Research cancelled'))
    clearTimeout(this.idle)
    return new Promise((resolve, reject) => {
      const cancel = () => { this.release(request.requestId, 'cancel'); reject(new Error('Research cancelled')) }
      signal?.addEventListener('abort', cancel, { once: true })
      this.pending.set(request.requestId, { resolve, reject, update, cancel, signal })
      this.child.stdin.write(JSON.stringify(request) + '\n')
    })
  }
  release(requestId, type = 'release') {
    const waiting = this.pending.get(requestId)
    waiting?.signal?.removeEventListener('abort', waiting.cancel)
    this.pending.delete(requestId)
    if (!this.dead) this.child.stdin.write(JSON.stringify({ requestId, type }) + '\n')
    if (!this.pending.size) this.idle = setTimeout(() => this.stop(), 60_000)
    this.idle?.unref()
  }
  stop() {
    clearTimeout(this.idle)
    if (this.dead) return
    this.child.stdin.end()
    // The process group includes Chromium; never leave detached browsers behind on shutdown.
    const pid = this.child.pid
    if (pid && process.platform !== 'win32') { try { process.kill(-pid, 'SIGTERM') } catch { /* already exited */ } }
    else if (pid) spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {})
    this.dead = true
  }
}
