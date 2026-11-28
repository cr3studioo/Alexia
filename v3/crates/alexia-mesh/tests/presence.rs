// SPDX-License-Identifier: AGPL-3.0-only
use alexia_mesh::presence::{here, idle_now, Here, Said, Seen, WINDOW_MS};
use alexia_mesh::DeviceId;

fn seen(id: &str, idle_ms: u64, locked: bool, at: i64) -> Seen {
    Seen {
        device: DeviceId(id.into()),
        idle_ms,
        locked,
        at,
    }
}
fn dev(id: &str) -> Option<Here> {
    Some(Here::Device(DeviceId(id.into())))
}
fn said() -> Said {
    Said {
        channel: "telegram".into(),
        chat: "42".into(),
        at: 1,
    }
}
fn chan() -> Option<Here> {
    Some(Here::Channel {
        channel: "telegram".into(),
        chat: "42".into(),
    })
}

#[test]
fn most_recent_device_wins() {
    let d = [
        seen("hub", 60_000, false, 1000),
        seen("laptop", 2_000, false, 1000),
    ];
    assert_eq!(here(&d, None, 1000, WINDOW_MS), dev("laptop"));
    // An old report ages: the laptop's 2 s idle is 100 s old, the hub's fresher 60 s report wins.
    let d = [
        seen("hub", 60_000, false, 100_000),
        seen("laptop", 2_000, false, 0),
    ];
    assert_eq!(here(&d, None, 100_000, WINDOW_MS), dev("hub"));
}

#[test]
fn locked_is_absent() {
    let d = [seen("hub", 0, true, 0), seen("laptop", 100_000, false, 0)];
    assert_eq!(here(&d, None, 0, WINDOW_MS), dev("laptop"));
    let d = [seen("hub", 0, true, 0)];
    assert_eq!(here(&d, Some(&said()), 0, WINDOW_MS), chan());
}

#[test]
fn outside_window_falls_to_channel() {
    let d = [seen("hub", WINDOW_MS + 1, false, 0)];
    assert_eq!(here(&d, Some(&said()), 0, WINDOW_MS), chan());
    assert_eq!(here(&d, None, 0, WINDOW_MS), None);
}

#[test]
fn tie_goes_to_hub() {
    // The hub is the device the caller passes first.
    let d = [
        seen("hub", 5_000, false, 0),
        seen("laptop", 5_000, false, 0),
    ];
    assert_eq!(here(&d, None, 0, WINDOW_MS), dev("hub"));
}

#[test]
fn nothing_is_none() {
    assert_eq!(here(&[], None, 0, WINDOW_MS), None);
}

#[tokio::test]
async fn idle_now_reads_on_this_os() {
    let r = idle_now().await;
    if cfg!(any(windows, target_os = "macos")) {
        assert!(r.expect("idle should be readable").idle_ms < 24 * 3_600_000);
    } else {
        assert!(r.is_none());
    }
}
