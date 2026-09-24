// SPDX-License-Identifier: AGPL-3.0-only
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The Alexia shell (M5-1, M5-2).
//!
//! **This file is deliberately boring, and staying boring is a test** — invariant 10 counts
//! the lines. Rust is here for four things and no others: the installer, signed updates, the
//! tray icon and the global hotkey — plus one exception with its own file and its own reason,
//! custody of secrets (`vault.rs`, D153). Everything Alexia actually *does* — the
//! conversation, the router, the plugins, the permission model — is in the TypeScript core,
//! behind an HTTP boundary this process starts and then leaves alone.
//!
//! The shape:
//!
//! * Pick a free port, spawn the core sidecar on it, point two windows at it.
//! * `main` is the window with a taskbar entry. `overlay` is the frameless one the hotkey
//!   summons: always on top, never in the taskbar, gone when it loses focus.
//! * The tray icon is the only answer to *is it running?* the target user has, so its four
//!   states matter more than usual. The page sets them over IPC.
//! * **Closing a window puts Alexia away; quitting takes the core with it.** Those are two
//!   different things and the difference is the whole of the tray. The core outliving the
//!   quit is what leaves a second Alexia on the same database next time — see `main`.
//!
//! What is **not** here, on purpose: no business logic, no model calls, no file handling, no
//! parsing of anything the core says. If something needs deciding, it is decided on the
//! other side of the port.

mod snapshot;
mod temps;
mod vault;

use std::net::TcpListener;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;
use snapshot::sheet_snapshot;
use temps::system_temps;

/// The summon. One combination, shown once at first run and then never again.
///
/// Not the same one everywhere (D145): on macOS `Ctrl+Option+Space` is the system's own *next
/// input source*, so for anybody with two keyboards it switched language instead. Option+Space
/// is the combination Mac assistants already answer to. `desktop.ts` says the same thing twice.
#[cfg(not(target_os = "macos"))]
const HOTKEY: (Modifiers, Code) = (Modifiers::CONTROL.union(Modifiers::ALT), Code::Space);
#[cfg(target_os = "macos")]
const HOTKEY: (Modifiers, Code) = (Modifiers::ALT, Code::Space);

// The overlay's AppKit class on a Mac (D145): a panel that can take the keyboard without
// activating Alexia, which is what lets it appear over another app's full-screen Space.
#[cfg(target_os = "macos")]
tauri_nspanel::tauri_panel! {
    panel!(OverlayPanel {
        config: {
            can_become_key_window: true,
            is_floating_panel: true
        }
    })
}

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

