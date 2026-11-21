// SPDX-License-Identifier: AGPL-3.0-only
//! P2-32: fit, the headroom, `nvidia-smi` parsing, and the game watcher with injected process lists.
//! The `nvidia-smi` samples below were captured on the owner's PC (RTX 4060 Ti, Windows, WDDM).
//! Real clock throughout: alexia-core's tokio has no `test-util`, so the watcher polls every 20 ms.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use alexia_core::gpu::{
    decode_reg, epic_dir, fit, headroom_mb, is_game, parse_compute_csv, parse_machine_csv,
    parse_xml_processes, reg_string, steam_dirs, GpuProc, Machine, Verdict, Watch,
};
use alexia_store::Store;
use serde_json::json;
use tokio_util::sync::CancellationToken;

const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;

const MACHINE_CSV: &str = "NVIDIA GeForce RTX 4060 Ti, 8188, 5976\n";
const COMPUTE_CSV: &str = "1696, [Insufficient Permissions], [N/A]\n\
8632, C:\\Windows\\explorer.exe, [N/A]\n\
2192, C:\\Program Files\\Epic Games\\Fortnite\\FortniteGame\\Binaries\\Win64\\FortniteClient-Win64-Shipping.exe, [N/A]\n\
4242, C:\\llama\\llama-server.exe, 5120\n";
const XML: &str = r"<?xml version='1.0' ?>
<nvidia_smi_log>
	<gpu id='00000000:01:00.0'>
		<processes>
			<process_info>
				<gpu_instance_id>N/A</gpu_instance_id>
				<pid>1484</pid>
				<type>C+G</type>
				<process_name>[Insufficient Permissions]</process_name>
				<used_memory>N/A</used_memory>
			</process_info>
			<process_info>
				<pid>2192</pid>
				<type>C+G</type>
				<process_name>C:\Program Files\Epic Games\Fortnite\FortniteGame\Binaries\Win64\FortniteClient-Win64-Shipping.exe</process_name>
				<used_memory>N/A</used_memory>
			</process_info>
			<process_info>
				<pid>4242</pid>
				<type>C</type>
				<process_name>C:\llama\llama-server.exe</process_name>
				<used_memory>5120 MiB</used_memory>
			</process_info>
		</processes>
	</gpu>
</nvidia_smi_log>
";

fn machine(free_mb: u32) -> Machine {
    Machine {
        vram_mb: free_mb,
        free_mb,
        ram_mb: 32768,
        gpu: None,
    }
}

// qwen3-8b Q4_K_M as in v2's fit.test.ts: 36 layers, 36 * 8 * 128 * 4 KV bytes per token.
const QWEN_BYTES: u64 = 5_027_784_192;
const QWEN_KV: u64 = 36 * 8 * 128 * 4;

fn qwen_need(context: u32) -> u64 {
    let slots = u64::from(context).div_ceil(256) * 256;
    let kv = (slots as f64 * QWEN_KV as f64 * 1.1).ceil() as u64;
    QWEN_BYTES + kv + GIB.max((QWEN_BYTES as f64 * 0.15).ceil() as u64)
}

fn qwen(free_mb: u32) -> Verdict {
    fit(&machine(free_mb), QWEN_BYTES, 36, QWEN_KV, 8192, 0).verdict
}

#[test]
fn fit_matches_v2_cases() {
    // weights + padded FP16 cache + max(1 GiB, 15%) overhead, as v2 counts them.
    let need = qwen_need(8192);
    let f = fit(&machine(8188), QWEN_BYTES, 36, QWEN_KV, 8192, 0);
    assert_eq!((f.verdict, f.gpu_layers), (Verdict::Fits, 36));
    assert_eq!(u64::from(f.vram_mb), need.div_ceil(MIB));
    // Context pads to 256-token slots: 8193 tokens costs as much as 8448.
    assert_eq!(qwen_need(8193), qwen_need(8448));
    assert!(qwen_need(16384) > need);
    // Thresholds: fits with 10% spare, tight when it only just fits, too big below that.
    let mb = u32::try_from(need.div_ceil(MIB)).unwrap();
    assert_eq!(qwen(mb * 10 / 9 + 2), Verdict::Fits);
    assert_eq!(qwen(mb), Verdict::Tight);
    let small = fit(&machine(mb - 1), QWEN_BYTES, 36, QWEN_KV, 8192, 0);
    assert_eq!(small.verdict, Verdict::TooBig);
    assert!(small.gpu_layers < 36);
    // Tiny model: the 1 GiB overhead floor, not 15%.
    let tiny = fit(&machine(4096), 500_000_000, 24, 64 * 1024, 8192, 0);
    assert_eq!(tiny.verdict, Verdict::Fits);
    // Nothing free: nothing offloaded; the card's total caps a free figure that is too large.
    let none = fit(&machine(0), QWEN_BYTES, 36, QWEN_KV, 8192, 0);
    assert_eq!(
        (none.verdict, none.gpu_layers, none.vram_mb),
        (Verdict::TooBig, 0, 0)
    );
    let odd = Machine {
        vram_mb: 1000,
        free_mb: 9000,
        ..machine(0)
    };
    assert_eq!(
        fit(&odd, QWEN_BYTES, 36, QWEN_KV, 8192, 0).verdict,
        Verdict::TooBig
    );
}

