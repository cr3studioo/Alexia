# Page watch

Watches the pages the owner cares about and says what changed. It only reads.

- **Pages** (`pages`, one address per line): the plugin keeps the last text of each. When it
  changes you get a notice with a short summary: how many lines were added and removed, and up
  to ten of them.
- **School portal** (`portal_url`, `portal_user`, `portal_password`, `portal_pages`): it signs in
  through the form on the page at `portal_url`, reads the paths listed in `portal_pages`, and
  watches them like any page. The password is a `password` setting, kept in the credential
  store; it is sent only to the login form of the portal's own site and appears in no log, tool
  result or notice. Cookies live in memory for one visit. Nothing but the login form is ever
  submitted. If the portal refuses the sign-in, the status says so in one sentence, you get one
  Low notice that day, and it does not try again until tomorrow or until you change the portal
  settings.
- **What you follow** (`feeds`, `interests`): RSS and Atom feeds. New items since the last look
  are matched against your topics (one per line; accents and capitals do not matter, so
  "skola" finds "Škola"; every word of a topic must appear; no topics means everything) and
  become Low notices. The brief gets a section "From what you follow:" with up to 5 items in
  the morning and 10 in the weekly one. The first look at a feed only learns what is there.
- **Look every** 30 minutes, an hour or 3 hours.

It provides `page.text` (the page's main text, at most 20 000 characters; scripts, styles,
navigation and footers removed), which a scheduler watch on a page polls, plus `notice.items`
and `brief.section`.

## Manners

At most one request to a host every 10 seconds, the User-Agent
`Alexia page watch (personal use)`, and `robots.txt` is read and obeyed for the path being
watched (a `robots.txt` that cannot be read because of a server error counts as "do not read").
The portal's own pages are the owner's and skip the robots check, but keep the 10 second gap.

## Limits

- **A login built with scripts** (the form is drawn by JavaScript, or the sign-in is a single-page
  app, or it needs a second factor) has no form to fill in. The plugin says so; reading such a
  portal needs the browser limb (V3-4).
- Pages whose text is drawn by scripts show only what the server sent.
- Prices and stock are deliberately not watched, and there are no shop presets.
- The portal pages must be on the portal's own site; a redirect to another site stops the visit.
