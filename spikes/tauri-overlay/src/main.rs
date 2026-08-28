// SPDX-License-Identifier: AGPL-3.0-only
//! M2-S1 — the overlay, fifty times.
//!
//! Tauri v2 has open reports that `alwaysOnTop` and the blur event stop working after a
//! `hide()`/`show()` round trip. That round trip is the overlay's entire life cycle: press
//! the hotkey, she appears on top of everything; click away, she goes. If it degrades on the
//! twelfth press, the primary local surface degrades with it, and M5 is a terrible place to
//! find that out.
//!
//! Two halves.
//!
//! * `cargo run` — the human one. Tray icon, `Ctrl+Alt+Space`, an always-on-top frameless
//!   window that hides when it loses focus. Press it as many times as you like.
//! * `cargo run -- --cycles 50` — the measured one. Fifty cycles, unattended, then a table
//!   in `results.md` and an exit code that is zero only if every one of the fifty did all
//!   four things below.
//!
//! What is checked each cycle, and why it is checked where it is:
//!
//! | | |
//! |---|---|
//! | visible after `show()` | Tauri's own view of the window |
//! | **`WS_EX_TOPMOST` set** | the OS's view. Tauri's `is_always_on_top()` reports what Tauri asked for, and the bug under test *is* the two disagreeing |
//! | focused after `set_focus()` | a window that never took focus cannot lose it, so a blur test without this proves nothing |
//! | hidden after focus moves away | the blur handler still firing. Nothing in the loop calls `hide()` — if she is gone, the event did it |

use std::fs::write;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread::{sleep, spawn};
use std::time::Duration;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Every blur the overlay has seen. The handler counts as well as hides, because "she went
/// away" and "the event arrived" stop being the same sentence the moment the bug bites.
static BLURS: AtomicUsize = AtomicUsize::new(0);

/// Long enough for the window manager to finish, short enough that fifty cycles is a minute.
const SETTLE: Duration = Duration::from_millis(150);

/// A cycle's own blur can arrive after the check that looks for it. Absorbing it here, rather
/// than letting it fall into the next cycle, is the difference between measuring Tauri and
/// measuring this harness: an unattributed blur hides the overlay a moment after the *next*
/// `show()`, and the row that reports it is not the row that caused it. Found at 200 cycles —
/// one divergence, at cycle 33, with `topmost` still set and exactly one blur counted.
const QUIET: Duration = Duration::from_millis(100);