#[test]
fn headroom_reduces_layers() {
    // A 12 GB model on a card with 8188 MB free is too big either way; headroom takes layers.
    let m = machine(8188);
    let none = fit(&m, 12 * GIB, 48, 100_000, 4096, 0);
    let default = fit(&m, 12 * GIB, 48, 100_000, 4096, 1536);
    let big = fit(&m, 12 * GIB, 48, 100_000, 4096, 3072);
    assert_eq!(none.verdict, Verdict::TooBig);
    assert!(none.gpu_layers > default.gpu_layers && default.gpu_layers > big.gpu_layers);
    assert!(default.gpu_layers > 0);
    // A model that fits with no headroom no longer fully fits once the owner reserves more.
    assert_eq!(fit(&m, 6 * GIB, 32, 50_000, 4096, 0).gpu_layers, 32);
    assert!(fit(&m, 6 * GIB, 32, 50_000, 4096, 4096).gpu_layers < 32);
    // The vram claim never exceeds the budget.
    assert!(u64::from(default.vram_mb) <= 8188 - 1536);
    // The setting: default 1536, the owner's value when set.
    let store = Store::open_in_memory().unwrap();
    assert_eq!(headroom_mb(&store), 1536);
    store
        .set_setting("_core", "gpu.headroom_mb", &json!(2048))
        .unwrap();
    assert_eq!(headroom_mb(&store), 2048);
}

#[test]
fn parse_nvidia_smi_csv() {
    assert_eq!(
        parse_machine_csv(MACHINE_CSV),
        Some(("NVIDIA GeForce RTX 4060 Ti".to_string(), 8188, 5976))
    );
    assert_eq!(parse_machine_csv(""), None);
    assert_eq!(parse_machine_csv("No devices were found"), None);
    let procs = parse_compute_csv(COMPUTE_CSV);
    assert_eq!(procs.len(), 4);
    assert_eq!(
        procs[0],
        GpuProc {
            pid: 1696,
            exe: PathBuf::new(),
            graphics: false,
            mb: 0
        }
    );
    assert_eq!(procs[1].exe, PathBuf::from("C:\\Windows\\explorer.exe"));
    assert_eq!((procs[3].pid, procs[3].mb), (4242, 5120));
}

#[test]
fn parse_xml_graphics_processes() {
    let procs = parse_xml_processes(XML);
    assert_eq!(procs.len(), 3);
    assert_eq!(procs[0].exe, PathBuf::new());
    assert!(procs[0].graphics);
    assert_eq!(procs[1].pid, 2192);
    assert!(procs[1].graphics);
    assert!(procs[1].exe.ends_with("FortniteClient-Win64-Shipping.exe"));
    // Compute-only (`C`) is not graphics; its memory is read when the driver gives it.
    assert!(!procs[2].graphics);
    assert_eq!(procs[2].mb, 5120);
    let empty = "<nvidia_smi_log><gpu><processes></processes></gpu></nvidia_smi_log>";
    assert!(parse_xml_processes(empty).is_empty());
}

fn proc(pid: u32, exe: &str, graphics: bool) -> GpuProc {
    GpuProc {
        pid,
        exe: PathBuf::from(exe),
        graphics,
        mb: 0,
    }
}