/// Come back as the version the updater has just put in place (D152).
///
/// On Windows the installer ends this process and starts the new one itself, so the page never
/// gets here. On a Mac the updater swaps the bundle and returns, and that is all: the bar sat
/// at 100% over an app that had already been replaced. `request_restart` goes out through
/// `RunEvent::Exit` below — the core stopped, the single-instance socket removed — and starts
/// the path this process was launched from, which is where the new bundle now is.
#[tauri::command]
fn relaunch(app: AppHandle) {
    app.request_restart();
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

/// Alexia is in the Dock while its window is up, and a menu-bar item while it is only a daemon.
///
/// Windows gives each window its own taskbar entry and the shell relies on that; macOS has one
/// icon for the app, so the same rule is the activation policy (D145).
///
/// This was taken out once, blamed for Alexia being terminated after its window closed. The
/// cause was a utility on the test Mac that quits any app whose last window closes — the same
/// thing would have happened to every build, which is why removing this did not stop it.
#[cfg(target_os = "macos")]
fn in_dock(app: &AppHandle, shown: bool) {
    use tauri::ActivationPolicy::{Accessory, Regular};
    let _ = app.set_activation_policy(if shown { Regular } else { Accessory });
}
#[cfg(not(target_os = "macos"))]
fn in_dock(_app: &AppHandle, _shown: bool) {}

/// Set only when `pnpm app:dev` compiles *Alexia Dev*: the name it shows, and the folder its core
/// keeps data in, so a change can be tried on this machine without touching the real Alexia.
const DEV: Option<&str> = option_env!("ALEXIA_DEV_NAME");

/// When the overlay was last summoned — the guard D66 asked M5-2 for and M5-2 never built.
///
/// A blur already in flight can land a moment *after* the show meant to open the overlay, and
/// blur-to-hide then shuts it in the same breath. On Windows that took *click away, change your
/// mind, press the hotkey*. On a Mac, while the overlay was an ordinary window, it took nothing:
/// activating the app to focus it sent it a blur of its own, and the hotkey brought Alexia to
/// the front and showed nothing (D145). A blur this soon after a summon is not somebody leaving.
static SUMMONED: Mutex<Option<Instant>> = Mutex::new(None);
const SETTLING: Duration = Duration::from_millis(400);

/// Environment the core is allowed to see: **a short list of what it needs, and nothing else.**
///
/// The core this process starts is handed the vault, so whatever can steer that core can read
/// every secret in it. `NODE_OPTIONS=--import` puts somebody else's code inside it; the loader,
/// OpenSSL and glibc variables (`GCONV_PATH` loads a shared object) do the same one layer down.
/// A list of what to block has to name every such variable on every platform forever, and had
/// already missed some — so this names what may pass instead: where things are, who is running,
/// and the language. None of it is set in a way that steers Node.
///
/// **On Windows the certificate variables pass too.** Its credential store has no per-program
/// access list, so stripping them protects no secret there — and a machine behind a
/// TLS-inspecting proxy whose IT set `NODE_EXTRA_CA_CERTS` could otherwise reach no provider.
///
/// Asked of the raw name, because `std::env::vars()` panics on a variable that is not valid
/// Unicode, and with `panic = "abort"` that is an app that will not open on that machine.
fn passes(name: &std::ffi::OsStr) -> bool {
    let name = name.to_string_lossy().to_ascii_uppercase();
    const NEEDED: [&str; 24] = [
        "PATH", "HOME", "USER", "LOGNAME", "LANG", "LANGUAGE", "TZ", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR",
        "SYSTEMDRIVE", "COMSPEC", "PATHEXT", "USERPROFILE", "USERNAME", "USERDOMAIN", "APPDATA", "LOCALAPPDATA",
        "PROGRAMDATA", "HOMEDRIVE", "HOMEPATH", "NUMBER_OF_PROCESSORS",
    ];
    let trusts = cfg!(windows) && ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"].contains(&name.as_str());
    NEEDED.contains(&name.as_str()) || name.starts_with("LC_") || name.starts_with("XDG_") || trusts
}

fn reveal(app: &AppHandle) {
    if let Ok(mut at) = SUMMONED.lock() {
        *at = Some(Instant::now());
    }
    // Shown and made key *without* activating Alexia, on a Mac — activating is what kept the
    // overlay off a full-screen Space.
    #[cfg(target_os = "macos")]
    if let Ok(panel) = tauri_nspanel::ManagerExt::get_webview_panel(app, "overlay") {
        panel.show_and_make_key();
        return;
    }
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.show();
        let _ = overlay.set_focus();
    }
}

