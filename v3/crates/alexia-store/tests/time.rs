// SPDX-License-Identifier: AGPL-3.0-only
//! P1-25: the one clock, calendar and text flattener.

use alexia_store::{civil_utc, now_ms, Content, Part};

#[test]
fn civil_utc_known_dates() {
    assert_eq!(civil_utc(0), (1970, 1, 1, 0, 0, 0));
    assert_eq!(civil_utc(951_782_400_000), (2000, 2, 29, 0, 0, 0));
    assert_eq!(civil_utc(1_700_000_000_000), (2023, 11, 14, 22, 13, 20));
    assert_eq!(civil_utc(-1), (1969, 12, 31, 23, 59, 59));
}

#[test]
fn now_ms_is_epoch_ms() {
    let a = now_ms();
    let b = now_ms();
    assert!(a > 1_704_067_200_000, "{a} is before 2024-01-01");
    assert!(b >= a, "{b} < {a}");
}

#[test]
fn content_text_joins_text_parts() {
    let c = Content::Parts(vec![
        Part::Text { text: "a".into() },
        Part::Image {
            url: "data:image/png;base64,AAAA".into(),
        },
        Part::Text { text: "b".into() },
    ]);
    assert_eq!(c.text(), "a\nb");
    assert_eq!(Content::Text("x".into()).text(), "x");
}
