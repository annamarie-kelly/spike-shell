// palette.ts — the ⌘K command palette, plus the ⌘/ shortcuts overlay. Same
// split as settings.ts: app.ts owns the live model (groups, sessions, the file
// index) and passes verbs in through PaletteDeps; this module owns all palette
// DOM, its CSS (injected once, index.html untouched), and the fuzzy matcher.
//
// Why a palette: workspaces grew powerful behind right-click menus and drag
// gestures that nothing advertises. The palette is the searchable index of
// every action — each row carries its shortcut or gesture as a dim hint, so
// finding a command here teaches the faster path for next time. Menus and
// gestures stay; they become accelerators instead of the only door.

// One row the user can pick. Items with `arg` are two-step (pick, then type a
// value — create/rename); everything else runs on Enter. Files aren't items:
// they're scored lazily from the live path set on each keystroke.
import { CHAT_ENABLED } from './edition';

export interface PaletteItem {
  id: string;
  label: string;
  /// dim right-aligned text: a shortcut (⌘B), a gesture (double-click), a count
  hint?: string;
  section: 'workspace' | 'tab' | 'command';
  /// workspace dot color
  color?: string;
  /// leads the empty-query list, above workspaces and tabs, bypassing the
  /// per-section cap. For the rare row that's actionable RIGHT NOW (a pending
  /// update) and must not be dug for. Use sparingly — every priority item
  /// spends the calm top slot the empty palette is otherwise for.
  priority?: boolean;
  run?: () => void;
  arg?: { placeholder: string; run: (value: string) => void };
}

export interface PaletteDeps {
  icon: (name: string, size?: number) => string;
  /// built fresh per open so the list always mirrors the live model
  getItems: () => PaletteItem[];
  /// app.ts's allPaths — every file under the project root, watcher-fresh
  getFiles: () => Set<string>;
  getProjectPath: () => string | null;
  openFile: (path: string, name: string) => void;
  /// close any floating UI (launcher, menus, settings) before taking the stage
  beforeOpen?: () => void;
  /// hand focus back (the active terminal) when the palette goes away
  onClose?: () => void;
}

export interface PaletteHandle {
  open: () => void;
  close: () => void;
  toggle: () => void;
  isOpen: () => boolean;
  /// the ⌘/ keys-and-gestures overlay
  shortcuts: () => void;
}

// ─── fuzzy matcher ────────────────────────────────────────────────────
// Subsequence scorer, VSCode-shaped: query chars must appear in order; runs
// and word-boundary hits score higher; shorter targets win ties. 0 = no match.
// Hand-rolled (~25 lines) — plenty for a few hundred items + a project's
// paths, and it keeps the module dependency-free like the rest of src/web.
function fuzzy(query: string, text: string): number {
  const q = query.toLowerCase(), t = text.toLowerCase();
  if (!q.length || q.length > t.length) return q.length ? 0 : 1;
  let qi = 0, score = 0, streak = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) { streak = 0; continue; }
    qi++; streak++;
    let pts = 1 + streak;                       // consecutive hits compound
    const prev = ti > 0 ? t[ti - 1] : '';
    if (ti === 0 || prev === '/' || prev === ' ' || prev === '-' ||
        prev === '_' || prev === '.') pts += 6; // word/segment starts matter most
    score += pts;
  }
  if (qi < q.length) return 0;
  return (score * 100) / (100 + t.length);      // mild brevity preference
}

// internal row model: real items, plus file hits materialized per keystroke
interface Row { item: PaletteItem; score: number }

const SECTIONS: Array<{ key: string; label: string }> = [
  { key: 'workspace', label: 'workspaces' },
  { key: 'tab', label: 'tabs' },
  { key: 'command', label: 'commands' },
  { key: 'file', label: 'files' },
];

const FILE_CAP = 8;      // top file hits shown
const SECTION_CAP = 6;   // per-section cap while querying, so no list scrolls forever