fn open_main(app: &AppHandle) {
    in_dock(app, true);
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

    let builder = tauri::Builder::default();
    // The panel crate's plugin, which the overlay's conversion below needs registered first.
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());
    builder
        // One Alexia. A second launch raises the window that is already running rather than
        // starting a second core on a second port with the same database open twice.
        //
        // `--overlay` summons the overlay instead (D145), so anything that can run a command —
        // a launcher, a Shortcut, a test with no keyboard to press — reaches the hotkey's door.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if argv.iter().any(|arg| arg == "--overlay") {
                reveal(app)
            } else {
                open_main(app)
            }
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Mutex::<Option<TrayIcon>>::new(None))
        // The core, held rather than dropped. `spawn` hands back a handle and dropping it
        // does *not* stop the process — which is how quitting used to leave a core running
        // with the database open, and the next launch made a second one beside it.
        .manage(Mutex::<Option<CommandChild>>::new(None))
        .invoke_handler(tauri::generate_handler![tray_state, hide_overlay, relaunch, system_temps, sheet_snapshot])
        .setup(move |app| {
            let handle = app.handle().clone();

            // Core, as a sidecar. Its stdout is not read and not parsed: the port was
            // decided here, so there is nothing to learn from it that this process does not
            // already know.
            let sidecar = app
                .shell()
                .sidecar("alexia-core")?
                .env_clear()
                .envs(std::env::vars_os().filter(|(name, _)| passes(name)))
                // The sidecar *is* the Node runtime, so it needs something to run. Passing
                // Node nothing opens a REPL and waits forever, which looks exactly like a
                // core that started and never answered.
                //
                // `--disable-sigusr1` because on macOS and Linux that signal opens Node's
                // inspector, and any process running as this user may send it — which would
                // be a debugger attached to the one process holding the vault's token.
                .args(["--disable-sigusr1", "boot.mjs"])
                .env("ALEXIA_PORT", port.to_string())
                .env("ALEXIA_TAURI", "1")
                .env("ALEXIA_DATA_NAME", DEV.unwrap_or("Alexia"))
                // Tauri preserves a resource's path relative to this crate, so the folder
                // `scripts/sidecar.mjs` fills lands one level in. Naming it here is cheaper
                // than a build step that flattens it, and it is one place rather than four
                // path joins inside the core it starts.
                .current_dir(app.path().resource_dir()?.join("resources"));
            // The vault is opened **before** core is started: failing here leaves nothing running,
            // where failing after the spawn left a core that nothing held and nothing would stop.
            let handover = vault::open()?;
            let (_events, child) = sidecar.spawn()?;
            {
                // Held first, so a failed write below still leaves it where quitting stops it.
                let state = handle.state::<Mutex<Option<CommandChild>>>();
                let mut held = state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                // Where the vault is and the token that opens it, down the one channel only this
                // process and that child share. Written before core has booted; the pipe holds
                // it until `boot.mjs` reads it.
                held.insert(child).write(handover.as_bytes())?;
            }

            let target: WebviewUrl = WebviewUrl::External(url.parse()?);

            WebviewWindowBuilder::new(app, "main", target.clone())
                .title(DEV.unwrap_or("Alexia"))
                .inner_size(880.0, 720.0)
                .min_inner_size(420.0, 420.0)
                .build()?;

            // The overlay, exactly as the spike proved it survives: frameless, on top, out
            // of the taskbar, and hidden by its own blur rather than by anything else.
            let overlay = WebviewWindowBuilder::new(app, "overlay", target)
                .title(DEV.unwrap_or("Alexia"))
                .inner_size(640.0, 320.0)
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .visible(false)
                .center()
                .build()?;
            // On a Mac the overlay becomes a panel: non-activating, so showing it neither brings
            // Alexia forward nor switches Space; on every Space; and allowed over a full-screen app.
            // `CanJoinAllSpaces` and `FullScreenAuxiliary` on an ordinary window were tried first and
            // measured not to be enough — the window activates its app, and macOS keeps it off a
            // full-screen Space that is not the app's.
            #[cfg(target_os = "macos")]
            {
                use tauri_nspanel::{CollectionBehavior, PanelLevel, StyleMask, WebviewWindowExt};
                let panel = overlay.to_panel::<OverlayPanel>()?;
                panel.set_level(PanelLevel::Floating.value());
                panel.set_style_mask(StyleMask::empty().nonactivating_panel().into());
                panel.set_collection_behavior(CollectionBehavior::new().full_screen_auxiliary().can_join_all_spaces().into());
            }

            let hiding = overlay.clone();
            overlay.on_window_event(move |event| {
                if let WindowEvent::Focused(false) = event {
                    let settling = SUMMONED.lock().ok().and_then(|at| *at).is_some_and(|at| at.elapsed() < SETTLING);
                    if !settling {
                        let _ = hiding.hide();
                    }
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
                        in_dock(closing.app_handle(), false);
                    }
                });
            }

            let open = MenuItem::with_id(app, "open", "Open Alexia", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let icon = TrayIconBuilder::new()
                .icon(Image::from_bytes(include_bytes!("../icons/icon.png"))?)
                .tooltip("Alexia — idle")
                .menu(&Menu::with_items(app, &[&open, &quit])?)
                // A menu-bar item opens its menu on a click; a Windows tray icon waits for the
                // right button. Each is what that platform's people already do.
                .show_menu_on_left_click(cfg!(target_os = "macos"))
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
                eprintln!("The hotkey is taken by something else: {error}");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Alexia did not start")
        // **Quit means quit.** Closing the main window hides it and the daemon carries on;
        // that is the tray and it is untouched. This is the other exit — the tray's Quit,
        // and every other way the app is asked to end — and it takes the core with it.
        //
        // A hard kill still cannot reach here, which is why `boot.mjs` watches its parent as
        // well. Two halves, because neither covers the other's case: this one is immediate
        // and orderly, that one survives this process being shot.
        .run(|app, event| match event {
            RunEvent::Exit => {
                if let Ok(mut held) = app.state::<Mutex<Option<CommandChild>>>().lock() {
                    if let Some(core) = held.take() {
                        let _ = core.kill();
                    }
                }
            }
            // Double-clicking an Alexia that is already running, or its Dock icon (D145). The
            // second launch never becomes a process on macOS, so single-instance never hears of
            // it — and a window closed to the tray would stay closed.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => open_main(app),
            _ => {}
        });
}
