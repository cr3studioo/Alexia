<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# M2-S1 — Tauri tray, hotkey and overlay on Windows

A question, not a component. `plan.md` puts it first in M2 and gives it a day, because the
answer decides how M5-2 is built and M5 is a terrible place to find out.

## The question

Tauri v2 has open reports that `alwaysOnTop` and the blur event stop working after a
`hide()`/`show()` round trip. That round trip is the overlay's entire life cycle — press the
hotkey and she is on top of everything, click away and she is gone — so a bug that appears on
the twelfth press takes the primary local surface with it.

`tauri-plugin-spotlight` is the usual reading on this. It is macOS-only, so Windows is ours.

## Running it

```bash
cargo run                    # the human half: tray icon, Ctrl+Alt+Space, click away to hide
cargo run -- --cycles 200    # the measured half: cycles, then results.md, then exit
powershell -File check-hotkey.ps1   # the human half, without the human
```

The measured run exits `0` only if every one of the cycles did all four things below —
sameness alone is not the bar, because fifty identical failures are still a failure.
`results.md` is the evidence either way, and it is committed.

`check-hotkey.ps1` drives the other half from outside the process: it launches the spike,
presses `Ctrl+Alt+Space` with `keybd_event` — the level a `RegisterHotKey` shortcut actually
listens at, which `SendKeys` is not — and then asks Win32 what happened. It also reads the
registrations rather than trusting them: the tray and the shortcut each own a message-only
window, `tray_icon_app` and `global_hotkey_app`, and their presence *is* the registration.

## What each cycle checks

| | |
|---|---|
| visible after `show()` | Tauri's own view of the window |
| **`WS_EX_TOPMOST` is set** | the OS's view, read off the `HWND`. Tauri's `is_always_on_top()` reports what Tauri *asked for*, and the bug under test is precisely the two disagreeing |
| focused after `set_focus()` | a window that never took focus cannot lose it, so a blur test without this proves nothing |
| hidden once focus moves | the blur handler still firing. Nothing in the loop calls `hide()` — if she is gone, the event did it |

The decoy window exists for the fourth row. Focus has to go *somewhere*, and it has to be
somewhere this process can steer.

## Where this lives, and why not in `src-tauri/`

`src-tauri/` is M5's, and invariant 10 holds hand-written Rust there under 300 lines. This is
a spike: it is allowed to be longer than the thing it de-risks, it is not shipped, and M5-1
writes the real shell using whatever comes out of it rather than by moving this file. What
crosses over is the finding — recorded in `plan.md` under M2-S1 — and, if there is one, the
workaround.

## Toolchain

Rust plus the MSVC C++ build tools; WebView2 ships with Windows 11. No pnpm involvement —
this crate is deliberately outside the workspace.
