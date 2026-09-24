// SPDX-License-Identifier: AGPL-3.0-only

//! A picture of part of the page, for the genie (`packages/ui/src/genie.ts`).
//!
//! **Why this is Rust at all.** The genie bends the Settings or Activity sheet into its tab one
//! row of pixels at a time, which needs the sheet as a picture. A page cannot take a picture of
//! itself — the browser's own way round that copies the sheet two dozen times, and WebKit
//! repainting two dozen sheets every frame was the stutter. WKWebView can: `takeSnapshot` hands
//! back what is on screen in a rectangle, blur and all, in one call. Mac only; everywhere else
//! the command says so and the page falls back to no effect.
//!
//! **It decides nothing and keeps nothing.** One rectangle in, one JPEG out, and only of this
//! window's own page.

/// `x, y, width, height` in CSS pixels, which are the web view's points while the page is not
/// zoomed. The JPEG goes back as a raw buffer, not JSON. A snapshot not back within a quarter of
/// a second is too late to play, and the page closes the sheet without the effect.
#[tauri::command]
pub async fn sheet_snapshot(webview: tauri::Webview, x: f64, y: f64, width: f64, height: f64) -> Result<tauri::ipc::Response, String> {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        webview.with_webview(move |platform| mac::take(platform.inner(), [x, y, width, height], tx)).map_err(|e| e.to_string())?;
        let bytes = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_millis(250)).ok().flatten())
            .await
            .map_err(|e| e.to_string())?;
        bytes.map(tauri::ipc::Response::new).ok_or_else(|| "no snapshot".into())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (webview, x, y, width, height);
        Err("not on this platform".into())
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use block2::RcBlock;
    use objc2::{rc::Retained, AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_foundation::{NSDictionary, NSError, NSNumber};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

    /// JPEG, not PNG: the sheet is opaque where it is drawn, and encoding time is the only cost
    /// anybody feels on the way to half a second of motion.
    fn jpeg(image: &NSImage) -> Option<Vec<u8>> {
        let cg = unsafe { image.CGImageForProposedRect_context_hints(std::ptr::null_mut(), None, None) }?;
        let rep = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &cg);
        unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::JPEG, &NSDictionary::new()) }.map(|data| data.to_vec())
    }

    /// Runs on the main thread, inside `with_webview`, where Tauri's platform view is a WKWebView.
    pub fn take(view: *mut std::ffi::c_void, [x, y, width, height]: [f64; 4], tx: std::sync::mpsc::Sender<Option<Vec<u8>>>) {
        let Some(mtm) = MainThreadMarker::new() else { return };
        // SAFETY: on a Mac the platform web view is a WKWebView, alive for this call.
        let view: &WKWebView = unsafe { &*view.cast::<WKWebView>() };
        let config = unsafe { WKSnapshotConfiguration::new(mtm) };
        unsafe {
            config.setRect(CGRect::new(CGPoint::new(x, y), CGSize::new(width, height)));
            config.setSnapshotWidth(Some(&NSNumber::new_f64(width)));
            config.setAfterScreenUpdates(false);
        }
        let done = RcBlock::new(move |image: *mut NSImage, _: *mut NSError| {
            // SAFETY: WebKit hands back a live image or null.
            let image: Option<Retained<NSImage>> = unsafe { Retained::retain(image) };
            let _ = tx.send(image.as_deref().and_then(jpeg));
        });
        unsafe { view.takeSnapshotWithConfiguration_completionHandler(Some(&config), &done) };
    }
}
