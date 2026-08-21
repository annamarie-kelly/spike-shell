// Scenario: one sign-in surface, and a way back out of it.
//
// Google refuses interactive sign-in inside the embedded pane webview, so Spike
// relocates it to a real top-level window (google_signin_show). What it did NOT
// do was tell the pane to stop rendering the page it had been bounced to — so
// the same "Choose an account" screen appeared twice, once in the pane and once
// in the window, and only the window's could be finished.
//
// Under test:
//   A. RELOCATION STILL FIRES. A main-frame hop to accounts.google.com/…/signin
//      opens the sign-in window.
//   B. THE RETURN TARGET IS THE PAGE WE CAME FROM. A third-party OAuth's
//      `continue=` is itself an accounts.google.com URL, which would send the
//      pane back to the sign-in host. The last non-sign-in page is used instead.
//   C. THE PANE HOLDS. The child webview is hidden, the .livehold placeholder is
//      up, and NO live_webview_show is issued while the window is open — that
//      absence IS the fix; a show call here is the second copy.
//   D. CANCEL RETURNS. Destroying the window without completing releases the
//      hold and puts the pane back, instead of stranding it behind the
//      placeholder forever.
//   E. SUCCESS RETURNS. google-signin-done releases the hold and points the pane
//      at the doc it was bounced from.
//
// The pane's URL is driven through the same 500ms live_webview_url poll the app
// uses (app.ts has no on_navigation listener — the poll is the only feed), so
// applyLiveNav runs exactly as it would in the app.
//
// Run: node verify/run.mjs signin-hold

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FROM = 'https://github.com/login?return_to=%2Fsettings';
const SIGNIN = 'https://accounts.google.com/v3/signin/identifier?continue='
  + encodeURIComponent('https://accounts.google.com/signin/oauth/consent?client_id=github')
  + '&service=oauth';

