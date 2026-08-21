// Scenario: the shell edition has no chat, anywhere a user could reach it.
//
// Spike ships two products from one source (SPIKE_EDITION). CHAT_ENABLED gates
// the tab menu, the palette command, chatCapable() and the spawn default — but
// three surfaces were left ungated and went on advertising a feature the shell
// edition doesn't have: the ⌘⇧E binding, its line in the ⌘/ overlay, and
// Settings' two "Default view" rows.
//
// Run BOTH ways — the point is the difference:
//   SPIKE_EDITION=shell node verify/run.mjs shell-edition   → chat is absent
//   node verify/run.mjs shell-edition                       → chat is present
//
// Under test (assertions flip with the edition):
//   A. SPAWN. A new lane opens in the terminal (shell) / obeys the preference (full).
//   B. MENU + PALETTE. No chat entry / the entries exist.
//   C. ⌘⇧E. Inert AND it must not fall through to the preview's edit toggle —
//      shift doesn't change e.key, so dropping the arm without the !e.shiftKey
//      guard would start editing the document instead.
//   D. ⌘/ OVERLAY. The key is listed only where it is bound.
//   E. SETTINGS. The "Default view" rows render only where there's a view to choose.

const SHELL = process.env.SPIKE_EDITION === 'shell';

export async function run({ startServer, launch, outDir }) {
  const results = [];
  const srv = await startServer();
  const browser = await launch({ headless: true });
  const p = await browser.newPage();

  await p.addInitScript(`
    window.__SPIKE_CFG = {
      spawnDefaults: { cwd: '/Users/me/proj', engine: 'claude', view: 'chat' },
      logging: { recentCount: 10 },
    };
    window.__SPIKE_FIXTURES = {
      get_config: function () { return window.__SPIKE_CFG; },
      patch_config: function () { return window.__SPIKE_CFG; },
      detect_engines: function () {
        return { claude: { installed: true, path: '/usr/bin/claude' }, codex: { installed: false, path: null } };
      },
      read_tree: function () {
        return { name: 'proj', dir: true, path: '/Users/me/proj', children: [
          { name: 'notes.md', dir: false, path: '/Users/me/proj/notes.md' },
        ] };
      },
      read_file: function () { return { text: '# notes\\n\\nbody\\n', truncated: false }; },
    };`);

  await p.goto(srv.url, { waitUntil: 'load', timeout: 20000 });
  await p.waitFor(() => window.__spikeReady === true, { timeout: 15000 });
  await p.eval(async () => { await window.__spike.loadConfig(); });
  await p.eval(() => window.__spike.openProject('/Users/me/proj'));
  await new Promise((r) => setTimeout(r, 300));

  // ── A: what a fresh lane opens as, with the preference asking for chat ─────
  const a = await p.eval(function () {
    const s = window.__spike;
    const g = s.newWorkspace({ name: 'ws', cwd: '/Users/me/proj' });
    s.newTabInGroup(g);
    const lane = s.sessions[s.sessions.length - 1];
    s.activate(lane); s.renderTabs();
    return {
      engine: lane.cmd,
      chatOn: lane.chatOn === true,
      chatCapable: typeof lane.chatCapable === 'function' ? lane.chatCapable() : null,
      prefIsChat: window.__SPIKE_CFG.spawnDefaults.view === 'chat',
    };
  });
  await p.screenshot(`${outDir}/shell-edition-A-spawn.png`);
  results.push({
    part: `A: a new lane with spawnDefaults.view='chat' [${SHELL ? 'shell' : 'full'}]`,
    observed: a,
    checks: {
      'preference-really-says-chat': a.prefIsChat === true,   // guards a vacuous pass
      'lane-is-an-agent-lane': a.engine === 'claude',
      [SHELL ? 'shell: opens as a terminal anyway' : 'full: honours the preference']:
        SHELL ? a.chatOn === false : a.chatOn === true,
      [SHELL ? 'shell: lane is not chat-capable' : 'full: lane is chat-capable']:
        SHELL ? a.chatCapable === false : a.chatCapable === true,
    },
  });

  // ── B: the tab menu and the command palette ───────────────────────────────
  const b = await p.eval(function () {
    const s = window.__spike;
    const lane = s.sessions[s.sessions.length - 1];
    const chip = lane && lane.tab;
    let items = [];
    if (chip) {
      const r = chip.getBoundingClientRect();
      chip.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 4, clientY: r.bottom }));
      items = [...document.querySelectorAll('#gmenu .item')].map((e) => e.textContent.trim());
    }
    const ids = (s.paletteItems() || []).map((i) => i.id);
    document.querySelectorAll('#gmenu').forEach((m) => m.remove());
    return {
      menuOpened: items.length > 0,
      isSessionMenu: items.some((t) => /hand off to new agent/i.test(t)),
      menuHasChat: items.some((t) => /chat view|terminal view/i.test(t)),
      paletteIsFullList: ids.indexOf('c:tree') !== -1,
      paletteHasChat: ids.indexOf('c:chat-view') !== -1,
    };
  });
  await p.screenshot(`${outDir}/shell-edition-B-menu.png`);
  results.push({
    part: 'B: tab menu + command palette',
    observed: b,
    checks: {
      'menu-actually-opened': b.menuOpened === true,          // guards a vacuous pass
      'opened-the-session-menu': b.isSessionMenu === true,
      'palette-is-the-full-list': b.paletteIsFullList === true,
      [SHELL ? 'shell: no chat entry in the menu' : 'full: menu offers chat']:
        SHELL ? b.menuHasChat === false : b.menuHasChat === true,
      [SHELL ? 'shell: no c:chat-view command' : 'full: c:chat-view exists']:
        SHELL ? b.paletteHasChat === false : b.paletteHasChat === true,
    },
  });

  // ── C: ⌘⇧E — inert in the shell, and no leak into the preview editor ──────
  const c = await p.eval(async function () {
    const s = window.__spike;
    const lane = s.sessions[s.sessions.length - 1];
    s.activate(lane);
    try { lane.toggleChat(false); } catch (e) {}
    const chatBefore = lane.chatOn === true;
    await s.openFile('/Users/me/proj/notes.md', 'notes.md');
    await new Promise((r) => setTimeout(r, 150));
    const editingBefore = !!document.querySelector('.pvrender.editing');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', metaKey: true, shiftKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    return {
      chatBefore, editingBefore,
      chatAfter: lane.chatOn === true,
      editingAfter: !!document.querySelector('.pvrender.editing'),
      previewPresent: !!document.querySelector('.pvrender'),
    };
  });
  await p.screenshot(`${outDir}/shell-edition-C-key.png`);
  results.push({
    part: 'C: ⌘⇧E',
    observed: c,
    checks: {
      'preview-actually-open': c.previewPresent === true,            // guards a vacuous pass
      'started-not-in-chat': c.chatBefore === false,
      'preview-was-not-already-editing': c.editingBefore === false,
      // TRUE IN BOTH EDITIONS, and the reason the !e.shiftKey guard exists: in
      // the shell the ⌘⇧E arm is compiled past, so without it the plain-⌘E arm
      // would swallow the chord and start editing the document.
      'never-leaks-into-the-preview-editor': c.editingAfter === false,
      [SHELL ? 'shell: chat stays off' : 'full: chat toggles on']:
        SHELL ? c.chatAfter === false : c.chatAfter === true,
    },
  });

  // ── D: the ⌘/ shortcuts overlay ───────────────────────────────────────────
  // Read #shortcuts itself, not document.body — the overlay is mounted veiled
  // and body.innerText doesn't pick it up.
  const d = await p.eval(async function () {
    const s = window.__spike;
    s.palette.shortcuts();
    await new Promise((r) => setTimeout(r, 250));
    const box = document.getElementById('shortcuts');
    const keys = box ? [...box.querySelectorAll('.sc-row .k')].map((e) => e.textContent.trim()) : [];
    s.palette.shortcuts();   // ⌘/ toggles — put it away
    return {
      overlayOpened: !!box,
      keyCount: keys.length,
      // proof we're reading the real key list, so "no ⌘⇧E" means something
      listsKnownKeys: keys.includes('⌘K') && keys.includes('⌘B'),
      listsChord: keys.includes('⌘⇧E'),
    };
  });
  await p.screenshot(`${outDir}/shell-edition-D-overlay.png`);
  results.push({
    part: 'D: the ⌘/ shortcuts overlay lists the chord only where it is bound',
    observed: d,
    checks: {
      'overlay-actually-opened': d.overlayOpened === true,       // guards a vacuous pass
      'reading-the-real-key-list': d.listsKnownKeys === true,
      [SHELL ? 'shell: does not list ⌘⇧E' : 'full: lists ⌘⇧E']:
        SHELL ? d.listsChord === false : d.listsChord === true,
    },
  });

  // NOT COVERED: Settings' two "Default view" rows. #settings in this tree is a
  // blank slate ("the new settings surface is being reimagined here") — the
  // panes are unwired, so fcRow never runs and there is nothing to assert
  // against. The CHAT_ENABLED guard on those rows is written for when the
  // surface comes back; it is unverified until then, and saying so beats a
  // green check that only proves the pane is empty.

  await browser.close();
  await srv.close();
  return results;
}
