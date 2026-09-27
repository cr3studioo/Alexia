// SPDX-License-Identifier: AGPL-3.0-only

//! Apple's own Liquid Glass, laid over parts of the page (`packages/ui/src/desktop.ts`).
//!
//! **Why this is Rust at all.** Liquid Glass bends and lights what is behind it, and a page can
//! only fake that with a blur. The real thing is `NSGlassEffectView`, an AppKit view, which only
//! this process can put in the window. It sits on top of the WKWebView, over a rectangle the page
//! names, and the page's own element stays underneath and keeps every click. macOS 26 and later;
//! anywhere else the command says no, and the page keeps its web look.
//!
//! It is used the way Apple uses it: as the moving pill of a switcher and the knob of a slider,
//! over a quiet track, with the chosen SF Symbol drawn inside the glass. The trackpad's click
//! (`haptic`) lives here too, because it goes with those same moves.
//!
//! **It decides nothing and keeps nothing but the views.** The page says where each glass goes,
//! how round it is, what it shows and whether it shows. This file only puts it there.

/// How one glass looks, as `desktop.ts` sends it.
///
/// - `rect` is `[x, y, width, height, page height]` in CSS pixels from `getBoundingClientRect`.
///   The page's zoom (⌘+ and ⌘-) is read here and applied, so the page never has to know it.
/// - `style` is `"regular"` or `"clear"`. A move takes `duration_ms`, and 0 is at once; `spring`
///   moves it with a little overshoot instead of easing.
/// - `symbol` is an SF Symbol's name, drawn in the middle of the glass; none draws nothing.
/// - `tint` is sRGB `[r, g, b, a]`, each 0 to 1, that the glass leans towards.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // Read only by the Mac's `place`.
pub struct Look {
    rect: [f64; 5], radius: f64, style: String, visible: bool, duration_ms: f64,
    spring: Option<bool>, symbol: Option<String>, tint: Option<[f64; 4]>,
}

/// `false` means *no glass here*: not a Mac, a Mac before macOS 26, or a window with no web
/// view. An empty `id` only asks the question and places nothing.
#[tauri::command]
pub async fn glass(webview: tauri::Webview, id: String, look: Option<Look>) -> bool {
    // Asked by name, never by `class()`, which stops the program on a Mac that has no such class.
    #[cfg(target_os = "macos")]
    if objc2::runtime::AnyClass::get(c"NSGlassEffectView").is_some() {
        let Some(look) = look.filter(|_| !id.is_empty()) else { return true };
        return webview.with_webview(move |p| mac::place(p.inner(), &id, &look)).is_ok();
    }
    let _ = (webview, id, look);
    false
}

/// The trackpad's small click as a pill or a knob lands: `"alignment"`, `"level"` or anything
/// else for the generic one. Nothing happens away from a Mac, or on one without a Force Touch
/// trackpad.
#[tauri::command]
pub fn haptic(kind: String) {
    #[cfg(target_os = "macos")]
    mac::haptic(&kind);
    let _ = kind;
}

