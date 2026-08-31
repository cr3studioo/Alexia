// SPDX-License-Identifier: AGPL-3.0-only
import { extname } from 'node:path'

/**
 * What a file is, and — where it is something this cannot read — **the sentence that says so**.
 *
 * §4 is the reason this file exists rather than a `switch` inside the extractor. *OCR* is one
 * word covering three problems, and the third one fails silently: run a text extractor over a
 * screenshot and nothing errors, because there is nothing in a PNG to error about. What comes
 * back is an empty string, or worse, the handful of characters a watermark left behind — and
 * a model then answers confidently about a document nobody read.
 *
 * So a picture is refused **by kind, before anything opens it**, and the refusal names what is
 * missing rather than what went wrong. That is the same rule the router's refusals follow: say
 * which wall this is, because the fix differs.
 */

/** Extension to kind. The first answer, and right nearly always, because people name files. */
const BY_EXTENSION = {
  // Text, as it is written.
  txt: 'text', text: 'text', log: 'text', me: 'text', nfo: 'text',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown', rst: 'text', adoc: 'text', org: 'text',
  csv: 'csv', tsv: 'csv',
  json: 'code', jsonl: 'code', ndjson: 'code', yaml: 'code', yml: 'code', toml: 'code', ini: 'code',
  cfg: 'code', conf: 'code', env: 'code', properties: 'code', sql: 'code', graphql: 'code',
  js: 'code', mjs: 'code', cjs: 'code', ts: 'code', tsx: 'code', jsx: 'code', py: 'code',
  rb: 'code', go: 'code', rs: 'code', java: 'code', kt: 'code', swift: 'code', c: 'code',
  h: 'code', cpp: 'code', hpp: 'code', cs: 'code', php: 'code', lua: 'code', sh: 'code',
  bash: 'code', zsh: 'code', ps1: 'code', bat: 'code', cmd: 'code', r: 'code', scala: 'code',
  css: 'code', scss: 'code', vue: 'code', svelte: 'code', dart: 'code', pl: 'code', ex: 'code',
  patch: 'code', diff: 'code',
  xml: 'xml', svg: 'xml', plist: 'xml', rss: 'xml', atom: 'xml',
  html: 'html', htm: 'html', xhtml: 'html',
  srt: 'text', vtt: 'text', sub: 'text',
  // Containers full of XML.
  docx: 'docx', xlsx: 'xlsx', pptx: 'pptx',
  odt: 'odt', ods: 'ods', odp: 'odp',
  epub: 'epub',
  // The one that needs a parser of its own.
  pdf: 'pdf',
}

/**
 * The formats that are a **picture**, and the sentence each of them gets (§4, category C).
 *
 * They are listed rather than inferred from *not being text*, because the answer differs: a
 * photograph of a document wants OCR and a screenshot wants a description, and telling
 * somebody the wrong one sends them looking for the wrong thing.
 */
const PICTURES = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'heic', 'heif', 'avif', 'ico', 'jfif',
])

const OTHER = {
  mp3: 'a recording', wav: 'a recording', flac: 'a recording', ogg: 'a recording',
  m4a: 'a recording', aac: 'a recording', opus: 'a recording', wma: 'a recording',
  mp4: 'a video', mov: 'a video', mkv: 'a video', avi: 'a video', webm: 'a video', wmv: 'a video',
  zip: 'an archive', rar: 'an archive', '7z': 'an archive', gz: 'an archive', tar: 'an archive',
  exe: 'a program', dll: 'a program', msi: 'an installer', iso: 'a disc image',
  doc: 'an old Word document', xls: 'an old Excel file', ppt: 'an old PowerPoint file',
  rtf: 'a rich-text file', pages: 'a Pages document', numbers: 'a Numbers spreadsheet',
  key: 'a Keynote deck',
}

/** The first bytes, for the files whose name is wrong or missing. */
function sniff(bytes) {
  const head = bytes.subarray(0, 8)
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf'
  if (head[0] === 0x50 && head[1] === 0x4b && (head[2] === 3 || head[2] === 5 || head[2] === 7)) return 'zip'
  if (head[0] === 0x89 && head.subarray(1, 4).toString('latin1') === 'PNG') return 'png'
  if (head[0] === 0xff && head[1] === 0xd8) return 'jpg'
  if (head.subarray(0, 3).toString('latin1') === 'GIF') return 'gif'
  if (head.subarray(0, 2).toString('latin1') === 'BM') return 'bmp'
  if (head.subarray(0, 4).toString('latin1') === 'RIFF') return 'webp'
  if (head.subarray(0, 2).toString('latin1') === 'MZ') return 'exe'
  if (head.subarray(0, 4).toString('latin1') === '%!PS') return 'ps'
  return undefined
}

