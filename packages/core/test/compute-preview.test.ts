// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { previewOf } from '../src/compute/types.js'

test('a preview passes only as an image data: URL small enough to send', () => {
  expect(previewOf('data:image/jpeg;base64,AAAA', 100)).toEqual({ mime: 'image/jpeg', data: 'AAAA' })
  expect(previewOf('data:image/png;base64,QUJD', 100)).toEqual({ mime: 'image/png', data: 'QUJD' })
  // Not a picture, not inline, or too big: nothing.
  expect(previewOf('data:text/html;base64,AAAA', 100)).toBeUndefined()
  expect(previewOf('https://example.com/a.png', 100)).toBeUndefined()
  expect(previewOf('/Users/someone/secret.png', 100)).toBeUndefined()
  expect(previewOf('data:image/png;base64,AAAA', 3)).toBeUndefined()
  expect(previewOf(undefined, 100)).toBeUndefined()
})
