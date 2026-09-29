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
//! * Pick a free port, spawn the core sidecar on it, point two windows at it once it answers —
//!   and start it again if it stops on its own.
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

mod glass;
mod snapshot;
mod temps;
mod vault;

use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Listener, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_shell::process::{Command, CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use glass::{glass, haptic};
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
//
// And the edge of the screen while Alexia is driving it: a panel that can never take the
// keyboard, so nothing typed on the person's behalf lands in it instead of the app meant.
#[cfg(target_os = "macos")]
tauri_nspanel::tauri_panel! {
    panel!(OverlayPanel {
        config: {
            can_become_key_window: true,
            is_floating_panel: true
        }
    })

    panel!(ControlPanel {
        config: {
            can_become_key_window: false,
            can_become_main_window: false,
            is_floating_panel: true
        }
    })
}

/// ⌥Esc (Alt+Esc elsewhere): stop what Alexia is doing on the screen. Registered only while the
/// edge is showing, so it never takes the combination from anything else the rest of the time.
const STOP_KEY: (Modifiers, Code) = (Modifiers::ALT, Code::Escape);

/// Show or hide the edge of the screen that says Alexia is using the computer (the page decides
/// when: from the first computer step of a task until the task ends).
///
/// Nothing on it can be pressed and it never takes the keyboard, so it cannot get in the way of
/// the clicks and keys it is announcing. While it shows, ⌥Esc stops the task: the page is told,
/// and it presses its own Stop, which is the one road a task is stopped by.
#[tauri::command]
fn control_overlay(app: AppHandle, show: bool) {
    let stop = Shortcut::new(Some(STOP_KEY.0), STOP_KEY.1);
    if show {
        let _ = app.global_shortcut().register(stop);
    } else {
        let _ = app.global_shortcut().unregister(stop);
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(edge) = handle.get_webview_window("control") else { return };
        if show {
            cover(&edge);
            #[cfg(target_os = "macos")]
            if let Ok(panel) = tauri_nspanel::ManagerExt::get_webview_panel(&handle, "control") {
                panel.order_front_regardless();
                return;
            }
            let _ = edge.show();
        } else {
            let _ = edge.hide();
        }
    });
}

/// The edge over the whole of the main display, wherever the display is and however it is scaled.
fn cover(edge: &tauri::WebviewWindow) {
    if let Ok(Some(screen)) = edge.primary_monitor() {
        let _ = edge.set_position(*screen.position());
        let _ = edge.set_size(*screen.size());
    }
}

/// The tray's four states, as the page reports them.
///
/// Alexia is a tray-resident daemon with thin UI faces, not an app you launch — so the icon
/// is the only answer to *is it running, and does it need me?* that anyone gets at a glance.
/// The tooltip carries the words because an icon alone cannot say "needs you".
#[tauri::command]
fn tray_state(app: AppHandle, state: String) {
    let said = match state.as_str() {
        "working" => "Alexia — working",
        "attention" => "Alexia — needs you",
        "error" => "Alexia — something went wrong",
        _ => "Alexia — idle",
    };
    tooltip(&app, said);
}

/// The tray's words, from the page or from here — the one thing this process says there itself
/// is that core stopped and is being started again.
fn tooltip(app: &AppHandle, said: &str) {
    if let Some(icon) = app.state::<Mutex<Option<TrayIcon>>>().lock().ok().and_then(|held| held.clone()) {
        let _ = icon.set_tooltip(Some(said));
    }
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
    // On the main thread, whoever asked. The panel is AppKit called directly, and WebKit ends a
    // process that touches it from anywhere else — which `--overlay` did, because single-instance
    // hears a second launch on a thread of its own (the crash of 2026-09-25).
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        // Shown and made key *without* activating Alexia, on a Mac — activating is what kept the
        // overlay off a full-screen Space.
        #[cfg(target_os = "macos")]
        if let Ok(panel) = tauri_nspanel::ManagerExt::get_webview_panel(&app, "overlay") {
            panel.show_and_make_key();
            return;
        }
        if let Some(overlay) = app.get_webview_window("overlay") {
            let _ = overlay.show();
            let _ = overlay.set_focus();
        }
    });
}