/**
 * Which entry a ZIP actually is, when the extension did not say.
 *
 * `.docx` renamed to `.zip` is a real thing people do, and so is a `.epub` with no extension
 * at all. The archive's own contents are the answer and they cost one string search.
 */
function insideZip(bytes) {
  const head = bytes.subarray(0, 4096).toString('latin1')
  if (head.includes('word/')) return 'docx'
  if (head.includes('xl/')) return 'xlsx'
  if (head.includes('ppt/')) return 'pptx'
  if (head.includes('mimetypeapplication/epub')) return 'epub'
  if (head.includes('opendocument.text')) return 'odt'
  if (head.includes('opendocument.spreadsheet')) return 'ods'
  if (head.includes('opendocument.presentation')) return 'odp'
  return undefined
}

/** Everything this reads, for the tool description and for the refusal that lists them. */
export const READABLE =
  'PDF (where it has a text layer), Word, Excel, PowerPoint, OpenDocument, EPUB, HTML, ' +
  'Markdown, CSV, JSON, XML, plain text and source code'

/**
 * What this file is: a kind this can read, or a refusal that says what would read it.
 *
 * The refusal is written for the person who has to act on it, and it deliberately does not
 * apologise. *Nothing installed here reads a scan* is a limit; *could not extract text* is a
 * failure, and only one of the two is true.
 *
 * A picture also comes back with **`picture`**, naming the format, and the two are not
 * redundant. The refusal is what a person is told when nothing here can read a picture; the
 * field is how `index.js` finds out there is something to offer `image.ocr` before falling
 * back to saying it. Neither this file nor the reader beside it ever makes that call — they
 * stay pure and stay testable without a wire, and the refusal they wrote is what a machine
 * with no OCR plugin still gets, word for word.
 */
export function kindOf(name, bytes) {
  const extension = extname(String(name)).slice(1).toLowerCase()
  const magic = sniff(bytes)

  // The bytes win over the name for a container, because a container's name is the one people
  // change. They do not win over a text extension: a `.md` file has no magic number and a
  // `.csv` beginning with `BM` is still a spreadsheet.
  if (magic === 'zip') {
    const inside = insideZip(bytes) ?? (BY_EXTENSION[extension] === undefined ? undefined : extension)
    if (inside !== undefined && inside !== 'zip') return { kind: inside }
    return { refusal: 'that is a zip archive. Unpack it and attach what is inside — this reads documents, not archives.' }
  }
  if (magic !== undefined && PICTURES.has(magic)) return { picture: magic, refusal: picture(magic) }
  if (magic === 'exe' || magic === 'ps') {
    return { refusal: `that is ${OTHER[magic] ?? 'not a document'}, and there are no words in it to read.` }
  }

  const known = BY_EXTENSION[extension]
  if (known !== undefined) return { kind: known }
  if (magic === 'pdf') return { kind: 'pdf' }
  if (PICTURES.has(extension)) return { picture: extension, refusal: picture(extension) }
  if (OTHER[extension] !== undefined) {
    return {
      refusal:
        `that is ${OTHER[extension]}, which this does not read. It reads ${READABLE}.` +
        (extension === 'doc' || extension === 'xls' || extension === 'ppt' || extension === 'rtf' ?
          ' Saving it in the newer format — the one ending in x — is the whole of the fix.'
        : ''),
    }
  }
  // No extension anybody recognises and no magic number. If it decodes as text it is text,
  // and if it does not the caller says so — that check needs the bytes and lives there.
  return { kind: 'unknown' }
}

/**
 * The picture sentence, and the one place in this plugin that names a capability it does not
 * provide.
 *
 * §4 argues that reading a *scan* and describing a *screenshot* are two different jobs with
 * two different answers, and that a single extractor quietly accepting both is the failure
 * mode. So this says which of the two the file looks like, and what each would need.
 */
const picture = (extension) =>
  `that is a picture (a .${extension}), not a document with text in it. Reading the words off a ` +
  'photograph or a scan needs OCR, and describing a screenshot or a chart needs a model that ' +
  'can see — neither of which is installed here. Nothing was read.'

/** The sentence for a PDF that turned out to be a photograph of one. */
export const SCANNED =
  'that PDF has no text layer — it is a picture of a document, which is what a scan or a phone ' +
  'photo produces. Reading one needs OCR, and nothing installed here does that. Nothing was read.'
