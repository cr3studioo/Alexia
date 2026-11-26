# Windows (`window-deck`)

Lists the open windows, arranges them, remembers layouts and quits apps (PC-03, PC-04).

| Tool | Capability | What it does |
|---|---|---|
| `window_list` | `window.list` | Windows and monitors, in screen pixels. Read-only. |
| `window_arrange` | `window.arrange` | Move, resize, snap left or right, maximise, minimise, restore, close. |
| `window_layout_save` | `window.layout.save` | Keeps every open window's place under a name. |
| `window_layout_apply` | `window.layout.apply` | Puts a layout back; opens missing apps only with `open_missing`. |
| `app_quit` | `app.quit` | Asks an app to quit; `force` ends it. Destructive. |

- **Close** and **quit** ask politely, so an app can still ask to save. Only `force: true` loses work.
  System processes are never force-quit.
- **Snap** uses half of the monitor's work area, so the taskbar or Dock stays visible.
- **Restore** of a layout matches windows by app and title, then by app alone. A window whose monitor
  is gone comes onto one that is there.
- Layouts are in the plugin's table `layouts` and never leave the computer.

## Limits

- Only windows on the current desktop are seen. An app on another virtual desktop or in the tray
  counts as not running.
- An app running as administrator cannot be moved.
- macOS needs *Accessibility* to see and move windows. It has no maximise, so *maximise* fills the
  screen and *restore* cannot undo it. A window is found again by its title.

## Tests

`node --test plugins/window-deck/test`, or `npx vitest run --project unit plugins/window-deck`. The
runner is faked. `ALEXIA_WINDOW_LIVE=1` adds live tests, which move only a window they open.
