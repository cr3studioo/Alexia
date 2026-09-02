// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process'

/**
 * Reading the words in a picture, through the engine Windows already has.
 *
 * ponytail: no `tesseract.js`, no ONNX runtime, no Python, no model to download. Windows
 * ships `Windows.Media.Ocr` — the engine behind Snipping Tool's text actions — and it is
 * reachable through the same PowerShell spawn `plugins/computer` already makes for the
 * screen. That is this repo's own rule arriving one namespace over: *four .NET types that
 * are already on every Windows machine*, and here it is three WinRT ones.
 *
 * **It was measured rather than assumed**, because the alternative had a number attached.
 * `document_plan.md` §6.6 records what `tesseract.js` costs — worker start-up plus 10–15 MB
 * of language data, paid on the first read of every session by a plugin that is lazily
 * spawned and stopped when idle. What this costs on the machine it was written on:
 *
 * - a cold call, spawn to answer, **423 ms**;
 * - an A4 page scanned at 300 dpi (2480×3508), **144 ms** of recognition;
 * - nothing downloaded, nothing unpacked, no worker to hold between calls.
 *
 * **And it survives being published**, which is the check that actually decided it.
 * `scripts/publish.mjs` bundles a plugin to one file; `pdfjs-dist` fails that because it
 * reaches for its worker by path at run time, and `tesseract.js` reaches for its worker the
 * same way. A string of PowerShell has no such path. That is D117's lesson taken before
 * rather than after, for the second time in this repo.
 *
 * **What it costs, said plainly: this is Windows only.** macOS has the Vision framework and
 * Linux has no engine at the OS level at all, so on those platforms this plugin refuses by
 * name and whatever asked for `image.ocr` falls back to its own sentence. A cross-platform
 * tier is `tesseract.js`, with the costs above, and it is a second plugin offering this same
 * capability rather than a change to this one.
 */

/** Windows' own PowerShell, asked for by absolute path for the reason `voice` gives. */
function shell() {
  const root = process.env.SystemRoot
  return root ? `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe'
}

export const supported = () => process.platform === 'win32'

/**
 * Run a script and give back what it printed.
 *
 * The same shape `plugins/computer/windows.js` uses, including the antivirus sentence: this
 * is a separate plugin and it does not import that one, because two plugins sharing a module
 * is two plugins that cannot be deleted independently.
 */
function run(script, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      shell(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { stdio: ['ignore', 'pipe', 'pipe'], signal },
    )
    let out = ''
    let said = ''
    child.stdout.on('data', (chunk) => (out += String(chunk)))
    child.stderr.on('data', (chunk) => (said += String(chunk)))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) return resolve(out.trim())
      // The **first** line, not the last. A PowerShell error record is its message followed
      // by `At line:12 char:1` and a caret diagram, so the last line of one is `+ ~~~~~~`
      // and tells nobody anything. Everything this script can predict is answered with a
      // sentence below instead; this is for the ones it cannot.
      const first = said.trim().split('\n').find((line) => line.trim() !== '')
      const last = first?.trim() ?? `PowerShell exited ${String(code)}`
      reject(
        new Error(
          /ScriptContainedMaliciousContent/.test(said) ?
            'Windows blocked this script before it ran — the antivirus decided it looked like malware. ' +
              'Nothing was read. Allowing Alexia in your antivirus settings is the only thing that changes it.'
          : last,
        ),
      )
    })
  })
}

/** A string, as a PowerShell single-quoted literal. Inside `'…'` nothing expands. */
const quoted = (value) => `'${String(value).replace(/'/g, "''")}'`

/**
 * The WinRT preamble, which is four lines of reflection and one of encoding.
 *
 * PowerShell 5.1 cannot `await` an `IAsyncOperation<T>`. The documented way through is
 * `AsTask`, which is a generic extension method, so it has to be found by reflection and
 * closed over the result type at each call — that is the whole of what `Await` is.
 *
 * The encoding line is not decoration. `ConvertTo-Json` writes whatever characters it was
 * given and the console encodes them in the machine's own codepage; on a machine that is not
 * already UTF-8, a Czech or Greek page comes back mojibake and nothing errors. One line, and
 * it is the difference between reading a scan and reading a corrupted one.
 */
const PREAMBLE = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  '$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {',
  "  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and",
  "  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
  'function Await($op, $t) { $asTask.MakeGenericMethod($t).Invoke($null, @($op)).GetAwaiter().GetResult() }',
  '$null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]',
  '$null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]',
  '$null = [Windows.Media.Ocr.OcrEngine,Windows.Media.Ocr,ContentType=WindowsRuntime]',
  '$null = [Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]',
]

/** What Windows can read here, as BCP-47 tags. Empty means no language pack is installed. */
export const languages = (signal) =>
  run(
    [
      ...PREAMBLE,
      'ConvertTo-Json @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages |',
      '  ForEach-Object { @{ tag = $_.LanguageTag; name = $_.DisplayName } }) -Compress -Depth 3',
    ].join('\n'),
    signal,
  ).then((out) => {
    if (!out) return []
    const list = JSON.parse(out)
    return Array.isArray(list) ? list : [list]
  })

