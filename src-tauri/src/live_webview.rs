// live_webview.rs — a native child webview pinned over the preview pane, used as
// a minimal in-pane browser (`spike open http(s)://…`) rendering pixel-perfectly.
//
// Why a native webview and not an <iframe>: WebKit (Tauri's engine) lays a page
// that declares `width=device-width` out at the *display's* device-width inside
// an iframe — not the frame's width — and doesn't scale to fill, leaving a band
// of empty frame beside the page (Chrome's Blink ignores the meta in iframes, so
// it fills; that's the visible difference). A real child webview renders the URL
// as its own main frame, exactly as a browser would: it fills, it's crisp, 1:1.
//
// The page owns placement. It computes the preview pane's rect (CSS px relative
// to the window) and calls `live_webview_show` on every layout/resize/overlay
// change; we create the child on first show, then just navigate/move/size/show
// or hide it. There is a single live webview (LIVE_LABEL) — one board at a time,
// reused across opens by navigating it — and it paints above the DOM, so the
// page hides it whenever an overlay or menu could sit over the pane. The page
// draws a chrome strip (address bar + back/fwd/reload) in the inset above it.
//
// Security: the URL is restricted to http(s) (any host, except Spike's own
// privileged hosts — see `is_http`). The load-bearing isolation is NOT "the
// child has no invoke_handler" (the handler is app-wide, shared by every
// webview). It is Tauri's capability model: `capabilities/default.json` declares
// no `remote` field, so its permissions apply only to the local `tauri://`
// origin. This child always loads a *remote* http(s) URL, so no capability
// matches it and Tauri injects no IPC bridge — arbitrary page JS cannot reach
// any Spike command. `on_navigation` additionally cancels any attempt to
// navigate the child into a privileged origin, and `on_new_window` classifies
// what the page asked for (see `classify_new_window`): a sized `window.open`
// becomes a real popup window with a working `window.opener`, a plain `_blank`
// becomes an in-pane navigation, and anything non-web goes to macOS.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};

use serde_json::json;

/// Whether a preview is currently expanded (full-screen focus mode). Set by the
/// page via `live_webview_set_expanded`; read by the Esc key monitor so Escape
/// only exits full-screen while in it (and otherwise passes through to the page).
static EXPANDED: AtomicBool = AtomicBool::new(false);

use serde::Serialize;
use tauri::webview::{NewWindowResponse, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl};

/// Payload for the `live-nav` event: the URL the child webview navigated to
/// (link click, redirect, or address-bar submit). The page uses it to keep the
/// address bar and tab name honest and to track back/forward affordance.
#[derive(Clone, Serialize)]
struct LiveNav {
    url: String,
}

pub(crate) const LIVE_LABEL: &str = "live-preview";
/// Label of the top-level Google sign-in window (see `google_signin_show`).
const SIGNIN_LABEL: &str = "google-signin";

/// User-Agents for the in-pane browser. Routed per host by `ua_for_url`: SAFARI_UA
/// is the default (honest engine identity, broadly supported), CHROME_UA only for
/// Google's own apps.
///
/// Why CHROME_UA for Google: Google Docs' canvas document renderer, under a Safari UA,
/// takes a code path that draws its offscreen canvas at 1× (blurry text) even
/// though devicePixelRatio is 2 — Gmail/Drive (plain DOM) stay crisp, so it's a
/// Docs-canvas quirk, not a device-scale bug. A Chrome UA flips Docs to the path
/// that passes the real pixel ratio through → crisp. Verified: Docs sharp,
/// Gmail/Drive unaffected, and it also clears the "unsupported browser" banner.
/// SAFARI_UA is the honest-engine string (this really is WebKit/Safari-family).
/// Used by the top-level Google sign-in window, and kept as the pane fallback if
/// a Chrome UA ever regresses a Google app (Blink-tuned code served to WebKit).
const SAFARI_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";
const CHROME_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// Make the live child webview the window's first responder. WKWebView only
/// tracks the cursor (pointer over links, hover states) reliably while it holds
/// focus; as an overlay child it loses that easily, and the cursor flickers over
/// interactive elements (wry #175). Re-asserting first-responder when the board
/// appears is the focus-based workaround for that engine bug. Main-thread only,
/// which `with_webview` guarantees. No-op off macOS.
#[cfg(target_os = "macos")]
fn make_child_first_responder(wv: &tauri::Webview) {
    let _ = wv.with_webview(|pw| unsafe {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;
        let webview = pw.inner() as *mut AnyObject;
        let ns_window = pw.ns_window() as *mut AnyObject;
        if !webview.is_null() && !ns_window.is_null() {
            let _: bool = msg_send![ns_window, makeFirstResponder: webview];
        }
    });
}
#[cfg(not(target_os = "macos"))]
fn make_child_first_responder(_wv: &tauri::Webview) {}

/// Honest User-Agent per host. The engine genuinely IS WebKit/Safari, so SAFARI_UA
/// is the accurate default — and, being a broadly-supported browser, it clears the
/// "your browser is not supported" walls that a spoofed Chrome UA actually
/// TRIGGERS: a site told "I'm Chrome" then feature-tests for Blink, the WebKit
/// engine fails the test, and the site declares us broken (Slack does exactly
/// this). CHROME_UA is kept ONLY for Google's own apps (docs/drive/mail/…), where
/// their renderer is tuned for it: Docs draws its canvas crisply under Chrome (see
/// CHROME_UA docs) and Google's apps otherwise nag to "update your browser". This
/// is a rendering-compat choice, not an attempt to defeat any control — Google's
/// embedded-webview sign-in block is UA-independent and handled separately by the
/// top-level sign-in window.
fn ua_for_url(url: &tauri::Url) -> &'static str {
    match url.host_str() {
        Some(h) => {
            let h = h.to_ascii_lowercase();
            if h == "google.com" || h.ends_with(".google.com") {
                CHROME_UA
            } else {
                SAFARI_UA
            }
        }
        None => SAFARI_UA,
    }
}

/// Set the child webview's User-Agent at runtime (WKWebView `customUserAgent`),
/// applied to the NEXT load. Lets one reused webview present a host-appropriate UA
/// as the pane navigates between sites. Main-thread only, which `with_webview`
/// guarantees. No-op off macOS.
#[cfg(target_os = "macos")]
fn set_child_ua(wv: &tauri::Webview, ua: &'static str) {
    let _ = wv.with_webview(move |pw| unsafe {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;
        use objc2_foundation::NSString;
        let webview = pw.inner() as *mut AnyObject;
        if !webview.is_null() {
            let ns = NSString::from_str(ua);
            let _: () = msg_send![webview, setCustomUserAgent: &*ns];
        }
    });
}
#[cfg(not(target_os = "macos"))]
fn set_child_ua(_wv: &tauri::Webview, _ua: &'static str) {}

/// Install a one-time app-wide keyDown monitor so Escape exits preview full-screen
/// even when the native browser child holds keyboard focus — its key events never
/// reach the app's DOM otherwise (it's a separate NSView). Acts ONLY while a
/// preview is expanded (EXPANDED): swallows that Escape and emits `browser-esc`
/// for the page to collapse the layout. Every other key — and Escape when not
/// expanded — passes straight through, so the web page keeps normal keyboard use.
#[cfg(target_os = "macos")]
fn install_esc_monitor(app: &AppHandle) {
    static ONCE: OnceLock<()> = OnceLock::new();
    if ONCE.set(()).is_err() {
        return;
    }
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || unsafe {
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};
        let mask: u64 = 1 << 10; // NSEventMaskKeyDown
        let emit_app = app.clone();
        let handler = block2::RcBlock::new(move |event: *mut AnyObject| -> *mut AnyObject {
            if !event.is_null() {
                let code: u16 = msg_send![event, keyCode];
                if code == 53 && EXPANDED.load(Ordering::Relaxed) {
                    // 53 = Escape. Swallow it and let the page collapse full-screen.
                    let _ = emit_app.emit("browser-esc", ());
                    return std::ptr::null_mut();
                }
            }
            event
        });
        let cls = class!(NSEvent);
        let _monitor: *mut AnyObject =
            msg_send![cls, addLocalMonitorForEventsMatchingMask: mask, handler: &*handler];
        // The monitor copies the block and lives for the app's lifetime; keep ours
        // alive too so the copy's captured state is never freed under it.
        std::mem::forget(handler);
    });
}
#[cfg(not(target_os = "macos"))]
fn install_esc_monitor(_app: &AppHandle) {}

