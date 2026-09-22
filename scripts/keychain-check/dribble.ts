// SPDX-License-Identifier: AGPL-3.0-only
// vault.rs against a client that connects and dribbles: it must hold only itself, and not for long.
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { vault } from '../../packages/core/src/secrets.ts'

const harness = process.env.KEYCHAIN_HARNESS ?? ''
const child = spawn(harness, [], { stdio: ['pipe', 'pipe', 'inherit'] })
const line = await new Promise<string>((resolve) => child.stdout!.on('data', (chunk) => resolve(String(chunk))))
const { port, token } = JSON.parse(line) as { port: number; token: string }

// A byte every second, never a newline — the shape that used to hold the vault shut for hours.
const started = Date.now()
const slow = connect({ host: '127.0.0.1', port })
const dribble = setInterval(() => slow.write('x'), 1000)
const closedAfter = new Promise<number>((resolve) => slow.on('close', () => resolve(Date.now() - started)))
slow.on('error', () => {})
await new Promise((resolve) => setTimeout(resolve, 1500))

// Core asking meanwhile.
const asked = Date.now()
const answer = await vault({ port, token }).get('zz-migration-test', 'nothing-here')
const took = Date.now() - asked
console.log(`${took < 1000 ? 'PASS' : 'FAIL'}  a request behind a dribbling client is answered at once (${took} ms, got ${String(answer)})`)
const cut = await closedAfter
clearInterval(dribble)
console.log(`${cut >= 4500 && cut < 7000 ? 'PASS' : 'FAIL'}  the dribbling client is cut off at the five-second deadline (${cut} ms)`)
child.stdin!.end()
process.exit(took < 1000 && cut >= 4500 && cut < 7000 ? 0 : 1)