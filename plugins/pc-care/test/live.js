// SPDX-License-Identifier: AGPL-3.0-only
import { homedir, tmpdir } from 'node:os'
import { createCare } from '../care.js'
import { macosBackend } from '../macos.js'
import { windowsBackend } from '../windows.js'
import { assert, slowTest } from './harness.js'

/**
 * This computer, for real, **reading only**: no setting is changed, nothing is deleted, nothing
 * is switched off, and power is never touched. No startup item or file name is printed.
 * `care.test.js` imports this file; nothing here is registered unless `ALEXIA_PC_LIVE=1`.
 */
const LIVE = process.env.ALEXIA_PC_LIVE === '1'
const windows = process.platform === 'win32'

/** The care half over the real backend, with every way of changing something taken out. */
function looking() {
  const real = windows ? windowsBackend() : macosBackend()
  const never = () => {
    throw new Error('a live test tried to change something')
  }
  const backend = { ...real, set: never, power: never, disableStartup: never, deleteUnused: never }
  return createCare({ backend, temp: tmpdir(), home: homedir(), system: process.env.SystemRoot })
}

if (LIVE && (windows || process.platform === 'darwin')) {
  slowTest('live: sound and dark mode are read', async () => {
    const care = looking()
    const volume = (await care.get({ what: 'volume' })).data.value
    assert.ok(Number.isInteger(volume) && volume >= 0 && volume <= 100, String(volume))
    assert.equal(typeof (await care.get({ what: 'mute' })).data.value, 'boolean')
    assert.equal(typeof (await care.get({ what: 'dark_mode' })).data.value, 'boolean')
  })

  slowTest('live: brightness is read, or the screen says it cannot be', async () => {
    try {
      const { value } = (await looking().get({ what: 'brightness' })).data
      assert.ok(value >= 0 && value <= 100, String(value))
    } catch (error) {
      assert.match(error.message, /brightness/)
    }
  })

  slowTest('live: disks, startup items and old temp files are reported', async () => {
    const care = looking()
    const disk = await care.care({ check: 'disk' })
    assert.match(disk.data.report, /free of/)
    const startup = await care.care({ check: 'startup' })
    for (const row of startup.data.items) assert.match(row, /\): (on|off)$/)
    const temp = await care.care({ check: 'temp' })
    assert.match(temp.data.report, /older than 7 days/)
    assert.equal(temp.data.freed_bytes, undefined)
  })

  slowTest('live: waiting updates are reported, or Windows Update says it did not answer', async () => {
    try {
      const { data } = await looking().care({ check: 'updates' })
      assert.ok(Array.isArray(data.items))
    } catch (error) {
      assert.match(error.message, /did not answer|took too long/)
    }
  })
}
