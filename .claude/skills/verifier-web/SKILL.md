---
name: verifier-web
description: Headless runtime verification of Spike's web frontend. Boots the real bundled app.ts in headless Google Chrome under a __TAURI_INTERNALS__ shim (no Tauri, no second live instance), drives it with real mouse/keyboard via raw CDP, and captures screenshots + asserts behavior. Use when verifying a UI/frontend change in src/web or index.html - drag/drop, tabs, groups, layout, menus.
---

# Verifier: Spike web frontend (headless)

The surface for a frontend change is **pixels** - the strip, a menu, a drag. This
harness reaches that surface without launching a second live Tauri window (which
would fight the user's running instance, per house practice).

## How it works

1. **`verify/serve.mjs`** bundles the *current* `src/web/app.ts` with esbuild
   (resolving `node_modules` from the main checkout, since a worktree has none),
   copies the vendored libs (xterm, marked, …), and serves `index.html` with a
   shim injected. It appends a tiny **setup seam** (`window.__spike`) exposing
   module-level functions so a scenario can build state the way the UI would.
   The seam is setup only - the gesture under test runs through real DOM events.
2. **`verify/shim.js`** provides `window.__TAURI_INTERNALS__` so the bundled
   `@tauri-apps/api` talks to a mock backend. Boot funnels every failure to
   `showWelcome()`, so unmocked commands resolving to `null` are harmless. Every
   `invoke` is recorded on `window.__tauri.calls` for assertions (e.g. what got
   persisted).
3. **`verify/cdp.mjs`** is a zero-dependency Chrome DevTools Protocol client
   (Node 22 global `WebSocket`/`fetch`, system Google Chrome). It launches
   headless Chrome, runs script, dispatches real `Input.dispatchMouseEvent`
   drags, and screenshots.
4. **`verify/scenarios/*.mjs`** are the per-feature tests.

## Run

```bash
npm run verify                 # default scenario: reorder-groups
node verify/run.mjs <name>     # a specific scenario
SPIKE_HEADED=1 npm run verify  # watch it in a real Chrome window
SPIKE_OUT=/tmp/shots npm run verify   # screenshots elsewhere (default verify/out)
```

Exit code is 0 on PASS, 1 on FAIL. Screenshots and a per-check report print at
the end.

## Add a scenario

Copy `verify/scenarios/reorder-groups.mjs`. A scenario exports
`run({ startServer, launch, outDir })` and returns an array of
`{ part, ...observations, checks: { name: bool } }`. Drive through real elements:

- `p.eval(fn, ...args)` - run in page; use `window.__spike` for setup only.
- `p.center(sel)` / `p.drag(sel, toX)` / `p.mouse(type, x, y)` - real input.
- `p.screenshot(path)` - evidence.
- `window.__tauri.callsFor('save_group')` - assert what was persisted.

## Gotchas (learned building this)

- **Real `Session`s spawn an xterm pane** that, with no real layout sizing,
  paints over the strip and eats pointer events. For strip/group tests, push
  minimal stand-in session objects (`{name, groupId, close(){}, term:{focus(){}}}`)
  so groups render without a pane.
- The shim needs `__TAURI_INTERNALS__.metadata.currentWindow/currentWebview` or
  `getCurrentWindow()` throws during module init.
- `detect_engines` must return `{claude:{installed},codex:{installed}}` - the
  app reads nested `.installed`.
- The strip is `display:none` in welcome state; call `window.__spike.hideWelcome()`.
