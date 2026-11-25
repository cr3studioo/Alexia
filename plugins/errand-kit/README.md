# Errands (`errand-kit`)

Three skills and a few tools for the errands around a trip or an office.

- **travel**: plans a trip (dates, route, places, a day-by-day plan, a packing list) and saves it as a note.
- **booking**: prepares a booking with options, prices and links, then stops before paying or submitting.
- **forms**: fills PDF forms and keeps a paperwork checklist.

**Nothing here pays, books or submits.** Every skill says so, and there is no tool that does.

## Tools

| Tool | What it does |
|---|---|
| `form_fields {path}` | The fillable fields of a PDF (name, type, options, value). Read-only. A flat PDF returns "no fillable fields" and, if `document.extract` exists, its text. |
| `fill_form {path, values}` | Writes `<name> (filled).pdf` beside the original; `(2)`, `(3)` on a clash; never overwrites. Returns the path and the fields left empty. |
| `paperwork_add {what, due?, docs?}` | Adds a checklist item. |
| `paperwork_done {id}` | Ticks it off. |
| `paperwork {}` | The checklist. Read-only. |

Paths must be inside the folders the owner opened (MCP roots), and must be PDFs.

## Scheduler

`notice_items` offers open paperwork that has a `due` day, key `errands:<id>`. `notice_done`
closes `errands:<id>` and ignores every other key.

## Not here

Web forms are a later task. Field values are never logged.