#[test]
fn game_in_library_is_game() {
    let dirs = vec![
        PathBuf::from("D:\\SteamLibrary\\steamapps\\common"),
        PathBuf::from("C:\\Games"),
    ];
    let game = proc(
        10,
        "d:\\steamlibrary\\steamapps\\common\\Hades\\Hades.exe",
        true,
    );
    assert!(is_game(&game, &dirs, &[]));
    assert!(is_game(&proc(11, "C:/Games/x/y.exe", true), &dirs, &[]));
    // Not graphics, not in a library, a sibling folder with the same prefix, unknown exe: no.
    assert!(!is_game(
        &proc(12, "C:\\Games\\x\\y.exe", false),
        &dirs,
        &[]
    ));
    assert!(!is_game(
        &proc(13, "C:\\Windows\\explorer.exe", true),
        &dirs,
        &[]
    ));
    assert!(!is_game(
        &proc(14, "C:\\GamesAndMore\\z.exe", true),
        &dirs,
        &[]
    ));
    assert!(!is_game(&proc(15, "", true), &dirs, &[]));
    assert!(!is_game(&game, &[], &[]));
    // Library discovery: Steam's vdf and Epic's manifest.
    let vdf =
        "\"libraryfolders\"\n{\n\t\"0\"\n\t{\n\t\t\"path\"\t\t\"D:\\\\SteamLibrary\"\n\t}\n}\n";
    let s = steam_dirs(std::path::Path::new("C:\\Steam"), vdf);
    assert_eq!(s[0], PathBuf::from("C:\\Steam\\steamapps\\common"));
    assert_eq!(s[1], PathBuf::from("D:\\SteamLibrary\\steamapps\\common"));
    assert_eq!(
        epic_dir("{\"InstallLocation\":\"C:\\\\Program Files\\\\Epic Games\\\\Fortnite\"}"),
        Some(PathBuf::from("C:\\Program Files\\Epic Games\\Fortnite"))
    );
    assert_eq!(epic_dir("not json"), None);
}

#[test]
fn our_pid_is_not_a_game() {
    let dirs = vec![PathBuf::from("C:\\Games")];
    let p = proc(77, "C:\\Games\\x\\server.exe", true);
    assert!(is_game(&p, &dirs, &[1, 2]));
    assert!(!is_game(&p, &dirs, &[1, 77]));
}

async fn until(what: &str, cond: impl Fn() -> bool) {
    let start = Instant::now();
    while !cond() {
        assert!(
            start.elapsed() < Duration::from_secs(30),
            "timed out waiting for {what}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn watch_steps_aside_once_and_returns() {
    let store = Arc::new(Store::open_in_memory().unwrap());
    store
        .set_setting("_core", "gpu.games", &json!(["C:\\Games"]))
        .unwrap();
    let list = Arc::new(Mutex::new(vec![proc(1, "C:\\Windows\\explorer.exe", true)]));
    let polls = Arc::new(AtomicU32::new(0));
    let source = {
        let (list, polls) = (list.clone(), polls.clone());
        Arc::new(move || {
            polls.fetch_add(1, Ordering::SeqCst);
            let now = list.lock().unwrap().clone();
            Box::pin(async move { now }) as Pin<Box<dyn Future<Output = Vec<GpuProc>> + Send>>
        })
    };
    // pid 99 is a game-folder process Alexia started itself: it must never trigger a step-aside.
    let ours: Arc<dyn Fn() -> Vec<u32> + Send + Sync> = Arc::new(|| vec![99]);
    let watch = Watch::new(store, ours).with_source(source, Duration::from_millis(20));
    let (aside, over) = (Arc::new(AtomicU32::new(0)), Arc::new(AtomicU32::new(0)));
    let cancel = CancellationToken::new();
    let task = tokio::spawn({
        let (a, o, c) = (aside.clone(), over.clone(), cancel.clone());
        async move {
            watch
                .run(
                    c,
                    move || {
                        a.fetch_add(1, Ordering::SeqCst);
                    },
                    move || {
                        o.fetch_add(1, Ordering::SeqCst);
                    },
                )
                .await;
        }
    });
    let counts = || (aside.load(Ordering::SeqCst), over.load(Ordering::SeqCst));
    let polled = |n: u32| polls.load(Ordering::SeqCst) >= n;
    // No game yet; our own process in the library does not count.
    list.lock()
        .unwrap()
        .push(proc(99, "C:\\Games\\ours\\llama.exe", true));
    until("polls", || polled(3)).await;
    assert_eq!(counts(), (0, 0));
    // A game starts and keeps running over many polls: one step-aside only.
    list.lock()
        .unwrap()
        .push(proc(5, "C:\\Games\\Hades\\Hades.exe", true));
    until("step aside", || aside.load(Ordering::SeqCst) == 1).await;
    let at = polls.load(Ordering::SeqCst);
    until("more polls", || polled(at + 5)).await;
    assert_eq!(counts(), (1, 0));
    // The game ends: game_over once, no second step-aside.
    list.lock().unwrap().retain(|p| p.pid != 5);
    until("game over", || over.load(Ordering::SeqCst) == 1).await;
    let at = polls.load(Ordering::SeqCst);
    until("more polls", || polled(at + 5)).await;
    assert_eq!(counts(), (1, 1));
    // A second game steps aside again; cancelling ends the task.
    list.lock()
        .unwrap()
        .push(proc(6, "C:\\Games\\Other\\o.exe", true));
    until("second step aside", || aside.load(Ordering::SeqCst) == 2).await;
    cancel.cancel();
    tokio::time::timeout(Duration::from_secs(30), task)
        .await
        .unwrap()
        .unwrap();
}

#[test]
fn compute_csv_comma_in_path() {
    let got = parse_compute_csv("77, C:\\Games\\Foo, Bar\\game.exe, 2048\n");
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].pid, 77);
    assert_eq!(got[0].exe, PathBuf::from("C:\\Games\\Foo, Bar\\game.exe"));
    assert_eq!(got[0].mb, 2048);
}

