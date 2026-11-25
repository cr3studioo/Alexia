# Notes and documents

Reads the documents and notes in the folders you choose, keeps a short summary and a "what it is
about" fingerprint for each, and lets Alexia find them later by meaning — "the PDF about the
scholarship".

## What it reads

- **Text and Markdown** (`.md`, `.markdown`, `.txt`, `.text`, `.org`, `.rst`), always.
- **PDF, Word and similar** (`.pdf`, `.docx`, `.odt`, `.rtf`, `.epub`, `.pptx`), only when
  something on this machine can read documents (`document.extract`). Without it these are left
  alone and the status line says so.
- Only inside folders you opened for Alexia. A folder in this plugin's settings that is outside
  them is **not read**, and the status line says so.
- Dot-folders (`.obsidian`, `.git`, `.trash`), hidden files and links are skipped. A file over
  25 MB is skipped.

It re-reads only what changed: a file with the same size and modified time is not opened at all;
one with a new date but the same content is not summarised again.

## What it never does

- **It never writes to your files.** Nothing in this plugin can: it is handed a way to list,
  look at and read files, and no way to change one.
- It keeps no file contents in its logs. What it stores is, per file: path, size, date, a hash,
  title, a summary of at most three sentences, a vector, tags and links.
- One summary request per new or changed file; none for a file under 200 characters (the text is
  the summary). If no model can be reached, the start of the text is the summary.

## Settings

- **Folders to read**: one folder per line.
- **Notes folder**: one folder treated as a notes vault.
- **Read again**: hourly (default) or daily.

## Pointing it at an Obsidian vault

Open the vault's folder for Alexia, then choose it as **Notes folder**. That is all: it reads
every `.md` in it, keeps `[[wikilinks]]` (aliases, `#Heading` and `![[embeds]]` resolve to the
note's name) and `#tags` (nested `#project/alpha` too, and `tags:` in the front matter), and
skips `.obsidian/`. Any other folder of Markdown files works the same way. The `notes` tool lists
them, and takes a tag.

**Apple Notes is not read here.** It is not a folder of files; reading it needs the Mac limb
(V3-4).

## Tools

`find_document {query, limit?}`, `read_document {path}` (at most 20 000 characters),
`notes {tag?}`, `reindex {}`.