export function initPalette(deps: PaletteDeps): PaletteHandle {
  const { icon } = deps;

  let panelEl: HTMLElement | null = null;     // the open palette, or null
  let inputEl: HTMLInputElement | null = null;
  let listEl: HTMLElement | null = null;
  let footEl: HTMLElement | null = null;
  let scrimEl: HTMLElement | null = null;     // uniform blur behind the panel
  let items: PaletteItem[] = [];              // snapshot taken at open
  let rows: PaletteItem[] = [];               // currently rendered, flat
  let sel = 0;                                // index into rows
  let argItem: PaletteItem | null = null;     // two-step command awaiting its value
  let shortcutsEl: HTMLElement | null = null; // the ⌘/ overlay, or null

  injectStyles();

  // ─── result building ──────────────────────────────────────────────
  // Empty query: a calm jump list — workspaces, tabs, the leading commands, no
  // files. Querying: score everything, group by section in FIXED order so
  // results never jitter between categories as you type. '>' scopes to commands.
  function buildRows(query: string): PaletteItem[] {
    const q = query.trim();
    if (!q) {
      // Priority rows (a pending update) lead, above everything, uncapped —
      // the whole point is that they're the first thing ⌘K shows.
      const priority = items.filter(i => i.priority);
      const priorityIds = new Set(priority.map(i => i.id));
      return [
        ...priority,
        ...items.filter(i => i.section === 'workspace'),
        ...items.filter(i => i.section === 'tab'),
        ...items.filter(i => i.section === 'command' && !priorityIds.has(i.id)).slice(0, SECTION_CAP),
      ];
    }
    const cmdOnly = q.startsWith('>');
    const term = cmdOnly ? q.slice(1).trim() : q;
    if (!term) return items.filter(i => i.section === 'command');

    const hits: Row[] = [];
    for (const it of items) {
      if (cmdOnly && it.section !== 'command') continue;
      const s = fuzzy(term, it.label);
      if (s > 0) hits.push({ item: it, score: s });
    }
    if (!cmdOnly) for (const r of fileRows(term)) hits.push(r);

    const out: PaletteItem[] = [];
    for (const sec of SECTIONS) {
      const cap = sec.key === 'file' ? FILE_CAP : SECTION_CAP;
      out.push(...hits.filter(h => h.item.section === sec.key)
                      .sort((a, b) => b.score - a.score)
                      .slice(0, cap)
                      .map(h => h.item));
    }
    return out;
  }

  // Score the raw path set and materialize only the top hits into items. The
  // basename is what people usually type, so it gets double weight over the
  // full (root-relative) path.
  function fileRows(term: string): Row[] {
    const root = deps.getProjectPath();
    const pre = root ? root + '/' : '';
    const top: Row[] = [];
    for (const path of deps.getFiles() as Set<string>) {
      const rel = pre && (path as string).startsWith(pre) ? (path as string).slice(pre.length) : (path as string);
      const base = rel.slice(rel.lastIndexOf('/') + 1);
      const s = Math.max(fuzzy(term, rel), fuzzy(term, base) * 2);
      if (s <= 0) continue;
      const dir = rel.slice(0, Math.max(0, rel.length - base.length - 1));
      top.push({
        score: s,
        item: {
          id: 'file:' + path, label: base, hint: dir, section: 'file' as any,
          run: () => deps.openFile(path as string, base),
        },
      });
      // keep the candidate pool bounded on huge trees; 4× the cap leaves
      // plenty of room for the final per-section sort to pick the best
      if (top.length > FILE_CAP * 4) {
        top.sort((a, b) => b.score - a.score);
        top.length = FILE_CAP * 2;
      }
    }
    return top;
  }

  // ─── rendering ─────────────────────────────────────────────────────
  function render(): void {
    if (!listEl || !footEl) return;
    listEl.innerHTML = '';

    if (argItem) {
      // arg mode: the list collapses to a single reminder of what's being
      // named; the input carries the action via its placeholder.
      const r = document.createElement('div');
      r.className = 'prow sel';
      const nm = document.createElement('span');
      nm.className = 'pnm'; nm.textContent = argItem.label;
      r.appendChild(nm);
      listEl.appendChild(r);
      footEl.textContent = '↵ confirm · esc back';
      return;
    }

    rows = buildRows(inputEl ? inputEl.value : '');
    sel = Math.min(sel, Math.max(0, rows.length - 1));
    if (!rows.length) {
      const e = document.createElement('div');
      e.className = 'pempty';
      e.textContent = 'no matches';
      listEl.appendChild(e);
      footEl.textContent = '↑↓ navigate · ↵ open · esc close';
      return;
    }

    let lastSection = '';
    rows.forEach((it, i) => {
      if (it.section !== lastSection) {
        lastSection = it.section;
        const lab = document.createElement('div');
        lab.className = 'plab';
        lab.textContent = (SECTIONS.find(s => s.key === it.section) || { label: it.section }).label;
        listEl!.appendChild(lab);
      }
      const r = document.createElement('div');
      r.className = 'prow' + (i === sel ? ' sel' : '');
      if (it.color) {
        const d = document.createElement('span');
        d.className = 'pdot'; d.style.background = it.color;
        r.appendChild(d);
      } else if (it.section === ('file' as any)) {
        const ic = document.createElement('span');
        ic.className = 'pic'; ic.innerHTML = icon('file', 13);
        r.appendChild(ic);
      }
      const nm = document.createElement('span');
      nm.className = 'pnm'; nm.textContent = it.label;
      r.appendChild(nm);
      if (it.hint) {
        const h = document.createElement('span');
        h.className = 'phint'; h.textContent = it.hint;
        r.appendChild(h);
      }
      r.addEventListener('mousemove', () => { if (sel !== i) { sel = i; paintSel(); } });
      r.addEventListener('click', () => pick(it));
      listEl!.appendChild(r);
    });
    footEl.textContent = '↑↓ navigate · ↵ open · esc close';
  }

  // reselect without rebuilding (mouse hover, arrow keys)
  function paintSel(): void {
    if (!listEl) return;
    const els = listEl.querySelectorAll('.prow');
    els.forEach((el, i) => el.classList.toggle('sel', i === sel));
    const on = els[sel] as HTMLElement | undefined;
    if (on) on.scrollIntoView({ block: 'nearest' });
  }

  function move(d: number): void {
    if (argItem || !rows.length) return;
    sel = (sel + d + rows.length) % rows.length;
    paintSel();
  }

  // ─── running ───────────────────────────────────────────────────────
  function pick(it: PaletteItem): void {
    if (it.arg) {
      // two-step: stay open, repurpose the input for the value
      argItem = it;
      if (inputEl) { inputEl.value = ''; inputEl.placeholder = it.arg.placeholder; inputEl.focus(); }
      render();
      return;
    }
    close();
    if (it.run) it.run();
  }

  function confirmArg(): void {
    const it = argItem;
    const v = inputEl ? inputEl.value.trim() : '';
    if (!it || !it.arg || !v) return;   // empty value: nothing to commit, stay put
    close();
    it.arg.run(v);
  }

  function exitArg(): void {
    argItem = null;
    if (inputEl) { inputEl.value = ''; inputEl.placeholder = PLACEHOLDER; inputEl.focus(); }
    sel = 0;
    render();
  }

  // ─── open / close ──────────────────────────────────────────────────
  const PLACEHOLDER = 'Search workspaces, tabs, files, commands…';

  // Both panels (⌘K and ⌘/) mount in #toplayer — a body sibling appended after
  // #termlayer — NOT in <body>. A body-level overlay is painted over by the
  // terminal layer, which is why these used to blank the terminal while open
  // (html.overlay-open #termlayer): ⌘K read as "Claude disappeared". Up here
  // they stack above it and veil the app with one shared blur scrim instead,
  // so every panel recedes by the same amount — tree, terminal, preview.
  function mountVeiled(el: HTMLElement): void {
    const host = document.getElementById('toplayer') || document.body;
    if (!scrimEl) {
      scrimEl = document.createElement('div');
      scrimEl.id = 'palette-scrim';
      host.appendChild(scrimEl);
    }
    host.appendChild(el);   // after the scrim, and z-indexed above it
  }

  // One scrim shared by both panels, so ⌘K → ⌘/ hands over without the veil
  // blinking. Dropped only once neither is up.
  function syncVeil(): void {
    if (panelEl || shortcutsEl) return;
    scrimEl?.remove();
    scrimEl = null;
  }

  function open(): void {
    if (panelEl) return;
    if (deps.beforeOpen) deps.beforeOpen();
    items = deps.getItems();
    argItem = null;
    sel = 0;

    panelEl = document.createElement('div');
    panelEl.id = 'palette';
    inputEl = document.createElement('input');
    inputEl.className = 'pq';
    inputEl.placeholder = PLACEHOLDER;
    inputEl.addEventListener('input', () => { sel = 0; render(); });
    listEl = document.createElement('div');
    listEl.className = 'plist';
    footEl = document.createElement('div');
    footEl.className = 'pfoot';
    panelEl.append(inputEl, listEl, footEl);
    mountVeiled(panelEl);
    closeShortcuts();   // after mounting, so the shared veil survives the swap

    render();
    inputEl.focus();
    // capture phase so the terminal, the document-level Escape (tree menus),
    // and the global ⌘K handler never see palette keys while it's up
    window.addEventListener('keydown', onKey, true);
    setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);
  }

  function close(): void {
    if (!panelEl) return;
    panelEl.remove();
    panelEl = inputEl = listEl = footEl = null;
    syncVeil();
    argItem = null;
    rows = [];
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onOutside, true);
    if (deps.onClose) deps.onClose();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      argItem ? exitArg() : close();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault(); e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      if (argItem) confirmArg();
      else if (rows[sel]) pick(rows[sel]);
    }
  }

  function onOutside(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    // #kbtn is the palette's own doorway in the top bar; let its click handler
    // run the toggle instead of racing it with a close-on-mousedown
    if (panelEl && !panelEl.contains(t) && !t.closest('#kbtn')) close();
  }

  // ─── ⌘/ shortcuts overlay ──────────────────────────────────────────
  // One static panel: every key and every hidden gesture, summoned on demand
  // and gone on Esc. The palette lists it ("Keyboard shortcuts") and it lists
  // the palette — each makes the other discoverable.
  const KEYS: Array<[string, string]> = [
    ['⌘K', 'command palette'],
    ['⌘N', 'new Spike window'],
    ['⌘⇧N', 'new capture (jot to inbox)'],
    ['⌘T', 'new session'],
    ['⌘W', 'close session (twice to confirm)'],
    ['⌘1…9', 'jump to session (9 = last)'],
    ['⌃Tab', 'next / prev session (+⇧)'],
    ['⌘B', 'toggle file tree'],
    ['⌘J', 'toggle preview'],
    ['⌘\\', 'focus terminal'],
    // Listed only where the key is bound. The full edition flips a lane into
    // chat with it; the shell edition has no chat to flip into, and an overlay
    // naming a dead key is worse than one that stays quiet.
    ...(CHAT_ENABLED ? [['⌘⇧E', 'chat view / terminal view'] as [string, string]] : []),
    ['⌘S', 'save document'],
    ['⌘,', 'settings'],
    ['⌘/', 'this overlay'],
    ['⌘+', 'zoom in'],
    ['⌘−', 'zoom out'],
    ['⌘0', 'reset zoom'],
  ];
  const GESTURES: Array<[string, string]> = [
    ['right-click tab / chip', 'all options'],
    ['double-click name', 'rename'],
    ['drag tab off strip', 'split pane'],
    ['click group chip', 'collapse group'],
    ['+ in the tab strip', 'new session'],
    ['drag file onto terminal', 'insert path'],
  ];

  function shortcuts(): void {
    if (shortcutsEl) { closeShortcuts(); return; }   // ⌘/ toggles
    const box = document.createElement('div');
    box.id = 'shortcuts';
    const cols = document.createElement('div');
    cols.className = 'sc-cols';
    const col = (label: string, rows: Array<[string, string]>) => {
      const c = document.createElement('div');
      c.className = 'sc-col';
      const l = document.createElement('div');
      l.className = 'plab'; l.textContent = label;
      c.appendChild(l);
      for (const [k, d] of rows) {
        const r = document.createElement('div');
        r.className = 'sc-row';
        const ke = document.createElement('span'); ke.className = 'k'; ke.textContent = k;
        const de = document.createElement('span'); de.className = 'd'; de.textContent = d;
        r.append(ke, de);
        c.appendChild(r);
      }
      return c;
    };
    cols.append(col('keys', KEYS), col('gestures', GESTURES));
    box.appendChild(cols);
    mountVeiled(box);
    shortcutsEl = box;
    // AFTER claiming shortcutsEl, so syncVeil keeps the scrim through the
    // hand-off from ⌘K rather than tearing it down and re-fading it.
    close();
    document.addEventListener('keydown', onShortcutsKey, true);
    setTimeout(() => document.addEventListener('mousedown', onShortcutsOutside, true), 0);
  }

  function closeShortcuts(): void {
    if (!shortcutsEl) return;
    shortcutsEl.remove();
    shortcutsEl = null;
    syncVeil();
    document.removeEventListener('keydown', onShortcutsKey, true);
    document.removeEventListener('mousedown', onShortcutsOutside, true);
  }

  function onShortcutsKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && e.key === '/')) {
      e.preventDefault(); e.stopPropagation();
      closeShortcuts();
    }
  }

  function onShortcutsOutside(e: MouseEvent): void {
    if (shortcutsEl && !shortcutsEl.contains(e.target as Node)) closeShortcuts();
  }

  // ─── CSS (injected once; index.html stays untouched) ──────────────
  function injectStyles(): void {
    if (document.getElementById('palette-css')) return;
    const style = document.createElement('style');
    style.id = 'palette-css';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  return { open, close, toggle: () => (panelEl ? close() : open()), isOpen: () => !!panelEl, shortcuts };
}

