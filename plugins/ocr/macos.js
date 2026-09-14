// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process'

/**
 * Reading the words in a picture, through the engine macOS already has (D146).
 *
 * The same bargain `windows.js` made, on the other platform: no `tesseract.js`, no model, no
 * download. macOS ships **Vision** — `VNRecognizeTextRequest`, the engine behind Live Text —
 * and it is reachable from `osascript`'s JavaScript, which can call Objective-C directly. So
 * this is a string of script and one spawn per picture, exactly as the Windows side is a string
 * of PowerShell, and it survives `scripts/publish.mjs` bundling it for the same reason.
 *
 * Same interface, so `index.js` does not know which one it has: `supported`, `languages`, and
 * `read`, whose lines carry the box each one sits in — in **pixels from the top-left**, which
 * is what `lines.js` sorts on. Vision measures the other way up and in fractions, so that is
 * converted here and nowhere else.
 */

export const supported = () => process.platform === 'darwin'

/** What a person reads when this engine is named in a sentence. */
export const engine = 'macOS'

/**
 * Run a JavaScript-for-Automation script with arguments, and parse what it printed.
 *
 * Arguments go through `argv` rather than being pasted into the script, so a path with a quote
 * in it is a path and never code — the rule `windows.js` keeps with `quoted`, kept here by not
 * building a script out of values at all.
 */
function run(script, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    })
    let out = ''
    let said = ''
    child.stdout.on('data', (chunk) => (out += String(chunk)))
    child.stderr.on('data', (chunk) => (said += String(chunk)))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) return resolve(JSON.parse(out))
      // `execution error: Error: …` is osascript's own framing round the one useful clause.
      const why = said.trim().replace(/^.*execution error:\s*(Error:\s*)*/s, '').replace(/\s*\(-?\d+\)$/, '')
      reject(new Error(why || `osascript exited ${String(code)}`))
    })
  })
}

/** The request, set up once for both calls. `Accurate` because nobody is waiting on a frame. */
const REQUEST = `
ObjC.import('Vision'); ObjC.import('AppKit');
const request = $.VNRecognizeTextRequest.alloc.init;
request.recognitionLevel = $.VNRequestTextRecognitionLevelAccurate;
request.usesLanguageCorrection = true;
const supportedTags = () => ObjC.deepUnwrap(request.supportedRecognitionLanguagesAndReturnError(null)) || [];
const nameOf = (tag) => { const name = $.NSLocale.currentLocale.localizedStringForLanguageCode(tag); return name.isNil() ? tag : name.js; };
`

/** What Vision can read here, as BCP-47 tags with names in the reader's own language. */
export const languages = (signal) =>
  run(
    `${REQUEST}
function run() {
  return JSON.stringify(supportedTags().map((tag) => ({ tag, name: nameOf(tag) })));
}`,
    [],
    signal,
  )

/**
 * One picture, as lines with the box each one sits in. Known failures come back as a sentence,
 * the way `windows.js` answers them, because each has something a person can do about it.
 */
export const read = (path, { language = '', signal } = {}) =>
  run(
    `${REQUEST}
function run(argv) {
  const [path, wanted] = argv;
  const refuse = (why) => JSON.stringify({ ok: false, why });
  if (!$.NSFileManager.defaultManager.fileExistsAtPath(path)) return refuse('there is no file at ' + path + '.');

  // Asked before Vision is, because Vision's refusal of a file that is not a picture is a
  // domain and a code rather than a sentence. **From the bytes, never the name**: a page
  // another plugin hands over is spilled to a file with no extension, and every AppKit call
  // that takes a path picks its decoder by extension — so that page was *not a picture*.
  const bytes = $.NSData.dataWithContentsOfFile(path);
  const picture = bytes.isNil() ? bytes : $.NSBitmapImageRep.imageRepWithData(bytes);
  if (picture.isNil()) {
    return refuse('macOS could not open that file as a picture, so there was nothing to read text in. It reads PNG, JPEG, HEIC, TIFF, GIF and BMP.');
  }
  // Numbers, not the bridged objects AppKit hands back, which JSON would write as strings.
  const width = Number(picture.pixelsWide), height = Number(picture.pixelsHigh);

  const have = supportedTags();
  let used = 'automatic';
  if (wanted) {
    // \`cs\` is a fair thing to ask for and Vision only answers to \`cs-CZ\`, so a bare language
    // matches its first region, and a full tag must match exactly.
    const lower = wanted.toLowerCase();
    const match = have.find((tag) => tag.toLowerCase() === lower) || have.find((tag) => tag.toLowerCase().startsWith(lower + '-'));
    if (!match) return refuse('macOS cannot recognise text in ' + wanted + ' on this machine. It can read: ' + have.join(', ') + '.');
    request.recognitionLanguages = $([match]);
    used = match;
  } else {
    request.automaticallyDetectsLanguage = true;
  }

  const handler = $.VNImageRequestHandler.alloc.initWithDataOptions(bytes, $({}));
  const error = Ref();
  if (!handler.performRequestsError($([request]), error)) {
    return refuse('macOS would not read that picture: ' + (error[0] && !error[0].isNil() ? error[0].localizedDescription.js : 'no reason given') + '.');
  }

  const lines = [];
  const results = request.results;
  for (let i = 0; i < results.count; i++) {
    const found = results.objectAtIndex(i);
    const best = found.topCandidates(1);
    if (best.count === 0) continue;
    // Vision's box is a fraction of the picture with its origin at the bottom left.
    const box = found.boundingBox;
    lines.push({
      text: best.objectAtIndex(0).string.js,
      top: Math.round((1 - box.origin.y - box.size.height) * height),
      left: Math.round(box.origin.x * width),
      height: Math.round(box.size.height * height),
    });
  }
  return JSON.stringify({ ok: true, language: used, width, height, lines });
}`,
    [path, language],
    signal,
  ).then((found) => {
    if (found.ok !== true) throw new Error(String(found.why))
    return found
  })