/// The page reports whether a preview is expanded (full-screen focus mode) so the
/// Escape monitor knows when to intercept. See `install_esc_monitor`.
#[tauri::command]
pub fn live_webview_set_expanded(on: bool) {
    EXPANDED.store(on, Ordering::Relaxed);
}

/// The URL the live webview currently shows. A reposition (the common call,
/// fired every frame during a resize) must not reload the page, so we only
/// navigate when the target actually changes.
fn current_url() -> &'static Mutex<Option<String>> {
    static U: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    U.get_or_init(|| Mutex::new(None))
}

/// The rect (logical px, rounded to whole px) the webview is currently placed at.
/// The page fires `live_webview_show` every animation frame — off a MutationObserver
/// that catches every `document.body` child change (terminal output, tooltips) — so
/// a static board would otherwise be re-positioned/re-sized ~60×/sec. On macOS that
/// constant native relayout drops hover/click events mid-composite, reading as
/// "glitchy buttons". We remember the last placement and only move/resize the native
/// view when it actually changes, mirroring the URL guard above. Rounding also kills
/// the subpixel wobble from `getBoundingClientRect`'s fractional CSS px.
fn current_rect() -> &'static Mutex<Option<(i32, i32, i32, i32)>> {
    static R: OnceLock<Mutex<Option<(i32, i32, i32, i32)>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(None))
}

/// Whether the native view is currently shown. `syncLiveBoard` calls show/hide
/// every sync tick, and `wv.show()` on macOS re-orders/re-composites the view
/// even when it's already visible — under the pointer that flickers the cursor
/// on hover. So we track visibility and only toggle on a real transition, the
/// same "don't touch unless it changed" discipline as the URL and rect guards.
fn current_visible() -> &'static Mutex<bool> {
    static V: OnceLock<Mutex<bool>> = OnceLock::new();
    V.get_or_init(|| Mutex::new(false))
}

/// Whether the browser board is on screen right now. `shot.rs` asks before
/// photographing it: a hidden board would hand back a stale or blank frame,
/// which is worse than falling back to capturing Spike's own UI.
pub(crate) fn board_visible() -> bool {
    *current_visible().lock().unwrap()
}

/// Set when a show landed while the page was holding a DOM text edit, so we
/// skipped the first-responder grab (see `live_webview_show`'s `focus` arg) and
/// still OWE it. The hover-cursor workaround only re-asserts on a hidden→visible
/// transition, and there may not be another one for a long time — so we replay
/// the grab on the next show that arrives with `focus: true` (the page fires one
/// on focusout, when the edit ends). Without this, renaming a tab while a board
/// is up would leave hover tracking dead until the next overlay open/close.
fn focus_owed() -> &'static Mutex<bool> {
    static F: OnceLock<Mutex<bool>> = OnceLock::new();
    F.get_or_init(|| Mutex::new(false))
}

/// http(s) any host — the in-pane browser renders arbitrary public sites. The
/// scheme check blocks `file:`/`tauri:`/`ipc:` etc.; we additionally reject
/// Spike's own privileged hosts (`*.localhost` IPC/asset protocols) as
/// defense-in-depth, so a typed or clicked URL can never point the child at the
/// app's privileged origin even if the capability model were misconfigured.
fn is_http(url: &tauri::Url) -> bool {
    if url.scheme() != "http" && url.scheme() != "https" {
        return false;
    }
    match url.host_str() {
        Some(h) => {
            let h = h.to_ascii_lowercase();
            !(h == "ipc.localhost" || h == "tauri.localhost" || h == "asset.localhost")
        }
        None => false,
    }
}

/// Spike's own HTML-preview scheme (see html_preview.rs). Loading a local HTML
/// file in the child webview — instead of the sandboxed `<iframe>` — makes it
/// render as its own main frame (fills, crisp, `width=device-width` honored) and
/// with a real origin (localStorage/fetch/cookies work), which the sandbox can't
/// give. It's the "true inline browser" mode for local files. Origin is
/// `spikehtml://localhost` (macOS/Linux) or `http://spikehtml.localhost`
/// (Windows) — NOT the app's `tauri://localhost`, so no capability matches it and
/// Tauri injects no IPC bridge, exactly like a remote http(s) page. The handler
/// only ever serves file bytes + traversal-guarded sibling assets, never a
/// privileged command.
fn is_local_preview(url: &tauri::Url) -> bool {
    (url.scheme() == "spikehtml" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("spikehtml.localhost"))
}

/// The child webview may render arbitrary public http(s) sites OR a local HTML
/// preview served over Spike's own scheme. Everything else (file:, tauri:, ipc:,
/// asset:) stays blocked. This is the gate for what the PAGE may ask us to open
/// (`live_webview_show`) — for what the ENGINE may navigate to, see
/// `is_nav_allowed`.
fn is_allowed(url: &tauri::Url) -> bool {
    is_http(url) || is_local_preview(url)
}

/// The in-engine navigation gate: `is_allowed`, plus `about:` — which the show
/// gate has no reason to accept but the engine constantly needs.
///
/// Found by the Phase 0 sign-in proof: the trace showed eight cancelled
/// `about:blank` navigations on a single page load. Pages build subframes as
/// `about:blank` and then write into them (ad slots, reCAPTCHA, payment and
/// analytics SDKs all do this), and a popup's own starting document is
/// `about:blank` too. Cancelling those breaks the frame silently — the page
/// keeps running with a dead iframe and no error. It is also safe to allow:
/// `about:blank` has no content of its own and inherits the origin of whatever
/// created it, which in this webview is only ever a remote page — never Spike's
/// privileged origin.
///
/// The same cancellation blanks any frame a page fills with content it made
/// ITSELF, so `data:` and `blob:` belong here for the same reason: `<iframe
/// srcdoc>` commits as `about:srcdoc`, and editors/preview panes hand frames a
/// `blob:` or `data:` document. Sonar's page grid and page view are `srcdoc`,
/// which is how this surfaced — every thumbnail and the page itself painted an
/// empty box, no `load` event, no error. Same safety argument as `about:`: each
/// inherits (or is bound to) the origin of the document that created it, so a
/// page can only navigate to what it could already script. `blob:` is the one
/// that carries an origin in its URL, so it is checked against that INNER
/// origin — `blob:tauri://localhost/…` stays refused.
fn is_nav_allowed(url: &tauri::Url) -> bool {
    match url.scheme() {
        "about" => true,
        // Opaque origin, inert. WebKit blocks top-level data: navigation itself.
        "data" => true,
        "blob" => url
            .path()
            .parse::<tauri::Url>()
            .map(|inner| is_http(&inner) || is_local_preview(&inner))
            .unwrap_or(false),
        _ => is_allowed(url),
    }
}

// --- navigation trace ------------------------------------------------------
//
// Federated login fails in ways you cannot reconstruct after the fact: a chain
// of redirects ends on a blank page or a "browser may not be secure" wall, and
// the question is always *which hop* turned. So every navigation the in-pane
// browser makes — pane, popup, and sign-in window — appends one line to
// ~/.spike/logs/browser-trace-<day>.jsonl, and the same line goes to stderr for
// `tauri dev`.
//
// Off by default in release: the trace is a list of every URL the browser
// touches, which is not something a shipped build should write to disk without
// being asked. `tauri dev` has it on (that is where the proof runs); a dogfood
// build turns it on with SPIKE_BROWSER_TRACE=1.

fn trace_enabled() -> bool {
    cfg!(debug_assertions) || std::env::var_os("SPIKE_BROWSER_TRACE").is_some()
}

/// Append one `{ ts, event, ... }` line to today's browser trace. Best-effort:
/// a trace that cannot be written must never break browsing.
fn trace(event: &str, fields: serde_json::Value) {
    if !trace_enabled() {
        return;
    }
    let (iso, day) = crate::fs_ops::now_parts();
    let mut obj = serde_json::Map::new();
    obj.insert("ts".into(), serde_json::Value::String(iso));
    obj.insert("event".into(), serde_json::Value::String(event.to_string()));
    if let serde_json::Value::Object(m) = fields {
        for (k, v) in m {
            if k != "ts" && k != "event" {
                obj.insert(k, v);
            }
        }
    }
    let line = match serde_json::to_string(&serde_json::Value::Object(obj)) {
        Ok(s) => s,
        Err(_) => return,
    };
    eprintln!("spike browser: {line}");
    let dir = crate::state::spike_dir().join("logs");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(format!("browser-trace-{day}.jsonl")))
    {
        let _ = f.write_all(line.as_bytes());
        let _ = f.write_all(b"\n");
    }
}

