---
name: computer-use
description: How to get something done on this computer fastest and most surely — an app's
  own tools, then opening and scripting apps directly, then run_task inside a window, and
  clicking by hand only last. Use before doing anything in an app or on screen.
license: AGPL-3.0-only
---

Take the first route that can do the job. The app's own tools come first, then `run_task`.
Each one down the list is slower and easier to get wrong.

## 1. The app's own tools

If Alexia has tools for the app (Spotify, Blender, Figma, a mail or calendar plugin, anything
added as a server), use them. They act on the app's real objects, with no screen involved.

## 2. `run_task` with your plan, for anything that takes more than one action

**Write the whole plan yourself, in this first turn, and send it in `steps`.** `run_task` runs
it at once with no model in the loop — each control is found by its name or its role — and the
person watches it tick off as a checklist. Nothing you add before it (`windows`, `focus`,
`open_app`) is needed; every extra turn is seconds the person waits for nothing.

How to write a plan that works first time:

1. **Start at the page that does the job** with `open_url`, with the details in the address.
   Two steps from the right address beat seven clicks from a home page.
2. **Name every control as it is called on screen**, or by a plain role: `the search box`,
   `the first video`, `the second result`, `the Latest tab`. Never describe what it looks like.
3. **Add `expect`** after a step that changes the screen: a word from something that should
   then show.
4. **End a lookup with `read` then `answer`.** `read` copies what a control says into a name;
   `answer` is the reply, with `{name}` filled in from the screen. The person gets it straight
   away, word for word, and you are not asked again.
5. Keep each step's `say` under six words; it is the checklist line the person reads.
6. Turn *next Monday*, *tomorrow* and the like into a date from today's first.

Examples:

- Newest video on a channel:
  `[{"do":"open_url","url":"https://www.youtube.com/@MrBeast/videos","say":"Open his videos","expect":"Latest"},
  {"do":"read","target":"the first video","as":"title","say":"Read the newest title"},
  {"do":"answer","text":"The newest MrBeast video is “{title}”."}]`
- A search on a site: `open_url` to its results address
  (`https://www.youtube.com/results?search_query=lofi+beats`, `https://www.amazon.com/s?k=usb+cable`,
  `https://www.google.com/search?q=…`), then `read` or `press` `the first result`.
- A train on IDOS — one step; the answer lists what is on screen, and you read the times from it:
  `[{"do":"open_url","url":"https://idos.cz/vlaky/spojeni/vysledky/?f=Cheb&t=Praha&date=28.9.2026&time=8:00","say":"Open the connections"}]`
- Typing into a page: `{"do":"type","target":"the search box","text":"MrBeast"}`, then
  `{"do":"key","keys":"enter"}`.

**Web pages open in the browser the person chose** in settings. Do not open another browser to
browse in, and leave `pid` out of a plan that starts with `open_url`: the task follows the page
to that browser by itself. If the person names a browser that is not the chosen one, it is
still the chosen one the pages open in — say so rather than work around it.

**The person's accounts are already open.** The browser is theirs and signed in — school
(Moodle, Bakaláři), mail, shops, anything they use. *Get my homework from Moodle* means open
Moodle and get it: you act as them, in their session, the same as if they clicked. Never ask
for a password, and never tell them to fetch it themselves. If a sign-in page is what shows,
say so and let them sign in, then carry on. A file you download lands in their Downloads
folder; read it with the documents tool (`extract`) and answer from it.

A plan that sends, deletes, pays or posts comes back as `confirm` with nothing done. Show the
person the steps, and when they say yes call again with the same steps and `confirmed: true`.

**When it hands back**, it says which step it could not do, lists what is on screen, and gives
the steps not done yet. Send a corrected plan for the rest — with the control's name exactly
as listed — in one new `run_task`. Do not switch to pressing step by step.

Without `steps` it uses the plan that worked last time for the same goal, or a built-in one for
common goals, and otherwise hands back asking for steps.

## 3. Ask the system or the app directly, for one thing

- **Open an app:** `open_app` with its name. Never Spotlight, the Dock, or cmd+space.
- **Open a web page:** `open_url`, straight to the page that does the job, for example a site's
  own search results address rather than its home page, with the details in it when the site
  takes them there (`https://idos.cz/vlaky/spojeni/vysledky/?f=Cheb&t=Praha&date=28.9.2026&time=8:00`). Typing into the browser's address bar
  searches the web, not the site.
- **Apple's own apps and many others:** `run_script` with AppleScript. Music, Mail, Finder,
  Safari, Notes, Calendar, Reminders and System Events answer with their real objects, e.g.
  `tell application "Music" to play playlist "Focus"`.
- **The person's own automations:** `run_shortcut`. Call it with no name to see the list.

## Web pages

In a browser, `elements` lists the page's own buttons, links and fields, and `press` presses
them inside the page with no pointer. Chromium browsers (Comet, Chrome, Brave, Edge, Arc) need
*View → Developer → Allow JavaScript from Apple Events* for that. If `elements` says it is
off, tell the person where to turn it on.

`open_url`, `press`, `click` and `key` answer with what is on screen afterwards. Read that
rather than calling `elements` again.

## 4. By hand, last

Use `elements` + `press` (or `click` on a point `elements` gave) only when the steps above
cannot reach it.

**You cannot see screenshots.** `screenshot` shows the person a picture; you get a file name.
Nothing in it tells you where to click, and `click` refuses a point no listing named. When
`elements` lists nothing useful (a canvas, a game, a remote desktop), say so and ask the
person, rather than trying points.

## Don't go round in circles

- **Answer as soon as the screen shows it.** When the person asked for information — a title,
  a time, a price — and the last listing has it, stop and tell them. Do not open, scroll or
  list again to be sure.
- **Use the process id the last tool named.** `open_url` says which browser the page opened
  in. A pid from an app opened earlier is a different window.
- **Scroll by a screenful** (`down` 15 or more), not 2 or 3 lines. The answer shows what is on
  screen afterwards, so there is no need to call `elements` after it.

- An `elements` search that finds nothing means that name is not there. Leave the filter
  off and read what is there, rather than trying other words.
- Don't open the same app or page again to start over. Look at where things are and carry on.
- When two tries at the same step have failed, stop and tell the person what you see.

## Always

- Anything that sends, deletes, pays or posts: say what you are about to do first.
- Nothing is pressed while "Allow her to press things" is off. Tell the person where to turn
  it on rather than trying another way around it.
