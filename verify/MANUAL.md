# Manual verification: the in-pane browser

`npm run verify:web` drives the real frontend in headless Chrome. It cannot touch anything in this file. The in-pane browser is a **native WKWebView**, outside the DOM, rendered out of process, and popups are real OS windows. No headless harness reaches any of it. Hence a written suite.

Everything below was learned by getting it wrong first. The traps section is not padding: each entry cost at least one full test cycle.

---

## 0. Preflight: are you testing what you think you are?

Four separate times during Phase 0 we tested against a binary that did not contain the change. Do this first, every time.

```sh
echo "port=$SPIKE_PORT  cli=$(command -v spike)"
```

- **`port=`** identifies which Spike instance this terminal belongs to. Each Spike injects its own `SPIKE_PORT` and `SPIKE_TOKEN` into terminals it spawns. `spike` talks to `SPIKE_PORT`, so a terminal in window A can never drive window B. The token is per-process random, so `SPIKE_PORT=other spike …` returns `forbidden` by design.
- **`cli=`** identifies which CLI binary you have. **The CLI is a separate binary from the app.** `tauri dev` rebuilds the app and not the CLI, so a new subcommand can be missing from a build that otherwise has your change. A dev build resolves its repo root from `CARGO_MANIFEST_DIR` and puts `<repo>/bin` first on PATH; an installed app uses its own `Contents/Resources/bin`.

If more than one Spike is running:

```sh
lsof -nP -iTCP -sTCP:LISTEN | awk '$1=="Spike"{print $2,$9}'
ps -eo pid,etime,command | grep -E "MacOS/Spike|target/debug/Spike"
```

**Installing a test build:** never `rm -rf /Applications/Spike.app` while a Spike is running. Deleting a live bundle can crash it when it next lazily loads a resource, taking the session and any agents with it. Install alongside, under a **space-free** name, and launch with `open -n`:

```sh
ditto src-tauri/target/release/bundle/macos/Spike.app /Applications/SpikeDev.app
open -n /Applications/SpikeDev.app
```

Space-free matters: `shims/claude` writes its own path into `~/.claude/settings.json` as a shell string. A path with a space used to break every hook, globally, in sessions belonging to a *different* Spike. Fixed by quoting, but the two-install hook flip remains: whichever Spike launched last owns the hook path for every Claude session on the machine.

---

## 1. Reading the trace

Every pane, popup and sign-in navigation appends one JSON line to `~/.spike/logs/browser-trace-<day>.jsonl`. On in dev builds; in release only with `SPIKE_BROWSER_TRACE=1`, because it records every URL the browser touches.

```sh
T=~/.spike/logs/browser-trace-$(date +%F).jsonl
wc -l < $T                                    # mark position before a test
tail -n +<mark> $T | jq -c '{e:.event, allowed, url:(.url//""|.[0:70])}'
```

Useful one-liners:

```sh
# every navigation the gate cancelled
jq -r 'select(.allowed==false) | [.event,.url] | @tsv' $T

# did the runtime patches install
jq -c 'select(.event|test("patch"))' $T

# the full chain of one popup
jq -c 'select(.label=="browser-popup-1")' $T
```

Events: `pane-nav`, `pane-new-window`, `popup-open`, `popup-nav`, `popup-registered`, `popup-closed`, `popup-close-patch`, `media-permission-patch`, `signin-nav`.

---

## 2. Suite

### A. Federated login (the Phase 0 gate)

```sh
spike open https://www.linkedin.com/feed/
```

Sign out if already signed in, then use "Continue with Google".

| Check | Pass |
|---|---|
| A popup window appears, centered | `pane-new-window` with `kind=Popup`, then `popup-open` |
| Account chooser is interactive | `popup-nav` reaches `v3/signin/accountchooser` |
| Credential step actually runs | `popup-nav` reaches `InteractiveLogin`, then consent carrying `&rapt=` |
| Token crosses back | `popup-nav` `gsi/transform`, then a **`pane-nav`** to the relying party's login-submit |
| Not blocked | **no** `/signin/rejected` anywhere in the chain |

If the chain stops at `gsi/select` or a blank page, the popup did not get an opener. Check `pane-new-window` said `kind=Popup` and not `kind=Board`.

### B. Popup lifecycle

Serve a page that opens `window.open(url, name, 'width=520,height=640')` where the popup calls `window.close()` on a timer.

| Check | Pass |
|---|---|
| Patch installed | `popup-close-patch` with `"installed": true` **before** the first `pane-nav` |
| Popup has an opener | the popup page reports `window.opener` present |
| Self-close works | **the window visibly disappears** (see Traps) |
| Focus returns | the pane, not the desktop, has focus afterwards |
| Parent close cleans up | close the board tab with a popup open; the popup goes with it |

