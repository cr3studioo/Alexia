// SPDX-License-Identifier: AGPL-3.0-only
use alexia_mesh::wol::{magic_packet, own_macs, parse_mac, wake_to};

const MAC: [u8; 6] = [0xaa, 0xbb, 0xcc, 0x01, 0x02, 0x03];

#[test]
fn packet_shape() {
    let p = magic_packet(MAC);
    assert_eq!(p.len(), 102);
    assert!(p[..6].iter().all(|b| *b == 0xFF));
    assert!(p[6..].chunks(6).all(|c| c == MAC));
}

#[test]
fn parse_mac_forms() {
    assert_eq!(parse_mac("aa:bb:cc:01:02:03"), Some(MAC));
    assert_eq!(parse_mac("AA-BB-CC-01-02-03"), Some(MAC));
    for bad in [
        "",
        "aa:bb:cc:01:02",
        "aa:bb:cc:01:02:03:04",
        "aa:bb:cc:01:02:zz",
        "aabbcc010203",
        "a:b:c:d:e:f",
    ] {
        assert_eq!(parse_mac(bad), None, "{bad}");
    }
}

#[tokio::test]
async fn wake_sends_to_a_local_listener() {
    let l = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    wake_to(addr, &[MAC]).await.unwrap();
    let mut buf = [0u8; 200];
    for _ in 0..3 {
        let n = tokio::time::timeout(std::time::Duration::from_secs(30), l.recv(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&buf[..n], &magic_packet(MAC)[..]);
    }
}

#[tokio::test]
async fn own_macs_runs() {
    for m in own_macs().await {
        assert!(parse_mac(&m).is_some(), "{m}");
    }
}
