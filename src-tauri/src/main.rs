// SPDX-License-Identifier: AGPL-3.0-only
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The Alexia shell (M5-1, M5-2).
//!
//! **This file is deliberately boring, and staying boring is a test** — invariant 10 counts
//! the lines. Rust is here for four things and no others: the installer, signed updates, the
//! tray icon and the global hotkey. Everything Alexia actually *does* — the conversation,
//! the router, the plugins, the permission model — is in the TypeScript core, behind an HTTP
//! boundary this process starts and then leaves alone.
//!
//! The shape:
//!
//! * Pick a free port, spawn the core sidecar on it, point two windows at it.
//! * `main` is the window with a taskbar entry. `overlay` is the frameless one the hotkey
//!   summons: always on top, never in the taskbar, gone when it loses focus.
//! * The tray icon is the only answer to *is it running?* the target user has, so its four
//!   states matter more than usual. The page sets them over IPC.
//!
//! What is **not** here, on purpose: no business logic, no model calls, no file handling, no
//! parsing of anything the core says. If something needs deciding, it is decided on the
//! other side of the port.

use std::net::TcpListener;
use std::sync::Mutex;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_shell::ShellExt;

/// The summon. One combination, shown once at first run and then never again.
const HOTKEY: (Modifiers, Code) = (Modifiers::CONTROL.union(Modifiers::ALT), Code::Space);

/// The tray's four states, as the page reports them.
///
/// Alexia is a tray-resident daemon with thin UI faces, not an app you launch — so the icon
/// is the only answer to *is it running, and does it need me?* that anyone gets at a glance.
/// The tooltip carries the words because an icon alone cannot say "needs you".
#[tauri::command]
fn tray_state(app: AppHandle, tray: State<'_, Mutex<Option<TrayIcon>>>, state: String) {
    let said = match state.as_str() {
        "working" => "Alexia — working",
        "attention" => "Alexia — needs you",
        "error" => "Alexia — something went wrong",
        _ => "Alexia — idle",
    };
    if let Ok(held) = tray.lock() {
        if let Some(icon) = held.as_ref() {
            let _ = icon.set_tooltip(Some(said));
        }
    }
    let _ = app;
}

/// Dismiss the overlay from the page, which is where Escape is pressed.
///
/// Dismissing never cancels a running task: this hides a window and touches nothing else.
/// The task carries on and the tray says so.
#[tauri::command]
fn hide_overlay(app: AppHandle) {
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.hide();
    }
}

/// A port nothing else is using, released immediately so the core can take it.
///
/// There is a race here and it is the right trade: the alternative is parsing the sidecar's
/// stdout for a port it chose, which means the windows cannot be built until it has started,
/// which means a blank window for as long as Node takes to boot.
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .unwrap_or(43117)
}

fn reveal(app: &AppHandle) {
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.show();
        let _ = overlay.set_focus();
    }
}

fn open_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn main() {
    let port = free_port();
    // Decided here, so the windows can be built without waiting for the sidecar to boot.
    let url = format!("http://127.0.0.1:{port}/");

    tauri::Builder::default()
        // One Alexia. A second launch raises the window that is already running rather than
        // starting a second core on a second port with the same database open twice.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| open_main(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Mutex::<Option<TrayIcon>>::new(None))
        .invoke_handler(tauri::generate_handler![tray_state, hide_overlay])
        .setup(move |app| {
            let handle = app.handle().clone();

            // Core, as a sidecar. Its stdout is not read and not parsed: the port was
            // decided here, so there is nothing to learn from it that this process does not
            // already know.
            let sidecar = app
                .shell()
                .sidecar("alexia-core")?
                // The sidecar *is* the Node runtime, so it needs something to run. Passing
                // Node nothing opens a REPL and waits forever, which looks exactly like a
                // core that started and never answered.
                .args(["boot.mjs"])
                .env("ALEXIA_PORT", port.to_string())
                .env("ALEXIA_TAURI", "1")
                // Tauri preserves a resource's path relative to this crate, so the folder
                // `scripts/sidecar.mjs` fills lands one level in. Naming it here is cheaper
                // than a build step that flattens it, and it is one place rather than four
                // path joins inside the core it starts.
                .current_dir(app.path().resource_dir()?.join("resources"));
            sidecar.spawn()?;

            let target: WebviewUrl = WebviewUrl::External(url.parse()?);

            WebviewWindowBuilder::new(app, "main", target.clone())
                .title("Alexia")
                .inner_size(880.0, 720.0)
                .min_inner_size(420.0, 420.0)
                .build()?;

            // The overlay, exactly as the spike proved it survives: frameless, on top, out
            // of the taskbar, and hidden by its own blur rather than by anything else.
            let overlay = WebviewWindowBuilder::new(app, "overlay", target)
                .title("Alexia")
                .inner_size(640.0, 320.0)
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .visible(false)
                .center()
                .build()?;

            let hiding = overlay.clone();
            overlay.on_window_event(move |event| {
                if let WindowEvent::Focused(false) = event {
                    let _ = hiding.hide();
                }
            });

            // The main window closes to the tray rather than quitting. Alexia is a daemon;
            // closing its window is putting it away, not switching it off.
            if let Some(window) = app.get_webview_window("main") {
                let closing = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = closing.hide();
                    }
                });
            }

            let open = MenuItem::with_id(app, "open", "Open Alexia", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let icon = TrayIconBuilder::new()
                .icon(Image::from_bytes(include_bytes!("../icons/icon.png"))?)
                .tooltip("Alexia — idle")
                .menu(&Menu::with_items(app, &[&open, &quit])?)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => open_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            if let Ok(mut held) = handle.state::<Mutex<Option<TrayIcon>>>().lock() {
                *held = Some(icon);
            }

            let combo = Shortcut::new(Some(HOTKEY.0), HOTKEY.1);
            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(move |app, shortcut, event| {
                        if shortcut == &combo && event.state() == ShortcutState::Pressed {
                            reveal(app);
                        }
                    })
                    .build(),
            )?;
            // A hotkey another program already owns is a degraded install, not a reason to
            // refuse to start. It is logged and the tray still works.
            if let Err(error) = app.global_shortcut().register(combo) {
                eprintln!("Ctrl+Alt+Space is taken by something else: {error}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Alexia did not start");
}
