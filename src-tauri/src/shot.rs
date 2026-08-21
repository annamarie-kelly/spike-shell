// shot.rs — give the agent eyes on what the user is actually looking at.
//
// Why this exists: the in-pane browser's isolation cuts both ways. No Tauri
// capability matches a remote origin, so page JS cannot reach Spike's commands
// — and for exactly the same reason nothing can read that page's content out.
// The pane can be showing an authenticated feed, a document, a dashboard, and
// an agent asked "what am I looking at?" has literally no text channel to it.
// A picture is the only sanctioned way in.
//
// No Screen Recording permission. The obvious implementations
// (CGWindowListCreateImage, ScreenCaptureKit) both trip macOS TCC, which is a
// bad ask for a dev tool and a worse one for an app that just grew a browser.
// Both APIs used here are in-process and capture only Spike's own surfaces:
//   - `WKWebView takeSnapshotWithConfiguration:` for the native browser board.
//   - `NSView cacheDisplayInRect:toBitmapImageRep:` for Spike's own UI.
//
// Why two: a WKWebView renders out of process, so `cacheDisplayInRect:` over
// the window leaves a blank rectangle exactly where the browser is. Capturing
// both and compositing is the eventual answer (see `Target::Window`); today a
// board is captured on its own, which is the case that matters most because it
// is the one an agent cannot read any other way.
//
// PRIVACY / INJECTION. This is pull, never push. Nothing captures on its own:
// `spike context` only advertises that the capability exists, so an image
// enters an agent's context solely because the agent asked on this turn. And
// what comes back is untrusted web content — text rendered inside a screenshot
// can carry instructions just as a page can. Same conclusion as the
// console/network telemetry design: fence it as untrusted, and the real
// backstop is downstream tool approval, not anything decided here.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

/// What to photograph.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Target {
    /// The preview pane. The native browser board if one is up, otherwise
    /// Spike's own UI (which captures correctly, being in-process).
    Pane,
    /// The whole Spike window.
    Window,
}

/// Parse the CLI's target word. Pure, so the accepted vocabulary is testable.
/// Anything unrecognised is an error rather than a silent default, because
/// silently photographing the wrong surface wastes a round trip and the agent
/// has no way to tell it got the wrong thing.
pub fn parse_target(s: &str) -> Result<Target, String> {
    match s.trim().to_ascii_lowercase().as_str() {
        "" | "pane" | "preview" | "board" => Ok(Target::Pane),
        "window" | "app" | "all" => Ok(Target::Window),
        other => Err(format!("unknown target {other:?} (expected 'pane' or 'window')")),
    }
}

/// Where shots land. Under `~/.spike` rather than a temp dir so they survive
/// long enough for an agent to read them, and so there is one obvious place to
/// look when wondering what has been captured.
fn shots_dir() -> PathBuf {
    crate::state::spike_dir().join("shots")
}

/// Keep the last `KEEP` shots and delete the rest. These are screenshots of the
/// user's own screen; letting them pile up unbounded on disk is both untidy and
/// the wrong default for something this sensitive.
fn prune(dir: &std::path::Path) {
    const KEEP: usize = 20;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<_> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "png"))
        .filter_map(|e| e.metadata().ok().and_then(|m| m.modified().ok()).map(|t| (t, e.path())))
        .collect();
    if files.len() <= KEEP {
        return;
    }
    files.sort_by_key(|(t, _)| *t);
    for (_, path) in files.iter().take(files.len() - KEEP) {
        let _ = std::fs::remove_file(path);
    }
}

/// Filename for a capture taken now. Colons are legal on APFS but awful to type
/// and paste into a shell, so the ISO timestamp is flattened.
fn shot_name(iso: &str, target: Target) -> String {
    let stamp = iso.replace([':', '.'], "-");
    let what = match target {
        Target::Pane => "pane",
        Target::Window => "window",
    };
    format!("{what}-{stamp}.png")
}