// --- new-window routing ----------------------------------------------------
//
// The pane used to collapse EVERY new-window request into itself. That is right
// for documents (Drive opens a doc with target=_blank and the user wants it in
// the pane) and wrong for authentication: an OAuth popup that becomes a pane
// navigation loses `window.opener`, so the provider has nothing to post the
// result back to and the flow dead-ends — the page just sits there. Popups are
// the load-bearing half of "stay signed in inside Spike".
//
// The discriminator is the window features. `window.open(url, name, 'width=…,
// height=…')` — what every OAuth/consent popup does — arrives with a size;
// a plain `target=_blank` link arrives without one. That is the same signal a
// real browser uses to decide tab-vs-popup, so we use it rather than a list of
// known auth hostnames (a list is a maintenance burden and silently wrong for
// providers nobody wrote down).

/// What the page asked the in-pane browser to open.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum OpenKind {
    /// A sized `window.open` — an auth/consent popup. Needs a real window with a
    /// real `window.opener`, so the provider can hand the result back.
    Popup,
    /// A plain new tab/window request — becomes an in-pane navigation, keeping
    /// the single-board model (Drive/Docs `_blank` documents land in the pane).
    Board,
    /// Not a web URL (mailto:, tel:, a download, a custom scheme) — macOS owns it.
    External,
}

/// Route a new-window request. `sized` is "the page passed width/height", i.e.
/// `NewWindowFeatures::size().is_some()`. Pure, so the routing table is testable
/// without a webview.
fn classify_new_window(url: &tauri::Url, sized: bool) -> OpenKind {
    if !is_allowed(url) {
        OpenKind::External
    } else if sized {
        OpenKind::Popup
    } else {
        OpenKind::Board
    }
}

/// Label prefix + serial for popup windows. Every Tauri window needs a unique
/// label, and several popups can be open at once (a provider chaining consent
/// screens opens a second one from the first).
static POPUP_SEQ: AtomicUsize = AtomicUsize::new(0);
const POPUP_PREFIX: &str = "browser-popup-";

/// Labels of the popup windows currently open. A popup is a child of the board
/// conceptually but not structurally (it is a top-level OS window), so closing
/// the board has to tear them down explicitly or they outlive their opener as
/// orphaned auth windows with no way back.
fn popup_labels() -> &'static Mutex<Vec<String>> {
    static P: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(Vec::new()))
}

/// Close every open popup and forget them. Called when the board itself closes.
fn close_all_popups(app: &AppHandle) {
    let labels: Vec<String> = std::mem::take(&mut *popup_labels().lock().unwrap());
    for label in labels {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.close();
        }
    }
}

// --- window.close() from a popup -------------------------------------------
//
// wry 0.55.1's `WryWebViewUIDelegate` does not implement `webViewDidClose:`, so
// `window.close()` from page JS is silently dropped: a provider that closes its
// own popup after posting the token leaves a dead window on screen for the user
// to dismiss. Authentication completes either way, which is why Phase 0 passed
// without this — but "the popup closes itself" is the difference between the
// flow feeling native and feeling like a workaround.
//
// WebKit only calls `webViewDidClose:` if the UI delegate responds to it, and
// `respondsToSelector:` is answered by the CLASS. So the fix is to add the
// method to wry's class at runtime. The alternative — swapping in our own
// delegate that forwards to wry's — also requires overriding
// `respondsToSelector:` (a plain `forwardingTargetForSelector:` proxy reports
// NO for forwarded selectors, and WebKit would stop calling wry's file-upload
// panel, media-permission and create-webview handlers entirely). Adding one
// missing method is the smaller, less breakable change.
//
// Fails safe in both directions: if the class is ever renamed the lookup misses
// and we no-op back to manual close, and if wry implements the method upstream
// `class_addMethod` refuses and theirs wins. Either way it is recorded in the
// trace rather than failing silently. The real home for this is upstream in wry.

/// WKWebView pointers of the popups we created. The patch below consults this
/// before closing anything, because `webViewDidClose:` now exists on the class
/// every wry webview shares — including the pane's, which lives in Spike's MAIN
/// window. An unguarded implementation would let any page that calls
/// `window.close()` shut the whole app window.
#[cfg(target_os = "macos")]
fn popup_webviews() -> &'static Mutex<Vec<usize>> {
    static W: OnceLock<Mutex<Vec<usize>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(Vec::new()))
}

/// `webViewDidClose:` — the page called `window.close()`. Route it through
/// `performClose:` rather than closing the NSWindow outright: that is the same
/// path the window's close button takes, so Tauri's own delegate still sees
/// `windowShouldClose:`/`windowWillClose:` and our `Destroyed` handler still
/// runs (deregistering the popup, returning focus to the pane).
#[cfg(target_os = "macos")]
extern "C-unwind" fn web_view_did_close(
    _this: *mut objc2::runtime::AnyObject,
    _cmd: objc2::runtime::Sel,
    webview: *mut objc2::runtime::AnyObject,
) {
    if webview.is_null() || !popup_webviews().lock().unwrap().contains(&(webview as usize)) {
        return; // not one of ours — never touch the main window
    }
    unsafe {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;
        let win: *mut AnyObject = msg_send![webview, window];
        if !win.is_null() {
            let _: () = msg_send![win, performClose: std::ptr::null_mut::<AnyObject>()];
        }
    }
}

// --- camera and microphone --------------------------------------------------
//
// wry's UI delegate answers
// `webView:requestMediaCapturePermissionForOrigin:…:decisionHandler:` with an
// unconditional `WKPermissionDecision::Grant` (wry 0.55.1, ui delegate line
// 136). Defensible for an app whose webview only renders its own local UI;
// not defensible for a pane rendering arbitrary public sites.
//
// MEASURED, not assumed (2026-07-27): that grant is currently UNREACHABLE in
// Spike. `navigator.mediaDevices` is undefined in the pane on every origin —
// verified on both http://127.0.0.1 and an https WebRTC sample, each failing
// with "undefined is not an object" before any permission request. WebKit only
// exposes media capture when the host bundle declares
// NSCameraUsageDescription / NSMicrophoneUsageDescription, and Spike declares
// neither. No page can ask, so nothing was ever silently granted. An earlier
// version of this comment claimed otherwise; it was wrong.
//
// This is kept anyway, as the trapdoor guard. The day anyone adds a usage
// description — to let a video-call site work in the pane, say — the auto-grant
// arms itself instantly and silently, and whoever adds that line will be
// thinking about their feature, not about a default buried in a dependency's
// UI delegate. Cheap insurance against a change whose consequence is invisible
// at the point it is made.
//
// Corollary worth knowing: it also means this patch cannot be exercised
// end-to-end without temporarily adding a usage description to a build.
//
// We answer `Prompt` instead, which hands the decision to WebKit's own
// permission UI and therefore to the user. Prompt rather than Deny because a
// flat Deny breaks legitimate use with no way for the user to say yes, and
// because the failure mode of Prompt is at worst equivalent to Deny. Nothing is
// granted without a person agreeing to it either way.
//
// This one has to REPLACE an existing implementation rather than add a missing
// one, so it uses `class_replaceMethod`. The original is wry's and we do not
// chain to it: chaining would grant.

/// `WKPermissionDecisionPrompt`. See objc2-web-kit's `WKPermissionDecision`.
#[cfg(target_os = "macos")]
const WK_PERMISSION_PROMPT: isize = 0;

/// Ask, never assume. Replaces wry's auto-grant for camera/microphone.
#[cfg(target_os = "macos")]
extern "C-unwind" fn media_capture_permission(
    _this: *mut objc2::runtime::AnyObject,
    _cmd: objc2::runtime::Sel,
    _webview: *mut objc2::runtime::AnyObject,
    origin: *mut objc2::runtime::AnyObject,
    _frame: *mut objc2::runtime::AnyObject,
    capture_type: isize,
    handler: *mut objc2::runtime::AnyObject,
) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    let host = unsafe {
        if origin.is_null() {
            String::new()
        } else {
            let h: *mut AnyObject = msg_send![origin, host];
            if h.is_null() {
                String::new()
            } else {
                let s: *const std::os::raw::c_char = msg_send![h, UTF8String];
                if s.is_null() {
                    String::new()
                } else {
                    std::ffi::CStr::from_ptr(s).to_string_lossy().into_owned()
                }
            }
        }
    };
    // 0 = camera, 1 = microphone, 2 = both (WKMediaCaptureType).
    trace(
        "media-permission",
        json!({ "host": host, "type": capture_type, "decision": "prompt" }),
    );
    if handler.is_null() {
        return;
    }
    unsafe {
        let block: &block2::Block<dyn Fn(isize)> = &*(handler as *const block2::Block<dyn Fn(isize)>);
        block.call((WK_PERMISSION_PROMPT,));
    }
}

