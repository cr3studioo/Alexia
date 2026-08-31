// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { install, interpreters, loopback, port, search, tail } from '../launch.js'

// Starting a program on somebody's machine has three ways to be wrong, and they are the
// three things tested here: starting one that is not theirs, starting the wrong folder, and
// starting the right folder with a Python that has no PyTorch in it.

const root = mkdtempSync(join(tmpdir(), 'alexia-media-'))
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))

/** A folder that looks like ComfyUI to the only test that matters: the one on disk. */
const comfy = (...parts) => {
  const dir = join(root, ...parts)
  mkdirSync(dir, { recursive: true })
  for (const file of ['main.py', 'nodes.py']) writeFileSync(join(dir, file), '# not really\n')
  return dir
}

test('a ComfyUI two folders down is found, and a folder with one Python file is not', async () => {
  // The install this was written for lives at `Desktop/_/ComfyUI`, which is why the walk
  // goes two deep rather than one. `main.py` alone matches half the Python on a machine.
  const dir = comfy('desktop', 'stuff', 'ComfyUI')
  const decoy = join(root, 'desktop', 'notcomfy')
  mkdirSync(decoy, { recursive: true })
  writeFileSync(join(decoy, 'main.py'), 'print(1)\n')

  expect(await search(join(root, 'desktop'))).toBe(dir)
  expect(await search(decoy)).toBeUndefined()
})

test('a search that runs out of budget gives up rather than walking the disk', async () => {
  // The protection is the budget, not the depth: a home directory with a hundred thousand
  // files must not turn a request for a picture into a filesystem scan.
  comfy('deep', 'a', 'ComfyUI')
  expect(await search(join(root, 'deep'), 2, 0)).toBeUndefined()
})

test('the folder above the install is accepted, because that is what portable builds look like', async () => {
  // `ComfyUI_windows_portable/` holds `ComfyUI/` and `python_embeded/`, so pointing at the
  // one somebody downloaded is the mistake anybody makes once.
  const dir = comfy('portable', 'ComfyUI')
  expect(await install(join(root, 'portable'))).toBe(dir)
  expect(await install(dir)).toBe(dir)
  expect(await install(join(root, 'nothing-here'))).toBeUndefined()
})

test('the install’s own venv is tried before anything on PATH', () => {
  // ComfyUI runs on the Python that has PyTorch in it and on no other. Getting this order
  // wrong produces "no module named torch" on a machine where ComfyUI works perfectly.
  const order = interpreters(join(root, 'ComfyUI'))
  expect(order[0]).toMatch(/ComfyUI[\\/](venv|\.venv)[\\/]/)
  expect(order.some((path) => path.includes('python_embeded'))).toBe(true)
})

test('only an address on this machine is one Alexia may start', () => {
  // Starting a local process because a *remote* ComfyUI is down would be answering a
  // question nobody asked, on hardware that is not the one in the setting.
  expect(loopback('http://127.0.0.1:8188')).toBe(true)
  expect(loopback('http://localhost:8188')).toBe(true)
  expect(loopback('http://192.168.1.40:8188')).toBe(false)
  expect(loopback('https://comfy.example.com')).toBe(false)
  expect(loopback('not an address')).toBe(false)
})

test('it is started on the port the rest of the plugin then talks to', () => {
  expect(port('http://127.0.0.1:8188')).toBe(8188)
  expect(port('http://127.0.0.1:9999')).toBe(9999)
  // No port in the address means ComfyUI's own default, which is what it would have used.
  expect(port('http://127.0.0.1')).toBe(8188)
  expect(port('rubbish')).toBe(8188)
})

test('when a start fails, what comes back is the last thing ComfyUI said', async () => {
  const log = join(root, 'comfyui.log')
  writeFileSync(log, 'Total VRAM 8188 MB\n\nModuleNotFoundError: No module named torch\n')
  expect(await tail(log, 1)).toBe('ModuleNotFoundError: No module named torch')
  expect(await tail(join(root, 'no-such.log'))).toBe('')
})