/// Capture `target` and return the PNG's path on disk.
pub fn capture(app: &AppHandle, target: Target) -> Result<PathBuf, String> {
    let png = capture_png(app, target)?;
    if png.is_empty() {
        return Err("capture produced no image".into());
    }
    let dir = shots_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("shots dir: {e}"))?;
    let (iso, _day) = crate::fs_ops::now_parts();
    let path = dir.join(shot_name(&iso, target));
    std::fs::write(&path, &png).map_err(|e| format!("write shot: {e}"))?;
    prune(&dir);
    crate::watcher::log_action(
        "spike_shot",
        serde_json::json!({ "path": path.to_string_lossy(), "bytes": png.len() }),
    );
    Ok(path)
}

#[cfg(target_os = "macos")]
fn capture_png(app: &AppHandle, target: Target) -> Result<Vec<u8>, String> {
    // A board is only worth photographing when it is actually on screen; a
    // hidden one would hand back a stale or blank frame.
    let board_up = app.get_webview(crate::live_webview::LIVE_LABEL).is_some()
        && crate::live_webview::board_visible();
    match (target, board_up) {
        // Just the board: the tightest crop of the thing that has no text channel.
        (Target::Pane, true) => capture_board(app),
        // Spike's own UI is in-process and captures correctly on its own.
        (Target::Pane, false) | (Target::Window, false) => capture_window_ui(app),
        // Everything at once, which is the only version that honestly answers
        // "what am I looking at". Needs both captures composited — see below.
        (Target::Window, true) => capture_window_composited(app),
    }
}

#[cfg(not(target_os = "macos"))]
fn capture_png(_app: &AppHandle, _target: Target) -> Result<Vec<u8>, String> {
    Err("screenshots are macOS-only for now".into())
}

/// Snapshot the native browser board via `takeSnapshotWithConfiguration:`.
///
/// The completion handler is asynchronous and fires on the main queue, so this
/// hands the work to the main thread and blocks the CALLING thread on a channel
/// — safe precisely because the caller is the CLI listener thread, never main.
/// Blocking main here would deadlock against the handler we are waiting for.
#[cfg(target_os = "macos")]
fn capture_board(app: &AppHandle) -> Result<Vec<u8>, String> {
    use std::sync::mpsc;
    use std::time::Duration;

    let wv = app
        .get_webview(crate::live_webview::LIVE_LABEL)
        .ok_or("no browser board")?;
    let (tx, rx) = mpsc::channel::<Option<Vec<u8>>>();
    wv.with_webview(move |pw| unsafe {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;
        let webview = pw.inner() as *mut AnyObject;
        if webview.is_null() {
            let _ = tx.send(None);
            return;
        }
        let handler = block2::RcBlock::new(move |image: *mut AnyObject, _err: *mut AnyObject| {
            let _ = tx.send(if image.is_null() { None } else { png_from_nsimage(image) });
        });
        let nil = std::ptr::null_mut::<AnyObject>();
        let _: () = msg_send![webview, takeSnapshotWithConfiguration: nil, completionHandler: &*handler];
        // The callee copies the completion block, but leaking this one small
        // block is cheap insurance against the copy not happening: a dangling
        // handler here is a use-after-free on the main thread.
        std::mem::forget(handler);
    })
    .map_err(|e| format!("with_webview: {e}"))?;

    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Some(png)) => Ok(png),
        Ok(None) => Err("board snapshot returned no image".into()),
        Err(_) => Err("board snapshot timed out".into()),
    }
}

