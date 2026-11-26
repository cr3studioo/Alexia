# Look at my screen

"What does this error mean", "how do I turn this off here", "copy the text in that picture".

| Tool | Capability | What it does |
|---|---|---|
| `look` | `screen.look` | A description of the screen, the text read from it, and the window in front. |
| `help` | `screen.help` | Looks, asks a model once, and answers with steps that name controls by their labels. With `draw`, boxes the control for the first step. |
| `text` | `screen.text` | The text on the screen, or in one `region` of it. No model. |

It asks only for capabilities: `computer.screenshot`, `image.ocr`, `vision.describe` and
`screen.draw`. With no vision model it works from the text alone, and says so.

## Privacy

- It looks only when asked.
- It refuses a locked screen, a password manager, a sign-in window, a private browser window,
  and a window nobody could name. Nothing is read in those cases.
- The screenshot's file is deleted as soon as it is read into memory. Nothing here writes one.
- Nothing read off the screen is logged.
- `help` sends the description and the text to the model Alexia uses, under your own model rules.

## Limits

- The screenshot is of the whole screen: it does not say where the window in front is, so `look`
  and `help` read everything visible and name the front window. `whole_screen` changes only the
  wording.
- Only the window in front is judged private. A private window beside it is in the picture.
- The text reader gives no positions, so the box is found by reading ever smaller pieces of the
  picture. It takes some seconds, is drawn only when the label can be narrowed down, and goes on
  the first piece that holds the label when it is written twice.