fn open_main(app: &AppHandle) {
    in_dock(app, true);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Core, as a sidecar. Its stdout is not parsed: the port was decided here, so there is nothing
/// to learn from it that this process does not already know.
fn sidecar(app: &AppHandle, port: u16) -> Result<Command, Box<dyn std::error::Error>> {
    Ok(app
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
        .current_dir(app.path().resource_dir()?.join("resources")))
}

/// Set on the way out, so a core stopped by quitting is not started again behind it.
static QUITTING: AtomicBool = AtomicBool::new(false);

/// The running core, taken out of where quitting finds it — only if it is `pid`, when one is named.
fn take_core(app: &AppHandle, pid: Option<u32>) -> Option<CommandChild> {
    let state = app.state::<Mutex<Option<CommandChild>>>();
    let mut held = state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    held.take_if(|core| pid.is_none_or(|pid| core.pid() == pid))
}

/// Start core on `port`, hand it the vault, point the windows at it once it answers, and watch it.
///
/// **The windows go to core only once it is listening.** Until then they show the starting page
/// in `placeholder/`. Pointed at a port with nothing behind it yet — a cold start, a login, the
/// first launch after an update — the page failed once and the window stayed white for good.
///
/// **A core that stops on its own is started again**, on the same port and with the same vault
/// line, after a wait that doubles each time it stops within a minute of starting, up to about a
/// minute: the shape a plugin gets (`supervisor.ts`), so a core that cannot start is not a fast
/// loop. The same vault rather than a new one, because a second would leave the first's token
/// valid behind it.
fn start(app: &AppHandle, port: u16, handover: Arc<String>, lapse: u32) -> Result<(), Box<dyn std::error::Error>> {
    let (mut events, child) = sidecar(app, port)?.spawn()?;
    let (pid, began) = (child.pid(), Instant::now());
    // Said once the watch below is running, so a core that never got its line is still watched.
    let wrote = {
        // Held first, so a failed write below still leaves it where quitting stops it.
        let state = app.state::<Mutex<Option<CommandChild>>>();
        let mut held = state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        // Where the vault is and the token that opens it, down the one channel only this
        // process and that child share. Written before core has booted; the pipe holds
        // it until `boot.mjs` reads it.
        held.insert(child).write(handover.as_bytes())
    };
    let waiting = app.clone();
    thread::spawn(move || {
        let Ok(url) = Url::parse(&format!("http://127.0.0.1:{port}/")) else { return };
        let state = waiting.state::<Mutex<Option<CommandChild>>>();
        while state.lock().is_ok_and(|held| held.as_ref().is_some_and(|core| core.pid() == pid)) {
            if TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_secs(1)).is_ok() {
                // Both windows, the hidden overlay too — and after a restart, this is their reload.
                // **Never the edge.** It is its own page from the app; sent here, it became the
                // whole of Alexia's main screen, over everything, on top, for a whole task.
                for (label, window) in waiting.webview_windows() {
                    if label != "control" {
                        let _ = window.navigate(url.clone());
                    }
                }
                return tooltip(&waiting, "Alexia — idle");
            }
            thread::sleep(Duration::from_millis(200));
        }
    });
    let app = app.clone();
    thread::spawn(move || {
        // Every event read, not only the last: the shell plugin hands them over one at a time,
        // and one nobody collected would leave core stuck writing its next line of output.
        while let Some(event) = events.blocking_recv() {
            if let CommandEvent::Terminated(_) = event {
                break;
            }
        }
        // Out of its slot, so a quit during the wait below does not signal a pid that may by
        // then belong to some other program.
        drop(take_core(&app, Some(pid)));
        if QUITTING.load(Ordering::SeqCst) {
            return;
        }
        tooltip(&app, "Alexia — stopped, starting again");
        let lapse = if began.elapsed() > Duration::from_secs(60) { 0 } else { lapse + 1 };
        thread::sleep(Duration::from_secs(1 << lapse.min(6)));
        if QUITTING.load(Ordering::SeqCst) {
            return;
        }
        if let Err(error) = start(&app, port, handover, lapse) {
            eprintln!("Core could not be started again: {error}");
            tooltip(&app, "Alexia — something went wrong");
        }
    });
    Ok(wrote?)
}