/// Capture Spike's own UI straight off the window's content view. Synchronous,
/// in-process, and accurate for everything the DOM draws. A native child
/// webview inside it will come out blank (out-of-process rendering), which is
/// why a visible board is captured by `capture_board` instead.
#[cfg(target_os = "macos")]
fn capture_window_ui(app: &AppHandle) -> Result<Vec<u8>, String> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_foundation::NSRect;

    let window = app.get_window("main").ok_or("main window not found")?;
    let ns_window = window.ns_window().map_err(|e| format!("ns_window: {e}"))? as *mut AnyObject;
    if ns_window.is_null() {
        return Err("no ns_window".into());
    }
    // Must run on the main thread: AppKit view drawing is not thread-safe.
    let (tx, rx) = std::sync::mpsc::channel::<Option<Vec<u8>>>();
    let ptr = ns_window as usize;
    app.run_on_main_thread(move || unsafe {
        let ns_window = ptr as *mut AnyObject;
        let content: *mut AnyObject = msg_send![ns_window, contentView];
        if content.is_null() {
            let _ = tx.send(None);
            return;
        }
        let bounds: NSRect = msg_send![content, bounds];
        let rep: *mut AnyObject = msg_send![content, bitmapImageRepForCachingDisplayInRect: bounds];
        if rep.is_null() {
            let _ = tx.send(None);
            return;
        }
        let _: () = msg_send![content, cacheDisplayInRect: bounds, toBitmapImageRep: rep];
        let _ = tx.send(png_from_rep(rep));
    })
    .map_err(|e| format!("main thread: {e}"))?;

    match rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(Some(png)) => Ok(png),
        Ok(None) => Err("window capture returned no image".into()),
        Err(_) => Err("window capture timed out".into()),
    }
}

/// The whole window as the user actually sees it: Spike's own UI with the
/// native browser board drawn into the hole it leaves behind.
///
/// The ordering is the whole trick. `takeSnapshot` is asynchronous and its
/// completion handler runs on the main queue, while every AppKit object
/// involved (NSImage, NSBitmapImageRep, the graphics context) is neither `Send`
/// nor safe to touch off the main thread. So the compositing happens INSIDE the
/// completion handler, and the only thing that crosses back to the calling
/// thread is a `Vec<u8>` of PNG bytes.
///
/// Capturing the window inside the handler, after the snapshot returns, also
/// means both halves come from approximately the same instant rather than from
/// either side of an async hop.
///
/// Drawing goes through an `NSGraphicsContext` over the bitmap rep rather than
/// `NSImage lockFocus`, which would re-render at the current screen scale and
/// quietly throw away the Retina rep the window capture just produced.
#[cfg(target_os = "macos")]
fn capture_window_composited(app: &AppHandle) -> Result<Vec<u8>, String> {
    use std::sync::mpsc;
    use std::time::Duration;

    let wv = app
        .get_webview(crate::live_webview::LIVE_LABEL)
        .ok_or("no browser board")?;
    let (tx, rx) = mpsc::channel::<Option<Vec<u8>>>();
    wv.with_webview(move |pw| unsafe {
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};
        use objc2_foundation::NSRect;

        let webview = pw.inner() as *mut AnyObject;
        let ns_window = pw.ns_window() as *mut AnyObject;
        if webview.is_null() || ns_window.is_null() {
            let _ = tx.send(None);
            return;
        }
        let content: *mut AnyObject = msg_send![ns_window, contentView];
        if content.is_null() {
            let _ = tx.send(None);
            return;
        }
        // Where the board sits in the window's coordinate space. Asking the
        // view to convert is right where reading `frame` is not: the webview is
        // not necessarily a direct child of the content view, and `frame` is
        // relative to whatever its superview happens to be.
        let wv_bounds: NSRect = msg_send![webview, bounds];
        let board_rect: NSRect = msg_send![webview, convertRect: wv_bounds, toView: content];

        let content_ptr = content as usize;
        let handler = block2::RcBlock::new(move |image: *mut AnyObject, _err: *mut AnyObject| {
            let content = content_ptr as *mut AnyObject;
            let bounds: NSRect = msg_send![content, bounds];
            let rep: *mut AnyObject = msg_send![content, bitmapImageRepForCachingDisplayInRect: bounds];
            if rep.is_null() {
                let _ = tx.send(None);
                return;
            }
            let _: () = msg_send![content, cacheDisplayInRect: bounds, toBitmapImageRep: rep];
            // Draw the board over the blank rectangle the webview leaves.
            if !image.is_null() {
                let ctx: *mut AnyObject =
                    msg_send![class!(NSGraphicsContext), graphicsContextWithBitmapImageRep: rep];
                if !ctx.is_null() {
                    let _: () = msg_send![class!(NSGraphicsContext), saveGraphicsState];
                    let _: () = msg_send![class!(NSGraphicsContext), setCurrentContext: ctx];
                    // 2 = NSCompositingOperationSourceOver, 1.0 = fully opaque.
                    let _: () = msg_send![
                        image,
                        drawInRect: board_rect,
                        fromRect: NSRect::ZERO,
                        operation: 2usize,
                        fraction: 1.0f64
                    ];
                    let _: () = msg_send![class!(NSGraphicsContext), restoreGraphicsState];
                }
            }
            let _ = tx.send(png_from_rep(rep));
        });
        let nil = std::ptr::null_mut::<AnyObject>();
        let _: () = msg_send![webview, takeSnapshotWithConfiguration: nil, completionHandler: &*handler];
        std::mem::forget(handler); // see capture_board
    })
    .map_err(|e| format!("with_webview: {e}"))?;

    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Some(png)) => Ok(png),
        Ok(None) => Err("composite capture returned no image".into()),
        Err(_) => Err("composite capture timed out".into()),
    }
}