/**
 * One picture, as lines with the box each one sits in.
 *
 * **The boxes are the point, not a bonus.** The engine returns lines in its own order, which
 * on anything with two columns is not reading order — an invoice comes back with the totals
 * interleaved into the descriptions, which is precisely the *soup of nouns* `document_plan.md`
 * §4 says is worse than a refusal, because nothing errors and nobody can tell. Sorting them
 * back into reading order needs where they are, so that is what crosses this boundary, and
 * the sorting itself is a pure function in `lines.js` where it can be tested without a
 * desktop.
 *
 * Known failures come back as `{ ok: false, why }` rather than as a thrown error, because
 * each of them has a sentence a person can act on and `run`'s fallback is the last line of
 * stderr.
 */
export const read = (path, { language = '', signal } = {}) =>
  run(
    [
      ...PREAMBLE,
      `$path = ${quoted(path)}`,
      '$wanted = ' + quoted(language),
      // Answered here rather than letting `GetFileFromPathAsync` throw, because what it
      // throws is a four-line .NET exception whose readable half is not on the last line.
      'if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {',
      '  ConvertTo-Json @{ ok = $false; why = "there is no file at " + $path + "." } -Compress',
      '  exit',
      '}',
      '$engine = if ($wanted -ne "") {',
      '  [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language $wanted))',
      '} else { [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }',
      // Two different refusals, because the fix differs: one is *install a language*, the
      // other is *you asked for one that is not here, and here is what is*.
      '$have = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })',
      'if ($null -eq $engine) {',
      '  $why = if ($wanted -ne "") {',
      '    "Windows cannot recognise text in " + $wanted + " on this machine. It can read: " + ($have -join ", ") + "."',
      '  } elseif ($have.Count -eq 0) {',
      '    "Windows has no text-recognition language installed on this machine, so there is nothing to read a picture with. Settings, then Time and language, then Language and region, adds one."',
      '  } else { "Windows would not start its text recogniser." }',
      '  ConvertTo-Json @{ ok = $false; why = $why } -Compress',
      '  exit',
      '}',
      '$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])',
      '$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])',
      // A file that is not a picture at all lands here, and *the decoder threw* is not a
      // sentence. Windows reads PNG, JPEG, BMP, GIF, TIFF, HEIF and JPEG-XR; anything else
      // is a file somebody expected to be a picture and was not.
      '$decoder = $null',
      'try {',
      '  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])',
      '} catch {',
      '  ConvertTo-Json @{ ok = $false; why = "Windows could not open that file as a picture, so there was nothing to read text in. It reads PNG, JPEG, BMP, GIF, TIFF and HEIF." } -Compress',
      '  $stream.Dispose()',
      '  exit',
      '}',
      // The documented ceiling. Past it `RecognizeAsync` throws, and the throw says nothing
      // about size — so it is checked here, where the numbers to put in the sentence are.
      '$most = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension',
      'if ($decoder.PixelWidth -gt $most -or $decoder.PixelHeight -gt $most) {',
      '  $why = "that picture is " + $decoder.PixelWidth + " by " + $decoder.PixelHeight + " pixels, and Windows reads text in pictures up to " + $most + " on a side. Nothing was read."',
      '  ConvertTo-Json @{ ok = $false; why = $why } -Compress',
      '  $stream.Dispose()',
      '  exit',
      '}',
      '$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])',
      '$found = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])',
      '$rows = New-Object System.Collections.ArrayList',
      'foreach ($line in $found.Lines) {',
      '  $top = [double]::MaxValue; $left = [double]::MaxValue; $bottom = 0',
      '  foreach ($word in $line.Words) {',
      '    $r = $word.BoundingRect',
      '    if ($r.Y -lt $top) { $top = $r.Y }',
      '    if ($r.X -lt $left) { $left = $r.X }',
      '    if (($r.Y + $r.Height) -gt $bottom) { $bottom = $r.Y + $r.Height }',
      '  }',
      '  if ($top -eq [double]::MaxValue) { continue }',
      '  $row = New-Object psobject',
      '  $row | Add-Member NoteProperty text ([string]$line.Text)',
      '  $row | Add-Member NoteProperty top ([math]::Round($top))',
      '  $row | Add-Member NoteProperty left ([math]::Round($left))',
      '  $row | Add-Member NoteProperty height ([math]::Round($bottom - $top))',
      '  [void]$rows.Add($row)',
      '}',
      'ConvertTo-Json @{',
      '  ok = $true; language = $engine.RecognizerLanguage.LanguageTag',
      '  width = $decoder.PixelWidth; height = $decoder.PixelHeight; lines = @($rows)',
      '} -Compress -Depth 4',
      '$bitmap.Dispose()',
      '$stream.Dispose()',
    ].join('\n'),
    signal,
  ).then((out) => {
    const found = JSON.parse(out)
    if (found.ok !== true) throw new Error(String(found.why))
    // One line comes back as an object rather than a list, which is `ConvertTo-Json` being
    // PowerShell rather than being JSON.
    return { ...found, lines: Array.isArray(found.lines) ? found.lines : [found.lines] }
  })
