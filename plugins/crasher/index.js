// SPDX-License-Identifier: AGPL-3.0-only
// The plugin that dies. Three ways, on demand, because process isolation is only worth its
// memory if a plugin can do all three without core noticing anything worse than a tool
// going away. Invariant 3 is the test; this is what it points at.
import { log, plugin } from '@alexia/sdk'

// Before anything else, so the supervisor's restart backoff has something to back off from.
if (process.argv.includes('--die-on-start')) {
  log.error('dying on purpose, before anyone can talk to me')
  process.exit(1)
}

const alexia = plugin()

alexia.tool('exit', { description: 'Exits cleanly in the middle of this call.' }, () => {
  log.error('exiting mid-call')
  process.exit(3)
})

alexia.tool('hang', { description: 'Blocks its own event loop, so not even ping is answered.' }, () => {
  // A busy plugin is still responsive; a wedged one is not. Blocking the thread is the
  // honest version of "hangs forever" — it stops the heartbeat too.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000)
  return { content: [{ type: 'text', text: 'woke up' }] }
})

alexia.tool('leak', { description: 'Allocates until the runtime gives up.' }, () => {
  const held = []
  // The manifest caps this process at a 64 MB heap, so "until the OS objects" arrives in
  // about a second and takes nothing else with it.
  for (;;) held.push(new Array(1_000_000).fill('leaking'))
})

await alexia.start()
log.info('crasher is ready, and sorry in advance')