// Borrowed wholesale from the #launcher / #gmenu recipes: same surface, edge,
// radius and shadow family; selection is the .pill.active treatment (elevated
// + edge border), never an accent fill — see the "no accent-colored chrome"
// note next to the launcher styles.
const CSS = `
/* Uniform veil over the whole app while ⌘K or ⌘/ is open (one scrim, shared).
   It sits in #toplayer with the panel, so it blurs every panel the same
   amount — tree, terminal, preview — instead of the old behaviour where the
   terminal was hidden outright and the rest stayed sharp. Lighter than var(--scrim) (a
   full modal backdrop) on purpose: this recedes the app, it doesn't black it
   out. pointer-events:auto so clicks land here and close, rather than falling
   through to the terminal. Native live webviews can't be blurred by CSS, so
   they're still hidden while an overlay is up (liveBoardOccluded in app.ts). */
#palette-scrim {
  position: fixed; inset: 0; z-index: 69; pointer-events: auto;
  background: color-mix(in srgb, var(--bg) 26%, transparent);
  backdrop-filter: blur(5px); -webkit-backdrop-filter: blur(5px);
  animation: palette-veil .12s ease both;
}
@keyframes palette-veil { from { opacity: 0; } to { opacity: 1; } }
#palette {
  /* pointer-events:auto is load-bearing: #toplayer is click-through, so a child
     that doesn't opt back in is invisible to hit-testing and every click falls
     to the scrim underneath (which closes) — the panel would look dead. */
  position: fixed; z-index: 70; pointer-events: auto;
  left: 50%; top: 16vh; transform: translateX(-50%);
  width: 480px; max-width: calc(100vw - 32px); box-sizing: border-box;
  background: var(--surface); border: 1px solid var(--edge); border-radius: 10px;
  box-shadow: 0 14px 40px rgba(var(--shadow), calc(.45 * var(--shadow-k))); overflow: hidden;
  display: flex; flex-direction: column;
  font: 12px -apple-system, system-ui, sans-serif; color: var(--ink-soft);
}
#palette .pq {
  height: 38px; flex: none; padding: 0 14px; border: none; outline: none;
  background: transparent; border-bottom: 1px solid var(--edge);
  color: var(--ink); font: 13px -apple-system, system-ui, sans-serif;
}
#palette .pq::placeholder { color: var(--ink-ghost); }
#palette .plist { max-height: 46vh; overflow-y: auto; padding: 5px 6px 6px; }
#palette .plab, #shortcuts .plab {
  font-size: 9px; font-weight: 600; letter-spacing: .09em; text-transform: uppercase;
  color: var(--ink-ghost); padding: 7px 8px 3px; user-select: none;
}
#palette .prow {
  display: flex; align-items: center; gap: 8px; padding: 5px 8px;
  border-radius: 5px; border: 1px solid transparent; cursor: default;
}
#palette .prow.sel { background: var(--elevated); border-color: var(--edge); color: var(--ink); }
#palette .prow .pdot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
#palette .prow .pic { display: inline-flex; color: var(--ink-faint); flex: none; }
#palette .prow .pnm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#palette .prow .phint {
  margin-left: auto; padding-left: 10px; flex: none; max-width: 45%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--ink-ghost); font-size: 10.5px;
}
#palette .pempty { padding: 14px 12px; color: var(--ink-ghost); }
#palette .pfoot {
  flex: none; padding: 6px 12px; border-top: 1px solid var(--edge);
  color: var(--ink-faint); font-size: 11px; user-select: none;
}
#shortcuts {
  /* pointer-events:auto for the same reason as #palette — see above. */
  position: fixed; z-index: 70; pointer-events: auto;
  left: 50%; top: 22vh; transform: translateX(-50%);
  width: 560px; max-width: calc(100vw - 32px); box-sizing: border-box; padding: 10px 18px 14px;
  background: var(--surface); border: 1px solid var(--edge); border-radius: 10px;
  box-shadow: 0 14px 40px rgba(var(--shadow), calc(.45 * var(--shadow-k)));
  font: 12px -apple-system, system-ui, sans-serif; color: var(--ink-soft);
}
#shortcuts .sc-cols { display: flex; gap: 26px; }
#shortcuts .sc-col { flex: 1; min-width: 0; }
#shortcuts .sc-col .plab { padding-left: 0; }
#shortcuts .sc-row { display: flex; align-items: baseline; gap: 10px; padding: 3px 0; }
#shortcuts .sc-row .k { color: var(--ink); font: 11px ui-monospace, Menlo, monospace; white-space: nowrap; }
#shortcuts .sc-row .d { color: var(--ink-faint); margin-left: auto; text-align: right; }
`;