/// Replace wry's unconditional camera/microphone grant. Same class-from-a-live
/// object approach as the close patch, and installed from the same place.
#[cfg(target_os = "macos")]
unsafe fn install_media_permission_patch(cls: *const objc2::runtime::AnyClass) {
    use objc2::runtime::{AnyClass, AnyObject};
    let sel = objc2::sel!(
        webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:
    );
    if !(*cls).responds_to(sel) {
        // wry stopped implementing it; WebKit's own default applies and there is
        // nothing to override.
        trace("media-permission-patch", json!({ "replaced": false, "why": "not implemented" }));
        return;
    }
    let imp: objc2::runtime::Imp = std::mem::transmute(
        media_capture_permission
            as extern "C-unwind" fn(
                *mut AnyObject,
                objc2::runtime::Sel,
                *mut AnyObject,
                *mut AnyObject,
                *mut AnyObject,
                isize,
                *mut AnyObject,
            ),
    );
    // v@:@@@q@?  → void, self, _cmd, webview, origin, frame, NSInteger, block
    objc2::ffi::class_replaceMethod(cls as *mut AnyClass, sel, imp, c"v@:@@@q@?".as_ptr());
    trace("media-permission-patch", json!({ "replaced": true }));
}

/// Teach wry's shared UI delegate class to honor `window.close()`.
///
/// Takes a live WKWebView and reads the class off ITS `UIDelegate` rather than
/// looking the class up by name. The name is an implementation detail of wry's
/// `define_class!` and guessing it was simply wrong: the first attempt asked for
/// `WryWebViewUIDelegate` and got nothing, so the patch silently never installed
/// (the trace said so, which is the whole reason the trace exists). Asking a
/// live object what class it is cannot be wrong, and survives wry renaming it.
///
/// Called at PANE creation, before any popup exists, because WebKit decides
/// which optional `WKUIDelegate` methods a delegate supports when the delegate
/// is attached. Patch the class first and every delegate attached afterwards,
/// including every popup's, is seen with the method present.
///
/// Every wry webview shares this class, so once per process is enough.
#[cfg(target_os = "macos")]
unsafe fn install_window_close_patch(webview: *mut objc2::runtime::AnyObject) {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    static DONE: AtomicBool = AtomicBool::new(false);
    if DONE.load(Ordering::Relaxed) || webview.is_null() {
        return;
    }
    let delegate: *mut AnyObject = msg_send![webview, UIDelegate];
    if delegate.is_null() {
        // No delegate attached yet. Leave DONE unset so the next webview retries.
        trace("popup-close-patch", json!({ "installed": false, "why": "no UIDelegate" }));
        return;
    }
    let cls: *const AnyClass = msg_send![delegate, class];
    let name = (*cls).name().to_string_lossy().into_owned();
    // Same class, same one-shot moment: stop wry auto-granting camera/mic to
    // every site the pane renders. See `install_media_permission_patch`.
    install_media_permission_patch(cls);
    if (*cls).responds_to(objc2::sel!(webViewDidClose:)) {
        // wry implemented it upstream. Theirs wins; nothing to do.
        DONE.store(true, Ordering::Relaxed);
        trace("popup-close-patch", json!({ "installed": false, "why": "already implemented", "class": name }));
        return;
    }
    let imp: objc2::runtime::Imp = std::mem::transmute(
        web_view_did_close
            as extern "C-unwind" fn(*mut AnyObject, objc2::runtime::Sel, *mut AnyObject),
    );
    let ok = objc2::ffi::class_addMethod(
        cls as *mut AnyClass,
        objc2::sel!(webViewDidClose:),
        imp,
        c"v@:@".as_ptr(),
    );
    DONE.store(ok.as_bool(), Ordering::Relaxed);
    trace("popup-close-patch", json!({ "installed": ok.as_bool(), "class": name }));
}

// --- popup identity ---------------------------------------------------------
//
// An authentication window has to say whose it is. The user is about to type a
// password into a window Spike drew, and the only thing distinguishing the real
// provider from a page pretending to be one is the origin the window is actually
// showing. So the popup's title is ours, not the page's: hostname first, always,
// with the page's own title demoted to a suffix.
//
// The page is not trusted to name the window it lives in. A popup that sets
// `document.title = "accounts.google.com"` would otherwise be indistinguishable
// from one actually loaded from there, which is the entire trick. Keeping the
// real host in front, unconditionally, is what makes the suffix safe to show at
// all.

/// The host each popup is currently showing, so the title can be recomposed when
/// either half changes: the host on navigation (an OAuth chain walks across
/// several origins) and the page title whenever the document sets one.
fn popup_hosts() -> &'static Mutex<Vec<(String, String)>> {
    static H: OnceLock<Mutex<Vec<(String, String)>>> = OnceLock::new();
    H.get_or_init(|| Mutex::new(Vec::new()))
}

fn set_popup_host(label: &str, host: String) {
    let mut hosts = popup_hosts().lock().unwrap();
    match hosts.iter_mut().find(|(l, _)| l == label) {
        Some(entry) => entry.1 = host,
        None => hosts.push((label.to_string(), host)),
    }
}

fn popup_host(label: &str) -> String {
    popup_hosts()
        .lock()
        .unwrap()
        .iter()
        .find(|(l, _)| l == label)
        .map(|(_, h)| h.clone())
        .unwrap_or_default()
}

/// Compose a popup window title: security indication, then host, then the page's
/// own title. Pure, so the anti-spoofing rules are testable without a window.
///
/// - `insecure` prefixes "Not secure", because a credential form served over
///   plain http is the one thing a user must not miss.
/// - An empty host (rare: `about:`, opaque targets) reads as "Unknown site"
///   rather than silently leaving the window nameless.
/// - The page's title is truncated. Left unbounded, a long title pushes the host
///   out of the visible width of the titlebar, which is the same failure as not
///   showing the host at all. Newlines are stripped for the same reason.
fn popup_title(host: &str, insecure: bool, page_title: Option<&str>) -> String {
    const TITLE_CAP: usize = 48;
    let host = if host.is_empty() { "Unknown site" } else { host };
    let mut out = String::new();
    if insecure {
        out.push_str("Not secure · ");
    }
    out.push_str(host);
    let page = page_title.unwrap_or("").trim().replace(['\n', '\r', '\t'], " ");
    if !page.is_empty() && page != host {
        out.push_str(" · ");
        if page.chars().count() > TITLE_CAP {
            out.extend(page.chars().take(TITLE_CAP - 1));
            out.push('…');
        } else {
            out.push_str(&page);
        }
    }
    out
}

/// The new-window handler for a popup. A popup that opens another window (a
/// provider bouncing through a second consent screen) gets another popup, never
/// a pane navigation — once you are inside an auth flow, every hop needs to keep
/// its opener chain intact.
fn popup_new_window(
    app: AppHandle,
) -> impl Fn(tauri::Url, tauri::webview::NewWindowFeatures) -> NewWindowResponse<tauri::Wry>
       + Send
       + 'static {
    move |target, features| {
        let sized = features.size().is_some();
        trace(
            "popup-new-window",
            json!({ "url": target.as_str(), "sized": sized }),
        );
        if !is_allowed(&target) {
            let _ = crate::fs_ops::open_external(target.to_string());
            return NewWindowResponse::Deny;
        }
        match open_popup(&app, &target, features) {
            Some(window) => NewWindowResponse::Create { window },
            None => NewWindowResponse::Deny,
        }
    }
}

