// SPDX-License-Identifier: AGPL-3.0-only
import { clipboardFor } from '../clip.js'
import { assert, test } from './harness.js'

/**
 * Against the real clipboard of the machine it runs on. It overwrites the clipboard, so it
 * only runs when asked: `ALEXIA_LIVE=1 node --test plugins/device-clipboard/test`.
 */
const live = process.env.ALEXIA_LIVE === '1' && clipboardFor() !== undefined

test('the real clipboard round-trips text', { skip: !live && 'set ALEXIA_LIVE=1 on a Windows or macOS desktop', timeout: 60_000 }, async () => {
  const clip = clipboardFor()
  const text = `alexia live test ${String(Date.now())} — “quoted” 🙂\nsecond line`
  await clip.write(text)
  const seen = await clip.read()
  assert.equal(seen.kind, 'text')
  assert.equal(seen.sensitive, false)
  assert.equal(seen.text.replace(/\r\n/g, '\n').trimEnd(), text)
})
