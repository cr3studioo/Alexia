// SPDX-License-Identifier: AGPL-3.0-only
//! The types every mesh module shares.

use serde::{Deserialize, Serialize};

pub use alexia_store::Ms;

/// The longest a [`DeviceId`] may be.
const ID_MAX: usize = 32;

/// A paired device's id: lowercase `a-z0-9-`, 1..=32 chars, made from its name at pairing
/// ("Vaclav's MacBook" → "vaclavs-macbook"; a clash gets "-2"). It is also the hub's plugin id for it.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DeviceId(pub String);

impl DeviceId {
    /// The id for a device called `name`, unlike every id in `taken`. Accents fold to ASCII,
    /// apostrophes vanish, every other run of non-alphanumerics becomes one `-`. A name that
    /// starts with a digit (or has nothing usable) gets `device` in front, because a plugin id
    /// starts with a letter.
    pub fn from_name(name: &str, taken: &[DeviceId]) -> DeviceId {
        let mut s = String::new();
        let mut dash = false;
        for c in name.chars().flat_map(char::to_lowercase) {
            if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{02bc}' | '`') {
                continue;
            }
            let ascii = c.to_string();
            let Some(f) = (if c.is_ascii_alphanumeric() {
                Some(ascii.as_str())
            } else {
                fold(c)
            }) else {
                dash = true;
                continue;
            };
            if dash && !s.is_empty() {
                s.push('-');
            }
            dash = false;
            s.push_str(f);
        }
        if !s.starts_with(|c: char| c.is_ascii_lowercase()) {
            s = if s.is_empty() {
                "device".into()
            } else {
                format!("device-{s}")
            };
        }
        let base = cap(&s, ID_MAX);
        if !taken.iter().any(|t| t.0 == base) {
            return DeviceId(base);
        }
        (2..)
            .map(|n| {
                let suffix = format!("-{n}");
                format!("{}{suffix}", cap(&base, ID_MAX - suffix.len()))
            })
            .find(|c| !taken.iter().any(|t| &t.0 == c))
            .map(DeviceId)
            .expect("an unbounded range finds a free id")
    }

    /// Whether `s` is a well-formed device id (and so a plugin id).
    pub fn valid(s: &str) -> bool {
        (1..=ID_MAX).contains(&s.len()) && alexia_store::is_plugin_id(s)
    }
}

/// `s` cut to at most `max` bytes (all ASCII here), with no trailing `-`.
fn cap(s: &str, max: usize) -> String {
    s[..s.len().min(max)].trim_end_matches('-').to_string()
}

/// The ASCII for a lowercase accented Latin letter, or `None` for anything else.
fn fold(c: char) -> Option<&'static str> {
    Some(match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => "a",
        'æ' => "ae",
        'ç' | 'ć' | 'ĉ' | 'ċ' | 'č' => "c",
        'ď' | 'đ' | 'ð' => "d",
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' => "e",
        'ĝ' | 'ğ' | 'ġ' | 'ģ' => "g",
        'ĥ' | 'ħ' => "h",
        'ì' | 'í' | 'î' | 'ï' | 'ĩ' | 'ī' | 'ĭ' | 'į' | 'ı' => "i",
        'ĵ' => "j",
        'ķ' => "k",
        'ĺ' | 'ļ' | 'ľ' | 'ŀ' | 'ł' => "l",
        'ñ' | 'ń' | 'ņ' | 'ň' => "n",
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ŏ' | 'ő' => "o",
        'œ' => "oe",
        'ŕ' | 'ŗ' | 'ř' => "r",
        'ś' | 'ŝ' | 'ş' | 'š' => "s",
        'ß' => "ss",
        'ţ' | 'ť' | 'ŧ' => "t",
        'þ' => "th",
        'ù' | 'ú' | 'û' | 'ü' | 'ũ' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' => "u",
        'ŵ' => "w",
        'ý' | 'ÿ' | 'ŷ' => "y",
        'ź' | 'ż' | 'ž' => "z",
        _ => return None,
    })
}

/// connect's endpoint id: 64 lowercase hex.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EndpointId(pub String);

impl EndpointId {
    pub fn parse(s: &str) -> Option<EndpointId> {
        (s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
            .then(|| EndpointId(s.to_string()))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Hub,
    Limb,
}

/// connect's peer status.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Reach {
    Direct,
    Relayed,
    Offline,
}

/// What a device says about itself at pairing (connect's `payload`, ≤ 1024 B serialized).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub role: Role,
    pub platform: String,
    pub app_version: String,
    /// MAC addresses "aa:bb:cc:dd:ee:ff", hub only.
    #[serde(default)]
    pub wake: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum MeshEvent {
    Online { device: DeviceId, reach: Reach },
    Offline { device: DeviceId },
    Paired { device: DeviceId },
    Revoked { device: DeviceId },
}

/// A pairing the hub offers (HB-18).
#[derive(Clone, Debug)]
pub struct PairOffer {
    pub uri: String,
    pub code: String,
    pub expires_at: Ms,
    pub qr_text: String,
    pub qr_svg: String,
}

pub const PAIR_SCHEME: &str = "alexia-pair:1";
/// Limb operation, POST, duplex ndjson.
pub const LINK_PATH: &str = "/alexia/mcp/1";
/// Hub operation, POST `{}`.
pub const OP_KILL: &str = "/alexia/kill/1";
/// Hub operation, POST `{"idleMs","locked"}`.
pub const OP_PRESENCE: &str = "/alexia/presence/1";
/// Hub operation, POST `{"text","replyTo"?,"data"?}`.
pub const OP_FACE: &str = "/alexia/face/1";
pub const KEEPALIVE_MS: u64 = 5_000;
pub const KEYCHAIN_HUB: &str = "dev.alexia.hub.mesh";
pub const KEYCHAIN_LIMB: &str = "dev.alexia.limb.mesh";