/// NSImage → PNG bytes, via its TIFF representation (the one representation an
/// NSImage always knows how to produce).
#[cfg(target_os = "macos")]
unsafe fn png_from_nsimage(image: *mut objc2::runtime::AnyObject) -> Option<Vec<u8>> {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    let tiff: *mut AnyObject = msg_send![image, TIFFRepresentation];
    if tiff.is_null() {
        return None;
    }
    let rep: *mut AnyObject = msg_send![class!(NSBitmapImageRep), imageRepWithData: tiff];
    if rep.is_null() {
        return None;
    }
    png_from_rep(rep)
}

/// NSBitmapImageRep → PNG bytes. 4 is `NSBitmapImageFileTypePNG`.
#[cfg(target_os = "macos")]
unsafe fn png_from_rep(rep: *mut objc2::runtime::AnyObject) -> Option<Vec<u8>> {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    let props: *mut AnyObject = msg_send![class!(NSDictionary), dictionary];
    let data: *mut AnyObject = msg_send![rep, representationUsingType: 4isize, properties: props];
    if data.is_null() {
        return None;
    }
    let bytes: *const u8 = msg_send![data, bytes];
    let len: usize = msg_send![data, length];
    if bytes.is_null() || len == 0 {
        return None;
    }
    Some(std::slice::from_raw_parts(bytes, len).to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_vocabulary_is_forgiving_but_never_guesses() {
        assert_eq!(parse_target("").unwrap(), Target::Pane);
        assert_eq!(parse_target("pane").unwrap(), Target::Pane);
        assert_eq!(parse_target(" PREVIEW ").unwrap(), Target::Pane);
        assert_eq!(parse_target("board").unwrap(), Target::Pane);
        assert_eq!(parse_target("window").unwrap(), Target::Window);
        assert_eq!(parse_target("App").unwrap(), Target::Window);
        // An unknown word is an error, not a silent fallback: photographing the
        // wrong surface is invisible to the caller.
        assert!(parse_target("terminal").is_err());
        assert!(parse_target("screen").is_err());
    }

    #[test]
    fn shot_names_are_shell_safe_and_say_what_they_are() {
        let name = shot_name("2026-07-27T18:16:16.133Z", Target::Pane);
        assert!(name.starts_with("pane-"));
        assert!(name.ends_with(".png"));
        // Colons and dots make a path miserable to paste into a shell.
        assert!(!name[..name.len() - 4].contains(':'));
        assert!(!name[..name.len() - 4].contains('.'));
        assert!(shot_name("2026-07-27T18:16:16.133Z", Target::Window).starts_with("window-"));
    }
}
