// window.__TAURI_INTERNALS__ shim - makes the bundled @tauri-apps/api talk to a
// mock backend so the real Spike frontend boots inside a plain headless Chrome.
//
// Contract (from @tauri-apps/api/core.js): invoke(cmd,args,opts),
// transformCallback(cb,once), convertFileSrc(path,proto), unregisterCallback(id).
//
// Boot is resilient by design: app.ts funnels every boot failure to
// showWelcome(), so an unmocked command resolving to null just lands on the
// welcome screen - the tab strip (#tabs) still exists, which is all the
// group-reorder scenario drives. Every invoke is recorded on
// window.__tauri.calls so a scenario can assert what was persisted (e.g. the
// save_group order writes).
(function () {
  const calls = [];
  const callbacks = new Map();
  // event name → the transformCallback id its listener registered, so a scenario
  // can deliver a backend event (window.__tauri.emit) the way Rust's app.emit would.
  const eventListeners = new Map();
  let cbId = 0;

  // Per-command mock responses. A scenario can override/extend by defining
  // window.__SPIKE_FIXTURES before this runs (injected via CDP addScriptToEval).
  const fixtures = (window.__SPIKE_FIXTURES = window.__SPIKE_FIXTURES || {});
  // In-memory group store so save_group → list_groups round-trips within a
  // session (lets a scenario reload and watch hydrate honor the saved order).
  const groupStore = (window.__SPIKE_GROUP_STORE = window.__SPIKE_GROUP_STORE || {});
  const defaults = {
    list_groups: () => Object.keys(groupStore).sort().map((k) => groupStore[k]),
    save_group: (g) => { if (g && g.name) groupStore[g.name] = g; return null; },
    delete_group: (a) => { if (a && a.name) delete groupStore[a.name]; return null; },
    get_config: () => ({}),
    detect_engines: () => ({ claude: { installed: true, path: '/usr/bin/claude' }, codex: { installed: false, path: null } }),
    get_last_root: () => null,        // → showWelcome (no project spawn / ptys)
    resolve_auto_context: () => ({}),
    pty_spawn: () => null,            // resolve; no output is pushed
    pty_write: () => null,
    pty_resize: () => null,
    pty_kill: () => null,
    set_focus: () => null,
    log_event: () => null,
    start_watch: () => null,
    'plugin:event|listen': (args) => { if (args && args.event != null) eventListeners.set(args.event, args.handler); return ++cbId; },
    'plugin:event|unlisten': () => null,
  };

  function safeArgs(args) {
    try { return JSON.parse(JSON.stringify(args, (k, v) => (typeof v === 'function' ? '[fn]' : v))); }
    catch { return Object.keys(args || {}); }
  }

  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { windowLabel: 'main', label: 'main' },
    },
    invoke(cmd, args) {
      calls.push({ cmd, args: safeArgs(args) });
      const fn = fixtures[cmd] || defaults[cmd];
      try { return Promise.resolve(fn ? fn(args) : null); }
      catch (e) { return Promise.reject(e); }
    },
    transformCallback(cb, once) {
      const id = ++cbId;
      callbacks.set(id, { cb, once });
      return id;
    },
    unregisterCallback(id) { callbacks.delete(id); },
    convertFileSrc(path) { return 'file://' + path; },
    runCallback(id, payload) {
      const e = callbacks.get(id);
      if (!e) return;
      if (e.once) callbacks.delete(id);
      e.cb(payload);
    },
  };

  // Test inspection surface.
  window.__tauri = {
    calls,
    callsFor: (cmd) => calls.filter((c) => c.cmd === cmd),
    clear: () => { calls.length = 0; },
    // Deliver a backend event to its frontend listener, the way Rust's app.emit
    // would. Returns true if a listener was registered for that event.
    emit(event, payload) {
      const h = eventListeners.get(event);
      if (h == null) return false;
      window.__TAURI_INTERNALS__.runCallback(h, { event, id: h, payload });
      return true;
    },
  };
})();