fn main() {
    let cycles = std::env::args()
        .skip_while(|arg| arg != "--cycles")
        .nth(1)
        .and_then(|n| n.parse::<usize>().ok());

    tauri::Builder::default()
        .setup(move |app| {
            let overlay = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("index.html".into()))
                .title("Alexia overlay spike")
                .inner_size(560.0, 260.0)
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .visible(false)
                .build()?;

            let hiding = overlay.clone();
            overlay.on_window_event(move |event| {
                if let WindowEvent::Focused(false) = event {
                    BLURS.fetch_add(1, Ordering::SeqCst);
                    let _ = hiding.hide();
                }
            });

            tray(app.handle())?;
            hotkey(app.handle())?;

            if let Some(n) = cycles {
                // Built here rather than in the loop: window creation belongs to the main
                // thread, and the loop is not on it.
                WebviewWindowBuilder::new(app, "decoy", WebviewUrl::App("decoy.html".into()))
                    .title("focus decoy")
                    .inner_size(360.0, 160.0)
                    .position(40.0, 40.0)
                    .build()?;

                let handle = app.handle().clone();
                spawn(move || measure(handle, n));
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the spike did not start");
}

/// One cycle's four answers, plus how many blurs it took to get them.
struct Cycle {
    n: usize,
    visible: bool,
    topmost: bool,
    focused: bool,
    hidden: bool,
    blurs: usize,
}

fn measure(app: AppHandle, n: usize) {
    let overlay = app.get_webview_window("overlay").expect("overlay");
    let decoy = app.get_webview_window("decoy").expect("decoy");
    let mut rows = Vec::with_capacity(n);

    for i in 1..=n {
        let before = BLURS.load(Ordering::SeqCst);

        let _ = overlay.show();
        let _ = overlay.set_focus();
        sleep(SETTLE);
        let visible = overlay.is_visible().unwrap_or(false);
        let topmost = topmost(&overlay);
        let focused = overlay.is_focused().unwrap_or(false);

        // Take the focus away and leave the rest to the handler. Nothing here calls `hide()`
        // — that is the point of the cycle.
        let _ = decoy.set_focus();
        sleep(SETTLE);
        let hidden = !overlay.is_visible().unwrap_or(true);

        // Then wait out the stragglers, so the count below belongs to this cycle.
        sleep(QUIET);

        rows.push(Cycle {
            n: i,
            visible,
            topmost,
            focused,
            hidden,
            blurs: BLURS.load(Ordering::SeqCst) - before,
        });
    }

    app.exit(if report(&rows) { 0 } else { 1 });
}

/// Does the OS still consider the window topmost? Asked of the window, not of Tauri.
#[cfg(windows)]
fn topmost(window: &WebviewWindow) -> bool {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, GWL_EXSTYLE, WS_EX_TOPMOST};

    let Ok(handle) = window.hwnd() else { return false };
    let style = unsafe { GetWindowLongPtrW(HWND(handle.0 as _), GWL_EXSTYLE) } as u32;
    style & WS_EX_TOPMOST.0 != 0
}

/// Everywhere else this question has a different answer and this spike is not the one asking
/// it. Reported as `false` rather than skipped, so a run off Windows reads as unmeasured.
#[cfg(not(windows))]
fn topmost(_window: &WebviewWindow) -> bool {
    false
}

/// A cycle that did everything it was supposed to. Fifty *identical* cycles is only half the
/// bar — fifty identical failures are still a failure — so the verdict is this, not sameness.
fn clean(c: &Cycle) -> bool {
    c.visible && c.topmost && c.focused && c.hidden && c.blurs == 1
}

/// The table, and the verdict.
fn report(rows: &[Cycle]) -> bool {
    let good = rows.iter().filter(|c| clean(c)).count();
    let passed = good == rows.len();

    let mut out = format!("# M2-S1 — {} show/hide cycles\n\n", rows.len());
    out.push_str(&format!(
        "Generated by `cargo run -- --cycles {}`. {} of {} cycles did all four things below.\n\n",
        rows.len(),
        good,
        rows.len()
    ));
    out.push_str("| cycle | visible after show | WS_EX_TOPMOST | focused | hidden by blur | blur events |\n");
    out.push_str("|---|---|---|---|---|---|\n");
    let tick = |b: bool| if b { "yes" } else { "**no**" };
    for c in rows {
        out.push_str(&format!(
            "| {} | {} | {} | {} | {} | {} |\n",
            c.n,
            tick(c.visible),
            tick(c.topmost),
            tick(c.focused),
            tick(c.hidden),
            c.blurs
        ));
    }
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/results.md");
    let _ = write(path, out);

    println!("{good} of {} cycles clean. Table written to {path}", rows.len());
    if !passed {
        if let Some(first) = rows.iter().find(|c| !clean(c)) {
            println!(
                "First divergence at cycle {}: visible={} topmost={} focused={} hidden={} blurs={}",
                first.n, first.visible, first.topmost, first.focused, first.hidden, first.blurs
            );
        }
    }
    passed
}

fn tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show overlay", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::new()
        .icon(Image::from_bytes(include_bytes!("../icons/icon.png"))?)
        .tooltip("Alexia overlay spike")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => reveal(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

// Boxed rather than `tauri::Result`: registering a shortcut fails with the plugin's own error
// type, and `tauri::Error` has no `From` for it. The setup closure boxes anyway.
fn hotkey(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let combo = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space);
    let watched = combo;

    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                if shortcut == &watched && event.state() == ShortcutState::Pressed {
                    reveal(app);
                }
            })
            .build(),
    )?;
    app.global_shortcut().register(combo)?;
    Ok(())
}

fn reveal(app: &AppHandle) {
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.show();
        let _ = overlay.set_focus();
    }
}
