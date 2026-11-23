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
//! * Find the Rust hub already running on this PC and point two windows at it, or start
//!   `alexia-hub run` on a free port and point them at it once it answers — and start it again
//!   if it stops on its own (P2D-13, `hub.rs`). Node is never started here: the hub runs plugins.
//! * `main` is the window with a taskbar entry. `overlay` is the frameless one the hotkey
//!   summons: always on top, never in the taskbar, gone when it loses focus.
//! * The tray icon is the only answer to *is it running?* the target user has, so its four
//!   states matter more than usual. The page sets them over IPC.
//! * **Closing a window puts Alexia away; quitting takes the hub with it — only one this shell
//!   started.** A hub from Task Scheduler or a console serves other clients too, and is not ours.
//!
//! What is **not** here, on purpose: no business logic, no model calls, no file handling, no
//! policy in the shell lines core sends. If something needs deciding, it is decided on the
//! other side of the port.

mod glass;
mod hub;
mod snapshot;
mod temps;
// Not opened on the hub path (D-P2D-5): the hub reads its own Credential Manager entries.
#[allow(dead_code)]
mod vault;

use std::net::TcpListener;
use std::process::Command as StdCommand;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::Mutex;
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
use hub::Held;
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

// Core owns the status and the paused flag; these are only the two menu items they describe.
type ComputeMenu = (MenuItem<tauri::Wry>, MenuItem<tauri::Wry>, bool);

fn compute_status(app: &AppHandle, status: &str, paused: bool) {
    tooltip(app, status);
    if let Ok(mut held) = app.state::<Mutex<Option<ComputeMenu>>>().lock() {
        if let Some((line, pause, flag)) = held.as_mut() {
            let _ = line.set_text(status);
            let _ = pause.set_text(if paused { "Resume" } else { "Pause" });
            *flag = paused;
        }
    }
}

