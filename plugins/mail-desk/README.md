# Mail desk

Reads new mail through `mail.list` and `mail.read` (whichever account provides them) and sorts it
into `act`, `reply`, `wait`, `read_later` and `noise`. It also watches for parcels in shipping
mail, and keeps a list of bills and subscription renewals with their due days.

It **never marks, moves or deletes mail**, and never logs a subject, a sender or any text.

- `triage.js` — rules first (important senders → act; a reply in a thread you wrote in → reply;
  `List-Unsubscribe` or bulk labels → noise), then one model call per 20 left over. The model sees
  the sender, the subject and the first 500 characters.
- `parcels.js` — tracking numbers by carrier shape, state from the words ("shipped", "out for
  delivery", "delivered" and the Czech ones). No carrier is called.
- `bills.js` — the model reads a bill-like mail; the plugin accepts the answer only if the due day
  is a real date and the amount a real number.
- `desk.js` — the poll loop (only mail newer than the newest seen; the first run looks back three
  days), notices, brief sections and the tools' data.

Tables: `seen` (`id`, `at`, `class`, plus the sender's display name and a ≤ 15-word reason, so a
notice can say who and why), `parcels`, `bills`. No bodies are stored.

Tools: `inbox`, `parcels`, `bills` (read-only), `bill_paid`.
