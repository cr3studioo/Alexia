// SPDX-License-Identifier: AGPL-3.0-only
//! Step 12 on the real binary: `window.json`, the one-hub lock, loopback only (P2D-01).

mod common;

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream, UdpSocket};
use std::path::Path;
use std::time::{Duration, Instant};

use common::{command, scratch, Hub};
use serde_json::Value;

fn window_json(root: &Path) -> Value {
    let text = std::fs::read_to_string(root.join("data").join("window.json"))
        .expect("window.json is written once the hub is up");
    serde_json::from_str(&text).expect("window.json is JSON")
}

fn port_of(root: &Path) -> u16 {
    let v = window_json(root);
    u16::try_from(v["port"].as_u64().expect("a port")).unwrap()
}

/// `GET /` on `addr`, the whole answer as text.
fn get_root(addr: SocketAddr) -> std::io::Result<String> {
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(10))?;
    s.set_read_timeout(Some(Duration::from_secs(30)))?;
    write!(
        s,
        "GET / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
        addr.port()
    )?;
    let mut out = String::new();
    s.read_to_string(&mut out)?;
    Ok(out)
}

fn hub(root: &Path) -> Hub {
    let mut c = command(root);
    c.env_remove("ALEXIA_UI_DIR")
        .env_remove("ALEXIA_WINDOW_PORT");
    Hub::run(c)
}

#[tokio::test]
async fn window_json_written_and_removed() {
    let root = scratch("window-json");
    let mut h = hub(&root);
    h.up().await;
    let v = window_json(&root);
    let keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys.len(), 2, "only the port and the pid: {v}");
    assert_eq!(v["pid"].as_u64(), Some(u64::from(h.child.id())));
    let port = port_of(&root);
    assert_ne!(port, 0);
    assert!(!root.join("data").join("window.json.tmp").exists());

    // The port answers: no UI folder was given, so `/` says so.
    let page = get_root(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).unwrap();
    assert!(page.starts_with("HTTP/1.1 503"), "{page}");
    assert!(page.contains("Set ALEXIA_UI_DIR."), "{page}");

    assert_eq!(h.stop().await, Some(0), "{}", h.log());
    assert!(
        !root.join("data").join("window.json").exists(),
        "window.json is removed on shutdown"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(windows)]
#[tokio::test]
async fn second_hub_refused() {
    let root = scratch("second-hub");
    let mut first = hub(&root);
    first.up().await;
    let port = port_of(&root);

    let mut second = hub(&root);
    let end = Instant::now() + Duration::from_secs(60);
    let code = loop {
        if let Ok(Some(status)) = second.child.try_wait() {
            break status.code();
        }
        assert!(
            Instant::now() < end,
            "the second hub kept running\n{}",
            second.log()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    // Its readers may still hold the last line.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(code, Some(1), "{}", second.log());
    assert!(
        second
            .log()
            .contains("Another Alexia hub is already running on this computer."),
        "{}",
        second.log()
    );
    // The first hub is untouched: its window.json and its port.
    assert_eq!(port_of(&root), port);
    assert!(get_root(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).is_ok());

    assert_eq!(first.stop().await, Some(0), "{}", first.log());
    let _ = std::fs::remove_dir_all(&root);
}

/// This machine's address on its network: the source a UDP socket would use toward a
/// TEST-NET address. Connecting a UDP socket sends nothing.
fn non_loopback() -> IpAddr {
    let s = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).unwrap();
    s.connect((Ipv4Addr::new(192, 0, 2, 1), 9))
        .expect("this machine has a network route (needed to test loopback-only binding)");
    let ip = s.local_addr().unwrap().ip();
    assert!(
        !ip.is_loopback() && !ip.is_unspecified(),
        "no non-loopback address: {ip}"
    );
    ip
}

#[tokio::test]
async fn binds_loopback_only() {
    let root = scratch("loopback");
    let mut h = hub(&root);
    h.up().await;
    let port = port_of(&root);
    // Reachable on loopback ...
    assert!(get_root(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).is_ok());
    // ... and not on the machine's own network address.
    let outside = SocketAddr::new(non_loopback(), port);
    let started = Instant::now();
    let reached = TcpStream::connect_timeout(&outside, Duration::from_secs(10));
    assert!(
        reached.is_err(),
        "the window's port answered on {outside} (after {:?})",
        started.elapsed()
    );
    assert_eq!(h.stop().await, Some(0), "{}", h.log());
    let _ = std::fs::remove_dir_all(&root);
}
