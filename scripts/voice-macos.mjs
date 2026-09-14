// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The two voice programs, built for a Mac (D147).
 *
 * `plugins/voice` downloads a prebuilt Whisper and a prebuilt Piper, pinned, from the projects
 * that make them. On Windows both exist. On a Mac **neither does**, and the reasons were
 * measured rather than assumed:
 *
 * - **whisper.cpp publishes no macOS program at all.** Its releases carry an xcframework — a
 *   library for app developers — and no `whisper-cli` or `whisper-stream` to run.
 * - **Piper's `piper_macos_aarch64.tar.gz` is an Intel binary.** On Apple Silicon with no
 *   Rosetta it is `bad CPU type in executable`, and with Rosetta it still cannot find its own
 *   libraries: they are not in the archive beside it, and the binary has no rpath to look for
 *   them with.
 *
 * So this builds both from the same pinned sources, for the architecture it runs on, and packs
 * the two archives the plugin downloads. `.github/workflows/voice-macos.yml` runs it on one
 * Apple Silicon and one Intel runner and attaches the results to a release; running it on a Mac
 * by hand produces the same files, which is how it was proved before the workflow existed.
 *
 *     node scripts/voice-macos.mjs        # → dist-voice/whisper-bin-macos-<arch>.tar.gz
 *                                         #   dist-voice/piper-macos-<arch>.tar.gz
 *
 * Needs `cmake` on `PATH` and the Command Line Tools. Every download below is pinned, including
 * the one Piper's own build would otherwise take from a branch.
 *
 * **It checks what it built before packing it**, because a program that links a library from
 * the build machine works perfectly on the build machine and nowhere else — and that is the
 * exact way Piper's own Mac release is broken.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RELEASE as PIPER } from '../plugins/voice/piper.js'
import { RELEASE as WHISPER } from '../plugins/voice/whisper.js'

const SDL = '2.32.10'
/** The phonemiser Piper 2023.11.14-2 was released against. Piper's build takes `master` otherwise. */
const PHONEMIZE = '2023.11.14-4'
const ONNXRUNTIME = '1.14.1'

