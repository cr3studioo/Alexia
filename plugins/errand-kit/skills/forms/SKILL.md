---
name: forms
description: Fill in PDF forms from what is known about the owner, and keep a paperwork checklist with deadlines. Use when the user hands over a PDF form to fill, or asks what paperwork they have to do and by when.
license: AGPL-3.0-only
---

Fill the form on this computer and keep track of what is still to hand in.

Capabilities this uses: `memory.recall` (name, address, dates, numbers the owner has told you), `tasks.add` (a reminder for a step that is not paperwork), `calendar.events` and `calendar.create` (a deadline in the calendar, only when they say yes), `web.research` (what a form asks for, or where it goes).

1. Call `form_fields` on the PDF. If it has no fillable fields, say so and offer to list what it asks for.
2. Match the fields to what you know. Recall first, then ask the owner for the rest, one short question for several fields at a time. Never invent a value; leave it empty and say it is empty.
3. Call `fill_form`. It saves "name (filled).pdf" beside the original and never overwrites. Tell the owner the path and which fields were left empty.
4. Record what still has to happen with `paperwork_add` (what, a due day, the papers it needs). A dated item reaches the scheduler, which reminds the owner. When it is done, `paperwork_done`.

A filled copy is local and can be thrown away. **Never pay, book or submit anything without the owner's yes to that exact step.** There is no tool here that sends a form; posting, emailing or uploading it is the owner's step, or a separate yes to that exact step. Do not read form contents back into notes or logs unless the owner asks.
