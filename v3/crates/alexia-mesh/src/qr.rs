// SPDX-License-Identifier: AGPL-3.0-only
//! The pairing offer drawn as a QR code, as text and as SVG (HB-18).

use qrcode::render::svg;
use qrcode::{Color, QrCode};

/// Light modules around the code, on each side, in the text rendering.
const QUIET: usize = 2;

/// The modules of `data`'s code with a light border `QUIET` wide, row by row; true = dark.
/// None only for data too long for any QR version (a pairing URI never is).
fn grid(data: &str) -> Option<(usize, Vec<bool>)> {
    let code = QrCode::new(data.as_bytes()).ok()?;
    let w = code.width();
    let colors = code.to_colors();
    let side = w + 2 * QUIET;
    let mut out = vec![false; side * side];
    for y in 0..w {
        for x in 0..w {
            out[(y + QUIET) * side + x + QUIET] = colors[y * w + x] == Color::Dark;
        }
    }
    Some((side, out))
}

/// `data` as a QR in Unicode half blocks, two module rows per line, with a quiet zone of 2.
///
/// Dark on light for the usual dark-background terminal: a light module is drawn (the
/// terminal's light text colour) and a dark one is left blank, so the code reads dark modules on
/// a light field. An empty string if `data` is too long to encode.
pub fn qr_text(data: &str) -> String {
    let Some((side, g)) = grid(data) else {
        return String::new();
    };
    let light = |x: usize, y: usize| y < side && !g[y * side + x];
    let mut s = String::new();
    for y in (0..side).step_by(2) {
        for x in 0..side {
            s.push(match (light(x, y), light(x, y + 1)) {
                (true, true) => '█',
                (true, false) => '▀',
                (false, true) => '▄',
                (false, false) => ' ',
            });
        }
        s.push('\n');
    }
    s
}

/// `data` as a QR in SVG, black on white, at least 256 px square. An empty string if `data` is
/// too long to encode.
pub fn qr_svg(data: &str) -> String {
    let Ok(code) = QrCode::new(data.as_bytes()) else {
        return String::new();
    };
    code.render::<svg::Color>()
        .min_dimensions(256, 256)
        .dark_color(svg::Color("#000000"))
        .light_color(svg::Color("#ffffff"))
        .build()
}
