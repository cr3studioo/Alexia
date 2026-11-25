# Screen memory

Keeps the **words** that were on this computer's screen, every few minutes, so Alexia can answer
"what was that error I saw this morning" or "the flight price I had open yesterday".

**It ships off.** Nothing is looked at until you turn it on.

## What is kept

For each moment, one row: when, the app in front, its window title, and the words read off the
screen (at most 4000 characters), plus a "what it is about" fingerprint so it can be found by
meaning. Rows older than the number of days you chose (3, 7 or 14; 14 by default) are deleted once
a day, and right away when you lower the number.

## What is never kept

- **The picture.** A screenshot is taken by whatever on this computer provides screenshots, its
  words are read, and the file is deleted straight after, whether or not the reading worked.
  This plugin never captures the screen itself.
- **Anything while one of these is in front**, and the picture is not even read:
  - an app on your list (by default KeePassXC, 1Password and Bitwarden; add your private chat
    apps there);
  - a window whose title says *password*, *heslo*, *sign in* or *přihlášení*;
  - a window covering the whole screen with no title bar: a game or a full-screen video;
  - the lock screen;
  - a window the screenshot cannot name. When in doubt, the moment is dropped.
- **Secrets inside what is kept.** Card numbers (13 to 19 digits that pass the Luhn check), IBANs,
  and tokens starting `sk-`, `ghp_` or `xox` become `[removed]` before anything is stored.
- **Anything in the logs.** No words, titles or app names are ever written to a log.

## Turning it on and off

In this plugin's settings: **Remember what is on screen**. *Look every* is 2, 5 or 10 minutes
(5 by default). *Never remember these apps* takes process names, separated by commas, such as
`Signal.exe, Telegram.exe`. Turning it off stops the next screenshot; what is already kept stays
until it is older than *Keep for*, or until you forget it.

It needs something that takes screenshots (`computer.screenshot`) and something that reads words
in pictures (`image.ocr`). Finding by meaning uses `text.embed` when something provides it, and
plain word matching when nothing does. The State line says if a piece is missing.

## Forgetting a span

Ask Alexia to forget it, for example "forget what was on my screen between 2 and 3 this
afternoon". That calls `screen_forget` with a start and an end, and every moment in between is
deleted for good. Both ends are required.

## Tools

- `screen_recall {query, from?, to?}`: find moments by meaning, optionally inside a time span. Read-only.
- `screen_forget {from, to}`: delete every moment in a span. Destructive.
- `screen_status {}`: on or off, how often, how long, how many moments.
