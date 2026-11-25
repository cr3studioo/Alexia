# Study desk

Notes from a lecture or meeting recording, and study sessions over those notes.

## What it does

- **`lecture_notes {path, title?, course?}`** turns a recording into words (`voice.transcribe`),
  summarises it with the model Alexia lends it (one call per 20 minutes of transcript, then one to
  merge when there was more than one part) and saves a Markdown file in the notes folder: a header
  (title, date, course), *Key points*, *Terms*, *Open questions*, then the whole transcript under a
  `<details>` fold. A name that is taken becomes `Title (2).md`; nothing is ever overwritten.
- **`study {course?, minutes?, document?}`** returns the next cards to ask (about one a minute).
  Cards are written by the model from a saved note the first time it is needed, or from a
  document you point at. Read-only apart from making those cards.
- **`answer_card {id, right}`** is Leitner: right moves the card up a box and out 1/2/4/8/16 days
  (box 1 to 5); wrong puts it back in box 1, due tomorrow.
- **`exam {course, day}`** and **`exams {}`** keep exam dates. Dates are `YYYY-MM-DD`.

## Notices

`notice.items`: one low-urgency item "N cards to review" when cards are due, and, for each exam in
the next 14 days, an item with `dueAt` (08:00 on the day, local) and key `study:exam:<id>`.
`notice.done` closes the exam for that key; any other key does nothing.

## Settings and permissions

`notes_folder` is a folder setting. It, and any recording, must be inside a folder you opened in
Alexia; otherwise the tool says so and does nothing. Requires `voice.transcribe`, `fs.read_scoped`
and `fs.write_scoped`. With nothing that can transcribe, `lecture_notes` says so.

Transcript text is never logged. Tables: `notes`, `cards`, `exams`.