/// Only core says setup is done. Destroying bypasses the main window's close-to-tray handler.
fn compute_mode(app: &AppHandle, status: &str) -> tauri::Result<()> {
    let items = [
        ("status", status, false), ("pause", "Pause", true), ("unpair", "Unpair", true),
        ("role", "Switch role", true), ("window", "Open window", true), ("quit", "Quit", true),
    ].map(|(id, text, enabled)| MenuItem::with_id(app, id, text, enabled, None::<&str>))
        .into_iter().collect::<tauri::Result<Vec<_>>>()?;
    let menu = Menu::new(app)?;
    for item in &items { menu.append(item)?; }
    if let Some(icon) = app.state::<Mutex<Option<TrayIcon>>>().lock().ok().and_then(|held| held.clone()) {
        icon.set_menu(Some(menu))?;
    }
    if let Ok(mut held) = app.state::<Mutex<Option<ComputeMenu>>>().lock() {
        *held = Some((items[0].clone(), items[1].clone(), false));
    }
    let _ = app.global_shortcut().unregister_all();
    for label in ["main", "overlay", "control"] {
        if let Some(window) = app.get_webview_window(label) { let _ = window.destroy(); }
    }
    in_dock(app, false);
    compute_status(app, status, false);
    Ok(())
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

/// A port nothing else is using, released immediately so the hub can take it.
///
/// There is a race here and it is the right trade: the alternative is parsing the hub's
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

/// Environment the hub is allowed to see: **a short list of what it needs, and nothing else.**
///
/// The hub reads the person's credentials and runs Node plugins, so whatever can steer it, or
/// the Node it starts, can read every secret it holds. `NODE_OPTIONS=--import` puts somebody else's code inside it; the loader,
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
    // The Program Files folders too: NVIDIA's `nvidia-smi` did not answer core without them.
    const NEEDED: [&str; 28] = [
        "PATH", "HOME", "USER", "LOGNAME", "LANG", "LANGUAGE", "TZ", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR",
        "SYSTEMDRIVE", "COMSPEC", "PATHEXT", "USERPROFILE", "USERNAME", "USERDOMAIN", "APPDATA", "LOCALAPPDATA",
        "PROGRAMDATA", "HOMEDRIVE", "HOMEPATH", "NUMBER_OF_PROCESSORS", "PROGRAMFILES", "PROGRAMW6432",
        "COMMONPROGRAMFILES", "COMMONPROGRAMW6432",
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
    if let Some(window) = app.get_webview_window("main") {
        in_dock(app, true);
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// The hub, started by this shell on `port`. No secret goes in its environment (D-P2D-5): it
/// reads its own credentials. The plugins it runs get the bundled Node, the alexia-core sidecar.
fn hub_command(app: &AppHandle, port: u16) -> Result<Command, Box<dyn std::error::Error>> {
    // Tauri preserves a resource's path relative to this crate, so `scripts/sidecar.mjs`'s
    // folder lands one level in.
    let resources = app.path().resource_dir()?.join("resources");
    let exe = hub::exe(&resources).ok_or(hub::NOT_FOUND)?;
    let node = StdCommand::from(app.shell().sidecar("alexia-core")?).get_program().to_owned();
    let ui = Some(resources.join("ui")).filter(|dir| dir.join("index.html").is_file());
    let ui = ui.or_else(|| std::env::var_os("ALEXIA_UI_DIR").map(Into::into));
    Ok(app
        .shell()
        .command(exe)
        .env_clear()
        .envs(std::env::vars_os().filter(|(name, _)| passes(name)))
        .envs(std::env::var_os("ALEXIA_V3_DATA").map(|data| ("ALEXIA_V3_DATA", data)))
        .envs(ui.map(|ui: std::path::PathBuf| ("ALEXIA_UI_DIR", ui)))
        // An unbundled dev run has no sidecar; the hub then takes `node` from PATH.
        .envs(Some(node).filter(|node| std::path::Path::new(node).is_file()).map(|node| ("ALEXIA_NODE", node)))
        .env("ALEXIA_WINDOW_PORT", port.to_string())
        // Its stdin closing is its stop, so a quit stops its plugins and records a clean stop.
        .env("ALEXIA_HUB_STOP_ON_EOF", "1")
        .args(["run"]))
}

/// Set on the way out, so a hub stopped by quitting is not started again behind it.
static QUITTING: AtomicBool = AtomicBool::new(false);
/// The port of a hub somebody else started that the windows point at; 0 when there is none.
static ATTACHED: AtomicU16 = AtomicU16::new(0);
/// Bumped by every `launch`, so a watch left over from an earlier one stands down.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// The running hub this shell started, taken out of where quitting finds it — only if it is
/// `pid`, when one is named.
fn take_hub(app: &AppHandle, pid: Option<u32>) -> Option<CommandChild> {
    let state = app.state::<Mutex<Option<CommandChild>>>().inner();
    state.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take_if(|hub| pid.is_none_or(|pid| hub.pid() == pid))
}

fn held(app: &AppHandle) -> Held {
    let started = app.state::<Mutex<Option<CommandChild>>>().lock().is_ok_and(|held| held.is_some());
    if started { Held::Started } else if ATTACHED.load(Ordering::SeqCst) != 0 { Held::Attached } else { Held::Nothing }
}

/// Both windows to the hub, the hidden overlay too — and after a restart, this is their reload.
/// **Never the edge.** It is its own page from the app; sent here, it became the whole of
/// Alexia's main screen, over everything, on top, for a whole task.
fn navigate(app: &AppHandle, port: u16) {
    let Ok(url) = Url::parse(&format!("http://127.0.0.1:{port}/")) else { return };
    for (label, window) in app.webview_windows() {
        if label != "control" {
            let _ = window.navigate(url.clone());
        }
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if handle.state::<Mutex<Option<ComputeMenu>>>().lock().is_ok_and(|held| held.is_none()) {
            tooltip(&handle, "Alexia — idle");
        }
    });
}

/// Attach to the hub already running, or start one; on failure the starting page says why.
fn launch(app: &AppHandle, lapse: u32) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let result = match hub::find(app.path().local_data_dir().ok()) {
        Some(port) => {
            attach(app, port, lapse, generation);
            Ok(())
        }
        None => start(app, free_port(), lapse, generation),
    };
    if let Err(error) = result {
        eprintln!("The hub could not be started: {error}");
        tooltip(app, "Alexia — something went wrong");
        say(app, &error.to_string());
    }
}

/// The starting page's words, replaced — tried a few times, since the page may still be loading.
fn say(app: &AppHandle, words: &str) {
    let words = serde_json::to_string(words).unwrap_or_default();
    let script = format!("(() => {{ const late = document.getElementById('late'); if (!late) return; clearTimeout(timer); late.querySelector('p').textContent = {words}; late.hidden = false; document.getElementById('starting').hidden = true }})()");
    let app = app.clone();
    thread::spawn(move || {
        for _ in 0..5 {
            for (label, window) in app.webview_windows() {
                if label != "control" {
                    let _ = window.eval(&script);
                }
            }
            thread::sleep(Duration::from_secs(1));
        }
    });
}

/// Point the windows at a hub somebody else started, and watch its port. When it stops, after
/// the same growing wait, look for a hub again and start one if there is none.
fn attach(app: &AppHandle, port: u16, lapse: u32, generation: u64) {
    ATTACHED.store(port, Ordering::SeqCst);
    navigate(app, port);
    let (app, began) = (app.clone(), Instant::now());
    thread::spawn(move || {
        while hub::answers(port) && current(generation) {
            thread::sleep(Duration::from_secs(2));
        }
        detach(port, generation);
        again(&app, began, lapse, generation);
    });
}

/// The attached port forgotten, by the watch of the `launch` still in charge only: a watch left
/// over from an earlier one would otherwise clear a later attach to a hub on the same port.
fn detach(port: u16, generation: u64) {
    if current(generation) { let _ = ATTACHED.compare_exchange(port, 0, Ordering::SeqCst, Ordering::SeqCst); }
}

#[test]
fn an_earlier_launchs_attach_watch_leaves_a_later_attach_alone() {
    GENERATION.store(7, Ordering::SeqCst); ATTACHED.store(5000, Ordering::SeqCst);
    assert_eq!((detach(5000, 6), ATTACHED.load(Ordering::SeqCst)).1, 5000, "a stale watch must not clear it");
    assert_eq!((detach(5000, 7), ATTACHED.load(Ordering::SeqCst)).1, 0, "the watch in charge clears it");
}

/// Not quitting, and no later `launch` has taken over.
fn current(generation: u64) -> bool {
    !QUITTING.load(Ordering::SeqCst) && GENERATION.load(Ordering::SeqCst) == generation
}

/// A hub that stopped on its own is looked for or started again, after a wait that doubles each
/// time it stops within a minute of starting, up to about a minute: the shape a plugin gets, so a
/// hub that cannot start is not a fast loop. Asked before and after the wait whether to bother.
fn again(app: &AppHandle, began: Instant, lapse: u32, generation: u64) {
    if !current(generation) {
        return;
    }
    tooltip(app, "Alexia — stopped, starting again");
    let lapse = if began.elapsed() > Duration::from_secs(60) { 0 } else { lapse + 1 };
    thread::sleep(Duration::from_secs(1 << lapse.min(6)));
    if current(generation) {
        launch(app, lapse);
    }
}

/// Start the hub on `port`, point the windows at it once it answers, and watch it.
///
/// **The windows go to the hub only once it is listening.** Until then they show the starting
/// page in `placeholder/`. Pointed at a port with nothing behind it yet — a cold start, a login,
/// the first launch after an update — the page failed once and the window stayed white for good.
fn start(app: &AppHandle, port: u16, lapse: u32, generation: u64) -> Result<(), Box<dyn std::error::Error>> {
    let (mut events, child) = hub_command(app, port)?.spawn()?;
    let (pid, began) = (child.pid(), Instant::now());
    ATTACHED.store(0, Ordering::SeqCst);
    // Held, not dropped: dropping closes its stdin, which is the hub's stop.
    *app.state::<Mutex<Option<CommandChild>>>().lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(child);
    let waiting = app.clone();
    thread::spawn(move || {
        let state = waiting.state::<Mutex<Option<CommandChild>>>();
        while state.lock().is_ok_and(|held| held.as_ref().is_some_and(|hub| hub.pid() == pid)) {
            if hub::answers(port) {
                return navigate(&waiting, port);
            }
            thread::sleep(Duration::from_millis(200));
        }
    });
    let app = app.clone();
    thread::spawn(move || {
        // Every event read, not only the last: the shell plugin hands them over one at a time,
        // and one nobody collected would leave the hub stuck writing its next line of output.
        // The hub prints no `@shell` lines (D-P2D-7); the reader stays, and costs nothing.
        while let Some(event) = events.blocking_recv() {
            if let CommandEvent::Stdout(bytes) = &event {
                let line = String::from_utf8_lossy(bytes).trim_end_matches(['\r', '\n']).to_owned();
                if line.starts_with("@shell ") {
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        if let Some(status) = line.strip_prefix("@shell compute ") {
                            let _ = compute_mode(&handle, status);
                        } else if let Some(status) = line.strip_prefix("@shell status 0 ") {
                            compute_status(&handle, status, false);
                        } else if let Some(status) = line.strip_prefix("@shell status 1 ") {
                            compute_status(&handle, status, true);
                        } else if line == "@shell relaunch" { relaunch(handle); }
                    });
                }
            }
            if let CommandEvent::Terminated(_) = event {
                break;
            }
        }
        // Out of its slot, so a quit during the wait does not signal a pid that may by then
        // belong to some other program.
        drop(take_hub(&app, Some(pid)));
        again(&app, began, lapse, generation);
    });
    Ok(())
}

