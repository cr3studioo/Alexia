// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { bestPhoto, fileTurn, isImageMime, kindOf, PHOTO_MAX, photoNote, safeName, tooBig } from '../incoming.js'

// What arrives besides typed words, and the two ways it could go wrong: a `document` that is
// really an image getting treated as a generic file, and a filename walking out of the
// directory it was written to. Both are checked here because both are one string comparison
// or one regex away from silently being wrong.

test('kindOf finds the right branch, in order', () => {
  expect(kindOf({ web_app_data: { data: '{}' } })).toBe('web_app')
  expect(kindOf({ photo: [{ file_id: 'a', width: 1, height: 1 }] })).toBe('photo')
  expect(kindOf({ photo: [] })).toBeUndefined()
  expect(kindOf({ document: { mime_type: 'image/png' } })).toBe('image_document')
  expect(kindOf({ document: { mime_type: 'application/pdf' } })).toBe('document')
  expect(kindOf({ voice: { file_id: 'v' } })).toBe('voice')
  expect(kindOf({ audio: { file_id: 'a' } })).toBe('voice')
  expect(kindOf({ text: 'hi' })).toBe('text')
  expect(kindOf({ text: '' })).toBe('text')
  expect(kindOf({})).toBeUndefined()
  expect(kindOf(undefined)).toBeUndefined()
})

test('a web_app_data message wins even if it also carries text', () => {
  expect(kindOf({ web_app_data: { data: '{}' }, text: 'ignored' })).toBe('web_app')
})

test('isImageMime accepts the raster formats Telegram sends, and nothing else', () => {
  expect(isImageMime('image/png')).toBe(true)
  expect(isImageMime('image/jpeg')).toBe(true)
  expect(isImageMime('image/jpg')).toBe(true)
  expect(isImageMime('IMAGE/WEBP')).toBe(true)
  expect(isImageMime('image/gif')).toBe(true)
  expect(isImageMime('image/svg+xml')).toBe(false)
  expect(isImageMime('application/pdf')).toBe(false)
  expect(isImageMime(undefined)).toBe(false)
})

test('bestPhoto picks the largest size that fits under PHOTO_MAX', () => {
  const sizes = [
    { file_id: 'small', width: 10, height: 10, file_size: 100 },
    { file_id: 'big', width: 1000, height: 1000, file_size: PHOTO_MAX },
    { file_id: 'huge', width: 5000, height: 5000, file_size: PHOTO_MAX + 1 },
  ]
  expect(bestPhoto(sizes)?.file_id).toBe('big')
})

test('bestPhoto falls back to the smallest when nothing fits', () => {
  const sizes = [
    { file_id: 'big', width: 5000, height: 5000, file_size: PHOTO_MAX + 1 },
    { file_id: 'bigger', width: 8000, height: 8000, file_size: PHOTO_MAX * 2 },
  ]
  expect(bestPhoto(sizes)?.file_id).toBe('big')
})

test('bestPhoto treats an unknown file_size as fitting', () => {
  const sizes = [
    { file_id: 'known', width: 10, height: 10, file_size: 100 },
    { file_id: 'unknown', width: 9000, height: 9000 },
  ]
  expect(bestPhoto(sizes)?.file_id).toBe('unknown')
})

test('bestPhoto is undefined for empty or non-array input', () => {
  expect(bestPhoto([])).toBeUndefined()
  expect(bestPhoto(undefined)).toBeUndefined()
  expect(bestPhoto('not an array')).toBeUndefined()
})

test('safeName keeps only a safe basename', () => {
  expect(safeName('../../etc/passwd')).toBe('passwd')
  expect(safeName('C:\\Users\\x\\a b.pdf')).toBe('a_b.pdf')
  expect(safeName('.hidden')).toBe('hidden')
  expect(safeName('')).toBe('file')
  expect(safeName(undefined)).toBe('file')
  expect(safeName('a'.repeat(200) + '.txt')).toHaveLength(100)
})

test('tooBig only fires for a real, over-the-limit number', () => {
  expect(tooBig(20 * 1024 * 1024 + 1)).toBe(true)
  expect(tooBig(20 * 1024 * 1024)).toBe(false)
  expect(tooBig(undefined)).toBe(false)
  expect(tooBig('big')).toBe(false)
})

test('fileTurn with a caption puts it first, then the marker line, then the text', () => {
  expect(fileTurn('what is this?', 'report.pdf', 'the extracted text')).toBe(
    'what is this?\n\nThe file report.pdf says:\n\nthe extracted text',
  )
})

test('fileTurn with no caption starts directly at the marker line', () => {
  expect(fileTurn('', 'report.pdf', 'the extracted text')).toBe('The file report.pdf says:\n\nthe extracted text')
  expect(fileTurn(undefined, 'report.pdf', 'text')).toBe('The file report.pdf says:\n\ntext')
})

test('photoNote reflects whether there was a caption', () => {
  expect(photoNote('')).toBe('[a photo]')
  expect(photoNote(undefined)).toBe('[a photo]')
  expect(photoNote('a sunset')).toBe('[a photo] a sunset')
})