/// Build a real top-level window to service a `window.open`, and hand it back to
/// WebKit as the created webview so the popup gets a working `window.opener` and
/// the provider can `postMessage` its result home.
///
/// Two things make this work and are easy to get wrong:
///   - The popup MUST be built on the opener's `WKWebViewConfiguration`
///     (`with_webview_configuration`). That is what gives it the opener link and
///     the shared process pool; a popup on a fresh configuration renders but is
///     an unrelated window as far as the page is concerned.
///   - It starts at `about:blank`. WebKit itself drives the returned webview to
///     the requested URL as part of servicing the navigation action, so loading
///     the target ourselves would race it.
///
/// Size comes from the page's own window features (clamped to something sane —
/// a page can ask for a 4000px window), position does not: WKWindowFeatures
/// coordinates are screen-space and bottom-left origin, so honoring them lands
/// the window off screen as often as not. Centered over Spike is both safer and
/// what the plan's UX calls for.
///
/// UA is the honest Safari string, never the Chrome one the pane presents to
/// Google's apps: a Chrome UA on a WebKit engine is a mismatch that sign-in
/// treats as suspicious. It also means a popup opened from a Docs board changes
/// UA mid-flow — accepted deliberately, and recorded in the trace so the proof
/// can tell whether it ever mattered.
///
/// `window.close()` works via the runtime patch above (`install_window_close_patch`),
/// so a provider that self-closes its popup after posting the token does so.
fn open_popup(
    app: &AppHandle,
    url: &tauri::Url,
    features: tauri::webview::NewWindowFeatures,
) -> Option<tauri::WebviewWindow> {
    let n = POPUP_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let label = format!("{POPUP_PREFIX}{n}");
    let (w, h) = match features.size() {
        Some(s) => (s.width.clamp(320.0, 1400.0), s.height.clamp(320.0, 1000.0)),
        None => (480.0, 660.0),
    };
    // The window names itself after the origin it is showing, never after what
    // the page calls itself. See `popup_title`.
    let host = url.host_str().unwrap_or("").to_string();
    let insecure = url.scheme() == "http";
    set_popup_host(&label, host.clone());
    trace(
        "popup-open",
        json!({ "label": label, "url": url.as_str(), "host": host, "w": w, "h": h, "ua": "safari" }),
    );

    let nav_label = label.clone();
    let nav_app = app.clone();
    let title_label = label.clone();
    let blank: tauri::Url = "about:blank".parse().ok()?;
    #[allow(unused_mut)]
    let mut builder = tauri::WebviewWindowBuilder::new(app, &label, WebviewUrl::External(blank))
        .title(popup_title(&host, insecure, None))
        .inner_size(w, h)
        .center()
        .user_agent(SAFARI_UA)
        // Same security gate as the pane, plus the trace that makes a failed
        // login diagnosable. `about:` is the popup's own starting document, so
        // it has to pass; everything non-web hands off to macOS and is cancelled.
        //
        // Also where the window re-identifies itself: an OAuth chain walks
        // across origins (the provider, its account host, back to the relying
        // party), and a title left at the origin the popup STARTED on would be
        // actively misleading by the end of it.
        .on_navigation(move |target| {
            let ok = is_nav_allowed(target);
            trace(
                "popup-nav",
                json!({ "label": nav_label, "url": target.as_str(), "allowed": ok }),
            );
            if !ok {
                let _ = crate::fs_ops::open_external(target.to_string());
            }
            // Only a navigation we are actually letting through may rename the
            // window, and `about:` hops (the popup's own blank start document)
            // must not blank out the real host.
            if ok && target.scheme() != "about" {
                let host = target.host_str().unwrap_or("").to_string();
                if !host.is_empty() {
                    set_popup_host(&nav_label, host.clone());
                    if let Some(w) = nav_app.get_webview_window(&nav_label) {
                        let _ = w.set_title(&popup_title(&host, target.scheme() == "http", None));
                    }
                }
            }
            ok
        })
        // The page may contribute a suffix, never the whole title.
        .on_document_title_changed(move |win, title| {
            let host = popup_host(&title_label);
            let insecure = win
                .url()
                .map(|u| u.scheme() == "http")
                .unwrap_or(false);
            let _ = win.set_title(&popup_title(&host, insecure, Some(&title)));
        })
        .on_new_window(popup_new_window(app.clone()));
    #[cfg(target_os = "macos")]
    {
        builder = builder.with_webview_configuration(features.opener().target_configuration.clone());
    }

    let win = match builder.build() {
        Ok(w) => w,
        Err(e) => {
            trace("popup-failed", json!({ "label": label, "error": e.to_string() }));
            return None;
        }
    };
    popup_labels().lock().unwrap().push(label.clone());

    // Register this popup's WKWebView so `window.close()` can find it, and make
    // sure the patch that delivers `webViewDidClose:` is in place. Both are
    // no-ops off macOS. `ptr` is 0 if the platform handle was unavailable, in
    // which case the popup simply keeps the old manual-close behavior.
    #[allow(unused_mut, unused_assignments)]
    let mut ptr = 0usize;
    #[cfg(target_os = "macos")]
    {
        let seen = std::sync::Arc::new(AtomicUsize::new(0));
        let sink = seen.clone();
        let _ = win.with_webview(move |pw| {
            let inner = pw.inner() as *mut objc2::runtime::AnyObject;
            sink.store(inner as usize, Ordering::Relaxed);
            // Belt and braces: the pane normally installs this first (see
            // `live_webview_show`), but a popup opened from a popup has no pane
            // in its chain, so try here too. No-op once done.
            unsafe { install_window_close_patch(inner) };
        });
        ptr = seen.load(Ordering::Relaxed);
        if ptr != 0 {
            popup_webviews().lock().unwrap().push(ptr);
        }
        trace("popup-registered", json!({ "label": label, "closable": ptr != 0 }));
    }

    // A closed popup must hand focus back to the page that opened it — otherwise
    // the user is left looking at Spike with nothing focused, mid-flow.
    let ev_app = app.clone();
    let ev_label = label.clone();
    win.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            trace("popup-closed", json!({ "label": ev_label }));
            popup_labels().lock().unwrap().retain(|l| l != &ev_label);
            popup_hosts().lock().unwrap().retain(|(l, _)| l != &ev_label);
            #[cfg(target_os = "macos")]
            if ptr != 0 {
                popup_webviews().lock().unwrap().retain(|p| *p != ptr);
            }
            if let Some(main) = ev_app.get_window("main") {
                let _ = main.set_focus();
            }
            if let Some(wv) = ev_app.get_webview(LIVE_LABEL) {
                if *current_visible().lock().unwrap() {
                    make_child_first_responder(&wv);
                }
            }
        }
    });
    Some(win)
}