#[cfg(target_os = "macos")]
mod mac {
    use objc2::{define_class, msg_send, rc::Retained, runtime::NSObject, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::*;
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use std::{cell::RefCell, collections::HashMap};

    define_class!(
        /// The glass, with one change: it is never what a click lands on. `hitTest:` answering
        /// nothing sends the click on to the web view, and so to the element under the glass.
        #[unsafe(super(NSGlassEffectView, NSView, NSResponder, NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "AlexiaGlass"]
        struct Glass;

        impl Glass {
            #[unsafe(method(hitTest:))]
            fn hit_test(&self, _point: CGPoint) -> *mut NSView {
                std::ptr::null_mut()
            }
        }
    );

    // Every glass the page has asked for by its id, with the symbol it shows. AppKit views live
    // on the main thread, and so does this.
    thread_local!(static SHOWN: RefCell<HashMap<String, (Retained<Glass>, Option<String>)>> = RefCell::default());

    /// Runs on the main thread, inside `with_webview`, where Tauri's platform view is a WKWebView.
    pub fn place(view: *mut std::ffi::c_void, id: &str, look: &super::Look) {
        let Some(mtm) = MainThreadMarker::new() else { return };
        let [x, y, w, h, page] = look.rect;
        // SAFETY: on a Mac the platform web view is a WKWebView, alive for this call.
        let web = unsafe { &*view.cast::<objc2_web_kit::WKWebView>() };
        // `pageZoom` points a CSS pixel, measured up from the page's bottom: the view reaches under the title bar.
        let (zoom, flip) = (unsafe { web.pageZoom() }, web.isFlipped());
        let top = if flip { web.bounds().size.height - page * zoom + y * zoom } else { (page - y - h) * zoom };
        let frame = CGRect::new(CGPoint::new(x * zoom, top), CGSize::new(w * zoom, h * zoom));
        SHOWN.with_borrow_mut(|shown| {
            let (glass, symbol) = shown.entry(id.into()).or_insert_with(|| {
                let glass: Retained<Glass> = unsafe { msg_send![Glass::alloc(mtm), initWithFrame: frame] };
                web.addSubview(&glass);
                (glass, None)
            });
            glass.setCornerRadius(look.radius * zoom);
            glass.setStyle(if look.style == "clear" { NSGlassEffectViewStyle::Clear } else { NSGlassEffectViewStyle::Regular });
            glass.setTintColor(look.tint.map(|[r, g, b, a]| NSColor::colorWithSRGBRed_green_blue_alpha(r, g, b, a)).as_deref());
            if *symbol != look.symbol {
                // A new picture in a new view, the glass's size, growing with it as it moves.
                glass.setContentView(look.symbol.as_deref().and_then(|name| icon(name, (h * 0.55).min(18.0) * zoom, glass.bounds(), mtm)).as_deref());
                symbol.clone_from(&look.symbol);
            }
            glass.setHidden(!look.visible);
            NSAnimationContext::beginGrouping();
            let context = NSAnimationContext::currentContext();
            context.setDuration(look.duration_ms / 1000.0);
            // A spring's feel as a curve, past the end a little and back, as Apple's glass tabs move.
            let spring = look.spring == Some(true);
            context.setTimingFunction(spring.then(|| objc2_quartz_core::CAMediaTimingFunction::functionWithControlPoints(0.34, 1.4, 0.64, 1.0)).as_deref());
            glass.animator().setFrame(frame);
            NSAnimationContext::endGrouping();
        });
    }

    /// An SF Symbol, centred in `bounds` and never stretched. System symbols are template images,
    /// so the glass colours them itself, as it does its own. None when this Mac has no such name.
    fn icon(name: &str, size: f64, bounds: CGRect, mtm: MainThreadMarker) -> Option<Retained<NSView>> {
        let image = NSImage::imageWithSystemSymbolName_accessibilityDescription(&objc2_foundation::NSString::from_str(name), None)?;
        let view = NSImageView::imageViewWithImage(&image, mtm);
        // Medium weight (`NSFontWeightMedium`), as the symbols in Apple's own tab bars are.
        view.setSymbolConfiguration(Some(&NSImageSymbolConfiguration::configurationWithPointSize_weight(size, 0.23)));
        view.setFrame(bounds);
        view.setAutoresizingMask(NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable);
        Some(Retained::into_super(Retained::into_super(view)))
    }

    /// `NSHapticFeedbackManager`'s default performer, now rather than at the next redraw.
    pub fn haptic(kind: &str) {
        let pattern = match kind { "alignment" => NSHapticFeedbackPattern::Alignment, "level" => NSHapticFeedbackPattern::LevelChange, _ => NSHapticFeedbackPattern::Generic };
        NSHapticFeedbackManager::defaultPerformer().performFeedbackPattern_performanceTime(pattern, NSHapticFeedbackPerformanceTime::Now);
    }
}