fn main() {
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
        .manage(Mutex::<Option<ComputeMenu>>::new(None))
        // The hub this shell started, held so quitting can stop it — never one it attached to.
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
                    id @ ("pause" | "unpair" | "role" | "window") => {
                        let paused = app.state::<Mutex<Option<ComputeMenu>>>().lock().ok()
                            .and_then(|held| held.as_ref().map(|(_, _, paused)| *paused)).unwrap_or(false);
                        let action = if id == "pause" && paused { "resume" } else { id };
                        if let Ok(mut held) = app.state::<Mutex<Option<CommandChild>>>().lock() {
                            if let Some(hub) = held.as_mut() { let _ = hub.write(format!("tray {action}\n").as_bytes()); }
                        }
                    }
                    _ => {}
                })
                .build(app)?;
            if let Ok(mut held) = handle.state::<Mutex<Option<TrayIcon>>>().lock() {
                *held = Some(icon);
            }

            // The hub, after the windows and the tray it reports to; off the main thread, since
            // looking for one asks a port and the process list. No vault, no handover (D-P2D-5).
            let launching = handle.clone();
            thread::spawn(move || launch(&launching, 0));
            // The starting page's *Try again*: a hub this shell started is killed and its watch
            // brings up another; one it attached to is not ours, so it is looked for again.
            app.listen_any("start-core-again", move |_| {
                if !hub::ours(held(&handle)) {
                    let again = handle.clone();
                    thread::spawn(move || launch(&again, 0));
                } else if let Some(hub) = take_hub(&handle, None) {
                    let _ = hub.kill();
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
        // and every other way the app is asked to end — and it takes the hub with it, if this
        // shell started it. A hard kill of this process closes the hub's stdin all the same.
        .run(|app, event| match event {
            // The last window going is not a request to quit. Compute mode destroys every window
            // and lives in the tray; without this Tauri ends the process with code 0 a second
            // after launch (a Windows PC in the compute role "opened" and vanished). A real quit
            // or restart carries its own exit code, so it is not caught here.
            RunEvent::ExitRequested { api, code: None, .. } => api.prevent_exit(),
            // Quit with a hub of ours up: Alexia goes from the screen now, and the wait for the hub
            // (up to eight seconds) is off the main thread, which asks again once it is stopped —
            // with nothing held then, so the second ask ends the app. A restart cannot be held
            // back, so the stop below in `Exit` is the one it gets.
            RunEvent::ExitRequested { api, code: Some(code), .. } if code != tauri::RESTART_EXIT_CODE && hub::ours(held(app)) => {
                api.prevent_exit();
                QUITTING.store(true, Ordering::SeqCst);
                app.webview_windows().values().for_each(|window| { let _ = window.hide(); });
                if let Some(icon) = app.state::<Mutex<Option<TrayIcon>>>().lock().ok().and_then(|held| held.clone()) { let _ = icon.set_visible(false); }
                let (app, hub) = (app.clone(), take_hub(app, None));
                thread::spawn(move || { hub.into_iter().for_each(hub::stop); app.exit(code) });
            }
            RunEvent::Exit => {
                // First, so the watches know this stop was asked for.
                QUITTING.store(true, Ordering::SeqCst);
                if hub::ours(held(app)) {
                    if let Some(hub) = take_hub(app, None) {
                        hub::stop(hub);
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