/// Create-or-reuse the child webview, point it at `url` (navigating only on a
/// real change), move/size it to the pane rect (logical px = the page's CSS px,
/// which Tauri scales to device px), and show it. Idempotent: the page calls
/// this on every sync tick.
///
/// `focus` is the page's answer to "is it safe to take keyboard focus?". Showing
/// the board makes it first responder (the hover-cursor workaround above), which
/// blurs whatever the DOM had focused. That is normally harmless — but the board
/// is HIDDEN while any overlay is up and re-shown the moment it closes, and
/// closing a menu is exactly how some DOM text edits START. The tab context
/// menu's Rename creates its inline input as the menu closes; the re-show then
/// stole first responder, the input blurred, and its blur handler committed and
/// tore the edit down before a key could land — "Rename does nothing", but only
/// while a board was on screen. So the page passes `focus: false` whenever a real
/// DOM text edit holds focus, and we leave it alone.
#[tauri::command]
pub fn live_webview_show(
    app: AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    focus: bool,
) -> Result<(), String> {
    let parsed: tauri::Url = url.parse().map_err(|e| format!("bad url: {e}"))?;
    if !is_allowed(&parsed) {
        return Err("live preview accepts http(s) or local-preview URLs only".into());
    }
    // One-time: arm the Escape-exits-full-screen key monitor (no-op after first).
    install_esc_monitor(&app);
    // Round to whole logical px: the page passes fractional CSS px from
    // getBoundingClientRect, whose low bits jitter across reflows and would
    // otherwise nudge the native view a pixel every frame.
    let rect = (
        x.round() as i32,
        y.round() as i32,
        width.max(1.0).round() as i32,
        height.max(1.0).round() as i32,
    );
    let pos = LogicalPosition::new(rect.0 as f64, rect.1 as f64);
    let size = LogicalSize::new(rect.2 as f64, rect.3 as f64);

    if let Some(wv) = app.get_webview(LIVE_LABEL) {
        // Navigate ONLY on a genuinely new target. Compare against BOTH:
        //  - the webview's ACTUAL main-frame URL (`wv.url()`): so a page that
        //    navigated itself (a clicked link, a redirect) or — crucially — an
        //    iframe/subframe load (Gmail's ogs.google.com widget) is NOT mistaken
        //    for a stale target we must reload. `wv.url()` is main-frame only, so
        //    subframe churn never matches and never provokes a re-navigation.
        //  - the last URL WE requested (`current_url`): so the many reposition
        //    calls fired during an in-flight load (where `wv.url()` is still the
        //    old page) don't re-issue the same navigation over and over.
        let mut cur = current_url().lock().unwrap();
        let actual = wv.url().ok().map(|u| u.to_string());
        let is_new =
            actual.as_deref() != Some(url.as_str()) && cur.as_deref() != Some(url.as_str());
        if is_new {
            // Present a host-appropriate UA on this load (Safari by default, Chrome
            // for Google's own apps) — see ua_for_url. Set before navigate so the
            // load picks it up.
            set_child_ua(&wv, ua_for_url(&parsed));
            wv.navigate(parsed).map_err(|e| e.to_string())?;
            *cur = Some(url);
        }
        // Only touch geometry when it actually moved — see current_rect(). A no-op
        // re-place would re-composite the native view and drop clicks mid-frame.
        let mut cr = current_rect().lock().unwrap();
        let repositioned = *cr != Some(rect);
        if repositioned {
            let _ = wv.set_position(pos);
            let _ = wv.set_size(size);
            *cr = Some(rect);
        }
        // Show only on a real hidden→visible transition; a redundant show()
        // re-composites the view under the cursor and flickers hover. See
        // current_visible().
        let _ = repositioned;
        let mut vis = current_visible().lock().unwrap();
        let became_visible = !*vis;
        if became_visible {
            let _ = wv.show();
            *vis = true;
        }
        // Hover cursor updates (pointer over links) only work reliably when the
        // child webview holds first-responder — wry #175: a WKWebView that isn't
        // focused won't track the cursor and it flickers. Re-assert it each time
        // the board becomes visible — unless the page is mid-edit (`focus`), in
        // which case we defer the grab to the next show that says it's safe.
        let mut owed = focus_owed().lock().unwrap();
        if became_visible || *owed {
            if focus {
                make_child_first_responder(&wv);
                *owed = false;
            } else {
                *owed = true;
            }
        }
        return Ok(());
    }

    // First show: add the child to the main window, wiring the navigation and
    // new-window handlers that turn a bare webview into a browsable pane.
    let window = app.get_window("main").ok_or("main window not found")?;
    let open_app = app.clone();
    // Compute the UA before `parsed` is moved into the builder.
    let initial_ua = ua_for_url(&parsed);
    let builder = WebviewBuilder::new(LIVE_LABEL, WebviewUrl::External(parsed))
        // Host-appropriate UA (Safari by default — the honest engine identity, and
        // broadly supported; Chrome only for Google's own apps). See ua_for_url.
        // Reused loads re-set it at runtime via set_child_ua.
        .user_agent(initial_ua)
        // Fires on every real navigation (link click, redirect, address-bar
        // submit). Returning false cancels it in-engine — our gate against a
        // page trying to walk the child into `file:`/privileged origins. On an
        // allowed nav we update the tracked URL (so the next reposition `show()`
        // doesn't re-navigate to a URL the user reached by clicking) and emit
        // `live-nav` so the page's address bar / tab name track the real URL.
        // SECURITY GATE ONLY. wry fires this for EVERY navigation — including
        // iframes/subframes — and gives us no frame info, so its URL must NOT
        // drive the address bar or the nav guard: a Gmail widget subframe
        // (ogs.google.com) would otherwise flip the address bar and trigger a
        // spurious main-frame reload. The address bar tracks reality through the
        // main-frame-only URL poll (`live_webview_url`) instead.
        .on_navigation(move |target| {
            let ok = is_nav_allowed(target);
            // Traced for the login post-mortem (see `trace`). wry gives no frame
            // info here, so this is every frame's navigation, not just the main
            // one — noisy on purpose, since the hop that turns is often a frame.
            trace(
                "pane-nav",
                json!({ "url": target.as_str(), "allowed": ok }),
            );
            ok
        })
        // What the page asked to open in a new window. Routed by
        // `classify_new_window`: a sized `window.open` gets a real popup window
        // (with a working `window.opener`, which authentication depends on), a
        // plain `_blank` becomes an in-pane navigation via `live-open` (Drive and
        // Docs open documents that way and the user wants them in the pane), and
        // anything non-web hands off to macOS. A popup we fail to build falls
        // back to the pane rather than swallowing the click.
        .on_new_window(move |target, features| {
            let sized = features.size().is_some();
            let kind = classify_new_window(&target, sized);
            trace(
                "pane-new-window",
                json!({ "url": target.as_str(), "sized": sized, "kind": format!("{kind:?}") }),
            );
            match kind {
                OpenKind::Popup => {
                    if let Some(window) = open_popup(&open_app, &target, features) {
                        return NewWindowResponse::Create { window };
                    }
                    let _ = open_app.emit("live-open", LiveNav { url: target.to_string() });
                }
                OpenKind::Board => {
                    let _ = open_app.emit("live-open", LiveNav { url: target.to_string() });
                }
                OpenKind::External => {
                    let _ = crate::fs_ops::open_external(target.to_string());
                }
            }
            NewWindowResponse::Deny
        });
    let wv = window
        .add_child(builder, pos, size)
        .map_err(|e| format!("add_child: {e}"))?;
    // Patch wry's UI delegate class now, while this pane's delegate is the only
    // one that exists. WebKit fixes which optional WKUIDelegate methods it will
    // call when a delegate is attached, so `webViewDidClose:` has to be on the
    // class before any popup delegate is attached, not after. See
    // `install_window_close_patch`.
    #[cfg(target_os = "macos")]
    let _ = wv.with_webview(|pw| unsafe {
        install_window_close_patch(pw.inner() as *mut objc2::runtime::AnyObject)
    });
    let _ = wv.show();
    if focus {
        make_child_first_responder(&wv);
    } else {
        *focus_owed().lock().unwrap() = true;
    }
    *current_url().lock().unwrap() = Some(url);
    *current_rect().lock().unwrap() = Some(rect);
    *current_visible().lock().unwrap() = true;
    Ok(())
}

