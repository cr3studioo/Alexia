// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest'
import { MACOS_BUILDS } from '../fetching.js'
import { BUILDS as PIPER_BUILDS, RELEASE as PIPER } from '../piper.js'
import { BUILDS as WHISPER_BUILDS, RELEASE as WHISPER } from '../whisper.js'

/**
 * The Mac programs are built by this repository rather than downloaded from the projects that
 * make them (D147), so the one thing that can silently go wrong is the pins drifting apart:
 * `RELEASE` moved in `whisper.js`, and the URL still pointing at a build of the old tag. The
 * release tag names both pins, and this is what holds it to them.
 */
test('the macOS release is named for exactly the versions the plugin pins', () => {
  const tag = MACOS_BUILDS.split('/').at(-1)
  expect(tag).toBe(`voice-macos-${WHISPER}-${PIPER}`)
})

test('both Mac architectures have both programs, and never a Windows one', () => {
  for (const arch of ['arm64', 'x64']) {
    const whisper = WHISPER_BUILDS[`darwin-${arch}`]
    const piper = PIPER_BUILDS[`darwin-${arch}`]
    expect(whisper.url).toBe(`${MACOS_BUILDS}/whisper-bin-macos-${arch}.tar.gz`)
    expect(piper.url).toBe(`${MACOS_BUILDS}/piper-macos-${arch}.tar.gz`)
    for (const name of [whisper.cli, whisper.stream, piper.exe]) expect(name).not.toMatch(/\.exe$/)
  }
})
