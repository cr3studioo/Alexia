# Give your plugin a page

*Needs `"alexia_protocol": 11`. Decided 2026-09-24 (D199).*

Alexia's window is a **board**: a grid of dots with pages on it, and the person arranges the
pages. Chat is one, General is one, Running now is one. Yours can be one too. You say which of
your widgets it shows at each size; Alexia draws it, places it, and takes it away when your
folder goes.

**You declare; core draws.** A page has no pixels of yours in it and no new widgets. It shows
widgets you already declared in `settings` or `panel.widgets`, drawn by the same renderer as
your plugin's own page in Settings. Nothing on this page is a way round
[settings.md](./settings.md); it is those same widgets in a second place.

## The board, in one paragraph

Dots every **25 px**, centred in the window, with the spare pixels split evenly on both sides.
A page's corners sit on dots and there is always one clear dot between two pages. Three
columns run down the board as **guides**: drag the grip between two columns and every page
whose edge sits on that guide resizes with it. **Edit view** comes from a pill in the
bottom-left corner (or *Edit layout* in the command palette), and in it a person adds, moves
and resizes pages on the dots. A window narrower than 28 dot spaces — about 740 px, which is
the hotkey overlay — stacks the pages in one column instead, without touching the saved layout.
Every page but General can be taken off, Chat included: the board asks first only when no
other way in is connected — no enabled plugin providing
[`channel.chat`](../spec/capabilities.md#the-service-registry) with its keys stored. If your
plugin lets somebody talk to Alexia from elsewhere, list `channel.chat` in `provides`.

## A worked example: Voice

```jsonc
{
  "alexia_protocol": 11,
  "settings": [
    { "key": "which_voice", "type": "choice", "label": "Who speaks", "options": ["Ada", "Rowan"] }
  ],
  "panel": {
    "label": "Voice",
    "widgets": [
      { "key": "listening", "type": "status", "label": "Listening" },
      { "key": "last_heard", "type": "status", "label": "Last heard" }
    ]
  },
  "page": {
    "title": "Voice in/out",
    "sizes": {
      "S": { "at": [8, 4],  "show": ["listening"] },
      "M": { "at": [12, 8], "show": ["listening", "which_voice", "last_heard"] }
    },
    "scale": { "min": [8, 4], "max": [24, 16] }
  }
}
```

Small, it says whether it is listening. Medium, it says which voice and what it last heard,
and the choice can be changed right there — it is the same `which_voice` your settings page
draws, one value, so changing it on the board changes it in Settings. There is no L, so the
person is never offered one.

## Sizes are in dots

| | Dots | Pixels |
|---|---|---|
| `"at": [8, 4]` | 8 wide, 4 tall | 200 × 100 |
| `"at": [12, 8]` | 12 × 8 | 300 × 200 |
| the default page | 12 × 10 | 300 × 250 |
| `"max": [24, 16]` | 24 × 16 | 600 × 400 |
| the largest a tier may be | 80 × 80 | 2000 × 2000 |

Whole numbers, 1 to 80. Measure against the widgets you show rather than against a screen: a
`status` is one line, a `choice` with three options is one row, a `table` wants height.

**`sizes`** is the content, per tier. Declare at least one of `S`, `M`, `L`; leave a tier out
and it is not offered. **Neither dimension may shrink** from S to M to L — a bigger tier that
is narrower would make *bigger* a word with two meanings.

**`scale`** says the page may be resized freely between `min` and `max` rather than only
snapped to its tiers. `max` is optional; without it the page may grow to the board. At a size
between tiers the page shows **the biggest tier that fits**, and the smallest when none does.
Every tier must sit inside `min` and `max`, because a tier that cannot be reached is content
nobody sees.

**`fixed: true`** says the page is one size and cannot be resized. It needs exactly one tier,
and no `scale`. Voice could be `fixed` with only its S — a light that says *listening*, and
nothing to grow into.

Without `scale` and without `fixed`, the page snaps between the tiers you declared, and that
is the right answer for most plugins.

## Choosing what to `show`

`show` lists keys you already declared, in `settings` or in `panel.widgets` — **one
namespace**, the same one [settings.md](./settings.md) describes. They render in the order you
list them, one column, as they do on your plugin's own page.

- **S is one fact.** A `status`, a `progress`, one `toggle`. If a person has to read two
  things to know whether anything needs them, S is too full.
- **M is what they come back to look at**, plus the one thing they change while looking. That
  is what `panel` was already for, which is why the default page is built from it.
- **L is for the thing that needs room** — a `table`, a `graph`. Leave L out rather than
  declare one that is M with more space around it.

A `table` or `graph` on a page asks your `rows` tool when the page is drawn, exactly as it
does in Settings. So a page showing one keeps your process a little busier than a page of
`status` lines. Declare `readOnlyHint` on the tool, as you already had to.

## The default page

**A plugin with a `panel` and no `page` still gets a page**: M, 12 × 10 dots, showing every
widget in `panel.widgets` in order, titled with `panel.label` or, without one, your plugin's
`name`. That is why a plugin written against revision 3 appears on the board with no edit at
all.

So you need `page` only to offer more than one size, to change what is shown, or to be
smaller than 12 × 10. A plugin with neither `panel` nor `page` has no page, and that is fine
— most plugins are tools and have nothing to watch.

## When it appears, and when it goes

| What happened | Your page |
|---|---|
| Installed and enabled | placed at the first free spot, and the person is told where it went |
| Disabled | hidden. Its spot is remembered, so enabling you puts it back where it was |
| Uninstalled, or the folder deleted | gone from the layout, and nothing is left behind in it |
| Crashed, or marked unhealthy | shows the supervisor's state with *Restart*, never a blank box |
| No room on the board | placed below the others, and the board scrolls |

**One page per plugin, and one of it on the board.** A person cannot put two Voice pages up.

**Core never writes your page down by name.** The layout stores an id and a position; the
page itself is rebuilt from your manifest every time. That is what makes *delete the folder,
nothing breaks* true here too.

**A page draws while you are stopped**, like your settings do — except a `table` or `graph`,
which needs you running, and says so rather than showing an empty list.

## What gets refused

Each of these stops your plugin loading, with a sentence naming the field.

| Mistake | What you are told, and what it means |
|---|---|
| `page` while claiming `alexia_protocol` 10 or lower | *page arrived in alexia_protocol 11.* Set `"alexia_protocol": 11`. An Alexia older than that refuses you as *needs a newer Alexia*, which is the truth, rather than as a manifest it cannot parse. |
| a `show` key you never declared | *show "wich_voice" is not a widget this plugin declares.* There is nothing by that name in `settings` or `panel.widgets`. Usually a typo, or a key moved from one list to the other. |
| M smaller than S in either dimension, or L smaller than M | *M (12×3) is smaller than S (8×4).* Bigger has to mean bigger both ways, or the size picker offers a step that goes sideways. |
| a tier outside `scale` | *M (30×8) is outside scale (8×4 to 24×16).* The page could never be stretched to that tier, so its content would never be seen. |
| `scale.max` smaller than `scale.min` | the range is empty. |
| `fixed: true` with more than one tier | *a fixed page has exactly one size.* |
| `fixed: true` with `scale` | *a fixed page does not stretch.* Remove one of them. |
| no tier in `sizes` | *page.sizes needs at least one of S, M or L.* |
| a `title` empty or over 40 characters, an `at` of 0, a fraction, or over 80 | a schema error naming the field. Sizes are whole dots, 1 to 80. |

## What it costs

- **A page makes your process busier only if it shows a `table` or `graph`.** Everything else
  is read from what Alexia already stored.
- **Declaring revision 11 means an Alexia older than 11 will not load you.** If your page is
  nice to have and your plugin works without it, weigh that.
- **You do not choose where the page goes.** The person does. The first free spot is where it
  starts, and that is all.

## Checklist

- [ ] `"alexia_protocol": 11`
- [ ] `title` says what the page is, in 40 characters, not your plugin's name again if that says nothing
- [ ] every `show` key is declared in `settings` or `panel.widgets`
- [ ] S is one fact; L exists only if something needs the room
- [ ] tiers grow in both dimensions, and sit inside `scale` if you declared one
- [ ] `fixed` only with a single tier and no `scale`
- [ ] `npx @alexia/conformance .` is green
- [ ] disable, enable, delete the folder: the page hides, comes back in place, and goes

The full field list is [`../spec/manifest.md#page`](../spec/manifest.md#page).