/// History navigation for the in-pane browser. Tauri 2.11 exposes no native
/// back/forward/reload on `Webview`, so we drive the page's own history via JS.
/// These are no-ops at the ends of history (harmless), so the page's
/// back/forward button enable-state is a pure affordance, never a correctness
/// gate. No-op if the webview was never created.
#[tauri::command]
pub fn live_webview_back(app: AppHandle) -> Result<(), String> {
    if let Some(wv) = app.get_webview(LIVE_LABEL) {
        wv.eval("history.back()").map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn live_webview_forward(app: AppHandle) -> Result<(), String> {
    if let Some(wv) = app.get_webview(LIVE_LABEL) {
        wv.eval("history.forward()").map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn live_webview_reload(app: AppHandle) -> Result<(), String> {
    if let Some(wv) = app.get_webview(LIVE_LABEL) {
        wv.eval("location.reload()").map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Open the in-pane browser board's Web Inspector. DEV-ONLY BY DESIGN: Tauri's
/// `open_devtools` is compiled out of release builds because the `devtools`
/// feature is deliberately off (see Cargo.toml — the public bundle must never
/// ship the inspector + IPC surface to end users). So in release this is a
/// no-op; in `tauri dev`, where the WebKit inspector is auto-on, it pops the
/// inspector for the child webview. No-op if the webview doesn't exist yet.
#[tauri::command]
pub fn live_webview_devtools(app: AppHandle) -> Result<(), String> {
    #[cfg(debug_assertions)]
    if let Some(wv) = app.get_webview(LIVE_LABEL) {
        wv.open_devtools();
    }
    let _ = &app; // release: `app` is otherwise unused with the cfg'd block gone
    Ok(())
}

/// The child webview's current URL. `on_navigation` only fires on real document
/// loads, so it misses SPA pushState route changes and can leave the address bar
/// stale after a redirect/blocked nav bounces the page elsewhere. The page polls
/// this while a board is on screen to keep the address bar matched to reality.
/// `wv.url()` reflects the live `location`, including history-API changes. None
/// if the webview doesn't exist yet.
#[tauri::command]
pub fn live_webview_url(app: AppHandle) -> Option<String> {
    app.get_webview(LIVE_LABEL)
        .and_then(|wv| wv.url().ok())
        .map(|u| u.to_string())
}

// --- Google sign-in window ------------------------------------------------
//
// Google refuses interactive sign-in inside an EMBEDDED webview: the pane child
// hitting accounts.google.com/…/signin is bounced to /signin/rejected ("this
// browser or app may not be secure"). That block protects users from a host app
// reading credentials out of a webview it embeds — it is NOT a rendering bug and
// NOT UA-driven, so we do not try to defeat it. Instead we relocate the one-time
// sign-in to a REAL top-level OS window (not a child pinned over the pane),
// presenting the honest Safari UA. Every WKWebView in the process shares the
// default persistent data store — the same cookie jar the pane reads (see
// ~/Library/HTTPStorages/…binarycookies) — so a sign-in completed here lands the
// Google session cookies where the pane's docs.google.com board picks them up on
// its next load. No signal-hiding, no detection patching: if Google blocks a
// top-level WebKit window too, that is a hard wall and the answer is the Google
// API, not disguise.

/// Where to send the pane once sign-in completes (the `continue=` target Docs was
/// bounced away from). Set by `google_signin_show`, read on completion.
fn signin_return_url() -> &'static Mutex<Option<String>> {
    static U: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    U.get_or_init(|| Mutex::new(None))
}

/// Completion signal: the sign-in window has navigated off the sign-in host
/// (accounts.google.com) to the destination the flow was headed for.
/// `expect_host` is the `continue=` target's host when known, so an ancillary
/// subframe hop can't read as done; without it, any google.com product host
/// counts.
///
/// Two shapes reach here, and they end in different places:
///
///   • FIRST-PARTY (what this was built for). A Docs/Drive load bounced to
///     sign-in carries `continue=https://docs.google.com/…`, so the flow ends on
///     a named google.com host and `expect_host` matches it exactly.
///
///   • THIRD-PARTY ("sign in to GitHub with Google"). The `continue=` target of
///     an OAuth authorize flow is ITSELF on accounts.google.com, so expect_host
///     comes back as the sign-in host — a value that could never match, because
///     the first arm returns false for accounts.google.com. The flow instead
///     ends on the relying party's own host (github.com), which we cannot name
///     in advance. Landing on a NON-google host is the signal there.
///
///     Deliberately narrow: "not a google.com host" rather than "anywhere off
///     accounts.google.com", because a sign-in can hop through other Google
///     hosts (challenges, consent interstitials) on the way, and reading one of
///     those as done would close the window mid-flow.
fn is_signed_in_dest(url: &tauri::Url, expect_host: Option<&str>) -> bool {
    let h = match url.host_str() {
        Some(h) => h.to_ascii_lowercase(),
        None => return false,
    };
    if h == "accounts.google.com" {
        return false; // still on the sign-in / consent flow
    }
    let is_google = h == "google.com" || h.ends_with(".google.com");
    match expect_host {
        Some(want) if want.eq_ignore_ascii_case("accounts.google.com") => !is_google,
        Some(want) => h == want.to_ascii_lowercase(),
        None => is_google,
    }
}

/// Open (or focus) the top-level Google sign-in window at `url` (an
/// accounts.google.com sign-in URL). `return_url` is where the pane should go
/// once auth completes — normally the `continue=` target Docs was bounced from.
/// On completion we emit `google-signin-done` with that URL; the page closes this
/// window and points the pane at it, now authenticated against the shared jar.
#[tauri::command]
pub fn google_signin_show(
    app: AppHandle,
    url: String,
    return_url: Option<String>,
) -> Result<(), String> {
    let parsed: tauri::Url = url.parse().map_err(|e| format!("bad url: {e}"))?;
    // This window only ever points at Google's sign-in host — never an arbitrary
    // origin, and never Spike's own privileged hosts.
    match parsed.host_str() {
        Some(h) if h.eq_ignore_ascii_case("accounts.google.com") => {}
        _ => return Err("google sign-in window accepts accounts.google.com only".into()),
    }
    let expect_host = return_url
        .as_deref()
        .and_then(|u| u.parse::<tauri::Url>().ok())
        .and_then(|u| u.host_str().map(|s| s.to_string()));
    *signin_return_url().lock().unwrap() = return_url.clone();

    // Reuse the window if it's already open (re-trigger just re-navigates/focuses).
    if let Some(win) = app.get_webview_window(SIGNIN_LABEL) {
        let _ = win.navigate(parsed);
        let _ = win.set_focus();
        return Ok(());
    }

    let done_app = app.clone();
    tauri::WebviewWindowBuilder::new(&app, SIGNIN_LABEL, WebviewUrl::External(parsed))
        .title("Sign in to Google")
        .inner_size(480.0, 660.0)
        .center()
        // Honest engine identity. The Chrome UA the pane uses for crisp Docs is a
        // WebKit-on-Chrome-string mismatch that reads as suspicious to Google's
        // sign-in; Safari is what this engine actually is.
        .user_agent(SAFARI_UA)
        // Watch for auth completing (redirect off accounts.google.com to the
        // continue target). No IPC bridge is injected here (no capability matches
        // this window), so page JS can't reach Spike — this closure is our only
        // read of the window, and it observes URLs only.
        .on_navigation(move |target| {
            let expect = signin_return_url()
                .lock()
                .unwrap()
                .as_deref()
                .and_then(|u| u.parse::<tauri::Url>().ok())
                .and_then(|u| u.host_str().map(|s| s.to_string()));
            trace(
                "signin-nav",
                json!({ "url": target.as_str(), "expect": expect }),
            );
            if is_signed_in_dest(target, expect.as_deref()) {
                let dest = signin_return_url()
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or_else(|| target.to_string());
                let _ = done_app.emit("google-signin-done", LiveNav { url: dest });
            }
            true
        })
        .build()
        .map_err(|e| format!("signin window: {e}"))?;

    // The window can also go away WITHOUT completing — the user closes it, or
    // gives up half way. Nothing signalled that before, so the pane stayed held
    // behind its "finishing sign-in" placeholder with no way back. Emit on
    // destroy; the page ignores it when the hold is already released (the
    // ordinary post-success close destroys this window too).
    if let Some(win) = app.get_webview_window(SIGNIN_LABEL) {
        let gone_app = app.clone();
        win.on_window_event(move |ev| {
            if matches!(ev, tauri::WindowEvent::Destroyed) {
                let _ = gone_app.emit("google-signin-cancelled", ());
            }
        });
    }

    let _ = expect_host; // computed for clarity; the closure re-reads it live
    Ok(())
}

/// Close the Google sign-in window if it's open. No-op otherwise.
#[tauri::command]
pub fn google_signin_close(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(SIGNIN_LABEL) {
        win.close().map_err(|e| e.to_string())?;
    }
    *signin_return_url().lock().unwrap() = None;
    Ok(())
}

/// Hide the live webview without destroying it (an overlay opened, the board tab
/// lost focus, the pane went off screen). Cheap to re-show, and the page keeps
/// its state. No-op if it was never created.
#[tauri::command]
pub fn live_webview_hide(app: AppHandle) -> Result<(), String> {
    // Hide only on a real visible→hidden transition; the page calls this every
    // sync tick while occluded, and a redundant hide() is the same needless
    // re-composite as a redundant show(). See current_visible().
    let mut vis = current_visible().lock().unwrap();
    if *vis {
        if let Some(wv) = app.get_webview(LIVE_LABEL) {
            let _ = wv.hide();
        }
        *vis = false;
        // A hidden board owes nothing: the next show is itself a hidden→visible
        // transition and re-asserts first responder on its own terms.
        *focus_owed().lock().unwrap() = false;
    }
    Ok(())
}

/// Destroy the live webview (its board tab or pane is gone for good). Popups it
/// opened go with it — an auth window whose opener no longer exists can't
/// complete anything, and left alone it's an orphaned window with no way back.
#[tauri::command]
pub fn live_webview_close(app: AppHandle) -> Result<(), String> {
    close_all_popups(&app);
    if let Some(wv) = app.get_webview(LIVE_LABEL) {
        let _ = wv.close();
    }
    *current_url().lock().unwrap() = None;
    // A future board is a fresh view — don't let a stale rect suppress its first
    // placement (a new webview starts at wherever add_child put it).
    *current_rect().lock().unwrap() = None;
    *current_visible().lock().unwrap() = false;
    *focus_owed().lock().unwrap() = false;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> tauri::Url {
        s.parse().unwrap()
    }

    #[test]
    fn signin_completes_for_first_party_and_third_party_flows() {
        // FIRST-PARTY: a Docs load bounced to sign-in carries a docs.google.com
        // continue target. Only that host ends the flow.
        let docs = Some("docs.google.com");
        assert!(is_signed_in_dest(&url("https://docs.google.com/document/d/abc"), docs));
        assert!(!is_signed_in_dest(&url("https://accounts.google.com/v3/signin"), docs));
        assert!(!is_signed_in_dest(&url("https://drive.google.com/drive/my-drive"), docs));

        // THIRD-PARTY ("sign in to GitHub with Google"): the continue target is
        // itself on the sign-in host, so the flow ends somewhere we can't name
        // in advance. Landing off Google is what counts. This is the case that
        // could never fire before: expect_host == accounts.google.com matched
        // nothing, because the accounts.google.com arm returns false first.
        let oauth = Some("accounts.google.com");
        assert!(is_signed_in_dest(&url("https://github.com/settings/profile"), oauth));
        assert!(!is_signed_in_dest(&url("https://accounts.google.com/signin/oauth/consent"), oauth));
        // ...but a hop through another Google host mid-flow is NOT done. Reading
        // one of these as completion would close the window before the user is
        // through it.
        assert!(!is_signed_in_dest(&url("https://myaccount.google.com/interstitial"), oauth));
        assert!(!is_signed_in_dest(&url("https://www.google.com/"), oauth));

        // NO continue target: any google.com product host counts, nothing else.
        assert!(is_signed_in_dest(&url("https://mail.google.com/mail/u/0"), None));
        assert!(is_signed_in_dest(&url("https://google.com/"), None));
        assert!(!is_signed_in_dest(&url("https://github.com/"), None));
        assert!(!is_signed_in_dest(&url("https://accounts.google.com/x"), None));

        // Host casing is not a way to slip past either arm.
        assert!(!is_signed_in_dest(&url("https://ACCOUNTS.google.com/v3/signin"), docs));
        assert!(is_signed_in_dest(&url("https://DOCS.google.com/document/d/abc"), docs));
    }

    #[test]
    fn http_gate_allows_public_hosts_blocks_privileged() {
        // The in-pane browser renders arbitrary public http(s) sites.
        assert!(is_http(&url("https://www.conductor.build/")));
        assert!(is_http(&url("http://localhost:4317")));
        assert!(is_http(&url("http://127.0.0.1:3000/x")));
        assert!(is_http(&url("https://example.com/path?q=1")));
        assert!(is_http(&url("http://192.168.1.5:3000"))); // LAN now allowed
        // Non-http schemes are refused outright.
        assert!(!is_http(&url("file:///etc/passwd")));
        assert!(!is_http(&url("ftp://localhost")));
        assert!(!is_http(&url("tauri://localhost")));
        // Spike's own privileged hosts stay off-limits even over http(s).
        assert!(!is_http(&url("http://ipc.localhost")));
        assert!(!is_http(&url("https://tauri.localhost")));
        assert!(!is_http(&url("http://asset.localhost/icon.png")));
    }

    #[test]
    fn local_preview_scheme_allowed_but_not_treated_as_http() {
        // The HTML-preview scheme is a valid child target (browser mode for a
        // local file) but is NOT http — is_allowed accepts it, is_http rejects it.
        let spikehtml = url("spikehtml://localhost/abc123/");
        assert!(is_local_preview(&spikehtml));
        assert!(is_allowed(&spikehtml));
        assert!(!is_http(&spikehtml));
        // Windows form is plain http to the reserved preview host.
        let win = url("http://spikehtml.localhost/abc123/");
        assert!(is_local_preview(&win));
        assert!(is_allowed(&win));
        // Privileged app origins never qualify as a local preview.
        assert!(!is_local_preview(&url("tauri://localhost/index.html")));
        assert!(!is_local_preview(&url("http://ipc.localhost")));
        assert!(!is_allowed(&url("file:///etc/passwd")));
    }

    #[test]
    fn popup_title_always_leads_with_the_real_host() {
        // The host comes first and the page's title is only ever a suffix. A page
        // that names itself after another origin cannot occupy the position a
        // user reads as "this is who I am talking to".
        let spoof = popup_title("evil.example", false, Some("accounts.google.com"));
        assert!(spoof.starts_with("evil.example"), "got {spoof:?}");
        assert!(spoof.contains("accounts.google.com")); // shown, but demoted
        // Plain http says so, because this is where credentials get typed.
        assert!(popup_title("shop.example", true, None).starts_with("Not secure · "));
        assert!(!popup_title("shop.example", false, None).contains("Not secure"));
        // A nameless window is worse than an honest "Unknown site".
        assert_eq!(popup_title("", false, None), "Unknown site");
        // No redundant "host · host" when the page titles itself after its origin.
        assert_eq!(popup_title("ok.example", false, Some("ok.example")), "ok.example");
        assert_eq!(popup_title("ok.example", false, Some("   ")), "ok.example");
    }

    #[test]
    fn popup_title_caps_page_titles_so_they_cannot_push_the_host_out() {
        // An unbounded title scrolls the host out of the visible titlebar, which
        // fails exactly as badly as never showing the host.
        let long = "x".repeat(500);
        let t = popup_title("bank.example", false, Some(&long));
        assert!(t.starts_with("bank.example · "));
        assert!(t.chars().count() < 80, "title not capped: {} chars", t.chars().count());
        assert!(t.ends_with('…'));
        // Newlines can't be used to hide the host on a second line either.
        let sneaky = popup_title("bank.example", false, Some("safe\n\n\nbank.example"));
        assert!(!sneaky.contains('\n'));
    }

    #[test]
    fn nav_gate_allows_about_blank_the_show_gate_does_not() {
        // Pages build subframes as about:blank and write into them; cancelling
        // that kills the frame silently (eight on a single page load, which is
        // how this was found). Safe: about:blank inherits its creator's origin,
        // and in this webview the creator is always a remote page.
        let blank = url("about:blank");
        assert!(is_nav_allowed(&blank));
        assert!(!is_allowed(&blank)); // …but never a target the page may ASK us to open
        // Everything the nav gate rejected before, it still rejects.
        for bad in ["file:///etc/passwd", "tauri://localhost", "http://ipc.localhost"] {
            assert!(!is_nav_allowed(&url(bad)), "{bad} must stay blocked");
        }
        assert!(is_nav_allowed(&url("https://example.com/feed/")));
    }

    #[test]
    fn nav_gate_allows_the_other_in_document_schemes() {
        // Same cancellation, same blank frame: `<iframe srcdoc>` commits as
        // about:srcdoc, and preview panes hand frames a blob:/data: document.
        // Sonar's page grid is srcdoc — every thumbnail painted empty.
        for u in ["about:srcdoc", "data:text/html,<b>hi</b>"] {
            assert!(is_nav_allowed(&url(u)), "nav gate must allow {u}");
        }
        // blob: rides on the origin that created it — allowed only if that
        // origin is one the child may hold in the first place.
        assert!(is_nav_allowed(&url("blob:https://example.com/abc-123")));
        assert!(is_nav_allowed(&url("blob:spikehtml://localhost/abc-123")));
        for bad in ["blob:tauri://localhost/abc-123", "blob:file:///etc/passwd"] {
            assert!(!is_nav_allowed(&url(bad)), "{bad} must stay blocked");
        }
        // None of them are things the page may ASK us to open.
        for u in ["data:text/html,x", "blob:https://example.com/a"] {
            assert!(!is_allowed(&url(u)), "show gate must not accept {u}");
        }
    }

    #[test]
    fn sized_window_open_is_a_popup_bare_blank_stays_in_pane() {
        // Routing reads the window features and NEVER the host. The same URL
        // routes two ways depending only on whether the page passed a size, so
        // there is nothing here for a site to be special-cased by.
        let same = url("https://example.com/a/b");
        // Sized — what every OAuth/consent popup does. Needs a real window so
        // `window.opener` survives and the provider can hand the result back.
        assert_eq!(classify_new_window(&same, true), OpenKind::Popup);
        // Unsized (a plain target=_blank link) keeps the single-board model:
        // documents opened that way land in the pane, not a second window.
        assert_eq!(classify_new_window(&same, false), OpenKind::Board);
        // An identity provider is not distinguishable from anything else here.
        assert_eq!(
            classify_new_window(&url("https://idp.example.net/o/oauth2/auth"), true),
            OpenKind::Popup
        );
    }

    #[test]
    fn non_web_targets_go_to_macos_however_they_were_opened() {
        // Scheme decides before size does — a sized window.open at a non-web URL
        // is still the OS's business, and a privileged origin is never either.
        for sized in [true, false] {
            assert_eq!(
                classify_new_window(&url("mailto:someone@example.com"), sized),
                OpenKind::External
            );
            assert_eq!(
                classify_new_window(&url("file:///etc/passwd"), sized),
                OpenKind::External
            );
            assert_eq!(
                classify_new_window(&url("http://ipc.localhost/cmd"), sized),
                OpenKind::External
            );
        }
    }
}