export async function run({ startServer, launch, outDir }) {
  const results = [];
  const srv = await startServer();
  const browser = await launch({ headless: true });
  const p = await browser.newPage();

  await p.addInitScript(`
    window.__LIVE_URL = null;   // what the webview reports it is showing
    window.__SPIKE_FIXTURES = {
      read_tree: function () { return { name: 'proj', dir: true, path: '/proj', children: [] }; },
      // Model what Rust does: live_webview_show navigates the child when the URL
      // changes, and live_webview_url reports wherever it currently is. Without
      // this the fixture is frozen on whatever the scenario last set, and the
      // pane can never be observed coming back. Assigning __LIVE_URL directly
      // stands in for the PAGE navigating itself (the bounce to sign-in).
      live_webview_show: function (a) { if (a && a.url) window.__LIVE_URL = a.url; return null; },
      live_webview_url: function () { return window.__LIVE_URL; },
    };`);
  await p.goto(srv.url, { waitUntil: 'load', timeout: 20000 });
  await p.waitFor(() => window.__spikeReady === true, { timeout: 10000 });
  await p.eval(() => window.__spike.openProject('/proj'));
  await p.eval((u) => window.__spike.openUrl(u), 'https://github.com/');
  await p.waitFor(() => !!document.querySelector('.pvrender.show .livebar'), { timeout: 5000 });

  // Land on a real page first: this is what the pane must come back to, and the
  // only way the app learns it is applyLiveNav running for a non-Google host.
  await p.eval((u) => { window.__LIVE_URL = u; }, FROM);
  await p.waitFor(`document.querySelector('.liveaddr').value === ${JSON.stringify(FROM)}`, { timeout: 4000 });
  const before = await p.eval(() => ({
    shows: window.__tauri.callsFor('live_webview_show').length,
    hides: window.__tauri.callsFor('live_webview_hide').length,
  }));

  // ── A + B: the bounce to sign-in relocates, with an honest return target ───
  await p.eval((u) => { window.__LIVE_URL = u; }, SIGNIN);
  await p.waitFor(() => window.__tauri.callsFor('google_signin_show').length > 0, { timeout: 5000 });
  await p.screenshot(`${outDir}/signin-hold-A-relocated.png`);
  const ab = await p.eval(function () {
    const c = window.__tauri.callsFor('google_signin_show');
    return { count: c.length, url: c[0].args.url, returnUrl: c[0].args.returnUrl };
  });
  results.push({
    part: 'A+B: sign-in relocates to its own window, returning to the page we came from',
    observed: ab,
    checks: {
      'window-opened-once': ab.count === 1,
      'opened-at-the-signin-url': /accounts\.google\.com/.test(ab.url || ''),
      'return-target-is-the-github-page': ab.returnUrl === FROM,
      'return-target-is-not-the-signin-host': !/accounts\.google\.com/.test(ab.returnUrl || ''),
    },
  });

  // ── C: the pane holds instead of drawing the same screen again ────────────
  await sleep(700);   // let a poll tick or two go by — a stray show would land here
  const held = await p.eval(function (n) {
    return {
      placeholder: !!document.querySelector('.livehold'),
      cancelBtn: !!document.querySelector('.livehold .livehold-b'),
      // Counted SINCE the relocation. Total hides is the wrong measure: the
      // board gets hidden for ordinary reasons (menus, layout) and that count is
      // already non-zero on a build that never holds anything.
      hidesSinceSignin: window.__tauri.callsFor('live_webview_hide').length - n.hides,
      showsSinceSignin: window.__tauri.callsFor('live_webview_show').length - n.shows,
    };
  }, before);
  await p.screenshot(`${outDir}/signin-hold-C-held.png`);
  results.push({
    part: 'C: the pane holds — placeholder up, webview hidden, no second copy drawn',
    observed: held,
    checks: {
      'placeholder-is-up': held.placeholder === true,
      'placeholder-offers-a-way-out': held.cancelBtn === true,
      'child-webview-hidden-BY-the-hold': held.hidesSinceSignin > 0,
      // A guard, not a measure: it passes on the pre-change build too, because
      // the old pane never re-showed either — the webview was already sitting on
      // Google's page, which is exactly why it appeared twice. The hide above is
      // what actually removes the second copy.
      'no-show-while-held': held.showsSinceSignin === 0,
    },
  });

  // ── D: closing the window by hand puts the pane back ──────────────────────
  const cancelled = await p.eval(async function (from) {
    window.__tauri.emit('google-signin-cancelled', {});
    await new Promise((r) => setTimeout(r, 250));
    return {
      placeholder: !!document.querySelector('.livehold'),
      addr: document.querySelector('.liveaddr').value,
      backAtFrom: document.querySelector('.liveaddr').value === from,
    };
  }, FROM);
  await p.screenshot(`${outDir}/signin-hold-D-cancelled.png`);
  results.push({
    part: 'D: cancelling releases the hold and returns the pane',
    observed: cancelled,
    checks: {
      'placeholder-gone': cancelled.placeholder === false,
      'pane-back-on-the-page-we-came-from': cancelled.backAtFrom === true,
    },
  });

  // ── E: a cancel is honoured for a beat, then sign-in is available again ───
  const quiet = await p.eval(async function (signin) {
    window.__LIVE_URL = signin;                       // the pane is still parked there
    const n = window.__tauri.callsFor('google_signin_show').length;
    await new Promise((r) => setTimeout(r, 900));     // a poll tick or two
    return { reopens: window.__tauri.callsFor('google_signin_show').length - n,
             placeholder: !!document.querySelector('.livehold') };
  }, SIGNIN);
  await p.screenshot(`${outDir}/signin-hold-E-quiet.png`);
  results.push({
    part: 'E: right after a cancel, the window the user closed does not reopen',
    observed: quiet,
    checks: {
      'no-reopen-during-the-quiet-window': quiet.reopens === 0,
      'pane-not-re-held': quiet.placeholder === false,
    },
  });

  // ── F: once the quiet window lapses, a real bounce prompts again ──────────
  const again = await p.eval(async function (signin, from) {
    await new Promise((r) => setTimeout(r, 4600));    // SIGNIN_QUIET_MS is 5s from the cancel
    // A real retry is a NAVIGATION, not the pane sitting still: the user goes
    // back to the page and clicks "Sign in with Google" again. (Parking on the
    // sign-in URL and waiting deliberately does nothing — the quiet window
    // lapsing must not make a prompt appear on its own.)
    window.__LIVE_URL = from;
    await new Promise((r) => setTimeout(r, 700));
    window.__LIVE_URL = signin;
    await new Promise((r) => setTimeout(r, 900));
    const heldAgain = !!document.querySelector('.livehold');
    window.__tauri.emit('google-signin-done', { url: 'https://github.com/settings/profile' });
    await new Promise((r) => setTimeout(r, 300));
    return {
      heldAgain,
      placeholder: !!document.querySelector('.livehold'),
      addr: document.querySelector('.liveaddr').value,
      closes: window.__tauri.callsFor('google_signin_close').length,
    };
  }, SIGNIN, FROM);
  await p.screenshot(`${outDir}/signin-hold-F-done.png`);
  results.push({
    part: 'F: after the quiet window, sign-in prompts again and success returns the pane',
    observed: again,
    checks: {
      're-held-on-a-later-bounce': again.heldAgain === true,   // not permanently suppressed
      'placeholder-gone': again.placeholder === false,
      'signin-window-closed': again.closes > 0,
      'pane-on-the-destination': again.addr === 'https://github.com/settings/profile',
    },
  });

  await browser.close();
  await srv.close();
  return results;
}
