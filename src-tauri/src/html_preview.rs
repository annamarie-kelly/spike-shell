// html_preview.rs — serves a local HTML file's own content back to the preview
// iframe over a private `spikehtml://` URI scheme, so the previewed page runs as
// its OWN document instead of an `<iframe srcdoc>`.
//
// Why this exists: a `srcdoc` document inherits the embedder's Content-Security-
// Policy. The app's CSP (tauri.conf.json) is `script-src 'self' 'sha256-…'` with
// NO `'unsafe-inline'` — deliberately strict, because the main webview holds the
// IPC bridge to the shell. A srcdoc HTML preview inherits that policy, so every
// inline `<script>` (and every CDN `<script src>`) in the previewed file is
// silently blocked and interactive docs (slide decks, demos) render dead. A doc
// reached by a REAL navigation to a scheme we serve does not inherit the app CSP
// and we attach none, so its inline JS runs. The preview iframe stays sandboxed
// WITHOUT `allow-same-origin`, so it's still an opaque origin walled off from the
// app — this changes what CSP the frame sees, not what it can reach.
//
// The frontend hands us the exact bytes to serve (the file text, possibly with
// unsaved editor edits, plus the SPIKE_BRIDGE find/zoom/nav script it already
// appends), keyed by an unguessable token. We never read the main document off
// disk — so this scheme cannot be turned into an arbitrary-file reader. The one
// disk touch is sibling assets: a relative `img.png`/`style.css` the page
// references resolves to `spikehtml://localhost/<token>/img.png`, which we serve
// from the previewed file's OWN directory only, canonicalized and traversal-
// guarded so a `../../etc/passwd` can never escape that directory.

use std::collections::HashMap;
use std::hash::{BuildHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use tauri::http::{Request, Response};

/// One registered preview: the bytes to serve as the main document, and the
/// directory its relative assets are scoped to.
struct Preview {
    dir: PathBuf,
    body: Vec<u8>,
}

/// Token -> preview, plus insertion order so the store stays bounded. Previews
/// are small but a body can be ~2 MB (read_file's cap), so we evict the oldest
/// past MAX rather than grow without limit. An evicted token that's still shown
/// somewhere 404s on its next reload — acceptable for a preview surface.
#[derive(Default)]
struct Store {
    map: HashMap<String, Preview>,
    order: Vec<String>,
}

const MAX: usize = 24;

fn store() -> &'static Mutex<Store> {
    static S: OnceLock<Mutex<Store>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Store::default()))
}

/// Non-enumerable token. RandomState is seeded from the OS RNG once per process,
/// so tokens can't be walked (p1, p2, …) by one previewed page to read another
/// preview's directory. Kept stable for the process so the hash is deterministic
/// within a run.
fn token_for(seq: u64, dir: &Path) -> String {
    static RS: OnceLock<std::collections::hash_map::RandomState> = OnceLock::new();
    let rs = RS.get_or_init(std::collections::hash_map::RandomState::new);
    let mut h = rs.build_hasher();
    seq.hash(&mut h);
    dir.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// The URL the iframe navigates to. macOS/Linux (WebKit/WebKitGTK) serve custom
/// schemes at `scheme://localhost/…`; Windows (WebView2) at `http://scheme.
/// localhost/…`. The trailing slash makes the token the base so a relative
/// `img.png` resolves to `…/<token>/img.png`.
fn preview_url(token: &str) -> String {
    #[cfg(windows)]
    {
        format!("http://spikehtml.localhost/{token}/")
    }
    #[cfg(not(windows))]
    {
        format!("spikehtml://localhost/{token}/")
    }
}

/// Register `content` (the file text + SPIKE_BRIDGE, assembled by the frontend)
/// as the document to serve for `path`, and return the URL to point the iframe
/// at. Relative assets resolve against `path`'s parent directory.
#[tauri::command]
pub fn html_preview_register(path: String, content: String) -> Result<String, String> {
    static SEQ: AtomicU64 = AtomicU64::new(1);

    let p = Path::new(&path);
    let dir = p
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("/"));
    // Canonicalize so the traversal guard compares real paths (no symlink or
    // `.`/`..` surprises). Fall back to the lexical dir if it can't resolve.
    let dir = std::fs::canonicalize(&dir).unwrap_or(dir);

    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let token = token_for(seq, &dir);

    let mut s = store().lock().unwrap();
    s.map.insert(
        token.clone(),
        Preview {
            dir,
            body: content.into_bytes(),
        },
    );
    s.order.push(token.clone());
    while s.order.len() > MAX {
        let old = s.order.remove(0);
        s.map.remove(&old);
    }

    Ok(preview_url(&token))
}

/// The `spikehtml://` handler. Path is `/<token>/<relpath>`: empty relpath ->
/// the registered document; otherwise a sibling asset served from the preview's
/// own directory, traversal-guarded.
pub fn handle(request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let path = request.uri().path();
    let trimmed = path.trim_start_matches('/');
    let (token, rel) = match trimmed.split_once('/') {
        Some((t, r)) => (t, r),
        None => (trimmed, ""),
    };

    let guard = store().lock().unwrap();
    let Some(prev) = guard.map.get(token) else {
        return not_found();
    };

    // Main document: serve the exact registered bytes, no CSP attached.
    if rel.is_empty() {
        return ok(prev.body.clone(), "text/html; charset=utf-8");
    }

    // Sibling asset: resolve inside the preview's directory only.
    let rel = pct_decode(rel);
    let target = prev.dir.join(rel);
    let Ok(canon) = std::fs::canonicalize(&target) else {
        return not_found();
    };
    if !canon.starts_with(&prev.dir) {
        return not_found(); // `../` escape blocked
    }
    match std::fs::read(&canon) {
        Ok(bytes) => {
            let ct = content_type(&canon);
            ok(bytes, ct)
        }
        Err(_) => not_found(),
    }
}

fn ok(body: Vec<u8>, content_type: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(200)
        .header("Content-Type", content_type)
        // Reloads ("back") must re-fetch: the token may have been re-registered
        // with fresh (edited) content.
        .header("Cache-Control", "no-store")
        .body(body)
        .unwrap()
}

fn not_found() -> Response<Vec<u8>> {
    Response::builder()
        .status(404)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(b"not found".to_vec())
        .unwrap()
}

/// Minimal extension -> content-type for the sibling assets a page pulls in.
/// Unknown types fall back to octet-stream (the browser sniffs where it can).
fn content_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// Decode `%XX` escapes in a URL path segment (filenames with spaces etc.).
/// Anything malformed is left as-is.
fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(hi), Some(lo)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}