### C. Popup identity (anti-spoofing)

Point a popup at a page whose `document.title` is set to another origin's hostname.

| Check | Pass |
|---|---|
| Host leads | title starts with the **real** host, page title only ever a suffix |
| Insecure marked | an `http://` popup is prefixed `Not secure · ` |
| Long titles capped | a 500-char title cannot push the host out of the titlebar |
| Host follows navigation | across an OAuth chain the title tracks the **current** origin, not the starting one |

### D. Navigation gate

Load a page building iframes via `about:blank` + `document.write`, `srcdoc`, `data:` and `blob:`.

| Check | Pass |
|---|---|
| In-document schemes allowed | no `allowed:false` for `about:`/`data:`/`blob:` from a normal page |
| Privileged origins refused | `blob:tauri://…`, `file:`, `*.localhost` IPC hosts still `allowed:false` |

Frames that render blank with no error in the page are the symptom of over-blocking here.

### E. Screenshots

```sh
spike shot            # pane
spike shot window     # whole window
```

| Check | Pass |
|---|---|
| Pane, board up | the page content, not a blank rect |
| Window, no board | Spike's UI |
| Window, board up | **both**, board composited in place |
| Placement | board aligned under the chrome strip, no offset |
| Resolution | pixel dimensions are 2x the window's point size (Retina preserved) |
| Pruning | `~/.spike/shots` never exceeds 20 files |

### F. Session persistence

Sign in, quit Spike, relaunch, reopen the site. Pass is the page loading straight in: no login page, **and no authwall hop in the trace**.

### G. Compatibility matrix

Per the plan. Record date, build, and the trace excerpt for anything that fails.

| Site | Direct login | Google login | Popup | Upload/download | Persistence |
|---|---|---|---|---|---|
| LinkedIn | test | critical | critical | test | critical |
| Slack | test | critical | critical | critical | critical |
| Notion | test | critical | critical | test | critical |
| Linear | test | critical | critical | test | critical |
| Google Docs | special case | direct Google | test | test | critical |
| Gmail | special case | direct Google | test | test | critical |
| GitHub | test | test | critical | test | critical |

Google Docs and Gmail are the "special case" because they need a session in **the pane's own cookie jar**, not a token handoff. Different problem from third-party OAuth, different mechanism.

---

## 3. Traps: signals that look like a pass and are not

**`w.closed === true` does not mean the window closed.** WebKit tears the page down and marks it closed whether or not anything removes the native window. A test asserting on `w.closed` reported PASS while a dead page sat on screen. Only the window disappearing is the test. Corollary: buttons on a "closed" page do nothing, because you are clicking a painted corpse.

**A permission grant is not evidence of a prompt.** What distinguishes "the user consented" from "something auto-granted" is *time*. Anything under ~250ms is faster than a human can consent. Assert on the latency, not the outcome.

**An absent API is not a denial.** `navigator.mediaDevices` is undefined in the pane on every origin, http and https, because WebKit only exposes media capture when the bundle declares `NSCameraUsageDescription`. A `TypeError` here means the test never reached the code under test. Distinguish "refused" from "was never asked".

**Ask whether the hole is reachable before calling it a hole.** "Exposed today" and "exposed if someone adds a plist key" call for different responses. Checking reachability first would have prevented one incorrect security claim.

**A silent patch failure looks exactly like a shipped feature.** The `webViewDidClose:` patch was committed, reviewed and merged in a state where it never installed once. The only evidence was `{"installed": false, "why": "class not found"}` in the trace. Any runtime patch must record whether it took, and that line must be checked before the feature is called done.

**Never look up an objc2 `define_class!` class by name.** It is registered under its full Rust module path plus the crate version:

```
wry::wkwebview::class::wry_web_view_ui_delegate::WryWebViewUIDelegate0.55.1
```

A guessed name fails; a correct name breaks on the next patch bump, silently, because `AnyClass::get` just returns `None`. Read the class off a live instance instead.

**An agent reporting success may be in the wrong window.** Agents report on the Spike they are running inside. "It worked" and "no such subcommand" from two agents on the same machine is normal when two builds are installed. Run the preflight in *that* terminal before believing either.

**A stale note outranks fresh evidence, in an agent's reasoning.** A superseded research note kept steering agents into declining work that had already been proven to function. When behavior changes, fix the note the same day, and mark it superseded rather than deleting it so the correction is visible.