fn main() {
    let port = free_port();

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
                // On the main thread as well, like `reveal`: a second launch is heard on another.
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || open_main(&handle));
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
        .invoke_handler(tauri::generate_handler![tray_state, hide_overlay, control_overlay, relaunch, system_temps, sheet_snapshot, glass, haptic])
        .setup(move |app| {
            let handle = app.handle().clone();

            // The starting page, until `start` sees core listening and sends both windows there.
            let target = WebviewUrl::App("index.html".into());

            WebviewWindowBuilder::new(app, "main", target.clone())
                .title(DEV.unwrap_or("Alexia"))
                .inner_size(880.0, 720.0)
                .min_inner_size(420.0, 420.0)
                // ⌘+ and ⌘- make the text bigger and smaller, as in any browser. Tauri's own
                // polyfill, allowed by `core:webview:allow-set-webview-zoom` in the capability.
                .zoom_hotkeys_enabled(true)
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

            // The edge of the screen while Alexia drives it (`control_overlay`). Its own page from
            // the app, not core's: it has nothing to ask anyone, and must work before core does.
            let edge = WebviewWindowBuilder::new(app, "control", WebviewUrl::App("control.html".into()))
                .title("Alexia is using your computer")
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .focused(false)
                .resizable(false)
                .visible(false)
                // Left out of screenshots and recordings — Alexia's own included, which would
                // otherwise see a purple frame around everything she looks at.
                .content_protected(true)
                // Its own page and nothing else, whatever asks: anything else would be a real page
                // over the whole screen that cannot be clicked, which is what happened once.
                .on_navigation(|url| url.path().ends_with("/control.html"))
                .build()?;
            let _ = edge.set_ignore_cursor_events(true);
            cover(&edge);
            // On a Mac, a panel above everything that never activates Alexia or takes the keyboard,
            // on every Space and over full-screen apps — the same reasons as the overlay's, plus one
            // more: a key window here would swallow the keystrokes Alexia is typing somewhere else.
            #[cfg(target_os = "macos")]
            {
                use tauri_nspanel::{CollectionBehavior, PanelLevel, StyleMask, WebviewWindowExt};
                let panel = edge.to_panel::<ControlPanel>()?;
                panel.set_level(PanelLevel::Status.value());
                panel.set_style_mask(StyleMask::empty().nonactivating_panel().into());
                panel.set_collection_behavior(CollectionBehavior::new().full_screen_auxiliary().can_join_all_spaces().stationary().ignores_cycle().into());
                panel.set_ignores_mouse_events(true);
                panel.set_has_shadow(false);
                panel.set_opaque(false);
                panel.set_hides_on_deactivate(false);
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

            // Core, after the windows and the tray it reports to. The vault is opened **before**
            // core is started: failing here leaves nothing running, where failing after the spawn
            // left a core that nothing held and nothing would stop.
            start(&handle, port, Arc::new(vault::open()?), 0)?;
            // The starting page's *Try again*: the core that has not answered is stopped, and the
            // watch in `start` brings up another.
            app.listen_any("start-core-again", move |_| {
                if let Some(core) = take_core(&handle, None) {
                    let _ = core.kill();
                }
            });

            let combo = Shortcut::new(Some(HOTKEY.0), HOTKEY.1);
            let stop = Shortcut::new(Some(STOP_KEY.0), STOP_KEY.1);
            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(move |app, shortcut, event| {
                        if shortcut == &combo && event.state() == ShortcutState::Pressed {
                            reveal(app);
                        }
                        if shortcut == &stop && event.state() == ShortcutState::Pressed {
                            // The edge goes first, here, whatever the page does next: the way out
                            // must not depend on the page that put it up still answering.
                            control_overlay(app.clone(), false);
                            let _ = app.emit_to("main", "stop-task", ());
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
                // First, so the watch in `start` knows this stop was asked for.
                QUITTING.store(true, Ordering::SeqCst);
                if let Some(core) = take_core(app, None) {
                    let _ = core.kill();
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
