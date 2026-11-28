// SPDX-License-Identifier: AGPL-3.0-only
//! Wake-on-LAN: the magic packet a limb sends to wake a sleeping hub.

use crate::presence::run;
use crate::Result;
use std::net::{Ipv4Addr, SocketAddr};
use std::time::Duration;
use tokio::net::UdpSocket;

/// "aa:bb:cc:dd:ee:ff" or "aa-bb-cc-dd-ee-ff" (either case).
pub fn parse_mac(s: &str) -> Option<[u8; 6]> {
    let s = s.trim();
    let sep = if s.contains(':') { ':' } else { '-' };
    let mut out = [0u8; 6];
    let mut parts = s.split(sep);
    for b in &mut out {
        let p = parts.next()?;
        if p.len() != 2 {
            return None;
        }
        *b = u8::from_str_radix(p, 16).ok()?;
    }
    parts.next().is_none().then_some(out)
}

/// 6 × 0xFF, then the MAC 16 times.
pub fn magic_packet(mac: [u8; 6]) -> [u8; 102] {
    let mut p = [0xFF; 102];
    for i in 0..16 {
        p[6 + i * 6..12 + i * 6].copy_from_slice(&mac);
    }
    p
}

/// Send each MAC's magic packet to `addr`, three times 100 ms apart. Exposed for tests.
#[doc(hidden)]
pub async fn wake_to(addr: SocketAddr, macs: &[[u8; 6]]) -> Result<()> {
    // A send, not a listener: an unspecified local port.
    let sock = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).await?;
    sock.set_broadcast(true)?;
    for round in 0..3 {
        if round > 0 {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        for mac in macs {
            sock.send_to(&magic_packet(*mac), addr).await?;
        }
    }
    Ok(())
}

/// UDP broadcast to 255.255.255.255:9 and :7, three times 100 ms apart.
pub async fn wake(macs: &[[u8; 6]]) -> Result<()> {
    let to = |port| SocketAddr::from((Ipv4Addr::BROADCAST, port));
    let (a, b) = tokio::join!(wake_to(to(9), macs), wake_to(to(7), macs));
    a.and(b)
}

/// This computer's MAC addresses as "aa:bb:cc:dd:ee:ff". Empty if unknown.
pub async fn own_macs() -> Vec<String> {
    let mut macs: Vec<[u8; 6]> = Vec::new();
    #[cfg(windows)]
    if let Some(out) = run("getmac", &["/fo", "csv", "/nh"]).await {
        // "AA-BB-CC-DD-EE-FF","\Device\Tcpip_{...}"; a disconnected adapter says "N/A".
        macs = out
            .lines()
            .filter_map(|l| parse_mac(l.split(',').next()?.trim_matches('"')))
            .collect();
    }
    #[cfg(target_os = "macos")]
    if let Some(out) = run("ifconfig", &[]).await {
        macs = out
            .lines()
            .filter_map(|l| parse_mac(l.trim().strip_prefix("ether ")?))
            .collect();
    }
    macs.sort();
    macs.dedup();
    macs.iter()
        .map(|m| m.map(|b| format!("{b:02x}")).join(":"))
        .collect()
}