#[test]
fn xml_entities_decoded() {
    let xml = "<process_info><pid>9</pid><type>C+G</type>\
<process_name>C:\\Games\\A&amp;B\\g&#97;me&#x2e;exe &lt;&quot;x&quot;&apos;&gt; &bogus;</process_name>\
<used_memory>N/A</used_memory></process_info>";
    let got = parse_xml_processes(xml);
    assert_eq!(
        got[0].exe,
        PathBuf::from("C:\\Games\\A&B\\game.exe <\"x\"'> &bogus;")
    );
    assert!(is_game(&got[0], &[PathBuf::from("C:\\Games\\A&B")], &[]));
}

#[test]
fn reg_export_utf16_parsed() {
    let reg = "Windows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Software\\Valve\\Steam]\r\n\
\"SteamExe\"=\"c:\\\\steam\\\\steam.exe\"\r\n\"SteamPath\"=\"D:\\\\Hry\\\\Čeština\"\r\n";
    let mut bytes = vec![0xff, 0xfe];
    bytes.extend(reg.encode_utf16().flat_map(u16::to_le_bytes));
    let text = decode_reg(&bytes);
    assert_eq!(
        reg_string(&text, "SteamPath").as_deref(),
        Some("D:\\Hry\\Čeština")
    );
    assert_eq!(reg_string(&text, "Missing"), None);
}

/// A watcher over a scripted game/no-game list (the last entry repeats). Returns the over-count
/// seen at the start of each poll, then the step-aside and game-over counts, once `polls` ran.
async fn run_script(script: &[bool], polls: u32) -> (Vec<u32>, u32, u32) {
    let store = Arc::new(Store::open_in_memory().unwrap());
    store
        .set_setting("_core", "gpu.games", &json!(["C:\\Games"]))
        .unwrap();
    let (aside, over) = (Arc::new(AtomicU32::new(0)), Arc::new(AtomicU32::new(0)));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let script = script.to_vec();
    let source = {
        let (seen, over) = (seen.clone(), over.clone());
        Arc::new(move || {
            let mut seen = seen.lock().unwrap();
            let n = seen.len();
            seen.push(over.load(Ordering::SeqCst));
            let game = script[n.min(script.len() - 1)];
            let list = if game {
                vec![proc(5, "C:\\Games\\Hades\\Hades.exe", true)]
            } else {
                Vec::new()
            };
            Box::pin(async move { list }) as Pin<Box<dyn Future<Output = Vec<GpuProc>> + Send>>
        })
    };
    let ours: Arc<dyn Fn() -> Vec<u32> + Send + Sync> = Arc::new(Vec::new);
    let watch = Watch::new(store, ours).with_source(source, Duration::from_millis(20));
    let cancel = CancellationToken::new();
    let task = tokio::spawn({
        let (a, o, c) = (aside.clone(), over.clone(), cancel.clone());
        async move {
            watch
                .run(
                    c,
                    move || {
                        a.fetch_add(1, Ordering::SeqCst);
                    },
                    move || {
                        o.fetch_add(1, Ordering::SeqCst);
                    },
                )
                .await;
        }
    });
    until("polls", || seen.lock().unwrap().len() as u32 >= polls).await;
    let counts = (aside.load(Ordering::SeqCst), over.load(Ordering::SeqCst));
    cancel.cancel();
    tokio::time::timeout(Duration::from_secs(30), task)
        .await
        .unwrap()
        .unwrap();
    let seen = seen.lock().unwrap().clone();
    (seen, counts.0, counts.1)
}

#[tokio::test]
async fn game_over_needs_three_quiet_polls() {
    // poll 0: game; polls 1-3: quiet. The over-count seen at the start of poll n is what the
    // polls before it produced.
    let (seen, aside, _) = run_script(&[true, false], 6).await;
    assert_eq!(&seen[..5], [0, 0, 0, 0, 1], "{seen:?}");
    assert_eq!(aside, 1);
}

#[tokio::test]
async fn one_missed_poll_does_not_flap() {
    // one miss, then two misses in a row, with the game back each time; then it stays
    let (seen, aside, over) = run_script(&[true, false, true, false, false, true], 10).await;
    assert_eq!((aside, over), (1, 0), "{seen:?}");
}