if (process.platform !== 'darwin') throw new Error('This builds the macOS voice programs, and this is not a Mac.')
const arch = { arm64: 'arm64', x64: 'x64' }[process.arch]
if (!arch) throw new Error(`No macOS build for ${process.arch}.`)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dist-voice')
const work = join(out, `build-${arch}`)
const stage = join(out, `stage-${arch}`)
rmSync(work, { recursive: true, force: true })
rmSync(stage, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
mkdirSync(stage, { recursive: true })

function sh(command, args, options = {}) {
  const done = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (done.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${String(done.status)}`)
  return done
}

/** Download and unpack a `.tar.gz` into `work`, returning the folder it made. */
async function source(url, name) {
  const archive = join(work, `${name}.tar.gz`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`${url} answered ${String(response.status)}`)
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()))
  const before = new Set(readdirSync(work))
  sh('tar', ['-xzf', archive, '-C', work])
  const made = readdirSync(work).find((entry) => !before.has(entry))
  if (!made) throw new Error(`${url} unpacked to nothing new`)
  return join(work, made)
}

const RELEASE_FLAGS = ['-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0']
const cmake = (from, to, flags) => {
  sh('cmake', ['-S', from, '-B', to, ...RELEASE_FLAGS, ...flags])
  sh('cmake', ['--build', to, '--config', 'Release', '-j', '8'])
}

/**
 * Every library a Mach-O file loads that will not be on somebody else's Mac.
 *
 * The system's own are fine; `@rpath/` is fine when the library travels in the same folder;
 * anything else is a path on this machine.
 */
function foreign(file, shipped = []) {
  const said = spawnSync('otool', ['-L', file], { encoding: 'utf8' }).stdout.split('\n').slice(1)
  return said
    .map((line) => line.trim().split(' (')[0])
    .filter((lib) => lib && !lib.startsWith('/usr/lib/') && !lib.startsWith('/System/'))
    .filter((lib) => !shipped.some((name) => lib === `@rpath/${name}`))
}

/**
 * Signed, because Apple Silicon will not run an unsigned binary at all — and a copied or
 * edited one has lost whatever signature the linker gave it. Ad hoc unless a release names an
 * identity, which is the same rule `sidecar.mjs` keeps for the app.
 */
function sign(file) {
  const identity = process.env.APPLE_SIGNING_IDENTITY || '-'
  sh('codesign', ['--force', ...(identity === '-' ? [] : ['--timestamp', '--options', 'runtime']), '--sign', identity, file])
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

// ---- Whisper ------------------------------------------------------------------------------

// SDL2 is what `whisper-stream` opens the microphone with. Static, so the program carries it
// and nobody has to have it installed — Homebrew's copy is a path on the build machine.
const sdl = await source(`https://github.com/libsdl-org/SDL/releases/download/release-${SDL}/SDL2-${SDL}.tar.gz`, 'sdl')
cmake(sdl, join(work, 'sdl-build'), ['-DSDL_SHARED=OFF', '-DSDL_STATIC=ON', '-DSDL_TEST=OFF', `-DCMAKE_INSTALL_PREFIX=${join(work, 'sdl')}`])
sh('cmake', ['--install', join(work, 'sdl-build')])

const whisperSource = await source(`https://github.com/ggml-org/whisper.cpp/archive/refs/tags/${WHISPER}.tar.gz`, 'whisper')
sh('cmake', [
  '-S', whisperSource, '-B', join(work, 'whisper-build'), ...RELEASE_FLAGS,
  '-DBUILD_SHARED_LIBS=OFF',
  '-DWHISPER_SDL2=ON',
  `-DSDL2_DIR=${join(work, 'sdl', 'lib', 'cmake', 'SDL2')}`,
  // Not tuned to the CPU it was built on: a runner with a newer chip would otherwise emit
  // instructions an older Mac does not have, and that is a crash with no sentence in it.
  '-DGGML_NATIVE=OFF',
  // The GPU shaders inside the program, rather than a `.metal` file it has to find at run time.
  '-DGGML_METAL_EMBED_LIBRARY=ON',
  '-DWHISPER_BUILD_TESTS=OFF',
  '-DWHISPER_BUILD_EXAMPLES=ON',
])
sh('cmake', ['--build', join(work, 'whisper-build'), '--config', 'Release', '-j', '8', '--target', 'whisper-cli', 'whisper-stream'])

const whisperDir = join(stage, `whisper-bin-macos-${arch}`)
mkdirSync(whisperDir)
for (const program of ['whisper-cli', 'whisper-stream']) {
  const to = join(whisperDir, program)
  cpSync(join(work, 'whisper-build', 'bin', program), to)
  const wrong = foreign(to)
  if (wrong.length > 0) throw new Error(`${program} loads libraries no other Mac has: ${wrong.join(', ')}`)
  sign(to)
}
sh(join(whisperDir, 'whisper-cli'), ['--help'], { stdio: 'ignore' })

// ---- Piper --------------------------------------------------------------------------------

// The phonemiser first, pinned, with onnxruntime already where its build looks. Its own
// download of onnxruntime runs at configure time through CMake's `file(DOWNLOAD)`, which on
// the machine this was first built on wrote an empty file and carried on — so it is fetched
// here, where a failure is a failure.
const phonemize = await source(`https://github.com/rhasspy/piper-phonemize/archive/refs/tags/${PHONEMIZE}.tar.gz`, 'phonemize')
const onnx = `onnxruntime-osx-${arch === 'arm64' ? 'arm64' : 'x86_64'}-${ONNXRUNTIME}`
mkdirSync(join(phonemize, 'lib'), { recursive: true })
const onnxArchive = join(work, `${onnx}.tgz`)
{
  const response = await fetch(`https://github.com/microsoft/onnxruntime/releases/download/v${ONNXRUNTIME}/${onnx}.tgz`)
  if (!response.ok) throw new Error(`onnxruntime ${ONNXRUNTIME} answered ${String(response.status)}`)
  writeFileSync(onnxArchive, Buffer.from(await response.arrayBuffer()))
}
sh('tar', ['-xzf', onnxArchive, '-C', join(phonemize, 'lib')])
const phonemized = join(work, 'pi')
cmake(phonemize, join(work, 'phonemize-build'), [`-DCMAKE_INSTALL_PREFIX=${phonemized}`])
sh('cmake', ['--install', join(work, 'phonemize-build')])

const piperSource = await source(`https://github.com/rhasspy/piper/archive/refs/tags/${PIPER}.tar.gz`, 'piper')
const piperInstall = join(work, 'piper-install')
cmake(piperSource, join(work, 'piper-build'), [`-DPIPER_PHONEMIZE_DIR=${phonemized}`, `-DCMAKE_INSTALL_PREFIX=${piperInstall}`])
sh('cmake', ['--install', join(work, 'piper-build')])

/**
 * What Piper needs beside it, under the names it asks for.
 *
 * Its install step copies the libraries' *symlinks* — or nothing, depending on the CMake — and
 * the binary it links carries no rpath, which together are the whole of what is wrong with the
 * upstream Mac archive. So every library it loads through `@rpath`, and every one *those* load,
 * is copied as a file under exactly the name `otool -L` shows, and the binary is told to look
 * beside itself.
 *
 * Read off the binary rather than listed, because the list is not stable: the phonemiser's
 * pinned tag names espeak `libespeak-ng.dylib` and splits `libucd.dylib` out of it, where its
 * `master` names it `libespeak-ng.1.dylib` and does not. A list written against one would
 * package a Piper that cannot start against the other.
 */
const piperDir = join(stage, 'piper')
mkdirSync(piperDir)
cpSync(join(piperInstall, 'piper'), join(piperDir, 'piper'))
cpSync(join(piperInstall, 'espeak-ng-data'), join(piperDir, 'espeak-ng-data'), { recursive: true })
if (existsSync(join(piperInstall, 'libtashkeel_model.ort'))) {
  cpSync(join(piperInstall, 'libtashkeel_model.ort'), join(piperDir, 'libtashkeel_model.ort'))
}
const rpathed = (file) =>
  spawnSync('otool', ['-L', file], { encoding: 'utf8' })
    .stdout.split('\n')
    .slice(1)
    .map((line) => /^\s*@rpath\/(\S+)/.exec(line)?.[1])
    .filter(Boolean)
const LIBRARIES = []
for (const pending = rpathed(join(piperDir, 'piper')); pending.length > 0; ) {
  const library = pending.shift()
  if (LIBRARIES.includes(library)) continue
  LIBRARIES.push(library)
  // The real file behind the versioned symlink, under the symlink's name.
  copyFileSync(realpathSync(join(phonemized, 'lib', library)), join(piperDir, library))
  pending.push(...rpathed(join(piperDir, library)))
}
sh('install_name_tool', ['-add_rpath', '@executable_path', join(piperDir, 'piper')])
for (const file of [...LIBRARIES.map((library) => join(piperDir, library)), join(piperDir, 'piper')]) {
  const wrong = foreign(file, LIBRARIES)
  if (wrong.length > 0) throw new Error(`${file} loads libraries no other Mac has: ${wrong.join(', ')}`)
  sign(file)
}

// Piper's own test voice, which ships in its source, saying something. A binary that starts
// is not the claim; a WAV with sound in it is.
const heard = join(work, 'piper-check.wav')
sh(join(piperDir, 'piper'), ['-m', join(piperSource, 'etc', 'test_voice.onnx'), '-f', heard, '-q'], {
  input: 'Alexia is checking that this voice can speak.',
  stdio: ['pipe', 'ignore', 'inherit'],
})
if (!existsSync(heard) || statSync(heard).size < 10_000) throw new Error('Piper ran and produced no speech.')

// ---- pack ---------------------------------------------------------------------------------

const archives = [
  [`whisper-bin-macos-${arch}.tar.gz`, `whisper-bin-macos-${arch}`],
  [`piper-macos-${arch}.tar.gz`, 'piper'],
]
for (const [name, folder] of archives) {
  sh('tar', ['-czf', join(out, name), '-C', stage, folder])
  console.log(`${name}  ${(statSync(join(out, name)).size / 1024 / 1024).toFixed(1)} MB  sha256 ${sha256(join(out, name))}`)
}
