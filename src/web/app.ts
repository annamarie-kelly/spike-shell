// Spike frontend. Extracted from index.html's inline script and compiled
// to /public/app.js by esbuild (see build.mjs). Plain DOM, no framework.

// Tiling layout model (pure data + helpers; the renderer lives below in this
// file next to the live globals it re-parents).
import type { LayoutState, LayoutNode, LeafNode, SplitNode } from './layout';
import {
  terminalLeaf, previewLeaf, leaf, split, hasSurface, findLeaf, leaves,
  removeSurface, serialize, deserialize, defaultState,
  findLeafById, takeSurface, insertBeside,
} from './layout';
import type { SurfaceRef, DropZone, DropSide } from './layout';

// All backend transport (the old fetch/WebSocket/EventSource against
// server.ts) goes through the Tauri IPC shim. See ipc.ts for the contract.
import * as ipc from './ipc';
import claudeLogo from './claude-logo.png';
import codexLogo from './codex-logo.png';
import spikeMark from './spike-mark.png';

// The settings panel lives in its own module; app.ts only wires the live
// model (groups, config cache, file-open) into it. See initSettings' deps.
import { initSettings } from './settings';

// Brainstorm — the endless canvas (dot grid, drag-drop files, notes, shapes).
// Fully self-contained (own DOM + CSS + state); app.ts just opens it from the
// Home nav. See brainstorm.ts.
import { initBrainstorm, type BrainstormHandle, type CanvasSuggestion } from './brainstorm';

// The ⌘K command palette (and the ⌘/ shortcuts overlay) — same split as
// settings: app.ts builds the items from the live model (paletteItems, below),
// palette.ts owns the DOM, the fuzzy matcher, and the keyboard model.
import {
  mergeMentionItems, mentionInsert, trackMention, liveMentions,
  isCurrent as mentionIsCurrent,
  type MenuItem as MentionMenuItem, type TrackedMention,
} from './mention';
import { project as projectCard, type ContextCard } from '../work/card';
import { initPalette } from './palette';
import { initAttest } from './attestui';
import { initPlaybook } from './playbookui';
import type { PaletteItem } from './palette';

// The chat view: a lane's conversation rendered from the agent's own
// transcript, over the same pty. Parser, renderer and styles live there; app.ts
// owns only the lifecycle (see Session's chat view block).
import * as chatview from './chatview';
import * as converge from './converge';

// Which edition this bundle is. Spike ships two products from one source: the
// full app, and Spike Shell — the public, terminal-only client. `build-web.mjs`
// defines __SPIKE_EDITION__ when SPIKE_EDITION=shell; left undefined (verify's
// harness, plain builds) it reads as the full edition, so the typeof guard is
// what keeps an undeclared global from throwing. Terminal-only is a build flag
// on purpose: the public repo is an export of this tree, so a downstream patch
// would be silently clobbered by the next publish.
// (the declaration moved to ./edition so palette.ts and settings.ts can read
// the same flag rather than each re-deriving it)
import { SPIKE_EDITION, CHAT_ENABLED } from './edition';
import { LaneReviewExchange } from './lane-controller';
import { planGroupInstalls } from './groupmerge';
import { parameterizeGroup, resolveBundleGroups } from './pathparam';
import { categorizeItems, removeLedgerEntry, entryLabel } from './uninstall';

// Markdown preprocessing with an offset map (wikilinks/embeds rewritten before
// marked sees them, each rewrite carrying the offset back to the real file).
import { mdPreprocessMapped } from './mdedit';

// Globals provided by the CDN <script> tags in index.html (xterm + helpers).
declare const Terminal: any;
declare const FitAddon: any;
declare const WebLinksAddon: any;
declare const marked: any;
declare const hljs: any;
declare const DOMPurify: any;
// WYSIWYG markdown editor: turndown serializes the edited contenteditable DOM
// back to markdown on save; the GFM plugin adds table/strikethrough/task-list
// rules. Both are UMD globals from index.html (see build-web.mjs VENDOR).
declare const TurndownService: any;
declare const turndownPluginGfm: any;
// Custom property we stash on tree rows to map a DOM row back to its node.
// declare global keeps this augmenting lib.dom's HTMLElement now that the file
// is a module (a bare `interface HTMLElement` would otherwise shadow it).
declare global { interface HTMLElement { __node?: any; } }

    // ─── icon registry ────────────────────────────────────────────────
    // Tabler outline icons (https://tabler.io/icons). Each entry is the inner
    // markup of a 24x24 outline glyph; icon() wraps it in a themed <svg> that
    // inherits color via currentColor, so icons follow light/dark for free.
    const ICONS = {
      'chevron-right': '<path d="M9 6l6 6l-6 6" />',
      'chevron-down': '<path d="M6 9l6 6l6 -6" />',
      'folder': '<path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2" />',
      'folder-open': '<path d="M5 19l2.757 -7.351a1 1 0 0 1 .936 -.649h12.307a1 1 0 0 1 .986 1.164l-.996 5.211a2 2 0 0 1 -1.964 1.625h-14.026a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2h4l3 3h7a2 2 0 0 1 2 2v2" />',
      'sun': '<path d="M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0" /><path d="M3 12h1m8 -9v1m8 8h1m-9 8v1m-6.4 -15.4l.7 .7m12.1 -.7l-.7 .7m0 11.4l.7 .7m-12.1 -.7l-.7 .7" />',
      'moon': '<path d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454z" />',
      'eye': '<path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0" /><path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6" />',
      'code': '<path d="M7 8l-4 4l4 4" /><path d="M17 8l4 4l-4 4" /><path d="M14 4l-4 16" />',
      'braces': '<path d="M7 4a2 2 0 0 0 -2 2v3a2 2 0 0 1 -2 2a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2" /><path d="M17 4a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2a2 2 0 0 0 -2 2v3a2 2 0 0 1 -2 2" />',
      'x': '<path d="M18 6l-12 12" /><path d="M6 6l12 12" />',
      // footer dock toggles
      'list-tree': '<path d="M9 6h11" /><path d="M12 12h8" /><path d="M15 18h5" /><path d="M5 6v.01" /><path d="M8 12v.01" /><path d="M11 18v.01" />',
      'terminal': '<path d="M8 9l3 3l-3 3" /><path d="M13 15l3 0" /><path d="M3 4m0 2a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z" />',
      // panel-position glyphs: a frame with the docked edge marked
      'dock-right': '<path d="M4 4m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z" /><path d="M15 4l0 16" />',
      'dock-bottom': '<path d="M4 4m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z" /><path d="M4 14l16 0" />',
      // Paired states for the preview's presentation-only focus control.
      'maximize': '<path d="M4 8v-2a2 2 0 0 1 2 -2h2" /><path d="M16 4h2a2 2 0 0 1 2 2v2" /><path d="M20 16v2a2 2 0 0 1 -2 2h-2" /><path d="M8 20h-2a2 2 0 0 1 -2 -2v-2" />',
      'minimize': '<path d="M9 4v3a2 2 0 0 1 -2 2h-3" /><path d="M15 4v3a2 2 0 0 0 2 2h3" /><path d="M9 20v-3a2 2 0 0 0 -2 -2h-3" /><path d="M15 20v-3a2 2 0 0 1 2 -2h3" />',
      'dots': '<path d="M5 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" /><path d="M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" /><path d="M19 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />',
      'dots-vertical': '<path d="M12 5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" /><path d="M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" /><path d="M12 19m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />',
      // pin — promotes a doc pill out of the recyclable live slot
      'pin': '<path d="M15 4.5l-4 4l-4 1.5l-1.5 1.5l7 7l1.5 -1.5l1.5 -4l4 -4" /><path d="M9 15l-4.5 4.5" /><path d="M14.5 4l5.5 5.5" />',
      'plus': '<path d="M12 5l0 14" /><path d="M5 12l14 0" />',
      'file-plus': '<path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v5" /><path d="M16 19h6" /><path d="M19 16v6" />',
      'folder-plus': '<path d="M12 19h-7a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2h4l3 3h7a2 2 0 0 1 2 2v3.5" /><path d="M16 19h6" /><path d="M19 16v6" />',
      // file-type glyphs
      'file': '<path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z" />',
      'file-text': '<path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z" /><path d="M9 9l1 0" /><path d="M9 13l6 0" /><path d="M9 17l6 0" />',
      'photo': '<path d="M15 8h.01" /><path d="M3 6a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v12a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-12z" /><path d="M3 16l5 -5c.928 -.893 2.072 -.893 3 0l5 5" /><path d="M14 14l1 -1c.928 -.893 2.072 -.893 3 0l3 3" />',
      'file-pdf': '<path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M5 12v-7a2 2 0 0 1 2 -2h7l5 5v4" /><path d="M5 18h1.5a1.5 1.5 0 0 0 0 -3h-1.5v6" /><path d="M17 18h2" /><path d="M20 15h-3v6" /><path d="M11 15v6h1a2 2 0 0 0 2 -2v-2a2 2 0 0 0 -2 -2h-1z" />',
      'table': '<path d="M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14z" /><path d="M3 10h18" /><path d="M10 3v18" />',
      'music': '<path d="M6 17m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" /><path d="M16 17m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" /><path d="M9 17v-13h10v13" /><path d="M9 8h10" />',
      'movie': '<path d="M4 4m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z" /><path d="M8 4l0 16" /><path d="M16 4l0 16" /><path d="M4 8l4 0" /><path d="M4 16l4 0" /><path d="M4 12l16 0" /><path d="M16 8l4 0" /><path d="M16 16l4 0" />',
      // settings gear (footer entry point, lower-right) + a trash for removing pinned paths
      'settings': '<path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z" /><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" />',
      'trash': '<path d="M4 7l16 0" /><path d="M10 11l0 6" /><path d="M14 11l0 6" /><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12" /><path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3" />',
      // eight-ray spark — stands in for the Claude logo in the + launcher
      'claude-spark': '<path d="M12 2.5v5" /><path d="M12 16.5v5" /><path d="M2.5 12h5" /><path d="M16.5 12h5" /><path d="M5.3 5.3l3.5 3.5" /><path d="M15.2 15.2l3.5 3.5" /><path d="M5.3 18.7l3.5 -3.5" /><path d="M15.2 8.8l3.5 -3.5" />',
      // hexagon node — stands in for Codex in the + launcher (a different mark
      // than claude-spark so the two engines are visually distinct)
      'codex-spark': '<path d="M12 3l8 4.5v9l-8 4.5l-8 -4.5v-9z" /><path d="M12 12l8 -4.5" /><path d="M12 12v9" /><path d="M12 12l-8 -4.5" />',
      // settings v2 rail categories + affordances (Tabler outline, same family)
      'arrow-left': '<path d="M5 12l14 0" /><path d="M5 12l6 6" /><path d="M5 12l6 -6" />',
      'adjustments': '<path d="M4 10a2 2 0 1 0 4 0a2 2 0 0 0 -4 0" /><path d="M6 4v4" /><path d="M6 12v8" /><path d="M10 16a2 2 0 1 0 4 0a2 2 0 0 0 -4 0" /><path d="M12 4v10" /><path d="M12 18v2" /><path d="M16 7a2 2 0 1 0 4 0a2 2 0 0 0 -4 0" /><path d="M18 4v1" /><path d="M18 9v11" />',
      'layout-grid': '<path d="M4 4m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z" /><path d="M14 4m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z" /><path d="M4 14m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z" /><path d="M14 14m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z" />',
      'message': '<path d="M8 9h8" /><path d="M8 13h6" /><path d="M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12z" />',
      // clean rounded speech bubble w/ tail — no inner dots — friendlier than
      // the boxy 'message'; used for a plain conversation in the Workstreams list.
      'message-circle': '<path d="M3 20l1.3 -3.9a9 8 0 1 1 3.4 2.9l-4.7 1" />',
      // "add a note on this passage" — the bubble ties it to the notes system
      // (same family as the drawer toggle), the + says it creates one. Same plus
      // marks as file-plus / folder-plus / table-plus above.
      'message-plus': '<path d="M8 9h8" /><path d="M8 13h6" /><path d="M12.01 18.594l-4.01 2.406v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v4.5" /><path d="M16 19h6" /><path d="M19 16v6" />',
      'git-branch': '<path d="M7 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" /><path d="M7 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" /><path d="M17 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" /><path d="M7 8v8" /><path d="M9 18h6a2 2 0 0 0 2 -2v-5" /><path d="M14 14l3 -3l3 3" />',
      'git-fork': '<path d="M12 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" /><path d="M7 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" /><path d="M17 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" /><path d="M7 8v2a2 2 0 0 0 2 2h6a2 2 0 0 0 2 -2v-2" /><path d="M12 12v4" />',
      'lock': '<path d="M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6z" /><path d="M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0" /><path d="M8 11v-4a4 4 0 1 1 8 0v4" />',
      'palette': '<path d="M12 21a9 9 0 0 1 0 -18c4.97 0 9 3.582 9 8c0 1.06 -.474 2.078 -1.318 2.828c-.844 .75 -1.989 1.172 -3.182 1.172h-2.5a2 2 0 0 0 -1 3.75a1.3 1.3 0 0 1 -1 2.25" /><path d="M8.5 10.5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" /><path d="M12.5 7.5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" /><path d="M16.5 10.5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />',
      'activity': '<path d="M3 12h4l3 8l4 -16l3 8h4" />',
      'info-circle': '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" /><path d="M12 9h.01" /><path d="M11 12h1v4h1" />',
      // settings-polish: workspace card ⋯ menu + isolation "?" explainer
      'help-circle': '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" /><path d="M12 16v.01" /><path d="M12 13a2 2 0 0 0 .914 -3.782a1.98 1.98 0 0 0 -2.414 .483" />',
      'pencil': '<path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4" /><path d="M13.5 6.5l4 4" />',
      'copy': '<path d="M7 7m0 2.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667z" /><path d="M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1" />',
      'external-link': '<path d="M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6" /><path d="M11 13l9 -9" /><path d="M15 4h5v5" />',
      // in-pane browser chrome: reload glyph (back/forward reuse arrow-left/right)
      'refresh': '<path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4" /><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" />',
      // comment-to-agent: send glyph (target chip) + sent confirmation
      'arrow-right': '<path d="M5 12l14 0" /><path d="M13 18l6 -6" /><path d="M13 6l6 6" />',
      'check': '<path d="M5 12l5 5l10 -10" />',
      // WYSIWYG markdown toolbar (Tabler outline, same family as the rest)
      'bold': '<path d="M7 5h6a3.5 3.5 0 0 1 0 7h-6z" /><path d="M13 12h1a3.5 3.5 0 0 1 0 7h-7v-7" />',
      'italic': '<path d="M11 5l6 0" /><path d="M7 19l6 0" /><path d="M14 5l-4 14" />',
      'strikethrough': '<path d="M5 12l14 0" /><path d="M16 6.5a4 2 0 0 0 -4 -1.5h-1a3.5 3.5 0 0 0 0 7h2a3.5 3.5 0 0 1 0 7h-1.5a4 2 0 0 1 -4 -1.5" />',
      'list': '<path d="M9 6l11 0" /><path d="M9 12l11 0" /><path d="M9 18l11 0" /><path d="M5 6l0 .01" /><path d="M5 12l0 .01" /><path d="M5 18l0 .01" />',
      'list-numbers': '<path d="M11 6h9" /><path d="M11 12h9" /><path d="M12 18h8" /><path d="M4 16a2 2 0 1 1 4 0c0 .591 -.5 1 -1 1.5l-3 2.5h4" /><path d="M6 10v-6l-2 2" />',
      'list-check': '<path d="M3.5 5.5l1.5 1.5l2.5 -2.5" /><path d="M3.5 11.5l1.5 1.5l2.5 -2.5" /><path d="M3.5 17.5l1.5 1.5l2.5 -2.5" /><path d="M11 6l9 0" /><path d="M11 12l9 0" /><path d="M11 18l9 0" />',
      'quote': '<path d="M10 11h-4a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1h3a1 1 0 0 1 1 1v6c0 2.667 -1.333 4.333 -4 5" /><path d="M19 11h-4a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1h3a1 1 0 0 1 1 1v6c0 2.667 -1.333 4.333 -4 5" />',
      'link': '<path d="M9 15l6 -6" /><path d="M11 6l.463 -.536a5 5 0 0 1 7.071 7.072l-.534 .464" /><path d="M13 18l-.397 .534a5.068 5.068 0 0 1 -7.127 0a4.972 4.972 0 0 1 0 -7.071l.524 -.463" />',
      'table-plus': '<path d="M12 21h-7a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v7" /><path d="M3 10h18" /><path d="M10 3v18" /><path d="M16 19h6" /><path d="M19 16v6" />',
      'minus': '<path d="M5 12l14 0" />',
      // stands in for the paragraph-style picker's word ("Text", "Heading 2") when
      // the row is too narrow to spell it out
      'heading': '<path d="M7 12h10" /><path d="M7 5v14" /><path d="M17 5v14" />',
      'globe': '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" /><path d="M3.6 9h16.8" /><path d="M3.6 15h16.8" /><path d="M11.5 3a17 17 0 0 0 0 18" /><path d="M12.5 3a17 17 0 0 1 0 18" />',
    };
    // Build a themed <svg> string for an icon. size is px (default 15).
    function icon(name, size = 15) {
      const inner = ICONS[name] || ICONS['file'];
      return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block">${inner}</svg>`;
    }
    // The two strokes that turn an empty chat bubble into a written one — the
    // Workstreams list's "unread" cue. Kept as an overlay (absolutely placed
    // over the bubble, same 16px box and same viewBox) rather than a second
    // icon, so read and unread share one silhouette and only the contents
    // change. Hidden by default; #home .wrow.ready reveals it.
    const MSG_LINES =
      '<svg class="in" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"'
      + ' stroke-width="2" stroke-linecap="round">'
      + '<path d="M8.4 9.6h7.4" /><path d="M8.4 13.1h4.8" /></svg>';
    // The same icon, minus icon()'s inline `display:block` — the workstream
    // glyph has to be HIDDEN by a class (working and needs-you replace it), and
    // an inline style beats any stylesheet rule short of !important.
    function wicoIcon(name: string): string {
      return icon(name, 16).replace(' style="display:block"', '');
    }
    // Map a filename to a file-type icon name (by extension).
    function fileIcon(name) {
      const ext = (name.split('.').pop() || '').toLowerCase();
      if (/^(md|markdown)$/.test(ext)) return 'file-text';
      if (/^(html|htm)$/.test(ext)) return 'code';
      if (/^(json|jsonc|geojson)$/.test(ext)) return 'braces';
      if (/^(png|jpg|jpeg|gif|webp|svg|bmp|avif|ico)$/.test(ext)) return 'photo';
      if (ext === 'pdf') return 'file-pdf';
      if (/^(csv|tsv|spiketable)$/.test(ext)) return 'table';
      if (/^(mp3|wav|ogg|m4a|flac)$/.test(ext)) return 'music';
      if (/^(mp4|mov|webm|m4v)$/.test(ext)) return 'movie';
      if (/^(js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|c|h|cpp|cc|cs|php|swift|kt|sh|bash|zsh|sql|css|scss|less|lua|r|dart|vue|svelte|graphql|yml|yaml|toml|ini|xml|diff)$/.test(ext)) return 'code';
      return 'file';
    }
    // Tint class for a file-type icon, by extension. Restrained + theme-aware:
    // docs->mauve, code/markup->accent, images->sage, data->tan, media->soft.
    function fileTint(name) {
      const ext = (name.split('.').pop() || '').toLowerCase();
      if (/^(md|markdown|txt|rst)$/.test(ext)) return 'ic-doc';
      if (/^(html|htm|json|jsonc|geojson|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|c|h|cpp|cc|cs|php|swift|kt|sh|bash|zsh|sql|css|scss|less|lua|r|dart|vue|svelte|graphql|yml|yaml|toml|ini|xml|diff)$/.test(ext)) return 'ic-code';
      if (/^(png|jpg|jpeg|gif|webp|svg|bmp|avif|ico)$/.test(ext)) return 'ic-img';
      if (/^(csv|tsv|pdf|spiketable)$/.test(ext)) return 'ic-data';
      if (/^(mp3|wav|ogg|m4a|flac|mp4|mov|webm|m4v)$/.test(ext)) return 'ic-media';
      return '';
    }
    // A human display name from a filename: drop the extension, turn kebab/snake
    // into spaced Title Case (discovery-kit-100-calls.md → "Discovery Kit 100 Calls").
    function prettyName(name: string): string {
      const base = String(name || '').replace(/\.[^./\\]+$/, '');
      const words = base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (!words) return name;
      return words.replace(/\b([a-z])/g, (_m, c) => c.toUpperCase());
    }

    const status = document.getElementById('status');
    const ctxEl = document.getElementById('ctx');
    const tabsEl = document.getElementById('tabs');
    const termsEl = document.getElementById('terms');

    // ─── terminal overlay layer ───────────────────────────────────────
    // A terminal must never live inside a CSS-zoom context: xterm's selection
    // math drifts under zoom and its scroll container's metrics round (you can
    // scroll up but never back to the true bottom). The whole UI scales via
    // `zoom` on <body> (see the zoom block); #termlayer is mounted as a SIBLING
    // of <body> under <html>, the one spot outside body's zoom, so every xterm
    // renders at true 1.0 scale and is sized only by its `fontSize`. The panes
    // float here and are positioned over zoomed `.termslot` placeholders in the
    // layout by syncTermLayer(). pointer-events stays off the layer itself so
    // clicks fall through to chrome where no pane covers; panes re-enable it.
    const termLayer = document.createElement('div');
    termLayer.id = 'termlayer';
    document.documentElement.appendChild(termLayer);
    // Small popup menus (openMenu's .spikemenu) live here, not in <body>. The
    // zoomed body forms its own stacking context that #termlayer (a later body
    // sibling) paints over, so a menu inside body is occluded by the terminal —
    // the old workaround hid the whole terminal while any menu was open, which
    // read as "Claude vanishes on right-click". #toplayer is a body sibling
    // appended AFTER #termlayer, so its menus paint above the terminal with no
    // hide needed. Click-through except on the menu itself.
    const topLayer = document.createElement('div');
    topLayer.id = 'toplayer';
    document.documentElement.appendChild(topLayer);
    // First-load smoothing: the layer starts hidden (CSS opacity:0) and fades in
    // only once a pane has been positioned over its slot AND fitted, so you never
    // see the terminal flash at 80×24 or jump from an unmeasured box. Flips once.
    let termLayerReady = false;

    // #termlayer paints above <body> (it's a later sibling), which is what lets a
    // terminal show over the chrome — but a body-level overlay that should cover
    // the terminal (palette, settings, a context menu) can't out-stack a sibling
    // that paints after it. So whenever such an overlay is in the DOM we drop the
    // whole layer out of the way (CSS: html.overlay-open #termlayer). These
    // overlays are all direct children of <body>, so a childList observer catches
    // every open/close with no coupling to their modules.
    // Only true covering overlays — NOT .props (that's the preview's frontmatter
    // table, which is persistent preview content, not an overlay; matching it
    // here would hide the terminal forever whenever a file with frontmatter is open).
    // The small popup menus (.spikemenu) and the two palette panels (⌘K
    // #palette, ⌘/ #shortcuts) are NOT in TERM_COVER_SEL: they're hosted in
    // #toplayer ABOVE the terminal, so they stay clickable without blanking
    // the whole terminal — which read as "Claude vanished". They veil the app
    // with a shared uniform blur scrim instead (#palette-scrim in palette.ts).
    //
    // ADDING AN OVERLAY? It must be listed here or it renders UNDER the terminal.
    // z-index can't rescue it: #termlayer is a sibling appended after <body>, so
    // it paints over everything inside the zoomed body no matter the stacking
    // order. #wtask was missed and shipped invisible behind the terminal — the
    // scrim and buttons still live, so a blind click could hit Discard. There's
    // a regression guard in verify/scenarios/overlay-covers-terminal.mjs.
    // OVERLAY_SEL is the wider set — anything a NATIVE live webview would paint
    // over (it out-stacks #toplayer too, so the palette belongs here).
    // #handoff-overlay is a body-level covering sheet (like #settings/#launcher),
    // so it belongs in BOTH: TERM_COVER_SEL to hide the terminal behind it, and
    // OVERLAY_SEL so a live webview can't paint over it.
    // #gmenu is deliberately NOT in TERM_COVER_SEL. It mounts into #toplayer
    // (both callers do), so it already paints above the terminal and needs no
    // help. Listing it there was left over from when it was a body child, and
    // the cost was severe: right-clicking a session blanked every terminal pane
    // to black for as long as the menu was open, which reads as the app dying,
    // not as a menu opening. Guarded by verify/scenarios/overlay-covers-terminal.mjs.
    const OVERLAY_SEL = '#palette, #shortcuts, #settings, #gmenu, #launcher, #gate, #wtask, #handoff-overlay';
    const TERM_COVER_SEL = '#settings, #launcher, #gate, #wtask, #handoff-overlay';
    const refreshOverlayCover = () => {
      document.documentElement.classList.toggle('overlay-open', !!document.querySelector(TERM_COVER_SEL));
      // an overlay would be painted over by a live-board webview — re-sync so it
      // hides while one is open and re-shows when they all close. (scheduleLiveSync
      // is hoisted; this callback only runs at runtime.)
      scheduleLiveSync();
    };
    // Both hosts: overlays that cover the terminal are body children, and the
    // palette (a #toplayer child) still has to hide any native live webview,
    // which paints above #toplayer and would otherwise sit on top of it.
    const overlayObserver = new MutationObserver(refreshOverlayCover);
    overlayObserver.observe(document.body, { childList: true });
    overlayObserver.observe(topLayer, { childList: true });

    // The column's honest empty state: every session popped into its own pane
    // used to leave a bare beige void here, which read as a bug. Shown only
    // when sessions exist but none lives in the column (syncColActive toggles
    // it); the link is the one-click way back for anyone lost in panes.
    const colEmptyEl = document.createElement('div');
    colEmptyEl.id = 'colEmpty';
    colEmptyEl.innerHTML =
      `<div>All sessions are in their own panes.</div>` +
      `<div class="hint">Drag a pane's tab back here — or right-click it.</div>` +
      `<div class="back">Bring them all back</div>`;
    colEmptyEl.querySelector('.back').addEventListener('click', () => unpopAllSessions());
    termsEl.appendChild(colEmptyEl);

    // The shared column shows one session at a time. Its pane (in #termlayer)
    // overlays this placeholder; syncColActive points it at the colActive
    // session and syncTermLayer positions the pane over it.
    const colSlot = document.createElement('div');
    colSlot.className = 'termslot';
    termsEl.appendChild(colSlot);

    // ─── theme ────────────────────────────────────────────────────────
    // Dark by default; an explicit toggle sets data-theme and wins over the
    // OS preference. xterm can't read CSS vars, so we build its theme object
    // from the live computed values and re-apply on every toggle.
    function cssVar(name) {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    }
    function xtermTheme() {
      const bg = cssVar('--bg'), ink = cssVar('--ink'), accent = cssVar('--accent');
      return {
        background: bg, foreground: ink, cursor: accent,
        selectionBackground: cssVar('--edge'),
        black: bg, red: cssVar('--rose'), green: cssVar('--sage'),
        yellow: cssVar('--tan'), blue: cssVar('--blue-deep'), magenta: cssVar('--mauve'),
        cyan: cssVar('--sage'), white: ink,
      };
    }
    // current effective theme: explicit data-theme, else the OS preference.
    function effectiveTheme() {
      const set = document.documentElement.dataset.theme;
      if (set === 'light' || set === 'dark') return set;
      return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    // the stored PREFERENCE, which is not the same thing: 'system' means "no
    // override, follow the OS" and is what an unset/absent value means too.
    //
    // The durable copy lives in ~/.spike/config.json (appearance.theme) so one
    // appearance is shared by every Spike instance. localStorage is only a
    // synchronous cache for FIRST PAINT — reading config costs an IPC round
    // trip, which would land after the page has already painted the wrong
    // theme. reconcileTheme() corrects the cache once config arrives.
    function themePref() {
      let saved = null;
      try { saved = localStorage.getItem('spike-theme'); } catch {}
      return saved === 'light' || saved === 'dark' ? saved : 'system';
    }
    // Config → live DOM, WITHOUT writing back to config. applyTheme() is the
    // user-initiated path and does write; calling it here would echo the value
    // we just read straight back to disk on every boot.
    function reconcileTheme(cfg) {
      const stored = cfg && cfg.appearance && cfg.appearance.theme;
      const valid = stored === 'light' || stored === 'dark' || stored === 'system';
      // Never chosen (pre-appearance config, or a fresh install): adopt whatever
      // this origin's localStorage already had and promote it to the shared
      // file. Nothing repaints — the DOM is already showing that value.
      if (!valid) { patchConfig({ appearance: { theme: themePref() } }); return; }
      if (stored === themePref()) return;   // cache already agrees, nothing painted wrong
      const mode = stored;
      if (mode === 'system') delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = mode;
      try { localStorage.setItem('spike-theme', mode); } catch {}
      retheme();
      syncAgentThemes();
    }
    // brief 'theming' class enables CSS transitions only during the flip, so the
    // chrome fades rather than snaps. Terminals get a forced repaint to match.
    function retheme() {
      document.documentElement.classList.add('theming');
      for (const s of sessions) { s.term.options.theme = xtermTheme(); s.term.refresh(0, s.term.rows - 1); }
      setTimeout(() => document.documentElement.classList.remove('theming'), 240);
      // Covers the one case syncAgentThemes (below) documents as out of reach:
      // a `custom:*` agent theme. It has no opposite to compute, so no
      // `/config theme=` can be sent — and COLORFGBG doesn't help either, since
      // a custom theme's base is pinned in its own file and never derived from
      // the terminal background. Restate that base instead. Read at launch, so
      // it lands on the NEXT spawned tab; running agents keep what they booted
      // with. No-ops for built-in themes (the file won't exist).
      ipc.syncClaudeTheme(effectiveTheme()).catch(() => {});
    }
    // 'light' | 'dark' pin an override; 'system' clears it so the OS rules again.
    // Without the 'system' branch there'd be no way back to following the OS
    // once you'd toggled even once, short of clearing localStorage by hand.
    function applyTheme(mode) {
      if (mode === 'system') delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = mode;
      try { localStorage.setItem('spike-theme', mode); } catch {}
      // Durable, origin-independent copy. Fire-and-forget: the paint above has
      // already happened, and a failed write only costs us the cache being
      // ahead of disk until the next flip.
      patchConfig({ appearance: { theme: mode } });
      retheme();
      syncAgentThemes();
    }
    // ─── agent theme sync ─────────────────────────────────────────────
    // Retheming the terminal isn't enough: the agent INSIDE it paints its own
    // chrome (the composer, message blocks), so a flip leaves dark bars sitting
    // on a light pane. New panes are already fine — pty.rs hands them COLORFGBG
    // at spawn — but a running agent can't be reached that way, because a live
    // pty's env can't change and Claude re-reads its theme at launch only
    // (verified: editing settings.json under a live session does nothing).
    //
    // The one live lever is Claude's own `/config theme=<value>` command, typed
    // into the pty. That's non-destructive (no kill, no lost turn) but it lands
    // in the composer, so it must never be appended to something half-typed —
    // hence the composerDirty gate and the deferred retry on turn.ended.
    function syncAgentThemes() {
      const want = effectiveTheme();   // 'light' | 'dark'
      // The backend hands back the full theme id for `want`, variant suffix
      // preserved (light-ansi, light-daltonized, …). It no longer suppresses a
      // value that matches settings.json — the per-pane `agentTheme` gate below
      // owns "already right", because settings.json is the PERSISTED theme, not
      // what any given running pane is actually painted in.
      ipc.agentThemeCommand(want).then((target) => {
        if (!target) return;   // custom/auto theme, or no Claude install
        for (const s of sessions) {
          // `cmd` is the LAUNCH engine, so a pane where the user quit claude and
          // fell through to a shell still reads 'claude'. Harmless: the text
          // lands at a shell prompt the user is not typing at, and we only send
          // when the line is clean.
          if (s.cmd !== 'claude' || !s.ptyAlive) continue;
          if (s.agentTheme === want) continue;   // this pane is already on that side
          s.pendingAgentTheme = target;
          flushAgentTheme(s);
        }
      }).catch(() => {});
    }
    // Send only onto an empty prompt. If the user is mid-message we hold the
    // value and try again when they submit, or when the agent's turn ends.
    function flushAgentTheme(s: Session) {
      if (!s.pendingAgentTheme || s.composerDirty || !s.ptyAlive) return;
      const target = s.pendingAgentTheme;
      s.pendingAgentTheme = null;
      ipc.ptyWrite(s.ptyId, `/config theme=${target}\r`).catch(() => {});
      // Optimistically record the side we just drove the pane to, so a repeat
      // flip back and forth stays a no-op until it actually needs another send.
      s.agentTheme = target.startsWith('light') ? 'light' : 'dark';
    }
    // restore a saved choice; otherwise leave unset so the OS preference rules.
    (function restoreTheme() {
      const saved = themePref();
      if (saved !== 'system') document.documentElement.dataset.theme = saved;
    })();

    // ─── accent ───────────────────────────────────────────────────────
    // The Valence palette (from oasis-web): named accents, each a light/dark
    // PAIR. We store the NAME and let CSS resolve the right hex per theme (the
    // :root[data-accent=…] rules in index.html), so an accent tracks theme flips
    // for free — no per-flip recompute. `dot` is only the swatch's display
    // colour (its light value). null = no override → Spike's built-in --accent.
    // Mirrors the theme plumbing: localStorage for first paint, config.json
    // (appearance.accent) as the durable, cross-instance copy.
    const ACCENTS: Array<{ name: string; label: string; dot: string }> = [
      { name: 'coral',      label: 'Coral',      dot: '#E0848C' },
      { name: 'sage',       label: 'Sage',       dot: '#8B9A8B' },
      { name: 'terracotta', label: 'Terracotta', dot: '#C4847A' },
      { name: 'ocean',      label: 'Ocean',      dot: '#7A9AA0' },
      { name: 'teal',       label: 'Teal',       dot: '#5F8E86' },
      { name: 'plum',       label: 'Plum',       dot: '#9A7A8B' },
      { name: 'graphite',   label: 'Graphite',   dot: '#86847F' },
    ];
    const ACCENT_NAMES = ACCENTS.map((a) => a.name);
    // Spike's out-of-the-box accent (matches the built-in --accent in index.html).
    const DEFAULT_ACCENT = 'ocean';
    const setAccentAttr = (name: string | null) => {
      if (name && ACCENT_NAMES.includes(name)) document.documentElement.dataset.accent = name;
      else document.documentElement.removeAttribute('data-accent');
    };
    function accentPref(): string | null {
      let saved: string | null = null;
      try { saved = localStorage.getItem('spike-accent'); } catch {}
      return saved && ACCENT_NAMES.includes(saved) ? saved : null;
    }
    function applyAccent(name: string | null): void {
      setAccentAttr(name);
      try {
        if (name) localStorage.setItem('spike-accent', name);
        else localStorage.removeItem('spike-accent');
      } catch {}
      patchConfig({ appearance: { accent: name || null } });
    }
    function reconcileAccent(cfg: any): void {
      const stored = cfg && cfg.appearance && ('accent' in cfg.appearance) ? cfg.appearance.accent : undefined;
      // Never chosen: promote whatever this origin's cache had to the shared file.
      if (stored === undefined) { patchConfig({ appearance: { accent: accentPref() } }); return; }
      const valid = stored === null || (typeof stored === 'string' && ACCENT_NAMES.includes(stored));
      if (!valid) return;
      if (stored === accentPref()) return;   // cache already agrees
      setAccentAttr(stored || null);
      try {
        if (stored) localStorage.setItem('spike-accent', stored);
        else localStorage.removeItem('spike-accent');
      } catch {}
    }
    (function restoreAccent() {
      const c = accentPref();
      if (c) setAccentAttr(c);
    })();

    // ─── zoom ─────────────────────────────────────────────────────────
    // Browser-style scaling: scales the UI chrome (tree, tabs, previews, palette,
    // settings) via a body transform. The TERMINAL is deliberately excluded — it lives
    // in #termlayer outside the zoom (see that block above) and scales via its
    // own `fontSize` instead, because CSS-zooming an xterm drifts its selection
    // math and rounds its scroll container so you can't reach the true bottom.
    const ZOOM_STEPS = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];
    const BASE_ZOOM_INDEX = ZOOM_STEPS.indexOf(1.0);
    let zoomIndex = BASE_ZOOM_INDEX;
    try {
      const z = parseInt(localStorage.getItem('spike-zoom-index'), 10);
      if (z >= 0 && z < ZOOM_STEPS.length) zoomIndex = z;
    } catch {}

    // The terminal scales by real font size (sharper than a CSS scale of 13px
    // glyphs), so ⌘+ still makes terminal text bigger for readability.
    const BASE_FONT_SIZE = 13;
    const termFontSize = (factor: number) => Math.max(6, Math.round(BASE_FONT_SIZE * factor));

    // Floor the geometry we ever hand a pty. During layout churn (a split being
    // built, a splitter mid-flight, a pane briefly a sliver) fit() can measure a
    // ~3-col box; resizing the pty that narrow makes the program hard-wrap its
    // output, and xterm can't un-wrap program-emitted lines when the pane widens
    // back — scrollback stays stuck at ~3 cols. These floors sit just under the
    // real splitter min (90px ≈ 11 cols at any zoom, since box+font scale together),
    // so they never touch a genuinely narrow user-sized pane — only degenerate
    // transients, which re-fit to their true size the moment they have a real box.
    const MIN_PTY_COLS = 10;
    const MIN_PTY_ROWS = 3;

    // Chat view cadence. The poll is a byte-offset read of an append-only file,
    // so an idle lane costs a stat and nothing else — cheap enough to run often.
    // It's kept short so a completed transcript row (text-before-a-tool, a tool
    // result, the final answer) surfaces almost as soon as the engine flushes
    // it; broker tool/turn events also poke a poll (see chatBrokerEvent), so
    // this timer is mostly a backstop for whatever the events miss. IDLE is how
    // long the pty must stay quiet before "working" turns off; it has to outlast
    // the gaps between an agent's tool calls or the dots would strobe through a
    // normal turn.
    const CHAT_POLL_MS = 200;
    const CHAT_IDLE_MS = 1400;
    // How long a live turn may go completely silent before the view suggests
    // it might be blocked. Long, on purpose: a slow tool and a permission
    // prompt look identical from outside, so this has to outlast an ordinary
    // slow tool or it cries wolf on every long-running command.
    const CHAT_STUCK_MS = 25000;
    // How long work must be underway before the spinner appears. Agent work
    // arrives in bursts with sub-second gaps; an indicator that flashes on and
    // off across each gap reads as flicker rather than progress. Only a wait
    // long enough to notice earns one. Hiding is immediate — a stale spinner
    // is a lie, so only its appearance is damped.
    const CHAT_SPIN_DELAY_MS = 450;
    // How long one queued message waits for the transcript to confirm it
    // before the queue moves on regardless. Generous: the agent may be deep in
    // a turn. The cap exists only so a message it never echoes cannot wedge
    // the queue permanently.
    const CHAT_SEND_WAIT_MS = 8000;
    // How far back to look for a sent message's landed copy. Wide on purpose: a
    // pending bubble that never finds its match is never cleared, so it sits at
    // the foot of the conversation for good — and at the old eight, four `!`
    // shell commands (two user rows apiece) were enough to push a message out
    // of range.
    const CHAT_RECONCILE_TAIL = 40;
    // Turns rendered at once. Every update re-runs the markdown renderer over
    // everything on screen, so this is the difference between a cost that
    // tracks the visible conversation and one that tracks how long you have
    // been working. Earlier turns are one click away and never discarded.
    const CHAT_WINDOW = 60;
    // How many times a single finding may be contested before it escalates to the
    // person instead of bouncing again. This is the anti-recursion bound: the
    // reviewer and coder may go back and forth, but a standoff can't loop forever
    // — at the cap it becomes yours to break. 3 gives room to actually converge
    // (coder pushes back, reviewer reconsiders, coder answers the reconsideration)
    // while still terminating fast. The contested set also strictly shrinks each
    // round, so most reviews settle well before the cap.
    const CONVERGE_CAP = 3;
    // How long a finding may wait on a side before it times out to the person.
    // Generous — an agent working through a review can be quiet for minutes — but
    // finite, so a lane that has genuinely stopped answering can't wedge the loop.
    const CONVERGE_TIMEOUT_MS = 4 * 60 * 1000;
    // How often the background advance ticks while a negotiation is in flight.
    const CONVERGE_TICK_MS = 2000;
    // A staged attachment: held until the message is sent, so its chip's × can
    // retract it before anything reaches the agent. `route` is how it's
    // delivered — 'clip' pastes an image via the clipboard (Claude's [Image #N]),
    // 'typed' writes the path. `path` is the file to deliver; `thumb`/`name`
    // drive the composer chip.
    type ChatAtt = { route: 'clip' | 'typed'; path: string; thumb?: string; name: string };
    // Placeholder token for a block construct (table / fenced code) the terminal
    // draws as art and can't be reconstructed cleanly mid-stream — the renderer
    // swaps it for a SPIKE loader until the finished block lands from the transcript.
    const PTY_BLOCK = '#BLK#';
    // PURE: given the visible terminal lines (top→bottom), extract the LATEST
    // in-progress ASSISTANT prose as HTML — the "stream the stream through a
    // formatter" step. Reflows the terminal's hard wraps into paragraphs, drops
    // the input/status footer and tool lines, keeps list items on their own line,
    // and swaps block constructs (tables, fenced code) for a PTY_BLOCK placeholder.
    // Returns null when no assistant prose is confidently found, so the caller
    // falls back to the plain loader rather than showing a garbled dump.
    // Kept pure (text in, HTML out) so the parsing logic is unit-testable without
    // a live pty; the bold/inline-code overlay from cell styling rides on top in
    // chatPtyStreamHtml.
    function parsePtyStreamText(rawLines: string[]): string | null {
      const lines = rawLines.map((l) => (l || '').replace(/\s+$/, ''));
      // Claude Code's own CHROME — the spinner/status line ("Spinning… (7s · ↓ 175
      // tokens · thought for 1s)"), the rotating Tip, the update banner, the input
      // hints. These MUST never reach the prose stream, or the chat shows Claude's
      // status as if it were the reply (the "it types then disappears then retypes"
      // glitch). The gerund word rotates endlessly, so match by the elapsed/token
      // SIGNATURE, not a word list.
      const isChrome = (s: string): boolean => {
        const t = s.trim();
        if (!t) return false;
        if (/^[│├└⎿╰]?\s*Tip:/i.test(t)) return true;
        if (/(esc to interrupt|manual mode|for shortcuts|↑\/↓ to|to run in background|update available|brew upgrade|ctrl\+[a-z]|for agents\b)/i.test(t)) return true;
        // Status spinner: an elapsed-time or token-count signature (with the ellipsis).
        if (/\(\s*\d+m?\s*\d*s\b/.test(t)) return true;                 // "(7s" / "(3m 19s"
        if (/·\s*↓\s*[\d.]+/.test(t) || /↓\s*[\d.]+k?\s*tokens/i.test(t)) return true;  // "· ↓ 175 tokens"
        if (/\bthought for\b|\bthinking (more|with|less|hard)\b/i.test(t)) return true;
        if (/^[✻✳✱✷✶*+·∗][\s]/.test(t) && /…/.test(t)) return true;      // "✻ Spinning…"
        return false;
      };
      // Trim the footer (input box + status) from the bottom up.
      let end = lines.length;
      for (let i = lines.length - 1; i >= 0; i--) {
        const t = lines[i].trim();
        if (!t) { if (end === i + 1) end = i; continue; }
        if (/^[›❯»]/.test(t) || /^[-–—_─]{4,}$/.test(t) || isChrome(t)) { end = i; continue; }
        break;
      }
      let body = lines.slice(0, end);
      while (body.length && !body[body.length - 1].trim()) body.pop();
      if (!body.length) return null;
      // The last assistant bullet marks the start of the latest turn.
      let bi = -1;
      for (let i = body.length - 1; i >= 0; i--) {
        if (/^\s*[●⏺◉]/.test(body[i])) { bi = i; break; }
      }
      if (bi < 0) return null;
      const block = body.slice(bi);
      block[0] = block[0].replace(/^\s*[●⏺◉]\s?/, '');
      const head = block[0].trim();
      // Tool turns belong to the activity trail, not the prose stream.
      if (/^(Read|Reading|Wrote|Writing|Edit|Edited|Editing|Bash|Ran|Running|Search|Searched|Searching|Glob|Grep|List|Listed|LS|Fetch|Fetching|Explore|Explored|Using|Looked|Making|Made|Bringing|Waiting|Todo|Updated the plan)\b/.test(head)
          || /^[A-Za-z_][\w.]*\(/.test(head)) return null;
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const isList = (s: string) => /^\s*([-*•]\s|\d+[.)]\s)/.test(s);
      // A tool-activity line INSIDE the block (a Read/Ran between paragraphs) —
      // the activity trail owns those, drop them from the prose.
      const isToolLine = (s: string) => /^\s*[⎿└├│]/.test(s)
        || /^(Read|Reading|Wrote|Writing|Edited|Editing|Ran|Running|Searched|Searching|Listed|Fetched|Explored|Using a|Looked for|Made|Bringing|Waiting)\b/.test(s.trim());
      const out: string[] = [];
      let para: string[] = [];
      let inFence = false;
      const flush = () => { if (para.length) { out.push('<p>' + para.join(' ') + '</p>'); para = []; } };
      const pushBlock = () => { flush(); if (out[out.length - 1] !== PTY_BLOCK) out.push(PTY_BLOCK); };
      for (const ln of block) {
        const t = ln.trim();
        if (/^(```|~~~)/.test(t)) { inFence = !inFence; pushBlock(); continue; }
        if (inFence) continue;              // code content → the placeholder stands in
        if (!t) { flush(); continue; }      // blank line = paragraph break
        if (isChrome(t) || isToolLine(t)) { flush(); continue; }   // never stream Claude's chrome / tool lines
        if ((t.match(/\|/g) || []).length >= 2 || /^\|?[\s:|+-]{5,}\|?$/.test(t)) { pushBlock(); continue; }  // table
        if (isList(ln)) { flush(); out.push('<p class="ht-li">' + esc(t) + '</p>'); continue; }  // its own line
        para.push(esc(t));                  // reflow wrapped prose into the paragraph
      }
      flush();
      let html = out.join('');
      html = html.replace(new RegExp('(?:' + PTY_BLOCK + ')+', 'g'), PTY_BLOCK);   // collapse runs
      const proseOnly = html.split(PTY_BLOCK).join('').replace(/<\/?p[^>]*>/g, '').trim();
      if (!proseOnly && !html.includes(PTY_BLOCK)) return null;
      return html || null;
    }
    // Does this lane run an agent that writes a transcript? Free function, not
    // just a Session method, so anything holding a lane-shaped value (the
    // session menu, which is shared by the strip tab and the roster row) can
    // ask without depending on the class.
    const isAgentLane = (s: any) => !!s && (s.cmd === 'claude' || s.cmd === 'codex');
    // One stylesheet for the whole chat surface, injected once (the rules read
    // Spike's own custom properties, so it themes with the app).
    const chatStyle = document.createElement('style');
    chatStyle.textContent = chatview.CHAT_CSS;
    document.head.appendChild(chatStyle);

    // Scaling lives on <body>, not <html>: that keeps #termlayer (a sibling of
    // <body>) outside it while every body-appended overlay scales for free. We
    // use CSS `zoom` — NOT `transform: scale` — because on WebKit (the Tauri
    // webview) a scaled transform rasterizes the layer once at 1× and GPU-
    // upscales that bitmap, so all chrome text (tree, markdown, tabs) turns
    // blurry as you zoom in. `zoom` re-runs layout, so glyphs re-rasterize crisp
    // at every step. The catch `transform` originally dodged: WebKit builds
    // disagree on whether getBoundingClientRect reports zoomed (on-screen) or
    // pre-zoom px, and #termlayer must be positioned in true on-screen px. We
    // measure that convention per-apply into `overlayScale` (below) and correct
    // for it in toViewportRect(), so positioning is right either way. Body is
    // pre-sized to viewport/factor so `zoom` scales it back to exactly the
    // viewport (100vw/factor × factor = 100vw).
    let overlayScale = 1;
    // The native traffic-light inset depends only on `factor`, not window size.
    // macOS resets it on every resize, but a native resize handler in lib.rs
    // re-applies the stored inset synchronously — no JS round-trip, no jitter.
    // So JS re-pins the lights ONLY on a real zoom change (and boot); on resize
    // we pass applyLights=false and leave the dots to the native handler.
    function setUiZoom(factor: number, applyLights = true) {
      const b = document.body.style as any;
      b.transform = '';
      b.transformOrigin = '';
      b.zoom = String(factor);
      // Size body to viewport/factor in EXPLICIT px, NOT vw/vh: under CSS `zoom`,
      // WebKit resolves viewport units in the post-zoom frame while Chrome keeps
      // them pre-zoom, so `calc(100vh/factor)` under-sized the body on WebKit and
      // the footer unpinned from the bottom (floated up at factor > 1).
      // innerWidth/innerHeight are the layout viewport in unzoomed CSS px on both
      // engines (an element's zoom doesn't move the window viewport); `zoom` then
      // scales this box back to exactly the viewport. Re-applied on resize below.
      b.width = (window.innerWidth / factor) + 'px';
      b.height = (window.innerHeight / factor) + 'px';
      // Measure how this WebKit reports zoomed geometry so #termlayer (outside
      // the zoom) can be positioned in true on-screen px. Body renders exactly
      // viewport-wide, so innerWidth / its measured rect width is 1 when gBCR
      // already includes the zoom, and `factor` when it reports pre-zoom px —
      // exactly the multiplier toViewportRect() needs. (This forces a layout
      // read, but zoom changes are rare user gestures.)
      const bw = document.body.getBoundingClientRect().width;
      overlayScale = bw > 0 ? window.innerWidth / bw : 1;
      if (applyLights) ipc.setTrafficLightsZoom(factor).catch(() => {});
    }

    // Apply the saved zoom now so the UI boots at the user's scale. We can't call
    // the full applyZoom() yet — `sessions` is declared further down and the TDZ
    // would crash boot — so just set the chrome zoom here; the per-session refit
    // + termlayer reposition live in applyZoom() for later ⌘+/− presses.
    setUiZoom(ZOOM_STEPS[zoomIndex]);

    // Scale a chat overlay to the current zoom (#1 option-b). Scale ONLY the
    // transcript CONTENT, never the whole box: the box (.cwbox) and the composer
    // inside it stay natural and fill the pane, so the composer holds the real
    // pane bottom at every zoom. The old approach zoomed the whole box, which
    // (nested under the body zoom) DOUBLE-scaled the chat and floated the
    // composer far off the viewport in WebKit. --cw-zoom cascades from the box
    // to the .cw-scale wrapper the renderer builds inside .cw.
    function applyChatZoom(box: HTMLElement, factor = ZOOM_STEPS[zoomIndex]) {
      if (factor === 1) box.style.removeProperty('--cw-zoom');
      else box.style.setProperty('--cw-zoom', String(factor));
      // Undo any full-box zoom/size left by the previous approach.
      (box.style as any).zoom = '';
      box.style.width = '';
      box.style.height = '';
    }

    function applyZoom() {
      try { localStorage.setItem('spike-zoom-index', String(zoomIndex)); } catch {}
      const factor = ZOOM_STEPS[zoomIndex];
      setUiZoom(factor);
      // The terminal isn't zoomed, so it scales by font size instead. Bump each
      // xterm's fontSize to match the chrome's new scale, then refit + reposition
      // the panes over their (now-resized) slots.
      for (const s of sessions) {
        try { s.term.options.fontSize = termFontSize(factor); } catch {}
        // The chat overlay is HTML, not xterm, so it CAN take CSS zoom (the
        // selection-drift reason the terminal can't doesn't apply). It lives in
        // #termlayer outside body's zoom, so ⌘+/− would otherwise skip it
        // entirely — the one surface that stayed put while everything else grew.
        if (s.chatBox) applyChatZoom(s.chatBox, factor);
      }
      reflowAllVisible();   // repositions panes over the resized slots, then refits
    }
    // if we're following the OS and it flips, repaint the terminals.
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (document.documentElement.dataset.theme) return;   // an override is pinned; OS doesn't apply
      retheme();
    });

    // ── wheel-scroll rescue under CSS zoom ────────────────────────────────
    // WebKit (the Tauri webview) mis-hit-tests wheel events when an ancestor
    // carries CSS `zoom` ≠ 1: the gesture latches onto the wrong (non-scrolling)
    // element and the inner pane "sticks" — you can't wheel/trackpad down even
    // though there's more content. overscroll-behavior:contain on the scrollers
    // (see index.html) helps but doesn't fully close it. So when zoomed, we drive
    // the scroll ourselves: find the nearest scrollable ancestor in the wheel's
    // axis and apply the delta directly, which bypasses the broken native routing.
    // Gated on zoom ≠ 1 so the default scale keeps untouched native scrolling
    // (incl. momentum); the terminal is excluded — it lives outside the zoom and
    // owns its own scrollback follow logic.
    const LINE_PX = 16;   // deltaMode 1 (lines) → px; pages (mode 2) use the box.
    let termWheelAcc = 0; // carries sub-line trackpad deltas between wheel events
    function scrollableAncestor(from: EventTarget | null, dx: number, dy: number): HTMLElement | null {
      let el = from as HTMLElement | null;
      while (el && el !== document.body && el.nodeType === 1) {
        const st = getComputedStyle(el);
        const canY = dy && /(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 1;
        const canX = dx && /(auto|scroll)/.test(st.overflowX) && el.scrollWidth > el.clientWidth + 1;
        if (canY || canX) return el;
        el = el.parentElement;
      }
      return null;
    }
    window.addEventListener('wheel', (e: WheelEvent) => {
      if (e.ctrlKey) return;                                          // pinch-zoom — leave to native
      // Terminal: drive xterm's scrollback ourselves at EVERY zoom level,
      // including 1.0. xterm's native wheel handling intermittently "freezes"
      // (the trackpad stops moving the buffer and only arrows recover it) — at
      // 1.0 it's a stale-deltaMode/viewport-sync hiccup, and under zoom ≠ 1
      // WebKit mis-hit-tests the wheel against the zoomed body tree and the
      // gesture latches onto the wrong element.
      //
      // Drive xterm's OWN buffer scroll (scrollLines), NOT the DOM scrollTop.
      // Poking .xterm-viewport.scrollTop loses a race during streaming: xterm
      // adopts a scrollTop change on its NEXT rAF, but each term.write() first
      // re-syncs scrollTop SYNCHRONOUSLY to the buffer's (stale) viewportY — so a
      // wheel tick lands, then the very next write clobbers it back. Reading UP
      // looks fine (you're parked on static lines), but wheeling back DOWN gets
      // repeatedly yanked up: the "can't scroll down, have to press the arrow"
      // bug. scrollLines moves viewportY in the same tick, so the next write's
      // re-sync agrees with where the wheel just put us. xterm scrolls a whole
      // line at a time, so we accumulate sub-line trackpad deltas across events.
      const pane = (e.target as HTMLElement)?.closest?.('#termlayer .pane');
      // The chat overlay (.cwbox) lives INSIDE the pane, over a terminal that is
      // only visibility:hidden — so its .xterm-viewport keeps real, overflowing
      // dimensions. Without this guard a wheel over the chat list matched the
      // pane branch below and got routed into the hidden terminal's scrollback
      // (and preventDefault'd), so the chat itself never scrolled. It bit Codex
      // hardest: its busy TUI fills the scrollback, so the viewport always
      // overflowed and the steal was constant, while a quiet Claude terminal
      // often didn't overflow and the wheel fell through. Chat scrolls its own
      // list — let it fall through to the DOM/native path (#20 wheel).
      const overChat = !!(e.target as HTMLElement)?.closest?.('.cwbox');
      if (pane && !overChat) {
        const sess = sessions.find((s) => s.pane === pane);
        const vp = pane.querySelector('.xterm-viewport') as HTMLElement | null;
        if (sess && vp && vp.scrollHeight > vp.clientHeight + 1) {
          const px = e.deltaY * (e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? vp.clientHeight : 1);
          const cell = vp.scrollHeight / Math.max(1, sess.term.buffer.active.length);  // px per row
          termWheelAcc += px / cell;
          const lines = Math.trunc(termWheelAcc);
          if (lines) {
            termWheelAcc -= lines;
            sess.term.scrollLines(lines);
            sess.following = sess.atBottom();   // scrolled to the tail → follow; up → stay put
          }
          e.preventDefault();
        }
        return;
      }
      if (ZOOM_STEPS[zoomIndex] === 1) return;                        // rest of the UI: native handles 1.0
      const mult = e.deltaMode === 1 ? LINE_PX : 1;                   // mode 2 (page) handled per-target below
      let dx = e.deltaX * mult, dy = e.deltaY * mult;
      const el = scrollableAncestor(e.target, dx, dy);
      if (!el) return;                                                // nothing to scroll → leave it to native
      if (e.deltaMode === 2) { dx = e.deltaX * el.clientWidth; dy = e.deltaY * el.clientHeight; }
      el.scrollTop += dy;
      el.scrollLeft += dx;
      e.preventDefault();                                            // we moved it; don't let native double-scroll
    }, { passive: false });

    // ── external links open as a readable article in the preview ──────────
    // A real-DOM external link must never navigate the top-level webview (that
    // would replace the whole app with the page — full screen, no way back).
    // Default: open it as a readable article in the preview pane. ⌘/Ctrl-click:
    // open the live page in the system browser instead. Same-origin links
    // (in-app #anchors, local assets) pass through; HTML file previews run in a
    // sandboxed iframe and are handled by their own in-frame bridge.
    document.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement)?.closest?.('a') as HTMLAnchorElement | null;
      if (!a || !a.href) return;
      let u: URL;
      try { u = new URL(a.href); } catch { return; }
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== location.origin) {
        e.preventDefault();
        if (e.metaKey || e.ctrlKey) ipc.openExternal(u.href).catch(() => {});
        else openWebArticle(u.href);
      }
    }, true);

    // ── in-chat file links open in the Spike preview, not the browser (#22) ──
    // Agents cite files as markdown links ([North-Star.md](/…/North-Star.md),
    // ./notes/x.md, file:///…). These resolve same-origin, so the external-link
    // handler above ignores them — and a raw click would NAVIGATE the top-level
    // webview to a served file path (or a dead URL), replacing the whole app.
    // Instead: if a chat link points at a file we actually know, open it in the
    // preview pane exactly like `spike open` / a tree click. External http(s)
    // links keep their normal reader behaviour (handled above); only links
    // inside the chat surface (.cw) are intercepted, so the rest of the app —
    // note bodies, wikilinks, the web reader — is untouched.
    function chatFilePath(a: HTMLAnchorElement): string | null {
      let raw = a.getAttribute('href') || '';
      raw = raw.split('#')[0].split('?')[0];                       // drop anchor/query
      if (!raw) return null;
      // Scheme links are not local files: web/mail go to their own handlers,
      // our wikilink:/asset:/data:/blob: sentinels are handled elsewhere. Only
      // file: and bare filesystem paths are ours.
      if (/^(?:https?|mailto|tel|callto|cid|xmpp|sms|wikilink|asset|data|blob):/i.test(raw)) return null;
      // The REF as written — absolute, or relative to somewhere we don't know
      // yet. resolveFileRef (below) turns it into a real path; keeping it
      // unresolved here means a vault-relative ref isn't prematurely nailed to
      // the project root. Any local-file link in chat is intercepted whether or
      // not it resolves: an unhandled same-origin path would NAVIGATE the
      // top-level webview to it, replacing the whole app (the bug #22 fixes).
      // An unresolved file just opens in the preview with its own message.
      if (/^file:/i.test(raw)) {
        try { return normalizeFsPath(decodeURIComponent(new URL(raw).pathname)); } catch { return null; }
      }
      try { raw = decodeURIComponent(raw); } catch { /* keep raw */ }
      if (raw.startsWith('/')) return normalizeFsPath(raw);
      return projectPath ? raw : null;
    }
    document.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement)?.closest?.('a') as HTMLAnchorElement | null;
      if (!a || !a.closest('.cw')) return;                          // chat surface only
      const path = chatFilePath(a);
      if (!path) return;
      e.preventDefault();
      e.stopPropagation();
      // Resolve out-of-tree refs (vault, other repos) before opening.
      resolveFileRef(path).then((abs) => openFile(abs, abs.split('/').pop() || abs, null));
    }, true);

    // ── per-code-block Copy in chat (#25) ────────────────────────────────────
    // The button comes back through innerHTML (enhanceCodeBlocks), so it carries
    // no listener — one delegated handler copies the block's RAW source (the
    // <code>'s textContent, not the highlighted HTML) and flashes "Copied".
    document.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement)?.closest?.('.cw-code-copy') as HTMLElement | null;
      if (!btn) return;
      const code = btn.closest('.cw-code')?.querySelector('pre code, code');
      const text = code ? (code.textContent || '') : '';
      if (!text) return;
      try {
        navigator.clipboard.writeText(text);
        btn.textContent = 'Copied';
        btn.classList.add('done');
        setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('done'); }, 1400);
      } catch { /* clipboard denied — the code is still selectable by hand */ }
    });

    // The current project root. New terminals spawn here; the tree mirrors it.
    // Existing terminals keep whatever cwd they were born with.
    let projectPath: string | null = null; // absolute path, filled by the first /tree fetch
    // Last-loaded config.json (logging / preview / spawn defaults). Null until the
    // boot fetch resolves; every reader guards for that. The settings panel edits it.
    let appConfig = null;
    // In-pane browser bookmarks (config.json `bookmarks`). A leaf is {title, url};
    // a folder is {title, children:[…]} — one level deep. Persisted via patchConfig.
    type Bookmark = { title: string; url?: string; children?: Bookmark[] };
    let bookmarks: Bookmark[] = [];
    function saveBookmarks() { patchConfig({ bookmarks }); }
    // Starred docs, pinned forever in the Home sidebar (config.json `pinned`).
    // A leaf is {path, name}. renderPinnedRef bridges the top-level config load to
    // the nested Home-nav renderer (same pattern as homeOpenDocRef).
    let pinned: { path: string; name: string; icon?: string; title?: string }[] = [];
    // Pins are written by MUTATION, never by "save what I have in memory".
    //
    // The list used to be persisted wholesale — `patchConfig({ pinned })` with
    // whatever this page happened to hold. Any page whose copy was empty or
    // stale then overwrote the real list: the boot race (loadConfig is async, so
    // for the first moment after launch `pinned` is [] — pin something in that
    // window and every earlier pin is erased), a `get_config` that failed, or a
    // second Spike window that started before the pins existed. That is why pins
    // "go away after a reinstall": the first launch is slow, and pinning early
    // wrote a one-item list over the old one.
    //
    // So: re-read the file, apply the change to THAT, write it back. The only
    // thing this page asserts is the edit itself.
    async function mutatePins(fn: (list: typeof pinned) => typeof pinned) {
      let disk = pinned;
      try {
        const list = await ipc.pinsGet();
        if (Array.isArray(list)) disk = list as typeof pinned;
      } catch { /* unreadable pins file — fall back to what we hold */ }
      pinned = fn(disk.slice());
      ipc.pinsSet(pinned).catch(() => {});
      try { logAction('pin_change', { count: pinned.length }); } catch {}
      try { renderPinnedRef && renderPinnedRef(); } catch { /* nav not built yet */ }
    }
    // Load the pins (their own file; migrates the legacy config key) and paint.
    function loadPins() {
      return ipc.pinsGet().then((list) => {
        pinned = Array.isArray(list) ? list as typeof pinned : [];
        try { renderPinnedRef && renderPinnedRef(); } catch { /* nav not built yet */ }
        return pinned;
      }).catch(() => pinned);
    }
    let renderPinnedRef: (() => void) | null = null;
    // Cached engine detection result — populated at boot, re-checked before any
    // spawn-time decision (defaultSpawnEngine, launcher chip enabledness). The
    // null state means "not yet detected" and readers treat every engine as
    // available (optimistic) — the boot fetch resolves before any user input,
    // so this null window is essentially zero.
    let detectedEngines: ipc.EngineDetection | null = null;
    // Rebuilds the Home composer's model/engine menu. Set when that picker is
    // built; called again as soon as engine detection resolves, so an installed
    // Codex appears instead of the pre-detection Claude-only fallback.
    let refreshHomeModelPicker: (() => void) | null = null;
    // Company OS: "Import people from a CSV…" (palette). Assigned when the Home
    // composer wires up, because the import reports its result into the card
    // strip that lives there.
    let importPeopleCsv: (() => void) | null = null;
    const isEngineAvailable = (e: string): boolean => {
      if (e === 'shell') return true;   // shell is always available
      if (!detectedEngines) return true; // pre-detection — assume yes
      if (e === 'claude') return detectedEngines.claude.installed;
      if (e === 'codex')  return detectedEngines.codex.installed;
      return true;                       // Custom engines: we can't know — assume yes
    };

    // ─── terminal session ─────────────────────────────────────────────
    // One Session = one named tab = one xterm + one websocket = one fresh
    // claude. Kept alive in the background when another tab is active.
    let ptyIdSeq = 0;            // unique pty session ids for the IPC channel
    const sessions = [];         // creation order

    // Session names double as IDs (the layout system addresses surfaces by
    // name), so they must be unique. Default tabs read as "Claude" / "Codex"
    // / "Terminal" with no number — we only add " 2", " 3"… on collision.
    function uniqueSessionName(base) {
      const taken = new Set(sessions.map((s) => s.name));
      if (!taken.has(base)) return base;
      for (let n = 2; ; n++) {
        const candidate = base + ' ' + n;
        if (!taken.has(candidate)) return candidate;
      }
    }
    // The first non-empty user message in a lane's transcript — a lane's natural
    // title once it's said something.
    function firstUserText(s: any): string {
      try {
        const turns = s && s.chatStream ? s.chatStream.turns() : [];
        for (const t of turns) {
          if (t.actor !== 'you') continue;
          const txt = (t.blocks || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ').replace(/\s+/g, ' ').trim();
          if (txt) return txt;
        }
      } catch { /* transcript shape guard */ }
      return '';
    }
    // What a Workstreams row shows. Priority: an explicit (renamed) name wins;
    // else an agent-generated title (Haiku names it from the opening message);
    // else the first user message once there is one; else "new chat" while the
    // lane is still empty. Display-only — never the id.
    function workstreamLabel(s: any): string {
      const def = String(s.name || '').match(/^(?:Claude|Codex|Terminal)( \d+)?$/);
      if (!def) return s.name;              // an explicit rename beats the auto-title
      if (s.autoTitle) return s.autoTitle;  // Haiku's 2–5 word name for the session
      const first = firstUserText(s);
      // No ellipsis — the row fades the text out at its edge (CSS mask on .lb),
      // so hand over a generous slice and let the fade do the truncating.
      if (first) return first.length > 90 ? first.slice(0, 90) : first;
      return 'new chat' + (def[1] || '');
    }
    let active: any = null;      // the focused Session (keyboard/resize target)
    // Set by the Home launcher while its landing owns the screen: an OS file drop
    // anywhere on the app should stage into the Home composer, NOT the hidden
    // active pane sitting behind #home. wireNativeDrop consults this first and
    // stands down (returns true) when Home claims the drop. Null when Home is
    // down. Returns false if it declines so normal pane/tree routing continues.
    let homeDropRouter: ((paths: string[]) => Promise<boolean>) | null = null;
    // With pop-out tiling, "focused" and "shown in the terminal column" split:
    // a popped-out session is always visible in its own leaf, so the column
    // needs its own notion of which tab it is showing.
    let colActive: any = null;   // the column's visible Session

    // ─── tab groups (Chrome-style) ────────────────────────────────────
    // A group is { id, name, color, collapsed }. A Session carries groupId
    // (or null). The strip is rendered from this model by renderTabs().
    let gseq = 0;
    const groups = [];           // strip order (saved drag order; see beginGroupReorder)
    // Group accents, cycled as groups are made and offered in the chip picker.
    // A full spin of the wheel at one tasteful medium saturation — warm reds
    // and amber, through olive/green/teal, into blue/indigo/violet and back
    // through orchid/rose — so there's real variety to pick from and adjacent
    // groups never collide. Kept muted (gouache, not crayon) so they sit calm
    // on the cream light theme and stay legible on dark. Twelve hues fill a
    // clean 6×2 grid; the picker (openChipMenu) wraps, so it can grow freely.
    const GROUP_COLORS = [
      '#CB5D5D', // red
      '#D6835A', // coral
      '#E0A24E', // amber
      '#9AAA57', // olive
      '#6FA96A', // green
      '#4CA090', // teal
      '#4C9FB0', // cyan
      '#5A8FC2', // blue
      '#7A78C4', // indigo
      '#9E70BE', // violet
      '#C267A0', // orchid
      '#CB6389', // rose
    ];
    function groupById(id) { return groups.find(g => g.id === id) || null; }
    function groupName(id) { return id ? ((groupById(id) || {}).name || null) : null; }
    // The workspace (group) whose folder IS this cwd, or null. A Home spawn roots
    // at a FOLDER, but a workspace's identity — its injected brief, pinned paths,
    // MCP set, and (the reason this matters) its auto-worktree isolation — hangs
    // off a GROUP. Adopting the matching group binds that identity so a
    // folder-launched session isn't ungrouped and colliding in the shared
    // checkout (#77). Trailing slashes normalized so "/proj" and "/proj/" match.
    function workspaceForCwd(cwd: string) {
      const norm = (p: string) => (p || '').replace(/\/+$/, '');
      const key = norm(cwd);
      if (!key) return null;
      return groups.find((g: any) => g && g.cwd && norm(g.cwd) === key) || null;
    }
    function membersOf(id) { return sessions.filter(s => s.groupId === id); }
    // The subagent children of a lane, in creation order (the sessions array is
    // creation-ordered). Keyed by the parent's ptyId — the stable Spike tab id.
    function childrenOf(s) { return s.ptyId == null ? [] : sessions.filter(c => c.parentId != null && c.parentId === s.ptyId); }
    // Rotating cursor so each subagent gets a distinct identity swatch the first
    // time it's shown (see renderSubagents), stable for the life of the lane.
    let subColorSeq = 0;
    // Reduce a chunk of agent narration to one glanceable strip line: first
    // non-empty line/sentence, markdown stripped-ish, capped so it never wraps
    // past the row's two-line clamp.
    function firstNarrationLine(text: string): string {
      let s = (text || '').replace(/\s+/g, ' ').trim();
      // prefer the first sentence when the opener is a full one; else the whole
      // (capped) line — a mid-thought fragment still reads fine truncated.
      const dot = s.search(/[.!?]\s/);
      if (dot > 24) s = s.slice(0, dot + 1);
      s = s.replace(/^[#>*\-\s]+/, '');          // strip a leading md marker
      return s.length > 120 ? s.slice(0, 119).trimEnd() + '…' : s;
    }
    // A child's live status for the parent's subagents strip, read straight off
    // the child Session's own broker state — which the event router keeps current
    // whether or not the child's chat view is open (chatBrokerEvent updates the
    // fields unconditionally; only the re-render is gated). So the parent can
    // show what each worker is doing without the child ever being on screen.
    function childStatus(c) {
      if (c.chatAwait || c.chatNotice)
        return { cls: 'needs', label: c.chatNotice === 'permission' ? 'Needs permission' : 'Needs you' };
      if (c.chatTurnLive) return { cls: 'run', label: c.chatNow || 'Working' };
      return { cls: 'idle', label: 'Idle' };
    }
    // What a Workstreams row is saying — the one place the launcher's states are
    // decided, so the initial paint (renderWorkstreams) and the live one
    // (Session.syncWorkRow) can never disagree. Four things a row has to tell
    // you, in priority order:
    //   'needs'   — the agent is BLOCKED on you: an open question or a
    //               permission prompt. Nothing moves until you answer.
    //   'working' — a turn is in flight. Normal, not something you act on.
    //   'ready'   — done, and you haven't looked: a turn ENDED (s.ready, from
    //               the broker) while you were elsewhere. "Unread".
    //   ''        — done, and read. The resting row.
    // The order is the whole model: being asked outranks being busy, and being
    // busy outranks having something to read. The two 'done' states differ only
    // by whether you've LOOKED, which is why 'ready' clears on open
    // (clearAttention) while 'needs' clears only on an answer.
    function workRowState(s: any): '' | 'needs' | 'working' | 'ready' {
      if (s.chatAwait || s.chatNotice) return 'needs';
      // chatWorking() is the authoritative "a turn is in flight" read (the same
      // one the thread's loader trusts); chatTurnLive is the raw broker flag it
      // is built on, kept as the fallback for a lane that predates it.
      if (typeof s.chatWorking === 'function' ? s.chatWorking() : s.chatTurnLive) return 'working';
      if (s.ready) return 'ready';
      return '';
    }
    // The same four states, for the surfaces that show SESSIONS rather than
    // workstreams — the strip tab and the sidebar roster row. A plain shell has
    // no turn to be in and no question to ask, so it stays blank and keeps the
    // byte-stream fallback (.attn, from flagActivity) as its only cue.
    function sessionRowState(s: any): '' | 'needs' | 'working' | 'ready' {
      return isAgentLane(s) ? workRowState(s) : '';
    }
    // Would linking `child` under `parent` form a cycle? Walk the parent's own
    // ancestry; if `child` is already somewhere above `parent`, refuse. Guards
    // the "Make subagent of…" picker so a tree can't eat its own tail.
    function wouldCycle(child, parent) {
      let p = parent;
      const byId = (id) => sessions.find(s => s.ptyId === id);
      const seen = new Set();
      while (p) {
        if (p === child) return true;
        if (seen.has(p.ptyId)) break;   // defensive: never loop forever
        seen.add(p.ptyId);
        p = p.parentId ? byId(p.parentId) : null;
      }
      return false;
    }
    // A live session by its pty id (SPIKE_SESSION_ID). The single lookup behind
    // lane attribution, the `spike open` router, and the agent-event dock router.
    function sessionByPty(id): any {
      return id ? (sessions as any[]).find(x => x.ptyId === id) || null : null;
    }
    // The lane (session) that owns a doc, resolved from its ptyId. null when the
    // doc is user-owned or the lane is gone.
    function laneSessionFor(doc): any {
      return doc ? sessionByPty(doc.ownerSessionId) : null;
    }
    // The group a lane belongs to — its live visual group, else the workspace it
    // spawned into (bound at spawn, stable even after a regroup).
    function laneGroupFor(s): any {
      if (!s) return null;
      return groupById(s.groupId) || (s.spawnGroup ? groups.find(g => g.name === s.spawnGroup) : null) || null;
    }
    // The color a preview doc should wear, or null for a neutral (user-owned)
    // doc. Resolves LIVE from the owning lane so regrouping recolors its previews
    // too; falls back to the color frozen when the lane closed (orphaned docs).
    // A user-pinned doc is always neutral.
    function laneColorFor(doc): string | null {
      if (!doc || doc.pinnedByUser) return null;
      const g = laneGroupFor(laneSessionFor(doc));
      if (g && g.color) return g.color;
      return doc.laneColorFrozen || null;
    }
    // A short lane label for the orphan cluster ("N from <lane>"). Prefers the
    // frozen name (lane already gone), else the live group/workspace name.
    function laneNameFor(doc): string {
      if (doc && doc.laneNameFrozen) return doc.laneNameFrozen;
      const g = laneGroupFor(laneSessionFor(doc));
      return (g && g.name) || 'a lane';
    }

    // ─── group persistence (Phase 3) ──────────────────────────────────
    // Groups are durable workspaces now, not just visual clusters: their config
    // (name, color, cwd, description, pinned paths) lives on disk via /groups and
    // survives a reload. The in-memory group carries those fields; the strip only
    // reads name/color/collapsed and renders a group only while it has ≥1 live tab
    // (renderTabs), so an empty-but-saved workspace is invisible here yet still
    // available to the settings panel and "open new tab in this group".
    function groupToJson(g) {
      const j: any = { name: g.name, color: g.color, cwd: g.cwd || '', description: g.description || '',
               pinnedPaths: g.pinnedPaths || [],
               isolation: g.isolation === 'auto-worktree' ? 'auto-worktree' : 'shared',
               mcpEnabled: g.mcpEnabled || [],
               // learned DO/DON'T writing voice (see groupmd.ts). Only serialize
               // when there's content so an untouched workspace stays clean.
               ...(g.voice && ((g.voice.do || []).length || (g.voice.dont || []).length)
                 ? { voice: { do: g.voice.do || [], dont: g.voice.dont || [] } } : {}),
               // per-workspace override of the global Default view: 'terminal' |
               // 'chat', or omitted to inherit Defaults. Only serialize a real
               // choice so an untouched workspace keeps inheriting.
               ...(g.view === 'terminal' || g.view === 'chat' ? { view: g.view } : {}),
               // only serialize a real choice, so an untouched workspace keeps
               // discovering its check set by convention rather than pinning one.
               ...(typeof g.attest === 'string' && g.attest ? { attest: g.attest } : {}),
               // left-to-right position in the strip; durable so a drag-reorder survives reload.
               order: typeof g.order === 'number' ? g.order : 0,
               createdAt: g.createdAt || new Date().toISOString() };
      // legacy field: round-trip an old manual worktree path untouched (the
      // isolation model supersedes it; spawn no longer honors it).
      if (g.worktreePath) j.worktreePath = g.worktreePath;
      return j;
    }
    function persistGroup(g) {
      ipc.saveGroup(groupToJson(g)).catch(() => {});
    }
    function unpersistGroup(name) {
      if (!name) return;
      ipc.deleteGroup(name).catch(() => {});
    }
    // Pull saved workspaces into the model on load. They start member-less (the page
    // reloaded; the ptys are gone), so they don't render until a tab joins them.
    // Build the in-memory group from a saved-workspace json and append it to the
    // model (no disk read — the caller owns that). Shared by hydrateGroups (boot)
    // and the template install path, so a freshly-installed workspace shows up
    // without a reload. Returns the model group.
    function addGroupToModel(j: any) {
      const g = { id: ++gseq, name: j.name, color: j.color || GROUP_COLORS[(gseq - 1) % GROUP_COLORS.length],
                  collapsed: false, cwd: j.cwd || '', description: j.description || '',
                  pinnedPaths: j.pinnedPaths || [],
                  // reader defaults (settings-v2): missing isolation → shared;
                  // mcpEnabled falls back to the legacy mcpServers list.
                  isolation: j.isolation === 'auto-worktree' ? 'auto-worktree' : 'shared',
                  mcpEnabled: j.mcpEnabled || j.mcpServers || [],
                  // learned DO/DON'T writing voice; normalize to {do,dont} arrays.
                  voice: { do: (j.voice && j.voice.do) || [], dont: (j.voice && j.voice.dont) || [] },
                  // per-workspace Default view override; absent → inherit Defaults.
                  view: j.view === 'terminal' || j.view === 'chat' ? j.view : undefined,
                  // path to this workspace's attest check set; absent → look for
                  // attest.yaml beside the workspace folder, else the built-in starter.
                  attest: typeof j.attest === 'string' ? j.attest : undefined,
                  // strip position; legacy/unsaved groups (no order) sink to the end.
                  order: typeof j.order === 'number' ? j.order : groups.length,
                  createdAt: j.createdAt || '',
                  worktreePath: j.worktreePath || '' };
      groups.push(g);
      return g;
    }
    async function hydrateGroups() {
      try {
        const saved = await ipc.listGroups();
        if (!Array.isArray(saved)) return;
        for (const j of saved) {
          if (!j || typeof j.name !== 'string') continue;
          addGroupToModel(j);
        }
        // listGroups returns filename order; the strip honors the saved drag order.
        // Stable sort keeps creation order as the tiebreaker for equal/legacy values.
        groups.sort((a, b) => (a.order - b.order) || (a.id - b.id));
        renderTabs();
      } catch {}
    }

    class Session {
      // Identity and the DOM this lane owns. Declared because the chat view
      // block below reads them; the rest of the class still predates strict
      // typing (see the tsconfig note on the Phase-2 backlog).
      name: string;
      cwd: string;
      pane: HTMLElement;
      term: any;
      // pty transport state (the only declared fields — the rest of the class
      // predates strict typing; see the tsconfig note on the Phase-2 backlog).
      ptyId: string;
      ptyAlive: boolean;
      ptyUnlisteners: ipc.UnlistenFn[];
      // Active-work context for the status line, resolved live on focus from
      // this session's cwd (branch always; PR when `gh` finds one). Display-only.
      autoBranch?: string;
      autoPr?: number;
      autoPrUrl?: string;
      // True when this session's cwd is a linked git worktree — prefixes a quiet
      // tee glyph to the branch readout so an isolated lane reads at a glance.
      autoIsWorktree?: boolean;
      // Theme sync (see syncAgentThemes): whether a half-typed message is
      // sitting in the composer, and a theme value held back until it clears.
      composerDirty: boolean;
      pendingAgentTheme: string | null;
      // The light/dark SIDE this pane is currently painted in — seeded from the
      // COLORFGBG it booted with, then updated whenever we send `/config theme=`.
      // The theme sync gates on THIS (the live pane's state), not on the persisted
      // ~/.claude/settings.json, so a pane that booted dark still gets corrected
      // even when the global setting already reads the target side.
      agentTheme: 'light' | 'dark';
      // The dir the agent actually launched in, returned by pty_spawn. Differs
      // from `cwd` only when auto-worktree isolated this tab into its own
      // worktree; the branch/PR badge resolves from this so an isolated lane
      // shows its own branch, not the workspace's main checkout. `cwd` stays the
      // canonical group root (respawn/layout still target it).
      autoCwd?: string;
      // Handoff spec when this lane boots via pty_handoff_spawn, else null.
      handoff?: any;
      // The engine this lane runs: 'claude' | 'codex' | 'shell', or a Custom
      // command string. Declared because the conversation logic below branches
      // on it (the rest of the class is still on the Phase-2 typing backlog).
      cmd: string;
      // The agent conversation this lane owns (Claude only). Spike mints the id
      // rather than letting Claude Code pick one, because the id IS the
      // transcript filename — see runId below and PtySpawnOpts.agentSessionId.
      agentSessionId?: string;
      // The transcript the context ring reads. For a Claude lane this is known
      // at spawn (it's agentSessionId), so the ring is exact from frame one; for
      // other engines it's latched later from the first agent event.
      runId?: string;
      // Subagent linkage. When set, this lane is a CHILD of the lane whose
      // ptyId this holds — spawned to do a scoped piece of the parent's work.
      // A child lives UNDER its parent in the strip/roster (not as a loose tab
      // and not in a workspace), so a parented lane always has groupId == null.
      // Phase 1 sets this manually (context menu); Phase 2 sets it at spawn.
      parentId?: string;
      // Whether this parent's child subtree is folded in the strip. Display-only,
      // per-lane; children still exist and stay focusable from the roster.
      subCollapsed?: boolean;
      // A stable identity color for this lane WHEN it's a subagent — one swatch
      // per child so the parent's watch strip reads at a glance (assigned once in
      // renderSubagents from GROUP_COLORS, distinct in creation order).
      subColor?: string;
      // Isolation mode for a subagent: 'read' (default) shares the parent's cwd —
      // no worktree, the right call for research/analysis; 'write' forks its own
      // worktree (via handoff) for parallel edits that would otherwise collide.
      subMode?: 'read' | 'write';
      // The task to hand a freshly-spawned subagent as its FIRST message, so it
      // actually starts working (the handoff bundle is context-not-instructions;
      // this is the instruction). Delivered once on boot via the pty. openingSent
      // guards against a double-send.
      openingPrompt?: string;
      openingSent = false;
      openingArmed = false;
      // The Home composer's text, carried onto the freshly-spawned default session
      // so it lands as the first real chat message once the pty is alive — same
      // "wait for the CLI to paint" timing as the subagent opening task.
      pendingChatFirst?: string;
      pendingChatFirstSent = false;
      pendingChatFirstArmed = false;
      deliverPendingChatFirst() {
        if (!this.pendingChatFirst || this.pendingChatFirstSent || !this.ptyAlive) return;
        this.pendingChatFirstSent = true;
        const t = this.pendingChatFirst; this.pendingChatFirst = undefined;
        this.toggleChat(true);   // Home implies the chat surface, not the terminal
        this.chatSend(t);
      }
      // The child's own latest narration line ("investigating apply_patch…"),
      // read from its transcript so the parent's strip shows what it's THINKING,
      // not just which tool it touched. Refreshed on the child's broker events
      // via a private stream, independent of whether its chat view is open.
      subNarration?: string;
      narrStream: chatview.ChatStream | null = null;
      narrOffset = 0;
      narrPolling = false;

      // ── chat view state (see the chat view block below) ──────────────────
      // This lane's calm face: the same session rendered as conversation from
      // the agent's own transcript. All of it is inert until toggled on.
      chatOn = false;
      chatBox: HTMLElement | null = null;         // the overlay inside this.pane
      chatScroll: HTMLElement | null = null;      // the .cw list the renderer owns
      chatTranscriptSig: string | null = null;     // last conversation-DOM signature — skip an identical transcript rebuild
      chatStatusSig: string | null = null;         // last working-indicator signature — status-only ticks don't rebuild the transcript (#20)
      chatPainted = false;                          // has chatview.render laid down the current scroller yet — the ONLY first-paint trigger (not a live child count, which could be misread) (#20 leak)
      chatInput: HTMLTextAreaElement | null = null;
      chatStream: chatview.ChatStream | null = null;
      chatOffset = 0;                             // bytes of transcript consumed
      chatTimer: any = null;                      // the poll interval
      chatPolling = false;                        // in-flight guard, so a slow
                                                  // read can't stack up behind itself
      chatBusy = false;                           // agent mid-turn → show the dots
      chatBusyTimer: any = null;
      // Has this lane ever carried a conversation? A freshly spawned agent
      // paints its own banner, model line and prompt before anyone has typed a
      // word, and those bytes are indistinguishable from work (see chatTouch) —
      // which is why an untouched lane used to open showing a spinner and a
      // Stop button with nothing to stop. Set by sending, and by the transcript
      // having any turn at all (so a resumed session, or one driven from the
      // terminal, still counts).
      chatSpoken = false;
      // Waiting-on-you detection. A permission prompt or an interactive select
      // exists only in the TUI — it never reaches the transcript — so the chat
      // view would otherwise just go quiet forever. The broker's turn events
      // are the honest signal: a turn that started (tool.start) and went quiet
      // without ending (turn.ended) is a turn blocked on the terminal.
      chatTurnLive = false;      // a turn is in flight per the broker
      chatBrokerSeen = false;    // this lane's hooks are actually reporting
      chatAwait = false;         // → show the "needs you" nudge
      chatAsking = false;        // the exact question signal, not a guess
      // The live question, built from the broker event's payload, shown until
      // the transcript's own copy lands. null when no question is open.
      chatLiveAsk: chatview.Action | null = null;
      // The Notification hook is exact where the stuck timer only guesses: it
      // fires the instant a turn blocks on a permission prompt (or another
      // needs-you dialog the TUI owns). Holds the reason so the nudge can name
      // it — 'permission' | 'input' — or null when nothing is blocking.
      chatNotice: string | null = null;
      // A permission prompt to answer inline, built from the notification + the
      // tool that triggered it. null when nothing is awaiting approval. When
      // set, the panel replaces the "answer in the terminal" nudge.
      chatLivePermission: chatview.PermissionAsk | null = null;
      // Re-measures the distance to the bottom and shows/hides the "Latest"
      // button. Held so every render can call it — the content height changes
      // far more often than the scroll position does.
      chatSyncJump: (() => void) | null = null;
      // Where the conversation stood when each pending message was typed — its
      // true place, which the transcript will not record (see the reconcile in
      // renderChat). A turn index AND a block position within it, because the
      // answer you interrupt keeps growing inside the turn it already owns.
      // Index-aligned with chatPending.
      chatPendingAt: Array<{ turn: number; block: number }> = [];
      // Landed turn index → the cut it should be read at, for messages the
      // transcript filed later than they were said. Handed to chatview.render
      // as `anchored`.
      chatAnchored = new Map<number, { turn: number; block: number }>();
      // The convergence loop's state, on the CODER lane: the reviewer's findings,
      // tracked through the coder's per-finding replies. null until a review is
      // sent here. The reviewer lane holds none of this — it only emits findings;
      // this lane owns the exchange because this is where it resolves.
      // The reviewer↔coder negotiation, owned by a lane-agnostic controller (see
      // lane-controller.ts). Session is just its adapter now: it implements
      // LaneHandle and hands the controller two handles + a repaint callback.
      chatReview: LaneReviewExchange | null = null;
      // The reviewer lane the current controller was built for, so a re-send from
      // the same reviewer reuses the controller (keeping in-flight state) and a
      // different reviewer rebuilds it.
      chatReviewPeer: string | null = null;
      // "Tend inbox" state, kept separate from the reviewer↔coder findings loop.
      // chatTending gates the per-poll parse so only the lane that was asked to
      // tend scrapes ```spike-moves```; chatMoves carries approve/skip across
      // re-renders (a fresh parse would reset every decided row to 'proposed').
      chatTending = false;
      chatMoves: chatview.Move[] | null = null;
      // The reviewer lane's header trigger, shown only when this lane has a parent
      // (a coder to report to) and its transcript carries parseable findings.
      chatReviewBtn: HTMLButtonElement | null = null;
      // The raw tool name from the most recent tool.start (PreToolUse). A
      // permission prompt fires right after its tool's PreToolUse, so this is
      // the tool being asked about — the honest, immediate attribution the
      // notification itself doesn't carry.
      chatPromptTool: string | null = null;
      chatStuckTimer: any = null;
      chatTurnStartedAt = 0;     // epoch ms, for the elapsed clock
      chatTickTimer: any = null;
      chatPending: string[] = [];   // typed here, not yet in the transcript
      // Thumbnails of the images sent WITH a message, keyed by its text. The
      // transcript's turns carry only a count (turn.attachments), and the pending
      // bubble carried nothing — so a sent image vanished the instant the tray
      // cleared. This map re-supplies the actual thumbnails to both the pending
      // bubble and the landed "you" turn, so an image you sent stays visible in
      // the conversation. Keyed by trimmed text; it only grows within a session.
      chatSentAtts: Map<string, Array<{ thumb?: string; name: string }>> = new Map();
      chatQueue: string[] = [];     // not yet written to the pty
      // Staged-and-retractable attachments, bound to messages on send. Pure
      // model (chatview.AttachmentQueue) so the retract path is unit-tested.
      attq = new chatview.AttachmentQueue<ChatAtt>();
      chatComposer: HTMLElement | null = null;
      // An OPTIONAL alternate tray for staged-attachment chips. The chat lane
      // uses the chatview.composer's own tray (this.chatComposer); the Home
      // launcher's composer is hand-rolled HTML, not that widget, so its session
      // points this at a home-tray shim. When set, it wins over chatComposer for
      // add/clear so chips land where the user is actually looking.
      attSink: { addAttachment?: (a: { thumb?: string; name?: string; onRemove?: () => void }) => void; clearAttachments?: () => void } | null = null;
      chatError: string | null = null;    // last read failure, shown not swallowed
      chatWindow = CHAT_WINDOW;           // turns rendered, widened on request
      chatSending: string | null = null;   // in flight, awaiting confirmation
      chatSendTimer: any = null;
      chatResubmitTimer: any = null;        // re-nudges a swallowed Enter (see chatDrain)
      chatShowSpinner = false;      // gated by CHAT_SPIN_DELAY_MS
      chatSpinTimer: any = null;
      chatNudge: HTMLElement | null = null;
      chatNudgeBtn: HTMLButtonElement | null = null;
      chatSplit = false;                            // debug: raw PTY docked beside the chat
      chatSplitBtn: HTMLButtonElement | null = null;
      chatTermWrap: HTMLElement | null = null;      // half-width host the xterm moves into while split
      // The session is parked on a pty startup prompt (Codex's "do you trust
      // this directory?" gate). Detected from the byte stream, surfaced in chat
      // as an inline Yes/No ask answered through the SAME channel as an
      // elicitation pick (digit + Enter — see chatAnswerPick). Without this the
      // chat showed "Ready" and swallowed anything typed into a blocked pty.
      chatGateActive = false;
      chatGateAnswered = false;   // latched once answered, so it can't re-fire
      codexOutBuf = '';           // rolling ANSI-stripped tail, for gate detection
      // What the live status line says. The broker names the tool the instant
      // it starts (no specifics — PreToolUse carries only the name), and the
      // next transcript poll refines it to the specific act ("Reading
      // notes.md"). Fast first, precise a beat later.
      chatNow: string | null = null;
      chatNowKind: string | null = null;
      // The connected service behind the live tool, when there is one, so the
      // status line shows Slack's mark rather than a generic globe.
      chatNowMark: chatview.Mark | undefined = undefined;
      // The subagents strip pinned to the top of this lane's chat view — one
      // live row per child (see renderSubagents). Null until buildChat runs;
      // stays empty+hidden for a lane with no children.
      chatSubs: HTMLElement | null = null;
      // The lane's NATIVE (Claude Task/Agent) subagents, polled from the on-disk
      // subagents dir while the chat view is open — the watch strip renders these.
      // Claude spawns them itself; Spike just makes them visible.
      nativeSubs: any[] = [];
      nativeSubsPolling = false;
      // The right-hand subagents panel + the read-only click-in viewer over it.
      chatAside: HTMLElement | null = null;
      chatSubView: HTMLElement | null = null;
      chatSubViewScroll: HTMLElement | null = null;
      viewingSub: any = null;          // the subagent being read (or null)
      subViewStream: any = null;       // its transcript parser
      subViewOffset = 0;
      subsCollapsed = false;           // user collapsed the subagents panel to a rail

      constructor(name, cwd, cmd, group, handoff?, resumeId?: string) {
        this.name = name;
        this.cwd = cwd;
        this.cmd = cmd || 'claude';   // 'claude' (default) | 'codex' | 'shell' — see the + launcher
        // Claim this lane's conversation up front: reuse the id a restore handed
        // us (so we resume that conversation) or mint a new one. Claude-only —
        // Codex has no equivalent flag, so its ring still resolves by cwd until
        // its first agent event, and a shell has no conversation at all.
        if (this.cmd === 'claude') {
          this.agentSessionId = resumeId || crypto.randomUUID();
          // The ring can read the exact transcript from now on. A brand-new
          // conversation has no file yet and reads blank (which is the honest
          // answer); a resumed one paints its real occupancy immediately,
          // without waiting for a turn to land.
          this.runId = this.agentSessionId;
        }
        // When set, this lane boots via pty_handoff_spawn instead of pty_spawn:
        // the backend forks a worktree from the source lane's HEAD, carries its
        // snapshot, and briefs this agent with the composed bundle. Shape:
        // { sourceId, recap, includeFiles, includeBranchDiff, includeWorkspace,
        //   includeActivity }. Null for an ordinary spawn.
        this.handoff = handoff || null;
        this.groupId = null;     // null = ungrouped; else a group id
        // Theme sync (see syncAgentThemes): is a half-typed message sitting in
        // the composer, and is there a theme value waiting for it to clear?
        this.composerDirty = false;
        this.pendingAgentTheme = null;
        // Seed from the theme this pane will boot with (its COLORFGBG, set from
        // effectiveTheme() at spawn below). Kept in step with every /config send.
        this.agentTheme = effectiveTheme();
        // The workspace this tab spawned INTO, if any. Distinct from groupId (the
        // visual membership, which can change later): a group's prompt is injected at
        // spawn and can't change on a live pty, so we bind it here, once, by name.
        this.spawnGroup = group || null;

        // xterm — same config and theme as the original single terminal.
        this.term = new Terminal({
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: termFontSize(ZOOM_STEPS[zoomIndex]),
          lineHeight: 1.2,
          cursorBlink: true,
          allowProposedApi: true,
          // xterm defaults to 1000 lines; a long Claude session scrolls off the
          // top well before that, so keep more history reachable.
          scrollback: 5000,
          theme: xtermTheme(),
        });
        this.fit = new FitAddon.FitAddon();
        this.term.loadAddon(this.fit);
        // The addon's default handler uses window.open(), which Tauri's webview
        // blocks (returns null) -> clicks did nothing. Route through the native
        // opener IPC instead.
        this.term.loadAddon(new WebLinksAddon.WebLinksAddon(
          (_event: MouseEvent, uri: string) => { ipc.openExternal(uri).catch(() => {}); },
        ));

        // the pane that holds this session's xterm. Panes live in #termlayer
        // (outside the UI's zoom) and are positioned over their `.termslot`
        // placeholder by syncTermLayer(); they're never re-parented into the
        // layout itself, so the xterm canvas + scrollback survive every relayout.
        this.pane = document.createElement('div');
        this.pane.className = 'pane';
        termLayer.appendChild(this.pane);
        this.term.open(this.pane);
        // xterm keeps its selection in its own model, not the DOM, so the
        // webview's native Copy can't see it — Cmd+C off a terminal selection
        // silently copied nothing. Wire the clipboard ourselves: Cmd+C copies
        // the selection, Cmd+V pastes (bracketed-paste aware via term.paste),
        // Cmd+A selects all. Ctrl+C/Ctrl+V are left alone — they're SIGINT and
        // the \x16 byte the image-paste flow sends. The webview is a secure
        // origin (tauri.localhost), so navigator.clipboard is available.
        this.term.attachCustomKeyEventHandler((e) => {
          // ⌃Tab / ⌃⇧Tab cycle sessions globally (handled at the window level).
          // Return false so xterm neither renders a tab nor sends one to the pty;
          // the event still bubbles to the window dispatcher, which does the cycle.
          if (e.type === 'keydown' && e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab') return false;
          if (e.type !== 'keydown' || !e.metaKey || e.ctrlKey || e.altKey) return true;
          const k = e.key.toLowerCase();
          if (k === 'c' && this.term.hasSelection()) {
            try { navigator.clipboard?.writeText(this.term.getSelection()); } catch {}
            return false;
          }
          if (k === 'v') {
            navigator.clipboard?.readText().then((t) => { if (t) this.term.paste(t); }).catch(() => {});
            return false;
          }
          if (k === 'a') { this.term.selectAll(); return false; }
          return true;
        });
        this.wireDrop();           // drag an image onto the pane → path into the prompt
        // With tiling, several terminals can be visible at once, so keyboard
        // focus (not visibility) decides which is "active". Clicking into a pane
        // makes it active. The guard makes this a no-op when it's already active,
        // so activate()'s own term.focus() can't recurse.
        this.pane.addEventListener('focusin', () => { if (active !== this) activate(this); });
        // Clicking anywhere in the pane (incl. the padding gutter outside xterm's
        // rows) focuses the terminal, so a stray click never leaves it dead.
        this.pane.addEventListener('mousedown', () => this.term.focus());

        // the tab in the strip is built (and rebuilt) by renderTabs() from the
        // shared model — the Session no longer owns its tab DOM directly.
        this.tab = null;
        // "needs attention" = output landed on this tab while it wasn't the one
        // on screen, and then went quiet (Claude finished a burst). idleTimer
        // debounces so the dot means "done, go look" not "mid-stream".
        this.attention = false;
        // "ready" = a chat turn ENDED on this session while you were looking at
        // something else — the response has fully landed and nothing is waiting
        // on you (distinct from attention, which also fires for questions and
        // permission prompts). Drives the solid chat-bubble in the Workstreams
        // list. Set on the broker's turn.ended, cleared the moment you open it.
        this.ready = false;
        this.idleTimer = null;
        // Are we pinned to the tail? This tracks the user's INTENT, not the
        // viewport's current position: scrolling up (even one line) clears it so
        // streaming output won't yank you off the line you're reading; reaching
        // the bottom, or any keystroke (scrollOnUserInput snaps to bottom), sets
        // it. The write loop pins to the bottom only while this is true. Tracking
        // intent explicitly — instead of re-deriving "near the bottom?" on every
        // write — is what stops the pin from ever mis-guessing.
        this.following = true;

        // pty over Tauri IPC — one pty_spawn carries what the old WS url + init
        // message did (cwd, theme, cmd, group), plus cols/rows so the first
        // paint is sized right. Output streams back over a Channel passed to
        // the spawn itself (wired before the invoke, so no early chunk is
        // lost); exit is a per-id event, registered before the spawn too.
        this.ptyId = `s${++ptyIdSeq}-${Date.now()}`;
        this.ptyAlive = false;       // gates writes/resizes until the pty is live
        this.ptyUnlisteners = [];    // event unsubscribers, disposed in close()
        const boot = async () => {
          try {
            this.ptyUnlisteners.push(await ipc.onPtyExit(this.ptyId, (code) => {
              this.ptyAlive = false;
              this.term.write(`\r\n\x1b[90m[process exited ${code}]\x1b[0m\r\n`);
            }));
            // Fit BEFORE spawn so the pty opens at the pane's real cols/rows.
            // Spawning at xterm's 80x24 construction default made full-width
            // TUI rules wrap into the next row until the first resize landed.
            // By now the caller's activate() has made the pane visible (the
            // await above yielded past it), so fit() measures a real box; on
            // a zero-size pane FitAddon no-ops and activate()'s resize covers it.
            this.fitClamped();
            // Keep the tail pinned only while the user is following it. xterm's
            // own auto-follow needs the viewport EXACTLY at the bottom and
            // silently stops a line short, so we re-snap ourselves. `following`
            // is the user's intent (set by the wheel handler / keystrokes), read
            // BEFORE the write so output that grows the buffer can't flip it.
            const onOut = (d) => {
              const stick = this.following;
              this.term.write(d);
              if (stick) this.term.scrollToBottom();
              if (this !== active) this.flagActivity();
              // A startup gate (Codex trust prompt) blocks the pty before any
              // transcript exists — watch the byte stream for it so the chat
              // reflects "needs you", not "Ready", and can answer it.
              if (this.cmd === 'codex') this.codexGateScan(d);
              this.chatTouch();   // bytes moving = the agent is mid-turn
              // First output means the CLI has painted its prompt — a good moment
              // to hand a subagent its task. Settle briefly so we don't type into
              // a half-drawn TUI. Idempotent (openingSent), with a boot-side
              // fallback below in case no output ever arrives.
              if (this.openingPrompt && !this.openingSent && !this.openingArmed) {
                this.openingArmed = true;
                setTimeout(() => this.sendOpening(), 500);
              }
              // Same idiom for a Home-originated first message, but wait longer:
              // Claude Code's TUI isn't ready to accept input the instant it first
              // paints, and a too-early send is silently dropped (the bug that made
              // the Home message never land). Give it a real beat at its prompt.
              if (this.pendingChatFirst && !this.pendingChatFirstArmed) {
                this.pendingChatFirstArmed = true;
                setTimeout(() => this.deliverPendingChatFirst(), 1400);
              } else if (this.chatQueue.length && !this.pendingChatFirstArmed) {
                // Follow-ups typed before the TUI was ready sit in the queue
                // (chatSend no longer drops them). Flush once the prompt settles,
                // same beat as the first-message arm so the paste isn't eaten.
                this.pendingChatFirstArmed = true;
                setTimeout(() => this.chatDrain(), 1400);
              }
            };
            // A lane with a parent is a subagent → Rust gives it the worker
            // guidance (report up, don't spawn) instead of the orchestrator's.
            // parentId is set right after construction (spawnSubagent), before
            // this async spawn call runs, so it's authoritative here.
            const isSubagent = !!this.parentId;
            const effectiveCwd = this.handoff
              ? await ipc.ptyHandoffSpawn({
                  sourceId: this.handoff.sourceId, id: this.ptyId, cwd,
                  cols: this.term.cols, rows: this.term.rows, theme: effectiveTheme(),
                  cmd: this.cmd as 'claude' | 'codex', recap: this.handoff.recap,
                  agentSessionId: this.agentSessionId,
                  includeFiles: this.handoff.includeFiles,
                  includeBranchDiff: this.handoff.includeBranchDiff,
                  includeWorkspace: this.handoff.includeWorkspace,
                  includeActivity: this.handoff.includeActivity,
                  subagent: isSubagent,
                }, onOut)
              : await ipc.ptySpawn({
                  id: this.ptyId, cwd, cols: this.term.cols, rows: this.term.rows,
                  theme: effectiveTheme(), cmd: this.cmd, group: this.spawnGroup || undefined,
                  // Resume only when a restore handed us an id we'd used before;
                  // a freshly minted one starts its conversation.
                  agentSessionId: this.agentSessionId, resume: !!resumeId,
                  subagent: isSubagent,
                }, onOut);
            this.ptyAlive = true;
            // Fallback delivery of a subagent's opening task: if the CLI never
            // emitted output to trigger the onOut path, hand it the task anyway
            // after a longer beat. sendOpening is idempotent.
            if (this.openingPrompt) setTimeout(() => this.sendOpening(), 1600);
            // Boot-side fallback for the Home first message, in case no output
            // ever triggers the onOut arm. deliverPendingChatFirst is idempotent.
            if (this.pendingChatFirst) setTimeout(() => this.deliverPendingChatFirst(), 2400);
            // Isolation may have relocated us into a worktree — resolve the
            // branch/PR badge from the dir we actually launched in, not the
            // group's configured cwd, so an isolated lane shows its own branch.
            if (effectiveCwd && effectiveCwd !== this.cwd) {
              this.autoCwd = effectiveCwd;
              refreshAutoContext(this);
            }
            if (active === this) { this.resize(); markStatus(); }
          } catch (err) {
            // a failed spawn reports into the xterm (old server behavior).
            (this as any).spawnErr = ipc.errorMessage(err, 'unknown error');
            this.term.write(`\r\n\x1b[31mspawn failed: ${ipc.errorMessage(err, 'unknown error')}\x1b[0m\r\n`);
          }
        };
        boot();
        this.term.onData((d) => {
          // A keystroke makes xterm snap to the bottom (scrollOnUserInput), so
          // we're following the tail again — this is the "press a key and it
          // resumes following" recovery, now recorded instead of re-inferred.
          this.following = true;
          // Track whether a half-typed message is sitting in the composer, so a
          // theme sync never appends `/config …` to it. Enter submits and clears
          // it; printable input (and paste) dirties it. Escape sequences (arrows,
          // fn-keys) start with \x1b and sort below ' ', so they don't count.
          // Backspace is deliberately treated as dirtying: erring toward "wait"
          // only delays the sync, while erring the other way corrupts a message.
          if (d === '\r' || d === '\n') { this.composerDirty = false; flushAgentTheme(this); }
          else if (d >= ' ') this.composerDirty = true;
          if (this.ptyAlive) ipc.ptyWrite(this.ptyId, d).catch(() => {});
        });

        sessions.push(this);
        renderTabs();
        // A session brackets the life of a tab: session_start here, session_end on
        // close() with the elapsed duration. spawnedAt is the clock the duration
        // reads from. (cwd identifies the working tree; group is null until grouped.)
        this.spawnedAt = Date.now();
        logAction('session_start', { name: this.name, cwd, cmd: this.cmd });
      }

      // Is the viewport sitting at the buffer bottom? Pure buffer math (no DOM,
      // no scrollTop), so it's exact. The wheel handler reads this after each
      // scroll to set `following`: reach the bottom → follow; a line short →
      // don't. (The 1-line slop the old pin needed is gone now that scrollLines
      // lands the viewport exactly where we ask.)
      atBottom() {
        const b = this.term.buffer.active;
        return (b.baseY - b.viewportY) <= 0;
      }

      // The latest in-progress assistant prose from the LIVE terminal buffer,
      // as HTML — so the chat can show a reply AS it streams instead of waiting
      // for the whole message to reach the transcript (the "chat is slower than
      // the terminal" gap). Fail-safe: returns null when it can't confidently
      // find assistant prose, so the caller shows the plain loader, never a dump.
      // See parsePtyStreamText for the formatting; the transcript takes over as
      // the clean source the instant the message completes.
      chatPtyStreamHtml(): string | null {
        try {
          const buf = this.term.buffer.active;
          const bottom = buf.baseY + this.term.rows - 1;
          const startY = Math.max(0, bottom - 240);
          const lines: string[] = [];
          for (let y = startY; y <= bottom; y++) {
            const ln = buf.getLine(y);
            lines.push(ln ? ln.translateToString(true) : '');
          }
          return parsePtyStreamText(lines);
        } catch { return null; }
      }

      // fit() to the pane, then floor the result so a transient sliver box can't
      // drive the pty into a hard-wrapping width (see MIN_PTY_COLS). xterm ends
      // up a few cols wider than the degenerate box for that one churn frame;
      // the next real fit() corrects it. Genuine narrow panes (≥ the splitter
      // floor) sit above the floor and are never touched.
      fitClamped() {
        try { this.fit.fit(); } catch {}
        const c = Math.max(this.term.cols, MIN_PTY_COLS);
        const r = Math.max(this.term.rows, MIN_PTY_ROWS);
        if (c !== this.term.cols || r !== this.term.rows) {
          try { this.term.resize(c, r); } catch {}
        }
      }

      resize() {
        // A fit() that changes the row count can leave the viewport a line short
        // of the buffer's true bottom. If we were following the tail, restore it
        // past the refit; if the user had scrolled up, leave them where they are.
        const stick = this.following;
        this.fitClamped();
        if (stick) this.term.scrollToBottom();
        if (this.ptyAlive)
          ipc.ptyResize(this.ptyId, this.term.cols, this.term.rows).catch(() => {});
      }

      // Drag an image onto the terminal → the bytes go to the server, which
      // writes a temp file and hands back its path; we type that path into the
      // prompt so Claude Code attaches the image (browsers won't give us the
      // real dropped path, so we round-trip the bytes). preventDefault on
      // dragover is what tells the browser we accept the drop instead of
      // navigating to the file.
      wireDrop() {
        const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
        this.pane.addEventListener('dragover', (e) => { stop(e); this.pane.classList.add('dropping'); });
        this.pane.addEventListener('dragleave', (e) => { stop(e); this.pane.classList.remove('dropping'); });
        this.pane.addEventListener('drop', async (e) => {
          stop(e);
          this.pane.classList.remove('dropping');
          const dt = e.dataTransfer;
          if (!dt) return;

          // macOS hands a browser drop several representations at once. We grab
          // them all — both to try every ingestion path and to log exactly what
          // arrived when one fails. Note: getData() only works inside 'drop'.
          const fileList = [...(dt.files || [])];
          const getData = (t) => { try { return dt.getData(t) || ''; } catch { return ''; } };
          const uriList = getData('text/uri-list');
          const plain = getData('text/plain');

          // In-app tree drag (a page/folder dropped on the terminal): no bytes to
          // ingest — just type its absolute path at the cursor so Claude can act
          // on it. Take this path before the image-ingestion logic below.
          const spikePath = getData('application/x-spike-path');
          if (spikePath) {
            if (this.ptyAlive) ipc.ptyWrite(this.ptyId, spikePath + ' ').catch(() => {});
            logAction('drop_tree_path', { path: spikePath });
            return;
          }

          // In Tauri the OS-level handler (wireNativeDrop) also receives this
          // drop — with a real path, even for the screenshot thumbnail the DOM
          // can't read. Both channels fire on macOS, so the DOM side stands
          // down for external files; everything below is web-only.
          if ('__TAURI_INTERNALS__' in window) return;

          // Diagnostics: a dropped screenshot that fails should never look like
          // nothing happened. `spike context` / today's log shows this probe so
          // we can see whether bytes or a file:// path actually came through.
          logAction('drop_probe', {
            files: fileList.map(f => ({ name: f.name, type: f.type, size: f.size })),
            items: [...(dt.items || [])].map(it => ({ kind: it.kind, type: it.type })),
            uriList, plain,
          });

          // The screenshot THUMBNAIL arrives as a zero-byte file promise — its
          // bytes are unreachable to the page, but a file:// path usually rides
          // along in uri-list/plain. The server has fs access and reads it the
          // same way a native terminal would.
          const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|avif|svg|heic|tiff?)$/i;
          const filePaths = [uriList, plain].join('\n').split(/[\r\n]+/)
            .map(s => s.trim())
            .filter(s => /^file:\/\//i.test(s) && IMG_RE.test(s))
            .map(s => { try { return decodeURIComponent(new URL(s).pathname); } catch { return ''; } })
            .filter(Boolean);

          let staged = 0;
          let failed = 0;

          // 1) Byte-backed image files (Finder drag, saved screenshot file).
          for (const f of fileList) {
            if (!f.type.startsWith('image/') || f.size === 0) continue;  // 0 bytes = promise, handled below
            try {
              // Keep the whole data URL: its tail is what the backend wants
              // (b64 after the comma), and the URL itself is a free, always-
              // valid thumbnail for the composer tray.
              const dataUrl = await new Promise<string>((resolve, reject) => {
                const r = new FileReader();
                r.onload = () => resolve(String(r.result));
                r.onerror = reject;
                r.readAsDataURL(f);
              });
              const path = await ipc.dropImage(dataUrl.split(',')[1] || '', f.name);
              // Staged, not delivered: in chat mode it waits (retractable) until
              // send; in the raw terminal stageAttachment writes it immediately.
              this.stageAttachment({ route: 'typed', path, thumb: dataUrl, name: f.name });
              staged++;
            } catch { failed++; }
          }

          // 2) file:// paths (screenshot thumbnail / any promised file) — the
          //    backend reads them off disk directly.
          for (const p of filePaths) {
            try {
              const path = await ipc.ingestPath(p);
              this.stageAttachment({ route: 'typed', path, thumb: ipc.rawSrc(path), name: p.slice(p.lastIndexOf('/') + 1) });
              staged++;
            } catch { failed++; }
          }

          if (failed && !staged)
            // The macOS screenshot *thumbnail* is a file promise: the browser
            // gets metadata but no real bytes and no file:// path (verified
            // 2026-06-10, uri/plain both empty). Nothing the page can do; a
            // native (Tauri) build gets the OS path. Saved files drag fine.
            this.term.write(`\r\n\x1b[33m[spike] can't read a dragged screenshot thumbnail. macOS gives the browser no file path and no real bytes, so drag the saved file from your Desktop instead. (The Spike app reads the thumbnail natively.)\x1b[0m\r\n`);
          else if (failed)
            this.term.write(`\r\n\x1b[33m[spike] attached ${staged}, skipped ${failed}\x1b[0m\r\n`);
        });
      }

      // Output arrived on a backgrounded tab. Wait for it to settle, then mark
      // the tab so the dot reads as "Claude finished, you haven't looked" — not
      // a flicker on every streamed chunk. Each new chunk pushes the timer out.
      flagActivity() {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
          this.idleTimer = null;
          this.attention = true;
          // Only for a lane with no broker state to speak for it — an agent's
          // tab says working / unread / needs-you exactly, and must not also
          // carry a guess. (A plain shell has nothing else, so this is its cue.)
          if (!sessionRowState(this)) {
            if (this.tab) this.tab.classList.add('attn');   // live update without a full re-render
            if (this.panelRow) this.panelRow.classList.add('attn');   // mirror onto the sidebar roster row
            if (this.wsvRow) this.wsvRow.classList.add('attn');   // …and the workspace-detail Active row
          }
          this.syncRowStates();
          // The Workstreams "done" glyph is driven by s.ready (a precise
          // turn.ended), NOT this idle heuristic — the heuristic can't tell a
          // finished response from a paused question, so it must not light it.
        }, 2500);   // wait out mid-response pauses (tool calls, thinking) before flagging
      }

      // Looked at → clear the dot and any pending settle.
      clearAttention() {
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
        this.attention = false;
        this.ready = false;   // opening it clears the "done, go look" glyph
        if (this.tab) this.tab.classList.remove('attn');
        if (this.panelRow) this.panelRow.classList.remove('attn');
        if (this.wsvRow) this.wsvRow.classList.remove('attn');
        // NOT a blanket removal: looking settles "unread", but a question still
        // open is still your turn and a live turn is still running — so the
        // state decides what stays lit on every surface.
        this.syncRowStates();
      }

      /**
       * Repaint every row this lane owns — the Home launcher's Workstreams row,
       * the strip tab, the sidebar roster row, the workspace-detail Active row —
       * from its live state, without a full re-render (the trick flagActivity
       * has always used for the dot). Without this, a question landing on a
       * BACKGROUNDED lane changed nothing on screen, which is why "waiting on
       * you" had no visual anywhere.
       *
       * The launcher row uses 'ready' for unread (its glyph writes the message
       * inside the bubble); the tab and roster use the same class on their state
       * dot. One vocabulary, three surfaces.
       */
      syncRowStates() {
        const work = workRowState(this);
        if (this.workRow) {
          this.workRow.classList.toggle('needs', work === 'needs');
          this.workRow.classList.toggle('working', work === 'working');
          this.workRow.classList.toggle('ready', work === 'ready');
        }
        const st = sessionRowState(this);
        for (const row of [this.tab, this.panelRow, this.wsvRow]) {
          if (!row) continue;
          row.classList.toggle('needs', st === 'needs');
          row.classList.toggle('working', st === 'working');
          row.classList.toggle('unread', st === 'ready');
          // A broker-backed state is exact; the idle-timer guess it supersedes
          // must not keep a second cue lit beside it.
          if (st) row.classList.remove('attn');
        }
      }

      // ── chat view ──────────────────────────────────────────────────────
      // The same session, rendered as a conversation instead of a TUI. Built
      // for people who don't live in a terminal: no ANSI, no monospace wall,
      // tool calls folded into one quiet line.
      //
      // It renders from the transcript the agent CLI already writes (see
      // chatview.ts on why the PTY stream is the wrong source), and it sends by
      // typing into the very same pty. That is what keeps it a formatting layer
      // rather than a second client: every feature the CLI grows — slash
      // commands, resume, plan mode, permission prompts — still works, and the
      // raw terminal is alive underneath the whole time, one click away.
      //
      // The overlay lives inside this.pane, which already lives in #termlayer
      // and is positioned over its slot by syncTermLayer(). So it inherits the
      // entire tiling/zoom/geometry story for free and needs no layout changes.

      /** Only an agent lane has a transcript; a shell has nothing to render. */
      chatCapable() { return CHAT_ENABLED && isAgentLane(this); }

      toggleChat(on?: boolean) {
        const next = on == null ? !this.chatOn : on;
        if (next === this.chatOn || (next && !this.chatCapable())) return;
        this.chatOn = next;
        this.pane.classList.toggle('chatting', next);
        if (next) {
          this.buildChat();
          this.chatPoll();
          this.chatTimer = setInterval(() => this.chatPoll(), CHAT_POLL_MS);
          this.chatTick();
          // Focus the composer, not the hidden xterm — otherwise the first
          // keystroke goes into a terminal nobody can see.
          setTimeout(() => this.chatInput && this.chatInput.focus(), 0);
        } else {
          if (this.chatTimer) { clearInterval(this.chatTimer); this.chatTimer = null; }
          if (this.chatTickTimer) { clearInterval(this.chatTickTimer); this.chatTickTimer = null; }
          // Leaving chat gives the terminal the whole pane back — a split that
          // outlived the chat would leave the xterm boxed into half of it.
          if (this.chatSplit) this.toggleChatSplit(false);
          this.term.focus();
        }
        renderTabs();
        logAction('chat_view', { name: this.name, on: next });
      }

      /**
       * Debug side-by-side: dock this session's raw xterm to the right of the
       * chat overlay so the JSONL-rendered conversation can be read against the
       * terminal it is derived from.
       *
       * The xterm normally fills the pane and is hidden under the chat overlay.
       * FitAddon sizes the pty from the xterm's PARENT, so a coherent half-width
       * terminal means giving it a half-width parent — we move the xterm node
       * into a right-half wrapper and refit, then move it back on the way out.
       * Returns the new state so the button can reflect it.
       */
      toggleChatSplit(on?: boolean): boolean {
        const next = on == null ? !this.chatSplit : on;
        if (next === this.chatSplit) return next;
        this.chatSplit = next;
        if (next) {
          if (!this.chatTermWrap) {
            const w = document.createElement('div');
            w.className = 'cwdbgterm';
            this.pane.appendChild(w);
            this.chatTermWrap = w;
          }
          this.chatTermWrap.appendChild(this.term.element);
        } else if (this.chatTermWrap && this.term.element.parentElement === this.chatTermWrap) {
          // Back to a direct pane child, where the .chatting rule hides it again.
          this.pane.appendChild(this.term.element);
        }
        this.pane.classList.toggle('dbgsplit', next);
        if (this.chatSplitBtn) this.chatSplitBtn.classList.toggle('on', next);
        // Reflow the pty to its new width on the next frame, once the box has
        // actually resized — fitting against the old geometry would wrap it.
        requestAnimationFrame(() => {
          this.fitClamped();
          if (this.ptyAlive) ipc.ptyResize(this.ptyId, this.term.cols, this.term.rows).catch(() => {});
          try { this.term.refresh(0, this.term.rows - 1); } catch {}
          if (next) this.term.scrollToBottom();
        });
        return next;
      }

      buildChat() {
        if (this.chatBox) return;
        const box = document.createElement('div');
        box.className = 'cwbox';
        // The only chrome: a way back to the terminal. Deliberately a word and
        // not an icon — the person this view is for should be able to read it.
        const top = document.createElement('div');
        top.className = 'cwtop';
        const flip = document.createElement('button');
        flip.type = 'button';
        flip.className = 'cwflip';
        flip.innerHTML = icon('terminal', 14) + '<span>Terminal</span>';
        flip.title = 'Show the raw terminal for this session';
        flip.addEventListener('click', () => this.toggleChat(false));

        // Debug side-by-side: the raw PTY docked to the right of the chat, so the
        // JSONL-rendered conversation can be watched against the terminal it's
        // derived from. This is the only place a streaming divergence (a row the
        // parser drops, a stall the transcript never shows) is visible next to
        // what the chat made of it. A debug affordance — see toggleChatSplit.
        const dbg = document.createElement('button');
        dbg.type = 'button';
        dbg.className = 'cwsplit';
        dbg.innerHTML = icon('dock-right', 14) + '<span>Split</span>';
        dbg.title = 'Show the raw terminal beside the chat (debug)';
        dbg.addEventListener('click', () => dbg.classList.toggle('on', this.toggleChatSplit()));
        this.chatSplitBtn = dbg;
        top.append(dbg, flip);

        // Reviewer → coder trigger. Lives on the reviewer lane's header and stays
        // hidden until this lane both has a parent (the coder to report to) and
        // has emitted a parseable ```spike-findings block. Clicking it hands the
        // findings to the coder and opens the convergence panel there. Manual by
        // design — you decide when the review is ripe, so it never fires on a
        // half-finished pass. renderChat toggles its visibility + count.
        const review = document.createElement('button');
        review.type = 'button';
        review.className = 'cwreview';
        review.title = 'Send these findings to the coder lane';
        review.addEventListener('click', () => this.sendReviewToCoder());
        top.appendChild(review);
        this.chatReviewBtn = review;

        // Subagents panel: the vertical list of this session's native subagents,
        // docked to the RIGHT of the conversation (not a top strip). renderSubagents
        // fills it; clicking a card opens that subagent's transcript read-only in
        // the viewer overlay. Empty + hidden until there are subagents.
        const subs = document.createElement('div');
        subs.className = 'cwsubs';
        this.chatSubs = subs;

        const scroller = document.createElement('div');
        scroller.className = 'cw';

        // Scrolling up to read must not mean losing the live end of the
        // conversation. The renderer already refuses to yank a detached
        // viewport back down; this is the way back.
        const jump = document.createElement('button');
        jump.type = 'button';
        jump.className = 'cwjump';
        jump.title = 'Jump to the latest';
        jump.innerHTML = icon('chevron-down', 14) + '<span>Latest</span>';
        jump.addEventListener('click', () => {
          scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
        });
        const syncJump = () => {
          const away = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
          jump.classList.toggle('show', away > 160);
        };
        scroller.addEventListener('scroll', syncJump, { passive: true });
        // Scrolling is not the only way the distance-to-bottom changes. The
        // conversation shrinks when a panel resolves or the window re-lays out,
        // and re-rendering restores scrollTop to the value it already had — so
        // no scroll event fires and the button was left asserting there is more
        // below when the whole conversation now fits on screen. Re-measure on
        // every geometry change, and after every render (see renderChat).
        this.chatSyncJump = syncJump;
        if (typeof ResizeObserver === 'function') {
          new ResizeObserver(() => syncJump()).observe(scroller);
        }

        // The nudge. Not a reimplementation of the prompt — reimplementing a
        // TUI dialog is exactly the coupling this layer exists to avoid — just
        // an honest handoff to the place the question actually is.
        const nudge = document.createElement('div');
        nudge.className = 'cwnudge';
        const nt = document.createElement('span');
        nt.className = 'cwnudge-t';
        nt.textContent = 'This session is waiting for an answer in the terminal.';
        const nb = document.createElement('button');
        nb.type = 'button';
        nb.textContent = 'Open terminal';
        nb.addEventListener('click', () => this.toggleChat(false));
        nudge.append(nt, nb);
        this.chatNudge = nudge;
        this.chatNudgeBtn = nb;

        const comp = chatview.composer(
          (text) => this.chatSend(text),
          'Ask for anything',
          () => this.chatStop(),
          () => this.chatPickFiles(),
        );
        this.chatComposer = comp;

        // Order matters: the fade lays over the scroller's last strip, so it
        // must come after it and before anything with its own background.
        const fade = document.createElement('div');
        fade.className = 'cwfade';

        // The conversation column. A read-only viewer overlay sits on top of it,
        // shown when you click into a subagent to read its transcript.
        const main = document.createElement('div');
        main.className = 'cwmain';
        const subview = document.createElement('div');
        subview.className = 'cwsubview';
        const svTop = document.createElement('div');
        svTop.className = 'cwsubview-top';
        const svBack = document.createElement('button');
        svBack.type = 'button'; svBack.className = 'cwsubview-back';
        svBack.innerHTML = icon('chevron-left', 14) + '<span>Subagents</span>';
        svBack.addEventListener('click', () => this.closeSubagentView());
        const svName = document.createElement('span');
        svName.className = 'cwsubview-name';
        svTop.append(svBack, svName);
        const svScroll = document.createElement('div');
        svScroll.className = 'cw cwsubview-scroll';
        subview.append(svTop, svScroll);
        this.chatSubView = subview;
        this.chatSubViewScroll = svScroll;
        main.append(top, scroller, jump, fade, nudge, comp, subview);

        // The subagents panel docks to the right of the conversation column.
        const aside = document.createElement('div');
        aside.className = 'cwaside';
        aside.append(subs);
        this.chatAside = aside;

        box.append(main, aside);
        // Match the box to the live zoom the moment it exists, so a chat opened
        // while zoomed in doesn't flash at 1× before the next ⌘+/− press.
        applyChatZoom(box);
        this.pane.appendChild(box);
        this.chatBox = box;
        this.chatScroll = scroller;
        this.chatInput = comp.querySelector('textarea');
        // ⌘V an image straight into the composer. A pasted image arrives as a
        // file item on the clipboard; we route it to the tray + the agent like
        // any drop. Text pastes fall through to the browser's default.
        if (this.chatInput) {
          this.chatInput.addEventListener('paste', (e) => {
            const items = [...((e.clipboardData && e.clipboardData.items) || [])];
            const imgs = items.filter((it) => it.kind === 'file' && it.type.startsWith('image/'));
            if (!imgs.length) return;   // plain text — let it paste normally
            e.preventDefault();
            for (const it of imgs) {
              const file = it.getAsFile();
              if (file) this.attachPastedImage(file);
            }
          });
        }
        this.chatStream = new chatview.ChatStream(this.cmd === 'codex' ? 'codex' : 'claude');
        this.chatOffset = 0;
        // Paint the empty state at once. The poll only re-renders when the
        // transcript CHANGES, so a lane with nothing on disk yet (every new
        // session) would otherwise sit as a blank rectangle until the first
        // turn landed — reading as broken, and never showing the openers that
        // are the whole point for someone who has never driven an agent.
        this.renderChat();
      }

      /**
       * Queue a message for this lane. Never writes to the pty directly.
       *
       * Two sends in quick succession used to arrive as one: "sup" then
       * "todos?" reached the agent as "suptodos?". Nothing merged them here —
       * both bracketed pastes landed in the TUI's composer before it had
       * processed the first Enter, so the agent genuinely saw a single line.
       * The only fix is to stop overlapping them: one message goes out at a
       * time, and the next waits until the transcript confirms the last.
       */
      chatSend(text: string) {
        // Don't silently drop a message sent before the pty is live — that read
        // as "it just stayed at home, nothing sent". Enqueue it and show it
        // optimistically; chatDrain won't write until ptyAlive, and the pty's
        // first-output arm kicks a drain once the TUI can accept input.
        // Typing your own answer to a question: the pty is in a select, so a
        // normal bracketed paste would land as option-filtering keystrokes, not
        // a reply. Route it through the escape-first path instead (only reachable
        // once live). This is the "click in and ask more" case.
        if (this.ptyAlive && this.chatQuestionOpen()) { this.chatAnswerWords(text); return; }
        // Show it immediately. The pty gets it soon, but the transcript only
        // gains the row once the agent picks it up — which, mid-turn, can be a
        // long wait. Painting it straight away is the difference between "sent"
        // and "swallowed".
        this.chatPending.push(text);
        this.chatPendingAt.push(this.chatTypedPoint());
        this.chatQueue.push(text);
        this.chatSpoken = true;   // from here, bytes on this lane really are work
        // Bind the staged attachments to THIS message — they are delivered to
        // the pty just before the message text, in chatDrain. Committing here
        // (and clearing the live tray) means a second message composed while
        // this one is still queued starts clean, and a × after send has nothing
        // to retract (the chip is gone and the set is already committed).
        // Remember the thumbnails BEFORE commit clears the staged set, so the
        // sent bubble (and, once it lands, the transcript turn) can show them.
        const staged = this.attq.pending();
        if (staged.length) this.chatSentAtts.set(text.trim(), staged.map((a) => ({ thumb: a.thumb, name: a.name })));
        this.attq.commit();
        (this.attSink || this.chatComposer as any)?.clearAttachments?.();
        this.renderChat();
        this.chatDrain();
      }

      /**
       * Where in the conversation a message being sent right now belongs.
       *
       * If the agent is mid-answer, that is INSIDE the turn it already owns —
       * after the blocks it has written so far — because the rest of its answer
       * will be appended to that same turn. Anywhere else, it is simply the
       * next turn. This is the one fact the transcript will never carry (see
       * anchorPlan in chatview), so it is recorded at the moment of sending.
       */
      chatTypedPoint(): { turn: number; block: number } {
        const turns = this.chatStream ? this.chatStream.turns() : [];
        const last = turns[turns.length - 1];
        if (last && last.actor === 'agent') return { turn: turns.length - 1, block: last.blocks.length };
        return { turn: turns.length, block: 0 };
      }

      /**
       * Deliver an agent-authored message into this lane WITHOUT going through the
       * composer — the convergence loop's channel for injecting a review ask or a
       * ruling. Reuses the same one-at-a-time queue (chatDrain) as a typed send, so
       * it inherits the bracketed-paste that keeps a multi-line block from
       * submitting on every newline, and the serialization that stops two messages
       * merging. Shows as a pending bubble (you see exactly what was sent). Returns
       * false when the lane is dead, so the caller can escalate rather than lose it.
       */
      injectMessage(text: string): boolean {
        if (!this.ptyAlive) return false;
        this.chatPending.push(text);
        this.chatPendingAt.push(this.chatTypedPoint());
        this.chatQueue.push(text);
        this.chatSpoken = true;
        // Commit an (empty) attachment batch so message↔attachment alignment in
        // the queue holds — chatDrain pairs them by position.
        this.attq.commit();
        if (this.chatOn) this.renderChat();
        this.chatDrain();
        return true;
      }

      /**
       * Stage an attachment for the message being composed.
       *
       * In chat mode the attachment is HELD in a pending list and mirrored by a
       * tray chip — nothing reaches the agent until the message is sent (see
       * flushAttachments, called from chatDrain). That is what lets the chip's ×
       * genuinely retract it: removal splices it out of the pending list before
       * it is ever delivered. In the raw terminal there is no composer to hold
       * it, so the path/image goes straight to the pty the moment it lands,
       * exactly as before.
       */
      stageAttachment(a: ChatAtt) {
        if (this.chatOn) {
          // The disposer the queue hands back IS the chip's × behaviour: it
          // removes the attachment from the staged set before it's ever bound to
          // a message, so a retracted file never reaches flushAttachments.
          const off = this.attq.stage(a);
          const sink = this.attSink || (this.chatComposer as any);
          sink?.addAttachment?.({ thumb: a.thumb, name: a.name, onRemove: off });
        } else {
          this.flushAttachments([a]);
        }
      }

      /**
       * Deliver a set of staged attachments to the pty, leaving the cursor ready
       * for the message text. Clipboard images go via Ctrl+V (Claude reads the
       * clipboard on paste, so they are spaced out); everything else is typed as
       * a path. A clipboard failure falls back to typing the path.
       */
      private async flushAttachments(atts: ChatAtt[]) {
        if (!atts.length || !this.ptyAlive) return;
        const typed: string[] = [];
        let pasted = 0;
        for (const a of atts) {
          if (a.route === 'clip') {
            try {
              if (pasted) await new Promise((r) => setTimeout(r, 300));
              await ipc.clipboardSetImage(a.path);
              if (this.ptyAlive) await ipc.ptyWrite(this.ptyId, '\x16');   // Ctrl+V
              pasted++;
              continue;
            } catch { /* clipboard route failed — fall through to a typed path */ }
          }
          typed.push(a.path);
        }
        if (typed.length && this.ptyAlive) await ipc.ptyWrite(this.ptyId, typed.join(' ') + ' ').catch(() => {});
      }

      /**
       * The "+" button: open the native file picker and attach what's chosen.
       */
      async chatPickFiles() {
        try {
          const paths = await ipc.pickFiles();
          if (paths.length) await this.attachPaths(paths);
        } catch { /* dialog failed or was cancelled — nothing to attach */ }
        if (this.chatInput) this.chatInput.focus();
      }

      /**
       * Stage a set of file paths, exactly as a native drop would.
       *
       * Same routing the drop handlers use, so the "+" picker and a drag behave
       * identically: a PNG/JPEG into a Claude lane goes via the clipboard (clean
       * [Image #N], no /tmp path in the prompt); any other image is staged to a
       * temp file and its path typed; a non-image is typed as-is. In chat mode
       * nothing ships until the message is sent, so each chip's × can take it
       * back before the agent ever sees it.
       */
      async attachPaths(paths: string[]) {
        if (!paths.length || !this.ptyAlive) return;
        const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|avif|svg|heic|tiff?)$/i;
        const CLIP_RE = /\.(png|jpe?g)$/i;
        const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
        let staged = 0, failed = 0;
        for (const p of paths) {
          if (CLIP_RE.test(p) && (!this.cmd || this.cmd === 'claude')) {
            this.stageAttachment({ route: 'clip', path: p, thumb: ipc.rawSrc(p), name: base(p) });
            staged++;
            continue;
          }
          if (IMG_RE.test(p)) {
            try { const s = await ipc.ingestPath(p); this.stageAttachment({ route: 'typed', path: s, thumb: ipc.rawSrc(s), name: base(p) }); staged++; }
            catch { failed++; }
          } else {
            // A non-image (PDF, .md, any file): typed as a path, shown as the
            // file-glyph chip. Deferred like the rest so its × can retract it.
            this.stageAttachment({ route: 'typed', path: p, name: base(p) });
            staged++;
          }
        }
        logAction('chat_attach_paths', { count: paths.length, staged, failed, name: this.name });
      }

      /**
       * A ⌘V'd image: stage the bytes to a temp file, then stage that path as an
       * attachment. Going through a real file (drop_image) guarantees the
       * clipboard route a readable source, so a paste lands Claude's [Image #N]
       * the same way a drop does — and, staged, it stays retractable until send.
       */
      async attachPastedImage(file: File) {
        if (!this.ptyAlive) return;
        try {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result));
            r.onerror = reject;
            r.readAsDataURL(file);
          });
          const staged = await ipc.dropImage(dataUrl.split(',')[1] || '', file.name || 'pasted.png');
          const clip = /image\/(png|jpe?g)/.test(file.type) && (!this.cmd || this.cmd === 'claude');
          this.stageAttachment({ route: clip ? 'clip' : 'typed', path: staged, thumb: dataUrl, name: file.name || 'pasted image' });
        } catch { /* couldn't read the paste — nothing lands, no half-state */ }
      }

      /**
       * Interrupt the running turn.
       *
       * Esc is what both TUIs treat as "stop what you're doing", and it is the
       * one control this view could not do without: someone watching an agent
       * head the wrong way needs an obvious way to halt it, not a hunt for a
       * terminal they were promised they'd never need. Esc, not Ctrl-C — Ctrl-C
       * would kill the CLI and take the session with it.
       *
       * Anything still queued is dropped too. Stopping means stopping, not
       * "stop this one and then fire the next three at it".
       */
      chatStop() {
        if (!this.ptyAlive) return;
        this.chatQueue = [];
        // Drop every attachment — queued messages' and never-sent staged ones —
        // and clear the tray. Stopping means stopping.
        this.attq.clear();
        (this.attSink || this.chatComposer as any)?.clearAttachments?.();
        // Kill the in-flight send watchdogs. chatDrain arms two timers on every
        // send — a resubmit nudger that fires bare Enters (up to 3×, out to
        // ~4.8s) and a giveup timer that re-drains the queue. Neither is bound to
        // "the user is still waiting", so left alive they fire an Enter (or kick
        // the next message) AFTER a stop — the agent looks like the interrupt did
        // nothing because a queued Enter re-submits the just-halted prompt. Stop
        // has to silence them, not just send the Esc.
        if (this.chatResubmitTimer) { clearTimeout(this.chatResubmitTimer); this.chatResubmitTimer = null; }
        if (this.chatSendTimer) { clearTimeout(this.chatSendTimer); this.chatSendTimer = null; }
        // Keep the message you just sent on screen (optimistic bubble) but RELEASE
        // the in-flight lock, so the watchdog guard (chatSending === text) can
        // never re-fire it and the queue is truly drained.
        this.chatPending = this.chatSending ? [this.chatSending] : [];
        this.chatSending = null;
        ipc.ptyWrite(this.ptyId, '\x1b').catch(() => {});
        logAction('chat_stop', { name: this.name });
        this.renderChat();
      }

      /** Write the next queued message, if nothing is already in flight. */
      chatDrain() {
        if (this.chatSending || !this.chatQueue.length || !this.ptyAlive) return;
        const text = this.chatQueue.shift() as string;
        const atts = this.attq.next();
        this.chatSending = text;
        // Deliver THIS message's attachments first (so their paths / [Image #N]
        // precede the prompt at the cursor), THEN the bracketed-paste text and
        // Enter. Bracketed paste keeps a multi-line message as one block instead
        // of submitting on every newline. Chaining off flushAttachments keeps
        // the ordering deterministic even when the clipboard route awaits.
        this.flushAttachments(atts)
          .then(() => ipc.ptyWrite(this.ptyId, '\x1b[200~' + text + '\x1b[201~'))
          // A small gap before the submit so Claude Code doesn't coalesce the
          // Enter into the bracketed paste it just received — coalesced, the
          // text lands in the box but never submits.
          .then(() => new Promise((r) => setTimeout(r, 90)))
          .then(() => ipc.ptyWrite(this.ptyId, '\r'))
          .catch(() => {});
        this.chatTouch();
        // Submit watchdog. A freshly-spawned Claude — still drawing its banner /
        // "update available" notice — accepts the pasted text but SWALLOWS the
        // first Enter, leaving the message parked in its input in "manual mode":
        // sent from Home, never run, with nothing to re-submit it. If the
        // transcript hasn't absorbed this exact message shortly after delivery,
        // re-send a bare Enter (the text is already sitting in the box) a few
        // times before the giveup timer fires. Guarded on chatSending/chatPending
        // so it stops the instant the message actually lands, and an extra Enter
        // against an already-submitted (empty) prompt is a harmless no-op.
        if (this.chatResubmitTimer) clearTimeout(this.chatResubmitTimer);
        let submitTries = 0;
        const nudgeSubmit = () => {
          this.chatResubmitTimer = null;
          if (!this.ptyAlive || this.chatSending !== text || !this.chatPending.includes(text)) return;
          ipc.ptyWrite(this.ptyId, '\r').catch(() => {});
          if (++submitTries < 3) this.chatResubmitTimer = setTimeout(nudgeSubmit, 1500);
        };
        this.chatResubmitTimer = setTimeout(nudgeSubmit, 1800);
        // Release on confirmation (renderChat clears it when the transcript
        // shows the message) or on a timeout, so one message the agent never
        // echoes cannot wedge the queue forever.
        if (this.chatSendTimer) clearTimeout(this.chatSendTimer);
        this.chatSendTimer = setTimeout(() => {
          this.chatSendTimer = null;
          if (this.chatResubmitTimer) { clearTimeout(this.chatResubmitTimer); this.chatResubmitTimer = null; }
          this.chatSending = null;
          this.chatDrain();
        }, CHAT_SEND_WAIT_MS);
      }

      chatPoll() {
        this.pollNativeSubs();   // refresh the native-subagents watch strip each tick
        if (this.viewingSub) this.pollSubagentView();   // keep the open viewer live
        // Self-heal a wedged send queue, every poll. A message enqueued before the
        // pty could take input (ptyAlive false) sits in chatQueue, greyed, because
        // chatDrain bailed; it was meant to be kicked by the pty's first-output
        // arm, but if that never fired (or ptyAlive flipped some other way) the
        // message greyed forever with no recovery. chatDrain is fully guarded —
        // a no-op unless something is queued, the pty is up, and nothing is in
        // flight — so poking it here costs nothing and guarantees a queued message
        // eventually goes out. Deliberately BEFORE the chatPolling/stream guards
        // and outside the transcript-changed branch, so it runs on a quiet poll
        // (a wedged queue moves no transcript, so a change-gated drain never runs).
        this.chatDrain();
        if (this.chatPolling || !this.chatStream) return;
        this.chatPolling = true;
        // No cwd fallback, deliberately. The backend's cwd lookup answers "what
        // ran in this folder most recently", which is a fine guess for a
        // context gauge and a wrong answer here: it would show one lane the
        // conversation of another. A chat view must render THIS lane or
        // nothing. Claude lanes own their id from spawn, so they are always
        // exact; a Codex lane stays blank until its first agent event latches
        // one, which is correct — before the first turn there is no
        // conversation to show.
        ipc.transcriptTail(this.runId || '', undefined, this.chatOffset, this.ptyId)
          .then((t) => {
            // No transcript yet is the normal state of a lane whose first turn
            // hasn't landed — keep polling, show nothing, say nothing.
            if (this.chatError) { this.chatError = null; this.renderChat(); }
            // `t` itself is nullable defensively, not theoretically: the real
            // command always resolves to an object, but a null here used to
            // throw inside .then and land in .catch as "Can't read this
            // session's history" — a red error for what is really the benign
            // "no transcript yet" state. Treat an absent response as absent.
            if (!t || !t.found || !this.chatStream) return;
            if (t.reset) this.chatStream.reset();
            const changed = this.chatStream.push(t.lines);
            this.chatOffset = t.offset;
            if (changed || t.reset) { this.chatRefreshNow(); this.renderChat(); }
          })
          .catch((err) => {
            // Never swallow this. A failing read used to leave a blank pane
            // forever, indistinguishable from a new session and impossible to
            // diagnose for the person this view exists for.
            const msg = ipc.errorMessage(err, 'unknown error');
            if (this.chatError !== msg) { this.chatError = msg; this.renderChat(); }
          })
          .finally(() => { this.chatPolling = false; });
      }

      /**
       * Is the agent working right now?
       *
       * NOT "are bytes moving" — that was wrong and it showed. A long tool call
       * (an MCP search, a 30-second test run) prints nothing for its whole
       * duration, so the byte stream reads as idle and the indicator vanished
       * at exactly the moment someone most needs to see it. The broker's turn
       * state is the accurate answer: a turn is live from tool.start until
       * turn.ended, silence included. The byte stream stays as the fallback for
       * lanes whose hooks aren't reporting.
       */
      chatWorking() {
        const on = this.chatBrokerSeen ? (this.chatTurnLive || this.chatBusy) : this.chatBusy;
        // Stamp the start of a turn on the rising edge, so the clock measures
        // this turn and not the session.
        if (on && !this.chatTurnStartedAt) this.chatTurnStartedAt = Date.now();
        else if (!on) this.chatTurnStartedAt = 0;
        return on;
      }

      /**
       * Tick the elapsed clock in place, once a second, while a turn is live.
       *
       * Deliberately NOT a re-render: rebuilding the conversation every second
       * would fight the scroll position and slam shut any expanded step. Only
       * the one text node changes.
       */
      chatTick() {
        if (this.chatTickTimer) return;
        this.chatTickTimer = setInterval(() => {
          if (!this.chatOn || !this.chatTurnStartedAt) return;
          const el = this.chatBox && this.chatBox.querySelector('.cw-elapsed');
          if (el) el.textContent = chatview.elapsed(this.chatTurnStartedAt);
        }, 1000);
      }

      /**
       * Hold the spinner back for a beat.
       *
       * Work arrives in bursts with sub-second gaps between them, and an
       * indicator that appears and vanishes on each gap reads as flicker, not
       * progress. A short delay before showing it means the only time you see
       * it is when there is a wait actually worth showing. It hides instantly,
       * though — a stale spinner is a lie, and only the appearance needs
       * damping.
       */
      chatSyncSpinner() {
        const want = this.chatWorking();
        if (!want) {
          if (this.chatSpinTimer) { clearTimeout(this.chatSpinTimer); this.chatSpinTimer = null; }
          this.chatShowSpinner = false;
          return;
        }
        if (this.chatShowSpinner || this.chatSpinTimer) return;
        this.chatSpinTimer = setTimeout(() => {
          this.chatSpinTimer = null;
          if (!this.chatWorking()) return;
          this.chatShowSpinner = true;
          this.renderChat();
        }, CHAT_SPIN_DELAY_MS);
      }

      renderChat() {
        if (!this.chatScroll || !this.chatStream) return;
        const turns = this.chatStream.turns();
        // Keep this lane's Workstreams row in step: its glyph flips chat↔checklist
        // when a plan appears/clears, and its label becomes the first user message
        // once one lands. Both are captured in a small signature so we repaint the
        // launcher list only when the row would actually change — renderChat runs
        // on every stream tick, the list must not.
        const nowPlan = !!(chatview.latestTodos(turns) || []).length;
        const wsSig = (nowPlan ? '1' : '0') + '¦' + workstreamLabel(this);
        if (wsSig !== this.chatWsSig) { this.chatWsSig = wsSig; renderWorkstreams?.(); }
        // A transcript with anything in it settles the question chatTouch has to
        // ask: this lane is past its startup paint, so its bytes are work. Covers
        // a resumed session and one being driven from the terminal — neither goes
        // through chatSend, and neither should lose the byte-stream fallback.
        if (turns.length) this.chatSpoken = true;
        // Coder-side verdict folding is driven by the exchange controller's own
        // tick (see lane-controller.ts), not from render.
        if (this.chatTending) this.mergeMoves();   // scrape ```spike-moves``` proposals
        this.syncReviewButton();
        // The transcript now owns this question (its own row carries the answer)
        // — retire the broker bridge so it can't linger or double-render.
        if (this.chatLiveAsk && this.chatTranscriptHasAsk()) this.chatLiveAsk = null;
        // A startup gate clears the moment the pty proceeds — the first real
        // transcript turn is proof Codex got past the trust prompt and is running.
        if (this.chatGateActive && turns.length > 0) { this.chatGateActive = false; this.chatLiveAsk = null; }
        // Drop anything the transcript has caught up to. Matching on text over
        // the recent tail is self-healing: a message that lands under a
        // different shape simply ages out instead of sticking forever.
        if (this.chatPending.length) {
          // Reconcile the optimistic "pending" bubbles against the user turns
          // the transcript has absorbed. One-to-one and reflow-tolerant (a
          // shipped message can pick up whitespace passing through the pty),
          // but WITHOUT over-matching: each landed turn clears at most one
          // pending item, so two near-identical queued messages can't both be
          // evicted by a single send. chatSending rides in chatPending, so its
          // clearance is read off the same reconciliation.
          //
          // The tail is deliberately generous. At eight it was a trap: `!`
          // shell rows arrive as user turns (two apiece), so four shell
          // commands were the entire window, and a message sent just before
          // them never found its landed copy — the bubble then sat at the foot
          // of the conversation for the rest of the session. Those rows are
          // dropped upstream now (see stripInjections); the wider window is the
          // belt to that suspenders, since anything else user-shaped would do
          // the same.
          const youTurns: Array<{ at: number; text: string }> = [];
          turns.forEach((t, i) => {
            if (t.actor !== 'you') return;
            youTurns.push({ at: i, text: t.blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n') });
          });
          const recent = youTurns.slice(-CHAT_RECONCILE_TAIL);
          const { kept, landed, pairs } = chatview.reconcilePending(this.chatPending, recent.map((r) => r.text));
          // A message you typed mid-turn is filed by Claude when it picks the
          // message up, which is after the answer that was already streaming.
          // We painted it at the moment you sent it and know where that was —
          // so remember that position and let the renderer read it back there.
          for (const pr of pairs) {
            const landedAt = recent[pr.recent] && recent[pr.recent].at;
            const typedAt = this.chatPendingAt[pr.pending];
            // Only a cut EARLIER than where it was filed is a move; a message
            // the agent picked up straight away is already in the right place.
            if (typeof landedAt === 'number' && typedAt && typedAt.turn < landedAt) {
              this.chatAnchored.set(landedAt, typedAt);
            }
          }
          this.chatPendingAt = this.chatPendingAt.filter((_, i) => !pairs.some((pr) => pr.pending === i));
          this.chatPending = kept;
          // The in-flight message landing is the signal that the pty has
          // finished with it and the next one can safely go out.
          if (this.chatSending && landed.includes(this.chatSending)) {
            if (this.chatSendTimer) { clearTimeout(this.chatSendTimer); this.chatSendTimer = null; }
            if (this.chatResubmitTimer) { clearTimeout(this.chatResubmitTimer); this.chatResubmitTimer = null; }
            this.chatSending = null;
            this.chatDrain();
          }
        }
        this.chatSyncSpinner();
        this.renderSubagents();   // keep the native-subagents panel in step with the view
        // Parked on a subagent? Say so, the way the terminal does — a bare
        // "Thinking" here reads as generating when the turn is actually blocked
        // waiting for a background agent to finish.
        const bgWait = chatview.openDelegateCount(turns);
        const workStatus = bgWait > 0
          ? `Waiting for ${bgWait} background agent${bgWait === 1 ? '' : 's'} to finish`
          : (this.chatNow || 'Thinking');
        // Blocked on the person, not the model: an open question/elicitation
        // panel or an `input` notice means nothing is running. Drop the working
        // indicator entirely (marquee + the elapsed "Thinking Ns" clock) — a
        // ticking timer while parked on the user reads as work that isn't
        // happening. It resumes the moment the agent is actually working again.
        const waitingOnUserInput = this.chatOpenQuestion() || this.chatLiveAskOpen() || this.chatNotice === 'input';
        const working = this.chatShowSpinner && !waitingOnUserInput;
        const liveAsk = this.chatTranscriptHasAsk() ? undefined : (this.chatLiveAsk || undefined);
        // Rebuild the conversation DOM ONLY when something it depends on changed.
        // renderChat is called on every poll and byte-stream touch; on the
        // chattier Codex path that meant re-clearing and rebuilding the whole
        // list many times over an unchanged conversation, which fought a
        // scrolled-up reader (the top kept getting clipped / the position reset)
        // — Claude polls quietly, so it never showed there. An unchanged render
        // now does NOTHING to the scroller; the elapsed clock still ticks in
        // place (chatTick) and the nudge/composer state is updated in place below.
        const start = Math.max(0, turns.length - (this.chatWindow > 0 ? this.chatWindow : turns.length));
        // The render signature is split in two. TRANSCRIPT fields describe the
        // conversation DOM (turns, pending/queued bubbles, the live question
        // panel, the error banner, the window). STATUS fields describe only the
        // working indicator (is it working, the status text, the tool kind) —
        // and those tick on essentially every poll while an agent runs, even
        // though the transcript above is unchanged. #20: including status in the
        // rebuild signature meant `host.textContent=''` + a full conversation
        // rebuild fired many times a second just to retitle the spinner, which
        // destroyed the nodes under a scrolling reader and made Codex chat
        // impossible to scroll. So a status-only change now updates JUST the
        // indicator in place (chatview.renderStatus) and never touches the
        // transcript; only a transcript-field change rebuilds the conversation.
        const transcriptObj: Record<string, unknown> = {
          t: turns.slice(start),
          more: start,
          p: this.chatPending,
          q: this.chatQueue,
          la: liveAsk ? { q: liveAsk.ask, a: liveAsk.answer } : null,
          // The inline permission panel is a transcript-area element like the
          // question panel, so it belongs in the rebuild signature — otherwise
          // setting/clearing it (no transcript change) never repaints (#20).
          lp: this.chatLivePermission
            // `sent` is in the signature for the same reason the panel itself is:
            // it is a visible state change with no transcript change behind it, so
            // leaving it out means the answered panel never repaints and the
            // buttons stay live after they were pressed.
            ? { t: this.chatLivePermission.tool, tg: this.chatLivePermission.target, pid: this.chatLivePermission.promptId, s: !!this.chatLivePermission.sent }
            : null,
          e: this.chatError || null,
          win: this.chatWindow,
          // Findings and moves panels are transcript-area elements drawn from
          // controller state, not from turns — so their signature must live here
          // too. Without them, resolving a finding/move or the escalation timer
          // flipping a finding's state calls renderChat but leaves transcriptSig
          // unchanged, so the panel never repaints at exactly the idle,
          // awaiting-you moment it exists for. Fingerprint only the fields that
          // change what's drawn.
          f: this.chatReview?.findings?.map(
            (x) => `${x.id}:${x.state}:${x.verdict || ''}:${x.bounces}:${x.reply ? 1 : 0}:${x.reviewerNote ? 1 : 0}`,
          ) || null,
          mv: this.chatMoves?.map((m) => `${m.id}:${m.state}`) || null,
        };
        const statusObj: Record<string, unknown> = {
          w: working,
          st: workStatus,
          sk: bgWait > 0 ? undefined : this.chatNowKind,
          // The mark's key, not the mark: a signature that carried an inlined
          // brand SVG would be a kilobyte of string compared on every tick.
          sm: bgWait > 0 ? undefined : (this.chatNowMark?.key || null),
        };
        const transcriptSig = JSON.stringify(transcriptObj);
        const statusSig = JSON.stringify(statusObj);
        // The transcript rebuilds ONLY when its own signature changed, or on the
        // very first paint. Deliberately NOT gated on a live child count: a
        // momentary empty read would otherwise force a full rebuild on a
        // status-only tick, exactly the #20 leak. chatPainted flips true the
        // first time chatview.render runs and never back — the scroller persists
        // for the session (buildChat runs once), so nothing legitimately empties
        // it underneath us.
        const rebuildTranscript = !this.chatPainted || transcriptSig !== this.chatTranscriptSig;
        const statusOnly = !rebuildTranscript && statusSig !== this.chatStatusSig;
        if (statusOnly) {
          // Only the working indicator changed — update it in place, leaving the
          // whole transcript DOM (and the reader's scroll) untouched (#20).
          this.chatStatusSig = statusSig;
          chatview.renderStatus(this.chatScroll, {
            working,
            status: workStatus,
            statusKind: bgWait > 0 ? undefined : ((this.chatNowKind as any) || undefined),
            statusMark: bgWait > 0 ? undefined : this.chatNowMark,
            since: this.chatTurnStartedAt || undefined,
          });
        }
        if (rebuildTranscript) {
        this.chatTranscriptSig = transcriptSig;
        this.chatStatusSig = statusSig;   // a full render also lays down the indicator
        this.chatPainted = true;          // first paint done — from here the transcript sig is the sole rebuild trigger
        chatview.render(this.chatScroll, turns, {
          markdown: renderChatMarkdown,
          working,
          pending: this.chatPending,
          // Re-supply the thumbnails a message was sent with, for both its
          // pending bubble and its landed turn (see chatSentAtts).
          attFor: (t: string) => this.chatSentAtts.get(t.trim()),
          // Messages the transcript filed later than they were said, put back
          // where you said them.
          anchored: this.chatAnchored,
          // Only what is still in the queue can be recalled; anything already
          // written to the pty belongs to the agent now.
          error: this.chatError || undefined,
          onRetry: () => { this.chatError = null; this.renderChat(); this.chatPoll(); },
          window: this.chatWindow,
          onShowEarlier: () => { this.chatWindow += CHAT_WINDOW; this.renderChat(); },
          cancellable: this.chatQueue.slice(),
          onCancel: (text) => {
            const i = this.chatQueue.indexOf(text);
            // Drop the message's bound attachments alongside it (index-aligned
            // with the queue), so a cancelled queued message delivers no files.
            if (i >= 0) { this.chatQueue.splice(i, 1); this.attq.cancelAt(i); }
            const j = this.chatPending.indexOf(text);
            if (j >= 0) { this.chatPending.splice(j, 1); this.chatPendingAt.splice(j, 1); }
            this.renderChat();
          },
          since: this.chatTurnStartedAt || undefined,
          emptyHint: `Everything you type goes to ${this.cmd === 'codex' ? 'Codex' : 'Claude'}. The terminal is one click away.`,
          // A few plain-language openers for someone who has never driven an
          // agent. Kept universal (they hold in any workspace) and phrased as
          // things a non-developer would actually want. Unlike onPick (whose pty
          // may be sitting in a key-driven select), the empty state means a fresh
          // agent at its prompt — so a click just sends, no extra step.
          starters: turns.length ? undefined : [
            'What can you help me with in this project?',
            'Explain what this project does, in plain language.',
            "Summarize what's changed here recently.",
          ],
          onStarter: (text) => this.chatSend(text),
          status: workStatus,
          // While waiting on a helper there is no active tool of our own, so the
          // marquee carries the signal — drop the tool-icon kind.
          statusKind: bgWait > 0 ? undefined : ((this.chatNowKind as any) || undefined),
          statusMark: bgWait > 0 ? undefined : this.chatNowMark,
          // The broker-delivered question, shown until the transcript's own copy
          // arrives — then the transcript owns it (open OR answered), and
          // rendering both would stack two panels. Crucially this survives being
          // ANSWERED: chatMarkAnswered resolves the bridge (collapses to "You
          // chose: …") rather than nulling it, so an answered broker question
          // shows the choice instead of vanishing until the transcript catches up.
          liveAsk,
          // Answer the question by driving the pty the way the TUI expects: a
          // pick types the option's number then Enter to submit (the panels
          // highlight on the digit but only commit on Enter); a multi-select set
          // or a typed answer escapes the select and goes back as a normal
          // message. See chatAnswerPick / chatAnswerWords.
          onAnswer: (ans) => {
            if (ans.type === 'pick') this.chatAnswerPick(ans.index, ans.label);
            else this.chatAnswerWords(ans.text);
          },
          // A file the agent touched, opened in Spike's own preview pane — the
          // same door the tree and recents use, so a clicked basename lands
          // where every other file in the app does. No terminal, no Finder.
          onOpenFile: (path) => openFile(path, path.split('/').pop() || path, null, { owner: this.name }),
          // A permission prompt, answered inline: Allow/Deny writes the option's
          // keystroke to the pty; the defer link falls back to the terminal.
          livePermission: this.chatLivePermission || undefined,
          onDecide: (opt) => this.chatDecide(opt),
          onDeferToTerminal: () => this.chatDeferPermission(),
          // The convergence panel and your tiebreak on an escalated finding.
          findings: this.chatReview?.findings,
          onFindingDecide: (id, side) => this.chatReview?.resolveFinding(id, side),
          moves: this.chatMoves && this.chatMoves.length ? this.chatMoves : undefined,
          onMoveDecide: (id, action) => this.resolveMove(id, action),
        });
        }
        // The conversation just changed height (or didn't) — either way the
        // distance to the bottom is now known, and "Latest" must agree with it.
        if (this.chatSyncJump) this.chatSyncJump();
        // Send becomes Stop while a turn is live.
        if (this.chatComposer) {
          this.chatComposer.classList.toggle('busy', this.chatWorking());
          // Blocked on the person (a question, a permission prompt) → a warm
          // edge that echoes the nudge, so the composer itself says "your move".
          this.chatComposer.classList.toggle('waiting', !!this.chatAwait);
        }
        // While a question is open, the composer is a second way to answer it —
        // say so, so nobody feels boxed into the options.
        if (this.chatInput) {
          // Only write when it changes. renderChat runs many times a second while
          // an agent works; rewriting the placeholder attribute every poll forces
          // WebKit to re-lay the placeholder pseudo over an already-painted value,
          // which leaves stale placeholder glyphs painted behind typed text.
          const ph = this.chatQuestionOpen()
            ? 'Pick above, or type your own answer' : 'Ask for anything';
          if (this.chatInput.placeholder !== ph) this.chatInput.placeholder = ph;
        }
        if (this.chatNudge) {
          // When the question is already on screen as a panel, "go look in the
          // terminal" is the wrong instruction — the options are right there.
          // Only claim what we actually know. `question.asked` is exact, so it
          // may say the agent is asking. A long silence is NOT proof of that —
          // a slow build looks identical from outside — so that case says what
          // is true (it has been quiet) and points at where the answer would
          // be, without asserting one is being waited on.
          // The answer is available RIGHT HERE — an options panel is on screen
          // (transcript question or broker-delivered), or an elicitation is
          // waiting on the person. In all these the composer already invites an
          // answer, so the terminal redirect (and its button) is redundant and
          // is dropped. A permission prompt (#12) is the exception: that dialog
          // is not reimplemented in-chat yet, so it still punts to the terminal.
          const answerableHere = this.chatOpenQuestion() || this.chatLiveAskOpen() || this.chatNotice === 'input';
          const t = this.chatNudge.querySelector('.cwnudge-t');
          if (t) {
            t.textContent = (this.chatOpenQuestion() || this.chatLiveAskOpen())
              ? 'Pick an option above.'
              : this.chatNotice === 'input'
                ? 'Answer above.'
                // A permission prompt is exact and immediate — name it, don't hedge.
                : this.chatNotice === 'permission'
                  ? 'This session needs your permission to continue. Answer in the terminal.'
                  : this.chatAsking
                    ? 'This session is asking you something in the terminal.'
                    : 'Quiet for a while. If it needs you, the terminal will show it.';
          }
          // Drop the "Open terminal" button whenever the answer is available in
          // chat; keep it only for the terminal-redirect cases (permission, the
          // asking/quiet fallbacks).
          if (this.chatNudgeBtn) this.chatNudgeBtn.style.display = answerableHere ? 'none' : '';
          // The inline permission panel is the answer surface now — the nudge
          // would only repeat it. Show the nudge only when we're blocked with no
          // panel up (a non-permission dialog, or a deferred prompt).
          this.chatNudge.classList.toggle('show', this.chatAwait && !this.chatLivePermission);
        }
      }

      /** Is an unanswered question panel the last thing in the conversation? */
      chatOpenQuestion(): boolean {
        const turns = this.chatStream ? this.chatStream.turns() : [];
        const last = turns[turns.length - 1];
        if (!last || last.actor !== 'agent') return false;
        const b = last.blocks[last.blocks.length - 1];
        return !!b && b.type === 'ask' && !b.item.answer;
      }

      /** A broker-delivered question still awaiting an answer. The optimistic
       *  answer set by chatMarkAnswered clears this, so an already-answered
       *  bridge no longer counts as "open". */
      chatLiveAskOpen(): boolean {
        return !!this.chatLiveAsk && !this.chatLiveAsk.answer;
      }

      /** The transcript already carries the live question (open or answered), so
       *  the broker bridge should stand down and let the transcript's copy own
       *  it — otherwise both would render once the answered row lands. */
      chatTranscriptHasAsk(): boolean {
        const q = this.chatLiveAsk && this.chatLiveAsk.ask && this.chatLiveAsk.ask[0] && this.chatLiveAsk.ask[0].question;
        if (!q) return false;
        const turns = this.chatStream ? this.chatStream.turns() : [];
        for (const t of turns) {
          if (t.actor !== 'agent') continue;
          for (const b of t.blocks) {
            if ((b as any).type === 'ask' && (b as any).item && (b as any).item.ask && (b as any).item.ask[0] && (b as any).item.ask[0].question === q) return true;
          }
        }
        return false;
      }

      /** A question is on screen, live or from the transcript, still UNANSWERED
       *  — so the pty is sitting in an AskUserQuestion select and any answer has
       *  to account for that (a digit + Enter to pick, or an Escape before typed
       *  text). An answered question routes a fresh message normally. */
      chatQuestionOpen(): boolean {
        return this.chatLiveAskOpen() || this.chatOpenQuestion();
      }

      /**
       * Answer a single-select question by clicking its option.
       *
       * The option panels Spike shows — Claude's AskUserQuestion and the cockpit
       * "Next move" dialog — HIGHLIGHT on a number key but only SUBMIT on Enter
       * (their footer reads "Enter to select"). The old code sent the digit
       * alone, which left the pick highlighted-but-unsubmitted and the agent
       * waiting forever. So: type the option's number to move to it, a beat for
       * the TUI to settle, then Enter to confirm — submitted exactly once (the
       * digit navigates, the single Enter commits; no stray blank line).
       */
      chatAnswerPick(index: number, label: string) {
        if (!this.ptyAlive) return;
        ipc.ptyWrite(this.ptyId, String(index + 1))
          .then(() => new Promise((r) => setTimeout(r, 60)))
          .then(() => ipc.ptyWrite(this.ptyId, '\r'))
          .catch(() => {});
        logAction('chat_answer_pick', { index, label, name: this.name });
        this.chatMarkAnswered(label);
        this.chatTouch();
        this.renderChat();
      }

      /**
       * Answer a MULTI-question AskUserQuestion in one go — one option index per
       * question, in order.
       *
       * The TUI walks the set: a digit selects that question's option and
       * auto-advances to the next; a final Enter submits the review (whose
       * default is "Submit answers"). So the whole set is `digit₁ … digitₙ ⏎` —
       * the exact shape of {@link chatAnswerPick} (digit + Enter) generalised to
       * n questions. A small gap between keystrokes lets the TUI redraw the next
       * question before the next digit lands, so none are dropped or coalesced.
       *
       * This is optimistic: the card is marked answered and dismissed. If the
       * sequence didn't fully drive the TUI, the ask stays open and the card
       * reappears on the next poll — self-correcting rather than a silent hang.
       * The terminal escape hatch is always on the card as the sure path.
       */
      chatAnswerMulti(indices: number[], labels: string[]) {
        if (!this.ptyAlive || !indices.length) return;
        let chain: Promise<any> = Promise.resolve();
        for (const idx of indices) {
          chain = chain
            .then(() => ipc.ptyWrite(this.ptyId, String(idx + 1)))
            .then(() => new Promise((r) => setTimeout(r, 90)));
        }
        chain.then(() => ipc.ptyWrite(this.ptyId, '\r')).catch(() => {});
        logAction('chat_answer_multi', { indices, labels, name: this.name });
        this.chatMarkAnswered(labels.join(', '));
        this.chatTouch();
        this.renderChat();
      }

      /**
       * Answer in words: escape the select first, then send the text.
       *
       * Multi-select can't be keystroke-driven (Claude's own TUI mishandles it),
       * and a typed answer isn't an option at all — so both take the honest
       * path the person would take by hand: Esc leaves the select and hands
       * control back to the normal prompt, then the text goes as an ordinary
       * message. Claude receives it as the answer and moves on. A beat between
       * the Esc and the paste lets the TUI's escape-timeout settle so the two
       * don't fuse into one sequence. This is also the always-available fallback
       * for any option panel: type your answer and send.
       */
      chatAnswerWords(text: string) {
        if (!this.ptyAlive || !text.trim()) return;
        ipc.ptyWrite(this.ptyId, '\x1b')
          .then(() => new Promise((r) => setTimeout(r, 60)))
          .then(() => ipc.ptyWrite(this.ptyId, '\x1b[200~' + text + '\x1b[201~'))
          .then(() => ipc.ptyWrite(this.ptyId, '\r'))
          .catch(() => {});
        logAction('chat_answer_words', { name: this.name });
        this.chatMarkAnswered(text);
        this.chatTouch();
        this.renderChat();
      }

      /**
       * The person answered the open question. DON'T vanish the panel — resolve
       * it optimistically so it collapses to "You chose: …" and stays put until
       * the transcript's own copy lands (the old code nulled chatLiveAsk here,
       * so a broker-delivered question disappeared with nothing recorded). Also
       * stop presenting as "waiting on you": the answer is on its way.
       */
      private chatMarkAnswered(text: string) {
        if (this.chatLiveAsk && !this.chatLiveAsk.answer) this.chatLiveAsk.answer = text;
        this.chatAwait = false;
        this.chatAsking = false;
        this.chatNotice = null;
        // If this resolved a startup gate, latch it answered so the detector
        // doesn't re-raise it; the gate ask clears once the pty proceeds.
        if (this.chatGateActive) this.chatGateAnswered = true;
        this.syncRowStates();   // answered → the row stops asking
      }

      /**
       * Watch a Codex session's byte stream for the startup TRUST GATE — the
       * "Do you trust the contents of this directory?" prompt Codex blocks on
       * before it will run. It exists before any transcript, so the chat's only
       * signal is the pty output. When seen, surface it as an inline Yes/No ask
       * (chatLiveAsk) so the chat reads "needs you", not "Ready", and the choice
       * is answered through the same digit+Enter channel as an elicitation pick
       * (option 1 = "Yes, continue", option 2 = "No, quit" — Codex's own order).
       * Trust is a security decision, so it is SURFACED, never auto-accepted.
       */
      codexGateScan(d: string) {
        if (this.chatGateActive || this.chatGateAnswered) return;
        // A small rolling window, ANSI stripped, so the prompt is matchable even
        // when Codex paints it with colour/cursor control interspersed.
        this.codexOutBuf = (this.codexOutBuf + d).slice(-4000)
          .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b[@-Z\\-_]/g, '');
        if (!/do you trust the contents of this (?:directory|folder)/i.test(this.codexOutBuf)) return;
        this.chatGateActive = true;
        this.codexOutBuf = '';
        this.chatLiveAsk = {
          kind: 'ask', verb: 'Asked you a question', gerund: 'Waiting on your answer',
          ask: [{
            header: 'Trust this folder?',
            question: 'Codex is waiting before it starts: do you trust the contents of this directory?',
            options: [{ label: 'Yes, continue' }, { label: 'No, quit' }],
            multi: false,
          }],
        } as any;
        this.chatAwait = true;
        this.chatNotice = 'input';
        if (this.chatOn) this.renderChat();
        this.syncRowStates();
      }

      /**
       * Sharpen the status from the transcript. The tool_use row carries the
       * tool's INPUT — the file, the query, the command's description — which
       * the broker's start event does not, so the specific phrasing can only
       * come from here. Called after every poll that changed anything.
       */
      chatRefreshNow() {
        if (!this.chatBusy || !this.chatStream) return;
        const turns = this.chatStream.turns();
        const last = turns[turns.length - 1];
        if (!last || last.actor !== 'agent') return;
        const block = last.blocks[last.blocks.length - 1];
        if (!block || block.type !== 'actions') return;
        const a = block.items[block.items.length - 1];
        this.chatNow = chatview.nowPhrase(a);
        this.chatNowKind = a.kind;
        this.chatNowMark = a.mark;
      }

      /**
       * A broker event for this lane. These are the only signals that can tell
       * a finished turn apart from one blocked on a TUI prompt (see chatTouch),
       * and the only ones fast enough to name what's happening the moment it
       * starts. Both engines emit all four kinds.
       */
      /**
       * Arm the "is it stuck?" timer.
       *
       * The nudge used to fire after ~1.4s of silence with a live turn, which
       * is wrong: that is also what a long tool call looks like from outside,
       * so a 30-second MCP query got labelled "waiting for an answer". A
       * permission prompt and a slow tool are genuinely indistinguishable from
       * the broker — PreToolUse fires before the prompt in both cases — so the
       * only honest handling is to wait long enough that a slow tool would
       * normally have finished before suggesting anything is wrong.
       * AskUserQuestion is the exception: `question.asked` is exact and fires
       * the nudge immediately.
       */
      chatArmStuck() {
        if (this.chatStuckTimer) clearTimeout(this.chatStuckTimer);
        this.chatStuckTimer = setTimeout(() => {
          this.chatStuckTimer = null;
          if (this.chatBrokerSeen && this.chatTurnLive && !this.chatBusy) {
            this.chatAwait = true;
            this.renderChat();
          }
        }, CHAT_STUCK_MS);
      }

      /**
       * A Notification-hook event for this lane: the honest, immediate signal
       * that a turn is blocked waiting on the person, not on a slow tool.
       *
       * A permission prompt now renders an inline Allow/Deny panel — the tool
       * that triggered it (from the last PreToolUse) named, the choices
       * Spike-authored, answered by a keystroke into the pty (the same write
       * path a question uses). The terminal stays one click away as the escape
       * hatch. Everything else (a generic input dialog we can't author options
       * for) still hands off to the terminal, honestly and immediately.
       */
      chatBrokerNotify(notificationType?: string) {
        // Only the "needs you" kinds block a turn; the adapter already filters
        // to these, but classify here too so the copy is specific.
        const notice =
          notificationType === 'permission_prompt' ? 'permission'
          : (notificationType === 'agent_needs_input' || notificationType === 'elicitation_dialog') ? 'input'
          : null;
        if (!notice) return;
        this.chatBrokerSeen = true;
        this.chatAwait = true;
        this.chatNotice = notice;
        // A permission prompt we can answer inline: build the panel from the
        // tool that triggered it plus its target (the last action's subject, if
        // the transcript has caught up). Other notices keep the nudge.
        this.chatLivePermission = notice === 'permission' ? this.chatBuildPermission() : null;
        // We have an exact signal now — the "is it stuck?" guess is moot.
        if (this.chatStuckTimer) { clearTimeout(this.chatStuckTimer); this.chatStuckTimer = null; }
        if (this.chatOn) this.renderChat();
        this.syncRowStates();   // light "Your turn" in the launcher, open or not
        this.notifyParentActivity();
      }

      /**
       * The inline permission panel's contents. Tool name comes from the last
       * tool.start (reliable — the prompt fires from that tool's PreToolUse);
       * the target (command, file, url) is the last action's object if the
       * transcript has it yet, shown only when present so a lagging row never
       * mislabels the subject.
       *
       * This panel can only answer by typing a digit into the dialog the
       * terminal is showing, so it offers the two options whose digit means the
       * same thing for every tool — allow once and deny. "Allow for this
       * session" is not one of them (see PERMISSION_OPTIONS_KEYSTROKE), and
       * anything this narrower set doesn't cover is a click away in the
       * terminal.
       */
      chatBuildPermission(): chatview.PermissionAsk {
        const tool = this.chatPromptTool || 'this tool';
        let target: string | undefined;
        const turns = this.chatStream ? this.chatStream.turns() : [];
        outer: for (let i = turns.length - 1; i >= 0; i--) {
          const t = turns[i];
          if (t.actor !== 'agent') continue;
          for (let j = t.blocks.length - 1; j >= 0; j--) {
            const b = t.blocks[j];
            if (b.type !== 'actions') continue;
            const a = b.items[b.items.length - 1];
            if (a) {
              // A command's subject is the whole command (detail); a file's is
              // its basename (object). Capped so a long line can't blow out the
              // panel.
              const raw = a.kind === 'run' ? (a.detail || a.object) : (a.object || a.detail);
              if (raw) target = raw.length > 80 ? raw.slice(0, 80) + '…' : raw;
            }
            break outer;
          }
        }
        return { tool: chatview.toolLabel(tool), target, options: chatview.PERMISSION_OPTIONS_KEYSTROKE };
      }

      /**
       * Relabel the "allow this session" option to name the scope the way the TUI
       * does — "Allow reading from spike/" — for READ tools, where the session
       * grant reliably means "reads in the working tree" (the repo the session
       * runs in). Other tools keep the generic label: their session scope varies
       * (an edit, a command) and Spike must not name a scope it can't keep — the
       * same reason the keystroke fallback drops this option (stableKeystroke).
       *
       * For reads we also put that session grant FIRST, so it becomes the card's
       * prominent default (the render marks the first non-deny option primary).
       * An A+ chat asks once and remembers: the session grant is the only option
       * that stops the SAME file being re-interrogated on the next read — the
       * hook records it (agent-event-hook _remember_session_allow) and auto-
       * allows the repeat. "Allow once" made the natural single click grant for
       * one call only, so every later read re-prompted. It stays available as the
       * second choice for the narrower "just this once" intent.
       */
      scopedPermissionOptions(tool: string, target?: string): chatview.PermissionOption[] {
        const cwd = this.autoCwd || this.cwd || '';
        const base = chatview.PERMISSION_OPTIONS;
        // Three choices, always: deny, one middle grant, allow-once. The middle
        // slot holds the WIDEST grant Spike can honestly offer for this call —
        // and that is the whole rule. A fourth button, or a standing grant
        // parked in its own strip below the row, made a card that asks one
        // question look like it was asking two.
        //
        // Reads keep the session grant and are never offered "always": the
        // sticky per-run grant already stops the same file being re-interrogated
        // (it is the "ask once, remember" default, and the card marks the first
        // non-deny option primary — so for reads it IS the default click). A
        // permanent grant over a whole directory is both the least necessary
        // here and the worst thing to make the default click.
        if (/^(Read|NotebookRead|Glob|Grep|LS)$/.test(tool)) {
          const repo = cwd.split('/').filter(Boolean).pop();
          const labelled = repo
            ? base.map((o) => o.id === 'allow_session'
              ? { ...o, label: 'Allow reading from ' + repo + '/' }
              : o)
            : base;
          // Sticky-first order: session grant, then allow-once, then deny.
          const rank = (o: chatview.PermissionOption) =>
            o.id === 'allow_session' ? 0 : o.id === 'allow_once' ? 1 : 2;
          return [...labelled].sort((a, b) => rank(a) - rank(b));
        }
        // Everything else: "always" REPLACES the session grant in the middle
        // slot when a class can be named safely (alwaysRuleFor returns null for
        // a chained command, an install, an rm, a bare interpreter — there the
        // session grant stays, which is the right middle ground for exactly the
        // calls too sharp to grant permanently). Allow-once remains first, so
        // the standing grant is never the primary.
        const always = chatview.alwaysRuleFor(tool, target, cwd);
        if (!always) return base;
        return base.map((o) => o.id === 'allow_session'
          ? { id: 'allow_always' as const, label: 'Always allow', keystroke: '', scope: 'always' as const, rule: always.rule, what: always.what }
          : o);
      }

      /**
       * A structured permission prompt from the hook (permission.ask). Carries
       * the real tool, target, options, and the prompt_id the hook is polling —
       * so the answer resolves the blocked hook directly, no keystroke guessing.
       * This is the primary path; the notify-derived panel is the fallback.
       */
      chatPermissionAsk(data: any) {
        const tool = typeof data.tool === 'string' ? data.tool : 'this tool';
        const target = typeof data.target === 'string' && data.target ? data.target : undefined;
        this.chatPromptTool = tool;
        this.chatBrokerSeen = true;
        this.chatAwait = true;
        this.chatNotice = null;
        this.chatLivePermission = {
          tool: chatview.toolLabel(tool),
          target,
          options: this.scopedPermissionOptions(tool, target),
          promptId: typeof data.prompt_id === 'string' ? data.prompt_id : undefined,
        };
        if (this.chatStuckTimer) { clearTimeout(this.chatStuckTimer); this.chatStuckTimer = null; }
        if (this.chatOn) this.renderChat();
        this.syncRowStates();   // …and in the launcher's Workstreams row
        // Same reason a blocking notification tells the parent: this lane is
        // stopped until someone looks at it.
        this.notifyParentActivity();
      }

      /**
       * The hook finished with a prompt (answered here, in the terminal, or
       * timed out). Clear the panel if it's the one showing — matched by
       * prompt_id so a newer prompt isn't wiped by a stale resolution.
       */
      chatPermissionResolved(data: any) {
        const id = typeof data.prompt_id === 'string' ? data.prompt_id : undefined;
        if (this.chatLivePermission && this.chatLivePermission.promptId === id) {
          this.chatLivePermission = null;
          this.chatAwait = false;
          if (this.chatOn) this.renderChat();
          this.syncRowStates();   // answered → the row stops asking
        }
      }

      /**
       * Answer a permission prompt inline. On the structured path (a prompt_id
       * from the hook) the decision resolves the blocked hook via a command —
       * the real allow/deny, no digit-guessing, and Spike honours whatever scope
       * the option named. On the fallback path (no prompt_id, a notify-derived
       * panel) it writes the option's keystroke into the pty, as a question pick
       * does.
       *
       * The two paths clear the panel differently, on purpose. The structured
       * path gets an acknowledgement — the hook resolves and posts back — so it
       * can clear on the click. The keystroke path gets nothing: Spike types a
       * digit into a dialog it cannot read, and has no way to learn whether that
       * digit selected what it meant. So it does NOT clear on the click. It
       * marks the panel sent and waits for evidence the block actually lifted,
       * which arrives as the next tool/turn event (see chatBrokerEvent).
       *
       * Clearing optimistically was wrong in the same way the option-2 label was
       * wrong: it stated something Spike had not established. A write that fails,
       * or a digit that lands on nothing because the dialog had fewer options
       * than assumed, left a dismissed panel, no nudge, and an agent still
       * blocked — the person believing they had answered.
       */
      chatDecide(opt: chatview.PermissionOption) {
        const promptId = this.chatLivePermission && this.chatLivePermission.promptId;
        if (!promptId) {
          // ── keystroke path: claim nothing, wait for evidence ──
          // An option whose digit isn't fixed across tools must not reach the
          // pty even if a panel is built wrong — sending an unverifiable digit
          // is how "allow for this session" turned into a persisted rule. Same
          // for a dead pty: there is nothing to type into. Both hand off to the
          // terminal rather than failing silently.
          if (!opt.stableKeystroke || !this.ptyAlive) { this.chatDeferPermission(); return; }
          logAction('chat_permission', { decision: opt.id, tool: this.chatPromptTool, structured: false, name: this.name });
          ipc.ptyWrite(this.ptyId, opt.keystroke).catch(() => this.chatDeferPermission());
          // Mark it sent so the buttons go quiet and can't be double-answered,
          // while the terminal link stays reachable for the case where the digit
          // did nothing at all.
          if (this.chatLivePermission) {
            this.chatLivePermission = { ...this.chatLivePermission, sent: true };
          }
          this.chatTouch();
          this.renderChat();
          return;
        }
        // "Always" is the one decision that outlives the prompt, so it is the one
        // that must not live in Spike. Settings ▸ Permissions is explicit that
        // Spike keeps NO permission model — it reads and writes the agent's own
        // rules — and the last time Spike kept a private allow-set consulted
        // ahead of those rules, an explicitly-allowlisted command still prompted
        // on every call in chat while running silently in the terminal. So this
        // appends a real rule to the workspace's own config, where the agent's
        // rules run before the hook ever fires, the terminal honours it too, and
        // Settings ▸ Permissions can take it back.
        //
        // The hook still has to be answered: it is blocked right now, and the
        // rule only takes effect on a later call. `allow_session`, not
        // allow_once, so the rest of this run is quiet even if the agent doesn't
        // re-read its config mid-session.
        if (opt.id === 'allow_always' && opt.rule) this.chatWriteAlwaysRule(opt.rule);
        ipc.agentPermissionAnswer(promptId, opt.id === 'allow_always' ? 'allow_session' : opt.id).catch(() => {});
        logAction('chat_permission', { decision: opt.id, tool: this.chatPromptTool, structured: true, rule: opt.rule, name: this.name });
        this.chatLivePermission = null;
        this.chatAwait = false;
        this.chatNotice = null;
        this.chatTouch();
        this.renderChat();
      }

      /**
       * Append one always-rule to this workspace's own agent config, read-
       * modify-write so a concurrent Settings edit isn't clobbered and a rule
       * already present isn't duplicated.
       *
       * Failure is deliberately quiet at the card: the tool call itself was
       * already allowed by the decision that accompanies this, so a config that
       * wouldn't save means the person gets asked again next time — the safe
       * direction to fail. It is logged so a persistent failure is findable.
       */
      async chatWriteAlwaysRule(rule: string) {
        const cwd = this.autoCwd || this.cwd || '';
        if (!cwd) return;
        try {
          const cur = await ipc.permissionRules(cwd);
          const rules = Array.isArray(cur && cur.workspace) ? cur.workspace : [];
          if (rules.indexOf(rule) >= 0) return;
          await ipc.permissionRulesSet(cwd, 'workspace', [...rules, rule]);
          logAction('chat_permission_always', { rule, cwd, name: this.name });
        } catch (e) {
          logAction('chat_permission_always_failed', { rule, cwd, error: String(e), name: this.name });
        }
      }

      /**
       * Fall back to the terminal for this prompt: drop the inline panel but
       * keep the block state, so the nudge takes over with its "answer in the
       * terminal" copy. The escape hatch if the inline path is ever wrong.
       */
      chatDeferPermission() {
        this.chatLivePermission = null;
        logAction('chat_permission_defer', { tool: this.chatPromptTool, name: this.name });
        this.renderChat();
      }

      chatBrokerEvent(kind: string, tool?: string, data?: any) {
        this.chatBrokerSeen = true;
        // AskUserQuestion's OWN tool.start/tool.end is not "work resumed" — the
        // hook fires BOTH a generic tool.start AND a question.asked for it, and
        // the two POSTs can be processed out of order. Letting the tool.start win
        // wiped the just-set question state (chatAwait → false, chatLiveAsk →
        // null), so the card never showed — the "question didn't work" bug. Never
        // let an AskUserQuestion tool event clobber the blocked/question state.
        const askToolEvent = (kind === 'tool.start' || kind === 'tool.end') && tool === 'AskUserQuestion';
        this.chatTurnLive = kind !== 'turn.ended';
        if (kind === 'question.asked') { this.chatAwait = true; this.chatAsking = true; }
        else if (!askToolEvent) { this.chatAwait = false; this.chatAsking = false; }
        // The question, rendered from the broker event's own payload — so the
        // options panel appears the instant the agent asks, not one transcript
        // poll later (and not never, if the assistant row is slow to reach the
        // on-disk transcript). Cleared by any later tool/turn event, because
        // work resuming IS the question being answered — EXCEPT the question's own
        // tool events (see askToolEvent). The transcript's copy takes over as soon
        // as it lands (see renderChat's liveAsk gate), so this only bridges the gap.
        if (kind === 'question.asked' && data && data.input) {
          try { this.chatLiveAsk = chatview.humanize('AskUserQuestion', data.input); }
          catch { this.chatLiveAsk = null; }
        } else if (!askToolEvent && (!this.chatLiveAsk || !this.chatLiveAsk.answer)) {
          // Work resumed on an UNANSWERED bridge → the question is moot, drop it.
          // But keep an ANSWERED bridge: it shows "You chose: …" until the
          // transcript's own answered row takes over (see the liveAsk gate).
          this.chatLiveAsk = null;
        }
        // Any tool/turn event is proof the block cleared: the person answered
        // the prompt and the agent moved on (approved → tool runs; denied →
        // turn ends). The notice and any inline permission panel are stale the
        // moment work resumes.
        this.chatNotice = null;
        this.chatLivePermission = null;
        // Any broker traffic is proof of progress: restart the stuck clock.
        if (this.chatTurnLive && !this.chatAwait) this.chatArmStuck();
        else if (this.chatStuckTimer) { clearTimeout(this.chatStuckTimer); this.chatStuckTimer = null; }
        if (kind === 'tool.start' && tool) {
          // Remember the tool that just started: if it turns out to need
          // permission, the prompt fires from its PreToolUse, so this names what
          // the inline Allow/Deny panel is about.
          this.chatPromptTool = tool;
          // Named immediately from the tool alone; the next poll adds the
          // object once the tool_use row lands in the transcript.
          const generic = chatview.humanize(tool, {});
          // nowPhrase, not `.gerund` — with no input there is no object, and a
          // bare "Reading" is not a sentence. This is what gerundAlone is for.
          this.chatNow = chatview.nowPhrase(generic);
          this.chatNowKind = generic.kind;
          this.chatNowMark = generic.mark;
        } else {
          // A tool finished, or the turn did: it's composing, not acting.
          this.chatNow = null;
          this.chatNowKind = null;
          this.chatNowMark = undefined;
        }
        if (this.chatOn) this.renderChat();
        // Question raised, or work resumed — either way the launcher row's
        // "Your turn" state just moved.
        this.syncRowStates();
        this.notifyParentActivity();
        // If this lane is a subagent, refresh its narration line so the parent's
        // strip shows what it's thinking — the transcript has caught up by the
        // time a tool/turn event fires. (No-op unless it has a parent + runId.)
        if (this.parentId) this.refreshNarration();
        // A tool/turn boundary means the engine just flushed a transcript row —
        // read it now instead of waiting for the next timer tick (from main).
        this.chatPoll();
      }

      /**
       * Paint this lane's subagents strip from its children's live state. Called
       * from renderChat (so it tracks every parent re-render) and pushed by a
       * child whenever its own broker state moves (notifyParentActivity). Each
       * row dives into that child's pane on click — the orchestrator's calm view
       * doubling as a live control panel over its workers.
       */
      /**
       * Poll this lane's native subagents from disk (the <session>/subagents dir)
       * and repaint the strip. Cheap + guarded; runs off the chat poll cycle so
       * it only fires while the chat view is open. Claude drives the spawning; we
       * only surface what it already wrote.
       */
      pollNativeSubs() {
        if (this.nativeSubsPolling || !this.runId) return;
        this.nativeSubsPolling = true;
        ipc.agentSubagents(this.runId, this.autoCwd || this.cwd)
          .then((subs) => {
            const prev = JSON.stringify(this.nativeSubs);
            this.nativeSubs = subs || [];
            if (JSON.stringify(this.nativeSubs) !== prev) this.renderSubagents();
          })
          .catch(() => {})
          .finally(() => { this.nativeSubsPolling = false; });
      }

      // ── Convergence loop ────────────────────────────────────────────────────
      // Two lanes, one shrinking list of disagreements. The reviewer (this lane,
      // when it has a parent) emits findings; the coder (the parent) answers each;
      // resolved items drop out and only genuine standoffs reach you. The whole
      // thing is bounded: CONVERGE_CAP rounds, then every unsettled finding
      // escalates rather than bouncing again, so it can't loop.

      /** Findings parsed from THIS lane's own transcript (the reviewer's output). */
      reviewFindings(): chatview.Finding[] {
        if (!this.chatStream) return [];
        const text = this.chatStream.turns()
          .filter((t) => t.actor === 'agent')
          .flatMap((t) => t.blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text))
          .join('\n\n');
        return chatview.parseFindings(text);
      }

      // ── Tend inbox ──────────────────────────────────────────────────────────
      // Ask THIS lane to read inbox/*.md and propose where each note belongs, as
      // a ```spike-moves``` block. Sets chatTending so renderChat starts scraping
      // the proposals; the person approves each and the agent performs the move.
      tendInbox() {
        if (!isAgentLane(this) || !this.ptyAlive) { status.textContent = 'Open an agent session to tend the inbox'; return; }
        this.chatTending = true;
        if (!this.chatMoves) this.chatMoves = [];
        this.injectMessage(
          'Tend the inbox: list the files in the `inbox/` folder and, for each one, ' +
          'read it and decide where it belongs in this project (a sensible folder plus a ' +
          'descriptive filename). Do NOT move anything yet. Emit your proposals as a single ' +
          'fenced code block tagged `spike-moves` containing a JSON array, each item ' +
          '`{ "from": "<current path>", "to": "<proposed path>", "why": "<one line>" }`. ' +
          'Use project-root-relative paths. If the inbox is empty, say so and emit an empty array.',
        );
        if (this.chatOn) this.renderChat();
      }

      /** Merge freshly-parsed proposals into chatMoves, preserving decided rows. */
      mergeMoves() {
        if (!this.chatTending || !this.chatStream) return;
        const text = this.chatStream.turns()
          .filter((t) => t.actor === 'agent')
          .flatMap((t) => t.blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text))
          .join('\n\n');
        const parsed = chatview.parseMoves(text);
        if (!parsed.length) return;   // nothing emitted yet (or an empty array) — keep what we have
        const prev = new Map((this.chatMoves || []).map((m) => [m.id, m]));
        // A move already decided (approved/skipped) keeps that outcome; only
        // genuinely new proposals start fresh.
        this.chatMoves = parsed.map((m) => prev.get(m.id) || m);
      }

      /**
       * You decided a proposed move. Approve → instruct the agent to perform the
       * filesystem move (same model as the findings loop: the approval instructs,
       * the CLI executes); Skip → leave it in the inbox. Either way mark the row
       * terminal so it stops asking.
       */
      resolveMove(id: string, action: 'approve' | 'skip') {
        const m = (this.chatMoves || []).find((x) => x.id === id);
        if (!m || m.state !== 'proposed') return;
        if (action === 'approve') {
          m.state = 'approved';
          this.injectMessage(`Approved: move \`${m.from}\` to \`${m.to}\` now (create the destination folder if needed).`);
        } else {
          m.state = 'skipped';
        }
        if (this.chatOn) this.renderChat();
      }

      /** The other live agent lanes this review could go to (the coder). */
      candidateCoders(): any[] {
        return sessions.filter((s: any) => s !== this && isAgentLane(s) && s.ptyAlive);
      }

      /** Resolve the coder lane without asking, or null when it needs a choice. */
      defaultCoder(): any {
        const parent = this.parentId ? sessionByPty(this.parentId) : null;
        if (parent && parent.ptyAlive) return parent;      // an explicit subagent link wins
        const cands = this.candidateCoders();
        return cands.length === 1 ? cands[0] : null;       // the sole other agent lane
      }

      /**
       * Hand this reviewer lane's findings to the coder lane and open the
       * convergence panel there. Works whether the reviewer is a subagent child
       * (parent link) or just another tab (the sole other agent lane, or a pick
       * when there are several). The coder answers per-finding; reviewer text
       * rides the message channel, never policy.
       */
      sendReviewToCoder() {
        const found = this.reviewFindings();
        if (!found.length) return;
        const coder = this.defaultCoder();
        if (coder) { coder.receiveReview(found, this.ptyId); return; }
        // Several candidates and no explicit parent → let the person pick which
        // lane is the coder, anchored under the trigger button.
        const cands = this.candidateCoders();
        if (!cands.length) return;
        const btn = this.chatReviewBtn;
        const r = btn ? btn.getBoundingClientRect() : null;
        openMenu(r ? r.left : 200, r ? r.bottom + 4 : 200, cands.map((c: any) => ({
          label: `Send to ${c.name}`,
          fn: () => c.receiveReview(found, this.ptyId),
        })));
      }

      /**
       * Show the reviewer lane's header trigger only when it can do something: this
       * lane has emitted parseable findings AND there's at least one other agent
       * lane to be the coder. The count on the label is the honest promise of what
       * the click will send.
       */
      syncReviewButton() {
        const btn = this.chatReviewBtn;
        if (!btn) return;
        const n = this.candidateCoders().length ? this.reviewFindings().length : 0;
        btn.classList.toggle('show', n > 0);
        btn.textContent = n > 0 ? `Send ${n} finding${n === 1 ? '' : 's'} → coder` : '';
      }

      // ── LaneHandle: this lane as a participant in an exchange ───────────────
      // The convergence controller (lane-controller.ts) reaches a lane only through
      // these; everything else about a Session is none of its business.
      get id(): string { return this.ptyId; }
      get engine(): chatview.Engine { return this.cmd === 'codex' ? 'codex' : 'claude'; }
      isAlive(): boolean { return this.ptyAlive; }
      /** Deliver a message into this lane — the bracketed, queued send. */
      deliver(text: string): boolean { return this.injectMessage(text); }
      /** Read this lane's transcript since `offset`. */
      readTranscript(offset: number) { return ipc.transcriptTail(this.runId || '', undefined, offset, this.ptyId); }

      /**
       * Take a reviewer's findings onto THIS (coder) lane and open/advance the
       * negotiation. The controller owns the loop; Session only builds it with two
       * lane handles + a repaint callback — reusing it for a re-send from the same
       * reviewer (so in-flight progress survives), rebuilding for a different one.
       */
      receiveReview(incoming: chatview.Finding[], reviewerId: string) {
        if (!this.chatReview || this.chatReviewPeer !== reviewerId) {
          this.chatReview?.dispose();
          this.chatReviewPeer = reviewerId;
          const reviewer = reviewerId ? sessionByPty(reviewerId) : null;
          this.chatReview = new LaneReviewExchange({
            coder: this,
            reviewer: reviewer ?? null,
            onChange: () => { if (this.chatOn) this.renderChat(); },
            now: () => Date.now(),
            cap: CONVERGE_CAP,
            timeoutMs: CONVERGE_TIMEOUT_MS,
            tickMs: CONVERGE_TICK_MS,
          });
        }
        this.chatReview.receiveReview(incoming);
      }

      renderSubagents() {
        const host = this.chatSubs;
        if (!host) return;
        const subs = this.nativeSubs || [];
        // The whole right panel shows only while there are subagents; the
        // conversation reclaims the full width otherwise.
        if (this.chatAside) {
          this.chatAside.classList.toggle('show', subs.length > 0);
          // Collapsed folds the panel to a thin rail so the conversation reclaims
          // the width — the panel is no longer pinned open for the session's life.
          this.chatAside.classList.toggle('collapsed', this.subsCollapsed);
        }
        if (!subs.length) { if (this.viewingSub) this.closeSubagentView(); host.replaceChildren(); return; }
        host.replaceChildren();
        const hdr = document.createElement('div');
        hdr.className = 'cwsubs-h';
        const lbl = document.createElement('span');
        lbl.className = 'cwsubs-n';
        const running = subs.filter((s) => !s.done).length;
        // Collapsed rail shows just the count; expanded shows the full label.
        lbl.textContent = this.subsCollapsed
          ? String(subs.length)
          : 'Subagents' + (running ? ` · ${running} working` : '');
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'cwsubs-toggle';
        toggle.title = this.subsCollapsed ? 'Show subagents' : 'Hide subagents';
        toggle.setAttribute('aria-label', toggle.title);
        toggle.innerHTML = icon(this.subsCollapsed ? 'chevron-left' : 'chevron-right', 14);
        toggle.addEventListener('click', () => { this.subsCollapsed = !this.subsCollapsed; this.renderSubagents(); });
        hdr.append(lbl, toggle);
        host.append(hdr);
        // Rail: header + toggle only, rows hidden until the user expands again.
        if (this.subsCollapsed) return;
        subs.forEach((s, i) => {
          // A stable-ish swatch per subagent, strided across the wheel so
          // consecutive ones read distinct (red, teal, orchid…).
          const color = GROUP_COLORS[(i * 5) % GROUP_COLORS.length];
          const cls = s.done ? 'done' : 'run';
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'cwsub ' + cls + (this.viewingSub && this.viewingSub.agentId === s.agentId ? ' on' : '');
          row.innerHTML =
            `<span class="cwsub-ic"><span class="cwsub-glyph"></span></span>` +
            `<span class="cwsub-body"><span class="cwsub-nm"></span><span class="cwsub-now"></span></span>`;
          (row.querySelector('.cwsub-ic') as HTMLElement).style.setProperty('--sc', color);
          (row.querySelector('.cwsub-glyph') as HTMLElement).textContent = s.done ? '✓' : '';
          (row.querySelector('.cwsub-nm') as HTMLElement).textContent = s.description || s.agentType || 'subagent';
          // Its own latest words while working; "Done" once it has finished.
          const activity = s.done ? 'Done' : (s.narration || 'Working…');
          (row.querySelector('.cwsub-now') as HTMLElement).textContent = activity;
          row.title = `${s.description || 'subagent'} — read what it's doing`;
          row.addEventListener('click', () => this.openSubagentView(s));
          host.append(row);
        });
      }

      /**
       * Dive into a subagent read-only: render its OWN transcript (the same chat
       * renderer, no composer) in the viewer overlay. You're watching what it
       * did, not talking to it — exactly the "click-in = visibility" model.
       */
      openSubagentView(sub: any) {
        if (!this.chatSubView || !this.chatSubViewScroll) return;
        this.viewingSub = sub;
        this.subViewStream = new chatview.ChatStream('claude');
        this.subViewOffset = 0;
        const name = this.chatSubView.querySelector('.cwsubview-name');
        if (name) name.textContent = sub.description || sub.agentType || 'subagent';
        this.chatSubViewScroll.replaceChildren();
        this.chatSubView.classList.add('show');
        this.renderSubagents();      // reflect the selected card
        this.pollSubagentView();     // pull its transcript now (and each tick after)
      }

      closeSubagentView() {
        this.viewingSub = null;
        this.subViewStream = null;
        if (this.chatSubView) this.chatSubView.classList.remove('show');
        this.renderSubagents();
      }

      /** Incrementally read the viewed subagent's transcript and re-render it. */
      pollSubagentView() {
        const sub = this.viewingSub;
        if (!sub || !this.runId || !this.subViewStream || !this.chatSubViewScroll) return;
        ipc.agentSubagentTail(this.runId, this.autoCwd || this.cwd, sub.agentId, this.subViewOffset)
          .then((t) => {
            if (!this.viewingSub || this.viewingSub.agentId !== sub.agentId || !this.subViewStream) return;
            if (!t || !t.found) return;
            if (t.reset) { this.subViewStream.reset(); this.subViewOffset = 0; }
            // A subagent's OWN transcript is all `isSidechain: true` — which the
            // chat renderer folds away as noise (right for the main chat, wrong
            // here where it's the whole point). Drop the flag so its turns render.
            const lines = (t.lines || []).map((l: string) => {
              try { const o = JSON.parse(l); delete o.isSidechain; return JSON.stringify(o); }
              catch { return l; }
            });
            this.subViewStream.push(lines);
            this.subViewOffset = t.offset;
            chatview.render(this.chatSubViewScroll!, this.subViewStream.turns(), {
              markdown: renderMarkdown,
              emptyHint: 'This subagent hasn’t said anything yet.',
            });
          })
          .catch(() => {});
      }

      /**
       * Tell this lane's PARENT that its state moved, so the parent's subagents
       * strip repaints live. No-op unless this is a child whose parent's chat is
       * open. This is what makes a child's activity visible from the parent
       * without the child being on screen.
       */
      notifyParentActivity() {
        if (!this.parentId) return;
        const parent = sessionByPty(this.parentId);
        if (parent && parent.chatOn) parent.renderSubagents();
      }

      /**
       * Read this child's latest narration line from its own transcript and stash
       * it on subNarration, so the parent's strip can show what it's thinking
       * ("investigating apply_patch…") rather than a generic tool phrase. Uses a
       * private, incremental stream (the same parser the chat view uses) so it
       * works whether or not this lane's chat is open. Cheap: only the tail since
       * narrOffset is parsed. On a change it pushes a repaint up to the parent.
       */
      refreshNarration() {
        if (this.narrPolling || !this.runId) return;
        if (!this.narrStream) this.narrStream = new chatview.ChatStream(this.cmd === 'codex' ? 'codex' : 'claude');
        this.narrPolling = true;
        ipc.transcriptTail(this.runId, undefined, this.narrOffset, this.ptyId)
          .then((t) => {
            if (!t || !t.found || !this.narrStream) return;
            if (t.reset) { this.narrStream.reset(); this.narrOffset = 0; }
            this.narrStream.push(t.lines);
            this.narrOffset = t.offset;
            // Walk back to the most recent agent turn with real text, take its
            // last text block, and reduce it to a single glanceable line.
            const turns = this.narrStream.turns();
            for (let i = turns.length - 1; i >= 0; i--) {
              if (turns[i].actor !== 'agent') continue;
              const texts = turns[i].blocks
                .filter((b: any) => b.type === 'text' && b.text && b.text.trim())
                .map((b: any) => b.text.trim());
              if (texts.length) { this.subNarration = firstNarrationLine(texts[texts.length - 1]); break; }
            }
            this.notifyParentActivity();
          })
          .catch(() => {})
          .finally(() => { this.narrPolling = false; });
      }

      /**
       * Hand a freshly-spawned subagent its task as a first message, so it starts
       * working on its own — the same pty write the composer uses to send a
       * message, just at boot. Idempotent (openingSent). NOTE: fired off a short
       * settle after first output / a boot fallback, NOT a real "prompt is ready"
       * signal — live use may need to watch for the agent's input prompt before
       * sending. Hardening TODO, and the robust long-term path is passing the task
       * as the engine's own initial-prompt arg (shims/claude, shims/codex).
       */
      sendOpening() {
        if (this.openingSent || !this.openingPrompt || !this.ptyAlive) return;
        this.openingSent = true;
        ipc.ptyWrite(this.ptyId, this.openingPrompt + '\r').catch(() => {});
      }

      /**
       * PTY output means the agent is mid-turn. The transcript can't tell us
       * that — it only gains a line once a turn's block is complete — so the
       * "working" pulse keys off the byte stream, which is the one signal that
       * is live regardless of engine. Quiet for a beat means done.
       */
      chatTouch() {
        if (!this.chatOn) return;
        // Bytes before anyone has spoken are the agent's own startup paint — the
        // banner, the model line, the empty prompt — not work. Treating them as
        // a live turn is what put a Stop button and a spinner on a lane that had
        // never been asked anything. The broker's turn state overrides this the
        // moment it says a turn really is in flight.
        if (!this.chatSpoken && !this.chatTurnLive) return;
        if (!this.chatBusy) { this.chatBusy = true; this.renderChat(); }
        if (this.chatBusyTimer) clearTimeout(this.chatBusyTimer);
        this.chatBusyTimer = setTimeout(() => {
          this.chatBusyTimer = null;
          this.chatBusy = false;
          this.renderChat();
          this.chatPoll();          // one last read so the final turn lands
        }, CHAT_IDLE_MS);
        this.chatArmStuck();
      }

      close() {
        // A closing parent must not strand its subagents (nothing would render
        // a child whose parent left `sessions`). Promote them to this lane's own
        // parent — grandparent if nested, else top-level — so they stay reachable.
        for (const c of childrenOf(this)) c.parentId = this.parentId;
        if (this.idleTimer) clearTimeout(this.idleTimer);   // no stray attention timer after dispose
        if (this.chatTimer) clearInterval(this.chatTimer);
        this.chatReview?.dispose();
        if (this.chatBusyTimer) clearTimeout(this.chatBusyTimer);
        if (this.chatStuckTimer) clearTimeout(this.chatStuckTimer);
        if (this.chatTickTimer) clearInterval(this.chatTickTimer);
        if (this.chatSpinTimer) clearTimeout(this.chatSpinTimer);
        if (this.chatSendTimer) clearTimeout(this.chatSendTimer);
        if (this.chatResubmitTimer) clearTimeout(this.chatResubmitTimer);
        logAction('session_end', {
          name: this.name,
          durationSeconds: Math.round((Date.now() - (this.spawnedAt || Date.now())) / 1000),
          group: groupName(this.groupId),
        });
        // kill the pty + drop its event subscriptions (the old ws close did both
        // implicitly — the server killed the pty when the socket dropped).
        this.ptyAlive = false;
        for (const un of this.ptyUnlisteners || []) { try { un(); } catch {} }
        this.ptyUnlisteners = [];
        ipc.ptyKill(this.ptyId).catch(() => {});
        // The lane is gone: dim the previews it opened. Runs BEFORE this session
        // leaves `sessions` (below) so the frozen lane color/name still resolve.
        orphanLane(this.ptyId);
        this.term.dispose();
        this.pane.remove();
        if (this.tab) this.tab.remove();
        const i = sessions.indexOf(this);
        if (i >= 0) sessions.splice(i, 1);
        // a popped-out session takes its leaf with it.
        if (hasSurface(layout.root, (x) => x.kind === 'terminal' && x.name === this.name)) {
          removeSurface(layout, (x) => x.kind === 'terminal' && x.name === this.name);
          renderLayout();
          saveLayout();
        } else syncColActive();
        // groups are durable workspaces: closing the last tab leaves the group saved
        // (just invisible in the strip until a tab rejoins), not deleted. Explicit
        // "Ungroup" is the only removal path.
        // if we closed the active tab, fall to a neighbour
        if (active === this) {
          active = null;
          const next = sessions[Math.min(i, sessions.length - 1)];
          if (next) activate(next);
          // an open project is never left empty: closing the last session
          // auto-spawns a fresh Claude at the root (no bare empty state). The
          // welcome screen is only for "no project open at all".
          else if (projectPath) spawnDefaultSession();
          else showWelcome();
        }
        renderTabs();
        // If this lane was itself a subagent, drop its row from the parent's strip.
        if (this.parentId) { const par = sessionByPty(this.parentId); if (par && par.chatOn) par.renderSubagents(); }
      }
    }

    // Show one session, hide the rest. Refit + resize the one coming forward —
    // an xterm sized while display:none measures wrong, so we fit on activate.
    function activate(s) {
      // "Active group" is whatever group the focused tab belongs to. When focus
      // crosses a group boundary (incl. to/from ungrouped), that's a group_switch —
      // distinct from group_assign, which is a membership change, not a focus change.
      const fromGroup = active ? groupName(active.groupId) : null;
      const toGroup = groupName(s.groupId);
      if (active !== s && fromGroup !== toGroup) logAction('group_switch', { fromGroup, toGroup });
      active = s;
      refreshSessionContext(s);   // repaint the context bar for the lane you switched to
      s.clearAttention();   // the one you're now looking at no longer needs your attention
      // focusing a strip session brings it forward in the column; focusing a
      // popped-out session leaves the column showing whatever it was showing.
      if (!isPoppedSession(s)) colActive = s;
      syncColActive();
      syncTermLayer();   // move the incoming pane onto the column slot (and park the outgoing one)
      renderTabs();   // active-tab styling lives in the model render
      s.term.focus();
      // The pane was display:none, so its box measured stale. The bug: scrolling
      // in the same tick as fit() races xterm's viewport re-render, so it lands
      // mid-buffer — and since scrollOnUserInput is on, the NEXT keystroke re-runs
      // scrollToBottom after layout settles, which is the "press down-arrow and it
      // jumps to the bottom" you were seeing. So we just need the scroll to fire
      // AFTER the fit's re-render. Three belts: (1) onRender fires exactly when the
      // re-render completes — the precise, timing-free shot for the resize case;
      // (2) an immediate snap covers the case where fit() changes nothing and no
      // render fires; (3) two deferred snaps cover the settle window and dispose
      // the listener. scrollToBottom is cheap + idempotent, so over-firing is free.
      requestAnimationFrame(() => {
        s.resize();                                  // fit to the now-visible box
        // Re-focus after the fit: the synchronous focus() above runs before a
        // freshly-spawned pane has dimensions, and xterm won't focus a 0-size
        // terminal — so a brand-new tab opened dead until you clicked it. Now
        // the cursor is live the moment the terminal appears, ready to type.
        if (active === s) s.term.focus();
        s.following = true;   // activate lands the tab at the bottom, so follow its tail
        const snap = () => s.term.scrollToBottom();
        const sub = s.term.onRender(() => { sub.dispose(); snap(); });
        snap();
        requestAnimationFrame(() => { snap(); requestAnimationFrame(() => { sub.dispose(); snap(); }); });
      });
      markStatus();
      markContext();          // paint cached context immediately…
      refreshAutoContext(s);  // …then re-resolve live (branch may have changed)
      if (typeof paintTermToggle === 'function') paintTermToggle();  // light the footer dock
    }

    // ⌘1..⌘9 tab jump. The strip's rendered `.tab` nodes already sit in visible
    // left-to-right order (groups flattened to their members by renderTabs), so
    // the DOM is the ordering source of truth — no need to re-derive the sort.
    // Popped sessions aren't in the strip, matching the Chrome analogy: these
    // are the tabs you can see. n is 1-based; 9 always lands on the last tab.
    function jumpToStripTab(n: number) {
      const tabs = Array.from(tabsEl.querySelectorAll('.tab')) as HTMLElement[];
      if (!tabs.length) return;
      const el = n >= 9 ? tabs[tabs.length - 1] : tabs[n - 1];
      if (!el) return;
      const s = sessions.find((x) => x.name === el.dataset.sname);
      if (s && s !== active) activate(s);
    }

    function markStatus() {
      // Top-bar status text stays empty — the slot this once reserved for a
      // ⌘K search is now the #kbtn pill beside it (built in the palette wiring
      // below), and #status itself keeps carrying transient worktree messages.
    }

    // Active-work context lives in its own #ctx span (not #status, which carries
    // transient worktree/FS messages) so the two never clobber each other.
    function markContext() {
      if (!ctxEl) return;
      ctxEl.textContent = '';
      const s = active;
      if (!s || !s.autoBranch) return;
      // Worktree sessions get one quiet accent glyph before the branch — the only
      // marker beyond the terminal preamble that this is an isolated lane. Built as
      // a child span (not inline) so it carries its own color; the branch is a text
      // node so a branch name can't inject markup.
      if (s.autoIsWorktree) {
        const g = document.createElement('span');
        g.className = 'wt';
        g.textContent = '⊶';
        g.title = 'isolated worktree';
        ctxEl.append(g, document.createTextNode(' '));
      }
      ctxEl.append(document.createTextNode(s.autoBranch));
      // The PR is a real link: a no-drag-region child (like #kbtn) so the click
      // lands instead of dragging the window, opening the PR via the http(s)-gated
      // opener. Falls back to inert text if gh gave us a number but no URL.
      if (s.autoPr) {
        ctxEl.append(document.createTextNode(' · '));
        const pr = document.createElement('span');
        pr.textContent = `PR #${s.autoPr}`;
        if (s.autoPrUrl) {
          const url = s.autoPrUrl;
          pr.className = 'pr';
          pr.title = `open PR #${s.autoPr} on GitHub`;
          pr.onclick = (e) => { e.stopPropagation(); ipc.openExternal(url).catch(() => {}); };
        }
        ctxEl.append(pr);
      }
    }

    // Resolve the session's branch + PR from its cwd. Fire-and-forget, fail-soft,
    // and guarded: a slow resolve that lands after the user switched tabs must not
    // overwrite the now-active session's readout.
    function refreshAutoContext(s) {
      if (appConfig && appConfig.autoContext && appConfig.autoContext.enabled === false) return;
      if (!s || !s.cwd) return;
      // Prefer the dir the agent actually launched in (an isolated worktree)
      // over the workspace's configured cwd, so the badge reads the real lane.
      const probe = s.autoCwd || s.cwd;
      ipc.resolveAutoContext(probe).then((ctx) => {
        s.autoBranch = ctx && ctx.branch || undefined;
        s.autoPr = ctx && ctx.prNumber || undefined;
        s.autoPrUrl = ctx && ctx.prUrl || undefined;
        s.autoIsWorktree = !!(ctx && ctx.isWorktree);
        if (active === s) markContext();
      }).catch(() => {});
    }

    // ─── render the tab strip from the model ──────────────────────────
    // Layout: one unified left-to-right order shared by groups (each = chip +
    // its members) and ungrouped tabs, so the two interleave freely - a group
    // can sit between two loose tabs and vice versa (see beginStripReorder).
    // Both carry a numeric `order`; renderTabs merges and sorts by it. Items
    // with no order yet (freshly created) sink to the end in creation order;
    // the next reorder normalizes everyone to 0..n-1. Then the + button.
    // A collapsed group shows only its chip (+ count); members are hidden but
    // their ptys keep running.
    function renderTabs() {
      // wipe rendered groups/chips/tabs but keep the transient newname input + addBtn.
      // (.group must be removed too, else empty container slivers accumulate.)
      tabsEl.querySelectorAll('.group, .tab, .chip').forEach(n => n.remove());

      // popped-out sessions LEAVE the strip — a pane is a real separation, not
      // a view; one session, one home. The pane's pill is its tab now (× there
      // closes the session; drag it onto the column's center, or right-click,
      // to rejoin the strip). groupId survives the trip, so a returning
      // session lands back in its group.
      const items: any[] = [];
      for (const g of groups) {
        const mem = membersOf(g.id).filter((s) => !isPoppedSession(s));
        if (mem.length) items.push({ kind: 'group', g, mem, ord: typeof g.order === 'number' ? g.order : undefined });
      }
      for (const s of sessions) {
        // A child lane is not a top-level strip item — it renders nested under
        // its parent (see renderLane), so skip it here alongside popped/grouped.
        if (s.groupId == null && s.parentId == null && !isPoppedSession(s)) items.push({ kind: 'tab', s, ord: typeof s.order === 'number' ? s.order : undefined });
      }
      // unordered items fill in after the highest known order, keeping their
      // relative creation order, so the sort stays total and they land at the end.
      let fill = maxStripOrder() + 1;
      items.forEach((it, i) => { it.i = i; if (typeof it.ord !== 'number') it.ord = fill++; });
      items.sort((a, b) => (a.ord - b.ord) || (a.i - b.i));

      // Per-tab engine badges earn their place only when the strip actually
      // holds more than one engine (Claude + Codex + Terminal in any mix). One
      // engine everywhere → the badge says nothing, so we hide it wholesale via
      // this class rather than per-tab. Popped sessions aren't in the strip, so
      // they don't count toward the mix the user can see here.
      const engs = new Set<string>();
      for (const it of items) {
        if (it.kind === 'group') for (const s of it.mem) engs.add(s.cmd);
        else engs.add(it.s.cmd);
      }
      tabsEl.classList.toggle('mixed-engines', engs.size > 1);

      for (const it of items) {
        if (it.kind === 'group') {
          const box = document.createElement('div');
          box.className = 'group';
          box.style.setProperty('--gc', it.g.color);    // soft tinted shape binds the members
          box.appendChild(buildChip(it.g, it.mem.length));
          if (!it.g.collapsed) for (const s of it.mem) box.appendChild(renderLane(s));
          tabsEl.insertBefore(box, addBtn);
        } else {
          tabsEl.insertBefore(renderLane(it.s), addBtn);
        }
      }
      renderSessionPanel();   // keep the sidebar's vertical roster in step
      renderWorkstreams?.();   // …and the Home launcher's Workstreams list
      updateTabsOverflow();   // refresh the edge-fade cue for the new tab count
    }

    // Overflow cue. Two parts: a soft edge-fade (.ovl/.ovr toggle the mask), and
    // a pinned "+N" badge on each side showing how many tabs are fully hidden
    // that way. The badge is the reliable signal — a bare fade only reads as
    // "more" when a tab's text happens to fall in the fade zone; the count never
    // lands on a blank gap. 1px slack absorbs sub-pixel rounding. Clicking a
    // badge pages the strip toward its hidden tabs.
    const moreL = document.getElementById('tabmore-l') as HTMLButtonElement;
    const moreR = document.getElementById('tabmore-r') as HTMLButtonElement;
    const CARET_L = '<span class="car"><svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 2 3 5l3.5 3"/></svg></span>';
    const CARET_R = '<span class="car"><svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 2 7 5l-3.5 3"/></svg></span>';
    function updateTabsOverflow() {
      const max = tabsEl.scrollWidth - tabsEl.clientWidth;
      tabsEl.classList.toggle('ovl', tabsEl.scrollLeft > 1);
      tabsEl.classList.toggle('ovr', tabsEl.scrollLeft < max - 1);
      // count tabs fully off each edge (viewport-relative, so nesting in a group
      // box doesn't skew it)
      const strip = tabsEl.getBoundingClientRect();
      let hidL = 0, hidR = 0;
      for (const t of tabsEl.querySelectorAll('.tab')) {
        const r = t.getBoundingClientRect();
        if (r.right <= strip.left + 1) hidL++;
        else if (r.left >= strip.right - 1) hidR++;
      }
      moreL.hidden = hidL === 0;
      moreR.hidden = hidR === 0;
      if (hidL) moreL.innerHTML = CARET_L + hidL;
      if (hidR) moreR.innerHTML = hidR + CARET_R;
    }
    // a badge click pages ~80% of the visible width toward its hidden tabs
    moreL.addEventListener('click', () => tabsEl.scrollBy({ left: -tabsEl.clientWidth * 0.8, behavior: 'smooth' }));
    moreR.addEventListener('click', () => tabsEl.scrollBy({ left: tabsEl.clientWidth * 0.8, behavior: 'smooth' }));
    tabsEl.addEventListener('scroll', updateTabsOverflow, { passive: true });
    window.addEventListener('resize', updateTabsOverflow);
    // A mouse wheel only produces deltaY; the strip scrolls horizontally, so
    // translate vertical intent into horizontal movement (trackpads already
    // send deltaX and fall through untouched). Only act when there's actually
    // something to scroll, so the page/other handlers keep the gesture otherwise.
    tabsEl.addEventListener('wheel', (e: WheelEvent) => {
      if (tabsEl.scrollWidth <= tabsEl.clientWidth) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;   // already a horizontal gesture
      tabsEl.scrollLeft += e.deltaY;
      updateTabsOverflow();   // update the fade now, not on the async scroll tick
      e.preventDefault();
    }, { passive: false });

    // One lane for the strip. Normally just its tab; when the lane has subagent
    // children, a `.subtree` wrapper holds the parent tab (carrying a fold pill)
    // plus each child tab indented beneath it. The wrapper is a plain container,
    // not a strip item — it inherits the parent's slot in the drag order, so
    // reorder/pop logic (which keys off the parent tab) is untouched.
    function renderLane(s) {
      const kids = childrenOf(s).filter((c) => !isPoppedSession(c));
      const parentTab = buildTab(s);
      if (!kids.length) return parentTab;
      parentTab.classList.add('has-kids');
      // A fold pill on the parent: caret + count. Click toggles the subtree; the
      // stopPropagation keeps it from also activating/renaming the lane.
      const fold = document.createElement('span');
      fold.className = 'kids';
      fold.innerHTML = `<span class="kcaret">${icon(s.subCollapsed ? 'chevron-right' : 'chevron-down', 11)}</span><span class="kn">${kids.length}</span>`;
      fold.title = (s.subCollapsed ? 'Show' : 'Hide') + ` ${kids.length} subagent${kids.length > 1 ? 's' : ''}`;
      fold.addEventListener('mousedown', (e) => e.stopPropagation());   // don't start a strip drag
      fold.addEventListener('click', (e) => { e.stopPropagation(); s.subCollapsed = !s.subCollapsed; renderTabs(); });
      parentTab.querySelector('.nm').after(fold);
      const wrap = document.createElement('div');
      wrap.className = 'subtree' + (s.subCollapsed ? ' collapsed' : '');
      wrap.appendChild(parentTab);
      if (!s.subCollapsed) for (const c of kids) wrap.appendChild(buildTab(c, true));
      return wrap;
    }

    // ─── vertical session roster (sidebar) ────────────────────────────
    // A second view over the SAME session/group model the strip renders, pinned
    // above the file tree — for users who find the horizontal strip unintuitive.
    // Unlike the strip it lists popped sessions too (a complete roster you can
    // jump to), grouped under their group headers. Clicking a row activates the
    // session; the × closes it; the attention dot mirrors the strip's. Rebuilt
    // from renderTabs() so every existing trigger updates both views at once.
    const sessionPanelEl = document.getElementById('sessionpanel')!;
    // Roster prefs, persisted independently of the layout blob (they're a sidebar
    // affordance, not part of the tiling tree): collapsed hides the rows behind
    // the header; pos docks the roster above or below the file tree.
    let sessionPanelCollapsed = localStorage.getItem('spike.spanel.collapsed') === '1';
    let sessionPanelPos: 'top' | 'bottom' = localStorage.getItem('spike.spanel.pos') === 'bottom' ? 'bottom' : 'top';
    // Re-dock the (persistent) panel node above or below the tree rows. Called
    // after every tree repaint (loadTree drops it) and when the pref flips.
    function placeSessionPanel() {
      if (!sessionPanelEl || sessionPanelEl.parentElement !== treeEl) return;
      sessionPanelEl.classList.toggle('bottom', sessionPanelPos === 'bottom');
      if (sessionPanelPos === 'bottom') treeEl.appendChild(sessionPanelEl);
      else treeEl.insertBefore(sessionPanelEl, treeEl.firstChild);
      measureSessionPanel();
    }
    // Both headers are sticky, so the tree's root row has to stop BELOW the
    // roster instead of under it. The offset is the roster's live height, which
    // moves with collapse, session count and group nesting — so publish it as a
    // CSS var and let the root row's `top` calc off it. Zero when the roster is
    // docked at the bottom (nothing above the root row to clear).
    function measureSessionPanel() {
      if (!treeEl) return;
      const h = sessionPanelEl && sessionPanelPos !== 'bottom' ? sessionPanelEl.offsetHeight : 0;
      treeEl.style.setProperty('--spanel-h', h + 'px');
    }
    // Height also changes without going through placeSessionPanel (a rename
    // field opening, a group collapsing), so watch the box itself.
    if (sessionPanelEl && typeof ResizeObserver === 'function') {
      new ResizeObserver(() => measureSessionPanel()).observe(sessionPanelEl);
    }

    // ─── recently-touched panel (sidebar) ─────────────────────────────
    // A lightweight MRU jump-list docked at the foot of the file tree. The tree
    // is the knowledge-graph view of the vault (folders, notes, [[wikilinks]]);
    // this is the "what did I just touch" view over the same files, newest
    // first — so a file you're iterating on is one click away without hunting
    // for it in the tree. Two provenances, and the row tells them apart:
    // an EDIT (agent write or on-disk change) gets a filled accent dot; a plain
    // OPEN gets a hollow ring. Default collapsed — it's a convenience surface,
    // not a primary one — with the open/closed state persisted.
    const recentPanelEl = document.getElementById('recentpanel')!;
    let recentPanelCollapsed = localStorage.getItem('spike.rpanel.collapsed') !== '0'; // default collapsed
    // The list keeps a deep MRU (so a long session's history stays reachable);
    // once it grows past RECENT_SEARCH_AT a filter field slides in so the list
    // stays skimmable instead of turning into a wall of rows.
    const RECENT_CAP = 40;
    const RECENT_SEARCH_AT = 8;
    let recentQuery = '';
    type RecentReason = 'edited' | 'opened';
    // `color` is the workspace (group) color of the lane that touched the file —
    // an agent editing in a colored workspace, or an owner-stamped open. It's
    // sticky: once a file is learned to belong to a workspace, later touches
    // keep that hue even if they arrive without one (a plain user re-open).
    let recentTouched: { path: string; name: string; reason: RecentReason; color?: string }[] = [];

    // Record a touch. An edit outranks a prior 'opened' tag (the stronger signal
    // wins); an open never downgrades a file already marked edited. Either way
    // the file jumps to the top of the MRU. `color` carries the touching
    // workspace's color when there is one.
    function noteTouched(path: string, reason: RecentReason, color?: string) {
      if (!path || typeof path !== 'string') return;
      const name = path.split('/').pop() || path;
      const prev = recentTouched.find((r) => r.path === path);
      const kept: RecentReason = prev && prev.reason === 'edited' ? 'edited' : reason;
      const col = color || (prev && prev.color) || undefined;   // sticky workspace hue
      recentTouched = [{ path, name, reason: kept, color: col }, ...recentTouched.filter((r) => r.path !== path)].slice(0, RECENT_CAP);
      renderRecentPanel();
    }

    // The workspace (group) color of a lane by its pty/session id — the hue the
    // recent dot wears. undefined for an ungrouped lane or an unknown id.
    function workspaceColorFor(sid: string | undefined | null): string | undefined {
      if (!sid) return undefined;
      const g = laneGroupFor(sessionByPty(sid));
      return (g && g.color) || undefined;
    }

    // Drop entries whose file no longer exists in the freshly-loaded tree (moved,
    // deleted, or a non-file path the watcher reported — dirs, .git internals).
    // allPaths is the file set rebuilt by buildNoteIndex; empty before first load.
    function pruneRecentTouched() {
      if (!allPaths.size) return;
      const before = recentTouched.length;
      recentTouched = recentTouched.filter((r) => allPaths.has(r.path));
      if (recentTouched.length !== before) renderRecentPanel();
    }

    // Dock the panel just above the file tree (below the session roster, above
    // the root row) — the MRU is a primary jump surface, so it rides at the top
    // of the folders rather than hiding at the sidebar's foot.
    function placeRecentPanel() {
      if (!recentPanelEl || recentPanelEl.parentElement !== treeEl) return;
      recentPanelEl.classList.remove('bottom');
      const root = treeEl.querySelector(':scope > .root');
      if (root) treeEl.insertBefore(recentPanelEl, root);
      else treeEl.appendChild(recentPanelEl);
    }

    function renderRecentPanel() {
      if (!recentPanelEl) return;
      // Hidden entirely until you've touched something — an empty "Recently
      // touched" header is just noise above the tree. It materializes on the
      // first open/edit and stays for the session.
      const show = !!projectPath && recentTouched.length > 0;
      recentPanelEl.classList.toggle('show', show);
      if (!show) { recentPanelEl.innerHTML = ''; return; }
      recentPanelEl.classList.toggle('collapsed', recentPanelCollapsed);
      recentPanelEl.innerHTML = '';
      const hdr = document.createElement('div');
      hdr.className = 'shdr';
      hdr.title = 'files you recently opened or edited — click to ' + (recentPanelCollapsed ? 'expand' : 'collapse');
      const chev = document.createElement('span'); chev.className = 'schev';
      chev.innerHTML = icon(recentPanelCollapsed ? 'chevron-right' : 'chevron-down', 12);
      const lbl = document.createElement('span'); lbl.className = 'slbl';
      lbl.textContent = recentPanelCollapsed && recentTouched.length ? `Recently touched · ${recentTouched.length}` : 'Recently touched';
      hdr.append(chev, lbl);
      hdr.addEventListener('click', () => {
        recentPanelCollapsed = !recentPanelCollapsed;
        localStorage.setItem('spike.rpanel.collapsed', recentPanelCollapsed ? '1' : '0');
        renderRecentPanel();
      });
      recentPanelEl.appendChild(hdr);
      if (recentPanelCollapsed) { recentPanelEl.dataset.searchShown = '0'; return; }

      // A full rebuild runs on every touch/edit — if the user is mid-type in the
      // filter, capture focus + caret so the keystroke isn't swallowed, and
      // restore below.
      const active = document.activeElement as HTMLInputElement | null;
      const hadSearchFocus = !!active && active.classList?.contains('rsearch');
      const caret = hadSearchFocus ? active!.selectionStart : null;

      // The filter slides in only once the list is long enough to warrant it.
      // Below the threshold it isn't rendered at all (and any stale query is
      // cleared, so a shrinking list can't stay secretly filtered).
      const wantSearch = recentTouched.length > RECENT_SEARCH_AT;
      if (!wantSearch) recentQuery = '';
      const prevShown = recentPanelEl.dataset.searchShown === '1';
      if (wantSearch) {
        const wrap = document.createElement('div'); wrap.className = 'rsearch-wrap';
        const input = document.createElement('input');
        input.className = 'rsearch'; input.type = 'text'; input.placeholder = 'Filter recent…';
        input.value = recentQuery; input.spellcheck = false;
        input.setAttribute('aria-label', 'Filter recently touched files');
        // Filtering is row-only — never re-render the whole panel from here, or
        // the input (and its focus) would be torn out from under the cursor.
        input.addEventListener('input', () => { recentQuery = input.value; renderRecentRows(rows); });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { recentQuery = ''; input.value = ''; renderRecentRows(rows); }
        });
        wrap.appendChild(input);
        recentPanelEl.appendChild(wrap);
        // Smooth reveal: if it wasn't showing last render, mount collapsed then
        // add .show next frame so max-height/opacity animate. Already-open stays
        // open with no re-animation on subsequent touches.
        if (prevShown) wrap.classList.add('show');
        else requestAnimationFrame(() => wrap.classList.add('show'));
      }
      recentPanelEl.dataset.searchShown = wantSearch ? '1' : '0';

      const rows = document.createElement('div'); rows.className = 'rrows';
      recentPanelEl.appendChild(rows);
      renderRecentRows(rows);

      if (hadSearchFocus) {
        const inp = recentPanelEl.querySelector('.rsearch') as HTMLInputElement | null;
        if (inp) { inp.focus(); if (caret != null) inp.setSelectionRange(caret, caret); }
      }
    }

    // Fill the rows container with the recents that match the current filter.
    // Split out from renderRecentPanel so typing re-renders only the list, not
    // the header/search field (keeping the input's focus + caret intact).
    function renderRecentRows(rows: HTMLElement) {
      rows.innerHTML = '';
      const q = recentQuery.trim().toLowerCase();
      const matches = q
        ? recentTouched.filter((r) => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q))
        : recentTouched;
      // (the panel is hidden entirely when there are no recents, so the only
      // empty state reachable here is a filter query that matches nothing)
      if (!matches.length) {
        const e = document.createElement('div'); e.className = 'rempty';
        e.textContent = 'No recent file matches “' + recentQuery.trim() + '”.';
        rows.appendChild(e); return;
      }
      for (const r of matches) {
        const row = document.createElement('div');
        row.className = 'rrow' + (r.reason === 'edited' ? ' edited' : '');
        row.title = (r.reason === 'edited' ? 'edited · ' : 'opened · ') + r.path;
        const dot = document.createElement('span'); dot.className = 'rdot';
        // The dot's hue is the workspace that touched the file (a colored agent
        // lane); files with no workspace keep the neutral grey ring/accent from
        // CSS. Fill reads edited-vs-opened: an edit is a SOLID dot in the
        // workspace hue, a plain open a hollow RING in it. Inline beats the base.
        if (r.color) {
          if (r.reason === 'edited') dot.style.background = r.color;
          else dot.style.boxShadow = `inset 0 0 0 1.5px ${r.color}`;
        }
        const ic = document.createElement('span'); ic.className = 'ric ' + fileTint(r.name); ic.innerHTML = icon(fileIcon(r.name), 15);
        const nm = document.createElement('span'); nm.className = 'rnm'; nm.textContent = r.name;
        row.append(dot, ic, nm);
        // immediate parent folder as a dimmed tail, so two like-named files stay apart
        const parent = r.path.slice(0, r.path.lastIndexOf('/')).split('/').pop();
        if (parent) { const d = document.createElement('span'); d.className = 'rdir'; d.textContent = parent; row.append(d); }
        row.addEventListener('click', () => openFile(r.path, r.name, null));
        rows.appendChild(row);
      }
    }
    // Paint a session row's context-occupancy ring from its last stored reading,
    // without touching the network. Kept separate from refreshSessionContext so
    // a roster rebuild (which mints a fresh .sring element) can restore the ring
    // synchronously. No reading, a zero reading, or no ring element → unpainted.
    // Compact token count: 126000 → "126k", 1000000 → "1m".
    function fmtTokens(n: number) {
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0) + 'm';
      if (n >= 1000) return Math.round(n / 1000) + 'k';
      return String(n);
    }
    function applyCtxRing(s: any) {
      const ring = s.ctxRing as HTMLElement | undefined;
      if (!ring) return;
      const row = ring.parentElement as HTMLElement | null;   // the .srow — the hover target
      const pct = s.ctxPercent;
      if (typeof pct !== 'number' || pct <= 0) {
        ring.classList.remove('has', 'warn', 'crit');
        ring.style.removeProperty('--pct');
        if (row) row.removeAttribute('title');
        return;
      }
      ring.classList.add('has');
      ring.style.setProperty('--pct', Math.min(100, pct).toFixed(1) + '%');
      // The sweep escalates amber past ~75% and red past ~90%, so a nearly-full
      // session reads at a glance even without hovering for the number.
      ring.classList.toggle('warn', pct >= 75 && pct < 90);
      ring.classList.toggle('crit', pct >= 90);
      // Hover leads with what's LEFT (that's the number you act on), with the
      // token detail behind it. Whole row is the hover target since the bar
      // itself is a 2px sliver. e.g. "58% context left · 126k / 1m used".
      const left = Math.max(0, Math.round(100 - pct));
      const detail = s.ctxTokens && s.ctxWindow
        ? ` · ${fmtTokens(s.ctxTokens)} / ${fmtTokens(s.ctxWindow)} used` : '';
      if (row) row.title = `${left}% context left${detail}`;
    }

    // Re-read a session's live context occupancy and repaint its bar in place.
    // Keyed by runId — the exact transcript. A Claude lane has one from spawn
    // (Spike minted it, see Session.agentSessionId), so the reading is exact
    // immediately: blank for a new conversation, real occupancy for a resumed
    // one. A Codex lane has no id until its first agent event, so it falls back
    // to cwd and the backend picks the newest transcript for that directory —
    // a guess, and only used where there's nothing better. Cheap point-in-time
    // read; safe to call on activate + every turn.ended. Only agent lanes are
    // measured; shells never get a bar.
    function refreshSessionContext(s: any) {
      if (!s) return;
      if (s.cmd !== 'claude' && s.cmd !== 'codex') return;
      // Need at least one key.
      const cwd = s.autoCwd || s.cwd || '';
      if (!s.runId && !cwd) return;
      ipc.sessionContext(s.runId || '', cwd).then((c) => {
        if (c && c.found) { s.ctxPercent = c.percent; s.ctxTokens = c.tokens; s.ctxWindow = c.contextWindow; }
        else { s.ctxPercent = 0; s.ctxTokens = 0; s.ctxWindow = 0; }
        applyCtxRing(s);
      }).catch(() => {});
    }
    // Keep the visible lane's ring current even when no agent event fires (a long
    // turn mid-flight, or hooks not wired): a light poll of just the active
    // session. One cheap single-file read every 15s; other lanes refresh on
    // activate and on their own turn.ended.
    setInterval(() => { if (active) refreshSessionContext(active); }, 15000);

    function buildSessionRow(s: any) {
      const row = document.createElement('div');
      const rst = sessionRowState(s);
      row.className = 'srow' + (s === colActive ? ' active' : '')
        + (s.attention && !rst ? ' attn' : '') + (rst === 'ready' ? ' unread' : rst ? ' ' + rst : '');
      row.dataset.sname = s.name;
      // The leading mark is the agent's own engine icon (Claude/Codex/shell) —
      // it identifies WHAT the row is. Group membership is already conveyed by
      // the nesting under a group header, so no group-color dot is needed. The
      // mark never animates: identity isn't a state. What the lane NEEDS is said
      // by the state dot beside it — the same working / unread / needs-you
      // vocabulary the strip tab and the Home launcher use.
      const eng = document.createElement('span'); eng.className = 'seng'; eng.innerHTML = engineGlyph(s.cmd);
      const sdot = document.createElement('span'); sdot.className = 'sdot';
      const nm = document.createElement('span'); nm.className = 'snm'; nm.textContent = s.name;
      row.append(eng, sdot, nm);
      if (isPoppedSession(s)) {   // mark sessions living in their own split pane
        const pop = document.createElement('span'); pop.className = 'spop';
        pop.title = 'in a split pane'; pop.innerHTML = icon('columns', 12);
        row.append(pop);
      }
      const x = document.createElement('span'); x.className = 'sx'; x.title = 'close session'; x.innerHTML = icon('x', 12);
      x.addEventListener('click', (e) => { e.stopPropagation(); s.close(); });
      row.append(x);
      // Context-occupancy ring: a small donut in the far-right slot (shared with
      // the × on hover) that fills as the session's chat context fills (see
      // applyCtxRing / refreshSessionContext). Only agent sessions get the
      // element; it stays unpainted until there's a real transcript reading, so
      // shell tabs and not-yet-run sessions show nothing. Re-attached each
      // rebuild, so restore the last known reading immediately.
      if (s.cmd === 'claude' || s.cmd === 'codex') {
        const ring = document.createElement('span'); ring.className = 'sring';
        row.append(ring);
        s.ctxRing = ring;
        applyCtxRing(s);
        // Fetch a reading if we haven't got one yet (e.g. after a roster
        // rebuild). A lane with no context reads blank, so this is safe to call
        // for any agent lane.
        if (typeof s.ctxPercent !== 'number') refreshSessionContext(s);
      }
      // Same gestures as the strip tab — the roster is a second view over the
      // same session, so it must not fall through to the file tree's menu
      // (New File / Collapse all mean nothing for a session). Single-click
      // activates, double-click renames — via clickOrRename so it survives the
      // renderSessionPanel() rebuild the same way the strip tab does.
      row.addEventListener('click', (e) => clickOrRename(s, e, () => s.panelRow));
      row.addEventListener('dblclick', (e) => e.preventDefault());
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        openGroupMenu(s, e.clientX, e.clientY, row);
      });
      s.panelRow = row;   // so flagActivity/clearAttention can light it without a full re-render
      return row;
    }
    // The roster's own menu — for the header and for the panel's empty space.
    // Anywhere inside the roster is session territory, so it must never fall
    // through to the file tree's menu: offering "New File" over the sessions
    // list describes the wrong surface entirely.
    function openRosterMenu(x: number, y: number) {
      openMenu(x, y, [
        { label: 'New session', fn: () => beginNewSession() },
        { sep: true },
        { label: sessionPanelCollapsed ? 'Expand sessions' : 'Collapse sessions',
          fn: () => {
            sessionPanelCollapsed = !sessionPanelCollapsed;
            localStorage.setItem('spike.spanel.collapsed', sessionPanelCollapsed ? '1' : '0');
            renderSessionPanel();
          } },
        { label: sessionPanelPos === 'bottom' ? 'Move sessions to top' : 'Move sessions to bottom',
          fn: () => {
            sessionPanelPos = sessionPanelPos === 'bottom' ? 'top' : 'bottom';
            localStorage.setItem('spike.spanel.pos', sessionPanelPos);
            placeSessionPanel();
          } },
        { sep: true },
        ...sidebarMenuItems(),
      ]);
    }
    // The panel's background (gaps between rows, the dead space under a short
    // list). Rows, group headers and the header stop the bubble with their own
    // menus, so this only ever fires on genuinely empty roster space.
    sessionPanelEl?.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      openRosterMenu(e.clientX, e.clientY);
    });
    function renderSessionPanel() {
      if (!sessionPanelEl) return;
      sessionPanelEl.innerHTML = '';
      sessionPanelEl.classList.toggle('show', sessions.length > 0);
      sessionPanelEl.classList.toggle('collapsed', sessionPanelCollapsed);
      if (!sessions.length) return;
      // Header doubles as the collapse toggle: a chevron + "SESSIONS" (count when
      // collapsed so it stays informative), and a + to spawn. Right-click flips
      // the roster between the top and bottom of the sidebar.
      const hdr = document.createElement('div'); hdr.className = 'shdr';
      const chev = document.createElement('span'); chev.className = 'schev';
      chev.innerHTML = icon(sessionPanelCollapsed ? 'chevron-right' : 'chevron-down', 12);
      const lbl = document.createElement('span'); lbl.className = 'slbl';
      lbl.textContent = sessionPanelCollapsed ? `SESSIONS · ${sessions.length}` : 'SESSIONS';
      const add = document.createElement('span'); add.className = 'sadd'; add.title = 'new session'; add.innerHTML = icon('plus', 14);
      add.addEventListener('click', (e) => { e.stopPropagation(); beginNewSession(); });
      hdr.append(chev, lbl, add);
      hdr.title = 'click to ' + (sessionPanelCollapsed ? 'expand' : 'collapse') + ' · right-click to move';
      hdr.addEventListener('click', () => {
        sessionPanelCollapsed = !sessionPanelCollapsed;
        localStorage.setItem('spike.spanel.collapsed', sessionPanelCollapsed ? '1' : '0');
        renderSessionPanel();
      });
      hdr.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        openRosterMenu(e.clientX, e.clientY);
      });
      sessionPanelEl.append(hdr);
      placeSessionPanel();
      if (sessionPanelCollapsed) return;   // header only; rows hidden
      // Same merged/sorted order as the strip (groups + ungrouped by `order`),
      // but popped sessions are kept in — the roster shows everything.
      const items: any[] = [];
      for (const g of groups) {
        const mem = membersOf(g.id);
        if (mem.length) items.push({ kind: 'group', g, mem, ord: typeof g.order === 'number' ? g.order : undefined });
      }
      for (const s of sessions) {
        // Children nest under their parent's row (see below), not at top level.
        if (s.groupId == null && s.parentId == null) items.push({ kind: 'tab', s, ord: typeof s.order === 'number' ? s.order : undefined });
      }
      let fill = maxStripOrder() + 1;
      items.forEach((it, i) => { it.i = i; if (typeof it.ord !== 'number') it.ord = fill++; });
      items.sort((a, b) => (a.ord - b.ord) || (a.i - b.i));
      for (const it of items) {
        if (it.kind === 'group') {
          const g = it.g;
          const box = document.createElement('div'); box.className = 'grp';
          // --gc drives the header tint + the members' rail, same colour the strip
          // chip/card derive their wash from — the two views share one language.
          box.style.setProperty('--gc', g.color);
          const gh = document.createElement('div'); gh.className = 'grphdr'; gh.dataset.gid = g.id;
          // a chevron stands in for the strip chip's collapse affordance (and the
          // swatch — the header's own tint carries the group colour now).
          const chev = document.createElement('span'); chev.className = 'gchev';
          chev.innerHTML = icon(g.collapsed ? 'chevron-right' : 'chevron-down', 12);
          // .gnm so beginGroupRename can edit in place here, same as the chip
          const gn = document.createElement('span'); gn.className = 'gnm'; gn.textContent = g.name || 'group';
          const gc = document.createElement('span'); gc.className = 'gcount'; gc.textContent = String(it.mem.length);
          gh.append(chev, gn, gc);
          // Single-click collapses, double-click renames — same shared `g.collapsed`
          // the strip drives, so the two views stay in step. Detect the pair off a
          // panel-local timestamp (not g.lastLabelClick, which the strip chip owns)
          // via the same trick as the chip: the collapse re-renders the panel, so a
          // native dblclick would land on a torn-down node.
          gh.addEventListener('click', (e) => {
            if (g.lastPanelClick != null && e.timeStamp - g.lastPanelClick < DBL_MS) {
              g.lastPanelClick = null; beginGroupRename(g, gh); return;
            }
            g.lastPanelClick = e.timeStamp;
            g.collapsed = !g.collapsed; onGroupCollapse(g);
          });
          gh.addEventListener('dblclick', (e) => e.preventDefault());
          gh.addEventListener('contextmenu', (e) => {
            e.preventDefault(); e.stopPropagation();
            openChipMenu(g, e.clientX, e.clientY);
          });
          box.append(gh);
          if (!g.collapsed) {
            // rows sit inside a rail-bearing wrapper so the group colour binds them
            // to the header, the way grouped tabs sit in the strip's tinted card.
            const memBox = document.createElement('div'); memBox.className = 'grpmem';
            for (const s of it.mem) appendRosterRow(memBox, s);
            box.append(memBox);
          }
          sessionPanelEl.append(box);
        } else {
          appendRosterRow(sessionPanelEl, it.s);
        }
      }
    }

    // A roster row plus, indented beneath it, a row for each of its subagent
    // children — the vertical twin of the strip's subtree. Children render even
    // when popped (the roster shows everything), so no popped-filter here.
    function appendRosterRow(host, s) {
      host.append(buildSessionRow(s));
      for (const c of childrenOf(s)) {
        const row = buildSessionRow(c);
        row.classList.add('subrow');
        host.append(row);
      }
    }

    // one tab element, wired to the model. Stored back on s.tab so close()/
    // activate() can reach it.
    // The engine mark shown to the LEFT of a tab name — same glyphs as the +
    // launcher's segmented control. Coral Claude spark, inverted Codex hexagon,
    // an ink terminal chevron. CSS only reveals it when the strip is mixed
    // (see renderTabs' `mixed-engines` toggle) — one engine → no badge, no noise.
    const engineGlyph = (cmd: string): string =>
      cmd === 'codex'
        ? `<span class="cicon-codex"><img src="${codexLogo}" width="12" height="12" alt="Codex"></span>`
        : cmd === 'shell'
        ? icon('terminal', 12)
        : `<img src="${claudeLogo}" width="12" height="12" alt="Claude">`;

    // Single-click activates a session; double-click renames it. We can't lean on
    // the native `dblclick` event here: the first click runs activate() →
    // renderTabs(), which tears down and rebuilds every strip node, so the two
    // clicks land on DIFFERENT elements and the browser fires dblclick on #tabs,
    // not the tab — the rename never triggers. So detect the double-click off the
    // SESSION (its timestamp survives the rebuild) and resolve the CURRENT node
    // via hostFor() at rename time (s.tab/s.panelRow are refreshed every render).
    const DBL_MS = 400;
    function clickOrRename(s, e, hostFor) {
      // Only the SECOND click of a pair renames — so require a prior recorded
      // click (lastLabelClick != null), else the very first click on a session
      // would rename itself. null after a rename resets the pair.
      if (s.lastLabelClick != null && e.timeStamp - s.lastLabelClick < DBL_MS) {
        s.lastLabelClick = null;
        const host = hostFor();
        if (host) beginTabRename(s, host);
        return;
      }
      s.lastLabelClick = e.timeStamp;
      activate(s);
    }

    function buildTab(s, isChild = false) {
      const tab = document.createElement('div');
      // the bright pill marks what the COLUMN is showing (colActive), not the
      // globally focused session — a focused popped tab outshining the column's
      // real occupant read as "my drag didn't work, it's still at the top".
      // .dot is a state slot, not an alert — see the four-state vocabulary in
      // index.html (#tabs .tab .dot). .attn is the byte-stream fallback, used
      // only when the lane has no broker state of its own (a plain shell).
      const tst = sessionRowState(s);
      tab.className = 'tab pill' + (s === colActive ? ' active' : '')
        + (s.attention && !tst ? ' attn' : '') + (tst === 'ready' ? ' unread' : tst ? ' ' + tst : '')
        + (isChild ? ' child' : '');
      tab.innerHTML = `<span class="eng">${engineGlyph(s.cmd)}</span><span class="dot"></span><span class="nm"></span><span class="ctl more" title="group">${icon('dots', 14)}</span><span class="ctl x" title="close session">${icon('x', 13)}</span>`;
      tab.querySelector('.nm').textContent = s.name;
      tab.dataset.sname = s.name;   // maps the element back to its session for strip reorder
      // grouped tabs are bound by the container; no per-tab border accent needed.
      if (s.groupId != null) tab.classList.add('grouped');
      tab.addEventListener('click', (e) => clickOrRename(s, e, () => s.tab));
      // Drag behavior splits by membership:
      //  • an UNGROUPED tab is a top-level strip item - drag it sideways to
      //    reorder it among groups/tabs, or drag it down off the strip to pop
      //    it into its own pane (beginStripReorder handles both).
      //  • a GROUPED member tab still pops straight out via the dock engine.
      // The 5px threshold in either keeps plain clicks working.
      tab.addEventListener('mousedown', (e) => {
        if ((e.target as HTMLElement).closest('.more, .x, .nmedit, .kids')) return;
        // A child lane is bound to its parent's subtree — it doesn't reorder in
        // the strip or pop out on drag; a plain click still activates it.
        if (s.parentId != null) return;
        if (s.groupId == null) beginStripReorder(e, tab, s);
        else beginDockDrag(e, { surface: { kind: 'terminal', name: s.name } }, s.name);
      });
      // dblclick handled by clickOrRename above (native dblclick is unreliable
      // once the click rebuilds the strip); keep the guard against a stray one.
      tab.addEventListener('dblclick', (e) => e.preventDefault());
      tab.addEventListener('contextmenu', (e) => { e.preventDefault(); openGroupMenu(s, e.clientX, e.clientY); });
      tab.querySelector('.more').addEventListener('click', (e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        openGroupMenu(s, r.left, r.bottom + 2);
      });
      tab.querySelector('.x').addEventListener('click', (e) => { e.stopPropagation(); s.close(); });
      s.tab = tab;
      return tab;
    }

    // group header chip. Single click toggles collapse; double click renames.
    function buildChip(g, count) {
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.dataset.gid = g.id;
      // tinted fill + solid text so the pill reads as a label, not a button.
      // The wash and ink are derived per theme in CSS from --gc (see #tabs
      // .chip); baking hex+alpha here would freeze the group's look at the
      // theme it was rendered in.
      chip.style.setProperty('--gc', g.color);
      chip.innerHTML = `<span class="gnm"></span>` +
        (g.collapsed ? `<span class="gcount">${count}</span>` : '');
      chip.querySelector('.gnm').textContent = g.name;
      // drag the chip sideways to move the whole group within the strip. The
      // 5px threshold in beginStripReorder leaves the single-click collapse and
      // double-click rename below it untouched. Groups never pop out (no
      // session arg), so a downward drag just reorders.
      chip.addEventListener('mousedown', (e) => beginStripReorder(e, chip.parentElement as HTMLElement, null));
      // Single-click collapses, double-click renames — detected off the GROUP's
      // timestamp for the same reason as the tab: the collapse toggle rebuilds
      // the strip, so a native dblclick would miss (see clickOrRename). g.chip is
      // refreshed every render, so it resolves to the current node at rename time.
      g.chip = chip;
      chip.addEventListener('click', (e) => {
        if (g.lastLabelClick != null && e.timeStamp - g.lastLabelClick < DBL_MS) {
          g.lastLabelClick = null;
          if (g.chip) beginGroupRename(g, g.chip);
          return;
        }
        g.lastLabelClick = e.timeStamp;
        g.collapsed = !g.collapsed; onGroupCollapse(g);
      });
      chip.addEventListener('dblclick', (e) => e.preventDefault());
      chip.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openChipMenu(g, e.clientX, e.clientY); });
      return chip;
    }

    // ─── drag to reorder the strip (FLIP) ─────────────────────────────
    // Works on any top-level strip item - a group card (handle = its chip) or
    // an ungrouped tab. Grab it and it lifts to track the cursor while the
    // other items slide to open the slot; on drop everything settles with a
    // short FLIP. Because groups and ungrouped tabs share one `order` scale
    // (renderTabs), they interleave freely. An ungrouped tab dragged down off
    // the strip pops into its own pane instead (the `popSess` escape). A 5px
    // threshold keeps clicks / collapse / rename intact. Group order is durable
    // (persisted); ungrouped-tab order is in-memory (tabs are transient anyway).
    const GROUP_GAP = 4;   // #tabs flex gap - the slot a lifted item vacates

    // top-level strip items left→right: each .group card and each ungrouped
    // .tab (grouped member tabs live inside a card, so they're not direct
    // children and don't take part in strip reordering).
    function stripItemEls(): HTMLElement[] {
      return (Array.from(tabsEl.children) as HTMLElement[])
        .filter((el) => el.classList && (el.classList.contains('group') || el.classList.contains('tab')));
    }
    // stable identity for an item across a re-render: "g:<id>" or "t:<name>".
    function stripKey(el: HTMLElement): string {
      if (el.classList.contains('group')) return 'g:' + (el.querySelector('.chip') as HTMLElement).dataset.gid;
      return 't:' + el.dataset.sname;
    }
    // Highest order currently assigned on the shared group+tab scale (-1 if
    // none). The single source of truth for "where does the end of the strip
    // sit": nextStripOrder() places a freshly created item just past it, and
    // renderTabs() seeds unordered items from it so they sort to the end.
    function maxStripOrder(): number {
      let m = -1;
      for (const g of groups) if (typeof g.order === 'number') m = Math.max(m, g.order);
      for (const s of sessions) if (s.groupId == null && typeof s.order === 'number') m = Math.max(m, s.order);
      return m;
    }
    function nextStripOrder(): number { return maxStripOrder() + 1; }

    function beginStripReorder(e: MouseEvent, movingEl: HTMLElement, popSess: any) {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX, startY = e.clientY;
      // a poppable tab carries a surface so it can hand off to the dock engine
      // (ghost + target highlight) the moment it leaves the strip.
      const dockSrc: DockSrc | null = popSess ? { surface: { kind: 'terminal', name: popSess.name } } : null;
      let live = false, mode: 'reorder' | 'dock' = 'reorder';
      let shield: HTMLElement | null = null;
      let els: HTMLElement[] = [], others: HTMLElement[] = [];
      let di = 0, W = 0, t = -1, stripBottom = 0;
      const rectOf = new Map<HTMLElement, DOMRect>();   // pre-drag geometry, frozen

      // ── dock mode: the tab has left the strip; the real pill stays home
      // (dimmed) while the dock ghost + pane highlight take over - same feedback
      // as dragging a pane, and nothing fights #tabs' overflow clip. ──
      const enterDock = () => {
        if (mode === 'dock') return;
        mode = 'dock';
        movingEl.style.transform = '';            // drop the lift; pill rests in place
        movingEl.classList.add('popping');        // dim it: "this is leaving the strip"
        for (const b of others) b.style.transform = '';   // close the opened slot
        if (!dockGhost) {
          dockGhost = document.createElement('div');
          dockGhost.className = 'dockghost';
          dockGhost.textContent = popSess.name;
          document.body.appendChild(dockGhost);
        }
      };
      const leaveDock = () => {
        if (mode !== 'dock') return;
        mode = 'reorder';
        movingEl.classList.remove('popping');
        clearDockHl();
        if (dockGhost) { dockGhost.remove(); dockGhost = null; }
      };

      const move = (ev: MouseEvent) => {
        if (!live) {
          if (Math.abs(ev.clientX - startX) < 5 && Math.abs(ev.clientY - startY) < 5) return;
          live = true;
          els = stripItemEls();
          els.forEach((b) => rectOf.set(b, b.getBoundingClientRect()));
          others = els.filter((b) => b !== movingEl);
          di = els.indexOf(movingEl);                 // moving item's original slot (once)
          W = rectOf.get(movingEl)!.width + GROUP_GAP;
          stripBottom = tabsEl.getBoundingClientRect().bottom;   // cached: avoids a reflow per move
          shield = document.createElement('div');
          shield.className = 'dragshield';
          shield.style.cursor = 'grabbing';
          document.body.appendChild(shield);
          movingEl.classList.add('dragging');
          others.forEach((b) => b.classList.add('sliding'));
        }
        // off the bottom of the strip, hand to the dock engine (poppable only)
        if (dockSrc && ev.clientY > stripBottom + 16) {
          enterDock();
          dockGhost!.style.left = ev.clientX + 12 + 'px';
          dockGhost!.style.top = ev.clientY + 12 + 'px';
          updateDockTarget(ev.clientX, ev.clientY, dockSrc);   // paints the pane highlight
          return;
        }
        leaveDock();
        // reorder mode: the pill lifts and tracks the cursor horizontally
        movingEl.style.transform = `translateX(${ev.clientX - startX}px)`;
        // target rank among the OTHER items = how many sit left of the cursor
        t = 0;
        for (const b of others) {
          const r = rectOf.get(b)!;
          if (ev.clientX > r.left + r.width / 2) t++;
        }
        // open the slot at rank t: items the cursor has crossed shift aside.
        // `others` is `els` minus the moving item, in order, so a neighbor's
        // index r IS its rank; r >= di means it sat after the moving item.
        others.forEach((b, r) => {
          let dx = 0;
          if (r >= di && t > r) dx = -W;          // moving item passed it, heading right
          else if (r < di && t <= r) dx = W;      // moving item passed it, heading left
          b.style.transform = dx ? `translateX(${dx}px)` : '';
        });
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        if (shield) shield.remove();
        if (!live) return;                        // never crossed threshold: a click
        if (mode === 'dock') {
          const tgt = dockTarget;
          if (dockGhost) { dockGhost.remove(); dockGhost = null; }
          clearDockHl();
          movingEl.classList.remove('dragging', 'popping');
          movingEl.style.transform = '';
          if (tgt) finishDock(dockSrc!, tgt.leafId, tgt.zone);   // land on the chosen edge
          else popSession(popSess);                              // dead space → default split
          return;
        }
        const beforeKey = t >= 0 && t < others.length ? stripKey(others[t]) : null;
        flipStripReorder(movingEl, beforeKey, els);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    }

    // Renumber the unified order so the moving item lands before `beforeKey`
    // (null = end), then FLIP every item from where it visually sits now (drag
    // transforms baked in) to its settled spot, so nothing teleports.
    function flipStripReorder(movingEl: HTMLElement, beforeKey: string | null, oldEls: HTMLElement[]) {
      const movingKey = stripKey(movingEl);
      const first = new Map<string, number>();
      for (const el of oldEls) first.set(stripKey(el), el.getBoundingClientRect().left);

      // new key sequence: pull the moving item out, drop it before beforeKey.
      const keys = oldEls.map(stripKey).filter((k) => k !== movingKey);
      let at = beforeKey == null ? keys.length : keys.indexOf(beforeKey);
      if (at < 0) at = keys.length;
      keys.splice(at, 0, movingKey);

      // write the order back onto the model; persist only groups that moved.
      // name -> session once, so the per-key loop stays O(n), not O(n^2).
      const byName = new Map(sessions.map((s) => [s.name, s]));
      keys.forEach((k, i) => {
        if (k.startsWith('g:')) {
          const g = groupById(Number(k.slice(2)));
          if (g && g.order !== i) { g.order = i; persistGroup(g); }
        } else {
          const s = byName.get(k.slice(2));
          if (s) s.order = i;
        }
      });
      logAction('strip_reorder', { item: movingKey, index: keys.indexOf(movingKey) });
      renderTabs();   // fresh elements, no inline transforms

      // Last + invert: park each new element at its old spot, then release it.
      const play: HTMLElement[] = [];
      for (const el of stripItemEls()) {
        const k = stripKey(el);
        if (!first.has(k)) continue;
        const dx = first.get(k)! - el.getBoundingClientRect().left;
        if (Math.abs(dx) < 0.5) continue;
        el.style.transition = 'none';
        el.style.transform = `translateX(${dx}px)`;
        play.push(el);
      }
      requestAnimationFrame(() => {
        for (const el of play) { el.style.transition = 'transform .18s ease'; el.style.transform = ''; }
        setTimeout(() => { for (const el of play) { el.style.transition = ''; el.style.transform = ''; } }, 220);
      });
    }

    // Right-click a group chip: pick its color, rename, or ungroup. The swatch
    // row is the "let me choose the color" affordance (creation just seeds one).
    function openChipMenu(g, x, y) {
      closeGroupMenu(); closeMenu();   // the two menu families share the sidebar now
      const m = document.createElement('div');
      m.id = 'gmenu';
      const row = document.createElement('div');
      row.className = 'swrow';
      for (const c of GROUP_COLORS) {
        const sw = document.createElement('span');
        sw.className = 'swatch' + (c === g.color ? ' on' : '');
        sw.style.background = c;
        sw.title = c;
        sw.addEventListener('click', (e) => { e.stopPropagation(); g.color = c; persistGroup(g); closeGroupMenu(); renderTabs(); });
        row.appendChild(sw);
      }
      m.appendChild(row);
      const sep = document.createElement('div'); sep.className = 'sep'; m.appendChild(sep);
      const item = (label, fn, opts: any = {}) => {
        const it = document.createElement('div');
        it.className = 'item' + (opts.dim ? ' dim' : '');
        const t = document.createElement('span');
        t.textContent = label; it.appendChild(t);
        it.addEventListener('click', (e) => { e.stopPropagation(); closeGroupMenu(); fn(); });
        m.appendChild(it);
      };
      item('New tab in this group', () => newTabInGroup(g));
      // Rename edits the strip chip when there is one; a group whose members are
      // all popped has no strip card, so the sidebar roster header stands in.
      item('Rename group', () => {
        const chip = tabsEl.querySelector(`.chip[data-gid="${g.id}"]`)
          || sessionPanelEl?.querySelector(`.grphdr[data-gid="${g.id}"]`);
        if (chip) beginGroupRename(g, chip);
      });
      item('Ungroup', () => ungroupWorkspace(g), { dim: true });

      topLayer.appendChild(m);   // above #termlayer, or the terminal occludes it
      const r = m.getBoundingClientRect();
      m.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 6)) + 'px';
      m.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 6)) + 'px';
      gmenuEl = m;
      setTimeout(() => document.addEventListener('mousedown', onDocDownForMenu, true), 0);
    }

    // When a group collapses, if the active session is inside it, keep it
    // running but show the nearest still-visible tab instead. Nothing is killed.
    function onGroupCollapse(g) {
      if (g.collapsed && active && active.groupId === g.id) {
        const visible = sessions.find(s => s.groupId == null ||
          !(groupById(s.groupId) || {}).collapsed);
        if (visible) { activate(visible); return; } // activate() re-renders
      }
      renderTabs();
    }

    // inline-rename a session label (Enter/blur commit, Escape cancel). Renames
    // the session label only — the running claude is untouched. `host` is
    // whichever view the rename was invoked from: a strip tab (.nm) or a sidebar
    // roster row (.snm). Popped sessions have no strip tab, so the roster row is
    // the only place they CAN be renamed.
    function beginTabRename(s, host) {
      if (!host) return;
      const nmEl = host.querySelector('.nm, .snm');
      if (!nmEl || host.querySelector('.nmedit')) return;
      const input = document.createElement('input');
      input.className = 'nmedit';
      input.value = s.name;
      nmEl.replaceWith(input);
      input.focus();
      input.select();
      let done = false;
      const commit = (ok) => {
        if (done) return; done = true;
        const raw = input.value.trim();
        if (ok && raw && raw !== s.name) {
          // layout surfaces reference sessions by name — rename them in step.
          const old = s.name;
          s.name = raw;
          let inLayout = false;
          for (const lf of leaves(layout.root))
            for (const x of lf.surfaces)
              if (x.kind === 'terminal' && x.name === old) { x.name = raw; inLayout = true; }
          if (inLayout) { renderLayout(); saveLayout(); }
        }
        renderTabs();
      };
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commit(true);
        else if (e.key === 'Escape') commit(false);
      });
      input.addEventListener('blur', () => commit(true));
    }

    // Commit a group rename — shared by the chip's inline edit and the palette.
    // The disk key IS the name, so EVERY rename path must move the file
    // (unpersist the old name, persist the new) or saved workspaces orphan.
    function renameGroup(g, newName: string) {
      const raw = (newName || '').trim();
      if (!raw || raw === g.name) return;
      const oldName = g.name;
      g.name = raw;
      unpersistGroup(oldName);
      persistGroup(g);
      renderTabs();
    }

    // inline-rename a group via its chip.
    function beginGroupRename(g, chip) {
      const nmEl = chip.querySelector('.gnm');
      if (!nmEl || chip.querySelector('.gnmedit')) return;
      const input = document.createElement('input');
      input.className = 'gnmedit';
      input.value = g.name;
      nmEl.replaceWith(input);
      input.focus();
      input.select();
      let done = false;
      const commit = (ok) => {
        if (done) return; done = true;
        if (ok) renameGroup(g, input.value);
        renderTabs();   // renameGroup may no-op (unchanged/empty); the edit field must go either way
      };
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commit(true);
        else if (e.key === 'Escape') commit(false);
      });
      input.addEventListener('blur', () => commit(true));
    }

    // ─── group context menu ───────────────────────────────────────────
    let gmenuEl = null;
    function closeGroupMenu() {
      if (gmenuEl) { gmenuEl.remove(); gmenuEl = null; }
      document.removeEventListener('mousedown', onDocDownForMenu, true);
    }
    function onDocDownForMenu(e) {
      if (gmenuEl && !gmenuEl.contains(e.target)) closeGroupMenu();
    }
    // The session menu, shared by the strip tab and the sidebar roster row —
    // they're two views over the same session, so they get the same actions.
    // `host` is the element the menu was opened from; rename edits in place
    // there rather than always jumping to the strip.
    function openGroupMenu(s, x, y, host?) {
      closeGroupMenu(); closeMenu();   // ditto — never leave two menus on screen
      const m = document.createElement('div');
      m.id = 'gmenu';
      const add = (label, fn, opts: any = {}) => {
        const it = document.createElement('div');
        it.className = 'item' + (opts.dim ? ' dim' : '');
        if (opts.color) {
          const sw = document.createElement('span');
          sw.className = 'sw'; sw.style.background = opts.color;
          it.appendChild(sw);
        }
        const t = document.createElement('span');
        t.textContent = label; it.appendChild(t);
        it.addEventListener('click', (e) => { e.stopPropagation(); closeGroupMenu(); fn(); });
        m.appendChild(it);
      };
      const sep = () => { const d = document.createElement('div'); d.className = 'sep'; m.appendChild(d); };

      add('Rename', () => beginTabRename(s, host || s.tab || s.panelRow));
      // A popped session has no strip tab, so it can only reach this menu from the
      // roster — and from there the useful move is the return trip, not another split.
      if (isPoppedSession(s)) add('Move back to tab strip', () => unpopSession(s));
      else add('Open in split pane', () => popSession(s));
      // Only agent lanes have a transcript to render as conversation; a shell
      // gets no dead entry.
      if (CHAT_ENABLED && isAgentLane(s)) {
        sep();
        add(s.chatOn ? 'Terminal view' : 'Chat view', () => s.toggleChat());
      }
      sep();
      add('Hand off to new agent…', () => openHandoffSheet(s));
      // Spawn a scoped child agent that this lane keeps watching (Phase 2's
      // manual trigger). Only agent lanes can be an orchestrator; a shell has no
      // conversation to brief a child from.
      if (isAgentLane(s)) add('Spawn subagent…', () => openSpawnPrompt(s));
      // Subagent linkage (Phase 1: set the parent/child relationship by hand; a
      // spawn trigger fills it in automatically later). Parent candidates are the
      // other lanes that wouldn't form a cycle — a lane can't parent its own
      // ancestor. Detach is offered only when this lane already has a parent.
      if (s.parentId != null) {
        add('Detach from parent', () => {
          const par = sessionByPty(s.parentId);
          s.parentId = undefined; renderTabs();
          if (par && par.chatOn) par.renderSubagents();   // drop the row from its strip
        });
      } else {
        const parents = sessions.filter(o => o !== s && !isPoppedSession(o) && !wouldCycle(s, o));
        if (parents.length) add('Make subagent of…', () => {
          const r = (host || s.tab || s.panelRow)?.getBoundingClientRect?.();
          openMenu(r ? r.left : x, r ? r.bottom + 2 : y, parents.map(p => ({
            label: p.name,
            fn: () => {
              s.parentId = p.ptyId; s.groupId = null; p.subCollapsed = false;
              renderTabs(); activate(p);
              if (p.chatOn) p.renderSubagents();   // the new child shows up live
            },
          })));
        });
      }
      sep();
      add('New group', () => newGroupFor(s));
      const others = groups.filter(g => g.id !== s.groupId);
      if (others.length) {
        sep();
        for (const g of others) add('Add to ' + g.name, () => assignTo(s, g.id), { color: g.color });
      }
      if (s.groupId != null) {
        sep();
        add('Remove from group', () => assignTo(s, null), { dim: true });
      }
      // menu twin of the × — the roster's × is hover-only, so without this the
      // menu would be the one place a session can't be closed.
      sep();
      add('Close session', () => s.close());

      topLayer.appendChild(m);   // above #termlayer, or the terminal occludes it
      // clamp to viewport so the menu never spills off the right/bottom edge.
      const r = m.getBoundingClientRect();
      const left = Math.min(x, window.innerWidth - r.width - 6);
      const top = Math.min(y, window.innerHeight - r.height - 6);
      m.style.left = Math.max(6, left) + 'px';
      m.style.top = Math.max(6, top) + 'px';
      gmenuEl = m;
      setTimeout(() => document.addEventListener('mousedown', onDocDownForMenu, true), 0);
    }

    // ─── subagents: spawn a scoped child lane ────────────────────────────
    // The engine-agnostic core of Phase 2. A subagent is a child lane briefed
    // with `task`, forked into its OWN worktree via the same machinery handoff
    // uses (pty_handoff_spawn) — so parallel children never stomp each other —
    // and nested under `source` as a subagent (parentId). Unlike handoff this
    // does NOT retire the source: the orchestrator keeps running and watches its
    // workers from the subagents strip. Focus stays on the source so you see the
    // strip light up; the child boots on construction, no activate needed.
    //
    // Both manual triggers (the lane menu + the strip's +) and the future
    // `spike spawn` control command land here. Returns the child Session.
    function spawnSubagent(source: any, task: string, opts: any = {}) {
      const engine = opts.engine || (source.cmd === 'codex' ? 'codex' : 'claude');
      // Isolation is the caller's choice, defaulting to the common case. 'read'
      // shares the parent's cwd (no worktree) — right for research/analysis and
      // anything that doesn't write. 'write' forks a worktree (via handoff) so
      // parallel edits can't stomp each other.
      const mode: 'read' | 'write' = opts.mode === 'write' ? 'write' : 'read';
      // Only 'write' takes the handoff path (fork + snapshot bundle). 'read' is a
      // plain spawn in the parent's cwd — no fork, nothing carried.
      const handoff = mode === 'write'
        ? {
            sourceId: source.ptyId,
            recap: task,
            includeFiles: true,
            includeBranchDiff: true,
            includeWorkspace: !!source.spawnGroup,
            includeActivity: false,
          }
        : undefined;
      const child = new Session(
        uniqueSessionName(source.name + '-sub'),
        source.autoCwd || source.cwd,     // read: shares this; write: handoff forks from it
        engine,
        source.spawnGroup,
        handoff,
      );
      child.parentId = source.ptyId;          // nest it under the orchestrator
      child.subMode = mode;
      // The findings convention lives in the base system prompt (pty.rs), so any
      // reviewing lane — subagent or sibling tab — emits the machine-readable
      // block when its task is a review. Nothing to append here.
      child.openingPrompt = task;             // delivered on boot so the child actually starts
      source.subCollapsed = false;            // make sure the new child is visible
      logAction('subagent_spawn', { source: source.name, child: child.name, engine, mode });
      renderTabs();                           // re-render now that parentId is set (nests it)
      if (source.chatOn) source.renderSubagents();   // light up the watch strip
      return child;
    }

    // The minimal task prompt for a manual spawn — a small centered card with a
    // task box. ⌘/Ctrl+Enter or the Spawn button fires; Esc or a backdrop click
    // cancels. Deliberately tiny: the real briefing machinery is spawnSubagent.
    function openSpawnPrompt(source: any) {
      closeMenu(); closeGroupMenu();
      const ov = document.createElement('div');
      ov.className = 'spawnprompt';
      const card = document.createElement('div'); card.className = 'sp-card';
      const h = document.createElement('div'); h.className = 'sp-h'; h.textContent = 'Spawn a subagent';
      const sub = document.createElement('div'); sub.className = 'sp-sub';
      sub.textContent = `A new agent that starts on this task and reports back, nested under ${source.name}.`;
      const ta = document.createElement('textarea');
      ta.className = 'sp-in'; ta.rows = 3; ta.placeholder = 'What should this subagent do?';
      // Isolation toggle: Research (shares this cwd — for reading/analysis) vs
      // Edit (its own worktree — for changes that shouldn't touch your tree).
      let mode: 'read' | 'write' = 'read';
      const modes = document.createElement('div'); modes.className = 'sp-modes';
      const mkMode = (val: 'read' | 'write', label: string, hint: string) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'sp-mode' + (val === mode ? ' on' : ''); b.dataset.mode = val;
        b.innerHTML = `<span class="sp-mode-t"></span><span class="sp-mode-h"></span>`;
        (b.querySelector('.sp-mode-t') as HTMLElement).textContent = label;
        (b.querySelector('.sp-mode-h') as HTMLElement).textContent = hint;
        b.addEventListener('click', () => {
          mode = val;
          modes.querySelectorAll('.sp-mode').forEach((x) => x.classList.toggle('on', (x as HTMLElement).dataset.mode === val));
        });
        return b;
      };
      modes.append(
        mkMode('read', 'Research', 'shares your files'),
        mkMode('write', 'Edit', 'its own worktree'),
      );
      const acts = document.createElement('div'); acts.className = 'sp-actions';
      const cancel = document.createElement('button'); cancel.className = 'sp-cancel'; cancel.textContent = 'Cancel';
      const go = document.createElement('button'); go.className = 'sp-go primary'; go.textContent = 'Spawn';
      acts.append(cancel, go);
      card.append(h, sub, ta, modes, acts);
      ov.append(card);
      const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
      const submit = () => { const v = ta.value.trim(); if (!v) return; close(); spawnSubagent(source, v, { mode }); };
      function onKey(e: KeyboardEvent) {
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
      }
      cancel.addEventListener('click', close);
      go.addEventListener('click', submit);
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
      topLayer.appendChild(ov);
      document.addEventListener('keydown', onKey, true);
      // Defer focus past the menu-close/terminal-refocus settling, or the pty
      // behind the overlay can steal it back and keystrokes never reach the box.
      requestAnimationFrame(() => ta.focus());
    }

    // Hand off a live session to a fresh, briefed agent. Opens the preview/
    // confirm sheet: an editable recap, per-component manifest toggles, and a
    // target engine picker (briefable engines only — shell is NOT a handoff
    // target, per the plan §5). Launch spawns a new lane whose boot() routes
    // through pty_handoff_spawn, which forks a worktree from the source's HEAD,
    // carries its snapshot, and briefs the target with the composed bundle.
    let handoffEl: HTMLElement | null = null;
    function closeHandoff() {
      // The MutationObserver on <body> re-derives `overlay-open` from OVERLAY_SEL
      // (which now includes #handoff-overlay), so removing the node is enough —
      // it re-shows the terminal layer on its own.
      if (handoffEl) { handoffEl.remove(); handoffEl = null; }
      document.removeEventListener('keydown', onHandoffKey, true);
    }
    function onHandoffKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); closeHandoff(); }
    }
    function openHandoffSheet(s: any) {
      if (handoffEl) closeHandoff();
      // Target defaults to the source engine when it's briefable + installed,
      // else the first available briefable engine.
      const briefable = ['claude', 'codex'].filter(isEngineAvailable);
      let engine = (s.cmd === 'codex' || s.cmd === 'claude') && isEngineAvailable(s.cmd)
        ? s.cmd : (briefable[0] || 'claude');
      const hasWorkspace = !!s.spawnGroup;
      const state = { files: true, branchDiff: true, workspace: hasWorkspace, activity: true };

      const overlay = document.createElement('div');
      overlay.id = 'handoff-overlay';
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeHandoff(); });

      const box = document.createElement('div');
      box.id = 'handoff';
      box.addEventListener('mousedown', (e) => e.stopPropagation());

      const title = document.createElement('div');
      title.className = 'htitle'; title.textContent = `Hand off "${s.name}" to a new agent`;
      const sub = document.createElement('div');
      sub.className = 'hsub';
      sub.textContent = s.autoBranch
        ? `Source is on branch ${s.autoBranch}. The target starts already briefed.`
        : 'The target agent starts already briefed on this session.';

      const lab = (t: string) => { const l = document.createElement('div'); l.className = 'lab'; l.textContent = t; return l; };

      // RECAP — editable; the trusted, user-authored summary the target reads first.
      const recap = document.createElement('textarea');
      recap.value = `Picking up where "${s.name}" left off${s.autoBranch ? ` (branch ${s.autoBranch})` : ''}. `;
      recap.placeholder = 'What was this session doing? The target reads this first.';

      // MANIFEST — per-component toggles.
      const toggles = document.createElement('div'); toggles.className = 'toggles';
      const tog = (key: keyof typeof state, name: string, note: string, enabled = true) => {
        const row = document.createElement('label'); row.className = 'tog';
        const cb = document.createElement('input'); cb.type = 'checkbox';
        cb.checked = state[key] && enabled; cb.disabled = !enabled;
        cb.addEventListener('change', () => { state[key] = cb.checked; });
        const nm = document.createElement('span'); nm.className = 'tname'; nm.textContent = name;
        const nt = document.createElement('span'); nt.className = 'tnote'; nt.textContent = note;
        row.append(cb, nm, nt);
        return row;
      };
      toggles.append(
        tog('branchDiff', 'Branch & diff', 'forks a worktree'),
        tog('files', 'Current Spike view', 'open file + selection'),
        tog('activity', 'Recent activity', 'from this lane'),
        tog('workspace', 'Workspace prompt', hasWorkspace ? s.spawnGroup : 'none', hasWorkspace),
      );

      // ENGINE — briefable targets only (no shell).
      const modes = document.createElement('div'); modes.className = 'modes';
      const mk = (m: string, label: string, iconHtml: string) => {
        const available = isEngineAvailable(m);
        const b = document.createElement('div');
        b.className = 'mode' + (m === engine ? ' on' : '') + (available ? '' : ' disabled');
        b.innerHTML = iconHtml + `<span>${label}</span>`;
        if (!available) b.title = `${label} is not installed`;
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', () => {
          if (!available) return;
          engine = m;
          modes.querySelectorAll('.mode').forEach((x: any) => x.classList.toggle('on', x === b));
        });
        return b;
      };
      modes.append(
        mk('claude', 'Claude', `<span class="cicon"><img src="${claudeLogo}" width="14" height="14" alt=""></span>`),
        mk('codex', 'Codex', `<span class="cicon cicon-codex"><img src="${codexLogo}" width="14" height="14" alt=""></span>`),
      );

      // ACTIONS.
      const actions = document.createElement('div'); actions.className = 'actions';
      const cancel = document.createElement('button'); cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => closeHandoff());
      const launch = document.createElement('button'); launch.className = 'primary'; launch.textContent = 'Hand off';
      launch.addEventListener('click', () => {
        const targetGroup = state.workspace ? s.spawnGroup : undefined;
        const target = new Session(
          uniqueSessionName(s.name), s.autoCwd || s.cwd, engine, targetGroup,
          {
            sourceId: s.ptyId,
            recap: recap.value,
            includeFiles: state.files,
            includeBranchDiff: state.branchDiff,
            includeWorkspace: state.workspace,
            includeActivity: state.activity,
          },
        );
        // Mirror the source's visual group so the pair reads as related.
        if (state.workspace && s.groupId != null) target.groupId = s.groupId;
        logAction('agent_handoff', { source: s.name, target: target.name, engine, ...state });
        closeHandoff();
        activate(target);
        applyDefaultView(target);
      });
      actions.append(cancel, launch);

      box.append(title, sub, lab('Recap'), recap, lab('Carry'), toggles, lab('Target engine'), modes, actions);
      overlay.appendChild(box);
      document.body.appendChild(overlay);   // observer hides the terminal layer
      handoffEl = overlay;
      recap.focus(); recap.setSelectionRange(recap.value.length, recap.value.length);
      document.addEventListener('keydown', onHandoffKey, true);
    }

    // move a session into a group (or out, id=null). Emptying a group no longer
    // deletes it — groups are durable workspaces; an empty one just stops rendering
    // (renderTabs skips it) until a tab rejoins. Explicit "Ungroup" is the only delete.
    function assignTo(s, gid) {
      s.groupId = gid;
      logAction('group_assign', { name: s.name, group: gid ? (groupById(gid) || {}).name : null });
      renderTabs();
    }

    // Dissolve a group: members stay (ungrouped, ptys alive) but the saved
    // workspace file goes — the one deliberate delete in the group model.
    // Shared by the chip menu and the palette.
    function ungroupWorkspace(g) {
      for (const s of membersOf(g.id)) s.groupId = null;
      const gi = groups.findIndex(x => x.id === g.id);
      if (gi >= 0) groups.splice(gi, 1);
      unpersistGroup(g.name);
      renderTabs();
    }

    // Land on a workspace: its first live tab, else a fresh tab spawned into
    // it. Shared by settings' "Open ↗" card action and the palette — and the
    // only door into a saved-but-empty workspace, which the strip never shows.
    function focusWorkspace(g) {
      const mem = membersOf(g.id);
      if (mem.length) activate(mem[0]);
      else newTabInGroup(g);
    }

    // create a new group, persist it, assign this session, then inline-prompt for a
    // name on its fresh chip. Color cycles through the palette.
    function newGroupFor(s) {
      const g = { id: ++gseq, name: 'Group ' + gseq, color: GROUP_COLORS[(gseq - 1) % GROUP_COLORS.length], collapsed: false,
                  cwd: '', description: '', pinnedPaths: [], isolation: 'shared' as const, mcpEnabled: [],
                  order: nextStripOrder(),   // newest group lands at the right end of the strip
                  createdAt: new Date().toISOString() };
      groups.push(g);
      persistGroup(g);
      assignTo(s, g.id);   // renders
      const chip = tabsEl.querySelector(`.chip[data-gid="${g.id}"]`);
      if (chip) beginGroupRename(g, chip);
    }

    // Open a fresh Claude tab bound to a workspace. This is the meaningful surface
    // for per-group prompts: the group's .md is injected at spawn (the server reads
    // it), so the tab MUST know its group before the ws opens — hence we pass it
    // through the constructor, not via a later assignTo. No cwd on the group → fall
    // back to the usual launch cwd; the server falls back again to its default if
    // that isn't a real dir. The action never blocks on a missing cwd.
    function newTabInGroup(g) {
      const cwd = (g.cwd && g.cwd.trim()) || defaultSpawnCwd();
      const s = new Session(uniqueSessionName(g.name), cwd, defaultSpawnEngine(), g.name);   // 4th arg binds the spawn group
      s.groupId = g.id;
      logAction('group_assign', { name: s.name, group: g.name });
      activate(s);   // re-renders, now showing the tab inside its group
      applyDefaultView(s);
    }

    // ─── tab strip controls ───────────────────────────────────────────
    // The + button. We swap it for an inline name field so naming a session
    // feels native, not like a browser prompt.
    const addBtn = document.createElement('div');
    addBtn.className = 'add';
    addBtn.title = 'new session';
    addBtn.innerHTML = icon('plus', 15);
    tabsEl.appendChild(addBtn);
    addBtn.addEventListener('click', () => beginNewSession());   // no opts: strip launcher, cwd from workspace/default

    // Default working dir for a new session: the open project root, else the
    // configured spawn default. Deliberately NOT the tree selection — hovering
    // a folder on the way to + must not relocate the session; per-folder cwds
    // are a workspace concern.
    function defaultSpawnCwd() {
      return projectPath || (appConfig && appConfig.spawnDefaults && appConfig.spawnDefaults.cwd) || '';
    }

    // Default CLI engine for new tabs: the user's Settings choice, with a
    // liveness check against the cached detection. If the configured engine
    // isn't installed (uninstalled after settings, or this Spike was opened
    // on a different machine), fall back to whichever IS installed; finally
    // fall back to shell.
    //
    // The result: a user with `engine: codex` in config who uninstalls Codex
    // gets a Claude tab on next spawn (with no broken "Codex" tab labeled like
    // an agent that isn't running), not a dead-shell that pretends to be Codex.
    function defaultSpawnEngine(): string {
      const configured = (appConfig && appConfig.spawnDefaults && appConfig.spawnDefaults.engine) || 'claude';
      if (configured === 'shell') return 'shell';
      if (isEngineAvailable(configured)) return configured;
      // Live fallback: prefer the OTHER known engine if it's installed
      const other = configured === 'claude' ? 'codex' : 'claude';
      if (isEngineAvailable(other)) return other;
      return 'shell';
    }

    // Which face a freshly-spawned agent lane opens in — the terminal or the
    // calm chat view. This isn't a toggle people flip all day: a non-coder wants
    // chat every time, a terminal-lover never wants it. So it's a set-once
    // default, applied only on new user-initiated spawns — never on layout
    // restore, which keeps whatever view a session already had. A plain shell
    // has no transcript, so it silently ignores this and stays a terminal.
    //
    // Resolution: a workspace's own choice (Settings ▸ a workspace ▸ Default
    // view) wins; absent that, the global default (Settings ▸ Defaults) decides.
    // With NO preference set anywhere the default is CHAT — the calm view is the
    // one we want a first-time lane to open in; a terminal-lover sets Terminal
    // (globally or per workspace) and it sticks. So only an explicit 'terminal'
    // opens the raw terminal; anything else (chat, or unset) opens chat.
    function defaultSpawnView(group?: any): 'terminal' | 'chat' {
      const wsView = group && (group.view === 'terminal' || group.view === 'chat') ? group.view : null;
      const globalView = appConfig && appConfig.spawnDefaults && appConfig.spawnDefaults.view;
      if (!CHAT_ENABLED) return 'terminal';
      return (wsView || globalView) === 'terminal' ? 'terminal' : 'chat';
    }
    function applyDefaultView(s: any) {
      const group = s ? (groupById(s.groupId) || (s.spawnGroup ? groups.find((g: any) => g.name === s.spawnGroup) : null)) : null;
      if (defaultSpawnView(group) === 'chat' && isAgentLane(s)) s.toggleChat(true);
    }

    // The + launcher: a small popover that asks WHAT (Claude — the default — or a
    // plain Terminal), which WORKSPACE, and an optional name. No folder field:
    // the workspace's cwd decides, else the project root / spawn default.
    // Hitting Enter straight away still gives you Claude at the root, like the
    // old + did.
    let launcherEl = null;
    function closeLauncher() {
      if (!launcherEl) return;
      launcherEl.remove(); launcherEl = null;
      document.removeEventListener('mousedown', onLauncherOutside, true);
    }
    function onLauncherOutside(e) {
      if (launcherEl && !launcherEl.contains(e.target) && !addBtn.contains(e.target)) closeLauncher();
    }
    // opts.cwd pins the spawn to a specific folder (the tree row's + — an
    // explicit "spawn here", unlike the strip + which defers cwd to the
    // workspace/default). opts.anchor is the element to hang the popover under
    // (the folder's + instead of the strip +). Both optional; bare call = the
    // strip's launcher, unchanged.
    function beginNewSession(opts: { cwd?: string; anchor?: HTMLElement } = {}) {
      if (launcherEl) { closeLauncher(); return; }   // + toggles it
      const anchorEl = opts.anchor || addBtn;
      const pinnedCwd = opts.cwd && opts.cwd.trim() ? opts.cwd.trim() : null;
      const pinnedName = pinnedCwd ? (pinnedCwd.split('/').filter(Boolean).pop() || '') : '';
      let mode = defaultSpawnEngine();                // 'claude' | 'codex' | 'shell' — seeded from Settings
      let selGroup = null;                            // chosen workspace, or null
      let userPickedMode = false;                     // true once the user clicks a mode chip — stops the
                                                      // on-open re-detect from overriding a deliberate choice

      const box = document.createElement('div');
      box.id = 'launcher';

      // Auto-name follows the workspace when one is picked (matches newTabInGroup),
      // else the bare mode label — uniqueSessionName adds " 2", " 3"… only when
      // a session with that name already exists.
      const modeLabel = () => mode === 'claude' ? 'Claude' : mode === 'codex' ? 'Codex' : 'Terminal';
      // A folder-launched session auto-names from the folder (until a workspace
      // is picked, whose name then wins) — so a "New Session" in ~/dev/api reads
      // as "api", matching how it'll be rooted.
      const defaultName = () =>
        uniqueSessionName(selGroup ? selGroup.name : (pinnedName || modeLabel()));

      // A labeled row: a 9px uppercase micro-label over the control. Enough context
      // to tell the two inputs apart without adding visual weight.
      const row = (label, ...els) => {
        const w = document.createElement('div');
        const l = document.createElement('div'); l.className = 'lab'; l.textContent = label;
        w.append(l, ...els);
        return w;
      };

      // WHAT — a segmented control; the chosen mode reads as a raised button.
      // Engine seam: a third engine (Codex, Aider) slots in as another mk(...)
      // chip — same surface, no new panel. The mode string widens to match.
      // Each chip is gated by isEngineAvailable so an uninstalled engine reads
      // as muted (.disabled) and click is a no-op — no dead-end "Codex tab"
      // that's actually a bare shell. A title tooltip explains why.
      const modes = document.createElement('div'); modes.className = 'modes';
      const mk = (m, label, iconHtml) => {
        const available = isEngineAvailable(m);
        const b = document.createElement('div');
        b.className = 'mode' + (m === mode ? ' on' : '') + (available ? '' : ' disabled');
        b.dataset.mode = m;
        b.innerHTML = iconHtml + `<span>${label}</span>`;
        if (!available) b.title = `${label} is not installed`;
        // Don't let the segment steal focus from the inputs — otherwise focus falls
        // to <body> and the box's keydown (Enter to launch) stops firing.
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', () => {
          if (!isEngineAvailable(m)) return;   // disabled chip: no-op
          userPickedMode = true;
          mode = m;
          modes.querySelectorAll('.mode').forEach(x => x.classList.toggle('on', x.dataset.mode === m));
          nameI.placeholder = defaultName();
        });
        return b;
      };
      modes.append(
        mk('claude', 'Claude', `<span class="cicon"><img src="${claudeLogo}" width="14" height="14" alt=""></span>`),
        mk('codex', 'Codex', `<span class="cicon cicon-codex"><img src="${codexLogo}" width="14" height="14" alt=""></span>`),
        mk('shell', 'Terminal', icon('terminal', 14)),
      );

      // WORKSPACE — chips, one per saved group plus None. Offered up front because a
      // group's prompt is injected at spawn and can't be attached to a live pty later.
      // The whole row only renders when workspaces exist, so the common no-groups
      // launcher stays three rows.
      const chipsEl = document.createElement('div'); chipsEl.className = 'gchips';
      const gdesc = document.createElement('div'); gdesc.className = 'gdesc';
      gdesc.style.display = 'none';
      const refreshChips = () => {
        chipsEl.querySelectorAll('.gchip').forEach((c: any) => {
          const on = (c.dataset.gid || '') === (selGroup ? String(selGroup.id) : '');
          c.classList.toggle('on', on);
          // selected chip borders in the group's own color, echoing the tab strip
          c.style.borderColor = (on && c.dataset.color) ? c.dataset.color : '';
        });
        const d = selGroup ? (selGroup.description || '').trim() : '';
        gdesc.textContent = d;
        gdesc.style.display = d ? '' : 'none';
      };
      const pick = (g) => {
        selGroup = (selGroup === g) ? null : g;   // re-click toggles off
        refreshChips();
        nameI.placeholder = defaultName();
      };
      const mkChip = (g) => {
        const c = document.createElement('div');
        c.className = 'gchip' + (g ? '' : ' on');   // None starts selected
        c.dataset.gid = g ? String(g.id) : '';
        if (g) {
          c.dataset.color = g.color;
          const dot = document.createElement('span'); dot.className = 'dot';
          dot.style.background = g.color;
          c.appendChild(dot);
        }
        c.appendChild(document.createTextNode(g ? g.name : 'None'));
        c.addEventListener('mousedown', (e) => e.preventDefault());
        c.addEventListener('click', () => pick(g));
        return c;
      };
      chipsEl.appendChild(mkChip(null));
      for (const g of groups) chipsEl.appendChild(mkChip(g));
      // the + chip is the doorway to creating/editing workspaces — settings
      // opens with the workspace section on top. It's also why the row renders
      // even with no workspaces yet: otherwise the feature is undiscoverable.
      const addChip = document.createElement('div');
      addChip.className = 'gchip add';
      addChip.title = 'configure workspaces';
      addChip.textContent = '+';
      addChip.addEventListener('mousedown', (e) => e.preventDefault());
      addChip.addEventListener('click', () => { closeLauncher(); openSettings(); });
      chipsEl.appendChild(addChip);

      // WHERE is normally not asked (the workspace's cwd or the spawn default
      // decides). But a folder-launched session pins that folder, so we surface
      // it read-only as reassurance — picking a workspace with its own cwd still
      // overrides it (workspace prompt + cwd travel together).
      let whereRow: HTMLElement | null = null;
      if (pinnedCwd) {
        const where = document.createElement('div'); where.className = 'lwhere';
        where.innerHTML = icon('folder', 12);
        const wn = document.createElement('span'); wn.textContent = pinnedName; wn.title = pinnedCwd;
        where.append(wn);
        whereRow = row('spawn in', where);
      }

      // NAME — optional; auto-named from the workspace or mode if left blank.
      const nameI = document.createElement('input');
      nameI.placeholder = defaultName();

      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = '↵ launch · esc cancel';

      box.append(modes);
      if (whereRow) box.append(whereRow);
      box.append(row('workspace', chipsEl, gdesc));
      box.append(row('name', nameI), hint);
      document.body.appendChild(box);
      launcherEl = box;

      // anchor under the launching + button, right edge aligned, kept on-screen
      const r = anchorEl.getBoundingClientRect();
      const w = box.offsetWidth;   // real width, so the CSS width stays the single source of truth
      box.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
      box.style.top = (r.bottom + 6) + 'px';

      nameI.focus();
      document.addEventListener('mousedown', onLauncherOutside, true);

      // Detection is cached at startup, so an engine installed or logged-into
      // since (e.g. `codex login`) would read as uninstalled and its chip would
      // stay muted until relaunch. Re-detect on open — cheap (two stat calls) —
      // and re-sync the chips + default when it lands. Guarded so a launcher
      // that's already been closed, or a mode the user deliberately picked mid-
      // detect, is left alone.
      refreshEngineDetection().then(() => {
        if (launcherEl !== box) return;   // launcher closed while detecting
        modes.querySelectorAll('.mode').forEach((b: any) => {
          const m = b.dataset.mode;
          const ok = isEngineAvailable(m);
          b.classList.toggle('disabled', !ok);
          b.title = ok ? '' : `${b.querySelector('span')?.textContent || m} is not installed`;
        });
        if (!userPickedMode) {
          mode = defaultSpawnEngine();
          modes.querySelectorAll('.mode').forEach((x: any) => x.classList.toggle('on', x.dataset.mode === mode));
          nameI.placeholder = defaultName();
        }
      });

      const commit = () => {
        const raw = nameI.value.trim();
        // cwd precedence: a picked workspace (its cwd + prompt travel together)
        // wins; else the folder this launcher was opened from (pinnedCwd, the
        // explicit tree-row +); else the project root / configured spawn default.
        const cwd = (selGroup && selGroup.cwd && selGroup.cwd.trim()) || pinnedCwd || defaultSpawnCwd();
        // Names key the session, its layout surface, and its pane — a duplicate
        // would resolve onto the existing pane (a second view of the same
        // terminal), so uniquify EVERY launch, including a typed name that
        // collides. Matches newTabInGroup's uniqueSessionName guard.
        const name = uniqueSessionName(raw || (selGroup ? selGroup.name : modeLabel()));
        closeLauncher();
        hideWelcome();   // making a session from the + dismisses the empty state
        // 4th arg binds the spawn group so the workspace prompt is injected (see
        // newTabInGroup) — that's why the picker lives here and not post-launch.
        const s = new Session(name, cwd, mode, selGroup ? selGroup.name : undefined);
        if (selGroup) {
          s.groupId = selGroup.id;
          logAction('group_assign', { name: s.name, group: selGroup.name });
        }
        activate(s);
        applyDefaultView(s);
      };
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); closeLauncher(); }
      });
    }

    // resize fans out to the active session only — the hidden ones refit when
    // they next come forward.
    window.addEventListener('resize', () => {
      // Body is sized in explicit px from innerWidth/innerHeight (see setUiZoom),
      // so it must be re-sized to the new viewport on every resize/fullscreen.
      // The traffic-light re-inset is left to the native resize handler (lib.rs):
      // re-pinning it per-frame over the JS→Rust hop chases macOS's own reposition
      // a frame late and makes the dots flicker to the top then snap back. Passing
      // applyLights=false keeps JS out of it entirely on resize.
      setUiZoom(ZOOM_STEPS[zoomIndex], false);
      reflowAllVisible();
    });

    // ─── open project ─────────────────────────────────────────────────
    // Click the bar button -> native Finder folder picker (server /pick). If
    // the picker isn't available (non-macOS), fall back to typing a path. A
    // chosen folder re-roots the tree and points future terminals at it.
    const projectBtn = document.getElementById('project');
    projectBtn.addEventListener('click', pickProject);

    // Fallback: swap the button for an inline absolute-path field.
    function promptForPath() {
      const input = document.createElement('input');
      input.id = 'projectInput';
      input.value = projectPath || '';
      input.placeholder = '/absolute/path/to/folder';
      projectBtn.replaceWith(input);
      input.focus();
      input.select();
      const restore = () => { input.replaceWith(projectBtn); };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const p = input.value.trim();
          restore();
          if (p && p !== projectPath) openProject(p);
        } else if (e.key === 'Escape') {
          restore();
        }
      });
      input.addEventListener('blur', restore);
    }

    function setProjectLabel(absPath) {
      projectPath = absPath;
      reportFocus();
      const home = '/Users/'; // best-effort prettifier for the label
      let label = absPath;
      const m = absPath.match(/^\/Users\/[^/]+(\/.*)?$/);
      if (m) label = '~' + (m[1] || '');
      projectBtn.querySelector('.nm').textContent = label;
      renderRecentPanel();   // projectPath just became truthy → the panel can show
    }

    // ─── file tree rail ───────────────────────────────────────────────
    // Read-only for the spike — this is a proportions/feel test, not a file
    // opener yet. Folders toggle; top two levels start open.
    const treeEl = document.getElementById('tree');
    // Folders currently expanded, by path — captured before each tree rebuild so
    // rename/create don't collapse the whole tree (see loadTree).
    let openDirs = new Set();
    // Folders to force-open on the next rebuild (e.g. reveal a just-created file).
    let pendingOpen = new Set();
    // Show dot-prefixed files/folders in the tree (default on; right-click toggles).
    let showDotfiles = true;
    const showDot = (n) => showDotfiles || !n.name.startsWith('.');
    // Collapse the file rows behind the root header, the way the roster header
    // collapses its rows — when you're living in the sessions list, the tree is
    // just noise you can't scroll past. Persisted like the roster's own prefs
    // (a sidebar affordance, not part of the tiling layout blob).
    let treeCollapsed = localStorage.getItem('spike.tree.collapsed') === '1';
    function applyTreeCollapsed() {
      if (treeEl) treeEl.classList.toggle('rows-collapsed', treeCollapsed);
    }
    // Repaint the header in place rather than refetching the tree — the rows are
    // still in the DOM, just hidden, so a round-trip would buy nothing.
    function setTreeCollapsed(v: boolean) {
      treeCollapsed = v;
      localStorage.setItem('spike.tree.collapsed', v ? '1' : '0');
      applyTreeCollapsed();
      const rootEl = treeEl && treeEl.querySelector('.root');
      if (rootEl) {
        const name = (rootEl as HTMLElement).dataset.rootname || '';
        const n = treeEl.querySelectorAll(':scope > .dirwrap, :scope > .row').length;
        rootEl.querySelector('.rootchev')!.innerHTML = icon(v ? 'chevron-right' : 'chevron-down', 12);
        rootEl.querySelector('.rootname')!.textContent = v ? `${name} · ${n}` : name;
        (rootEl as HTMLElement).title = 'click to ' + (v ? 'expand' : 'collapse') + ' the file tree';
      }
    }
    // Tree selection, Finder-shaped. `selRows` is the whole selection; `selRow`
    // is the lead — the row that holds DOM focus, the rename target, and where
    // ↑/↓ step from. `selAnchor` is the pivot ⇧-extend measures back to. Every
    // selected row wears `.sel`, so multi-select needs no new style: the accent
    // ring already means "picked".
    let selRow: any = null;
    let selRows: Set<any> = new Set();
    let selAnchor: any = null;
    // Rows as they read on screen, skipping anything inside a closed folder.
    // ⇧-click and ⇧-arrow walk this list, not the DOM tree. The `__node` filter
    // drops the roster/MRU panels and the inline create row, none of which are
    // selectable even though they live inside #tree.
    function visibleTreeRows(): any[] {
      return [...treeEl.querySelectorAll('.row')].filter((r: any) => r.__node && r.offsetParent !== null);
    }
    // The selection as nodes, in on-screen order — what menus, ⌘C, Delete and
    // drags all act on.
    function selectedNodes(): any[] {
      return visibleTreeRows().filter((r) => selRows.has(r)).map((r) => r.__node);
    }
    // Paint a new selection and move the lead. The single seam that touches
    // `.sel`, so no row can be left wearing a ring it no longer owns.
    function markTreeSel(rows: Set<any>, lead: any) {
      for (const r of selRows) if (!rows.has(r)) r.classList.remove('sel');
      for (const r of rows) r.classList.add('sel');
      selRows = rows;
      selRow = lead || null;
      if (selRow) selRow.focus({ preventScroll: true });
      reportFocus();   // `spike context` carries the tree selection
    }
    // Plain click (and every programmatic caller): this row alone.
    function selectTreeRow(row: any) {
      selAnchor = row;
      markTreeSel(row ? new Set([row]) : new Set(), row);
    }
    // ⌘-click: add or drop one row, leaving the rest of the selection alone.
    function toggleTreeRow(row: any) {
      const next = new Set(selRows);
      const off = next.has(row);
      if (off) next.delete(row); else next.add(row);
      // Dropping the lead hands the lead to whatever is still selected. The
      // anchor follows the lead rather than the clicked row, so a later
      // ⇧-extend never measures back to a row that just left the selection.
      const lead = off ? (selRow === row ? [...next][next.size - 1] || null : selRow) : row;
      selAnchor = lead;
      markTreeSel(next, lead);
    }
    // ⇧-click / ⇧-arrow: take the visible run between the anchor and `row`.
    function extendTreeSel(row: any) {
      const rows = visibleTreeRows();
      const b = rows.indexOf(row);
      if (b < 0) return;
      const anchor = selAnchor && rows.includes(selAnchor) ? selAnchor : selRow;
      const a = rows.indexOf(anchor);
      const [lo, hi] = a < 0 ? [b, b] : (a <= b ? [a, b] : [b, a]);
      markTreeSel(new Set(rows.slice(lo, hi + 1)), row);
    }
    // Re-attach the selection to freshly built rows after loadTree wipes them.
    // No focus() here — a background reload must not yank the caret out of a
    // terminal or an editor.
    function restoreTreeSel(paths: Set<string>, leadPath: any) {
      selRows = new Set(); selRow = null; selAnchor = null;
      if (!paths.size) return;
      for (const r of treeEl.querySelectorAll('.row')) {
        const p = (r as any).__node && (r as any).__node.path;
        if (!p || !paths.has(p)) continue;
        r.classList.add('sel');
        selRows.add(r);
        if (p === leadPath) selRow = r;
      }
      selRow = selRow || [...selRows][0] || null;
      selAnchor = selRow;
    }
    // Tree drags ride the mouse engine (beginTreeDrag, by the dock engine
    // below) — NOT HTML5 drag. Tauri's OS-level drag handler (dragDropEnabled,
    // required for screenshot/Finder drops to carry real paths) swallows every
    // in-page HTML5 drag session, which silently killed drag-a-file-to-a-pane
    // in the installed app. Plain mouse events can't be intercepted.
    // + cropped to its strokes (no viewBox padding) so the hover box hugs it and
    // its right edge lines up with the row counts.
    const plusGlyph = '<svg viewBox="4 4 16 16" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block"><path d="M12 5l0 14" /><path d="M5 12l14 0" /></svg>';
    // Move one or many entries into destDir on the server, then refresh the tree
    // once (preserving the user's open/closed folders as-is). Drops the moves
    // that would be no-ops or impossible — an entry already sitting in destDir,
    // and a folder dropped inside itself — so a sloppy drop is quiet, not an
    // error. A failure anywhere still reloads: the tree must match the disk.
    function moveAll(srcs: any[], destDir: any) {
      const list = [...new Set(srcs)].filter((p: any) => p && p !== destDir
        && p.slice(0, p.lastIndexOf('/')) !== destDir
        && !(destDir + '/').startsWith(p + '/'));
      if (!list.length) return;
      let failed: any = null;
      Promise.all(list.map((p: any) => ipc.movePath(p, destDir).catch((e) => { failed = failed || e; })))
        .then(() => {
          if (failed) status.textContent = ipc.errorMessage(failed, 'move failed');
          loadTree(projectPath);
        });
    }
    // A path as the user reads it: relative to the project root when it's inside.
    function relToRoot(p: string) {
      return projectPath && p.startsWith(projectPath + '/') ? p.slice(projectPath.length + 1) : p;
    }
    // Let a folder row (or the root label) accept a dropped tree item. Just a
    // marker now: beginTreeDrag finds `.dropdir` under the cursor and reads
    // the destination from the dataset — no HTML5 events involved.
    function makeDropTarget(el, destDir) {
      el.classList.add('dropdir');
      el.dataset.dropdir = destDir;
    }
    // Make a row a drag source on the mouse engine. (The old HTML5 dragstart
    // also offered drag-out-to-desktop via DownloadURL; that was already dead
    // under the native drag handler and is dropped with it.)
    function makeDragSource(row, node) {
      row.addEventListener('mousedown', (e) => {
        if ((e.target as HTMLElement).closest('input, button')) return;   // inline rename etc.
        // Grabbing any row of a multi-selection carries the whole selection —
        // mousedown runs before the click that would collapse it, which is why
        // dragging out of a folder can take five files at once.
        beginTreeDrag(e, selRows.size > 1 && selRows.has(row) ? selectedNodes() : [node]);
      });
    }
    function countFiles(node) {
      if (!node.dir) return 1;
      return (node.children || []).reduce((n, c) => n + (showDot(c) ? countFiles(c) : 0), 0);
    }
    function renderNode(node, depth) {
      const row = document.createElement('div');
      const pad = 8 + depth * 13;
      if (node.dir) {
        const wrap = document.createElement('div');
        const startOpen = openDirs.has(node.path);  // all folders closed by default
        wrap.className = startOpen ? 'dirwrap open' : 'dirwrap';
        wrap.dataset.path = node.path;
        row.className = 'row dir';
        row.style.paddingLeft = pad + 'px';
        row.tabIndex = -1;
        row.__node = node;
        const n = countFiles(node);
        row.innerHTML = `<span class="tw">${icon('chevron-right', 12)}</span>` +
          `<span class="ic">${icon(startOpen ? 'folder-open' : 'folder', 15)}</span>` +
          `<span class="nm">${node.name}</span><span class="count">${n}</span>`;
        // hover action: a single + that opens the new file/folder menu, creating
        // inside this folder. stopPropagation so the click doesn't toggle it.
        const act = document.createElement('span');
        act.className = 'rowact';
        const add = document.createElement('span');
        add.className = 'ract'; add.title = 'New file or folder'; add.innerHTML = plusGlyph;
        add.addEventListener('click', (e) => { e.stopPropagation(); openCreateMenu(node.path, row, add); });
        act.append(add);
        row.append(act);
        const icEl = row.querySelector('.ic');
        const kids = document.createElement('div');
        kids.className = 'children';
        for (const c of node.children || []) if (showDot(c)) kids.appendChild(renderNode(c, depth + 1));
        row.addEventListener('click', (e) => {
          // ⌘/⇧ are selection gestures, not navigation — they never toggle the
          // folder, so you can build a selection without the tree moving.
          if (e.metaKey || e.ctrlKey) { toggleTreeRow(row); return; }
          if (e.shiftKey) { extendTreeSel(row); return; }
          selectTreeRow(row);
          const open = wrap.classList.toggle('open');
          // chevron rotation is CSS-driven via .open; swap the folder glyph here.
          icEl.innerHTML = icon(open ? 'folder-open' : 'folder', 15);
        });
        // drag the folder to move it; drop a file/folder onto it to move in.
        makeDragSource(row, node);
        makeDropTarget(row, node.path);
        wrap.appendChild(row);
        wrap.appendChild(kids);
        return wrap;
      } else {
        row.className = 'row file';
        row.style.paddingLeft = pad + 'px';
        row.title = node.name;       // full name on hover when the row truncates
        row.tabIndex = -1;
        row.__node = node;
        const tint = fileTint(node.name);
        row.innerHTML = `<span class="tw"></span>` +
          `<span class="ic ${tint}">${icon(fileIcon(node.name), 15)}</span>` +
          `<span class="nm">${node.name}</span>`;
        // click selects + peeks the file in the preview (transient). Double-click
        // to pin is the next slice; for now a single panel is the peek surface.
        // ⌘-click picks without peeking and ⇧-click takes the run — neither
        // opens, so a five-file selection doesn't churn the preview's live slot.
        row.addEventListener('click', (e) => {
          if (e.metaKey || e.ctrlKey) { toggleTreeRow(row); return; }
          if (e.shiftKey) { extendTreeSel(row); return; }
          selectTreeRow(row); openFile(node.path, node.name, row, { keepFocus: true });
        });
        // drag to move into a folder (inside the app) or out to the OS as a copy.
        makeDragSource(row, node);
        return row;
      }
    }

    // Fetch + paint the tree for a root. `root` omitted → server default.
    // Returns the absolute path the server actually rooted at.
    // Index of note basename -> absolute path, for resolving [[wikilinks]].
    // Rebuilt on every tree load. Basename match (Obsidian-style), case-insensitive.
    const noteIndex = new Map();
    // Same idea for EVERY file (full basename incl. extension -> path), plus the
    // set of all absolute paths — these resolve ![[embeds]] and relative img srcs.
    const fileIndex = new Map();
    const allPaths = new Set();
    function buildNoteIndex(nodes) {
      for (const n of nodes) {
        if (n.dir) { if (n.children) buildNoteIndex(n.children); }
        else {
          allPaths.add(n.path);
          const full = n.name.toLowerCase();
          if (!fileIndex.has(full)) fileIndex.set(full, n.path);   // first wins (shallowest)
          if (/\.md$/i.test(n.name)) {
            const base = n.name.replace(/\.md$/i, '').toLowerCase();
            if (!noteIndex.has(base)) noteIndex.set(base, n.path);
          }
        }
      }
    }
    // Resolve a [[target]] (may include a folder path or #heading) to a path.
    // Notes first; non-md targets ([[deck.pdf]]) fall back to the file index.
    function resolveWiki(target) {
      let t = target.split('#')[0].trim();          // drop heading anchor
      t = t.split('/').pop();                         // basename if a path was given
      return noteIndex.get(t.toLowerCase().replace(/\.md$/i, ''))
        || fileIndex.get(t.toLowerCase()) || null;
    }
    // Resolve an ![[embed]] target. Obsidian image embeds usually carry the
    // extension, but pasted attachments sometimes don't — try image extensions,
    // then fall back to a note (note transclusion).
    const IMG_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'];
    function resolveEmbed(target) {
      const t = (target.split('#')[0].trim().split('/').pop() || '').toLowerCase();
      if (fileIndex.has(t)) return fileIndex.get(t);
      for (const e of IMG_EXTS) { const hit = fileIndex.get(`${t}.${e}`); if (hit) return hit; }
      return noteIndex.get(t.replace(/\.md$/i, '')) || null;
    }

    function loadTree(root) {
      // read_tree is pure now — the old GET /tree?root= also persisted lastRoot
      // (when a root was named) and re-pointed the watcher, so do all three
      // together here. Fire-and-forget on the side effects; same-root watches
      // are a no-op backend-side.
      return ipc.getTree(root || null).then(data => {
        if (root) ipc.setLastRoot(data.path).catch(() => {});
        ipc.startWatch(data.path).catch(() => {});
        // preserve which folders were expanded across the rebuild (plus any
        // queued by a create), so rename/create don't collapse the tree.
        const open = new Set(pendingOpen);
        pendingOpen = new Set();
        treeEl.querySelectorAll('.dirwrap.open').forEach(el => { if (el.dataset.path) open.add(el.dataset.path); });
        openDirs = open;
        // The rows are about to be thrown away, so hold the selection by path
        // and re-attach it below — otherwise a move/rename/create silently drops
        // what the user had picked (and left `selRow` pointing at a dead node).
        const keepSel = new Set([...selRows].map((r: any) => r.__node && r.__node.path).filter(Boolean));
        const keepLead = selRow && selRow.__node ? selRow.__node.path : null;
        noteIndex.clear();
        fileIndex.clear();
        allPaths.clear();
        buildNoteIndex(data.children);
        // The session roster is a persistent child of #tree — detach it before
        // the wipe so a tree repaint doesn't drop it; placeSessionPanel() re-docks
        // it above or below the rows per the user's pref once they're built.
        const panel = sessionPanelEl && sessionPanelEl.parentElement === treeEl ? sessionPanelEl : null;
        const rpanel = recentPanelEl && recentPanelEl.parentElement === treeEl ? recentPanelEl : null;
        if (panel) treeEl.removeChild(panel);
        if (rpanel) treeEl.removeChild(rpanel);
        treeEl.innerHTML = '';
        if (panel) treeEl.appendChild(panel);
        if (rpanel) treeEl.appendChild(rpanel);
        // Root label row — the tree's header, shaped like the roster's: a
        // chevron that collapses the rows, the project name (with a count when
        // collapsed, so the row stays informative), and the + that opens the
        // new file/folder menu for the project root.
        const kids = data.children.filter(showDot);
        const rootEl = document.createElement('div');
        rootEl.className = 'root';
        rootEl.dataset.rootname = data.root;   // the bare name, so the count can come and go
        const rootChev = document.createElement('span');
        rootChev.className = 'rootchev';
        rootChev.innerHTML = icon(treeCollapsed ? 'chevron-right' : 'chevron-down', 12);
        const rootName = document.createElement('span');
        rootName.className = 'rootname';
        rootName.textContent = treeCollapsed ? `${data.root} · ${kids.length}` : data.root;
        const rootAdd = document.createElement('span');
        rootAdd.className = 'rootadd'; rootAdd.title = 'New file or folder'; rootAdd.innerHTML = plusGlyph;
        rootAdd.addEventListener('click', (e) => { e.stopPropagation(); openCreateMenu(data.path, null, rootAdd); });
        rootEl.append(rootChev, rootName, rootAdd);
        rootEl.title = 'click to ' + (treeCollapsed ? 'expand' : 'collapse') + ' the file tree';
        rootEl.addEventListener('click', () => setTreeCollapsed(!treeCollapsed));
        makeDropTarget(rootEl, data.path);  // drop here to move to the project root
        treeEl.appendChild(rootEl);
        for (const c of kids) treeEl.appendChild(renderNode(c, 0));
        restoreTreeSel(keepSel, keepLead);
        applyTreeCollapsed();
        placeSessionPanel();   // dock the roster above/below the freshly-built rows
        pruneRecentTouched();  // drop recents that no longer exist in the new tree
        placeRecentPanel();    // keep the MRU list pinned at the tree's foot
        renderRecentPanel();
        return data.path;
      });
    }

    // ─── welcome / empty state ────────────────────────────────────────
    // Shown before any project is open. The single entry into a project is
    // openProject(): it loads the tree, relabels the bar, hides the welcome,
    // and (only if there are no sessions yet) spawns the first terminal.
    const welcomeEl = document.getElementById('welcome');
    // The Home landing (Cloudflare-OS shape) is the login screen: it rides the
    // same show/hide points as the welcome splash and covers the shell while no
    // project is open. Its real path in is pickProject(); unbuilt features flash
    // the "Coming soon" toast.
    const homeEl = document.getElementById('home');
    // Bridge: openHomeDoc is defined deep in the Home-setup scope; the CLI `open`
    // event handler lives in a different function scope and can't see it. This
    // module-level ref is assigned once openHomeDoc exists, so `spike open` can
    // route a doc into the Home preview (incl. the .spiketable grid).
    let homeOpenDocRef: ((path: string, name: string) => void) | null = null;
    // Set at boot when a last project exists; Home's real doors continue into it
    // (or fall back to the folder picker when there's no prior project).
    let bootLastRoot: string | null = null;
    // The Home composer's text, held from submit until the default session spawns
    // and consumes it (see spawnDefaultSession).
    let pendingHomeMessage: string | null = null;
    {
      const lg = document.getElementById('welcomeLogo') as HTMLImageElement | null;
      if (lg) lg.src = spikeMark;
      for (const id of ['homeLogo', 'homeAvatar', 'homeAcctPopImg', 'barBrandImg']) {
        const el = document.getElementById(id) as HTMLImageElement | null;
        if (el) el.src = spikeMark;
      }
    }
    // Declared in the OUTER boot scope (not inside `if (homeEl)`), because
    // showWelcome() — a sibling function below — calls it. When it lived inside
    // the block, showWelcome threw a ReferenceError every boot, which silently
    // aborted the rest of showWelcome (tab-strip hide, tree visibility) and,
    // before the home-open line moved up, left Home visible without home-open.
    let homeRepaintGreeting: (() => void) | null = null;
    // Repaints the Home sidebar's Workstreams list. Declared out here (like
    // homeRepaintGreeting) so renderTabs() — defined far above — can call it as
    // the single repaint choke point; assigned inside the `if (homeEl)` block.
    let renderWorkstreams: (() => void) | null = null;
    // Assigned inside the block once the home-chat surface is built; the
    // Workstreams rows + Home nav (wired earlier in the block) call through these
    // so a click opens the session IN the home thread / returns to the launcher,
    // instead of tearing #home down into the raw pane.
    let homeOpenWorkstream: ((s: any) => void) | null = null;
    let homeGoLauncher: (() => void) | null = null;
    // Assigned inside the homeEl block; the `spike open <file>` control channel
    // (far below, outer scope) reads it so a CLI/tree open lands in the Home
    // preview column when the Home surface is up — the shell preview it would
    // otherwise target sits hidden behind #home, so the file appeared to vanish.
    let homeOpenDoc: ((path: string, name: string) => void) | null = null;
    // The Workspaces surface (assigned inside the homeEl block). Nav wiring above
    // its definition needs a handle, so it's declared out here like the two above.
    let openWorkspacesView: (() => void) | null = null;
    let closeWorkspacesView: (() => void) | null = null;
    // The Playbooks surface, built where the `playbook` handle exists (below). Same pattern.
    let openPlaybooksView: (() => void) | null = null;
    let closePlaybooksView: (() => void) | null = null;
    // Assigned inside the homeEl block; reportFocus (broader scope) reads it to
    // publish the open Brainstorm board into `spike context`.
    let brainstormRef: BrainstormHandle | null = null;
    // [shell edition] Home surface is not part of Spike Shell.
    function hideWelcome() {
      if (welcomeEl) welcomeEl.style.display = 'none';
      if (homeEl) homeEl.style.display = 'none';
      document.documentElement.classList.remove('home-open');   // titlebar returns with the project
      if (tabsEl) tabsEl.style.display = '';   // tab strip returns with the project
    }
    function showWelcome() {
      // Home owns the whole canvas as the landing; the older welcome splash stays
      // hidden underneath (still the host for the rare dual-engine first-run pick).
      if (welcomeEl) welcomeEl.style.display = 'none';
      // Set display + home-open ATOMICALLY, before anything that could throw
      // (homeRepaintGreeting once did, leaving home visible without the class —
      // so the titlebar never blanked and the bar chrome never appeared).
      if (homeEl) { homeEl.style.display = 'grid'; homeEl.classList.remove('leaving', 'chatting'); }
      document.documentElement.classList.add('home-open');   // blank the titlebar to just the dots
      if (homeRepaintGreeting) homeRepaintGreeting();   // refresh to the current part-of-day
      renderWorkstreams?.();   // reflect current open sessions + active highlight on return
      // Land the cursor in the composer so you can just start typing.
      setTimeout(() => (document.getElementById('homeInput') as HTMLTextAreaElement | null)?.focus(), 0);
      if (tabsEl) tabsEl.style.display = 'none';
      if (typeof paintTermToggle === 'function') paintTermToggle();
      applyTreeVisible();
    }
    document.getElementById('welcomeChoose').addEventListener('click', pickProject);
    // Note: the explicit "or type a path" link is gone from welcome — the
    // native picker is enough. If pickProject's call to ipc.pickFolder fails,
    // it still falls back to promptForPath() automatically (see pickProject's
    // catch). promptForPath is also still reachable from the command palette.

    // Shared pick flow: native folder dialog (Tauri plugin), fall back to typing.
    async function pickProject() {
      try {
        const p = await ipc.pickFolder();
        if (p === null) return;   // user hit Cancel
        if (p !== projectPath) openProject(p);
        return;
      } catch { /* picker failed; manual entry */ }
      promptForPath();
    }

    // Open a project: re-root the tree, relabel the bar, hide the welcome, and
    // spawn the first terminal if none exist yet. Existing terminals stay where
    // they are. Bad path → leave things put.
    //
    // commitPendingFirstRunEngine() fires here so the engine the user picked
    // in the welcome chip picker persists BEFORE the default session spawns —
    // that session reads spawnDefaults.engine, which is set synchronously by
    // patchConfig (the disk write follows asynchronously, doesn't block us).
    //
    // While loadTree + spawnDefaultSession run, #welcome carries `.loading`
    // so the Spike mark spins (the hover-rotation looped) and the engine /
    // CTA dim — the page reads as "opening" instead of "still clickable".
    function openProject(root, opts?: { restore?: boolean }) {
      if (welcomeEl) welcomeEl.classList.add('loading');
      loadTree(root).then(abs => {
        commitPendingFirstRunEngine();
        setProjectLabel(abs);
        logAction('project_open', { path: abs });
        hideWelcome();
        if (welcomeEl) welcomeEl.classList.remove('loading');
        applyTreeVisible();   // a project is open now → the sidebar returns
        // Auto-reopening the SAME last project: respawn the terminals that were
        // popped into split panes last session (a dead pty can't be revived, so
        // we re-create them by name + saved spawn params). Only here — a manual
        // pick of a different folder must NOT drag the old project's panes in.
        if (opts?.restore) restorePoppedSessions();
        // The shared column always needs a live, non-popped terminal — spawn the
        // default when every session is popped (restore case) or there are none.
        if (!sessions.some((s) => !isPoppedSession(s))) spawnDefaultSession();
      }).catch(() => {
        if (welcomeEl) welcomeEl.classList.remove('loading');
        status.textContent = 'not a folder';
      });
    }

    // The default session for an open project: a single ungrouped engine at the
    // root. Used on first open and to refill the workspace when the last session
    // closes — a project always has at least one agent, so the empty center
    // never appears.
    function spawnDefaultSession() {
      hideWelcome();
      const engine = defaultSpawnEngine();
      const label = engine === 'codex' ? 'Codex' : engine === 'shell' ? 'Terminal' : 'Claude';
      const s = new Session(uniqueSessionName(label), projectPath, engine);
      // A Home-originated open carries the composer's text — hand it to this
      // session so it lands as the first chat message once the pty is alive.
      if (pendingHomeMessage) { s.pendingChatFirst = pendingHomeMessage; pendingHomeMessage = null; }
      activate(s);
      applyDefaultView(s);
    }

    // ─── preview / editor panels ──────────────────────────────────────
    // File panes. Each is an independent clone of <template id="pvtemplate">
    // (see makePreview below) with its own tab strip, recyclable live slot,
    // viewer modes, highlighted editor and dirty/save state — so two files can
    // sit side by side in the tiling layout. Two views per doc, switched by
    // the segmented control in the header:
    //   code icon  source/editor — a live, editable monospace textarea (Cmd/Ctrl+S
    //       to save back via POST /file).
    //   eye icon   rendered/viewer — markdown to themed prose, html to sandboxed iframe,
    //       anything else → read-only source. Binary/too-large → a calm message.
    // The layout tree addresses an instance as { kind:'preview', id }; the
    // registry maps id → instance. focusedPreview — the pane last clicked or
    // typed into — is where tree clicks, `spike open` and ⌘S land.
    interface PvDoc {
      path: string; name: string; content: string; draft: string;
      view: 'source' | 'rendered' | 'live'; dirty: boolean;
      media: string | null; binary: boolean; tooBig: boolean; error: boolean;
      ephemeral: boolean; loaded: boolean; loadToken?: object;
      // a fetched web article (link opened in preview): path is the URL, content
      // is the SANITIZED readable HTML, rendered read-only and annotatable.
      web?: boolean; byline?: string; errMsg?: string; lowconf?: boolean;
      reader?: boolean;   // an HTML file shown as extracted prose (so it's annotatable) vs the live iframe
      // an HTML file promoted to the native child webview ("true browser" mode):
      // renders as its own main frame — fills, crisp, width=device-width honored,
      // real origin so localStorage/fetch/cookies work — where the sandboxed
      // iframe can't. Singleton (shares the one live webview with `spike open`).
      browser?: boolean;
      // a live URL docked in the preview (`spike open http://localhost:…`): path
      // is the URL, rendered in a sandboxed <iframe src>. Nothing is fetched into
      // the app — the frame loads the page at its own origin. Loopback only.
      liveurl?: boolean;
      // ─── lane-owned lifecycle ───────────────────────────────────────────
      // The lane (terminal session ptyId) that opened this doc via `spike open`.
      // undefined = user-owned (a tree/⌘-click open). Drives the lane color and
      // the orphan/evict lifecycle. Resolved live against `sessions` so a
      // regrouped lane recolors its previews too.
      ownerSessionId?: string;
      // The user has claimed this doc (pinned): it goes neutral (no lane color),
      // never dims on lane close, never auto-evicts. Manual opens are born true.
      pinnedByUser?: boolean;
      // The owning lane's tab closed: this doc is dimmed (still readable) and
      // eligible to coalesce into a per-lane cluster, then to evict once the
      // user moves on. laneColorFrozen/laneNameFrozen snapshot the lane's
      // identity at close time, since the session is gone and can't be resolved.
      orphaned?: boolean;
      laneColorFrozen?: string;
      laneNameFrozen?: string;
      // MRU stamp for orphan eviction (set on activate + open).
      lastTouchedAt?: number;
      // per-doc undo/redo (assigning editor.value kills the textarea's native
      // stack on every tab switch, so the editor keeps its own — see pushUndo)
      undo?: { v: string; s: number; e: number }[];
      redo?: { v: string; s: number; e: number }[];
    }
    interface Preview {
      id: string;
      root: HTMLElement;
      readonly tabs: PvDoc[];
      readonly file: PvDoc | null;
      readonly view: string;
      readonly dirty: boolean;
      openDoc(path: string, name: string, opts?: { reload?: boolean; owner?: string; pin?: boolean; keepFocus?: boolean }): void;
      openWeb(url: string, owner?: string): void;       // open an external link as a readable article
      openLiveUrl(url: string, owner?: string): void;   // dock an http(s) URL live in the in-pane browser
      adoptDocs(docs: PvDoc[], focus?: PvDoc | null): void;   // merge another instance's docs in (center-drop)
      reloadDoc(tab: PvDoc): void;
      markOrphaned(sessionId: string): void;   // owning lane closed → dim this lane's docs (Stage 2)
      dropPath(path: string): void;     // a doc deleted on disk leaves without confirm
      save(): void;
      close(): void;                    // user-facing: confirm dirty, fade, dispose
      dispose(): void;                  // immediate structural teardown
      openFind(replace?: boolean): void; // ⌘F — find-in-page; ⌥⌘F opens replace too
      htmlZoomActive(): boolean;        // is an HTML iframe the live rendered view?
      htmlZoom(dir: number): void;      // +1 zoom in, -1 out, 0 reset (HTML preview only)
      htmlBack(): void;                 // ⌘[ — step back through in-page nav (HTML preview only)
      canLiveSplit(): boolean;          // does this doc have both halves to split?
      toggleLiveSplit(): void;          // ⌘K — enter live view, or flip its orientation
      canEdit(): boolean;               // is the active doc a WYSIWYG-editable markdown file?
      toggleEdit(): void;               // ⌘E / pencil — enter or commit+leave WYSIWYG edit
    }
    const previews = new Map<string, Preview>();   // creation order (Map preserves it)
    let focusedPreview: Preview | null = null;
    // Presentation-only preview focus. LayoutState stays untouched so reducing
    // restores the exact split, active tabs, and panel proportions from before.
    let expandedPreviewId: string | null = null;
    let pvSeq = 0;   // instance ids (pv1, pv2…) — session-local; previews never persist across boots
    let pvTouchSeq = 0;   // monotonic MRU stamp for orphan eviction (order-only, no clock)
    // The standing web pane: the browser lives in its own tile beside your work,
    // not as a tab that hijacks the artifact preview you're reading. Tracks that
    // one pane's id so every `spike open <url>` navigates it instead of spawning
    // a new one; cleared when that pane closes. null = no web pane open yet.
    let webPvId: string | null = null;
    // Last URL the web pane visited this session, so the footer globe reopens
    // where you left off instead of a cold start. null = never browsed yet.
    let lastLiveUrl: string | null = null;
    // the routing target for opens/saves: the focused pane if it's still alive,
    // else the first (and usually only) one.
    function livePreview(): Preview | null {
      if (focusedPreview && previews.has(focusedPreview.id)) return focusedPreview;
      return previews.values().next().value || null;
    }

    // The routing target for FILE / article opens: a preview that is NOT the
    // dedicated web pane. Opening a file must never land as a tab inside the
    // browser pane — that re-merges docs and the live board into one surface,
    // so you couldn't see your artifact and a web page at the same time. Prefers
    // the focused pane when it's a doc pane, else the first non-web preview,
    // else null (caller spawns a fresh doc pane, which docks beside the web one).
    function docPreview(): Preview | null {
      if (focusedPreview && previews.has(focusedPreview.id) && focusedPreview.id !== webPvId) return focusedPreview;
      for (const pv of previews.values()) if (pv.id !== webPvId) return pv;
      return null;
    }

    // ── live URL board: a native child webview pinned over the preview pane ────
    // `spike open http://localhost:…` shows a live local tool's page. An <iframe>
    // underfills it in WebKit (a width=device-width page lays out at the display
    // width, not the frame's), so we float a real Tauri child webview over the
    // pane instead — pixel-perfect, the way it looks in a browser. The webview
    // paints ABOVE the DOM, so it must be hidden whenever an overlay or menu
    // could sit over the pane, and its rect kept matched to the pane on every
    // layout / resize / tab change. liveRenderBox is the .pvrender currently
    // showing the board (its rect = the webview's rect); null when none is.
    let liveRenderBox: HTMLElement | null = null;
    let liveUrl = '';
    let liveSyncRaf = 0;
    // Height (CSS px) of the chrome strip drawn at the top of the board's pane
    // (address bar + back/fwd/reload). The native webview is inset below it so
    // the strip — plain DOM — stays visible and clickable above the page. Must
    // match the .livebar height in index.html.
    const LIVE_STRIP_H = 36;
    // The strip's live controls for the board currently on screen, re-registered
    // by renderLiveUrl on each paint (the strip DOM is rebuilt each time). null
    // when no board is showing. onNav writes the navigated URL back into the
    // owning tab (name + path) from inside the Preview that owns it. Back/forward
    // are NOT gated on a reconstructed history model: those buttons drive the
    // webview's OWN session history via history.back()/forward(), which (unlike a
    // model fed by on_navigation) also covers SPA pushState routes and is a safe
    // no-op at the ends. So they stay always-enabled; live-nav only refreshes the
    // address bar + tab name on real document loads.
    let liveBoardCtl: {
      addr: HTMLInputElement;
      onNav: (url: string) => void;
    } | null = null;
    // Menus live in #toplayer (above the webview) and the palette/settings/etc.
    // overlays cover the pane — the webview would paint over any of them.
    function liveBoardOccluded(): boolean {
      return !!document.querySelector(OVERLAY_SEL) || !!document.querySelector('.spikemenu');
    }
    // Is the DOM holding a text edit the user is typing into? Showing the native
    // board makes it first responder (wry #175 hover workaround), which blurs the
    // DOM — and the board is hidden while an overlay is up and re-shown the
    // instant it closes, which is exactly when some edits are BORN: the tab
    // menu's Rename creates its inline input as the menu closes. The steal blurred
    // it, blur committed, and the rename vanished before a key landed ("Rename
    // does nothing" — but only while a board was on screen). So we tell the show
    // call to leave focus alone while an edit is live.
    // xterm's helper <textarea> is excluded on purpose: it being focused means
    // "the terminal has focus", the ordinary resting state, not an open edit —
    // gating on it would disable the hover workaround entirely.
    function domTextEditActive(): boolean {
      const ae = document.activeElement as HTMLElement | null;
      if (!ae || ae === document.body) return false;
      if (ae.isContentEditable) return true;
      if (ae.tagName !== 'INPUT' && ae.tagName !== 'TEXTAREA') return false;
      return !ae.closest('.xterm');
    }
    // #termlayer and the native live webview both live in the UNZOOMED viewport
    // coordinate space (Tauri logical px), so a zoomed `.termslot` / render-box
    // rect must be expressed there before we position a pane or webview over it.
    // Under CSS `zoom`, WebKit builds disagree on whether getBoundingClientRect
    // reports on-screen or pre-zoom px; `overlayScale` (measured in setUiZoom)
    // is the multiplier that lands the rect in true on-screen px either way. It
    // is 1 whenever gBCR already includes the zoom (every current WebKit), so
    // this is a no-op there and only rescues older builds.
    function toViewportRect(el: HTMLElement) {
      const r = el.getBoundingClientRect();
      const k = overlayScale;
      return {
        left: r.left * k,
        top: r.top * k,
        width: r.width * k,
        height: r.height * k,
      };
    }
    function syncLiveBoard() {
      // While the top-level sign-in window is up, the pane must NOT also render
      // the page it was bounced to — that's the same "Choose an account" screen
      // twice, and the one the user can actually finish is the window. Hide the
      // child webview and let the .livehold placeholder underneath show through.
      if (signinHold) { ipc.liveWebviewHide().catch(() => {}); return; }
      const rb = liveRenderBox;
      // Show only when the board's pane is on screen (rendered view, non-zero
      // box) and nothing is layered over it; otherwise hide (keeps the page
      // alive + its state, cheap to re-show). Rect is CSS px = Tauri logical px,
      // inset below the chrome strip so the webview never covers it.
      if (rb && rb.isConnected && rb.classList.contains('show') && !liveBoardOccluded()) {
        const v = toViewportRect(rb);   // → unzoomed viewport px (Tauri logical px)
        // The top chrome (bar + bookmarks bar + open-docs dropdown) is one flow
        // container (.livechrome) in renderLiveUrl; renderHtmlBrowser uses a bare
        // .livebar. Measure whichever is present — its full height is the inset so
        // the native webview sits below ALL of it (page slides down, stays live).
        // DOM inside the zoomed body, so measure through the engine-aware mapping.
        const stripEl = rb.querySelector<HTMLElement>('.livechrome') || rb.querySelector<HTMLElement>('.livebar');
        const stripH = stripEl ? toViewportRect(stripEl).height : LIVE_STRIP_H * ZOOM_STEPS[zoomIndex];
        const top = v.top + stripH;
        const height = v.height - stripH;
        if (v.width > 1 && height > 1) {
          ipc.liveWebviewShow(liveUrl, v.left, top, v.width, height, !domTextEditActive()).catch(() => {});
          return;
        }
      }
      ipc.liveWebviewHide().catch(() => {});
    }
    // The webview reported a real navigation (load / redirect / address submit):
    // refresh the address bar + tab name to match. Won't fire for SPA pushState
    // routes (on_navigation is document-load only) — a known limitation.
    function applyLiveNav(url: string) {
      if (!liveBoardCtl || !liveRenderBox || !liveRenderBox.isConnected) return;
      liveUrl = url;
      // Don't clobber the address bar while the user is editing it.
      if (document.activeElement !== liveBoardCtl.addr) liveBoardCtl.addr.value = url;
      liveBoardCtl.onNav(url);
      // The last page that wasn't the sign-in host: where "Cancel" puts the pane
      // back, and the honest return target when the OAuth `continue=` is itself
      // an accounts.google.com URL (every third-party flow) and so says nothing
      // about where the user actually was.
      try {
        if (new URL(url).hostname !== 'accounts.google.com') {
          lastNonSigninUrl = url;
          // ...and this is the ONLY place the one-shot guard re-arms. A cancel
          // leaves the child webview still parked on Google's sign-in page, so
          // the 500ms URL poll keeps reporting it; clearing the guard on release
          // meant the very next tick relocated again and the window the user
          // just closed reopened. Re-arming on a real move away means a later
          // bounce still prompts, and a stationary one never does.
          signinPromptedFor = '';
        }
      } catch {}
      // Keep `spike context`'s browser line current — on_navigation + the poll
      // both land here, so this covers real loads, SPA routes, and redirects.
      reportFocus();
      maybeGoogleSignin(url);
    }
    // Google refuses interactive sign-in inside the embedded pane webview: a Docs
    // load with no valid session bounces to accounts.google.com/…/signin (and on
    // to /signin/rejected "browser may not be secure"). Relocate that one-time
    // sign-in to a real top-level window sharing the same cookie jar — see
    // google_signin_show in live_webview.rs. Fire once per board session so a
    // redirect chain doesn't reopen it on every hop.
    let signinPromptedFor = '';
    // True from the moment we relocate sign-in until it finishes or is abandoned.
    // Read by syncLiveBoard (which keeps the child webview hidden) and by the
    // cancel listener (which ignores a close it already handled).
    let signinHold = false;
    let lastNonSigninUrl = '';
    // A cancel means "I don't want to do this now". Honour it for a beat: the
    // child webview is still parked on Google's sign-in page when the window
    // closes, and the 500ms URL poll keeps reporting that page until the
    // navigate-back lands — long enough to relocate again and reopen the window
    // the user just dismissed. The guard alone can't cover it (the poll's report
    // arrives before the move away that re-arms it), so the cancel path buys a
    // quiet window outright.
    const SIGNIN_QUIET_MS = 5000;
    let signinQuietUntil = 0;
    function maybeGoogleSignin(url: string) {
      if (Date.now() < signinQuietUntil) return;
      let u: URL;
      try { u = new URL(url); } catch { return; }
      if (u.hostname !== 'accounts.google.com') return;
      if (!/\/(signin|rejected)/.test(u.pathname)) return;
      // Where to send the pane afterwards. A third-party OAuth's `continue=` is
      // another accounts.google.com URL, which would put the pane back on the
      // sign-in host; the page we were actually on is the honest target.
      let cont = u.searchParams.get('continue') || liveUrl;
      try {
        if (new URL(cont).hostname === 'accounts.google.com' && lastNonSigninUrl) cont = lastNonSigninUrl;
      } catch {}
      if (signinPromptedFor === cont) return;
      signinPromptedFor = cont;
      holdPaneForSignin();
      ipc.googleSigninShow(url, cont).catch(() => { releasePaneHold(); });
    }
    // Put the pane behind a placeholder for the duration: one sign-in surface on
    // screen, and a way out that doesn't require finding the other window.
    function holdPaneForSignin() {
      signinHold = true;
      scheduleLiveSync();   // hides the child webview through the gate above
      const rb = liveRenderBox;
      if (!rb || rb.querySelector('.livehold')) return;
      const hold = document.createElement('div');
      hold.className = 'livehold';
      const title = document.createElement('div');
      title.className = 'livehold-t';
      title.textContent = 'Finishing sign-in in a separate window';
      const sub = document.createElement('div');
      sub.className = 'livehold-s';
      sub.textContent = 'Google will not accept a sign-in inside an embedded browser, so it runs in its own window. This page comes back once you are through.';
      const cancel = document.createElement('button');
      cancel.className = 'livehold-b';
      cancel.textContent = 'Cancel sign-in';
      cancel.addEventListener('click', () => {
        // Closing the window emits google-signin-cancelled, which sets the quiet
        // window and returns the pane — same path as closing it by hand.
        ipc.googleSigninClose().catch(() => {});
      });
      hold.append(title, sub, cancel);
      rb.appendChild(hold);
    }
    function releasePaneHold() {
      signinHold = false;
      const rb = liveRenderBox;
      if (rb) rb.querySelectorAll('.livehold').forEach((e) => e.remove());
    }
    // Drop the hold and point the pane at `url` (the doc we were bounced from on
    // success, the page we came from on cancel).
    function returnPaneAfterSignin(url: string) {
      releasePaneHold();
      if (!liveRenderBox || !liveRenderBox.isConnected || !url) { scheduleLiveSync(); return; }
      liveUrl = url;
      if (liveBoardCtl) { liveBoardCtl.addr.value = url; liveBoardCtl.onNav(url); }
      scheduleLiveSync();
      reportFocus();
    }
    // The address bar / tab name track reality through the main-frame-only URL
    // poll below — NOT through an on_navigation event, which fires for iframe
    // subframes too (Gmail's ogs.google.com widget) and made the bar flicker
    // between the main URL and whatever widget just loaded.
    // A _blank/window.open the page tried to open in a new window: keep it in the
    // pane by navigating the one board to it. Same effect as applyLiveNav, but it
    // must ALSO drive the webview there — scheduleLiveSync passes the new liveUrl
    // to live_webview_show, which navigates because the URL changed. onNav keeps
    // the active doc's path/name + address bar in step.
    ipc.onLiveOpen((url) => {
      if (!liveRenderBox || !liveRenderBox.isConnected) return;
      liveUrl = url;
      if (liveBoardCtl) { liveBoardCtl.addr.value = url; liveBoardCtl.onNav(url); }
      scheduleLiveSync();
      reportFocus();
    }).catch(() => {});
    // Google sign-in finished in the top-level window: the session cookies are now
    // in the shared jar. Close it and point the pane back at the doc we were
    // bounced from — it reloads authenticated. Clear the one-shot guard so a later
    // expiry can prompt again.
    ipc.onGoogleSigninDone((url) => {
      ipc.googleSigninClose().catch(() => {});
      // The flow completed, so a later session expiry is allowed to prompt again
      // immediately — no need to wait for the re-arm above.
      signinPromptedFor = '';
      returnPaneAfterSignin(url);
    }).catch(() => {});
    // The sign-in window went away without completing (closed by hand, or given
    // up on). Without this the pane stayed held behind the placeholder forever.
    // The ordinary post-success close destroys that window too, so this fires
    // then as well — releasePaneHold has already run by then and the guard makes
    // it a no-op rather than a second navigation.
    ipc.onGoogleSigninCancelled(() => {
      if (!signinHold) return;
      signinQuietUntil = Date.now() + SIGNIN_QUIET_MS;
      signinPromptedFor = '';
      returnPaneAfterSignin(lastNonSigninUrl || liveUrl);
    }).catch(() => {});
    // Poll the webview's real URL while a board is on screen. on_navigation
    // (which feeds live-nav) only fires on document loads, so it misses SPA
    // pushState routes and goes stale when a redirect/blocked nav (e.g. an
    // embedded sign-in Google bounces back) lands the page somewhere else. The
    // poll keeps the address bar honest; applyLiveNav is idempotent and won't
    // clobber the bar while it's focused.
    let livePollBusy = false;
    setInterval(async () => {
      if (livePollBusy) return;
      if (!liveRenderBox || !liveRenderBox.isConnected
        || !liveRenderBox.classList.contains('show') || liveBoardOccluded()) return;
      livePollBusy = true;
      try {
        const url = await ipc.liveWebviewUrl();
        if (url && url !== liveUrl) applyLiveNav(url);
      } catch {} finally { livePollBusy = false; }
    }, 500);
    // Coalesce the many triggers (resize, layout, overlay/menu toggles, tab
    // switches) into one call per frame; the no-op-reload guard lives in Rust.
    function scheduleLiveSync() {
      if (liveSyncRaf) return;
      liveSyncRaf = requestAnimationFrame(() => { liveSyncRaf = 0; syncLiveBoard(); });
    }
    // An edit ending is a sync trigger like any other: while one was open we told
    // the board not to take first responder, so it's owed the grab (see
    // domTextEditActive / focus_owed in live_webview.rs) and this is what pays it.
    // Cheap — syncLiveBoard is a no-op tick when nothing moved, and the rAF
    // coalesces bursts.
    document.addEventListener('focusout', () => scheduleLiveSync(), true);

    // language for the editor's live highlighting, by file type.
    function editorLang(name) {
      if (MD_EXT.test(name)) return 'markdown';
      if (HTML_EXT.test(name)) return 'xml';
      if (JSON_EXT.test(name)) return 'json';
      if (/\.css$/i.test(name)) return 'css';
      return langFor(name);   // code extensions, else null
    }
    // only these file kinds have a distinct rendered view (and thus a toggle).
    function hasRendered(name) {
      return MD_EXT.test(name) || HTML_EXT.test(name) || CSV_EXT.test(name);
    }

    // `selectedRow` is the tree row wearing the "selected" lift so we can
    // clear it on switch; the open-document state itself lives per instance.
    let selectedRow = null;
    // last document opened in the preview, so the footer's right-dock toggle can
    // reopen it after a close (true toggle, not just a one-way close).
    let lastFilePath = null, lastFileName = null;
    // most-recently-opened files (paths, newest first), surfaced to the embedded
    // agent via `spike context` so it can see what's been in play.
    let recentFiles = [];

    const MD_EXT = /\.(md|markdown)$/i;
    const HTML_EXT = /\.(html?|htm)$/i;
    // Bridge appended to every HTML srcdoc. The sandbox has allow-scripts but NO
    // allow-same-origin, so the parent can't reach into the frame — this little
    // script is the only channel back out. A sandboxed `about:srcdoc` document is
    // NOT a normal page: hashchange/popstate don't fire and a plain in-page link
    // can replace the whole document, taking this script with it. So we don't try
    // to track the frame's own history — we just detect that the user navigated
    // (capture-phase anchor clicks, which fire before any teardown; pushState for
    // JS routers; a location poll as a catch-all) and report it. "Back" is then a
    // parent-side re-render of the original doc — engine-independent, can't break.
    // The bridge also answers find queries (window.find) and forwards ⌘F / ⌘± / ⌘[
    // keys the parent can't see while the frame holds focus. allow-scripts is
    // already on, so this grants the doc no capability it didn't already have.
    const SPIKE_BRIDGE = '<script>(function(){'
      + 'if(window.__spikeBridge)return;window.__spikeBridge=1;'
      + 'var _sb=document.currentScript;'   // this bridge's own node — the end of the real content
      + 'function P(m){try{parent.postMessage(m,"*");}catch(e){}}'
      + 'var navd=false;function navd_(){if(navd)return;navd=true;P({__spikeNav:"state",canBack:true});}'
      + 'var _ed=false;'   // in-place edit mode active (set by __spikeEdit:on); suppresses note gestures

      + 'document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a"):null;'
      + 'if(!a)return;var h=a.getAttribute("href");'
      + 'if(!h||h==="#"||/^javascript:/i.test(h))return;'
      // external http(s) links open in the real browser — letting them navigate
      // this sandboxed iframe would replace the doc (and kill this bridge),
      // stranding the user with no way back to Spike. In-page anchors fall through.
      + 'var abs;try{abs=new URL(h,location.href).href;}catch(_){abs=h;}'
      + 'if(/^https?:/i.test(abs)){e.preventDefault();P({__spikeNav:"external",url:abs});return;}'
      + 'if(a.target==="_blank")return;navd_();},true);'
      + 'var _ps=history.pushState;history.pushState=function(){var r=_ps.apply(this,arguments);navd_();return r;};'
      + 'var _rs=history.replaceState;history.replaceState=function(){var r=_rs.apply(this,arguments);navd_();return r;};'
      + 'var last=location.href;setInterval(function(){if(location.href!==last){last=location.href;navd_();}},150);'
      + 'addEventListener("message",function(e){var m=e.data;if(!m||typeof m!=="object")return;'
      + 'if(m.__spikeFind==="search"){var ok=false;try{if(m.fresh){var s=getSelection();if(s)s.removeAllRanges();}'
      + 'ok=window.find(m.q,false,!!m.back,true);}catch(_){}P({__spikeFind:"result",ok:!!ok});}'
      + 'else if(m.__spikeFind==="clear"){try{var s2=getSelection();if(s2)s2.removeAllRanges();}catch(_){}}'
      + 'else if(m.__spikeAnnots){try{paintAnn(m.__spikeAnnots,m.accent);}catch(_){}}'
      + 'else if(m.__spikeEdit==="on"){try{edOn();}catch(_){}}'
      + 'else if(m.__spikeEdit==="cmd"){try{edCmd(m.cmd,m.val);}catch(_){}}'
      + 'else if(m.__spikeEdit==="save"){try{edSave();}catch(_){}}'
      // notes-drawer "jump to passage": scroll our own highlight span into view
      // and pulse it (the parent can't reach into this sandbox to do it).
      + 'else if(m.__spikeScrollAnnot){try{var el=document.querySelector(".__sann[data-id=\\""+m.__spikeScrollAnnot+"\\"]");if(el){el.scrollIntoView({block:"center",behavior:"smooth"});var o=el.style.backgroundColor;el.style.transition="background-color .3s ease";el.style.backgroundColor="rgba(184,95,78,.5)";setTimeout(function(){el.style.backgroundColor=o;},800);}}catch(_){}}});'
      + 'addEventListener("keydown",function(e){if(!(e.metaKey||e.ctrlKey)||e.altKey)return;var k=e.key.toLowerCase();'
      // while editing, the frame owns focus so the parent never sees these keys —
      // handle the formatting shortcuts + ⌘S (save+done) here in the frame.
      + 'if(_ed){if(k==="b"){e.preventDefault();edCmd("bold");return;}if(k==="i"){e.preventDefault();edCmd("italic");return;}if(k==="u"){e.preventDefault();edCmd("underline");return;}if(k==="s"||k==="e"){e.preventDefault();edSave();return;}}'
      // ⌘E while the frame holds focus (it grabs focus on open) enters in-place
      // edit — the parent's window keymap never sees this key, so ask for it.
      + 'if(k==="e"){e.preventDefault();P({__spikeEdit:"enter"});}'
      + 'else if(k==="f"){e.preventDefault();P({__spikeFind:"open"});}'
      + 'else if(k==="["){e.preventDefault();P({__spikeNav:"home"});}'
      + 'else if(k==="="||k==="+"){e.preventDefault();P({__spikeFind:"zoom",dir:1});}'
      + 'else if(k==="-"){e.preventDefault();P({__spikeFind:"zoom",dir:-1});}'
      + 'else if(k==="0"){e.preventDefault();P({__spikeFind:"zoom",dir:0});}'
      + 'else if(k>="1"&&k<="9"){e.preventDefault();P({__spikeTab:+k});}},true);'
      // highlight-to-note across the sandbox: a selection made inside this frame
      // is invisible to the parent's getSelection(), so we report it out — the
      // quoted text, 32 chars of context each side for re-anchoring, and the
      // caret's on-frame coords so the parent can float the Note chip there.
      // mousedown clears a stale chip (parent can't see clicks into the frame).
      + 'function selctx(r){var pre="",suf="";try{var a=document.createRange();a.setStart(document.body,0);a.setEnd(r.startContainer,r.startOffset);pre=a.toString().slice(-32);var b=document.createRange();b.setStart(r.endContainer,r.endOffset);if(_sb&&_sb.parentNode)b.setEndBefore(_sb);else b.setEndAfter(document.body);suf=b.toString().slice(0,32);}catch(_){}return{pre:pre,suf:suf};}'
      + 'document.addEventListener("mouseup",function(){if(_ed)return;setTimeout(function(){if(_ed)return;var s=getSelection();if(!s||s.isCollapsed||!s.rangeCount)return;var t=s.toString();if(!t.trim())return;var r=s.getRangeAt(0);var rs=r.getClientRects();var rc=rs.length?rs[rs.length-1]:r.getBoundingClientRect();var c=selctx(r);P({__spikeSel:"show",text:t,prefix:c.pre,suffix:c.suf,x:rc.left+rc.width/2,y:rc.top});},0);});'
      + 'document.addEventListener("mousedown",function(){P({__spikeSel:"hide"});});'
      // saved-note highlights: the parent can't reach into this sandboxed frame to
      // paint, so it posts its annotation list and we mark up our OWN DOM — the
      // same persistent marker markdown gets, so KEEP has a visible result here.
      // We re-locate each quote by stored context (skipping our own script/style
      // text so offsets match what selctx captured), wrap the range, and report a
      // click back so the parent opens its note editor. Full list every time →
      // unwrap + repaint is idempotent and survives a "back" re-render.
      + 'function annSkip(n){for(var p=n.parentNode;p;p=p.parentNode){if(p.nodeName==="SCRIPT"||p.nodeName==="STYLE")return true;}return false;}'
      + 'function annNodes(){var w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,null),a=[],n;while(n=w.nextNode()){if(!annSkip(n))a.push(n);}return a;}'
      + 'function annText(){var ns=annNodes(),s="";for(var i=0;i<ns.length;i++)s+=ns[i].nodeValue;return s;}'
      + 'function annPoint(off){var ns=annNodes(),acc=0;for(var i=0;i<ns.length;i++){var l=ns[i].nodeValue.length;if(off<=acc+l)return{node:ns[i],off:off-acc};acc+=l;}return null;}'
      // Fold whitespace so a quote captured as RENDERED text (collapsed spaces)
      // still matches the raw node-value text — mirrors the parent's foldWs.
      + 'function annFold(raw){var norm="",map=[],ws=false;for(var i=0;i<raw.length;i++){var c=raw.charCodeAt(i);var w=(c===32||c===9||c===10||c===13||c===160||c===12);if(w){if(!ws){norm+=" ";map.push(i);ws=true;}}else{norm+=raw[i];map.push(i);ws=false;}}map.push(raw.length);return{norm:norm,map:map};}'
      + 'function annLocate(a){if(!a.quote)return null;var H=annFold(annText());var nq=a.quote.replace(/\\s+/g," ").replace(/^\\s+|\\s+$/g,"");if(!nq)return null;var pf=(a.prefix||"").replace(/\\s+/g," "),sf=(a.suffix||"").replace(/\\s+/g," ");var best=-1,bs=-1,from=0,at;while((at=H.norm.indexOf(nq,from))!==-1){var pre=H.norm.slice(Math.max(0,at-32),at),suf=H.norm.slice(at+nq.length,at+nq.length+32);var s=0;while(s<pre.length&&s<pf.length&&pre[pre.length-1-s]===pf[pf.length-1-s])s++;var s2=0;while(s2<suf.length&&s2<sf.length&&suf[s2]===sf[s2])s2++;if(s+s2>bs){bs=s+s2;best=at;}from=at+1;}if(best<0)return null;var st=H.map[best],en=H.map[best+nq.length];var sp=annPoint(st),ep=annPoint(en);if(!sp||!ep)return null;var r=document.createRange();try{r.setStart(sp.node,sp.off);r.setEnd(ep.node,ep.off);}catch(_){return null;}return{r:r,start:st};}'
      + 'function annWrap(range,id){var host=range.commonAncestorContainer,nodes=[];if(host.nodeType===3)nodes.push(host);else{var w=document.createTreeWalker(host,NodeFilter.SHOW_TEXT,null),n;while(n=w.nextNode()){if(range.intersectsNode(n)&&!annSkip(n))nodes.push(n);}}for(var i=0;i<nodes.length;i++){var node=nodes[i],r=document.createRange();r.selectNodeContents(node);if(node===range.startContainer)r.setStart(node,range.startOffset);if(node===range.endContainer)r.setEnd(node,range.endOffset);if(r.collapsed)continue;var sp=document.createElement("span");sp.className="__sann";sp.setAttribute("data-id",id);try{r.surroundContents(sp);}catch(_){}}}'
      + 'function annUnwrap(){var ss=document.querySelectorAll("span.__sann");for(var i=0;i<ss.length;i++){var s=ss[i],p=s.parentNode;if(!p)continue;while(s.firstChild)p.insertBefore(s.firstChild,s);p.removeChild(s);}try{document.body.normalize();}catch(_){}}'
      // The frame can't see the app's --accent, so the parent passes it in and we
      // rebuild the EXACT markdown .spike-annot recipe (accent wash + thin accent
      // underline) — one restrained accent, identical note across both surfaces.
      + 'var _annEl=null;function paintAnn(list,acc){acc=acc||"#B85F4E";if(!_annEl){_annEl=document.createElement("style");(document.head||document.documentElement).appendChild(_annEl);}_annEl.textContent=".__sann{background-color:color-mix(in srgb,"+acc+" 12%,transparent);border-radius:3px;cursor:pointer;text-decoration:underline;text-decoration-color:color-mix(in srgb,"+acc+" 48%,transparent);text-decoration-thickness:1.5px;text-underline-offset:3px;-webkit-box-decoration-break:clone;box-decoration-break:clone;}.__sann:hover{background-color:color-mix(in srgb,"+acc+" 22%,transparent);text-decoration-color:"+acc+";}";annUnwrap();var loc=[];for(var i=0;i<list.length;i++){var L=annLocate(list[i]);if(L)loc.push({id:list[i].id,start:L.start,range:L.r});}loc.sort(function(x,y){return y.start-x.start;});for(var j=0;j<loc.length;j++)annWrap(loc[j].range,loc[j].id);}'
      + 'document.addEventListener("click",function(e){if(_ed)return;var s=e.target&&e.target.closest?e.target.closest(".__sann"):null;if(!s)return;e.preventDefault();e.stopPropagation();P({__spikeSel:"annot",id:s.getAttribute("data-id"),x:e.clientX,y:e.clientY});},true);'
      // ── in-place text editor ──────────────────────────────────────────
      // Parent drives this over postMessage (__spikeEdit: on / cmd / save). We
      // make <body> contenteditable; the FORMATTING BAR itself lives in Spike's
      // header (same themed one-row bar markdown uses), and each button posts a
      // {__spikeEdit:"cmd"} in. Because clicking a parent-side button blurs this
      // frame and collapses its selection, we track the live selection here on
      // selectionchange and restore it before running each command. On save we
      // serialize document.body's inner HTML — this bridge <script>, note spans,
      // and contenteditable attrs stripped — and post it out; the parent splices
      // it back between <body> and </body> so head/doctype/scripts round-trip
      // byte-for-byte. Inline formatting only — a full restructure is a
      // conversation with the agent, by design.
      + 'function edPost(){P({__spikeEdit:"dirty"});}'
      + 'function edBlk(){var s=getSelection();if(!s||!s.rangeCount)return"p";var n=s.getRangeAt(0).startContainer;while(n&&n!==document.body){if(n.nodeType===1){var t=n.tagName.toLowerCase();if(/^(p|h1|h2|h3|h4|h5|h6|blockquote|pre|li)$/.test(t))return t;}n=n.parentNode;}return"p";}'
      + 'var _edRange=null;'
      + 'function edSelReport(){P({__spikeEdit:"block",tag:edBlk()});}'
      + 'function edSel(){if(!_ed)return;var s=getSelection();if(s&&s.rangeCount&&document.body.contains(s.anchorNode))_edRange=s.getRangeAt(0).cloneRange();edSelReport();}'
      + 'function edRestore(){try{document.body.focus();if(_edRange){var s=getSelection();s.removeAllRanges();s.addRange(_edRange);}}catch(_){}}'
      + 'function edCode(){var s=getSelection();if(!s||!s.rangeCount)return;var r=s.getRangeAt(0);if(r.collapsed)return;try{r.surroundContents(document.createElement("code"));}catch(_){}}'
      + 'function edCmd(c,v){if(!_ed)return;edRestore();if(c==="code")edCode();else{try{document.execCommand(c,false,(v===undefined||v===null)?null:v);}catch(_){}}edPost();edSelReport();}'
      + 'function edOn(){if(_ed)return;_ed=true;if(_sb)_sb.id="__spikeBridge";'
      + 'try{document.execCommand("styleWithCSS",false,false);}catch(_){}'
      + 'document.body.setAttribute("contenteditable","true");document.body.spellcheck=true;'
      + 'document.body.addEventListener("input",edPost);document.addEventListener("selectionchange",edSel);'
      + 'try{document.body.focus();}catch(_){}P({__spikeEdit:"ready"});edSelReport();}'
      + 'function edStrip(root){var i,ns;'
      + 'ns=root.querySelectorAll("#__spikeBridge,script.__spikeBridge");for(i=0;i<ns.length;i++)ns[i].remove();'
      + 'ns=root.querySelectorAll("span.__sann");for(i=0;i<ns.length;i++){var s=ns[i],p=s.parentNode;if(!p)continue;while(s.firstChild)p.insertBefore(s.firstChild,s);p.removeChild(s);}'
      + 'ns=root.querySelectorAll("[contenteditable]");for(i=0;i<ns.length;i++)ns[i].removeAttribute("contenteditable");'
      + 'root.removeAttribute("contenteditable");root.removeAttribute("spellcheck");}'
      + 'function edSave(){if(!_ed)return;var clone=document.body.cloneNode(true);edStrip(clone);'
      + 'try{clone.normalize();}catch(_){}P({__spikeEdit:"html",body:clone.innerHTML});edDown();}'
      + 'function edDown(){_ed=false;_edRange=null;try{document.body.removeEventListener("input",edPost);}catch(_){}'
      + 'try{document.removeEventListener("selectionchange",edSel);}catch(_){}'
      + 'document.body.removeAttribute("contenteditable");document.body.removeAttribute("spellcheck");}'
      + 'P({__spikeNav:"state",canBack:false});})();<\/script>';
    const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;
    const PDF_EXT = /\.pdf$/i;
    const CSV_EXT = /\.(csv|tsv)$/i;
    const JSON_EXT = /\.(json|jsonc|geojson)$/i;
    const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|flac)$/i;
    const VIDEO_EXT = /\.(mp4|m4v|webm|mov)$/i;
    // extension -> highlight.js language. Recognized code opens in the
    // highlighted (rendered) view by default; toggle <> to edit raw.
    const LANGS = {
      js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
      ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', go: 'go',
      rs: 'rust', java: 'java', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cs: 'csharp',
      php: 'php', swift: 'swift', kt: 'kotlin', sh: 'bash', bash: 'bash', zsh: 'bash',
      sql: 'sql', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', xml: 'xml',
      css: 'css', scss: 'scss', less: 'less', lua: 'lua', r: 'r', dart: 'dart',
      vue: 'xml', svelte: 'xml', graphql: 'graphql', dockerfile: 'dockerfile', diff: 'diff',
    };
    function langFor(name) {
      if (/^dockerfile$/i.test(name)) return 'dockerfile';
      const ext = (name.split('.').pop() || '').toLowerCase();
      return LANGS[ext] || null;
    }

    // Minimal RFC-4180-ish parser: quoted fields, "" escapes, commas/newlines
    // inside quotes. delim is ',' or '\t'.
    function parseDelimited(text, delim) {
      const rows = []; let row = [], field = '', inQ = false;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQ) {
          if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
          else field += c;
        } else if (c === '"') { inQ = true; }
        else if (c === delim) { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else if (c !== '\r') field += c;
      }
      if (field.length || row.length) { row.push(field); rows.push(row); }
      return rows;
    }

    // ── interactive data table (Spike table) ────────────────────────────────
    // Mount a Notion/Sheets-flavored grid over a SQLite-backed table doc
    // (ipc.TableDoc). Sorting + filtering are client-side (instant, no round
    // trip); every *edit* — cell value, add/remove row, add/rename/retype/delete
    // column — goes through the datatable.rs verbs, which return the fresh doc so
    // the grid re-renders from truth. The backend re-exports the csv mirror on
    // each mutation, so the file tree + git stay in sync. Guards against a
    // superseded mount (a newer open) via the token the caller closes over.
    type DtDoc = import('./ipc').TableDoc;
    type DtCol = import('./ipc').TableColumn;
    type DtRow = import('./ipc').TableRow;
    const DT_TYPES: [import('./ipc').TableColType, string, string][] = [
      ['text', 'T', 'Text'], ['number', '#', 'Number'], ['date', '◷', 'Date'],
      ['checkbox', '☑', 'Checkbox'], ['select', '▾', 'Select'], ['multiselect', '▾', 'Multi-select'],
      ['status', '◐', 'Status'],
      ['place', '◎', 'Place'], ['url', '🔗', 'Link'],
    ];
    type DtOptGroup = import('./ipc').TableOptGroup;
    // Status buckets, in board/left-to-right order. label = section header; hue =
    // default color for a freshly-created option in that bucket.
    const STATUS_GROUPS: [DtOptGroup, string, string][] = [
      ['todo', 'To-do', '#9AA0A6'],
      ['active', 'In progress', '#5A8FC2'],
      ['done', 'Done', '#6FA96A'],
    ];
    const STATUS_ORDER: Record<string, number> = { todo: 0, active: 1, done: 2 };
    // The three options a new Status column seeds with (Notion's defaults).
    const STATUS_SEED: { value: string; color: string; group: DtOptGroup }[] = [
      { value: 'Not started', color: '#9AA0A6', group: 'todo' },
      { value: 'In progress', color: '#5A8FC2', group: 'active' },
      { value: 'Done', color: '#6FA96A', group: 'done' },
    ];
    // The Spike palette, NAMED (Notion shows named colors, not raw swatches). Gray
    // leads (the neutral default), then the 12 group-color wheel. Used by every
    // color picker (option editor, board-group recolor).
    const DT_PALETTE: [string, string][] = [
      ['Gray', '#9AA0A6'], ['Red', '#CB5D5D'], ['Coral', '#D6835A'], ['Amber', '#E0A24E'],
      ['Olive', '#9AAA57'], ['Green', '#6FA96A'], ['Teal', '#4CA090'], ['Cyan', '#4C9FB0'],
      ['Blue', '#5A8FC2'], ['Indigo', '#7A78C4'], ['Violet', '#9E70BE'], ['Orchid', '#C267A0'], ['Rose', '#CB6389'],
    ];
    const dtColorName = (hex: string): string => (DT_PALETTE.find(([, h]) => h.toLowerCase() === (hex || '').toLowerCase()) || ['Custom', hex])[0];
    const dtTruthy = (v: string) =>
      ['true', 'yes', 'y', '✓', '1', 'x'].includes((v || '').trim().toLowerCase());
    // Stable per-value hue from the group palette — same tag → same color always.
    function dtHueFor(s: string): string {
      let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
      return GROUP_COLORS[h % GROUP_COLORS.length];
    }
    // The color a select/multiselect/status option should paint with: the user's
    // chosen color if set, else the stable hash-derived hue. This is the single
    // override point — every tag pill/dot/lane resolves its color through here.
    function colorForOption(col: DtCol, value: string): string {
      return col.optionMeta?.[value]?.color || dtHueFor(value);
    }
    // A status option's group bucket (defaults to 'todo' when unset).
    function groupForOption(col: DtCol, value: string): DtOptGroup {
      return (col.optionMeta?.[value]?.group as DtOptGroup) || 'todo';
    }
    // Status is a single-select variant: it renders/edits like 'select' but its
    // options carry a group bucket. These predicates fold it into the shared paths.
    const dtSelectLike = (t: string) => t === 'select' || t === 'status';
    const dtOptionType = (t: string) => dtSelectLike(t) || t === 'multiselect';
    const dtIsUrl = (v: string) => {
      const t = (v || '').trim();
      return /^https?:\/\/\S+$/i.test(t) || /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(t);
    };
    const dtHref = (v: string) => (/^https?:\/\//i.test(v.trim()) ? v.trim() : 'https://' + v.trim());
    // Per-type header/menu icon, matched to Notion's vocabulary: Aa for text, a
    // target for select, # for number, a calendar for date, a check-box.
    function dtTypeIcon(type: string): string {
      const P = (d: string) => `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
      if (type === 'number') return P('<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>');
      if (type === 'date') return P('<rect x="3" y="4.5" width="18" height="16.5" rx="2.5"/><path d="M16 2.5v4M8 2.5v4M3 10h18"/>');
      if (type === 'checkbox') return P('<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m8 12 3 3 5-6"/>');
      if (type === 'select') return P('<circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/>');
      if (type === 'multiselect') return P('<path d="M4 7h11M4 12h11M4 17h11"/><circle cx="19.5" cy="7" r="1.6" fill="currentColor" stroke="none"/><circle cx="19.5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19.5" cy="17" r="1.6" fill="currentColor" stroke="none"/>');
      if (type === 'status') return P('<circle cx="12" cy="12" r="8.2"/><path d="M12 3.8a8.2 8.2 0 0 1 0 16.4z" fill="currentColor" stroke="none"/>');
      if (type === 'place') return P('<path d="M12 21s-6.5-6-6.5-10.5a6.5 6.5 0 0 1 13 0C18.5 15 12 21 12 21z"/><circle cx="12" cy="10.5" r="2.3"/>');
      if (type === 'url') return P('<path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1"/>');
      return '<span class="dt-aa">Aa</span>';   // text
    }
    const DT_EXT_ICON = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 5h5v5M19 5l-8 8M19 14v5H5V5h5"/></svg>';
    // Small line-icons for grid chrome (toolbar, menus, cell affordances).
    function dtSvg(d: string, size = 14): string {
      return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
    }
    const DT_ICONS: Record<string, string> = {
      funnel: '<path d="M3 5h18l-7 8v5l-4 2v-7z"/>',
      sliders: '<path d="M4 6h11M18 6h2M4 12h2M9 12h11M4 18h8M15 18h5"/><circle cx="16.5" cy="6" r="2"/><circle cx="7.5" cy="12" r="2"/><circle cx="13.5" cy="18" r="2"/>',
      eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
      eyeOff: '<path d="M3 3l18 18M10.6 10.7a3 3 0 0 0 4 4M9.9 5.2A9.6 9.6 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.3 4M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 3-.5"/>',
      search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-3.6-3.6"/>',
      sort: '<path d="M7 4v16M7 4 4 7M7 4l3 3M17 20V4M17 20l3-3M17 20l-3-3"/>',
      arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
      arrowDown: '<path d="M12 5v14M5 12l7 7 7-7"/>',
      pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
      trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
      pin: '<path d="M12 21s-6.5-6-6.5-10.5a6.5 6.5 0 0 1 13 0C18.5 15 12 21 12 21z"/><circle cx="12" cy="10.5" r="2.3"/>',
      chevL: '<path d="M15 6l-6 6 6 6"/>',
      chevR: '<path d="M9 6l6 6-6 6"/>',
      check: '<path d="m5 12 4 4L19 6"/>',
      dots: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
      x: '<path d="M6 6l12 12M18 6L6 18"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      download: '<path d="M12 3v12M7 10l5 5 5-5M4 20h16"/>',
      copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
      insLeft: '<path d="M14 4v16"/><path d="M4 12h5"/><path d="M6.5 9.5v5"/>',
      insRight: '<path d="M10 4v16"/><path d="M20 12h-5"/><path d="M17.5 9.5v5"/>',
      vTable: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/>',
      vBoard: '<rect x="3" y="4" width="4.5" height="16" rx="1"/><rect x="9.75" y="4" width="4.5" height="11" rx="1"/><rect x="16.5" y="4" width="4.5" height="14" rx="1"/>',
      vGallery: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
      vList: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
      vCalendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    };
    const VIEW_META: Record<string, [string, string]> = {
      table: ['vTable', 'Table'], board: ['vBoard', 'Board'], gallery: ['vGallery', 'Gallery'],
      list: ['vList', 'List'], calendar: ['vCalendar', 'Calendar'],
    };
    const dtIcon = (name: string, size = 14) => dtSvg(DT_ICONS[name] || '', size);
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    // Parse a stored date string → {y,m,d} (m 0-based) or null.
    function dtParseYMD(v: string): { y: number; m: number; d: number } | null {
      const t = (v || '').trim(); if (!t) return null;
      const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
      if (iso) return { y: +iso[1], m: +iso[2] - 1, d: +iso[3] };
      const ms = Date.parse(t); if (isNaN(ms)) return null;
      const dt = new Date(ms); return { y: dt.getFullYear(), m: dt.getMonth(), d: dt.getDate() };
    }
    // Days between two {y,m,d} (b - a), calendar-day exact (no TZ drift).
    const dtDayDiff = (a: { y: number; m: number; d: number }, b: { y: number; m: number; d: number }) =>
      Math.round((Date.UTC(b.y, b.m, b.d) - Date.UTC(a.y, a.m, a.d)) / 86400000);
    // Near dates read as Today / Yesterday / Tomorrow (Notion-style relative time);
    // everything else stays an absolute date. Same-year drops the year.
    const dtFmtDate = (v: string) => {
      const p = dtParseYMD(v); if (!p) return v;
      const t = dtParseYMD(new Date().toISOString());
      if (t) {
        const diff = dtDayDiff(t, p);
        if (diff === 0) return 'Today';
        if (diff === 1) return 'Tomorrow';
        if (diff === -1) return 'Yesterday';
        if (p.y === t.y) return `${MONTHS[p.m]} ${p.d}`;
      }
      return `${MONTHS[p.m]} ${p.d}, ${p.y}`;
    };
    // A multiselect cell is a JSON array of tag strings; parse tolerantly and
    // serialize canonically so the backend's option-merge sees clean values.
    const dtMulti = (v: string): string[] => {
      const t = (v || '').trim(); if (!t) return [];
      try { const a = JSON.parse(t); if (Array.isArray(a)) return a.map((x) => String(x).trim()).filter(Boolean); } catch {}
      return t.split(',').map((s) => s.trim()).filter(Boolean);
    };
    const dtMultiStr = (arr: string[]) => JSON.stringify(arr);
    const dtYMD = (y: number, m: number, d: number) =>
      `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dtIsLocationCol = (name: string) => /\b(location|address|city|place|based|hq|office)\b/i.test(name || '');
    // Display a number by its column format (money/percent/separators).
    const DT_NUMFMT: [string, string][] = [
      ['plain', 'Plain'], ['comma', '1,000'], ['usd', '$ USD'], ['eur', '€ EUR'], ['gbp', '£ GBP'], ['percent', 'Percent %'],
    ];
    function dtFmtNumber(val: string, format?: string): string {
      const n = parseFloat((val || '').replace(/[,$€£%\s]/g, ''));
      if (isNaN(n)) return val;
      const g = (d = 2) => n.toLocaleString('en-US', { maximumFractionDigits: d });
      switch (format) {
        case 'comma': return g(2);
        case 'usd': return '$' + g();
        case 'eur': return '€' + g();
        case 'gbp': return '£' + g();
        case 'percent': return g() + '%';
        default: return val;
      }
    }

    function mountDataGrid(container: HTMLElement, initial: DtDoc, alive: () => boolean) {
      let doc = initial;
      const path = doc.path;
      let sortKey: string | null = null;
      let sortDir = 1;              // 1 asc, -1 desc
      let filter = '';
      let groupBy: string | null = null;   // board group-by column
      let dateField: string | null = null; // calendar date column
      let hiddenGroups: string[] = [];     // board lanes hidden by the user
      let hideEmpty = false;               // board: drop lanes with no cards
      let hiddenCols: string[] = [];       // per-view hidden properties (Edit view)
      // Columns shown in the active view: all minus per-view hidden ones. The
      // primary (first) column is the title — always shown, never hideable.
      const shownCols = (): DtCol[] => doc.columns.filter((c, i) => i === 0 || !hiddenCols.includes(c.key));
      // structured filter TREE (separate from the free-text `filter` search): a
      // group has a conjunction (and | or) over rules AND nested sub-groups, so you
      // can build "A and (B or C)" like Notion. Persisted as config.filterTree;
      // reads legacy flat config.filters (wrapped in an AND group) for back-compat.
      type FRule = { col: string; op: string; value: string };
      type FGroup = { conj: 'and' | 'or'; rules: Array<FRule | FGroup> };
      const isFGroup = (n: FRule | FGroup): n is FGroup => Array.isArray((n as FGroup).rules);
      let filterRoot: FGroup = { conj: 'and', rules: [] };
      const ruleActive = (r: FRule): boolean => {
        const col = colByKey(r.col); if (!col) return false;
        if (opNoValue(r.op)) return true;
        return !opNeedsValueButEmpty(r, col.type);
      };
      const nodeActive = (n: FRule | FGroup): boolean => (isFGroup(n) ? n.rules.some(nodeActive) : ruleActive(n));
      const matchNode = (n: FRule | FGroup, row: DtRow): boolean => (isFGroup(n) ? matchGroup(n, row) : condMatches(n, row));
      function matchGroup(g: FGroup, row: DtRow): boolean {
        const parts = g.rules.filter(nodeActive);
        if (!parts.length) return true;
        return g.conj === 'or' ? parts.some((n) => matchNode(n, row)) : parts.every((n) => matchNode(n, row));
      }
      const countRules = (g: FGroup): number => g.rules.reduce((n, x) => n + (isFGroup(x) ? countRules(x) : 1), 0);
      const hasActiveFilter = () => filterRoot.rules.some(nodeActive);
      // Build the tree from a view config: prefer the new filterTree, else wrap the
      // legacy flat `filters` array in a top-level AND group (back-compat).
      function loadFilterTree(c: any): FGroup {
        const sane = (n: any): FRule | FGroup | null => {
          if (n && Array.isArray(n.rules)) return { conj: n.conj === 'or' ? 'or' : 'and', rules: n.rules.map(sane).filter(Boolean) as Array<FRule | FGroup> };
          if (n && typeof n.col === 'string') return { col: n.col, op: n.op, value: n.value || '' };
          return null;
        };
        if (c.filterTree && Array.isArray(c.filterTree.rules)) return sane(c.filterTree) as FGroup;
        const flat = Array.isArray(c.filters) ? c.filters.map((f: any) => ({ col: f.col, op: f.op, value: f.value || '' })) : [];
        return { conj: 'and', rules: flat };
      }
      let activeViewId = (doc.views[0] || { id: 'default' }).id;
      let persistT: any = null;
      let openMenu: HTMLElement | null = null;
      let closeSelPop: null | (() => void) = null;   // sticky select/multiselect popover
      const selected = new Set<number>();   // selected row ids

      container.innerHTML = '';
      container.className = (container.className.replace(/\bdtwrap\b/, '').trim() + ' dtwrap').trim();

      // toolbar: count · (bulk delete) · filter(funnel) · sort · add row/column · ⋯
      const bar = document.createElement('div'); bar.className = 'dt-bar';
      const count = document.createElement('span'); count.className = 'dt-count';
      const spacer = document.createElement('span'); spacer.style.flex = '1';
      const delSelBtn = document.createElement('button'); delSelBtn.className = 'dt-act danger dt-delsel'; delSelBtn.style.display = 'none';
      delSelBtn.addEventListener('click', deleteSelected);
      // Filter: a funnel that opens the per-column condition builder (a real
      // filter, not a text box). Shows a count badge when conditions are active.
      const funnelBtn = document.createElement('button'); funnelBtn.className = 'dt-iconbtn dt-funnel'; funnelBtn.title = 'Filter'; funnelBtn.innerHTML = dtIcon('funnel');
      funnelBtn.addEventListener('click', (e) => { e.stopPropagation(); openFilterMenu(funnelBtn); });
      // Search: a separate magnifier that expands an inline free-text field
      // (matches any cell). This is the old behaviour, now clearly "search".
      const searchWrap = document.createElement('div'); searchWrap.className = 'dt-filterwrap';
      const searchBtn = document.createElement('button'); searchBtn.className = 'dt-iconbtn dt-searchbtn'; searchBtn.title = 'Search'; searchBtn.innerHTML = dtIcon('search');
      const search = document.createElement('input');
      search.className = 'dt-filter'; search.type = 'text'; search.placeholder = 'Search…';
      search.addEventListener('input', () => { filter = search.value.trim().toLowerCase(); searchBtn.classList.toggle('active', !!filter); applyView(); });
      searchBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = searchWrap.classList.toggle('open');
        if (open) search.focus();
        else { search.value = ''; filter = ''; searchBtn.classList.remove('active'); applyView(); }
      });
      searchWrap.append(searchBtn, search);
      const sortBtn = document.createElement('button'); sortBtn.className = 'dt-iconbtn dt-sortbtn'; sortBtn.title = 'Sort'; sortBtn.innerHTML = dtIcon('sort');
      sortBtn.addEventListener('click', (e) => { e.stopPropagation(); openSortMenu(sortBtn); });
      // Download = one click → Export CSV (no ⋯ menu to dig through).
      const dlBtn = document.createElement('button'); dlBtn.className = 'dt-iconbtn dt-download'; dlBtn.title = 'Download CSV'; dlBtn.innerHTML = dtIcon('download');
      dlBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        ipc.tableExportCsv(path).then((csv: string) => { try { updateStatus('Downloaded ' + (csv.split('/').pop() || 'csv'), 2600); } catch {} }).catch(() => {});
      });
      // A universal "New record" — the one add that works in EVERY view (table,
      // board, gallery, list, calendar). Contextual adds still exist (lane feet,
      // calendar days, table footer), but this is the always-there create action.
      const newBtn = document.createElement('button'); newBtn.className = 'dt-iconbtn dt-newrec'; newBtn.title = 'New record'; newBtn.innerHTML = dtIcon('plus', 17);
      newBtn.addEventListener('click', (e) => { e.stopPropagation(); addRowWith(); });
      // View settings (sliders): show/hide + reorder properties for this view.
      const setBtn = document.createElement('button'); setBtn.className = 'dt-iconbtn dt-viewset'; setBtn.title = 'View settings'; setBtn.innerHTML = dtIcon('sliders');
      setBtn.addEventListener('click', (e) => { e.stopPropagation(); openViewSettings(setBtn); });
      // ONE top row: view tabs on the left, controls on the right (Notion-style).
      const viewbar = document.createElement('div'); viewbar.className = 'dt-viewbar';
      bar.append(viewbar, spacer, delSelBtn, funnelBtn, searchWrap, sortBtn, setBtn, dlBtn, newBtn);

      // A chip bar (under the toolbar) surfacing active filter conditions, each
      // clickable to edit + an ✕ to remove — shown only when filters exist.
      const filterbar = document.createElement('div'); filterbar.className = 'dt-filterbar'; filterbar.hidden = true;

      const scroll = document.createElement('div'); scroll.className = 'dt-scroll';
      const table = document.createElement('table'); table.className = 'dt';
      const thead = document.createElement('thead');
      const tbody = document.createElement('tbody');
      const tfoot = document.createElement('tfoot');
      table.append(thead, tbody, tfoot);
      container.append(bar, filterbar, scroll);

      // ── views (saved layouts + per-view sort/filter/group) ────────────────
      function activeView() { return doc.views.find((v) => v.id === activeViewId) || doc.views[0]; }
      // Pull the active view's saved state into the live vars + sync the toolbar.
      function loadViewState() {
        const c = (activeView() || ({} as any)).config || {};
        sortKey = c.sort && c.sort.key ? c.sort.key : null;
        sortDir = c.sort && c.sort.dir === -1 ? -1 : 1;
        filter = c.filter || '';
        groupBy = c.groupBy || null;
        dateField = c.dateField || null;
        hiddenGroups = Array.isArray(c.hiddenGroups) ? c.hiddenGroups.slice() : [];
        hideEmpty = !!c.hideEmpty;
        hiddenCols = Array.isArray(c.hiddenCols) ? c.hiddenCols.slice() : [];
        filterRoot = loadFilterTree(c);
        search.value = filter; searchWrap.classList.toggle('open', !!filter); searchBtn.classList.toggle('active', !!filter);
      }
      // Persist the live state back into the active view (debounced write).
      function persistView() {
        const v = activeView(); if (!v) return;
        v.config = { sort: { key: sortKey, dir: sortDir }, filter, filterTree: filterRoot, groupBy, dateField, hiddenGroups, hideEmpty, hiddenCols };
        const id = v.id, cfg = v.config;
        if (persistT) clearTimeout(persistT);
        // Persist only — the local doc already carries the new config (set above),
        // so we must NOT swap in the server doc here (it would clobber any
        // optimistic cell edit whose background write is still in flight).
        persistT = setTimeout(() => { ipc.tableUpdateView(path, id, null, cfg).catch(() => {}); }, 400);
      }
      // Re-render the active view after a sort/filter/group change (+ persist).
      function applyView() { persistView(); paintFilterBar(); renderActive(); paintCount(); }
      function switchView(id: string) { activeViewId = id; loadViewState(); paintViewbar(); renderActive(); paintCount(); }

      // Run a mutation verb; swap in the fresh doc it returns and repaint. Used
      // for STRUCTURAL ops whose result the backend computes (new keys, inferred
      // types) — cheap enough to await. High-frequency edits use the optimistic
      // path below instead.
      async function mutate(run: () => Promise<DtDoc>) {
        closeMenu();
        try {
          const next = await run();
          if (!alive()) return;
          doc = next; repaint();
        } catch (e) { /* backend rejected; leave the grid as-is */ }
      }
      function repaint() { paintViewbar(); paintFilterBar(); renderActive(); paintCount(); syncSelUi(); }

      // ── optimistic writes (frictionless editing) ──────────────────────────
      // The UI must never wait on a disk round-trip. We mutate the local doc and
      // render IMMEDIATELY, persist in the background, and only reconcile/roll
      // back if the backend disagrees. Temp ids (negative) stand in for rows the
      // backend hasn't assigned yet, swapped for the real doc on success.
      let nextTemp = -1;
      function reloadDoc() { ipc.tableRead(path).then((d) => { if (alive()) { doc = d; repaint(); } }).catch(() => {}); }
      function bgWrite(run: () => Promise<DtDoc>, after?: (d: DtDoc) => void) {
        run().then((d) => { if (alive() && after) after(d); }).catch(() => { if (alive()) reloadDoc(); });
      }
      // Mirror the backend's "typing a value into a select/multiselect remembers
      // it as an option" so the local doc matches without waiting for the read.
      function mirrorOptions(col: DtCol, value: string) {
        if (!dtOptionType(col.type)) return;
        const vals = col.type === 'multiselect' ? dtMulti(value) : (value.trim() ? [value.trim()] : []);
        for (const v of vals) if (!col.options.includes(v)) col.options.push(v);
      }
      // Optimistic single-cell write: update local doc + render now, persist async.
      function setCell(rowId: number, col: DtCol, value: string) {
        const row = doc.rows.find((r) => r.id === rowId); if (!row) return;
        if ((row.cells[col.key] || '') === (value || '')) { renderActive(); return; }   // no change: just exit any edit UI
        row.cells[col.key] = value;
        mirrorOptions(col, value);
        renderActive(); paintCount();
        if (rowId > 0) bgWrite(() => ipc.tableSetCell(path, rowId, col.key, value));
        // rowId < 0 → a not-yet-persisted temp row; its create call carries cells.
      }

      // A popover that survives grid re-renders (like the select popover): it lives
      // outside the shared openMenu slot and manages its own outside-click + Esc.
      function openStickyPop(anchor: HTMLElement, className: string) {
        closeMenu(); if (closeSelPop) closeSelPop();
        const menu = document.createElement('div'); menu.className = 'dt-menu ' + className;
        let onDown: ((e: MouseEvent) => void) | null = null;
        const close = () => { menu.remove(); if (onDown) document.removeEventListener('mousedown', onDown, true); if (closeSelPop === close) closeSelPop = null; };
        closeSelPop = close;
        document.body.appendChild(menu);
        const rect = anchor.getBoundingClientRect();
        const place = () => {
          const w = menu.offsetWidth || 300, h = menu.offsetHeight || 0;
          let left = rect.left; if (left + w > window.innerWidth - 8) left = Math.max(8, rect.right - w);
          let top = rect.bottom + 6; if (h && top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 6);
          menu.style.left = Math.round(left) + 'px'; menu.style.top = Math.round(top) + 'px';
        };
        onDown = (e: MouseEvent) => { if (!menu.contains(e.target as Node)) close(); };
        setTimeout(() => document.addEventListener('mousedown', onDown!, true), 0);
        return { menu, close, place };
      }

      // Human-readable value for a filter chip / builder summary.
      function condValueText(cond: { col: string; op: string; value: string }): string {
        const col = colByKey(cond.col); if (!col || opNoValue(cond.op)) return '';
        if (opMultiValue(col.type, cond.op)) { const t = dtMulti(cond.value || ''); return t.join(', '); }
        if (col.type === 'date') return dtFmtDate(cond.value || '');
        return cond.value || '';
      }
      // Render the chip bar under the toolbar (one chip per active condition).
      function paintFilterBar() {
        filterbar.innerHTML = '';
        const nRules = countRules(filterRoot);
        const sortCol = sortKey ? colByKey(sortKey) : null;
        filterbar.hidden = nRules === 0 && !sortCol;
        if (filterbar.hidden) return;
        // Active SORT pill (Notion-style): direction arrow + column name, click to
        // edit, ✕ to clear. Sits first, before the filter pill.
        if (sortCol) {
          const sp = document.createElement('button'); sp.className = 'dt-fchip dt-sortchip';
          sp.innerHTML = dtIcon(sortDir === 1 ? 'arrowUp' : 'arrowDown', 12) + `<span class="dt-fchip-col">${sortCol.name}</span>`;
          sp.addEventListener('click', (e) => { e.stopPropagation(); openSortMenu(sp); });
          const x = document.createElement('span'); x.className = 'dt-fchip-x'; x.innerHTML = dtIcon('x', 12);
          x.addEventListener('click', (e) => { e.stopPropagation(); sortKey = null; applyView(); });
          sp.appendChild(x); filterbar.appendChild(sp);
        }
        // Collapsed FILTER pill — "N rule(s)" opens the builder; ✕ clears all
        // (Notion collapses the whole filter tree into one pill).
        if (nRules) {
          const fp = document.createElement('button'); fp.className = 'dt-fchip dt-filterchip';
          fp.innerHTML = dtIcon('funnel', 12) + `<span class="dt-fchip-col">${nRules} ${nRules === 1 ? 'rule' : 'rules'}</span>`;
          fp.addEventListener('click', (e) => { e.stopPropagation(); openFilterMenu(fp); });
          const x = document.createElement('span'); x.className = 'dt-fchip-x'; x.innerHTML = dtIcon('x', 12);
          x.addEventListener('click', (e) => { e.stopPropagation(); filterRoot = { conj: 'and', rules: [] }; applyView(); });
          fp.appendChild(x); filterbar.appendChild(fp);
        }
        const add = document.createElement('button'); add.className = 'dt-fchip dt-fchip-add'; add.innerHTML = dtIcon('plus', 12) + '<span>Filter</span>';
        add.addEventListener('click', (e) => { e.stopPropagation(); addRule(filterRoot); openFilterMenu(add); });
        filterbar.appendChild(add);
      }
      // Append a fresh rule / nested group to a filter group.
      function addRule(g: FGroup) {
        const col = doc.columns[0]; if (!col) return;
        g.rules.push({ col: col.key, op: (opsFor(col.type)[0] || ['contains'])[0], value: '' });
      }
      function addGroup(g: FGroup) {
        const col = doc.columns[0];
        const rules: FRule[] = col ? [{ col: col.key, op: (opsFor(col.type)[0] || ['contains'])[0], value: '' }] : [];
        g.rules.push({ conj: 'and', rules });
      }
      // The filter builder (funnel / filter-pill click). Renders the filter TREE:
      // each group has a conjunction (And/Or) over rules + nested sub-groups, so you
      // can build "A and (B or C)" — Notion parity (Add filter rule / Add filter group).
      function openFilterMenu(anchor: HTMLElement) {
        const { menu, place } = openStickyPop(anchor, 'dt-filtermenu');
        let editing: { rule: FRule; field: 'col' | 'op' | 'val' } | null = null;
        const toggle = (rule: FRule, field: 'col' | 'op' | 'val') => { editing = (editing && editing.rule === rule && editing.field === field) ? null : { rule, field }; draw(); };
        const redo = () => { applyView(); draw(); place(); };

        // The lead cell: "Where" for the first row, else a clickable And/Or that
        // flips the whole group's conjunction (Notion applies one conj per group).
        function leadCell(g: FGroup, i: number): HTMLElement {
          if (i === 0) { const s = document.createElement('span'); s.className = 'dt-fjoin'; s.textContent = 'Where'; return s; }
          const b = document.createElement('button'); b.className = 'dt-fjoin dt-fconj'; b.textContent = g.conj === 'or' ? 'Or' : 'And';
          b.addEventListener('click', (e) => { e.stopPropagation(); g.conj = g.conj === 'and' ? 'or' : 'and'; redo(); });
          return b;
        }
        function ruleRow(container: HTMLElement, g: FGroup, cond: FRule, i: number): void {
          const col = colByKey(cond.col) || doc.columns[0];
          const rowEl = document.createElement('div'); rowEl.className = 'dt-frow';
          rowEl.appendChild(leadCell(g, i));
          const colb = document.createElement('button'); colb.className = 'dt-fseg' + (editing && editing.rule === cond && editing.field === 'col' ? ' open' : '');
          colb.innerHTML = `<span>${col ? col.name : 'Column'}</span>` + dtIcon('arrowDown', 11);
          colb.addEventListener('click', (e) => { e.stopPropagation(); toggle(cond, 'col'); });
          rowEl.appendChild(colb);
          const opb = document.createElement('button'); opb.className = 'dt-fseg' + (editing && editing.rule === cond && editing.field === 'op' ? ' open' : '');
          opb.innerHTML = `<span>${col ? opLabel(col.type, cond.op) : cond.op}</span>` + dtIcon('arrowDown', 11);
          opb.addEventListener('click', (e) => { e.stopPropagation(); toggle(cond, 'op'); });
          rowEl.appendChild(opb);
          if (col && !opNoValue(cond.op)) {
            if (opMultiValue(col.type, cond.op) || (dtSelectLike(col.type) && (cond.op === 'is' || cond.op === 'isnot'))) {
              const vb = document.createElement('button'); vb.className = 'dt-fseg dt-fval-seg' + (editing && editing.rule === cond && editing.field === 'val' ? ' open' : '');
              const txt = condValueText(cond); vb.innerHTML = `<span>${txt ? txt.replace(/</g, '&lt;') : 'Select…'}</span>` + dtIcon('arrowDown', 11);
              vb.addEventListener('click', (e) => { e.stopPropagation(); toggle(cond, 'val'); });
              rowEl.appendChild(vb);
            } else {
              const inp = document.createElement('input'); inp.className = 'dt-finput'; inp.value = cond.value || '';
              inp.type = 'text'; inp.placeholder = col.type === 'date' ? 'YYYY-MM-DD' : 'value';
              if (col.type === 'number') inp.inputMode = 'decimal';
              inp.addEventListener('input', () => { cond.value = inp.value; applyView(); });
              inp.addEventListener('click', (e) => e.stopPropagation());
              rowEl.appendChild(inp);
            }
          }
          const del = document.createElement('button'); del.className = 'dt-fdel'; del.title = 'Remove'; del.innerHTML = dtIcon('trash', 13);
          del.addEventListener('click', (e) => { e.stopPropagation(); g.rules.splice(g.rules.indexOf(cond), 1); editing = null; redo(); });
          rowEl.appendChild(del);
          container.appendChild(rowEl);
          if (editing && editing.rule === cond) container.appendChild(subPicker(cond, col, editing.field, () => { editing = null; draw(); place(); }));
        }
        // Render a group's rules into `container` (rules inline; nested groups in a
        // bordered box that recurses). Only the root offers "Add filter group".
        function renderGroup(container: HTMLElement, g: FGroup, isRoot: boolean): void {
          g.rules.forEach((node, i) => {
            if (isFGroup(node)) {
              const rowEl = document.createElement('div'); rowEl.className = 'dt-frow dt-fgrouprow';
              rowEl.appendChild(leadCell(g, i));
              const box = document.createElement('div'); box.className = 'dt-fgroupbox';
              renderGroup(box, node, false);
              rowEl.appendChild(box);
              const del = document.createElement('button'); del.className = 'dt-fdel'; del.title = 'Remove group'; del.innerHTML = dtIcon('trash', 13);
              del.addEventListener('click', (e) => { e.stopPropagation(); g.rules.splice(g.rules.indexOf(node), 1); editing = null; redo(); });
              rowEl.appendChild(del);
              container.appendChild(rowEl);
            } else {
              ruleRow(container, g, node, i);
            }
          });
          const addWrap = document.createElement('div'); addWrap.className = 'dt-faddrow';
          const addR = document.createElement('button'); addR.className = 'dt-fadd'; addR.innerHTML = dtIcon('plus', 13) + '<span>Add filter rule</span>';
          addR.addEventListener('click', (e) => { e.stopPropagation(); addRule(g); redo(); });
          addWrap.appendChild(addR);
          if (isRoot) {
            const addG = document.createElement('button'); addG.className = 'dt-fadd dt-faddgroup'; addG.innerHTML = dtIcon('plus', 13) + '<span>Add filter group</span>';
            addG.addEventListener('click', (e) => { e.stopPropagation(); addGroup(g); redo(); });
            addWrap.appendChild(addG);
          }
          container.appendChild(addWrap);
        }
        const draw = () => {
          menu.innerHTML = '';
          const hdr = document.createElement('div'); hdr.className = 'dt-mhdr'; hdr.textContent = 'Filter'; menu.appendChild(hdr);
          if (!filterRoot.rules.length) { const e = document.createElement('div'); e.className = 'dt-mnote'; e.textContent = 'No filters yet.'; menu.appendChild(e); }
          renderGroup(menu, filterRoot, true);
          if (filterRoot.rules.length) {
            const sep = document.createElement('div'); sep.className = 'dt-msep'; menu.appendChild(sep);
            const clr = document.createElement('button'); clr.className = 'dt-fadd dt-fclear'; clr.innerHTML = dtIcon('trash', 13) + '<span>Delete filter</span>';
            clr.addEventListener('click', (e) => { e.stopPropagation(); filterRoot = { conj: 'and', rules: [] }; editing = null; redo(); });
            menu.appendChild(clr);
          }
          place();
        };
        // The list shown when a column / operator / value segment is expanded.
        function subPicker(cond: any, col: DtCol | undefined, field: 'col' | 'op' | 'val', done: () => void): HTMLElement {
          const box = document.createElement('div'); box.className = 'dt-fsub';
          if (field === 'col') {
            for (const c of doc.columns) {
              const r = document.createElement('div'); r.className = 'dt-mrow' + (c.key === cond.col ? ' sel' : '');
              const ic = document.createElement('span'); ic.className = 'dt-mi'; ic.innerHTML = dtTypeIcon(c.type);
              const tx = document.createElement('span'); tx.className = 'dt-mlabel'; tx.textContent = c.name;
              r.append(ic, tx);
              r.addEventListener('mousedown', (e) => { e.preventDefault(); if (c.key !== cond.col) { cond.col = c.key; cond.op = (opsFor(c.type)[0] || ['contains'])[0]; cond.value = ''; } applyView(); done(); });
              box.appendChild(r);
            }
          } else if (field === 'op') {
            for (const [op, label] of opsFor(col ? col.type : 'text')) {
              const r = document.createElement('div'); r.className = 'dt-mrow' + (op === cond.op ? ' sel' : '');
              const tx = document.createElement('span'); tx.className = 'dt-mlabel'; tx.textContent = label;
              r.appendChild(tx);
              r.addEventListener('mousedown', (e) => { e.preventDefault(); cond.op = op; if (opNoValue(op)) cond.value = ''; applyView(); done(); });
              box.appendChild(r);
            }
          } else {
            // value picker for select/multiselect: tag toggles from the column universe
            const multi = col ? opMultiValue(col.type, cond.op) : false;
            const chosen = dtMulti(cond.value || '');
            const single = !multi && col && dtSelectLike(col.type);
            for (const o of (col ? selectUniverse(col) : [])) {
              const on = multi ? chosen.includes(o) : (cond.value || '').trim() === o;
              const r = document.createElement('div'); r.className = 'dt-mrow dt-selopt' + (on ? ' sel' : '');
              const pill = document.createElement('span'); pill.className = 'dt-tag'; pill.style.setProperty('--tag', colorForOption(col!, o));
              const dot = document.createElement('span'); dot.className = 'dt-tag-dot'; const tx = document.createElement('span'); tx.textContent = o;
              pill.append(dot, tx); r.appendChild(pill);
              if (multi && on) { const ck = document.createElement('span'); ck.className = 'dt-selcheck'; ck.innerHTML = dtIcon('check', 14); r.appendChild(ck); }
              r.addEventListener('mousedown', (e) => {
                e.preventDefault();
                if (multi) { const next = on ? chosen.filter((x) => x !== o) : [...chosen, o]; cond.value = dtMultiStr(next); applyView(); draw(); place(); }
                else { cond.value = o; applyView(); done(); }
              });
              box.appendChild(r);
            }
            if (single) { const note = document.createElement('div'); note.className = 'dt-mnote'; note.textContent = 'Pick a value'; if (!col || !selectUniverse(col).length) box.appendChild(note); }
          }
          return box;
        }
        if (!filterRoot.rules.length) addRule(filterRoot);
        draw();
      }
      // Clear the body + render whichever view is active.
      function renderActive() {
        closeMenu();
        // Preserve scroll across re-renders so editing a cell (or adding one)
        // never snaps you back to the top-left.
        const sl = scroll.scrollLeft, st = scroll.scrollTop;
        requestAnimationFrame(() => { scroll.scrollLeft = sl; scroll.scrollTop = st; });
        const kind = (activeView() || ({} as any)).kind || 'table';
        scroll.innerHTML = ''; scroll.className = 'dt-scroll dt-view-' + kind;
        if (kind === 'board') { renderBoard(); return; }
        if (kind === 'gallery') { renderGallery(); return; }
        if (kind === 'list') { renderList(); return; }
        if (kind === 'calendar') { renderCalendar(); return; }
        scroll.appendChild(table); paintHead(); paintBody(); paintFoot();
      }
      function colByKey(k: string): DtCol | undefined { return doc.columns.find((c) => c.key === k); }
      function firstColOfType(t: string): DtCol | undefined { return doc.columns.find((c) => c.type === t); }

      // Type-aware comparison for the active sort column.
      function cmp(a: string, b: string, type: string): number {
        if (type === 'number') {
          const x = parseFloat((a || '').replace(/[,$%]/g, '')), y = parseFloat((b || '').replace(/[,$%]/g, ''));
          const xn = isNaN(x), yn = isNaN(y);
          if (xn && yn) return 0; if (xn) return 1; if (yn) return -1;   // blanks last
          return x - y;
        }
        if (type === 'date') {
          const x = Date.parse(a), y = Date.parse(b);
          const xn = isNaN(x), yn = isNaN(y);
          if (xn && yn) return 0; if (xn) return 1; if (yn) return -1;
          return x - y;
        }
        if (type === 'checkbox') return (dtTruthy(a) ? 1 : 0) - (dtTruthy(b) ? 1 : 0);
        return (a || '').localeCompare(b || '', undefined, { numeric: true, sensitivity: 'base' });
      }
      // ── structured filters (per-column condition builder) ─────────────────
      // Operators available for each column type, as [op, label] pairs.
      function opsFor(type: string): [string, string][] {
        switch (type) {
          case 'number': return [['eq', '='], ['ne', '≠'], ['gt', '>'], ['lt', '<'], ['gte', '≥'], ['lte', '≤'], ['empty', 'is empty'], ['notempty', 'is not empty']];
          case 'date': return [
            ['is', 'is'], ['before', 'is before'], ['after', 'is after'], ['onbefore', 'is on or before'], ['onafter', 'is on or after'],
            // relative ranges (no value needed) — evaluated against "today"
            ['today', 'is today'], ['yesterday', 'is yesterday'], ['tomorrow', 'is tomorrow'],
            ['thisweek', 'is this week'], ['lastweek', 'is last week'], ['nextweek', 'is next week'],
            ['thismonth', 'is this month'], ['past', 'is in the past'], ['future', 'is in the future'],
            ['empty', 'is empty'], ['notempty', 'is not empty'],
          ];
          case 'checkbox': return [['checked', 'is checked'], ['unchecked', 'is unchecked']];
          case 'status':
          case 'select': return [['is', 'is'], ['isnot', 'is not'], ['anyof', 'is any of'], ['empty', 'is empty'], ['notempty', 'is not empty']];
          case 'multiselect': return [['hasany', 'contains'], ['hasnot', 'does not contain'], ['empty', 'is empty'], ['notempty', 'is not empty']];
          default: return [['contains', 'contains'], ['notcontains', 'does not contain'], ['is', 'is'], ['isnot', 'is not'], ['empty', 'is empty'], ['notempty', 'is not empty']];
        }
      }
      const opLabel = (type: string, op: string) => (opsFor(type).find(([o]) => o === op) || [op, op])[1];
      const REL_DATE_OPS = ['today', 'yesterday', 'tomorrow', 'thisweek', 'lastweek', 'nextweek', 'thismonth', 'past', 'future'];
      // Evaluate a relative date operator against "today" (week = Monday-start).
      function matchRelDate(op: string, x: { y: number; m: number; d: number }): boolean {
        const now = new Date();
        const DAY = 86400000;
        const dToday = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
        const dx = Date.UTC(x.y, x.m, x.d);
        const dow = (new Date(dToday).getUTCDay() + 6) % 7;   // 0 = Monday
        const weekStart = dToday - dow * DAY, weekEnd = weekStart + 7 * DAY;
        switch (op) {
          case 'today': return dx === dToday;
          case 'yesterday': return dx === dToday - DAY;
          case 'tomorrow': return dx === dToday + DAY;
          case 'thisweek': return dx >= weekStart && dx < weekEnd;
          case 'lastweek': return dx >= weekStart - 7 * DAY && dx < weekStart;
          case 'nextweek': return dx >= weekEnd && dx < weekEnd + 7 * DAY;
          case 'thismonth': return x.y === now.getFullYear() && x.m === now.getMonth();
          case 'past': return dx < dToday;
          case 'future': return dx > dToday;
        }
        return true;
      }
      const opNoValue = (op: string) => op === 'empty' || op === 'notempty' || op === 'checked' || op === 'unchecked' || REL_DATE_OPS.includes(op);
      // A multi-tag value control (select 'is any of' / multiselect) reuses the JSON
      // array encoding; single-value ops keep a plain string.
      const opMultiValue = (type: string, op: string) => (type === 'multiselect' && (op === 'hasany' || op === 'hasnot')) || (dtSelectLike(type) && op === 'anyof');
      function condMatches(cond: { col: string; op: string; value: string }, row: DtRow): boolean {
        const col = colByKey(cond.col); if (!col) return true;
        const raw = row.cells[cond.col] || ''; const v = raw.trim(); const op = cond.op;
        if (op === 'empty') return !v;
        if (op === 'notempty') return !!v;
        if (col.type === 'checkbox') return op === 'checked' ? dtTruthy(raw) : !dtTruthy(raw);
        if (opNeedsValueButEmpty(cond, col.type)) return true;   // half-built condition: inactive
        if (col.type === 'number') {
          const x = parseFloat(v.replace(/[,$%]/g, '')), y = parseFloat((cond.value || '').replace(/[,$%]/g, ''));
          if (isNaN(x) || isNaN(y)) return false;
          switch (op) { case 'eq': return x === y; case 'ne': return x !== y; case 'gt': return x > y; case 'lt': return x < y; case 'gte': return x >= y; case 'lte': return x <= y; }
          return true;
        }
        if (col.type === 'date') {
          const x = dtParseYMD(v);
          if (REL_DATE_OPS.includes(op)) return x ? matchRelDate(op, x) : false;
          const y = dtParseYMD(cond.value || '');
          if (!x || !y) return false;
          const dx = Date.UTC(x.y, x.m, x.d), dy = Date.UTC(y.y, y.m, y.d);
          switch (op) { case 'is': return dx === dy; case 'before': return dx < dy; case 'after': return dx > dy; case 'onbefore': return dx <= dy; case 'onafter': return dx >= dy; }
          return true;
        }
        if (col.type === 'multiselect') {
          const tags = dtMulti(raw), want = dtMulti(cond.value || '');
          if (!want.length) return true;
          if (op === 'hasany') return want.some((w) => tags.includes(w));
          if (op === 'hasnot') return !want.some((w) => tags.includes(w));
          return true;
        }
        if (dtSelectLike(col.type)) {
          if (op === 'anyof') { const want = dtMulti(cond.value || ''); return !want.length || want.some((w) => w.toLowerCase() === v.toLowerCase()); }
          const val = (cond.value || '').trim().toLowerCase();
          if (op === 'is') return v.toLowerCase() === val;
          if (op === 'isnot') return v.toLowerCase() !== val;
          return true;
        }
        const val = (cond.value || '').trim().toLowerCase(), lv = v.toLowerCase();
        switch (op) { case 'contains': return lv.includes(val); case 'notcontains': return !lv.includes(val); case 'is': return lv === val; case 'isnot': return lv !== val; }
        return true;
      }
      // A value-needing op with no value yet is treated as inactive (Notion does the same).
      function opNeedsValueButEmpty(cond: { op: string; value: string }, type: string): boolean {
        if (opNoValue(cond.op)) return false;
        if (opMultiValue(type, cond.op)) return dtMulti(cond.value || '').length === 0;
        return !(cond.value || '').trim();
      }
      function viewRows() {
        let rows = doc.rows;
        if (filter) rows = rows.filter((r) => doc.columns.some((c) => (r.cells[c.key] || '').toLowerCase().includes(filter)));
        if (hasActiveFilter()) rows = rows.filter((r) => matchGroup(filterRoot, r));
        if (sortKey) {
          const col = colByKey(sortKey); const type = col ? col.type : 'text';
          rows = rows.slice().sort((r1, r2) => sortDir * cmp(r1.cells[sortKey!] || '', r2.cells[sortKey!] || '', type));
        }
        return rows;
      }
      function paintCount() {
        // The footer calc row already shows the total — so the toolbar count only
        // speaks up for a transient state (selection or an active filter).
        const n = viewRows().length, total = doc.rows.length;
        const nRules = countRules(filterRoot);
        if (selected.size) count.textContent = `${selected.size} selected`;
        else if (filter || nRules) count.textContent = `${n} of ${total}`;
        else count.textContent = '';
        funnelBtn.classList.toggle('active', hasActiveFilter());
        funnelBtn.dataset.count = nRules ? String(nRules) : '';
      }

      // ── selection ─────────────────────────────────────────────────────────
      function deleteSelected() {
        const ids = Array.from(selected); if (!ids.length) return;
        closeMenu();
        // Optimistic: drop the rows locally + render now; persist the deletes in
        // the background (temp rows were never saved, so skip them).
        const gone = new Set(ids);
        doc.rows = doc.rows.filter((r) => !gone.has(r.id));
        selected.clear();
        repaint();
        const real = ids.filter((id) => id > 0);
        if (!real.length) return;
        Promise.all(real.map((id) => ipc.tableDeleteRow(path, id)))
          .then((docs) => { if (alive() && docs.length) { doc = docs[docs.length - 1]; repaint(); } })
          .catch(() => { if (alive()) reloadDoc(); });
      }
      function syncSelUi() {
        delSelBtn.style.display = selected.size ? '' : 'none';
        delSelBtn.textContent = `Delete ${selected.size}`;
        paintCount();
      }

      // ── sort menu (icon-driven) ───────────────────────────────────────────
      function openSortMenu(anchor: HTMLElement) {
        closeMenu();
        const menu = document.createElement('div'); menu.className = 'dt-menu dt-sortmenu';
        const hdr = document.createElement('div'); hdr.className = 'dt-mhdr'; hdr.textContent = 'Sort by'; menu.appendChild(hdr);
        for (const col of doc.columns) {
          const r = document.createElement('div'); r.className = 'dt-mrow' + (sortKey === col.key ? ' sel' : '');
          const ic = document.createElement('span'); ic.className = 'dt-mi';
          ic.innerHTML = sortKey === col.key ? dtIcon(sortDir === 1 ? 'arrowUp' : 'arrowDown', 13) : (dtTypeIcon(col.type) || dtSvg(DT_ICONS.sort, 13));
          const tx = document.createElement('span'); tx.className = 'dt-mlabel'; tx.textContent = col.name;
          r.append(ic, tx);
          r.addEventListener('mousedown', (e) => {
            e.preventDefault();
            if (sortKey === col.key) sortDir = sortDir === 1 ? -1 : 1; else { sortKey = col.key; sortDir = 1; }
            closeMenu(); applyView();
          });
          menu.appendChild(r);
        }
        if (sortKey) {
          const sep = document.createElement('div'); sep.className = 'dt-msep'; menu.appendChild(sep);
          const clr = document.createElement('div'); clr.className = 'dt-mrow';
          const ic = document.createElement('span'); ic.className = 'dt-mi'; ic.innerHTML = dtIcon('x', 13);
          const tx = document.createElement('span'); tx.className = 'dt-mlabel'; tx.textContent = 'Clear sort';
          clr.append(ic, tx);
          clr.addEventListener('mousedown', (e) => { e.preventDefault(); sortKey = null; closeMenu(); applyView(); });
          menu.appendChild(clr);
        }
        anchorMenu(menu, anchor);
      }

      // ── "New ▾" menu (row / column) ───────────────────────────────────────
      function openNewMenu(anchor: HTMLElement) {
        closeMenu();
        const menu = document.createElement('div'); menu.className = 'dt-menu';
        menu.appendChild(menuRow('New row', 'plus', () => { closeMenu(); addRowWith(); }));
        menu.appendChild(menuRow('New column', 'plus', () => { closeMenu(); openNewColumnMenu(anchor); }, 'dt-addcol'));
        anchorMenu(menu, anchor);
      }

      // ── table actions menu (⋯) ────────────────────────────────────────────
      function openTableMenu(anchor: HTMLElement) {
        closeMenu();
        const menu = document.createElement('div'); menu.className = 'dt-menu';
        menu.appendChild(menuRow('Export CSV', 'funnel', () => {
          closeMenu();
          ipc.tableExportCsv(path).then((csv: string) => {
            try { updateStatus('Exported ' + (csv.split('/').pop() || 'csv'), 2600); } catch {}
          }).catch(() => {});
        }));
        anchorMenu(menu, anchor);
      }

      // A menu row with a leading line-icon (Notion-style). icon = DT_ICONS key.
      function menuRow(label: string, icon: string, fn: () => void, cls = ''): HTMLElement {
        const r = document.createElement('div'); r.className = 'dt-mrow' + (cls ? ' ' + cls : '');
        const ic = document.createElement('span'); ic.className = 'dt-mi'; ic.innerHTML = icon ? dtIcon(icon, 14) : '';
        const tx = document.createElement('span'); tx.className = 'dt-mlabel'; tx.textContent = label;
        r.append(ic, tx);
        r.addEventListener('mousedown', (e) => { e.preventDefault(); fn(); });
        return r;
      }

      // ── popover plumbing (single open menu at a time) ─────────────────────
      function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; document.removeEventListener('mousedown', onDocDown, true); } }
      function onDocDown(e: MouseEvent) { if (openMenu && !openMenu.contains(e.target as Node)) closeMenu(); }
      // Position a freshly-built menu under an anchor, clamped to the viewport.
      function anchorMenu(menu: HTMLElement, anchor: HTMLElement) {
        document.body.appendChild(menu);
        const r = anchor.getBoundingClientRect();
        const w = menu.offsetWidth || 200, h = menu.offsetHeight || 0;
        let left = r.left; if (left + w > window.innerWidth - 8) left = Math.max(8, r.right - w);
        let top = r.bottom + 4; if (h && top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
        menu.style.left = Math.round(left) + 'px';
        menu.style.top = Math.round(top) + 'px';
        openMenu = menu;
        setTimeout(() => document.addEventListener('mousedown', onDocDown, true), 0);
      }
      function openColMenu(anchor: HTMLElement, col: DtCol) {
        closeMenu();
        const menu = document.createElement('div'); menu.className = 'dt-menu';
        menu.appendChild(menuRow('Sort ascending', 'arrowUp', () => { sortKey = col.key; sortDir = 1; closeMenu(); applyView(); }, sortKey === col.key && sortDir === 1 ? 'sel' : ''));
        menu.appendChild(menuRow('Sort descending', 'arrowDown', () => { sortKey = col.key; sortDir = -1; closeMenu(); applyView(); }, sortKey === col.key && sortDir === -1 ? 'sel' : ''));
        menu.appendChild(menuRow('Rename', 'pencil', () => { closeMenu(); beginRenameHeader(col); }));
        const typeHdr = document.createElement('div'); typeHdr.className = 'dt-mhdr'; typeHdr.textContent = 'Type'; menu.appendChild(typeHdr);
        for (const [t, , label] of DT_TYPES) {
          const r = document.createElement('div'); r.className = 'dt-mrow' + (col.type === t ? ' sel' : '');
          const ic = document.createElement('span'); ic.className = 'dt-mi'; ic.innerHTML = dtTypeIcon(t) || dtSvg('<path d="M4 7h16M4 12h16M4 17h10"/>', 14);
          const tx = document.createElement('span'); tx.className = 'dt-mlabel'; tx.textContent = label;
          r.append(ic, tx);
          r.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const opts = dtOptionType(t)
              ? Array.from(new Set(doc.rows.flatMap((rr) => {
                  const raw = rr.cells[col.key] || '';
                  return col.type === 'multiselect' ? dtMulti(raw) : raw.split(',').map((s) => s.trim());
                }).filter(Boolean)))
              : undefined;
            mutate(() => ipc.tableRetypeColumn(path, col.key, t, opts));
          });
          menu.appendChild(r);
        }
        if (col.type === 'number') {
          const fh = document.createElement('div'); fh.className = 'dt-mhdr'; fh.textContent = 'Number format'; menu.appendChild(fh);
          for (const [fmt, label] of DT_NUMFMT) {
            const cur = col.format || 'plain';
            menu.appendChild(menuRow(label, '', () => { closeMenu(); col.format = fmt as any; renderActive(); bgWrite(() => ipc.tableSetColumnFormat(path, col.key, fmt as any)); }, cur === fmt ? 'sel' : ''));
          }
        }
        if (dtOptionType(col.type)) {
          menu.appendChild(menuRow('Edit options', 'dots', () => { closeMenu(); openOptionManager(anchor, col); }));
        }
        const sep = document.createElement('div'); sep.className = 'dt-msep'; menu.appendChild(sep);
        menu.appendChild(menuRow('Insert left', 'insLeft', () => { closeMenu(); insertColumn(col.key, 'left'); }));
        menu.appendChild(menuRow('Insert right', 'insRight', () => { closeMenu(); insertColumn(col.key, 'right'); }));
        menu.appendChild(menuRow('Duplicate', 'copy', () => mutate(() => ipc.tableDuplicateColumn(path, col.key))));
        const sep2 = document.createElement('div'); sep2.className = 'dt-msep'; menu.appendChild(sep2);
        menu.appendChild(menuRow('Delete column', 'trash', () => mutate(() => ipc.tableDeleteColumn(path, col.key)), 'danger'));
        anchorMenu(menu, anchor);
      }
      // Scroll a freshly-added column into view and drop straight into its inline
      // rename — so a new column stays put under the cursor instead of bouncing to
      // the front and losing your place.
      function focusNewColumn(newKey: string) {
        const th = thead.querySelector<HTMLElement>(`th[data-key="${newKey}"]`);
        if (!th) return;
        th.scrollIntoView({ inline: 'nearest', block: 'nearest' });
        const col = colByKey(newKey); if (col) beginRenameHeader(col);
      }
      // Create a column with a chosen name + type in one step (optimistic). A
      // Status column seeds the three Notion buckets (To-do / In progress / Done).
      function addColumnTyped(name: string, type: import('./ipc').TableColType) {
        const nm = (name || '').trim() || 'Column';
        const seedStatus = type === 'status';
        const options = seedStatus ? STATUS_SEED.map((s) => s.value) : [];
        const optionMeta = seedStatus
          ? Object.fromEntries(STATUS_SEED.map((s) => [s.value, { color: s.color, group: s.group }]))
          : undefined;
        const existing = doc.columns.map((c) => c.key).filter((k) => !k.startsWith('tmp'));
        doc.columns.push({ key: 'tmp' + (nextTemp--), name: nm, type, options, format: 'plain', optionMeta });
        repaint();
        bgWrite(() => ipc.tableAddColumn(path, nm, type, options), (d) => {
          doc = d;
          const newKey = seedStatus ? d.columns.map((c) => c.key).find((k) => !existing.includes(k)) : undefined;
          if (newKey) {
            bgWrite(
              () => ipc.tableSetOptions(path, newKey, STATUS_SEED.map((s) => ({ value: s.value, color: s.color, group: s.group }))),
              (d2) => { doc = d2; repaint(); },
            );
          } else {
            repaint();
          }
        });
      }
      // The "new column" flow: name it AND pick its type up front — no need to add
      // then dig into the ⋮ menu to retype it.
      function openNewColumnMenu(anchor: HTMLElement) {
        closeMenu();
        const menu = document.createElement('div'); menu.className = 'dt-menu dt-newcolmenu';
        const inp = document.createElement('input'); inp.className = 'dt-rename dt-newcolname'; inp.placeholder = 'Property name';
        const create = (t: import('./ipc').TableColType) => { closeMenu(); addColumnTyped(inp.value, t); };
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create('text'); } else if (e.key === 'Escape') closeMenu(); });
        inp.addEventListener('click', (e) => e.stopPropagation());
        menu.appendChild(inp);
        const hdr = document.createElement('div'); hdr.className = 'dt-mhdr'; hdr.textContent = 'Type'; menu.appendChild(hdr);
        for (const [t, , label] of DT_TYPES) {
          const r = document.createElement('div'); r.className = 'dt-mrow';
          const ic = document.createElement('span'); ic.className = 'dt-mi'; ic.innerHTML = dtTypeIcon(t);
          const tx = document.createElement('span'); tx.className = 'dt-mlabel'; tx.textContent = label;
          r.append(ic, tx);
          r.addEventListener('mousedown', (e) => { e.preventDefault(); create(t); });
          menu.appendChild(r);
        }
        anchorMenu(menu, anchor);
        setTimeout(() => inp.focus(), 0);
      }
      // Move a column so it lands where another one is (drag-to-reorder).
      function reorderColTo(src: string, dst: string) {
        const keys = doc.columns.map((c) => c.key);
        const from = keys.indexOf(src); if (from < 0) return;
        keys.splice(from, 1);
        let to = keys.indexOf(dst); if (to < 0) to = keys.length;
        keys.splice(to, 0, src);
        // optimistic: reorder the local columns to match, render now, persist async
        const byKey: Record<string, DtCol> = {}; doc.columns.forEach((c) => { byKey[c.key] = c; });
        doc.columns = keys.map((k) => byKey[k]).filter(Boolean);
        repaint();
        bgWrite(() => ipc.tableReorderColumns(path, keys));
      }
      // Add a new column immediately left/right of a reference column (uses the
      // existing add + reorder verbs — no special backend position param needed).
      async function insertColumn(refKey: string, side: 'left' | 'right') {
        closeMenu();
        try {
          const before = doc.columns.map((c) => c.key);
          const d1 = await ipc.tableAddColumn(path, '', 'text');
          if (!alive()) return;
          const newKey = d1.columns.map((c) => c.key).find((k) => !before.includes(k));
          if (!newKey) { doc = d1; repaint(); return; }
          const order = d1.columns.map((c) => c.key).filter((k) => k !== newKey);
          let at = order.indexOf(refKey); if (at < 0) at = order.length; if (side === 'right') at += 1;
          order.splice(at, 0, newKey);
          const d2 = await ipc.tableReorderColumns(path, order);
          if (!alive()) return;
          doc = d2; repaint();
          focusNewColumn(newKey);
        } catch (e) { /* leave as-is */ }
      }
      function beginRenameHeader(col: DtCol) {
        const th = thead.querySelector<HTMLElement>(`th[data-key="${col.key}"]`); if (!th) return;
        const input = document.createElement('input'); input.className = 'dt-rename'; input.value = col.name;
        const label = th.querySelector('.dt-hname'); if (label) (label as HTMLElement).replaceWith(input);
        input.focus(); input.select();
        const commit = () => {
          const v = input.value.trim();
          if (v && v !== col.name) { col.name = v; repaint(); bgWrite(() => ipc.tableRenameColumn(path, col.key, v)); }   // optimistic
          else paintHead();
        };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') paintHead(); });
        input.addEventListener('blur', commit);
      }

      // A styled checkbox (box + check / dash) matching the reference feel.
      function mkCheck(checked: boolean, mixed: boolean, onToggle: () => void, label: string): HTMLElement {
        const CHECK = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg>';
        const wrap = document.createElement('label'); wrap.className = 'dt-check'; wrap.title = label;
        const input = document.createElement('input'); input.type = 'checkbox'; input.checked = checked; input.setAttribute('aria-label', label);
        const box = document.createElement('span'); box.className = 'dt-check-box';
        // Reflect the input's state into the visible box — so a click fills the
        // check immediately (the box is a real element, not the hidden input).
        const paint = () => {
          box.classList.toggle('on', input.checked || mixed);
          box.innerHTML = mixed ? '<span class="dt-check-dash"></span>' : (input.checked ? CHECK : '');
        };
        paint();
        input.addEventListener('change', (e) => { e.stopPropagation(); mixed = false; paint(); onToggle(); });
        wrap.addEventListener('click', (e) => e.stopPropagation());
        wrap.append(input, box);
        return wrap;
      }

      function paintHead() {
        const tr = document.createElement('tr');
        const rows = viewRows();
        const allSel = rows.length > 0 && rows.every((r) => selected.has(r.id));
        const someSel = !allSel && rows.some((r) => selected.has(r.id));
        // Left lane header = select-all (rows are added by the "+ New" footer row).
        const selTh = document.createElement('th'); selTh.className = 'dt-selcell';
        selTh.appendChild(mkCheck(allSel, someSel, () => {
          // Recompute freshly at click-time — the captured `allSel` goes stale
          // after the first toggle (the header isn't rebuilt on every change),
          // which desynced the box from the rows. Repaint the head so the next
          // click sees correct state too.
          const nowAll = rows.length > 0 && rows.every((r) => selected.has(r.id));
          if (nowAll) rows.forEach((r) => selected.delete(r.id));
          else rows.forEach((r) => selected.add(r.id));
          paintHead(); paintBody(); syncSelUi();
        }, 'Select all'));
        tr.appendChild(selTh);
        shownCols().forEach((col, idx) => {
          const th = document.createElement('th'); th.className = 'dt-th' + (idx === 0 ? ' dt-primary' : ''); th.dataset.key = col.key;
          const sorted = sortKey === col.key;
          const name = document.createElement('span'); name.className = 'dt-hname';
          const ic = dtTypeIcon(col.type);
          if (ic) { const g = document.createElement('span'); g.className = 'dt-hicon'; g.innerHTML = ic; name.appendChild(g); }
          const tEl = document.createElement('span'); tEl.className = 'dt-htext'; tEl.textContent = col.name;
          const sEl = document.createElement('span'); sEl.className = 'dt-sort' + (sorted ? ' on' : '');
          sEl.innerHTML = sorted ? dtIcon(sortDir === 1 ? 'arrowUp' : 'arrowDown', 12) : '';
          name.append(tEl, sEl);
          name.addEventListener('click', () => {
            if (sortKey === col.key) { if (sortDir === 1) sortDir = -1; else { sortKey = null; } }
            else { sortKey = col.key; sortDir = 1; }
            applyView();
          });
          const kebab = document.createElement('button'); kebab.className = 'dt-kebab'; kebab.innerHTML = dtIcon('dots', 15);
          kebab.title = 'Column options';
          kebab.addEventListener('click', (e) => { e.stopPropagation(); openColMenu(kebab, col); });
          th.append(name, kebab);
          // drag a header to reorder columns (distinct dataTransfer type so it
          // never collides with row/card drags which use text/plain)
          th.draggable = true;
          th.addEventListener('dragstart', (e) => { e.dataTransfer!.setData('text/dt-col', col.key); e.dataTransfer!.effectAllowed = 'move'; th.classList.add('col-dragging'); });
          th.addEventListener('dragend', () => { th.classList.remove('col-dragging'); thead.querySelectorAll('.col-over').forEach((x) => x.classList.remove('col-over')); });
          th.addEventListener('dragover', (e) => { if (e.dataTransfer!.types.includes('text/dt-col')) { e.preventDefault(); th.classList.add('col-over'); } });
          th.addEventListener('dragleave', () => th.classList.remove('col-over'));
          th.addEventListener('drop', (e) => {
            if (!e.dataTransfer!.types.includes('text/dt-col')) return;
            e.preventDefault(); th.classList.remove('col-over');
            const src = e.dataTransfer!.getData('text/dt-col');
            if (src && src !== col.key) reorderColTo(src, col.key);
          });
          tr.appendChild(th);
        });
        // endcap absorbs slack AND carries the + to add a column, on the table itself
        const cap = document.createElement('th'); cap.className = 'dt-endcap dt-endcap-h';
        const addcol = document.createElement('button'); addcol.className = 'dt-addcolhdr'; addcol.title = 'Add column'; addcol.innerHTML = dtIcon('plus', 16);
        addcol.addEventListener('click', (e) => { e.stopPropagation(); openNewColumnMenu(addcol); });
        cap.appendChild(addcol);
        tr.appendChild(cap);
        thead.innerHTML = ''; thead.appendChild(tr);
      }

      // A themed option picker for select cells (replaces the native <select>).
      // Every value ever used in a select/multiselect column, unioned with the
      // column's saved options — so the dropdown always offers the full set, not
      // just this row's current value.
      function selectUniverse(col: DtCol): string[] {
        const seen = new Set<string>(); const out: string[] = [];
        const add = (v: string) => { const t = v.trim(); if (t && !seen.has(t)) { seen.add(t); out.push(t); } };
        for (const o of col.options) add(o);
        for (const r of doc.rows) {
          const raw = r.cells[col.key] || '';
          if (col.type === 'multiselect') dtMulti(raw).forEach(add); else add(raw);
        }
        return out;
      }
      // ── option metadata editing (color / group / order / rename / delete) ──
      type DtOpt = { value: string; color?: string; group?: DtOptGroup };
      // The column's options as an ordered list carrying each option's color+group.
      function optionList(col: DtCol): DtOpt[] {
        return col.options.map((v) => ({ value: v, color: col.optionMeta?.[v]?.color, group: col.optionMeta?.[v]?.group as DtOptGroup | undefined }));
      }
      // Persist a whole edited option list (reorder/recolor/regroup/add/delete) —
      // optimistic: update the local doc + render now, save in the background. Any
      // value dropped from the list is cleared from cells (mirror the backend).
      function applyOptions(col: DtCol, list: DtOpt[]) {
        const values: string[] = [];
        const meta: Record<string, { color?: string; group?: DtOptGroup }> = {};
        for (const o of list) {
          const v = o.value.trim(); if (!v || values.includes(v)) continue;
          values.push(v);
          if (o.color || o.group) { const m: any = {}; if (o.color) m.color = o.color; if (o.group) m.group = o.group; meta[v] = m; }
        }
        const keep = new Set(values);
        col.options = values; col.optionMeta = meta;
        const multi = col.type === 'multiselect';
        for (const r of doc.rows) {
          const raw = r.cells[col.key]; if (!raw) continue;
          if (multi) { const kept = dtMulti(raw).filter((v) => keep.has(v)); r.cells[col.key] = kept.length ? dtMultiStr(kept) : ''; }
          else if (!keep.has(raw.trim())) r.cells[col.key] = '';
        }
        renderActive();
        bgWrite(() => ipc.tableSetOptions(path, col.key, list.map((o) => ({ value: o.value, color: o.color ?? null, group: o.group ?? null }))), (d) => { doc = d; repaint(); });
      }
      const editOptions = (col: DtCol, fn: (list: DtOpt[]) => void) => { const list = optionList(col); fn(list); applyOptions(col, list); };
      const setOptionColor = (col: DtCol, value: string, color: string) => editOptions(col, (l) => { const it = l.find((o) => o.value === value); if (it) it.color = color; });
      const setOptionGroup = (col: DtCol, value: string, group: DtOptGroup) => editOptions(col, (l) => { const it = l.find((o) => o.value === value); if (it) it.group = group; });
      const moveOption = (col: DtCol, value: string, dir: number) => editOptions(col, (l) => { const i = l.findIndex((o) => o.value === value); const j = i + dir; if (i >= 0 && j >= 0 && j < l.length) { const t = l[i]; l[i] = l[j]; l[j] = t; } });
      const deleteOption = (col: DtCol, value: string) => editOptions(col, (l) => { const i = l.findIndex((o) => o.value === value); if (i >= 0) l.splice(i, 1); });
      const addOption = (col: DtCol, value: string) => editOptions(col, (l) => { if (!l.some((o) => o.value === value)) l.push({ value, color: col.type === 'status' ? STATUS_GROUPS[0][2] : dtHueFor(value), group: col.type === 'status' ? 'todo' : undefined }); });
      // Rename goes through the dedicated verb (a bare list can't express old→new;
      // applyOptions would treat it as delete+add and wipe the cells). Optimistic.
      function renameOption(col: DtCol, from: string, to: string) {
        to = to.trim(); if (!to || to === from) return;
        const i = col.options.indexOf(from); if (i >= 0) col.options[i] = to;
        col.options = col.options.filter((v, idx) => col.options.indexOf(v) === idx);
        if (col.optionMeta && col.optionMeta[from]) { col.optionMeta[to] = col.optionMeta[from]; delete col.optionMeta[from]; }
        const multi = col.type === 'multiselect';
        for (const r of doc.rows) {
          const raw = r.cells[col.key]; if (!raw) continue;
          if (multi) { const arr = dtMulti(raw).map((v) => (v === from ? to : v)); r.cells[col.key] = dtMultiStr(Array.from(new Set(arr))); }
          else if (raw.trim() === from) r.cells[col.key] = to;
        }
        renderActive();
        bgWrite(() => ipc.tableRenameOption(path, col.key, from, to), (d) => { doc = d; repaint(); });
      }
      // Move an option so it lands right before `beforeVal` (or at the end when
      // null), optionally re-bucketing it (status drag between group sections).
      const dropOption = (col: DtCol, value: string, beforeVal: string | null, group?: DtOptGroup) => editOptions(col, (l) => {
        const i = l.findIndex((o) => o.value === value); if (i < 0) return;
        const [it] = l.splice(i, 1);
        if (group) it.group = group;
        let idx = beforeVal ? l.findIndex((o) => o.value === beforeVal) : l.length; if (idx < 0) idx = l.length;
        l.splice(idx, 0, it);
      });
      // Notion's named color list (swatch + name + check on the current one). Reused
      // by the option editor AND the board-group recolor menu.
      function colorListEl(cur: string, onPick: (hex: string) => void): HTMLElement {
        const wrap = document.createElement('div'); wrap.className = 'dt-collist';
        const hdr = document.createElement('div'); hdr.className = 'dt-mhdr'; hdr.textContent = 'Colors'; wrap.appendChild(hdr);
        for (const [name, hex] of DT_PALETTE) {
          const r = document.createElement('div'); r.className = 'dt-mrow dt-colrow';
          const sw = document.createElement('span'); sw.className = 'dt-colsw'; sw.style.background = hex;
          const nm = document.createElement('span'); nm.className = 'dt-mlabel'; nm.textContent = name;
          r.append(sw, nm);
          if (hex.toLowerCase() === (cur || '').toLowerCase()) { const ck = document.createElement('span'); ck.className = 'dt-selcheck'; ck.innerHTML = dtIcon('check', 14); r.appendChild(ck); }
          r.addEventListener('mousedown', (e) => { e.preventDefault(); onPick(hex); });
          wrap.appendChild(r);
        }
        return wrap;
      }
      const dtGripSvg = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';
      // The option manager — Notion's two-screen model: a LIST screen (drag handle +
      // pill + ⋯) and a per-option EDITOR screen (rename + Delete + named Colors +,
      // for status, Group). A sticky pop (survives the grid re-render each edit does).
      function openOptionManager(anchor: HTMLElement, col: DtCol, startEdit?: string) {
        const { menu, place } = openStickyPop(anchor, 'dt-optmgr');
        const isStatus = col.type === 'status';
        let editing: string | null = startEdit || null;
        let redraw = () => {};

        // ── per-option editor screen ──────────────────────────────────────
        const drawEditor = (val: string) => {
          menu.innerHTML = '';
          const back = document.createElement('div'); back.className = 'dt-mrow dt-optback';
          back.innerHTML = `<span class="dt-mi">${dtIcon('chevL', 14)}</span><span class="dt-mlabel">Edit options</span>`;
          back.addEventListener('mousedown', (e) => { e.preventDefault(); editing = null; redraw(); });
          menu.appendChild(back);
          const name = document.createElement('input'); name.className = 'dt-rename dt-opteditname'; name.value = val;
          name.addEventListener('mousedown', (e) => e.stopPropagation());
          const commit = () => { const v = name.value.trim(); if (v && v !== val) { renameOption(col, val, v); editing = v; } };
          name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); redraw(); } else if (e.key === 'Escape') { editing = null; redraw(); } });
          name.addEventListener('blur', commit);
          menu.appendChild(name);
          const del = document.createElement('div'); del.className = 'dt-mrow danger';
          del.innerHTML = `<span class="dt-mi">${dtIcon('trash', 14)}</span><span class="dt-mlabel">Delete</span>`;
          del.addEventListener('mousedown', (e) => { e.preventDefault(); deleteOption(col, val); editing = null; redraw(); });
          menu.appendChild(del);
          if (isStatus) {
            const gsep = document.createElement('div'); gsep.className = 'dt-mhdr'; gsep.textContent = 'Group'; menu.appendChild(gsep);
            for (const [g, label] of STATUS_GROUPS) {
              const r = document.createElement('div'); r.className = 'dt-mrow dt-colrow';
              const nm = document.createElement('span'); nm.className = 'dt-mlabel'; nm.textContent = label; r.appendChild(nm);
              if (groupForOption(col, val) === g) { const ck = document.createElement('span'); ck.className = 'dt-selcheck'; ck.innerHTML = dtIcon('check', 14); r.appendChild(ck); }
              r.addEventListener('mousedown', (e) => { e.preventDefault(); setOptionGroup(col, val, g); redraw(); });
              menu.appendChild(r);
            }
          }
          menu.appendChild(colorListEl(colorForOption(col, val), (hex) => { setOptionColor(col, val, hex); redraw(); }));
          place();
          setTimeout(() => name.focus(), 0);
        };

        // ── drag-to-reorder (pointer based; HTML5 dnd is dead in this WKWebView) ──
        let drag: null | { val: string; line: HTMLElement } = null;
        const onDragMove = (e: MouseEvent) => {
          if (!drag) return;
          const rowEl = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('.dt-optrow') as HTMLElement | null;
          if (!rowEl || !menu.contains(rowEl)) return;
          const rect = rowEl.getBoundingClientRect();
          const after = e.clientY > rect.top + rect.height / 2;
          drag.line.remove();
          rowEl.parentElement!.insertBefore(drag.line, after ? rowEl.nextSibling : rowEl);
          drag.line.dataset.before = after ? (rowEl.nextElementSibling?.dataset.val ?? '') : (rowEl.dataset.val ?? '');
          drag.line.dataset.group = rowEl.dataset.group || '';
        };
        const onDragUp = () => {
          if (!drag) return;
          document.removeEventListener('mousemove', onDragMove, true);
          document.removeEventListener('mouseup', onDragUp, true);
          const beforeVal = drag.line.dataset.before || null;
          const grp = (isStatus ? (drag.line.dataset.group as DtOptGroup) : undefined) || undefined;
          const val = drag.val; drag.line.remove(); drag = null;
          if (beforeVal !== val) dropOption(col, val, beforeVal === '' ? null : beforeVal, grp);
          redraw();
        };

        // ── list screen ───────────────────────────────────────────────────
        const renderRow = (o: string) => {
          const row = document.createElement('div'); row.className = 'dt-optrow'; row.dataset.val = o;
          if (isStatus) row.dataset.group = groupForOption(col, o);
          const grip = document.createElement('span'); grip.className = 'dt-optgrip'; grip.title = 'Drag to reorder'; grip.innerHTML = dtGripSvg;
          grip.addEventListener('mousedown', (e) => {
            e.preventDefault(); e.stopPropagation();
            const line = document.createElement('div'); line.className = 'dt-dropline';
            drag = { val: o, line };
            document.addEventListener('mousemove', onDragMove, true);
            document.addEventListener('mouseup', onDragUp, true);
          });
          const pill = document.createElement('span'); pill.className = 'dt-tag'; pill.style.setProperty('--tag', colorForOption(col, o));
          pill.innerHTML = '<span class="dt-tag-dot"></span>'; const tx = document.createElement('span'); tx.textContent = o; pill.appendChild(tx);
          const more = document.createElement('button'); more.className = 'dt-optmore'; more.title = 'Edit'; more.innerHTML = dtIcon('dots', 15);
          more.addEventListener('mousedown', (e) => { e.preventDefault(); editing = o; redraw(); });
          row.append(grip, pill, more);
          row.addEventListener('mousedown', (e) => { if ((e.target as HTMLElement).closest('.dt-optgrip, .dt-optmore')) return; e.preventDefault(); editing = o; redraw(); });
          return row;
        };
        const drawList = () => {
          menu.innerHTML = '';
          const title = document.createElement('div'); title.className = 'dt-mhdr'; title.textContent = 'Edit options'; menu.appendChild(title);
          const list = document.createElement('div'); list.className = 'dt-optlist'; menu.appendChild(list);
          if (isStatus) {
            for (const [g, label] of STATUS_GROUPS) {
              const gh = document.createElement('div'); gh.className = 'dt-optgrp'; gh.textContent = label; list.appendChild(gh);
              col.options.filter((o) => groupForOption(col, o) === g).forEach((o) => list.appendChild(renderRow(o)));
            }
          } else {
            col.options.forEach((o) => list.appendChild(renderRow(o)));
          }
          const add = document.createElement('input'); add.className = 'dt-rename dt-optadd'; add.placeholder = 'Add an option…';
          add.addEventListener('mousedown', (e) => e.stopPropagation());
          add.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = add.value.trim(); if (v && !col.options.includes(v)) { addOption(col, v); } redraw(); } });
          menu.appendChild(add);
          place();
        };

        redraw = () => { if (editing != null && col.options.includes(editing)) drawEditor(editing); else { editing = null; drawList(); } };
        redraw();
      }

      function openSelectPop(anchor: HTMLElement, row: DtRow, col: DtCol, cur: string) {
        closeMenu(); if (closeSelPop) closeSelPop();
        const multi = col.type === 'multiselect';
        const menu = document.createElement('div'); menu.className = 'dt-menu dt-selectpop';
        // This popover must survive grid re-renders (multiselect toggles keep it
        // open while the table updates behind it), so it lives OUTSIDE the shared
        // openMenu slot that mutate()/renderActive() tear down. It manages its own
        // outside-click + Escape lifecycle instead.
        let onDown: ((e: MouseEvent) => void) | null = null;
        const closeSelf = () => {
          menu.remove();
          if (onDown) document.removeEventListener('mousedown', onDown, true);
          if (closeSelPop === closeSelf) closeSelPop = null;
        };
        closeSelPop = closeSelf;
        let filterText = '';
        // multiselect keeps a live working set (mutate is async — reading row.cells
        // back would be stale), select commits on click.
        let working = multi ? dtMulti(cur) : [];
        const commit = (v: string) => setCell(row.id, col, v);
        const draw = () => {
          menu.innerHTML = '';
          const selectedNow = working;
          const q = filterText.trim().toLowerCase();
          const opts = selectUniverse(col).filter((o) => !q || o.toLowerCase().includes(q));
          // clear row (single-select only; multiselect clears via unchecking)
          if (!multi) {
            const clr = document.createElement('div'); clr.className = 'dt-mrow dt-selopt' + (cur ? '' : ' sel');
            clr.innerHTML = '<span class="dt-dash">—</span><span class="dt-selclear">Clear</span>';
            clr.addEventListener('mousedown', (e) => { e.preventDefault(); closeSelf(); if (cur) commit(''); });
            menu.appendChild(clr);
          }
          for (const o of opts) {
            const on = multi ? selectedNow.includes(o) : o === cur;
            const r = document.createElement('div'); r.className = 'dt-mrow dt-selopt' + (on ? ' sel' : '');
            const pill = document.createElement('span'); pill.className = 'dt-tag'; pill.style.setProperty('--tag', colorForOption(col, o));
            const dot = document.createElement('span'); dot.className = 'dt-tag-dot';
            const tx = document.createElement('span'); tx.textContent = o;
            pill.append(dot, tx); r.appendChild(pill);
            // right-aligned cluster: the selected check (multi) + a hover ⋯ that
            // opens this option's editor (rename / color / delete), Notion-style.
            const right = document.createElement('span'); right.className = 'dt-seloptright';
            if (multi && on) { const ck = document.createElement('span'); ck.className = 'dt-selcheck'; ck.innerHTML = dtIcon('check', 14); right.appendChild(ck); }
            const more = document.createElement('button'); more.className = 'dt-optmore'; more.title = 'Edit option'; more.innerHTML = dtIcon('dots', 15);
            more.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); closeSelf(); openOptionManager(anchor, col, o); });
            right.appendChild(more); r.appendChild(right);
            r.addEventListener('mousedown', (e) => {
              e.preventDefault();
              if (multi) {
                working = on ? working.filter((x) => x !== o) : [...working, o];
                commit(dtMultiStr(working));   // re-renders grid; popover stays open, redrawn below
                filterText = ''; draw();
              } else { closeSelf(); if (o !== cur) commit(o); }
            });
            menu.appendChild(r);
          }
          if (!opts.length) { const e = document.createElement('div'); e.className = 'dt-mnote'; e.textContent = q ? `Create “${filterText.trim()}”` : 'No options yet'; menu.appendChild(e); }
          const sep = document.createElement('div'); sep.className = 'dt-mhdr'; menu.appendChild(sep);
          const inp = document.createElement('input'); inp.className = 'dt-rename dt-seladd'; inp.placeholder = multi ? 'Add a tag…' : 'Add value…'; inp.value = filterText;
          inp.addEventListener('input', () => { filterText = inp.value; });
          inp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault(); const v = inp.value.trim(); if (!v) return;
              if (multi) { if (!working.includes(v)) { working = [...working, v]; commit(dtMultiStr(working)); } filterText = ''; draw(); }
              else { closeSelf(); if (v !== cur) commit(v); }
            } else if (e.key === 'Escape') closeSelf();
          });
          menu.appendChild(inp);
          // footer: jump to the full option manager (rename / recolor / reorder / delete)
          const mgr = document.createElement('div'); mgr.className = 'dt-mrow dt-selmanage';
          mgr.innerHTML = `<span class="dt-mi">${dtIcon('dots', 14)}</span><span class="dt-mlabel">Edit options…</span>`;
          mgr.addEventListener('mousedown', (e) => { e.preventDefault(); closeSelf(); openOptionManager(anchor, col); });
          menu.appendChild(mgr);
          setTimeout(() => inp.focus(), 0);
        };
        // Position once off the anchor's current rect, then keep it fixed — the
        // grid re-renders under it during multiselect edits, so we can't re-read
        // the (now-detached) anchor each redraw.
        document.body.appendChild(menu);
        const rect = anchor.getBoundingClientRect();
        draw();
        const w = menu.offsetWidth || 220, h = menu.offsetHeight || 0;
        let left = rect.left; if (left + w > window.innerWidth - 8) left = Math.max(8, rect.right - w);
        let top = rect.bottom + 4; if (h && top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 4);
        menu.style.left = Math.round(left) + 'px'; menu.style.top = Math.round(top) + 'px';
        onDown = (e: MouseEvent) => { if (!menu.contains(e.target as Node)) closeSelf(); };
        setTimeout(() => document.addEventListener('mousedown', onDown!, true), 0);
      }

      // A themed month calendar for date cells (replaces the OS date picker).
      function openDatePop(anchor: HTMLElement, row: DtRow, col: DtCol, cur: string) {
        closeMenu();
        const set = (v: string) => { closeMenu(); if (v !== cur) setCell(row.id, col, v); };
        const today = dtParseYMD(new Date().toISOString());
        const start = dtParseYMD(cur) || today || { y: 2026, m: 0, d: 1 };
        let vy = start.y, vm = start.m;
        const menu = document.createElement('div'); menu.className = 'dt-menu dt-datepop';
        const draw = () => {
          menu.innerHTML = '';
          const head = document.createElement('div'); head.className = 'dt-cal-head';
          const prev = document.createElement('button'); prev.className = 'dt-cal-nav'; prev.innerHTML = dtIcon('chevL', 15);
          const lbl = document.createElement('span'); lbl.className = 'dt-cal-title'; lbl.textContent = `${MONTHS[vm]} ${vy}`;
          const next = document.createElement('button'); next.className = 'dt-cal-nav'; next.innerHTML = dtIcon('chevR', 15);
          prev.addEventListener('mousedown', (e) => { e.preventDefault(); vm--; if (vm < 0) { vm = 11; vy--; } draw(); });
          next.addEventListener('mousedown', (e) => { e.preventDefault(); vm++; if (vm > 11) { vm = 0; vy++; } draw(); });
          head.append(prev, lbl, next); menu.appendChild(head);
          const grid = document.createElement('div'); grid.className = 'dt-cal-grid';
          for (const d of DOW) { const c = document.createElement('span'); c.className = 'dt-cal-dow'; c.textContent = d; grid.appendChild(c); }
          const first = new Date(vy, vm, 1).getDay();
          const days = new Date(vy, vm + 1, 0).getDate();
          for (let i = 0; i < first; i++) grid.appendChild(document.createElement('span'));
          for (let d = 1; d <= days; d++) {
            const cell = document.createElement('button'); cell.className = 'dt-cal-day'; cell.textContent = String(d);
            if (start && vy === start.y && vm === start.m && d === start.d) cell.classList.add('sel');
            if (today && vy === today.y && vm === today.m && d === today.d) cell.classList.add('today');
            cell.addEventListener('mousedown', (e) => { e.preventDefault(); set(dtYMD(vy, vm, d)); });
            grid.appendChild(cell);
          }
          menu.appendChild(grid);
          const foot = document.createElement('div'); foot.className = 'dt-cal-foot';
          const tBtn = document.createElement('button'); tBtn.className = 'dt-cal-ftbtn'; tBtn.textContent = 'Today';
          tBtn.addEventListener('mousedown', (e) => { e.preventDefault(); const t = dtParseYMD(new Date().toISOString())!; set(dtYMD(t.y, t.m, t.d)); });
          const cBtn = document.createElement('button'); cBtn.className = 'dt-cal-ftbtn'; cBtn.textContent = 'Clear';
          cBtn.addEventListener('mousedown', (e) => { e.preventDefault(); set(''); });
          foot.append(tBtn, cBtn); menu.appendChild(foot);
        };
        draw();
        anchorMenu(menu, anchor);
      }

      // In-app location picker for place cells (Notion "Place"): type a location,
      // or use the browser's geolocation — no external tab, no online autocomplete.
      function openPlacePop(anchor: HTMLElement, row: DtRow, col: DtCol, cur: string) {
        closeMenu();
        const set = (v: string) => { closeMenu(); if (v !== cur) setCell(row.id, col, v); };
        const menu = document.createElement('div'); menu.className = 'dt-menu dt-placepop';
        const search = document.createElement('input'); search.className = 'dt-rename dt-seladd'; search.placeholder = 'Search for a location…'; search.value = cur;
        search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = search.value.trim(); if (v) set(v); } else if (e.key === 'Escape') closeMenu(); });
        menu.appendChild(search);
        const cur2 = document.createElement('div'); cur2.className = 'dt-mrow';
        const ic = document.createElement('span'); ic.className = 'dt-mi'; ic.innerHTML = dtIcon('pin', 14);
        const tx = document.createElement('span'); tx.className = 'dt-mlabel'; tx.textContent = 'Current location';
        cur2.append(ic, tx);
        cur2.addEventListener('mousedown', (e) => {
          e.preventDefault();
          if (!navigator.geolocation) { tx.textContent = 'Location unavailable'; return; }
          tx.textContent = 'Locating…';
          navigator.geolocation.getCurrentPosition(
            (pos) => set(`${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`),
            () => { tx.textContent = 'Current location'; },
            { timeout: 8000 },
          );
        });
        menu.appendChild(cur2);
        if (cur) { const sep = document.createElement('div'); sep.className = 'dt-msep'; menu.appendChild(sep); menu.appendChild(menuRow('Clear', 'x', () => set(''))); }
        anchorMenu(menu, anchor);
        setTimeout(() => search.focus(), 0);
      }

      // Turn a <td> into the right editor for text/number columns.
      function editCell(td: HTMLElement, rowId: number, col: DtCol, cur: string) {
        if (td.classList.contains('editing')) return;
        td.classList.add('editing'); td.innerHTML = '';
        const done = (val: string) => {
          if (val === cur) { paintBody(); return; }
          setCell(rowId, col, val);
        };
        const input = document.createElement('input'); input.className = 'dt-edit';
        input.type = 'text';   // number/date validate on the backend; keep a plain editable field
        input.value = cur;
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } else if (e.key === 'Escape') { input.value = cur; input.blur(); } });
        input.addEventListener('blur', () => done(input.value));
        td.appendChild(input); input.focus(); input.select();
      }

      // Render one cell's display content (not the editor) by column type + role.
      function fillCell(td: HTMLElement, row: DtRow, col: DtCol, primary: boolean) {
        const val = row.cells[col.key] || '';
        if (col.type === 'checkbox') {
          td.appendChild(mkCheck(dtTruthy(val), false, () => setCell(row.id, col, dtTruthy(val) ? 'false' : 'true'), col.name));
          return;
        }
        // A score/rating number renders as ⭐ (Notion-style), still click-to-edit.
        if (col.type === 'number' && /\b(score|rating|stars?)\b/i.test(col.name)) {
          const n = Math.max(0, Math.min(5, Math.round(parseFloat((val || '').replace(/[,$%]/g, '')) || 0)));
          const chip = document.createElement('span'); chip.className = 'dt-stars';
          if (n) chip.textContent = '⭐'.repeat(n);
          else { const d = document.createElement('span'); d.className = 'dt-dash'; d.textContent = '—'; chip.appendChild(d); }
          td.appendChild(chip);
          td.addEventListener('click', () => editCell(td, row.id, col, val));
          return;
        }
        if (col.type === 'number') {
          if (val.trim()) { const s = document.createElement('span'); s.className = 'dt-celltext'; s.textContent = dtFmtNumber(val, col.format); td.appendChild(s); }
          else { const dash = document.createElement('span'); dash.className = 'dt-dash'; dash.textContent = '—'; td.appendChild(dash); }
          td.addEventListener('click', () => editCell(td, row.id, col, val));
          return;
        }
        if (col.type === 'url') {
          if (val.trim()) {
            const a = document.createElement('span'); a.className = 'dt-celltext dt-urltext'; a.textContent = val;
            td.appendChild(a); td.classList.add('dt-haslink');
            const open = document.createElement('button'); open.className = 'dt-linkopen'; open.title = 'Open link'; open.innerHTML = DT_EXT_ICON;
            open.addEventListener('click', (e) => { e.stopPropagation(); try { openUrl(dtHref(val)); } catch { ipc.openExternal(dtHref(val)).catch(() => {}); } });
            td.appendChild(open);
          } else {
            const dash = document.createElement('span'); dash.className = 'dt-dash'; dash.textContent = '—'; td.appendChild(dash);
          }
          td.addEventListener('click', () => editCell(td, row.id, col, val));
          return;
        }
        if (col.type === 'place') {
          if (val.trim()) {
            const wrap = document.createElement('span'); wrap.className = 'dt-place';
            const pin = document.createElement('span'); pin.className = 'dt-placepin'; pin.innerHTML = dtIcon('pin', 13);
            const tx = document.createElement('span'); tx.className = 'dt-celltext'; tx.textContent = val;
            wrap.append(pin, tx); td.appendChild(wrap);
            td.classList.add('dt-haslink');
            const open = document.createElement('button'); open.className = 'dt-linkopen'; open.title = 'Open map in Spike'; open.innerHTML = DT_EXT_ICON;
            open.addEventListener('click', (e) => {
              e.stopPropagation();
              // dock the map in Spike's in-app browser pane — not an external tab
              try { openUrl('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(val.trim())); }
              catch { ipc.openExternal('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(val.trim())).catch(() => {}); }
            });
            td.appendChild(open);
          } else {
            const dash = document.createElement('span'); dash.className = 'dt-dash'; dash.textContent = '—'; td.appendChild(dash);
          }
          td.addEventListener('click', () => openPlacePop(td, row, col, val));
          return;
        }
        if (dtOptionType(col.type)) {
          // click anywhere in the cell opens the themed option popover (never the
          // native <select>). Select/multi tags are dot-less muted pills (Notion
          // keeps the dot in the dropdown); a Status cell shows its colored dot.
          const pieces = col.type === 'multiselect'
            ? dtMulti(val)
            : val.split(',').map((s) => s.trim()).filter(Boolean);
          const withDot = col.type === 'status';
          if (pieces.length) {
            const tags = document.createElement('span'); tags.className = 'dt-tags';
            for (const piece of pieces) {
              const pill = document.createElement('span'); pill.className = 'dt-tag';
              pill.style.setProperty('--tag', colorForOption(col, piece));
              if (withDot) { const dot = document.createElement('span'); dot.className = 'dt-tag-dot'; pill.appendChild(dot); }
              const tx = document.createElement('span'); tx.textContent = piece;
              pill.appendChild(tx); tags.appendChild(pill);
            }
            td.appendChild(tags);
          } else {
            const dash = document.createElement('span'); dash.className = 'dt-dash'; dash.textContent = '—';
            td.appendChild(dash);
          }
          td.addEventListener('click', () => openSelectPop(td, row, col, val));
          return;
        }
        if (col.type === 'date') {
          // themed calendar popover (never the OS date picker); display formatted.
          if (val.trim()) { const s = document.createElement('span'); s.className = 'dt-celltext'; s.textContent = dtFmtDate(val); td.appendChild(s); }
          else { const dash = document.createElement('span'); dash.className = 'dt-dash'; dash.textContent = '—'; td.appendChild(dash); }
          td.addEventListener('click', () => openDatePop(td, row, col, val));
          return;
        }
        if (!val.trim()) {
          const dash = document.createElement('span'); dash.className = 'dt-dash'; dash.textContent = '—';
          td.appendChild(dash);
          td.addEventListener('click', () => editCell(td, row.id, col, val));
          return;
        }
        if (primary) {
          const mono = document.createElement('span'); mono.className = 'dt-mono';
          mono.style.setProperty('--tag', dtHueFor(val));
          mono.textContent = val.trim().slice(0, 1).toUpperCase();
          const nm = document.createElement('span'); nm.className = 'dt-primary-name'; nm.textContent = val;
          td.append(mono, nm);
          td.addEventListener('click', () => editCell(td, row.id, col, val));
          return;
        }
        // plain text — hover reveals the full value (native tooltip) when truncated
        const tx = document.createElement('span'); tx.className = 'dt-celltext'; tx.textContent = val;
        td.appendChild(tx);
        if (val.length > 24) td.title = val;
        td.addEventListener('click', () => editCell(td, row.id, col, val));
        // url-ish value → open-external affordance
        if (col.type === 'text' && dtIsUrl(val)) {
          td.classList.add('dt-haslink');
          const open = document.createElement('button'); open.className = 'dt-linkopen'; open.title = 'Open link'; open.innerHTML = DT_EXT_ICON;
          open.addEventListener('click', (e) => { e.stopPropagation(); ipc.openExternal(dtHref(val)).catch(() => {}); });
          td.appendChild(open);
        } else if (col.type === 'text' && dtIsLocationCol(col.name)) {
          // location column → a map-pin that opens the address in Maps.
          td.classList.add('dt-haslink');
          const pin = document.createElement('button'); pin.className = 'dt-linkopen dt-mappin'; pin.title = 'Open in Maps'; pin.innerHTML = dtIcon('pin', 13);
          pin.addEventListener('click', (e) => {
            e.stopPropagation();
            ipc.openExternal('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(val.trim())).catch(() => {});
          });
          td.appendChild(pin);
        }
      }

      function paintBody() {
        tbody.innerHTML = '';
        const rows = viewRows();
        rows.forEach((row, i) => {
          const tr = document.createElement('tr'); tr.className = 'dt-row' + (selected.has(row.id) ? ' is-selected' : ''); tr.dataset.id = String(row.id);
          // Selection lane: a quiet row number at rest; the checkbox reveals on
          // row hover or when selected (Notion-style — no wall of empty boxes).
          const selTd = document.createElement('td'); selTd.className = 'dt-selcell';
          const num = document.createElement('span'); num.className = 'dt-rownum'; num.textContent = String(i + 1);
          selTd.appendChild(num);
          selTd.appendChild(mkCheck(selected.has(row.id), false, () => {
            if (selected.has(row.id)) selected.delete(row.id); else selected.add(row.id);
            tr.classList.toggle('is-selected', selected.has(row.id)); paintHead(); syncSelUi();
          }, `Select row`));
          tr.appendChild(selTd);
          shownCols().forEach((col, idx) => {
            const td = document.createElement('td'); td.className = 'dt-td dt-' + col.type + (idx === 0 ? ' dt-primary' : '');
            fillCell(td, row, col, idx === 0);
            tr.appendChild(td);
          });
          const cap = document.createElement('td'); cap.className = 'dt-endcap'; tr.appendChild(cap);
          tbody.appendChild(tr);
        });
        if (!rows.length) {
          const tr = document.createElement('tr');
          const td = document.createElement('td'); td.className = 'dt-empty'; td.colSpan = shownCols().length + 2;
          td.textContent = filter ? 'No rows match the filter.' : 'No rows yet.';
          tr.appendChild(td); tbody.appendChild(tr);
        }
      }

      // Calculations row: count under the primary column, and a per-type rollup
      // under each other column (numbers → sum, checkboxes → N checked).
      function paintFoot() {
        const rows = viewRows();
        const tr = document.createElement('tr'); tr.className = 'dt-foot';
        // "+ New" lives in the footer (same row as the count), left lane.
        const selTd = document.createElement('td'); selTd.className = 'dt-selcell';
        const addRowBtn = document.createElement('button'); addRowBtn.className = 'dt-addrow dt-footadd'; addRowBtn.title = 'Add row'; addRowBtn.innerHTML = dtIcon('plus', 15);
        addRowBtn.addEventListener('click', () => mutate(() => ipc.tableAddRow(path)));
        selTd.appendChild(addRowBtn);
        tr.appendChild(selTd);
        shownCols().forEach((col, idx) => {
          const td = document.createElement('td'); td.className = 'dt-footcell' + (idx === 0 ? ' dt-primary' : '');
          if (idx === 0) {
            td.innerHTML = `<span class="dt-footnum">${rows.length}</span> <span class="dt-footlbl">${rows.length === 1 ? 'record' : 'records'}</span>`;
          } else if (col.type === 'number') {
            const nums = rows.map((r) => parseFloat((r.cells[col.key] || '').replace(/[,$%]/g, ''))).filter((n) => !isNaN(n));
            if (nums.length) {
              const sum = nums.reduce((a, b) => a + b, 0);
              const shown = col.format && col.format !== 'plain' ? dtFmtNumber(String(sum), col.format) : String(Number(sum.toFixed(2)));
              td.innerHTML = `<span class="dt-footlbl">sum</span> <span class="dt-footnum">${shown}</span>`;
            }
          } else if (col.type === 'checkbox') {
            const on = rows.filter((r) => dtTruthy(r.cells[col.key] || '')).length;
            const pct = rows.length ? Math.round((on / rows.length) * 100) : 0;
            td.innerHTML = `<span class="dt-footnum">${pct}%</span> <span class="dt-footlbl">checked · ${on}/${rows.length}</span>`;
          }
          tr.appendChild(td);
        });
        tfoot.innerHTML = ''; tfoot.appendChild(tr);
      }

      // ── view bar (tabs + add) ─────────────────────────────────────────────
      function paintViewbar() {
        viewbar.innerHTML = '';
        for (const v of doc.views) {
          const tab = document.createElement('button'); tab.className = 'dt-viewtab' + (v.id === activeViewId ? ' active' : '');
          const meta = VIEW_META[v.kind] || VIEW_META.table;
          const ic = document.createElement('span'); ic.className = 'dt-vi'; ic.innerHTML = dtIcon(meta[0], 14);
          const nm = document.createElement('span'); nm.className = 'dt-vname'; nm.textContent = v.name || meta[1];
          tab.append(ic, nm);
          tab.addEventListener('click', () => { if (v.id === activeViewId) openViewMenu(tab, v); else switchView(v.id); });
          viewbar.appendChild(tab);
        }
        const add = document.createElement('button'); add.className = 'dt-viewadd'; add.title = 'Add view'; add.innerHTML = dtIcon('plus', 15);
        add.addEventListener('click', (e) => { e.stopPropagation(); openAddViewMenu(add); });
        viewbar.appendChild(add);
      }
      async function mutateAfter(p: Promise<DtDoc>, after?: (d: DtDoc) => void) {
        closeMenu();
        try { const next = await p; if (!alive()) return; doc = next; if (after) after(next); repaint(); } catch (e) { /* ignore */ }
      }
      function openAddViewMenu(anchor: HTMLElement) {
        closeMenu();
        const menu = document.createElement('div'); menu.className = 'dt-menu';
        (['table', 'board', 'gallery', 'list', 'calendar'] as const).forEach((k) => {
          const meta = VIEW_META[k];
          menu.appendChild(menuRow(meta[1], meta[0], () => {
            mutateAfter(ipc.tableAddView(path, meta[1], k), (d) => { activeViewId = d.views[d.views.length - 1].id; loadViewState(); });
          }));
        });
        anchorMenu(menu, anchor);
      }
      // View settings — per-view property visibility + order (Notion "Edit view").
      // A sticky pop: each property row = drag grip + type icon + name + eye toggle.
      // The primary (title) column is always shown; reorder writes the global order.
      function openViewSettings(anchor: HTMLElement) {
        const { menu, place } = openStickyPop(anchor, 'dt-viewset-pop');
        let drag: null | { key: string; line: HTMLElement } = null;
        const onMove = (e: MouseEvent) => {
          if (!drag) return;
          const rowEl = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('.dt-propRow') as HTMLElement | null;
          if (!rowEl || !menu.contains(rowEl)) return;
          const rect = rowEl.getBoundingClientRect();
          const after = e.clientY > rect.top + rect.height / 2;
          drag.line.remove();
          rowEl.parentElement!.insertBefore(drag.line, after ? rowEl.nextSibling : rowEl);
          drag.line.dataset.before = after ? (rowEl.nextElementSibling?.dataset.key ?? '') : (rowEl.dataset.key ?? '');
        };
        const onUp = () => {
          if (!drag) return;
          document.removeEventListener('mousemove', onMove, true);
          document.removeEventListener('mouseup', onUp, true);
          const before = drag.line.dataset.before || ''; const key = drag.key; drag.line.remove(); drag = null;
          if (before !== key) reorderColTo(key, before);   // '' → move to end
          redraw();
        };
        let redraw = () => {};
        redraw = () => {
          menu.innerHTML = '';
          const hdr = document.createElement('div'); hdr.className = 'dt-mhdr'; hdr.textContent = 'Properties'; menu.appendChild(hdr);
          const list = document.createElement('div'); list.className = 'dt-proplist'; menu.appendChild(list);
          doc.columns.forEach((col, idx) => {
            const isPrimary = idx === 0;
            const shown = isPrimary || !hiddenCols.includes(col.key);
            const row = document.createElement('div'); row.className = 'dt-propRow'; row.dataset.key = col.key;
            const grip = document.createElement('span'); grip.className = 'dt-optgrip'; grip.title = 'Drag to reorder'; grip.innerHTML = dtGripSvg;
            grip.addEventListener('mousedown', (e) => {
              e.preventDefault(); e.stopPropagation();
              const line = document.createElement('div'); line.className = 'dt-dropline'; drag = { key: col.key, line };
              document.addEventListener('mousemove', onMove, true); document.addEventListener('mouseup', onUp, true);
            });
            const ic = document.createElement('span'); ic.className = 'dt-mi'; ic.innerHTML = dtTypeIcon(col.type);
            const nm = document.createElement('span'); nm.className = 'dt-mlabel'; nm.textContent = col.name;
            const eye = document.createElement('button'); eye.className = 'dt-propeye' + (shown ? '' : ' off'); eye.title = shown ? 'Hide' : 'Show';
            eye.innerHTML = dtIcon(shown ? 'eye' : 'eyeOff', 15);
            if (isPrimary) { eye.disabled = true; eye.title = 'The title is always shown'; }
            eye.addEventListener('mousedown', (e) => {
              e.preventDefault(); if (isPrimary) return;
              if (hiddenCols.includes(col.key)) hiddenCols = hiddenCols.filter((k) => k !== col.key);
              else hiddenCols = [...hiddenCols, col.key];
              applyView(); redraw();
            });
            row.append(grip, ic, nm, eye);
            list.appendChild(row);
          });
          const hidden = doc.columns.filter((c, i) => i !== 0 && hiddenCols.includes(c.key)).length;
          const foot = document.createElement('div'); foot.className = 'dt-propfoot';
          const toggleAll = document.createElement('button'); toggleAll.className = 'dt-fadd';
          toggleAll.innerHTML = dtIcon(hidden ? 'eye' : 'eyeOff', 13) + `<span>${hidden ? 'Show all properties' : 'Hide all properties'}</span>`;
          toggleAll.addEventListener('mousedown', (e) => {
            e.preventDefault();
            hiddenCols = hidden ? [] : doc.columns.slice(1).map((c) => c.key);
            applyView(); redraw();
          });
          foot.appendChild(toggleAll); menu.appendChild(foot);
          place();
        };
        redraw();
      }
      function openViewMenu(anchor: HTMLElement, v: any) {
        closeMenu();
        const menu = document.createElement('div'); menu.className = 'dt-menu';
        menu.appendChild(menuRow('Rename', 'pencil', () => { closeMenu(); beginRenameView(anchor, v); }));
        menu.appendChild(menuRow('Edit view', 'sliders', () => { closeMenu(); openViewSettings(anchor); }));
        // Display as — switch this view's layout in place (Notion's "Display as").
        const dh = document.createElement('div'); dh.className = 'dt-mhdr'; dh.textContent = 'Display as'; menu.appendChild(dh);
        (['table', 'board', 'gallery', 'list', 'calendar'] as const).forEach((k) => {
          const meta = VIEW_META[k];
          menu.appendChild(menuRow(meta[1], meta[0], () => {
            closeMenu();
            if (k === v.kind) return;
            mutateAfter(ipc.tableUpdateView(path, v.id, null, null, k), () => loadViewState());
          }, k === v.kind ? 'sel' : ''));
        });
        const dsep = document.createElement('div'); dsep.className = 'dt-msep'; menu.appendChild(dsep);
        // Duplicate: a fresh view of the same kind carrying this view's saved
        // sort/filter/group config (add → then copy the config onto the new id).
        menu.appendChild(menuRow('Duplicate view', 'copy', () => {
          closeMenu();
          const cfg = JSON.parse(JSON.stringify(v.config || {}));
          mutateAfter(ipc.tableAddView(path, (v.name || 'View') + ' copy', v.kind), (d) => {
            const nv = d.views[d.views.length - 1];
            activeViewId = nv.id;
            mutateAfter(ipc.tableUpdateView(path, nv.id, null, cfg), () => loadViewState());
          });
        }));
        if (doc.views.length > 1) {
          const sep = document.createElement('div'); sep.className = 'dt-msep'; menu.appendChild(sep);
          menu.appendChild(menuRow('Delete view', 'trash', () => {
            const wasId = v.id;
            mutateAfter(ipc.tableDeleteView(path, v.id), (d) => { if (activeViewId === wasId) activeViewId = d.views[0].id; loadViewState(); });
          }, 'danger'));
        }
        anchorMenu(menu, anchor);
      }
      function beginRenameView(tab: HTMLElement, v: any) {
        const nm = tab.querySelector('.dt-vname'); if (!nm) return;
        const input = document.createElement('input'); input.className = 'dt-rename dt-vrename'; input.value = v.name;
        nm.replaceWith(input); input.focus(); input.select();
        input.addEventListener('click', (e) => e.stopPropagation());
        const commit = () => { const val = input.value.trim(); if (val && val !== v.name) mutateAfter(ipc.tableUpdateView(path, v.id, val)); else paintViewbar(); };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') paintViewbar(); });
        input.addEventListener('blur', commit);
      }

      // A group-by / date-field picker button used by Board/Calendar headers.
      function fieldPicker(label: string, current: string | null, types: string[], onPick: (key: string | null) => void): HTMLElement {
        const btn = document.createElement('button'); btn.className = 'dt-pickbtn';
        const cols = doc.columns.filter((c) => types.includes(c.type));
        const cur = current ? colByKey(current) : null;
        btn.innerHTML = `<span class="dt-picklbl">${label}</span> <span class="dt-pickval">${cur ? cur.name : 'None'}</span>`;
        btn.appendChild(Object.assign(document.createElement('span'), { className: 'dt-pickcar', innerHTML: dtIcon('arrowDown', 12) }));
        btn.addEventListener('click', (e) => {
          e.stopPropagation(); closeMenu();
          const menu = document.createElement('div'); menu.className = 'dt-menu';
          menu.appendChild(menuRow('None', 'x', () => { closeMenu(); onPick(null); }, !current ? 'sel' : ''));
          for (const c of cols) menu.appendChild(menuRow(c.name, '', () => { closeMenu(); onPick(c.key); }, current === c.key ? 'sel' : ''));
          anchorMenu(menu, btn);
        });
        return btn;
      }
      // A labeled, editable field for card/list views (reuses the cell editors).
      function fieldEl(row: DtRow, col: DtCol, showLabel: boolean): HTMLElement {
        const wrap = document.createElement('div'); wrap.className = 'dt-field';
        if (showLabel) { const l = document.createElement('span'); l.className = 'dt-flabel'; l.textContent = col.name; wrap.appendChild(l); }
        const val = document.createElement('div'); val.className = 'dt-fval dt-td dt-' + col.type;
        fillCell(val, row, col, false);
        wrap.appendChild(val);
        return wrap;
      }
      function cardTitle(row: DtRow): HTMLElement {
        const pcol = doc.columns[0];
        const el = document.createElement('div'); el.className = 'dt-cardtitle dt-td dt-primary';
        const pv = pcol ? (row.cells[pcol.key] || '').trim() : '';
        if (pcol && pv) { fillCell(el, row, pcol, true); }
        else if (pcol) {
          // empty primary → a clear, muted placeholder (not a bare "—") so a new
          // card reads as "Untitled" and clicking it names the record inline.
          el.classList.add('dt-untitled'); el.textContent = 'Untitled';
          el.addEventListener('click', () => editCell(el, row.id, pcol, ''));
        } else { el.textContent = 'Untitled'; }
        return el;
      }
      // non-primary columns to show on a card/list row (skip the group column +
      // any per-view hidden properties)
      function secondaryCols(skipKey?: string | null): DtCol[] {
        return doc.columns.slice(1).filter((c) => c.key !== skipKey && !hiddenCols.includes(c.key));
      }
      // Add a row, optionally pre-filling cells (board lane value, calendar day).
      // Optimistic: a temp row appears instantly, then the create (+ any preset
      // cells) runs in the background and reconciles to the real ids on success.
      function addRowWith(preset?: Record<string, string>) {
        closeMenu();
        const cells: Record<string, string> = {};
        if (preset) for (const [k, v] of Object.entries(preset)) if (v) { cells[k] = v; const c = colByKey(k); if (c) mirrorOptions(c, v); }
        doc.rows.push({ id: nextTemp--, cells });
        renderActive(); paintCount();
        bgWrite(
          async () => {
            const d = await ipc.tableAddRow(path);
            const nr = d.rows[d.rows.length - 1];
            if (nr && preset) {
              let last = d;
              for (const [k, v] of Object.entries(preset)) if (v) last = await ipc.tableSetCell(path, nr.id, k, v);
              return last;
            }
            return d;
          },
          (d) => { doc = d; repaint(); },   // reconcile: swap temp row for the real one
        );
      }
      // A "+ New" button used at the foot of board lanes / gallery / list.
      function addRowButton(preset?: Record<string, string>): HTMLElement {
        const b = document.createElement('button'); b.className = 'dt-addrow';
        b.innerHTML = dtIcon('plus', 15) + '<span>New</span>';
        b.addEventListener('click', (e) => { e.stopPropagation(); addRowWith(preset); });
        return b;
      }

      // ── Board (kanban) ────────────────────────────────────────────────────
      function renderBoard() {
        const rows = viewRows();
        let gcol = groupBy ? colByKey(groupBy) : (firstColOfType('status') || firstColOfType('select') || firstColOfType('multiselect') || undefined);
        if (!groupBy && gcol) groupBy = gcol.key;
        const head = document.createElement('div'); head.className = 'dt-viewhead';
        head.appendChild(fieldPicker('Group by', groupBy, ['status', 'select', 'multiselect', 'text', 'checkbox'], (k) => { groupBy = k; hiddenGroups = []; applyView(); }));
        if (gcol) {
          // hide-empty toggle + a chip to restore hidden lanes
          const he = document.createElement('button'); he.className = 'dt-pickbtn dt-boardtog' + (hideEmpty ? ' on' : '');
          he.innerHTML = `<span class="dt-picklbl">Hide empty</span>`;
          he.addEventListener('click', (e) => { e.stopPropagation(); hideEmpty = !hideEmpty; applyView(); });
          head.appendChild(he);
          if (hiddenGroups.length) {
            const hc = document.createElement('button'); hc.className = 'dt-pickbtn';
            hc.innerHTML = `<span class="dt-pickval">${hiddenGroups.length} hidden</span>`;
            hc.addEventListener('click', (e) => {
              e.stopPropagation(); closeMenu();
              const menu = document.createElement('div'); menu.className = 'dt-menu';
              const hdr = document.createElement('div'); hdr.className = 'dt-mhdr'; hdr.textContent = 'Hidden lanes'; menu.appendChild(hdr);
              for (const g of hiddenGroups.slice()) menu.appendChild(menuRow(g || ('No ' + gcol!.name), 'plus', () => { closeMenu(); hiddenGroups = hiddenGroups.filter((x) => x !== g); applyView(); }));
              anchorMenu(menu, hc);
            });
            head.appendChild(hc);
          }
        }
        scroll.appendChild(head);
        if (!gcol) { const e = document.createElement('div'); e.className = 'dt-empty'; e.textContent = 'Pick a column to group by.'; scroll.appendChild(e); return; }
        const gk = gcol.key;
        const multiG = gcol.type === 'multiselect';
        // the group value(s) a row belongs to (multiselect → one lane per tag)
        const groupsOf = (r: DtRow): string[] => {
          const raw = (r.cells[gk] || '').trim();
          if (multiG) { const t = dtMulti(raw); return t.length ? t : ['']; }
          return [raw];
        };
        // lane order: the column's saved options first, then any other present values, then Empty.
        // A Status board additionally sorts lanes by group bucket (To-do → In progress → Done),
        // keeping option order within each bucket (stable sort).
        const present = Array.from(new Set(rows.flatMap(groupsOf)));
        const order: string[] = [];
        for (const o of gcol.options) if (!order.includes(o)) order.push(o);
        for (const p of present) if (p && !order.includes(p)) order.push(p);
        if (gcol.type === 'status') {
          order.sort((a, b) => (STATUS_ORDER[groupForOption(gcol!, a)] ?? 0) - (STATUS_ORDER[groupForOption(gcol!, b)] ?? 0));
        }
        order.push('');   // the "no value" lane
        const board = document.createElement('div'); board.className = 'dt-board';
        // Pointer-based card drag. HTML5 draggable/dragstart is dead in this
        // WKWebView — the rest of the app moved off it onto the mouse engine for
        // exactly this reason (see makeDragSource) — so the Board carries its own:
        // a floating ghost follows the cursor, the lane under it highlights, and
        // releasing over a different lane sets the group cell via the same mutate
        // the field menus already use.
        let cardDrag: null | { id: number; from: string; ghost: HTMLElement; card: HTMLElement; dx: number; dy: number } = null;
        function startCardDrag(e: MouseEvent, card: HTMLElement, row: any, from: string) {
          if (e.button !== 0) return;
          if ((e.target as HTMLElement).closest('input, button, a, .dt-check, .dt-menu')) return;   // let inline controls work
          const rect = card.getBoundingClientRect();
          const sx = e.clientX, sy = e.clientY;
          const dx = e.clientX - rect.left, dy = e.clientY - rect.top;
          // Target a lane by the cursor's X only — the WHOLE column (full height,
          // even below a short/empty lane) is a drop zone, and gaps snap to the
          // nearest lane. elementFromPoint made empty lanes near-impossible to hit.
          const highlight = (x: number, _y: number): HTMLElement | null => {
            const lanes = Array.from(board.querySelectorAll('.dt-lane')) as HTMLElement[];
            let target: HTMLElement | null = null;
            for (const lane of lanes) { const r = lane.getBoundingClientRect(); if (x >= r.left && x <= r.right) { target = lane; break; } }
            if (!target && lanes.length) {   // in a gap or past the ends → nearest by center-x
              let best = Infinity;
              for (const lane of lanes) { const r = lane.getBoundingClientRect(); const d = Math.abs(x - (r.left + r.right) / 2); if (d < best) { best = d; target = lane; } }
            }
            lanes.forEach((n) => n.classList.toggle('over', n === target));
            return target;
          };
          const onMove = (ev: MouseEvent) => {
            if (!cardDrag) {
              if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 5) return;   // below threshold: still a click
              const ghost = card.cloneNode(true) as HTMLElement;
              ghost.classList.add('dt-card-ghost');
              ghost.style.width = rect.width + 'px';
              document.body.appendChild(ghost);
              card.classList.add('dragging');
              document.body.classList.add('dt-dragging');
              cardDrag = { id: row.id, from, ghost, card, dx, dy };
            }
            cardDrag.ghost.style.left = (ev.clientX - cardDrag.dx) + 'px';
            cardDrag.ghost.style.top = (ev.clientY - cardDrag.dy) + 'px';
            highlight(ev.clientX, ev.clientY);
          };
          const onUp = (ev: MouseEvent) => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            if (!cardDrag) return;   // never crossed the threshold — a plain click, leave it be
            const d = cardDrag; cardDrag = null;
            const lane = highlight(ev.clientX, ev.clientY);
            d.ghost.remove(); d.card.classList.remove('dragging'); document.body.classList.remove('dt-dragging');
            board.querySelectorAll('.dt-lane.over').forEach((n) => n.classList.remove('over'));
            if (lane) {
              const to = lane.dataset.val || '';
              if (to !== d.from) {
                if (multiG) {
                  // move the tag: drop the source lane's tag, add the destination's
                  const r = doc.rows.find((x) => x.id === d.id);
                  const cur = r ? dtMulti(r.cells[gk] || '') : [];
                  const next = cur.filter((x) => x !== d.from); if (to && !next.includes(to)) next.push(to);
                  setCell(d.id, gcol!, dtMultiStr(next));
                } else {
                  setCell(d.id, gcol!, to);
                }
              }
            }
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
          e.preventDefault();   // don't begin a text selection
        }
        let shown = 0;
        for (const val of order) {
          if (hiddenGroups.includes(val)) continue;
          const laneRows = rows.filter((r) => groupsOf(r).includes(val));
          if (val === '' && laneRows.length === 0) continue;
          if (hideEmpty && laneRows.length === 0) continue;
          shown++;
          const lane = document.createElement('div'); lane.className = 'dt-lane'; lane.dataset.val = val;
          const lh = document.createElement('div'); lh.className = 'dt-lanehead';
          if (val) { const pill = document.createElement('span'); pill.className = 'dt-tag'; pill.style.setProperty('--tag', colorForOption(gcol, val)); pill.innerHTML = '<span class="dt-tag-dot"></span>'; const t = document.createElement('span'); t.textContent = val; pill.appendChild(t); lh.appendChild(pill); }
          else { const t = document.createElement('span'); t.className = 'dt-lanenone'; t.textContent = 'No ' + gcol.name; lh.appendChild(t); }
          const cnt = document.createElement('span'); cnt.className = 'dt-lanecount'; cnt.textContent = String(laneRows.length); lh.appendChild(cnt);
          // per-lane kebab → hide this lane
          const keb = document.createElement('button'); keb.className = 'dt-lanekebab'; keb.title = 'Lane options'; keb.innerHTML = dtIcon('dots', 15);
          keb.addEventListener('click', (ev) => {
            ev.stopPropagation(); closeMenu();
            const menu = document.createElement('div'); menu.className = 'dt-menu';
            menu.appendChild(menuRow('Hide lane', 'x', () => { closeMenu(); if (!hiddenGroups.includes(val)) hiddenGroups.push(val); applyView(); }));
            // recolor the group (= recolor its option) with the named Spike palette
            if (val && dtOptionType(gcol.type)) {
              menu.appendChild(colorListEl(colorForOption(gcol, val), (hex) => { closeMenu(); setOptionColor(gcol, val, hex); }));
            }
            anchorMenu(menu, keb);
          });
          lh.appendChild(keb);
          lane.appendChild(lh);
          const body = document.createElement('div'); body.className = 'dt-lanebody';
          for (const row of laneRows) {
            const card = document.createElement('div'); card.className = 'dt-card'; card.dataset.id = String(row.id);
            card.addEventListener('mousedown', (e) => startCardDrag(e, card, row, val));
            card.appendChild(cardTitle(row));
            for (const c of secondaryCols(gk).slice(0, 4)) card.appendChild(fieldEl(row, c, true));
            body.appendChild(card);
          }
          lane.appendChild(body);
          // + New in this lane → new row pre-tagged with the lane's value
          lane.appendChild(addRowButton(val ? { [gk]: multiG ? dtMultiStr([val]) : val } : undefined));
          board.appendChild(lane);
        }
        if (!shown) { const e = document.createElement('div'); e.className = 'dt-empty'; e.textContent = 'All lanes hidden.'; board.appendChild(e); }
        scroll.appendChild(board);
      }

      // ── Gallery (cards) ───────────────────────────────────────────────────
      function renderGallery() {
        const rows = viewRows();
        const grid = document.createElement('div'); grid.className = 'dt-gallery';
        for (const row of rows) {
          const card = document.createElement('div'); card.className = 'dt-card';
          card.appendChild(cardTitle(row));
          for (const c of secondaryCols()) card.appendChild(fieldEl(row, c, true));
          grid.appendChild(card);
        }
        scroll.appendChild(grid);
        if (!rows.length && filter) { const e = document.createElement('div'); e.className = 'dt-empty'; e.textContent = 'No rows match the filter.'; scroll.appendChild(e); }
        else scroll.appendChild(addRowButton());
      }

      // ── List (compact stacked rows) ───────────────────────────────────────
      function renderList() {
        const rows = viewRows();
        const list = document.createElement('div'); list.className = 'dt-listview';
        for (const row of rows) {
          const lr = document.createElement('div'); lr.className = 'dt-listrow';
          lr.appendChild(cardTitle(row));
          const meta = document.createElement('div'); meta.className = 'dt-listmeta';
          for (const c of secondaryCols().slice(0, 5)) meta.appendChild(fieldEl(row, c, false));
          lr.appendChild(meta);
          list.appendChild(lr);
        }
        if (!rows.length && filter) { const e = document.createElement('div'); e.className = 'dt-empty'; e.textContent = 'No rows match the filter.'; list.appendChild(e); }
        else list.appendChild(addRowButton());
        scroll.appendChild(list);
      }

      // ── Calendar (rows placed on a month by a date column) ────────────────
      let calY = -1, calM = -1;
      function renderCalendar() {
        const rows = viewRows();
        let dcol = dateField ? colByKey(dateField) : firstColOfType('date');
        if (!dateField && dcol) dateField = dcol.key;
        const head = document.createElement('div'); head.className = 'dt-viewhead';
        if (calY < 0) { const now = dtParseYMD(new Date().toISOString())!; calY = now.y; calM = now.m; }
        const title = document.createElement('span'); title.className = 'dt-cal-title'; title.textContent = `${MONTHS[calM]} ${calY}`;
        const prev = document.createElement('button'); prev.className = 'dt-cal-nav'; prev.innerHTML = dtIcon('chevL', 15);
        const next = document.createElement('button'); next.className = 'dt-cal-nav'; next.innerHTML = dtIcon('chevR', 15);
        prev.addEventListener('click', () => { calM--; if (calM < 0) { calM = 11; calY--; } renderActive(); });
        next.addEventListener('click', () => { calM++; if (calM > 11) { calM = 0; calY++; } renderActive(); });
        head.append(prev, title, next);
        head.appendChild(fieldPicker('By', dateField, ['date'], (k) => { dateField = k; applyView(); }));
        scroll.appendChild(head);
        if (!dcol) { const e = document.createElement('div'); e.className = 'dt-empty'; e.textContent = 'Add a date column to use the calendar.'; scroll.appendChild(e); return; }
        const dk = dcol.key;
        const byDay: Record<number, DtRow[]> = {};
        for (const r of rows) { const p = dtParseYMD(r.cells[dk] || ''); if (p && p.y === calY && p.m === calM) (byDay[p.d] = byDay[p.d] || []).push(r); }
        const cal = document.createElement('div'); cal.className = 'dt-calmonth';
        for (const d of DOW) { const c = document.createElement('span'); c.className = 'dt-cal-dow'; c.textContent = d; cal.appendChild(c); }
        const first = new Date(calY, calM, 1).getDay();
        const days = new Date(calY, calM + 1, 0).getDate();
        for (let i = 0; i < first; i++) cal.appendChild(Object.assign(document.createElement('div'), { className: 'dt-calcell empty' }));
        const pcol = doc.columns[0];
        const today = dtParseYMD(new Date().toISOString());
        for (let d = 1; d <= days; d++) {
          const cell = document.createElement('div'); cell.className = 'dt-calcell'; cell.dataset.day = String(d);
          const dow = new Date(calY, calM, d).getDay();
          if (dow === 0 || dow === 6) cell.classList.add('weekend');
          if (today && today.y === calY && today.m === calM && today.d === d) cell.classList.add('today');
          const num = document.createElement('span'); num.className = 'dt-caldnum'; num.textContent = String(d); cell.appendChild(num);
          // hover "+" → add a row dated to this day
          const add = document.createElement('button'); add.className = 'dt-caladd'; add.title = 'New on this day'; add.innerHTML = dtIcon('plus', 14);
          add.addEventListener('click', (e) => { e.stopPropagation(); addRowWith({ [dk]: dtYMD(calY, calM, d) }); });
          cell.appendChild(add);
          for (const r of (byDay[d] || [])) {
            const chip = document.createElement('div'); chip.className = 'dt-calchip'; chip.style.setProperty('--tag', dtHueFor((pcol && r.cells[pcol.key]) || String(r.id)));
            chip.textContent = (pcol && r.cells[pcol.key]) || 'Untitled';
            chip.draggable = true; chip.dataset.id = String(r.id);
            chip.addEventListener('dragstart', (e) => { e.dataTransfer!.setData('text/plain', String(r.id)); chip.classList.add('dragging'); });
            chip.addEventListener('dragend', () => chip.classList.remove('dragging'));
            cell.appendChild(chip);
          }
          // click an empty part of the day → add a row there
          cell.addEventListener('click', (e) => { if (e.target === cell || e.target === num) addRowWith({ [dk]: dtYMD(calY, calM, d) }); });
          // drop a card here → set its date to this day (drag-to-reschedule)
          cell.addEventListener('dragover', (e) => { e.preventDefault(); cell.classList.add('over'); });
          cell.addEventListener('dragleave', () => cell.classList.remove('over'));
          cell.addEventListener('drop', (e) => {
            e.preventDefault(); cell.classList.remove('over');
            const id = parseInt(e.dataTransfer!.getData('text/plain'), 10);
            if (!isNaN(id) && dcol) setCell(id, dcol, dtYMD(calY, calM, d));
          });
          cal.appendChild(cell);
        }
        scroll.appendChild(cal);
      }

      loadViewState();
      repaint();
    }

    // A plain .csv not yet adopted: show it read-only with a banner to convert it
    // into an interactive Spike table (creates a sibling .spiketable, the source
    // of truth). onAdopt receives the new table doc (its path is the .spiketable).
    function renderCsvAdopt(container: HTMLElement, path: string, text: string, alive: () => boolean, onAdopt: (doc: any) => void) {
      container.innerHTML = '';
      const banner = document.createElement('div'); banner.className = 'dt-adopt';
      const msg = document.createElement('span'); msg.textContent = 'Plain CSV — convert to a Spike table to sort, filter, type, and edit. ';
      const btn = document.createElement('button'); btn.className = 'dt-act primary'; btn.textContent = 'Make interactive';
      btn.addEventListener('click', () => {
        btn.disabled = true; btn.textContent = 'Converting…';
        ipc.tableImportCsv(path).then((tdoc) => { if (alive()) onAdopt(tdoc); })
          .catch(() => { btn.disabled = false; btn.textContent = 'Make interactive'; });
      });
      banner.append(msg, btn);
      const scroll = document.createElement('div'); scroll.className = 'dt-scroll';
      const rows = parseDelimited(text, /\.tsv$/i.test(path) ? '\t' : ',');
      const table = document.createElement('table'); table.className = 'csv';
      rows.slice(0, 500).forEach((cells, r) => {
        const tr = document.createElement('tr');
        cells.forEach((cell) => { const c = document.createElement(r === 0 ? 'th' : 'td'); c.textContent = cell; tr.appendChild(c); });
        (r === 0 ? table.createTHead() : (table.tBodies[0] || table.createTBody())).appendChild(tr);
      });
      scroll.appendChild(table);
      container.append(banner, scroll);
    }

    // Lay each terminal pane over its placeholder. Panes live in #termlayer
    // (true 1.0 scale, outside the chrome's CSS zoom) and never move in the DOM;
    // the layout instead renders zoomed `.termslot` boxes, and we mirror each
    // visible slot's on-screen rect onto its pane. getBoundingClientRect reports
    // zoomed rects in either post- or pre-zoom px depending on the WebKit build,
    // so toViewportRect() maps the rect into the unzoomed coordinate space
    // #termlayer lives in. A pane whose slot is absent or
    // collapsed (display:none, behind a closed tab) is parked hidden. Call this
    // after any layout/zoom/size change, before reflowAllVisible() fits to the box.
    // Breathing room between the terminal text and its slot edges. Was once CSS
    // padding on .pane; moved here because FitAddon double-counts parent padding
    // (see syncTermLayer below). Matches the former `padding: 12px 14px 10px`.
    const PANE_INSET = { top: 12, right: 14, bottom: 10, left: 14 };
    function syncTermLayer() {
      const claimed = new Set<any>();
      document.querySelectorAll<HTMLElement>('.termslot').forEach((slot) => {
        const name = slot.dataset.term;
        if (!name || claimed.has(name)) return;
        const s = sessions.find((x) => x.name === name);
        if (!s) return;
        const r = slot.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return;   // slot hidden / zero-box
        claimed.add(name);
        // toViewportRect maps the (possibly pre-zoom) slot rect into #termlayer's
        // unzoomed viewport space; then inset the pane inside that box instead of
        // padding .pane via CSS: FitAddon measures the pane's height and only nets
        // out the terminal element's own padding, so padding on .pane is double-
        // counted and the last row spills behind the footer. Insetting hands
        // FitAddon a clean padding-free box; the amounts match the former CSS
        // padding, and both .pane and PANE_INSET live in the unzoomed #termlayer,
        // so the inset is a fixed px amount at every zoom level.
        const v = toViewportRect(slot);   // rect → unzoomed viewport px (#termlayer's space)
        const st = s.pane.style;
        st.display = 'block';
        st.left = (v.left + PANE_INSET.left) + 'px';
        st.top = (v.top + PANE_INSET.top) + 'px';
        st.width = Math.max(0, v.width - PANE_INSET.left - PANE_INSET.right) + 'px';
        st.height = Math.max(0, v.height - PANE_INSET.top - PANE_INSET.bottom) + 'px';
      });
      for (const s of sessions) if (!claimed.has(s.name)) s.pane.style.display = 'none';
      // reveal the layer once the first pane is placed; two rAFs let reflow's
      // fit() land + paint so the fade-in shows already-correct geometry.
      if (!termLayerReady && claimed.size) {
        termLayerReady = true;
        requestAnimationFrame(() => requestAnimationFrame(() => termLayer.classList.add('ready')));
      }
    }

    // Refit every terminal that's actually on screen. With tiling, more than one
    // pane can be visible at once, so we can't refit just `active`. A pane that's
    // display:none or collapsed to zero measures wrong (xterm geometry corrupts),
    // so skip anything with no box — it refits when it next becomes visible.
    function reflowAllVisible() {
      syncTermLayer();   // panes must cover their slots before we measure + fit
      for (const s of sessions) {
        const p = s.pane;
        if (p && p.offsetWidth > 0 && p.offsetHeight > 0 && s.fit) { s.fit.fit(); s.resize(); }
      }
      markStatus();
      // a live board webview is pinned to its pane's rect (same post-zoom px the
      // terminal panes use) — re-track it after any layout / resize / zoom change.
      scheduleLiveSync();
    }
    // back-compat alias: existing call sites still say reflowTerminal().
    function reflowTerminal() { reflowAllVisible(); }

    // mark the chosen tree row selected, clearing any prior one.
    function selectRow(row) {
      if (selectedRow && selectedRow !== row) selectedRow.classList.remove('selected');
      selectedRow = row || null;
      if (selectedRow) selectedRow.classList.add('selected');
      reportFocus();
    }

    // Report the page's current focus to the server so `spike context` (run in
    // the embedded terminal) can tell the agent what the user is looking at.
    // Debounced because a single open fires several state changes in a row
    // (select row, clear dirty, set view) — we only want the settled result.
    let focusTimer = null;
    function reportFocus() {
      if (focusTimer) clearTimeout(focusTimer);
      focusTimer = setTimeout(() => {
        focusTimer = null;
        const selPath = selectedRow && selectedRow.__node ? selectedRow.__node.path : null;
        // What the user has picked in the tree. Falls back to the open doc's row
        // when nothing is picked, which is what this reported before multi-select.
        const treeSel = selectedNodes().map((n) => n.path);
        // the focused pane's doc is "the open file" — it's where the next
        // open/save lands, which is what the agent cares about.
        const fpv = livePreview();
        const f = fpv ? fpv.file : null;
        // A docked live URL is the in-pane browser, not a file — report it through
        // `browser`, never `openFile`. The on-screen board (single native webview)
        // is the honest signal for "what page am I looking at", independent of
        // which pane holds keyboard focus, so key it off liveRenderBox/liveUrl.
        const fileIsLive = !!(f && f.liveurl);
        const liveBoardOn = !!(liveRenderBox && liveRenderBox.isConnected
          && liveRenderBox.classList.contains('show') && liveUrl);
        const body = {
          projectPath,
          openFile: fpv && f && !fileIsLive ? {
            path: f.path, name: f.name, view: fpv.view,
            binary: !!f.binary, tooBig: !!f.tooBig, media: f.media || null,
          } : null,
          browser: liveBoardOn ? { url: liveUrl } : null,
          // The open Brainstorm canvas — so `spike context` reports what's on the
          // board (the agent's orient tool is otherwise blind to the canvas).
          brainstorm: brainstormRef?.isOpen() ? brainstormRef.boardSummary() : null,
          selection: treeSel.length ? treeSel : (selPath ? [selPath] : []),
          dirty: !!(fpv && fpv.dirty),
          recent: recentFiles.slice(0, (appConfig && appConfig.logging && appConfig.logging.recentCount) || 10),
          // the active tab's workspace, so the server can fold that group's pinned
          // paths into `spike context`. Keyed on spawnGroup (the workspace the tab's
          // prompt was bound to at spawn), not the visual group — regrouping a live
          // tab recolors it but does NOT re-bind its agent, so pins must track the
          // prompt's group to stay consistent with it.
          activeGroup: active ? (active.spawnGroup || groupName(active.groupId)) : null,
          // every open tab across every preview pane, so the agent can see what's
          // pinned/held vs the live (ephemeral) slots it churns through. `active`
          // marks the doc the focused pane is showing.
          tabs: [...previews.values()].flatMap((p) => p.tabs.map((t) => ({
            path: t.path, name: t.name,
            ephemeral: !!t.ephemeral, dirty: !!t.dirty, active: !!(fpv && t === fpv.file),
          }))),
        };
        ipc.setFocus(body).catch(() => {});
      }, 120);
    }
    // push a path onto the MRU list (newest first, deduped, capped).
    function pushRecent(p) {
      if (!p) return;
      // keep the MRU at least as deep as the configured context count (≥10) so a
      // higher recentCount isn't silently truncated here before /focus slices it.
      const cap = Math.max(10, (appConfig && appConfig.logging && appConfig.logging.recentCount) || 10);
      recentFiles = [p, ...recentFiles.filter((x) => x !== p)].slice(0, cap);
    }

    // ─── lane-owned preview lifecycle (page level) ────────────────────────
    // A lane's terminal closed → dim the previews it opened, across every pane.
    // Called from Session.close while the session still exists, so markOrphaned
    // can snapshot the lane's live color/name before it's gone.
    function orphanLane(sessionId: string) {
      if (!sessionId) return;
      for (const pv of previews.values()) pv.markOrphaned(sessionId);
      sweepOrphans();   // dimming may push a pane over the visible-orphan cap
    }

    const ORPHAN_CAP = 6;        // max dimmed orphans kept visible per pane
    // newest first, for reopen. Carries the surface kind so a docked live URL or
    // web article reopens through the right door, not as a filesystem read.
    interface EvictedDoc { path: string; name: string; web?: boolean; liveurl?: boolean }
    let evictedOrphans: EvictedDoc[] = [];
    function pushEvicted(rec: EvictedDoc) {
      evictedOrphans = [rec, ...evictedOrphans.filter((x) => x.path !== rec.path)].slice(0, 12);
    }
    // Drop a path from the reopen buffer — it's back on screen by some route, so
    // the palette must stop offering to reopen it.
    function dropEvicted(path: string) {
      if (path) evictedOrphans = evictedOrphans.filter((x) => x.path !== path);
    }

    // The user moved on: trim each pane's dimmed orphans to the cap, stalest
    // (oldest MRU stamp) first. Never touches the active doc, the live ephemeral
    // slot, or a doc with unsaved edits — you never lose what you're looking at
    // or anything unsaved. Evicted paths stay reopenable from the palette (reopen
    // is cheap, so nothing is truly lost). Idempotent; safe on every open/focus.
    function sweepOrphans() {
      for (const pv of previews.values()) {
        const victims = pv.tabs
          .filter((t) => t.orphaned && t !== pv.file && !t.pinnedByUser && !t.dirty)
          .sort((a, b) => (a.lastTouchedAt || 0) - (b.lastTouchedAt || 0));   // stalest first
        const excess = victims.length - ORPHAN_CAP;
        for (let i = 0; i < excess; i++) {
          pushEvicted({ path: victims[i].path, name: victims[i].name, web: victims[i].web, liveurl: victims[i].liveurl });
          pv.dropPath(victims[i].path);
        }
      }
    }

    // Append a workflow event to the server's action log (~/.spike/logs/<day>.jsonl).
    // Spike only records; whatever reads the log back — Claude, a retro, a habit
    // audit — is the intelligence layer. Fire-and-forget; the server stamps the time.
    function logAction(action, payload) {
      ipc.logEvent(action, payload || {}).catch(() => {});
    }

    // a fresh tab record (ephemeral until edited). Lifecycle fields are reset
    // explicitly so recycling the live slot (resetTab → Object.assign) wipes any
    // stale ownership/orphan state from the doc it replaced.
    function newTab(path: string, name: string): PvDoc {
      return { path, name, content: '', draft: '', view: 'source', dirty: false,
               media: null, binary: false, tooBig: false, error: false, ephemeral: true, loaded: false, web: false, liveurl: false,
               ownerSessionId: undefined, pinnedByUser: false, orphaned: false,
               laneColorFrozen: undefined, laneNameFrozen: undefined, lastTouchedAt: undefined };
    }
    // recycle an existing ephemeral tab onto a new file (the live-slot reuse that
    // keeps browsing churn from accumulating tabs).
    function resetTab(tab: PvDoc, path: string, name: string) {
      Object.assign(tab, newTab(path, name));
    }

    // Open a file. Routes to the focused preview pane, else the first live one,
    // else a fresh pane in the default split — then the instance handles the
    // live-slot recycling (see Preview.openDoc). The routed pane becomes the
    // focused one, so follow-up opens keep landing where the last one did.
    function openFile(path, name, row, opts?) {
      selectRow(row);
      rememberOpened(path);   // out-of-tree files resolve by basename/folder later
      lastFilePath = path; lastFileName = name;
      pushRecent(path);
      noteTouched(path, 'opened', workspaceColorFor(opts && opts.owner));   // MRU; workspace hue if an agent lane opened it
      logAction('file_open', { path, name });
      dropEvicted(path);   // it's back on screen — stop offering to reopen it
      const pv = docPreview() || spawnPreview();
      focusedPreview = pv;
      pv.openDoc(path, name, opts);
      sweepOrphans();   // opening a new surface = moved on; trim stale orphans
    }

    // Open an external URL as a readable article in the preview (link → in-app
    // reader). Routes to the focused/first/new preview pane, same as openFile.
    function openWebArticle(url: string, owner?: string) {
      dropEvicted(url);
      const pv = docPreview() || spawnPreview();
      focusedPreview = pv;
      pv.openWeb(url, owner);
      logAction('web_open', { url });
      sweepOrphans();   // opening a new surface = moved on; trim stale orphans
    }

    // Is this an http(s) URL? Those dock live in the preview's in-pane browser
    // (a native child webview — its security boundary is the Rust is_http gate +
    // Tauri's capability model, NOT CSP, which only governs DOM <iframe>s). Any
    // other scheme falls back to the in-app reader.
    function isHttpUrl(url: string): boolean {
      try { const p = new URL(url).protocol; return p === 'http:' || p === 'https:'; }
      catch { return false; }
    }

    // `spike open <http(s)-url>`: docks live in the in-pane browser. Non-http
    // URLs (and any explicit reader entry point) fall through to openWebArticle.
    // The dedicated web pane. Reused across navigations so the in-pane browser
    // is a single standing surface beside your work — not a live tab that takes
    // over the artifact preview you're reading (which is what `livePreview()`
    // used to do: it returned the focused preview, so opening a URL while
    // reviewing a file replaced the file in that same pane). Anchors to the
    // right of the pane you're currently looking at; falls back to the default
    // dock when there's nothing to sit beside.
    function webPane(): Preview {
      if (webPvId && previews.has(webPvId)) return previews.get(webPvId)!;
      // Capture the anchor BEFORE makePreview — it repoints focusedPreview at
      // the new pane, so read the pane-you're-looking-at first.
      const anchor = focusedPreview && previews.has(focusedPreview.id) ? focusedPreview : null;
      const anchorLeaf = anchor
        ? findLeaf(layout.root, (s) => s.kind === 'preview' && s.id === anchor.id)
        : null;
      const pv = makePreview('pv' + (++pvSeq));
      webPvId = pv.id;
      if (anchorLeaf) {
        insertBeside(layout, anchorLeaf.id, previewLeaf(pv.id), 'right');
        // insertBeside is a silent no-op if the anchor dissolved mid-open; fall
        // back to the default dock so the web pane can never orphan.
        if (!hasSurface(layout.root, (s) => s.kind === 'preview' && s.id === pv.id)) {
          dockPreviewDefault(pv.id);
        } else {
          renderLayout();
          saveLayout();
        }
      } else {
        dockPreviewDefault(pv.id);
      }
      return pv;
    }

    function openUrl(url: string, owner?: string) {
      if (isHttpUrl(url)) {
        dropEvicted(url);
        const pv = webPane();
        focusedPreview = pv;
        pv.openLiveUrl(url, owner);
        lastLiveUrl = url;
        paintWebToggle();
        logAction('url_open', { url });
        sweepOrphans();
      } else {
        openWebArticle(url, owner);
      }
    }

    // The server's watcher reports which absolute paths changed. Any pane
    // showing one of them reloads live so an external edit shows without
    // reopening. (Background tabs keep their cache until activated.)
    function reloadOpenDoc(paths) {
      if (!Array.isArray(paths) || !paths.length) return;
      for (const pv of previews.values())
        if (pv.file && paths.includes(pv.file.path)) pv.reloadDoc(pv.file);
    }

    // Markdown source -> marked-ready source, handling two Obsidian-isms:
    //  1. ![[target]] embeds — images become real <img> via the raw file URL;
    //     embedded NOTES become transclusion placeholders filled async by
    //     fillEmbeds (top level only — inside an embed they become plain links,
    //     which also breaks embed cycles); anything else falls back to a link.
    //  2. [[Target]] / [[Target|Alias]] wikilinks -> wikilink: anchors,
    //     resolved + wired after render (wireWikilinks).
    const MD_IMG_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;
    // The rewrite rules themselves; mdedit owns the scan (one pass, and it
    // records WHERE each substitution landed so a visual edit can map a rendered
    // offset back to the real file). See mdedit.mdPreprocessMapped.
    const wikiHooks = (depth: number) => ({
      embed: (target: string, _anchor: string | undefined, alias: string | undefined) => {
        const p = resolveEmbed(target);
        if (p && MD_IMG_RE.test(p)) return `![${(alias || target).trim()}](${ipc.rawSrc(p)})`;
        if (p && /\.md$/i.test(p) && depth === 0)
          return `<span class="embed" data-embed-path="${encodeURIComponent(p)}"></span>`;
        return `[${(alias || target).trim()}](wikilink:${encodeURIComponent(target.trim())})`;
      },
      link: (target: string, _anchor: string | undefined, alias: string | undefined) =>
        `[${(alias || target).trim()}](wikilink:${encodeURIComponent(target.trim())})`,
    });
    function mdPreprocess(body, depth) {
      return mdPreprocessMapped(body, wikiHooks(depth)).out;
    }

    // Rewrite relative <img> srcs (![](attachments/x.png)) to raw file URLs.
    // Resolution order: relative to the note's folder, then the project root,
    // then a vault-wide basename match. Misses are left alone (still broken,
    // but no worse than before).
    function normalizeFsPath(p) {
      const out = [];
      for (const seg of p.split('/')) {
        if (seg === '..') out.pop();
        else if (seg && seg !== '.') out.push(seg);
      }
      return '/' + out.join('/');
    }

    // ── out-of-tree file resolution ──────────────────────────────────────
    // Agents cite files by bare name ("Discovery-Kit.md") or by a path that is
    // relative to somewhere that ISN'T the project root — the vault, another
    // repo, ~/Downloads. `fileIndex`/`allPaths` only know the project tree, so
    // those joined to projectPath name a file that doesn't exist and the
    // preview says "Couldn't open this file." Two extra sources close the gap:
    // the basenames of files we've actually seen this session (opened by the
    // user, read/edited by the agent), and every ancestor directory of those
    // files as a root a relative ref can be joined against. Candidates are
    // then STAT'd (path_stats, one batch call) and the first real file wins —
    // guessing is cheap, being wrong is not.
    const openedByBase = new Map<string, string>();   // lowercase basename → real absolute path
    const seenRoots: string[] = [];                   // absolute dirs worth joining a relative ref against
    function rememberOpened(p?: string | null) {
      if (!p || !p.startsWith('/')) return;
      const base = (p.split('/').pop() || '').toLowerCase();
      if (base) openedByBase.set(base, p);
      let dir = p.slice(0, p.lastIndexOf('/'));
      while (dir.length > 1) {
        if (!seenRoots.includes(dir)) seenRoots.push(dir);
        dir = dir.slice(0, dir.lastIndexOf('/'));
      }
      if (seenRoots.length > 400) seenRoots.splice(0, seenRoots.length - 400);
    }
    // The user's home dir, inferred from a path we know — enough to expand a
    // "~/…" ref the agent wrote. Null before the first tree load.
    function homeGuess(): string | null {
      const m = /^(\/(?:Users|home)\/[^/]+)(?:\/|$)/.exec(projectPath || seenRoots[seenRoots.length - 1] || '');
      return m ? m[1] : null;
    }
    // A cited file ref → the absolute path it really names. Async: the last
    // resort is asking the filesystem which candidate exists. Never rejects —
    // an unresolvable ref falls back to the old joined guess so the preview
    // still opens and shows its own message.
    async function resolveFileRef(ref: string): Promise<string> {
      let rel = (ref || '').trim().replace(/^\.\//, '');
      const home = homeGuess();
      if (rel.startsWith('~/') && home) rel = home + rel.slice(1);
      const abs = /^([/~]|[A-Za-z]:[\\/])/.test(rel);
      const name = (rel.split('/').pop() || rel).toLowerCase();
      const joined = abs ? rel : normalizeFsPath((projectPath || '').replace(/\/+$/, '') + '/' + rel);
      const cands: string[] = [];
      const push = (c?: string | null) => { if (c && c.startsWith('/') && !cands.includes(c)) cands.push(c); };
      if (abs) push(normalizeFsPath(rel));
      if (allPaths.has(joined)) push(joined);          // in the project tree: certain
      push(joined);                                     // project-root join: probe it
      if (!abs) {
        // Deepest root first — a specific folder we've been in beats "/Users".
        const roots = seenRoots.slice().sort((a, b) => b.split('/').length - a.split('/').length);
        for (const r of roots.slice(0, 40)) push(normalizeFsPath(r + '/' + rel));
      }
      push(fileIndex.get(name));                        // project basename index
      push(openedByBase.get(name));                     // seen this session
      if (!cands.length) return joined;
      if (cands.length === 1) return cands[0];
      try {
        const stats = await ipc.pathStats(null, cands.slice(0, 48));
        const hit = Array.isArray(stats) ? stats.find((st) => st && st.exists && !st.dir) : null;
        if (hit) return hit.path;
      } catch { /* stat unavailable — fall through to the old guess */ }
      return allPaths.has(joined) ? joined : (fileIndex.get(name) || openedByBase.get(name) || joined);
    }
    // One doc-relative image src → the absolute path it names, or null. Split out
    // of wireImages so the WYSIWYG editor can resolve the same way without
    // inheriting its "overwrite src and forget the original" behaviour.
    function resolveDocImage(src: string, fromPath: string) {
      if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src)) return null;   // already a URL (http, data, asset…)
      const dir = fromPath.slice(0, fromPath.lastIndexOf('/'));
      let rel = src;
      try { rel = decodeURIComponent(src); } catch {}
      return (rel.startsWith('/')
        ? [rel]
        : [normalizeFsPath(dir + '/' + rel), projectPath && normalizeFsPath(projectPath + '/' + rel)])
        .find((c) => c && allPaths.has(c))
        || fileIndex.get((rel.split('/').pop() || '').toLowerCase())
        || null;
    }
    function wireImages(container, fromPath) {
      container.querySelectorAll('img').forEach((img) => {
        const abs = resolveDocImage(img.getAttribute('src') || '', fromPath);
        if (abs) img.src = ipc.rawSrc(abs);
      });
    }
    // Same resolution for the editable surface, but the markdown path is stashed
    // in data-md-src first: this DOM is about to be turned back into the file, and
    // the turndown img rule writes that attribute rather than the asset: URL we
    // put on src to make the image visible. Read-only rendering can clobber src
    // freely; edit mode cannot.
    function wireEditImages(container: HTMLElement, fromPath: string) {
      container.querySelectorAll('img').forEach((img) => {
        const src = img.getAttribute('src') || '';
        if (!img.dataset.mdSrc) img.dataset.mdSrc = src;
        const abs = resolveDocImage(src, fromPath);
        if (abs) img.src = ipc.rawSrc(abs);
      });
    }

    // Render markdown to SANITIZED HTML before it ever touches innerHTML. The
    // preview lives in the privileged Tauri webview (full IPC: pty_spawn,
    // read_file, …), and the file being rendered is untrusted — an agent or a
    // cloned repo may have written it. Without this, a <script>/onerror/
    // javascript: in any opened .md is stored XSS → arbitrary local code.
    // DOMPurify strips script, event handlers and dangerous URLs; we widen the
    // URI allow-list by two schemes so our own URLs survive: `wikilink:` anchors
    // (wired by wireWikilinks after render) and `asset:` — the macOS/Linux form
    // of Tauri's file protocol that convertFileSrc bakes into ![[embed]] img
    // srcs (Windows' http://asset.localhost form already passes as http:; the
    // CSP allows asset: too, so this only closes the DOMPurify gap). The embed
    // <span data-embed-path> placeholders survive too — data-* and class are
    // allowed by default.
    const MD_URI_RE =
      /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|cid|xmpp|sms|wikilink|asset):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;
    function renderMarkdown(src: string) {
      return DOMPurify.sanitize(marked.parse(src), { ALLOWED_URI_REGEXP: MD_URI_RE });
    }

    // Chat code blocks (#25): upgrade marked's bare <pre><code> into a
    // Claude-grade block — hljs syntax highlighting (reusing the app's global,
    // theme-aware .hljs-* palette, so it reads in light AND dark), a header with
    // the language label + a Copy button, and horizontal scroll contained INSIDE
    // the block so a long line never scrolls the chat page sideways. Operates on
    // the ALREADY-sanitized HTML string and only adds TRUSTED nodes: hljs escapes
    // the source it highlights, and the header chrome is our own. The Copy button
    // carries no inline handler (it comes back through innerHTML) — a delegated
    // listener wires it (see the '.cw-code-copy' click handler). Chat-only: the
    // preview/editor keep their own code rendering.
    function enhanceCodeBlocks(html: string): string {
      if (html.indexOf('<pre') === -1) return html;   // no fenced blocks — cheap out
      const tpl = document.createElement('template');
      tpl.innerHTML = html;
      tpl.content.querySelectorAll('pre > code').forEach((code) => {
        const pre = code.parentElement as HTMLElement;
        const raw = code.textContent || '';
        const m = (code.getAttribute('class') || '').match(/language-([\w+#.\-]+)/i);
        const lang = m ? m[1] : '';
        // A friendly label when hljs knows the language ("ts" → "TypeScript"),
        // else the bare fence token, else nothing.
        let label = lang;
        try { if (window.hljs && lang && hljs.getLanguage(lang)?.name) label = hljs.getLanguage(lang).name; } catch { /* keep bare */ }
        // Highlight only a known language; unknown/none stays plain escaped text.
        if (window.hljs && lang && hljs.getLanguage(lang)) {
          try {
            code.innerHTML = hljs.highlight(raw, { language: lang, ignoreIllegals: true }).value;
            (code as HTMLElement).classList.add('hljs');
          } catch { /* leave as plain escaped text */ }
        }
        const wrap = document.createElement('div');
        wrap.className = 'cw-code';
        const head = document.createElement('div');
        head.className = 'cw-code-head';
        const lbl = document.createElement('span');
        lbl.className = 'cw-code-lang';
        lbl.textContent = label;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cw-code-copy';
        btn.title = 'Copy';
        btn.textContent = 'Copy';
        head.appendChild(lbl);
        head.appendChild(btn);
        pre.replaceWith(wrap);          // wrap takes the pre's place in the flow…
        wrap.appendChild(head);
        wrap.appendChild(pre);          // …then the pre moves inside it, under the header
      });
      return tpl.innerHTML;
    }
    // The chat markdown renderer: sanitized markdown + rich fenced code blocks.
    function renderChatMarkdown(src: string) {
      return enhanceCodeBlocks(renderMarkdown(src));
    }

    // ── WYSIWYG markdown edit round-trip ─────────────────────────────────
    // The edit surface is a contenteditable rendering of the doc BODY (frontmatter
    // is preserved verbatim and re-prepended on save). Deliberately NOT the same
    // decorated HTML the reader shows: we skip mdPreprocess so [[wikilinks]] and
    // ![[embeds]] stay literal text — they survive editing and turndown emits them
    // back byte-for-byte. One shared turndown instance, configured to match the
    // conventions the rest of the app writes (ATX headings, `-` bullets, fenced
    // code, `*`/`**` emphasis), plus the GFM plugin for tables/strike/task-lists.
    let _td: any = null;
    function turndowner() {
      if (_td) return _td;
      _td = new TurndownService({
        headingStyle: 'atx', hr: '---', bulletListMarker: '-',
        codeBlockStyle: 'fenced', emDelimiter: '*', strongDelimiter: '**',
        linkStyle: 'inlined',
      });
      if (typeof turndownPluginGfm !== 'undefined' && turndownPluginGfm.gfm) _td.use(turndownPluginGfm.gfm);
      // Images serialize from data-md-src, not src. While editing, a relative
      // path like `shot.png` has to be swapped to an asset: URL or it renders
      // broken (wireEditImages) — and that display URL must never be what lands
      // back in the file. The original path rides along in the data attribute and
      // is what we write; src is only the fallback for images we never rewrote.
      _td.addRule('mdImage', {
        filter: 'img',
        replacement: (_content: string, node: HTMLElement) => {
          const src = node.getAttribute('data-md-src') || node.getAttribute('src') || '';
          if (!src) return '';
          const alt = node.getAttribute('alt') || '';
          const title = node.getAttribute('title');
          return `![${alt}](${src}${title ? ` "${title.replace(/"/g, '&quot;')}"` : ''})`;
        },
      });
      return _td;
    }
    // markdown body → sanitized HTML for the editable surface.
    function mdToEditHtml(body: string) {
      return DOMPurify.sanitize(marked.parse(body), { ALLOWED_URI_REGEXP: MD_URI_RE });
    }
    // edited contenteditable → markdown body. Strip zero-width/nbsp noise WebKit
    // sprinkles into an empty contenteditable so a blank doc serializes clean.
    function editHtmlToMd(html: string) {
      let md = turndowner().turndown(html || '');
      // turndown escapes markdown-significant text, mangling the Obsidian-isms we
      // deliberately kept literal: [[wikilinks]] and ![[embeds]] come back as
      // \[\[…\]\]. Un-escape exactly those shapes (a genuine [link](url) is an <a>
      // element, serialized separately, so this never touches real links).
      md = md.replace(/(!?)\\\[\\\[([\s\S]*?)\\\]\\\]/g, '$1[[$2]]');
      // collapse turndown's marker padding ("-   x") to our house style ("- x")
      md = md.replace(/^(\s*)-   /gm, '$1- ');
      // task items get padded the same way ("- [x]  text"); a checkbox ticked in
      // the read view writes a single-space "- [x] text", so without this the same
      // line drifts to a double space the moment it round-trips through the editor.
      md = md.replace(/^(\s*[-*+] \[[ xX]\]) +/gm, '$1 ');
      return md.replace(/ /g, ' ').replace(/[​﻿]/g, '').replace(/[ \t]+$/gm, '');
    }

    // Readability for the in-app reader: turn a fetched page's raw HTML into the
    // article's title, byline, and a clean prose body. The body is parsed inert
    // (DOMParser runs no scripts), the densest content block is picked, links are
    // absolutised against the source URL (so a relative href can't navigate the
    // app), images/embeds are dropped (relative srcs break + it's a text reader),
    // and the result is DOMPurify-sanitized — it renders in the app's OWN DOM, so
    // this is the XSS→RCE boundary: untrusted HTML must never reach it raw.
    function extractArticle(html: string, url: string): { title: string; byline: string; html: string; lowConfidence: boolean } {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const meta = (sel: string) => doc.querySelector(sel)?.getAttribute('content')?.trim() || '';
      const title = meta('meta[property="og:title"]') || (doc.querySelector('title')?.textContent || '').trim();
      const byline = meta('meta[name="author"]') || meta('meta[property="article:author"]');
      doc.querySelectorAll('script,style,noscript,nav,header,footer,aside,form,button,svg,img,picture,figure,video,audio,iframe,object,embed')
        .forEach((n) => n.remove());
      let best: Element | null = doc.querySelector('article') || doc.querySelector('main');
      if (!best) {
        let top = 0;
        doc.querySelectorAll('div,section').forEach((el) => {
          const score = el.querySelectorAll('p').length * 60 + (el.textContent || '').length;
          if (score > top) { top = score; best = el; }
        });
      }
      const host = best || doc.body;
      if (host) {
        host.querySelectorAll('a[href]').forEach((a) => {
          try { a.setAttribute('href', new URL(a.getAttribute('href') || '', url).href); } catch {}
        });
        // space out adjacent inline elements (styled chips/tags get concatenated
        // into "tag1tag2tag3" when there's no whitespace text node between them).
        host.querySelectorAll('a,span,em,strong,code,b,i,small,time,label').forEach((el) => {
          if (el.nextSibling && el.nextSibling.nodeType === 1) el.after(document.createTextNode(' '));
        });
      }
      // confidence: an article is mostly prose; a thin page or one whose text is
      // mostly link-text (nav / card grid / app shell) extracted poorly.
      const allText = (host?.textContent || '').replace(/\s+/g, ' ').trim();
      const linkText = Array.from(host?.querySelectorAll('a') || [])
        .map((a) => a.textContent || '').join(' ').replace(/\s+/g, ' ').trim();
      const linkDensity = allText.length ? linkText.length / allText.length : 1;
      const lowConfidence = allText.length < 500 || linkDensity > 0.5;
      const raw = host ? host.innerHTML : '';
      // This is the XSS→RCE boundary: fully-untrusted remote HTML about to enter
      // the app's OWN (privileged) DOM. Use a strict ALLOW-list of prose tags +
      // attributes, NOT a deny-list — anything not named is dropped. We do NOT
      // widen ALLOWED_URI_REGEXP here (unlike the trusted-markdown path), so
      // DOMPurify's default rejects javascript:/data: hrefs.
      const clean = DOMPurify.sanitize(raw, {
        ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li',
          'blockquote', 'pre', 'code', 'em', 'strong', 'b', 'i', 'u', 's', 'a', 'span', 'div',
          'table', 'thead', 'tbody', 'tr', 'th', 'td', 'figure', 'figcaption', 'sup', 'sub',
          'mark', 'small', 'time', 'abbr', 'dl', 'dt', 'dd'],
        ALLOWED_ATTR: ['href', 'title', 'lang', 'dir'],
      });
      return { title, byline, html: clean, lowConfidence };
    }

    // Fill ![[note]] transclusion placeholders: fetch each note and render its
    // body inline as a quoted block. One level deep — mdPreprocess at depth 1
    // emits links, not placeholders, so this never recurses.
    function fillEmbeds(container, depth) {
      container.querySelectorAll('span.embed[data-embed-path]').forEach((box) => {
        let p = box.dataset.embedPath;
        try { p = decodeURIComponent(p); } catch {}
        const fileName = p.split('/').pop() || p;
        const head = document.createElement('span');
        head.className = 'embed-title';
        head.textContent = fileName.replace(/\.md$/i, '');
        head.title = p;
        head.addEventListener('click', () => openFile(p, fileName, null));
        const bodySpan = document.createElement('span');
        bodySpan.className = 'embed-body';
        box.append(head, bodySpan);
        ipc.readFile(p).then((d) => {
          if (d.binary || d.tooBig || typeof d.content !== 'string') { bodySpan.textContent = "Can't embed this file"; return; }
          const fm = parseFrontmatter(d.content);
          bodySpan.innerHTML = renderMarkdown(mdPreprocess(fm ? fm.body : d.content, depth + 1));
          wireWikilinks(bodySpan);
          wireImages(bodySpan, p);   // the embedded note resolves ITS relative images
        }).catch(() => { bodySpan.textContent = 'Failed to load embed'; });
      });
    }

    // Resolve + wire [[wikilink]] anchors inside rendered markdown. Resolved
    // links open the note in this panel; unresolved ones read as broken.
    function wireWikilinks(container) {
      container.querySelectorAll('a[href^="wikilink:"]').forEach((a) => {
        const target = decodeURIComponent(a.getAttribute('href').slice(9));
        const path = resolveWiki(target);
        a.classList.add('wikilink');
        if (!path) { a.classList.add('broken'); a.title = `No note named "${target}"`; }
        else a.title = path;
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const p = resolveWiki(target);
          if (p) openFile(p, p.split('/').pop(), null);
        });
      });
    }

    // Pull leading YAML frontmatter (--- ... ---) off a note. Returns
    // { props:[{key,val,arr}], body } or null. Light parser: key: value lines
    // and [a, b] arrays — enough for vault property blocks.
    function parseFrontmatter(text) {
      const m = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
      if (!m) return null;
      const props = [];
      for (const line of m[1].split(/\r?\n/)) {
        const mm = line.match(/^([A-Za-z0-9_ -]+):\s?(.*)$/);
        if (!mm) continue;
        const key = mm[1].trim();
        let val = mm[2].trim();
        const am = val.match(/^\[(.*)\]$/);
        const arr = am ? am[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : null;
        props.push({ key, val: arr ? null : val.replace(/^["']|["']$/g, ''), arr });
      }
      // `offset` is where the body starts in the FILE, so a visual edit's patch
      // lands at an absolute file position rather than a body-relative one.
      return { props, body: text.slice(m[0].length), offset: m[0].length };
    }

    function renderProps(props) {
      const box = document.createElement('div');
      box.className = 'props';
      for (const p of props) {
        const row = document.createElement('div'); row.className = 'prop';
        const k = document.createElement('div'); k.className = 'k'; k.textContent = p.key;
        const v = document.createElement('div'); v.className = 'v';
        if (p.arr) p.arr.forEach((t) => { const c = document.createElement('span'); c.className = 'chip'; c.textContent = t; v.appendChild(c); });
        else v.textContent = p.val;
        row.appendChild(k); row.appendChild(v); box.appendChild(row);
      }
      return box;
    }

    // build a syntax-highlighted <pre> via highlight.js (reuses .raw layout).
    function highlighted(text, lang) {
      const pre = document.createElement('pre');
      pre.className = 'raw hl';
      const code = document.createElement('code');
      try {
        if (window.hljs && lang && hljs.getLanguage(lang)) {
          code.innerHTML = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
        } else { code.textContent = text; }
      } catch { code.textContent = text; }
      pre.appendChild(code);
      return pre;
    }

    // ─── preview instance factory ─────────────────────────────────────
    // Stamps #pvtemplate into a live pane and owns ALL of its state: the tab
    // strip (with the one recyclable ephemeral slot), the highlighted editor,
    // the rendered views, dirty/save. Nothing in here touches another
    // instance — cross-pane policy (routing, focus, the footer toggle) lives
    // on the module-level helpers around openFile.
    function makePreview(id: string): Preview {
      const tmpl = document.getElementById('pvtemplate') as HTMLTemplateElement;
      const root = (tmpl.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
      root.dataset.previewId = id;
      // True while the doc on screen was peeked from the file tree: setView
      // skips its editor.focus() so the tree keeps the keyboard and ↑/↓ (and
      // ⇧↑/↓) go on walking rows, the way an explorer pane behaves. Any click
      // in the pane, or any other kind of open, clears it.
      let holdFocus = false;
      const q = (sel: string) => root.querySelector(sel) as HTMLElement;
      const head = q('.pvhead');
      const tabStrip = q('.pvtabs');
      const saveEl = q('.pvsave');
      const saveLbl = q('.pvsave .lbl');
      const segEl = q('.seg');
      const sourceBtn = q('.pvsource');
      const renderedBtn = q('.pvrendered');
      const bodyEl = q('.pvbody');
      const editWrap = q('.pveditwrap');
      const editor = q('.pveditor') as HTMLTextAreaElement;
      const hlPre = q('.pvhl');
      const hlCode = q('.pvhl code');
      const renderBox = q('.pvrender');
      const notesBtn = q('.pvnotesbtn');
      const toolbar = q('.pvtoolbar');
      const pencilBtn = q('.pvpencil') as HTMLButtonElement;
      sourceBtn.innerHTML = icon('code', 15);
      renderedBtn.innerHTML = icon('eye', 15);
      pencilBtn.innerHTML = icon('pencil', 15);
      notesBtn.addEventListener('click', () => toggleSide());
      // Edit mode is ONE row: relocate the formatting bar from the body up into
      // the header (between the tabs and the save/view controls), shown only
      // while editing. Done is the single way out of that row (the view segment
      // hides while editing — see syncSeg — because both of its halves were just
      // alternate exits duplicating Done and ⌘E).
      head.insertBefore(toolbar, saveEl);
      // …plus an explicit "Done", which ABSORBS the save flag while editing: it
      // saves to disk, so its own glyph is the honest place for "there is
      // something unsaved" — a dot when there is, a check when there isn't. A
      // separate wordless dot beside it just read as a sixth tool. The flag comes
      // back only when it has a word worth reading ("saved", "save failed").
      const doneBtn = document.createElement('button');
      doneBtn.type = 'button'; doneBtn.className = 'pvdone'; doneBtn.title = 'Save and finish editing (⌘E)';
      doneBtn.innerHTML = `<span class="mark">${icon('check', 14)}</span><span>Done</span>`;
      doneBtn.addEventListener('click', () => { if (htmlEditing) exitHtmlEdit(true); else exitEdit(true); });
      head.insertBefore(doneBtn, saveEl.nextSibling);
      // The header is what squeezes the toolbar, so watch it rather than the
      // window: a pane dragged narrower resizes this and nothing else.
      try { new ResizeObserver(() => { if (editing) syncToolbarOverflow(); }).observe(head); } catch {}
      // WYSIWYG edit mode: rendered markdown made contenteditable + formatting
      // bar. Transient (never persisted per-doc) — committed & left on any view
      // change, tab switch, or save. rawFm holds the doc's frontmatter block so
      // the parts we don't edit round-trip byte-for-byte. This is the only way to
      // edit the rendered pane — there is no click-into-a-block path.
      let editing = false;
      let editRawFm = '';
      // The source/rendered segment is allowed by file type (setView decides) but
      // withheld while editing: in WYSIWYG both halves are just alternate ways out,
      // duplicating Done and ⌘E, and two more targets in the busiest row is what
      // made it read as crowded. Kept as a variable + sync so the two conditions
      // can't fight over one inline style.
      let segAllowed = false;
      const syncSeg = () => { segEl.style.display = segAllowed && !editing ? '' : 'none'; };
      // When a fresh, empty markdown doc lands in a pane that was mid-WYSIWYG
      // (e.g. quick-capture fired while you were editing a rendered note), open
      // it the same way — in the rendered editor — instead of dropping to the
      // raw source view. Captured in openDoc before activateTab tears the
      // outgoing edit down; consumed and cleared in loadTabContent's empty arm.
      let openBlankInEdit = false;

      // live-split orientation is a shared preference: 'col' stacks editor over
      // rendered (top/bottom), 'row' sits them side by side (left/right). Live
      // view has no button of its own — it's a ⌘K command (see toggleLiveSplit),
      // which is why the segmented control only carries source and rendered.
      const LIVE_SPLIT_KEY = 'spike-live-split';
      const liveSplit = (): 'row' | 'col' => {
        try { return localStorage.getItem(LIVE_SPLIT_KEY) === 'row' ? 'row' : 'col'; } catch { return 'col'; }
      };
      const applyLiveSplit = (o: 'row' | 'col') => {
        // .vsplit is inert unless .live is also present (set by setView), so we
        // can toggle it unconditionally — it only takes effect in live mode.
        bodyEl.classList.toggle('vsplit', o === 'col');
      };
      const setLiveSplit = (o: 'row' | 'col') => {
        try { localStorage.setItem(LIVE_SPLIT_KEY, o); } catch {}
        applyLiveSplit(o);
      };
      applyLiveSplit(liveSplit());

      // open-document state. `tabs` is every doc in THIS pane; `file` aliases
      // the active one. At most one tab is `ephemeral: true` — the recyclable
      // "live" slot the agent + tree churn through, so browsing never piles up
      // tabs. The moment you edit a tab it promotes (ephemeral → false) and is
      // protected: the next open spawns a fresh live tab beside it instead of
      // recycling it shut.
      let tabs: PvDoc[] = [];
      let file: PvDoc | null = null;
      let view: 'source' | 'rendered' | 'live' = 'source';   // mirrors file.view
      // undo bookkeeping: the editor value BEFORE the in-flight input event,
      // and the time of the last keystroke (a >600ms gap closes an undo step,
      // so ⌘Z rewinds bursts of typing, not single characters).
      let lastSeen = '';
      let lastEditAt = 0;
      let dirty = false;                            // mirrors file.dirty
      let savedTimer: ReturnType<typeof setTimeout> | null = null;
      let closing = false;                          // mid-fade-out; gates re-entry

      // The save flag is hidden when the file is clean, shows "unsaved" while
      // dirty, and flashes "saved" briefly after a save before hiding again.
      // paintSavePill is paint-only (no state change), split out so activating
      // a tab can reflect its dirty state without re-firing a save.
      // While editing the flag steps aside entirely and Done's own glyph carries
      // dirtiness (see doneBtn): Done writes to disk, so "unsaved" beside it was
      // two claims about one state, and a wordless dot in that row read as
      // another tool. The flag returns for the things that need words — the
      // "saved" flash and "save failed".
      function paintSavePill() {
        if (savedTimer) { clearTimeout(savedTimer); savedTimer = null; }
        doneBtn.classList.toggle('dirty', dirty);
        if (dirty && !editing) { saveEl.classList.add('show', 'dirty'); saveLbl.textContent = 'unsaved'; }
        else { saveEl.classList.remove('show', 'dirty'); saveLbl.textContent = ''; }
      }
      function setDirty(d: boolean) {
        dirty = d;
        if (file) file.dirty = d;
        paintSavePill();
        renderPvTabs();   // the doc pill carries a dirty dot
        reportFocus();
      }
      function flashSaved() {
        if (savedTimer) clearTimeout(savedTimer);
        saveEl.classList.remove('dirty');
        saveEl.classList.add('show');
        saveLbl.textContent = 'saved';
        savedTimer = setTimeout(() => {
          if (!dirty) { saveEl.classList.remove('show'); saveLbl.textContent = ''; }
          savedTimer = null;
        }, 1300);
      }

      // re-highlight the editor backdrop from the textarea's current value.
      function highlightEditor() {
        const lang = file ? editorLang(file.name) : null;
        const text = editor.value;
        try {
          if (window.hljs && lang && hljs.getLanguage(lang)) {
            hlCode.innerHTML = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
          } else { hlCode.textContent = text; }
        } catch { hlCode.textContent = text; }
        // a trailing newline must be mirrored so the last line aligns.
        if (text.endsWith('\n')) hlCode.innerHTML += '\n';
      }
      function syncEditorScroll() {
        hlPre.scrollTop = editor.scrollTop;
        hlPre.scrollLeft = editor.scrollLeft;
      }

      // make sure this pane's surface is in the tree and forward in its stack.
      function ensureVisible() {
        const lf = findLeaf(layout.root, (s) => s.kind === 'preview' && s.id === id);
        if (!lf) { dockPreviewDefault(id); return; }   // defensive: re-seat a lost surface
        const i = lf.surfaces.findIndex((s) => s.kind === 'preview' && s.id === id);
        if (lf.activeIndex !== i) {
          lf.activeIndex = i;
          renderLayout();
          saveLayout();
        }
      }

      // Open a doc here. New opens land in the single ephemeral "live" slot,
      // recycling it; re-opening an already-open path re-activates its tab.
      function openDoc(path: string, name: string, opts?: { reload?: boolean; owner?: string; pin?: boolean; keepFocus?: boolean }) {
        // A peek from the file tree leaves the keyboard where it was; every other
        // open (palette, `spike open`, a drop) still lands the caret in the doc.
        holdFocus = !!(opts && opts.keepFocus);
        ensureVisible();
        root.classList.add('open');
        requestAnimationFrame(() => root.classList.add('shown'));  // fade in
        paintPreviewToggle();
        // Read the pane's WYSIWYG state now, before activateTab commits + exits
        // the outgoing edit: a brand-new blank note opened while editing should
        // inherit the rendered editor (see loadTabContent's empty-file arm).
        const wasEditing = editing;

        const existing = tabs.find((t) => t.path === path);
        if (existing) {
          stampOwner(existing, opts && opts.owner);   // before activateTab, which repaints the strip
          activateTab(existing);
          // A re-open via `spike open` should show live bytes, not the cached copy.
          if (opts && opts.reload) reloadTab(existing);
          if (opts && opts.pin) setTabPinned(existing, true);
          return;
        }

        let tab = tabs.find((t) => t.ephemeral);   // the lone recyclable slot, if any
        if (tab) resetTab(tab, path, name);
        else { tab = newTab(path, name); tabs.push(tab); }
        stampOwner(tab, opts && opts.owner);
        openBlankInEdit = wasEditing;   // consumed by loadTabContent iff the doc is empty markdown
        activateTab(tab);    // makes it active, then loads its content
        // A caller opening several docs at once pins each so the next one spawns
        // a tab instead of recycling this slot out from under it.
        if (opts && opts.pin) setTabPinned(tab, true);
      }

      // Record who opened a doc. A `spike open` from a lane carries that lane's
      // session id → the doc is lane-owned (wears the lane color, follows the
      // orphan lifecycle). An owner-less open is a user action (tree/⌘-click,
      // palette reopen) → born user-owned: neutral and immune. Re-opening a doc
      // the user already claimed never lets a later `spike open` steal it.
      function stampOwner(tab: PvDoc, owner: string | undefined) {
        if (owner) {
          if (tab.pinnedByUser) return;          // user owns it; don't reattribute
          tab.ownerSessionId = owner;
          tab.orphaned = false;                  // a fresh open un-orphans it
          tab.laneColorFrozen = undefined; tab.laneNameFrozen = undefined;
        } else {
          tab.pinnedByUser = true;
          tab.ownerSessionId = undefined;
          tab.orphaned = false;
        }
      }

      // Open an external link as a readable article (path is the URL). Mirrors
      // openDoc: recycle the live slot or spawn a tab, mark it web, let
      // loadTabContent fetch + extract. Re-opening the same URL just re-focuses.
      function openWeb(url: string, owner?: string) {
        ensureVisible();
        root.classList.add('open');
        requestAnimationFrame(() => root.classList.add('shown'));
        paintPreviewToggle();
        const existing = tabs.find((t) => t.path === url);
        if (existing) { stampOwner(existing, owner); activateTab(existing); return; }
        let tab = tabs.find((t) => t.ephemeral);
        if (tab) resetTab(tab, url, 'Loading…');
        else { tab = newTab(url, 'Loading…'); tabs.push(tab); }
        tab.web = true;
        stampOwner(tab, owner);
        activateTab(tab);
      }

      // Dock a live URL in the preview (`spike open http(s)://…`): the in-pane
      // browser. Like openWeb but the page renders live in a native child webview
      // (see renderLiveUrl) rather than being fetched + read — so it stays fully
      // interactive. Recycles the live slot; re-opening the same URL re-focuses.
      function openLiveUrl(url: string, owner?: string) {
        ensureVisible();
        root.classList.add('open');
        requestAnimationFrame(() => root.classList.add('shown'));
        paintPreviewToggle();
        const existing = tabs.find((t) => t.path === url);
        if (existing) { stampOwner(existing, owner); activateTab(existing); return; }
        let name = url;
        try { const u = new URL(url); name = u.host + (u.pathname === '/' ? '' : u.pathname); } catch {}
        let tab = tabs.find((t) => t.ephemeral);
        if (tab) resetTab(tab, url, name);
        else { tab = newTab(url, name); tabs.push(tab); }
        tab.liveurl = true;
        stampOwner(tab, owner);
        activateTab(tab);
      }

      // Merge another instance's docs in (center-dropping one preview pane onto
      // another). Doc objects ride over whole — content, draft, dirty and
      // promotion survive the move. Collision rules mirror openDoc: a path
      // already open here keeps its resident tab (an incoming unsaved draft
      // carries over rather than vanish); an incoming ephemeral recycles this
      // pane's live slot, since only one may exist per pane.
      function adoptDocs(docs: PvDoc[], focus?: PvDoc | null) {
        let land: PvDoc | null = null;
        for (const d of docs) {
          const resident = tabs.find((t) => t.path === d.path);
          if (resident) {
            if (d.dirty && !resident.dirty) { resident.draft = d.draft; resident.dirty = true; }
            if (!d.ephemeral) resident.ephemeral = false;   // promotion is sticky
            if (!land || d === focus) land = resident;
            continue;
          }
          if (d.ephemeral) {
            const slot = tabs.find((t) => t.ephemeral);
            if (slot) tabs[tabs.indexOf(slot)] = d;
            else tabs.push(d);
          } else tabs.push(d);
          if (!land || d === focus) land = d;
        }
        if (land) {
          // the replaced live slot may have been this pane's active doc; null it
          // so activateTab can't stash the editor into a dropped object.
          if (file && !tabs.includes(file)) file = null;
          activateTab(land);
        } else renderPvTabs();
        reportFocus();
      }

      // Make a tab the active document: stash the outgoing tab's working text,
      // restore (or load) this one's, and repaint the strip + view.
      function activateTab(tab: PvDoc) {
        // An open edit belongs to the OUTGOING doc, so it has to land before
        // `file` moves — otherwise it would be serialized against the wrong
        // source and silently dropped.
        if (editing && file !== tab) exitEdit(true);
        // an in-place HTML edit can't round-trip synchronously across the sandbox;
        // switching tabs rebuilds the frame from disk, so just tear the edit down
        // (unsaved in-place edits are discarded — Done / ⌘S are the save paths).
        if (htmlEditing && file !== tab) htmlEditTeardown();
        if (file && file !== tab && !file.media && !file.binary && !file.tooBig) {
          file.draft = editor.value;   // keep the outgoing tab's unsaved edits in memory
        }
        file = tab;
        tab.lastTouchedAt = ++pvTouchSeq;   // MRU: the active doc is the freshest
        // Engaging with a dimmed orphan brings it back: un-dim it so it's no
        // longer faded and no longer an eviction target (it keeps its frozen lane
        // color until claimed). You never re-lose the thing you just reopened.
        tab.orphaned = false;
        renderPvTabs();
        if (!tab.loaded) { loadTabContent(tab); return; }
        // already loaded — restore from memory, no refetch.
        if (!tab.media && !tab.binary && !tab.tooBig) { editor.value = tab.draft; lastSeen = tab.draft; lastEditAt = 0; }
        dirty = tab.dirty;
        paintSavePill();
        setView(tab.view);
      }

      // Fetch a tab's content and paint it — but only touch the DOM if it's still
      // the active tab AND still loading the same file when the fetch resolves. The
      // identity check alone isn't enough: recycling the ephemeral slot reuses the
      // SAME object, so a fast A-then-B open would let A's late response paint into
      // the now-B tab. A per-load token (re-stamped on every load) settles it.
      function loadTabContent(tab: PvDoc) {
        const { path, name } = tab;
        const load = (tab.loadToken = {});   // a fresh load stamps the tab; older in-flight loads go stale
        const current = () => file === tab && tab.loadToken === load;
        const intoEdit = openBlankInEdit;   // one-shot: this load owns the "open blank in WYSIWYG" intent
        openBlankInEdit = false;            // clear now so it can never leak to a later, unrelated load
        if (tab.liveurl) {   // nothing to fetch — the iframe loads the page itself
          tab.loaded = true;
          if (current()) { setDirty(false); setView('rendered'); }
          return;
        }
        if (tab.web) {   // a fetched web article — read over curl, not the filesystem
          ipc.fetchUrl(path).then((html) => {
            if (tab.loadToken !== load) return;
            const art = extractArticle(html, path);
            tab.content = art.html; tab.byline = art.byline; tab.lowconf = art.lowConfidence;
            if (art.title) tab.name = art.title;
            tab.loaded = true;
            if (current()) { setDirty(false); renderPvTabs(); setView('rendered'); }
          }).catch((err) => {
            if (tab.loadToken !== load) return;
            tab.error = true; tab.loaded = true;
            tab.errMsg = ipc.errorMessage(err, 'could not load this page');
            if (current()) setView('rendered');
          });
          return;
        }
        // Images, PDFs, audio, video render straight from /raw — no text, no editor.
        const media = IMG_EXT.test(name) ? 'image' : PDF_EXT.test(name) ? 'pdf'
          : AUDIO_EXT.test(name) ? 'audio' : VIDEO_EXT.test(name) ? 'video' : null;
        if (media) {
          tab.media = media; tab.loaded = true;
          if (current()) { setDirty(false); setView('rendered'); }
          return;
        }
        ipc.readFile(path).then((data) => {
          if (tab.loadToken !== load) return;   // recycled mid-flight → this response is stale
          if (data.binary || data.tooBig) {
            tab.binary = !!data.binary; tab.tooBig = !!data.tooBig; tab.loaded = true;
            if (current()) { setDirty(false); setView('rendered'); }   // calm message
            return;
          }
          // A reload that replaces real text (the agent saved over it) becomes
          // an undoable step — ⌘Z can bring the pre-reload version back.
          if (tab.loaded && tab.draft !== (data.content || '')) {
            (tab.undo = tab.undo || []).push({ v: tab.draft, s: 0, e: 0 });
            tab.redo = [];
          }
          tab.content = data.content || ''; tab.draft = tab.content; tab.loaded = true;
          if (current()) {
            editor.value = tab.draft;
            lastSeen = tab.draft;
            lastEditAt = 0;
            setDirty(false);
            // An empty file (e.g. one just created from the tree) has nothing to
            // render, so drop straight into the editor to start typing — no blank
            // preview. Otherwise: md/html/csv render; code/json/text open in editor.
            // A doc the user put in live mode stays there across reloads (the
            // agent saving to disk must not kick the split away mid-edit).
            if (tab.content.trim() === '' && intoEdit && canEdit()) enterEdit();   // inherit the WYSIWYG editor
            else setView(tab.content.trim() === '' ? 'source'
              : tab.view === 'live' ? 'live' : defaultViewFor(name));
          }
        }).catch(() => {
          if (tab.loadToken !== load) return;   // stale failure from a recycled load
          tab.error = true; tab.loaded = true;
          if (current()) {
            setDirty(false);
            setView('rendered');
            renderBox.innerHTML = '';
            const msg = document.createElement('div');
            msg.className = 'pvmsg';
            msg.textContent = "Can't open this file";
            renderBox.appendChild(msg);
          }
        });
      }

      // Re-fetch a tab's content from disk and repaint it. Used when the file
      // changed underneath us (the watcher's push, or a `spike open` on the
      // already-open doc) so the pane shows live bytes, not the cached copy.
      // Unsaved editor edits win — never clobber a dirty buffer.
      function reloadTab(tab: PvDoc) {
        if (!tab || tab.dirty) return;
        tab.loaded = false; tab.media = null; tab.binary = false; tab.tooBig = false; tab.error = false;
        loadTabContent(tab);
      }

      // Pin/unpin a tab. Pinning just clears ephemeral (same seam as the hover
      // pin / typing). Unpinning makes this the recyclable live slot again —
      // there's at most one ephemeral tab, so demote any other first.
      function setTabPinned(t: PvDoc, pinned: boolean) {
        if (pinned) { t.ephemeral = false; }
        else { for (const o of tabs) o.ephemeral = false; t.ephemeral = true; t.pinnedByUser = false; }
        renderPvTabs();
        reportFocus();
      }
      // Close every tab except `keep`. keep stays, so closeTab never hits its
      // last-tab → closeInstance path; dirty tabs still prompt individually.
      function closeOthers(keep: PvDoc) {
        for (const o of [...tabs]) if (o !== keep) closeTab(o);
        if (file !== keep) activateTab(keep);
      }
      // Copy text to the clipboard. The webview runs on a secure origin
      // (tauri.localhost), so the async Clipboard API is available; swallow the
      // rejection if a build ever lacks the permission rather than throw page-side.
      function copyText(s: string) {
        try { navigator.clipboard?.writeText(s); } catch {}
      }
      // Right-click file-actions menu for a tab. Uses the shared popup menu
      // (hosted in #toplayer, so it shows over the terminal). Path actions hit
      // the OS; copy is page-side.
      function openTabMenu(t: PvDoc, x: number, y: number) {
        const rel = projectPath && t.path.startsWith(projectPath + '/')
          ? t.path.slice(projectPath.length + 1) : t.path;
        const fail = (e: unknown, what: string) => { status.textContent = ipc.errorMessage(e, what); };
        const canClaim = t.ephemeral || (t.ownerSessionId && !t.pinnedByUser);
        const items: any[] = [
          { label: canClaim ? 'Keep open' : 'Unpin', fn: () => canClaim ? claimDoc(t) : setTabPinned(t, false) },
          { sep: true },
          { label: 'Copy path', fn: () => copyText(t.path) },
          { label: 'Copy relative path', fn: () => copyText(rel) },
          { label: 'Reveal in Finder', fn: () => ipc.revealPath(t.path).catch((e) => fail(e, 'reveal failed')) },
          { sep: true },
          { label: 'Share…', fn: () => ipc.shareFile(t.path, x, y).catch((e) => fail(e, 'share failed')) },
          { sep: true },
          { label: 'Close', fn: () => closeTab(t) },
        ];
        if (tabs.length > 1) items.push({ label: 'Close others', fn: () => closeOthers(t) });
        openMenu(x, y, items);
      }

      // Render the header's doc pills. Every doc is a .pill — the single-file
      // case is just a one-pill bar, so the header reads like every other tab
      // strip (no separate name + × mode). The un-promoted live-slot doc gets a
      // hover pin that promotes it; the last pill's × closes the whole pane
      // (via closeTab), so no standalone close button is needed.
      function renderPvTabs() {
        tabStrip.innerHTML = '';
        // Coalesce orphaned docs by owning lane: a lane with ≥2 dimmed docs
        // renders as ONE cluster pill ("N from <lane>") instead of N chips. The
        // active doc always renders expanded (never hidden inside a cluster), so
        // it's excluded from the count and from cluster membership.
        const orphanCount = new Map<string, number>();
        for (const t of tabs)
          if (t.orphaned && t !== file && t.ownerSessionId)
            orphanCount.set(t.ownerSessionId, (orphanCount.get(t.ownerSessionId) || 0) + 1);
        const clustered = new Set<string>();
        for (const t of tabs) {
          const owner = t.ownerSessionId;
          if (t.orphaned && t !== file && owner && (orphanCount.get(owner) || 0) >= 2) {
            if (clustered.has(owner)) continue;        // one pill per lane
            clustered.add(owner);
            tabStrip.appendChild(makeClusterChip(owner));
            continue;
          }
          tabStrip.appendChild(makeTabChip(t));
        }
      }

      // One doc pill. Wears the owning lane's color (a left accent) while live;
      // dims when orphaned; neutral once the user has claimed it.
      function makeTabChip(t: PvDoc): HTMLElement {
        const chip = document.createElement('span');
        chip.className = 'pvtab pill' + (t === file ? ' active' : '') + (t.ephemeral ? ' ephemeral' : '') + (t.dirty ? ' dirty' : '') + (t.orphaned ? ' orphaned' : '');
        chip.title = t.name;
        const col = laneColorFor(t);
        if (col) { chip.style.setProperty('--lane', col); chip.classList.add('lane'); }
        const lbl = document.createElement('span');
        lbl.className = 'nm';
        lbl.textContent = t.name;
        chip.appendChild(lbl);
        // Dirty dot as a real sibling, not a ::after on .nm — inside the label it
        // shared the label's ellipsis, so the one case that most needs the signal
        // (a long name in a crowded strip) was the case that hid it.
        if (t.dirty) {
          const dot = document.createElement('span');
          dot.className = 'dirt';
          dot.textContent = '•';
          chip.appendChild(dot);
        }
        // Pin/claim affordance: the live-slot promote (ephemeral) AND the "this
        // is mine" claim on a lane-owned doc both resolve to claimDoc — keep it
        // open, go neutral, immune from the orphan lifecycle.
        if (t.ephemeral || (t.ownerSessionId && !t.pinnedByUser)) {
          const pin = document.createElement('span');
          pin.className = 'ctl pin';
          pin.title = 'keep open';
          pin.innerHTML = icon('pin', 12);
          pin.addEventListener('click', (e) => { e.stopPropagation(); claimDoc(t); });
          chip.appendChild(pin);
        }
        const x = document.createElement('span');
        x.className = 'ctl x';
        x.title = 'close';
        x.innerHTML = icon('x', 12);
        chip.appendChild(x);
        chip.addEventListener('click', (e) => { if (!(e.target as HTMLElement).closest('.ctl')) activateTab(t); });
        x.addEventListener('click', (e) => { e.stopPropagation(); closeTab(t); });
        // double-click toggles pin/unpin (VS Code-style); preventDefault stops
        // WebKit's word-select + native Look Up menu on the label.
        chip.addEventListener('dblclick', (e) => {
          if ((e.target as HTMLElement).closest('.ctl')) return;
          e.preventDefault();
          if (t.ephemeral || (t.ownerSessionId && !t.pinnedByUser)) claimDoc(t);
          else setTabPinned(t, false);
        });
        // right-click → our own file-actions menu (hosted above the terminal),
        // replacing WebKit's native text menu.
        chip.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openTabMenu(t, e.clientX, e.clientY); });
        return chip;
      }

      // The coalesced orphan pill for one closed lane. Dim, wears the lane's
      // frozen color, labeled "N from <lane>". Click expands to its members.
      function makeClusterChip(owner: string): HTMLElement {
        const members = tabs.filter((x) => x.orphaned && x !== file && x.ownerSessionId === owner);
        const chip = document.createElement('span');
        chip.className = 'pvtab pill cluster orphaned';
        const col = members[0] && laneColorFor(members[0]);
        if (col) { chip.style.setProperty('--lane', col); chip.classList.add('lane'); }
        const lbl = document.createElement('span');
        lbl.className = 'nm';
        lbl.textContent = `${members.length} from ${laneNameFor(members[0])}`;
        chip.title = members.map((m) => m.name).join('\n');
        chip.appendChild(lbl);
        chip.addEventListener('click', (e) => {
          const items: any[] = members.map((m) => ({ label: m.name, fn: () => activateTab(m) }));
          items.push({ sep: true });
          items.push({ label: 'Close all', fn: () => { for (const m of [...members]) closeTab(m); } });
          openMenu(e.clientX, e.clientY, items);
        });
        return chip;
      }

      // Claim a doc as the user's own: keep it open (out of the recycler),
      // neutral (no lane color), and immune from the orphan/evict lifecycle.
      // The single seam behind the hover pin, the double-click, and reopening an
      // evicted orphan.
      function claimDoc(t: PvDoc) {
        t.pinnedByUser = true;
        t.ephemeral = false;
        t.orphaned = false;
        t.laneColorFrozen = undefined; t.laneNameFrozen = undefined;
        renderPvTabs();
        reportFocus();
      }

      // The owning lane's tab closed: dim this lane's still-owned, unclaimed docs
      // in this pane. They stay readable (never hard-closed here) and coalesce in
      // the strip; eviction removes them later once the user has moved on.
      // Snapshot the lane's color/name NOW — the session is about to be gone and
      // can't be resolved afterward. Clearing `ephemeral` pulls the doc out of
      // the recycler so a later `spike open` can't overwrite the orphan.
      function markOrphaned(sessionId: string) {
        let touched = false;
        for (const t of tabs) {
          if (t.ownerSessionId !== sessionId || t.pinnedByUser || t.orphaned) continue;
          t.laneColorFrozen = laneColorFor(t) || undefined;
          t.laneNameFrozen = laneNameFor(t);
          t.orphaned = true;
          t.ephemeral = false;
          touched = true;
        }
        if (touched) renderPvTabs();
      }

      // Close one tab. The last tab closes the whole pane (instance and all);
      // otherwise drop just this tab and fall to a neighbor. Only a dirty tab
      // prompts — switching away never loses edits, they stay in the tab.
      function closeTab(tab: PvDoc) {
        if (tabs.length <= 1) { closeInstance(); return; }
        if (tab.dirty && !confirm('You have unsaved edits. Discard them?')) return;
        const idx = tabs.indexOf(tab);
        tabs.splice(idx, 1);
        logAction('file_close', { path: tab.path, name: tab.name });
        if (file === tab) {
          const next = tabs[idx] || tabs[idx - 1] || tabs[0];
          file = null;            // skip activateTab's stash from the tab we just removed
          activateTab(next);
        } else {
          renderPvTabs();
          reportFocus();
        }
      }

      // switch the active view and (re)paint it.
      function setView(v: 'source' | 'rendered' | 'live') {
        // WYSIWYG edit is a mode layered over the rendered view — any explicit
        // view change (segment click, tab switch, ⌘S) first commits + leaves it,
        // so the raw-source and live modes never fight a live contenteditable.
        if (editing) exitEdit(true);
        if (htmlEditing) htmlEditTeardown();   // leaving rendered drops any in-place HTML edit
        const media = file && file.media;
        const web = file && (file.web || file.liveurl);
        const renderable = file && hasRendered(file.name);
        // Who gets the toggle: only media-less files that have a real rendered
        // view. Code/json/plain text are editor-only; media + web/live URLs are
        // rendered-only.
        segAllowed = !!(!media && !web && renderable);
        syncSeg();
        if (media || web) v = 'rendered';
        else if (!renderable) v = 'source';   // code/json/text: editor only
        view = v;
        if (file) file.view = v;
        // Live shows both halves, so light both segments — otherwise the control
        // would read as "nothing selected" in a mode with no button of its own.
        // Clicking either one still collapses to that single view.
        sourceBtn.classList.toggle('on', v === 'source' || v === 'live');
        renderedBtn.classList.toggle('on', v === 'rendered' || v === 'live');
        // live: both halves show, split 50/50 (the .live class stops them
        // overlapping); the rendered half tracks the editor as you type.
        bodyEl.classList.toggle('live', v === 'live');
        editWrap.classList.toggle('show', v !== 'rendered');
        renderBox.classList.toggle('show', v !== 'source');
        if (v !== 'source') paintRendered();
        if (v !== 'rendered') { highlightEditor(); if (!holdFocus) editor.focus(); }
        // The header pencil offers "edit this page" only for rendered markdown.
        setCanEdit(v === 'rendered' && !!file && MD_EXT.test(file.name) && !file.web && !file.liveurl);
        refreshHtmlPencil();   // HTML shares the header pencil; hide it outside an editable rendered frame
        reportFocus();
      }

      // A fetched web article: a quiet header (title · byline · source host ·
      // open-in-browser) over the sanitized prose. The body is rendered into the
      // app's own DOM, so highlight + comment work on it just like a markdown
      // doc; renderAnnots() repaints any saved highlights. content was sanitized
      // in extractArticle — never assign unsanitized HTML here.
      function renderWebArticle(f: PvDoc) {
        const wrap = document.createElement('div');
        wrap.className = 'md webarticle';
        const toBrowser = () => ipc.openExternal(f.path).catch(() => {});
        if (f.error) {
          const msg = document.createElement('div'); msg.className = 'pvmsg';
          msg.textContent = f.errMsg || 'Could not load this page';
          const open = document.createElement('button'); open.className = 'webopen';
          open.textContent = 'Open in browser ↗'; open.addEventListener('click', toBrowser);
          wrap.append(msg, open);
          renderBox.appendChild(wrap);
          return;
        }
        const head = document.createElement('div'); head.className = 'webhead';
        const h = document.createElement('div'); h.className = 'webtitle'; h.textContent = f.name;
        const meta = document.createElement('div'); meta.className = 'webmeta';
        let host = f.path; try { host = new URL(f.path).hostname.replace(/^www\./, ''); } catch {}
        meta.textContent = (f.byline ? f.byline + ' · ' : '') + host;
        const actions = document.createElement('div'); actions.className = 'webactions';
        const nCount = loadAnnots().length;
        const notes = document.createElement('button'); notes.className = 'webnotes';
        notes.innerHTML = icon('message', 12) + `<span>Notes${nCount ? ' · ' + nCount : ''}</span>`;
        notes.title = 'Open your notes for this article';
        notes.addEventListener('click', () => openNoteFile(f));
        const open = document.createElement('button'); open.className = 'webopen';
        open.textContent = 'Open in browser ↗'; open.title = 'Open the live page'; open.addEventListener('click', toBrowser);
        actions.append(notes, open);
        head.append(h, meta, actions);
        wrap.append(head);
        // low-confidence: set expectations + point at the exit, but never hide
        // the body — a thin extraction is still readable, just flagged.
        if (f.lowconf) {
          const note = document.createElement('div'); note.className = 'webnote';
          note.textContent = 'This looks like an app or a link-heavy page, not an article — it may read better in the browser.';
          wrap.append(note);
        }
        const body = document.createElement('div'); body.className = 'webbody';
        body.innerHTML = f.content || '';   // sanitized in extractArticle
        wrap.append(body);
        renderBox.appendChild(wrap);
        renderAnnots();
      }

      // A live URL docked in the preview (`spike open http(s)://…`): the in-pane
      // browser. No DOM frame for the page — a native child webview (created /
      // positioned in Rust) floats over this pane. We draw a chrome strip at the
      // top of the box (address bar + back/fwd/reload + open-in-browser), mark
      // the box as the board's slot, and kick a sync; from there the webview
      // tracks the box's rect, inset below the strip. The page area below the
      // strip stays empty (the webview covers it once it paints).
      function liveTabName(url: string): string {
        try { const u = new URL(url); return u.host + (u.pathname === '/' ? '' : u.pathname); }
        catch { return url; }
      }
      // Omnibox behavior, like a real browser's address bar: an explicit URL or a
      // bare host navigates; anything else is a Google search. We treat input as a
      // URL only when it already has an http(s) scheme, or looks like a single
      // token that resolves to a host — a dotted domain (example.com, with an
      // optional port/path), localhost[:port], or an IP. Everything else (has a
      // space, or a lone word with no dot like "google") is a query, so typing
      // "how to cook rice" searches instead of navigating to a dead https://host.
      function omniboxUrl(input: string): string {
        const raw = input.trim();
        if (/^https?:\/\//i.test(raw)) return raw;
        const host = raw.split(/[/?#]/, 1)[0];
        // Local hosts (localhost, 127.x, any bare IP) are dev servers that speak
        // http — https there just fails to connect, so scheme them http. Public
        // dotted domains get https.
        const isLocal = /^localhost(:\d+)?$/i.test(host) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(host);
        const isDomain = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i.test(host);
        if (!/\s/.test(raw) && (isLocal || isDomain)) return (isLocal ? 'http://' : 'https://') + raw;
        return 'https://www.google.com/search?q=' + encodeURIComponent(raw);
      }
      function renderLiveUrl(f: PvDoc) {
        liveRenderBox = renderBox;
        liveUrl = f.path;

        // The top chrome — bar + bookmarks bar + open-docs dropdown — lives in one
        // absolutely-positioned flow container so the three rows stack naturally and
        // syncLiveBoard can inset the native webview below the WHOLE thing (page
        // slides down, stays live). `topline` takes the macOS traffic-light inset in
        // preview-focus (the container is the pane's top strip while browsing).
        const chrome = document.createElement('div');
        chrome.className = 'livechrome topline';

        const bar = document.createElement('div');
        bar.className = 'livebar';
        // The dedicated web pane holds no file docs (file opens route to a doc
        // pane, see docPreview) — so its browser chrome drops the "open
        // documents" affordance entirely and reads as a clean browser. Only a
        // live board sharing a doc pane (legacy path) still shows the files fold.
        const webOnly = id === webPvId;
        // Files toggle: while browsing, .pvhead (the file-tab strip) is hidden and
        // this bar IS the top line — so the open docs fold behind this button.
        const files = document.createElement('button');
        files.className = 'livebtn'; files.title = 'Open documents'; files.innerHTML = icon('file-text', 16);
        const back = document.createElement('button');
        back.className = 'livebtn'; back.title = 'Back'; back.innerHTML = icon('arrow-left', 16);
        const fwd = document.createElement('button');
        fwd.className = 'livebtn'; fwd.title = 'Forward'; fwd.innerHTML = icon('arrow-right', 16);
        const reload = document.createElement('button');
        reload.className = 'livebtn'; reload.title = 'Reload'; reload.innerHTML = icon('refresh', 15);
        const addr = document.createElement('input');
        addr.className = 'liveaddr'; addr.type = 'text'; addr.spellcheck = false;
        addr.setAttribute('autocapitalize', 'off'); addr.setAttribute('autocomplete', 'off');
        addr.value = f.path;
        // ☆ bookmark the current page (fills when the page is already bookmarked).
        const star = document.createElement('button');
        star.className = 'livebtn';
        // Expand/restore — the full-size option, same toggle the zoom pill drives.
        const expand = document.createElement('button');
        expand.className = 'livebtn'; expand.title = expandedPreviewId === id ? 'Restore' : 'Expand preview';
        expand.innerHTML = icon(expandedPreviewId === id ? 'minimize' : 'maximize', 15);
        const ext = document.createElement('button');
        ext.className = 'livebtn'; ext.title = 'Open in browser'; ext.innerHTML = icon('external-link', 15);
        bar.append(...(webOnly ? [] : [files]), back, fwd, reload, addr, star, expand, ext);

        // Bookmarks bar — hidden when there are no bookmarks. Chips navigate;
        // folder chips drop their contents; right-click manages (rename/delete/
        // new folder/move). Rebuilt by renderBookmarks() on every mutation.
        const bmbar = document.createElement('div');
        bmbar.className = 'bmbar';

        // 📄 → the open documents, as an in-pane dropdown BELOW the bar. It's a real
        // strip in the chrome, not a floating menu: syncLiveBoard measures the chrome
        // and insets the native webview below it, so the page slides down and stays
        // live instead of being blanked. The website itself isn't a "document", so
        // it's filtered out — only real file docs list here.
        const drop = document.createElement('div');
        drop.className = 'livefiles';

        chrome.append(bar, bmbar, ...(webOnly ? [] : [drop]));
        renderBox.appendChild(chrome);

        // ── navigation + bookmarks ────────────────────────────────────────────
        function navigateTo(url: string) {
          addr.value = url;
          f.path = url;
          const nm = liveTabName(url);
          if (nm !== f.name) { f.name = nm; renderPvTabs(); }
          liveUrl = url;
          scheduleLiveSync();
          reportFocus();
          paintStar();
        }
        function bmLeaves(): Bookmark[] {
          const out: Bookmark[] = [];
          for (const b of bookmarks) { if (b.children) out.push(...b.children); else out.push(b); }
          return out;
        }
        function findBm(url: string) { return bmLeaves().find((l) => l.url === url); }
        function paintStar() {
          const on = !!findBm(liveUrl);
          star.innerHTML = icon(on ? 'star-filled' : 'star', 16);
          star.title = on ? 'Remove bookmark' : 'Bookmark this page';
          star.classList.toggle('on', on);
        }
        function removeBm(b: Bookmark, parent: Bookmark | null) {
          if (parent) parent.children = (parent.children || []).filter((c) => c !== b);
          else bookmarks = bookmarks.filter((n) => n !== b);
        }
        // The node whose name is being edited inline. renderBookmarks draws it as a
        // text field instead of a chip (this WebKit build has no window.prompt — it
        // returns null — so naming/renaming is done in-place, not via a dialog).
        let editing: Bookmark | null = null;
        function startEdit(node: Bookmark) { editing = node; renderBookmarks(); }
        function toggleBookmark() {
          const existing = findBm(liveUrl);
          if (existing) {
            removeBm(existing, bookmarks.find((n) => n.children && n.children.includes(existing)) || null);
            saveBookmarks(); renderBookmarks(); paintStar();
            return;
          }
          let dflt: string;
          try { dflt = new URL(liveUrl).hostname.replace(/^www\./, ''); } catch { dflt = liveUrl; }
          const node: Bookmark = { title: dflt, url: liveUrl };
          bookmarks.push(node);
          saveBookmarks(); paintStar();
          startEdit(node);   // add immediately, then let the user rename in place
        }
        function renameBm(b: Bookmark) { startEdit(b); }
        function newFolder() {
          const node: Bookmark = { title: 'New folder', children: [] };
          bookmarks.push(node);
          saveBookmarks();
          startEdit(node);
        }
        function moveBm(b: Bookmark, from: Bookmark | null, to: Bookmark | null) {
          removeBm(b, from);
          if (to) (to.children = to.children || []).push(b); else bookmarks.push(b);
          saveBookmarks(); renderBookmarks(); paintStar();
        }
        function leafMenu(b: Bookmark, parent: Bookmark | null, x: number, y: number) {
          const items: any[] = [
            { label: 'Rename', fn: () => renameBm(b) },
            { label: 'Delete', danger: true, fn: () => { removeBm(b, parent); saveBookmarks(); renderBookmarks(); paintStar(); } },
            { sep: true },
            { label: 'New folder…', fn: newFolder },
          ];
          if (parent) items.push({ label: 'Move out of folder', fn: () => moveBm(b, parent, null) });
          for (const fo of bookmarks) if (fo.children && fo !== parent) items.push({ label: 'Move to ' + fo.title, fn: () => moveBm(b, parent, fo) });
          openMenu(x, y, items);
        }
        function folderMenu(fo: Bookmark, x: number, y: number) {
          openMenu(x, y, [
            { label: 'Rename', fn: () => renameBm(fo) },
            { label: 'Delete folder', danger: true, fn: () => { bookmarks = bookmarks.filter((n) => n !== fo); saveBookmarks(); renderBookmarks(); paintStar(); } },
          ]);
        }
        function leafChip(b: Bookmark, parent: Bookmark | null) {
          const chip = document.createElement('button');
          chip.className = 'bmchip'; chip.title = b.url || ''; chip.textContent = b.title;
          chip.addEventListener('click', () => { if (b.url) navigateTo(b.url); });
          chip.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); leafMenu(b, parent, e.clientX, e.clientY); });
          return chip;
        }
        function folderChip(fo: Bookmark) {
          const chip = document.createElement('button');
          chip.className = 'bmchip folder'; chip.title = fo.title;
          chip.innerHTML = icon('folder', 14) + '<span class="lbl"></span>' + icon('chevron-down', 12);
          (chip.querySelector('.lbl') as HTMLElement).textContent = fo.title;
          chip.addEventListener('click', (e) => {
            e.stopPropagation();
            const r = chip.getBoundingClientRect();
            const kids = fo.children || [];
            openMenu(r.left, r.bottom + 3, kids.length
              ? kids.map((c) => ({ label: c.title, fn: () => c.url && navigateTo(c.url) }))
              : [{ label: 'Empty folder', fn: () => {} }]);
          });
          chip.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); folderMenu(fo, e.clientX, e.clientY); });
          return chip;
        }
        // In-place name editor (stands in for window.prompt, which is a no-op in
        // this webview). Enter/blur commits, Esc cancels; a blank keeps the old name.
        function editChip(node: Bookmark) {
          const wrap = document.createElement('span');
          wrap.className = 'bmchip editing';
          const inp = document.createElement('input');
          inp.className = 'bmedit'; inp.value = node.title; inp.spellcheck = false;
          let done = false;
          const commit = () => {
            if (done) return; done = true;
            const v = inp.value.trim(); if (v) node.title = v;
            editing = null; saveBookmarks(); renderBookmarks();
          };
          inp.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { e.preventDefault(); done = true; editing = null; renderBookmarks(); }
          });
          inp.addEventListener('blur', commit);
          wrap.appendChild(inp);
          setTimeout(() => { inp.focus(); inp.select(); }, 0);
          return wrap;
        }
        function renderBookmarks() {
          bmbar.innerHTML = '';
          bmbar.style.display = bookmarks.length ? 'flex' : 'none';
          for (const b of bookmarks) bmbar.appendChild(b === editing ? editChip(b) : (b.children ? folderChip(b) : leafChip(b, null)));
          scheduleLiveSync();   // height changed (0 ↔ shown) — re-inset the webview
        }
        star.addEventListener('click', toggleBookmark);
        renderBookmarks();
        paintStar();
        let dropAway: ((e: MouseEvent) => void) | null = null;
        function closeFiles() {
          if (!drop.classList.contains('open')) return;
          drop.classList.remove('open');
          drop.innerHTML = '';
          if (dropAway) { document.removeEventListener('mousedown', dropAway, true); dropAway = null; }
          scheduleLiveSync();   // webview slides back up into the freed space
        }
        function openFiles() {
          const docs = tabs.filter((t) => !t.liveurl);
          drop.innerHTML = '';
          if (!docs.length) {
            const empty = document.createElement('div');
            empty.className = 'lfitem empty'; empty.textContent = 'No open documents';
            drop.appendChild(empty);
          } else for (const t of docs) {
            const it = document.createElement('div');
            it.className = 'lfitem' + (t === file ? ' active' : '');
            it.textContent = t.name;
            it.addEventListener('click', () => { closeFiles(); activateTab(t); });
            drop.appendChild(it);
          }
          drop.classList.add('open');
          scheduleLiveSync();   // push the webview down to expose the dropdown band
          dropAway = (ev) => { if (!drop.contains(ev.target as Node) && !files.contains(ev.target as Node)) closeFiles(); };
          setTimeout(() => document.addEventListener('mousedown', dropAway!, true), 0);
        }
        files.addEventListener('click', (e) => {
          e.stopPropagation();
          drop.classList.contains('open') ? closeFiles() : openFiles();
        });
        expand.addEventListener('click', () => togglePreviewExpanded(id));

        // Address submit: normalize, point the tab + board at the new URL, and
        // re-sync (live_webview_show navigates because the URL changed).
        addr.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          if (!addr.value.trim()) return;
          const url = omniboxUrl(addr.value);
          addr.value = url;
          f.path = url; f.name = liveTabName(url); liveUrl = url;
          renderPvTabs();
          scheduleLiveSync();
          reportFocus();
          addr.blur();
        });
        // Back/forward drive the webview's own session history (covers SPA
        // routes; safe no-ops at the ends), so they're always live.
        back.addEventListener('click', () => ipc.liveWebviewBack().catch(() => {}));
        fwd.addEventListener('click', () => ipc.liveWebviewForward().catch(() => {}));
        reload.addEventListener('click', () => ipc.liveWebviewReload().catch(() => {}));
        ext.addEventListener('click', () => ipc.openExternal(f.path).catch(() => {}));

        // Register the strip's address bar for the global live-nav handler so it
        // tracks the webview's real URL on document loads.
        liveBoardCtl = {
          addr,
          // Only rebuild the tab strip when the display name actually changes —
          // a page's load-time redirect bounces (docs.google.com/document/u/0/ →
          // ?pli=1 → …) fire onNav repeatedly with the SAME name, and a blind
          // renderPvTabs() innerHTML-rebuild on each one made the title flicker.
          onNav: (url) => {
            f.path = url;
            const nm = liveTabName(url);
            if (nm !== f.name) { f.name = nm; renderPvTabs(); }
          },
        };
        scheduleLiveSync();
      }

      // An HTML file promoted to the native child webview ("true browser" mode).
      // Same board machinery as renderLiveUrl, but the page is a LOCAL file served
      // over the `spikehtml://` scheme (file bytes + traversal-guarded sibling
      // assets, no CSP), so its inline JS runs and it lays out as its own main
      // frame — unlike the sandboxed iframe. We register the current text (live
      // editor edits included), then point the board at the returned URL. A fresh
      // token per (re)load makes reload reflect edits/disk without a nav cache
      // fight. The strip is static (a local file has no address to type); its
      // "‹ page" button flips file.browser off and re-renders the iframe view.
      function renderHtmlBrowser(f: PvDoc) {
        liveRenderBox = renderBox;
        liveBoardCtl = null;   // local preview: no address bar / live-nav to track

        const bar = document.createElement('div');
        bar.className = 'livebar';   // shared height contract with syncLiveBoard
        const back = document.createElement('button');
        back.className = 'livebtn'; back.title = 'Back to page view'; back.innerHTML = icon('arrow-left', 16);
        const reload = document.createElement('button');
        reload.className = 'livebtn'; reload.title = 'Reload'; reload.innerHTML = icon('refresh', 15);
        const label = document.createElement('div');
        label.className = 'liveaddr livelocal'; label.textContent = f.name;
        label.title = f.path;
        const ext = document.createElement('button');
        ext.className = 'livebtn'; ext.title = 'Open in system browser'; ext.innerHTML = icon('external-link', 15);
        bar.append(back, reload, label, ext);
        renderBox.appendChild(bar);

        // (Re)register the current text and re-point the board. The token changes
        // each call, so liveWebviewShow navigates rather than serving a cache.
        const load = () => {
          const cur = (view !== 'source' && dirty) ? editor.value : f.content;
          return ipc.registerHtmlPreview(f.path, cur).then((url) => {
            liveUrl = url;
            scheduleLiveSync();
          }).catch(() => {});
        };

        back.addEventListener('click', () => { f.browser = false; paintRendered(); });
        reload.addEventListener('click', load);
        ext.addEventListener('click', () => ipc.openExternal(f.path).catch(() => {}));
        load();
      }

      // render the current file into the viewer pane per its type.
      // Interactive task checkboxes: clicking a rendered `- [ ]` / `- [x]` box in
      // the preview flips the matching task line in the source and persists it.
      // Rendered checkboxes map 1:1, in document order, to the source's task
      // lines (frontmatter/YAML never matches the task regex), so the Nth box
      // owns the Nth task line.
      const TASK_LINE = /^(\s*[-*+]\s+\[)([ xX])(\])/;
      function wireTaskboxes(container: HTMLElement) {
        if (!file) return;
        const boxes = Array.from(container.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
        boxes.forEach((cb, idx) => {
          cb.disabled = false;            // marked emits them disabled; make them live
          cb.style.cursor = 'pointer';
          cb.addEventListener('change', () => {
            const src = dirty ? editor.value : (file ? file.content : '');
            const lines = src.split('\n');
            let seen = -1, hit = -1;
            for (let i = 0; i < lines.length; i++) {
              if (TASK_LINE.test(lines[i]) && ++seen === idx) { hit = i; break; }
            }
            if (hit < 0) return;          // desynced (stray checkbox) — leave source alone
            lines[hit] = lines[hit].replace(TASK_LINE, (_m, a, _c, z) => a + (cb.checked ? 'x' : ' ') + z);
            const next = lines.join('\n');
            if (dirty) {
              // live-editing: merge into the working copy; saved with the rest.
              editor.value = next; lastSeen = next; if (file) file.draft = next;
            } else if (file) {
              file.content = next; file.draft = next;
              if (editor.value !== next) { editor.value = next; lastSeen = next; }
              ipc.saveFile(file.path, next).then(() => flashSaved()).catch(() => {
                saveEl.classList.add('show', 'dirty'); saveLbl.textContent = 'save failed';
              });
            }
          });
        });
      }

      // Render the body block by block so each element provably belongs to one
      // top-level token. Editing the rendered pane is WYSIWYG-only (pencil / ⌘E),
      // so nothing is wired for editing here — this is a read-only paint.
      function renderMdBlocks(host: HTMLElement, body: string, _base: number) {
        const pp = mdPreprocessMapped(body, wikiHooks(0));
        let tokens: any[] | null = null;
        try { tokens = marked.lexer(pp.out); } catch { tokens = null; }
        if (!tokens) { host.innerHTML = renderMarkdown(pp.out); return; }
        for (let i = 0; i < tokens.length; i++) {
          const holder = document.createElement('div');
          // One token at a time, but handed the whole document's link map so a
          // reference-style link defined elsewhere still resolves.
          const arr: any[] = [tokens[i]];
          arr.links = tokens.links || {};
          let html: string;
          try { html = DOMPurify.sanitize(marked.parser(arr), { ALLOWED_URI_REGEXP: MD_URI_RE }); }
          catch { continue; }
          holder.innerHTML = html;
          while (holder.firstChild) host.appendChild(holder.firstChild);
        }
      }

      function paintRendered() {
        // tear down any find/zoom state tied to the outgoing DOM (its nodes —
        // and any iframe — are about to be replaced).
        clearHighlights();
        curFrame = null;
        htmlEditTeardown();   // the frame this edit rode on is going away
        zoomPill.classList.remove('show');
        navPill.classList.remove('show');
        head.classList.remove('canedithtml');   // the editable frame is going away
        renderBox.innerHTML = '';
        // Repainting this box drops any board it was hosting; renderLiveUrl below
        // re-claims it if this file is itself a live URL. (Only clear OUR box so a
        // sibling pane's board is left alone.)
        if (liveRenderBox === renderBox) { liveRenderBox = null; scheduleLiveSync(); }
        // Refresh the notes count badge (and open drawer) for the file we're about
        // to paint — every render path, not just the ones that call renderAnnots().
        // Annotatable views (markdown / reader) re-run this via renderAnnots below;
        // the sandboxed-HTML-iframe and media paths have no such hook, so without
        // this the badge kept the PREVIOUS doc's count until you opened the drawer.
        notesRefresh();
        if (!file) return;
        // A live URL (the in-pane browser) hides the file-tab strip: its livebar
        // becomes the top line, and the open docs fold behind the livebar's 📄
        // toggle. Every other doc type keeps the normal .pvhead tab strip.
        head.classList.toggle('browsing', !!file.liveurl);
        // Decided here rather than per-branch: paintRendered returns early for
        // images, PDFs, media and unpreviewable files, and focus mode should be
        // reachable from all of them. applyHtmlZoom re-runs it for real frames.
        paintZoomPill();
        if (file.web) { renderWebArticle(file); return; }
        if (file.liveurl) { renderLiveUrl(file); return; }
        if (file.binary || file.tooBig) {
          const msg = document.createElement('div');
          msg.className = 'pvmsg';
          msg.textContent = file.tooBig ? 'File too large to preview' : "Can't preview this file";
          renderBox.appendChild(msg);
          return;
        }
        if (file.media === 'image') {
          const img = document.createElement('img');
          img.className = 'pvimg';
          img.alt = file.name;
          img.src = ipc.rawSrc(file.path);
          renderBox.appendChild(img);
          return;
        }
        if (file.media === 'pdf') {
          const frame = document.createElement('iframe');
          frame.className = 'pvpdf';
          frame.src = ipc.rawSrc(file.path);
          renderBox.appendChild(frame);
          return;
        }
        if (file.media === 'audio' || file.media === 'video') {
          const el = document.createElement(file.media);
          el.className = file.media === 'audio' ? 'pvaudio' : 'pvvideo';
          el.controls = true;
          el.src = ipc.rawSrc(file.path);
          renderBox.appendChild(el);
          return;
        }
        const name = file.name;
        // edits should preview live, so render from the textarea whenever it
        // holds the working copy (rendered-after-editing and live mode alike).
        const text = (view !== 'source' && dirty) ? editor.value : file.content;
        if (CSV_EXT.test(name)) {
          const rows = parseDelimited(text, /\.tsv$/i.test(name) ? '\t' : ',');
          const MAX = 2000;
          const wrap = document.createElement('div');
          wrap.className = 'csvwrap';
          const table = document.createElement('table');
          table.className = 'csv';
          rows.slice(0, MAX).forEach((cells, r) => {
            const tr = document.createElement('tr');
            cells.forEach((cell) => {
              const td = document.createElement(r === 0 ? 'th' : 'td');
              td.textContent = cell;
              tr.appendChild(td);
            });
            (r === 0 ? (table.createTHead()) : (table.tBodies[0] || table.createTBody())).appendChild(tr);
          });
          wrap.appendChild(table);
          if (rows.length > MAX) {
            const note = document.createElement('div');
            note.className = 'pvmsg'; note.style.position = 'static';
            note.textContent = `Showing first ${MAX} of ${rows.length} rows`;
            wrap.appendChild(note);
          }
          renderBox.appendChild(wrap);
        } else if (MD_EXT.test(name)) {
          const div = document.createElement('div');
          div.className = 'md';
          // Obsidian-style frontmatter -> a properties block; the rest is the body.
          const fm = parseFrontmatter(text);
          if (fm && fm.props.length) div.appendChild(renderProps(fm.props));
          const body = fm ? fm.body : text;
          const bodyEl = document.createElement('div');
          // Rendered block by block rather than in one shot, so every element
          // provably belongs to a known token — that is what lets a visual edit
          // know which source span a run of text came from. Byte-identical to a
          // whole-document render (guarded by a test in test/mdedit.test.mjs);
          // the per-block parse is handed the document's link map so
          // reference-style links still resolve across blocks.
          renderMdBlocks(bodyEl, body, fm ? fm.offset : 0);
          wireWikilinks(bodyEl);
          wireImages(bodyEl, file.path);
          fillEmbeds(bodyEl, 0);
          wireTaskboxes(bodyEl);
          while (bodyEl.firstChild) div.appendChild(bodyEl.firstChild);
          renderBox.appendChild(div);
          renderAnnots();   // re-paint any saved highlights for this doc
        } else if (HTML_EXT.test(name) && file.browser) {
          // browser mode: the native child webview renders the file as its own
          // main frame (true inline browser). Reuses the live-board machinery.
          renderHtmlBrowser(file);
        } else if (HTML_EXT.test(name) && file.reader) {
          // reader mode: extracted prose in the app's own DOM → annotatable.
          const wrap = document.createElement('div');
          wrap.className = 'md webarticle';
          const body = document.createElement('div');
          body.className = 'webbody';
          body.innerHTML = extractArticle(text, file.path).html;   // sanitized
          wrap.appendChild(body);
          renderBox.appendChild(wrap);
          renderAnnots();   // highlights work here — it's real DOM
        } else if (HTML_EXT.test(name)) {
          const frame = document.createElement('iframe');
          frame.className = 'htmlframe';
          // allow-scripts so interactive docs (slide decks, demos) actually run;
          // NO allow-same-origin — with srcdoc that would hand the previewed
          // HTML script access to the app itself (and its IPC to the shell).
          frame.setAttribute('sandbox', 'allow-scripts allow-modals allow-popups');
          // SPIKE_BRIDGE wires find / zoom-key / in-page nav back to the parent
          // over postMessage — the only channel across the same-origin-less sandbox.
          // Serve the doc (+ bridge) over the private `spikehtml://` scheme so
          // its inline JS actually runs. A `srcdoc` iframe inherits the app's
          // strict `script-src` (no 'unsafe-inline') and silently drops every
          // <script>; a real navigation to a scheme we serve inherits no such
          // policy. The sandbox stays same-origin-less, so the frame is still an
          // opaque origin walled off from the app — only the CSP it sees changes.
          const homeDoc = text + SPIKE_BRIDGE;
          ipc.registerHtmlPreview(file.path, homeDoc).then((url) => {
            htmlHomeUrl = url;
            frame.src = url;
          }).catch(() => {
            // Registration failed: fall back to srcdoc. Inline JS won't run, but
            // the markup still renders rather than leaving the pane blank.
            frame.srcdoc = homeDoc;
          });
          // this frame is now the live target for zoom / find / back / edit.
          curFrame = frame;
          refreshHtmlPencil();   // this frame is editable in place → show the header pencil
          navPill.classList.remove('show');   // reset the back affordance per doc
          // hand the doc keyboard focus on open so arrow-key nav works without
          // a click first — but never steal from the tree/editor/terminal.
          frame.addEventListener('load', () => {
            const ae = document.activeElement;
            if (!ae || ae === document.body || renderBox.contains(ae)) frame.focus();
            frameAnnotsSync();   // paint any saved notes into the freshly loaded doc
          });
          renderBox.appendChild(frame);
          applyHtmlZoom();   // carry the pane's zoom onto the new frame + show the pill
        } else if (JSON_EXT.test(name)) {
          let pretty = text;
          try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch {}   // pretty-print if valid
          renderBox.appendChild(highlighted(pretty, 'json'));
        } else if (langFor(name)) {
          renderBox.appendChild(highlighted(text, langFor(name)));
        } else {
          const pre = document.createElement('pre');
          pre.className = 'raw';
          pre.textContent = text;
          renderBox.appendChild(pre);
        }
      }

      // POST the textarea back to disk; clear the unsaved indicator on success.
      // The doc is captured so a tab switch mid-save can't mark the wrong one clean.
      function saveDoc() {
        // ⌘S with the WYSIWYG editor still open must save what the user can SEE.
        // The rendered view has no visible source editor to click into, so
        // without this the doc would be written out as it stood on open.
        if (htmlEditing) { exitHtmlEdit(true); return; }   // ⌘S while editing HTML = Done
        flushEdit();
        if (!file || file.binary || file.tooBig || !dirty) return;
        const doc = file;
        const content = editor.value;
        // learn-the-voice: capture the before/after of a markdown edit so Spike can
        // distill the user's writing voice from how they revise agent output. Only
        // for WYSIWYG-editable markdown; `doc.content` is still the pre-save text here.
        const voiceBefore = canEdit() ? doc.content : null;
        ipc.saveFile(doc.path, content).then(() => {
          if (voiceBefore != null && content !== voiceBefore) {
            learnVoiceFromEdit(doc.path, voiceBefore, content);
          }
          doc.content = content;
          doc.draft = content;
          doc.dirty = false;
          if (file === doc) {
            setDirty(false);
            flashSaved();        // "saved" → fades after a moment
          } else if (tabs.length > 1) renderPvTabs();   // clear the dirty dot in place
        }).catch(() => {
          saveEl.classList.add('show', 'dirty');
          saveLbl.textContent = 'save failed';
        });
      }

      // Close THIS pane: confirm dirty docs, fade out, then drop its surface
      // from the layout and dispose. The last tab's × and the footer toggle
      // both land here.
      function closeInstance() {
        if (closing) return;
        if (tabs.some((t) => t.dirty) && !confirm('You have unsaved edits in open tabs. Discard them?')) return;
        closing = true;
        // closing the pane closes the board: destroy the webview NOW (before the
        // fade) so it can't float, fully opaque, over the fading pane.
        if (liveRenderBox === renderBox) { liveRenderBox = null; ipc.liveWebviewClose().catch(() => {}); }
        // leave the registry NOW so routing can't land a fresh open in a dying
        // pane during the fade; the layout surface + DOM go in dispose.
        previews.delete(id);
        if (webPvId === id) webPvId = null;   // next `spike open` spawns a fresh web pane
        if (focusedPreview === pv) focusedPreview = null;
        root.classList.remove('shown');   // fade out, then drop the leaf
        selectRow(null);
        paintPreviewToggle();
        setTimeout(dispose, 150);
      }

      // Immediate structural teardown (no confirm, no fade): registry, layout
      // surface, DOM node. Also the path for a doc deleted out from under us.
      function dispose() {
        closing = true;
        // pane gone for good — destroy its live webview if it still owned one
        // (the direct-dispose path, e.g. a deleted doc; closeInstance already
        // closed it on the user-close path).
        if (liveRenderBox === renderBox) { liveRenderBox = null; ipc.liveWebviewClose().catch(() => {}); }
        if (savedTimer) clearTimeout(savedTimer);
        previews.delete(id);
        if (webPvId === id) webPvId = null;   // next `spike open` spawns a fresh web pane
        if (focusedPreview === pv) focusedPreview = null;
        if (expandedPreviewId === id) {
          expandedPreviewId = null;
          document.documentElement.classList.remove('preview-focus');
        }
        removeSurface(layout, (s) => s.kind === 'preview' && s.id === id);
        root.remove();
        renderLayout();
        saveLayout();
        paintPreviewToggle();
        reportFocus();
      }

      // a doc deleted on disk: drop its tab without confirming (it's gone).
      function dropPath(path: string) {
        const open = tabs.find((t) => t.path === path);
        if (!open) return;
        if (tabs.length <= 1) { dispose(); return; }   // the last doc takes the pane with it
        const idx = tabs.indexOf(open);
        tabs.splice(idx, 1);
        if (file === open) { file = null; activateTab(tabs[idx] || tabs[idx - 1] || tabs[0]); }
        else renderPvTabs();
      }

      // ── wiring ──
      // clicking or typing anywhere in the pane makes it the routing target
      // for tree clicks, `spike open` and ⌘S — and hands the caret back to the
      // doc after a tree peek left it in the file tree (holdFocus).
      root.addEventListener('mousedown', () => { focusedPreview = pv; holdFocus = false; });
      root.addEventListener('focusin', () => { focusedPreview = pv; });
      // Dragging the header re-docks THIS pane's surface (same engine as a leaf
      // tab / terminal tab). The grab target is the whole header EXCEPT its live
      // controls: the view segment, the save chip, and a doc pill's own pin/close
      // (.ctl). So the doc pill itself is a drag handle - grab it like a terminal
      // tab - while its click (switch doc) and dblclick (pin) still fire under
      // beginDockDrag's 5px threshold.
      head.addEventListener('mousedown', (e: MouseEvent) => {
        const t = e.target as HTMLElement;
        if (t.closest('.seg') || t.closest('.pvsave') || t.closest('.ctl')) return;   // controls keep clicks
        for (const lf of leaves(layout.root)) {
          const i = lf.surfaces.findIndex((s) => s.kind === 'preview' && s.id === id);
          if (i >= 0) { beginDockDrag(e, { leafId: lf.id, index: i, surface: lf.surfaces[i] }, 'preview'); return; }
        }
      });
      sourceBtn.addEventListener('click', () => { if (file) setView('source'); });
      renderedBtn.addEventListener('click', () => { if (file) setView('rendered'); });

      // ── WYSIWYG markdown editor ──────────────────────────────────────────
      // enterEdit is reachable only for rendered markdown (pencil / ⌘E). It
      // rebuilds .pvrender as a contenteditable rendering of the doc BODY, shows
      // the formatting bar, and focuses. exitEdit serializes the DOM back to
      // markdown, re-prepends the preserved frontmatter, and repaints read-only.
      // The pencil lives in the header but the state is a property of the BODY
      // (which view is showing), and the two are siblings — so mirror the class
      // onto both rather than reaching across with :has().
      function setCanEdit(v: boolean) {
        bodyEl.classList.toggle('canedit', v);
        head.classList.toggle('canedit', v);
      }
      function canEdit() {
        return !!file && !file.binary && !file.tooBig && MD_EXT.test(file.name) && !file.web && !file.liveurl;
      }
      function enterEdit() {
        if (!file || editing || !canEdit()) return;
        if (view !== 'rendered') setView('rendered');   // exits source/live first
        editing = true;
        // frontmatter is preserved verbatim; only the body becomes editable.
        const text = dirty ? editor.value : file.content;
        const fm = parseFrontmatter(text);
        editRawFm = fm ? text.slice(0, text.length - fm.body.length) : '';
        const body = fm ? fm.body : text;
        renderBox.innerHTML = '';
        const md = document.createElement('div');
        md.className = 'md';
        md.setAttribute('contenteditable', 'true');
        md.spellcheck = true;
        md.innerHTML = mdToEditHtml(body);
        wireEditImages(md, file.path);   // relative images stay visible while editing
        renderBox.appendChild(md);
        renderBox.classList.add('editing');
        bodyEl.classList.add('editing');
        head.classList.add('editing');   // one-row mode: reveal the tools in the header
        setCanEdit(false);
        md.addEventListener('input', onEditInput);
        md.addEventListener('keydown', onEditKeydown);
        md.addEventListener('paste', onEditPaste);
        renderBox.addEventListener('mousemove', onEditTableHover);
        renderBox.addEventListener('scroll', onEditScroll);
        buildToolbar();
        syncSeg();                 // the view segment stands down while editing
        document.addEventListener('selectionchange', headSelSync);
        // promote out of the recyclable live slot the moment you open the editor
        if (file.ephemeral) { file.ephemeral = false; renderPvTabs(); }
        setTimeout(() => { md.focus(); placeCaretStart(md); syncHeadLabel(); }, 0);
      }
      // Pasting MARKDOWN into the rendered editor should land as formatted
      // content, not as the literal syntax — you pasted a document, not a string
      // of hashes and asterisks. The clipboard hands us plain text; if it reads
      // as markdown we run it through the same md→HTML path the editor opened
      // with, so a pasted note arrives with its headings, lists and quotes
      // intact and serializes back cleanly on exit.
      //
      // Ordinary prose falls through to the default paste: running a bare
      // sentence through marked would wrap it in its own <p> and split the
      // paragraph you pasted into. Rich HTML on the clipboard (a web page) also
      // falls through — the browser already handles that better than we would.
      const MD_SHAPE = /(^|\n)[ \t]{0,3}(#{1,6} |[-*+] |\d+\. |> |```|---[ \t]*$|\|)|\*\*[^*\n]+\*\*|(^|[^!])\[[^\]\n]+\]\([^)\n]+\)|\[\[[^\]\n]+\]\]/;
      function onEditPaste(e: ClipboardEvent) {
        const cd = e.clipboardData;
        if (!cd) return;
        // An image on the clipboard has to be intercepted: the default handler
        // inlines it as a data:/blob: URL, and turndown would write that whole
        // blob (or a URL dead the moment the app restarts) into the .md. Land the
        // bytes as a real file beside the doc and reference it by name instead.
        const img = Array.from(cd.files || []).find((f) => f.type.startsWith('image/'));
        if (img) { e.preventDefault(); void pasteImageFile(img); return; }
        // any other file paste carries no text — leave it to the default handler
        const text = cd.getData('text/plain');
        if (!text || !MD_SHAPE.test(text)) return;
        e.preventDefault();
        // execCommand keeps this on the browser's own undo stack, so ⌘Z after a
        // paste behaves like every other edit in this surface.
        document.execCommand('insertHTML', false, mdToEditHtml(text));
        onEditInput();
      }
      // A ⌘V'd image becomes a file NEXT TO THE DOC and a relative reference to
      // it. Two hops, no new backend: drop_image stages the bytes in temp (the
      // same staging the terminal drop path uses), copy_path moves that beside
      // the note and de-duplicates the name on collision. Beside the note, not in
      // an attachments/ folder — a relative sibling is the one form that resolves
      // the same for us, for an agent reading the file, and for any other editor.
      async function pasteImageFile(f: File) {
        const doc = file;
        if (!doc) return;
        const dir = doc.path.slice(0, doc.path.lastIndexOf('/'));
        try {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result));
            r.onerror = reject;
            r.readAsDataURL(f);
          });
          const staged = await ipc.dropImage(dataUrl.split(',')[1] || '', f.name || 'pasted.png');
          const landed = await ipc.copyPath(staged, dir);
          if (file !== doc || !editing) return;   // moved on mid-copy: don't insert into the wrong doc
          insertImage(landed.name, f.name || '', landed.path);
        } catch {
          /* couldn't stage it — nothing lands, and the doc is untouched */
        }
      }
      // debounced live-preview of dirtiness: serialize on edit so the save pill
      // and the dirty dot track WYSIWYG changes the same as textarea typing.
      let editInputTimer: ReturnType<typeof setTimeout> | null = null;
      function onEditInput() {
        if (editInputTimer) clearTimeout(editInputTimer);
        editInputTimer = setTimeout(() => {
          editInputTimer = null;
          if (!editing || !file) return;
          const md = renderBox.querySelector('.md[contenteditable]') as HTMLElement;
          if (!md) return;
          const full = editRawFm + editHtmlToMd(md.innerHTML);
          file.draft = full;
          if (!dirty && full !== file.content) setDirty(true);
        }, 200);
      }
      // Commit the edit: serialize, push it through the editor pipeline (so undo
      // history, dirty state, and the source view all agree), repaint read mode,
      // then write to disk. That last step is what makes "Done" mean done — it
      // used to leave you sitting on an unsaved doc under a checkmark, which is
      // the same bargain the in-place HTML editor already refused (exitHtmlEdit
      // saves). Every keep=true exit saves, not just the button, so ⌘E and a tab
      // switch can't quietly strand the write. `keep` is always true today —
      // kept as a seam for a future "discard".
      function exitEdit(keep: boolean) {
        if (!editing) return;
        editing = false;
        closeTbPop();
        renderBox.removeEventListener('mousemove', onEditTableHover);
        renderBox.removeEventListener('scroll', onEditScroll);
        colCtl?.classList.remove('show'); rowCtl?.classList.remove('show'); ctlTable = null;
        if (ctlHideTimer) { clearTimeout(ctlHideTimer); ctlHideTimer = null; }
        document.removeEventListener('selectionchange', headSelSync);
        headBtn = null;
        if (editInputTimer) { clearTimeout(editInputTimer); editInputTimer = null; }
        const md = renderBox.querySelector('.md[contenteditable]') as HTMLElement | null;
        if (keep && md && file) {
          const full = editRawFm + editHtmlToMd(md.innerHTML);
          if (full !== editor.value) {
            pushUndo(file, editor.value);   // pre-edit text becomes an undo step
            applySnapshot(full, full.length, full.length);
          }
        }
        editRawFm = '';
        renderBox.classList.remove('editing');
        bodyEl.classList.remove('editing');
        head.classList.remove('editing');
        toolbar.innerHTML = '';
        syncSeg();                 // the view segment comes back on exit
        // repaint the clean read-only view + restore the pencil affordance
        paintRendered();
        if (file && MD_EXT.test(file.name)) setCanEdit(true);
        if (keep) saveDoc();       // Done lands on a saved doc, not an "unsaved" flag
      }
      // Serialize the open WYSIWYG DOM into the source editor WITHOUT leaving
      // edit mode. onEditInput only maintains file.draft (debounced), so anything
      // that reads editor.value mid-edit — ⌘S above all — has to flush first or
      // it writes out the text as it stood when the editor opened.
      function flushEdit() {
        if (!editing || !file) return;
        const md = renderBox.querySelector('.md[contenteditable]') as HTMLElement | null;
        if (!md) return;
        if (editInputTimer) { clearTimeout(editInputTimer); editInputTimer = null; }
        const full = editRawFm + editHtmlToMd(md.innerHTML);
        if (full === editor.value) return;
        pushUndo(file, editor.value);
        applySnapshot(full, full.length, full.length);
      }
      function placeCaretStart(el: HTMLElement) {
        try {
          const r = document.createRange(); r.selectNodeContents(el); r.collapse(true);
          const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(r);
        } catch {}
      }

      // ── shared editor helpers ──
      const editable = () => renderBox.querySelector('.md[contenteditable]') as HTMLElement | null;
      const focusDoc = () => { const el = editable(); if (el) el.focus(); };
      const exec = (cmd: string, val?: string) => { focusDoc(); document.execCommand(cmd, false, val); onEditInput(); };
      // Popovers (heading menu / table grid / link input) blur the contenteditable,
      // collapsing the live selection the command needs — so snapshot the Range on
      // open and restore it before applying.
      let savedRange: Range | null = null;
      function snapshotSel() {
        const md = editable(); const s = window.getSelection();
        savedRange = (md && s && s.rangeCount && md.contains(s.anchorNode)) ? s.getRangeAt(0).cloneRange() : null;
      }
      function restoreSel() {
        const md = editable(); if (!md) return; md.focus();
        if (savedRange) { const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(savedRange); }
      }

      // One floating popover at a time, anchored under its toolbar button inside
      // .pvbody. Dismisses on outside-mousedown or Escape.
      let tbPop: HTMLElement | null = null;
      let tbPopDismiss: ((e: Event) => void) | null = null;
      function closeTbPop() {
        tbPop?.remove(); tbPop = null;
        toolbar.querySelectorAll('.tbhead.open').forEach((b) => b.classList.remove('open'));
        if (tbPopDismiss) {
          document.removeEventListener('mousedown', tbPopDismiss, true);
          document.removeEventListener('keydown', tbPopDismiss, true);
          tbPopDismiss = null;
        }
      }
      function openTbPop(anchor: HTMLElement, content: HTMLElement) {
        closeTbPop();
        content.classList.add('tbpop');
        bodyEl.appendChild(content);
        const ar = anchor.getBoundingClientRect(), br = bodyEl.getBoundingClientRect();
        let left = ar.left - br.left;
        content.style.top = (ar.bottom - br.top + 4) + 'px';
        content.style.left = left + 'px';
        // clamp inside the pane
        const pr = content.getBoundingClientRect();
        if (pr.right > br.right - 6) { left -= (pr.right - (br.right - 6)); content.style.left = Math.max(6, left) + 'px'; }
        tbPop = content;
        tbPopDismiss = (e: Event) => {
          if (e.type === 'keydown') { if ((e as KeyboardEvent).key === 'Escape') { closeTbPop(); focusDoc(); } return; }
          const t = e.target as Node;
          if (content.contains(t) || anchor.contains(t)) return;
          closeTbPop();
        };
        document.addEventListener('mousedown', tbPopDismiss, true);
        document.addEventListener('keydown', tbPopDismiss, true);
      }

      const HEADINGS: [string, string, string][] = [
        ['Text', 'p', ''], ['Heading 1', 'h1', 'h1'], ['Heading 2', 'h2', 'h2'], ['Heading 3', 'h3', 'h3'],
      ];
      // the block tag wrapping the caret → its picker label (drives the button text)
      function currentBlockTag(): string {
        const md = editable(); const s = window.getSelection();
        if (!md || !s || !s.rangeCount) return 'p';
        let n: Node | null = s.getRangeAt(0).startContainer;
        while (n && n !== md) {
          if (n.nodeType === 1) { const t = (n as HTMLElement).tagName.toLowerCase(); if (/^(p|h1|h2|h3|h4|h5|h6|blockquote|pre|li)$/.test(t)) return t; }
          n = n.parentNode;
        }
        return 'p';
      }
      let headBtn: HTMLElement | null = null;
      function syncHeadLabel() {
        if (!headBtn) return;
        const tag = currentBlockTag();
        const row = HEADINGS.find((h) => h[1] === tag);
        const lbl = headBtn.querySelector('.lbl');
        const name = row ? row[0] : (tag === 'blockquote' ? 'Quote' : tag === 'pre' ? 'Code' : 'Text');
        if (lbl) lbl.textContent = name;
        // In a squeezed row the label hides and the H icon stands in, so the
        // tooltip has to carry what the button was saying.
        headBtn.title = 'Paragraph style: ' + name;
      }
      function openHeadMenu(anchor: HTMLElement) {
        if (tbPop) { closeTbPop(); return; }
        snapshotSel();
        anchor.classList.add('open');
        const cur = currentBlockTag();
        const menu = document.createElement('div'); menu.className = 'tbmenu';
        for (const [label, tag, cls] of HEADINGS) {
          const row = document.createElement('div'); row.className = 'row' + (tag === cur ? ' sel' : '');
          row.innerHTML = `<span class="tick">${icon('check', 13)}</span><span class="${cls}">${label}</span>`;
          row.addEventListener('mousedown', (e) => {
            e.preventDefault();
            restoreSel();
            // formatBlock toggles: applying the current heading again would nest;
            // 'Text' maps to <div>/<p> to clear a heading.
            document.execCommand('formatBlock', false, tag === 'p' ? 'p' : tag);
            onEditInput(); syncHeadLabel(); closeTbPop(); focusDoc();
          });
          menu.appendChild(row);
        }
        openTbPop(anchor, menu);
      }

      // Google-Docs-style size picker: hover to light an N×M block, click to
      // insert exactly that grid.
      function openTableGrid(anchor: HTMLElement) {
        if (tbPop) { closeTbPop(); return; }
        snapshotSel();
        const COLS = 8, ROWS = 6;
        const wrap = document.createElement('div');
        const grid = document.createElement('div'); grid.className = 'tbgrid';
        const label = document.createElement('div'); label.className = 'tbgridlabel'; label.textContent = '0 × 0';
        const cells: HTMLElement[] = [];
        const light = (nc: number, nr: number) => {
          cells.forEach((c) => {
            const cc = +c.dataset.c!, cr = +c.dataset.r!;
            c.classList.toggle('hot', cc <= nc && cr <= nr);
          });
          label.textContent = `${nc} × ${nr}`;
        };
        for (let r = 1; r <= ROWS; r++) for (let c = 1; c <= COLS; c++) {
          const cell = document.createElement('div'); cell.className = 'cell';
          cell.dataset.c = String(c); cell.dataset.r = String(r);
          cell.addEventListener('mouseenter', () => light(c, r));
          cell.addEventListener('mousedown', (e) => { e.preventDefault(); restoreSel(); insertTable(c, r); closeTbPop(); focusDoc(); });
          grid.appendChild(cell); cells.push(cell);
        }
        wrap.appendChild(grid); wrap.appendChild(label);
        openTbPop(anchor, wrap);
      }

      // Link input popover — replaces window.prompt (disabled in this WKWebView, so
      // the old prompt() silently returned null → "links don't work").
      function openLinkPop(anchor: HTMLElement) {
        if (tbPop) { closeTbPop(); return; }
        snapshotSel();
        const hadSel = !!savedRange && !savedRange.collapsed;
        const box = document.createElement('div'); box.className = 'tblinkpop';
        const input = document.createElement('input');
        input.type = 'text'; input.placeholder = 'https://…  or  [[Note]]';
        const go = document.createElement('button'); go.className = 'go'; go.textContent = 'Add';
        const apply = () => {
          const url = input.value.trim(); if (!url) { closeTbPop(); return; }
          restoreSel();
          if (hadSel) document.execCommand('createLink', false, url);
          else { const a = document.createElement('a'); a.href = url; a.textContent = url; insertAtCaret(a); }
          onEditInput(); closeTbPop(); focusDoc();
        };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
        go.addEventListener('mousedown', (e) => { e.preventDefault(); apply(); });
        box.appendChild(input); box.appendChild(go);
        openTbPop(anchor, box);
        setTimeout(() => input.focus(), 0);
      }

      // Image input popover — same shape as the link one. Takes a URL or a path;
      // a path is stored in the file EXACTLY as typed (that is what the markdown
      // has to say) while the on-screen img gets the resolved asset: URL, which is
      // the split data-md-src exists for.
      function openImagePop(anchor: HTMLElement) {
        if (tbPop) { closeTbPop(); return; }
        snapshotSel();
        const box = document.createElement('div'); box.className = 'tblinkpop';
        const input = document.createElement('input');
        input.type = 'text'; input.placeholder = 'shot.png  or  https://…';
        const go = document.createElement('button'); go.className = 'go'; go.textContent = 'Add';
        const apply = () => {
          const src = input.value.trim(); if (!src) { closeTbPop(); return; }
          restoreSel();
          insertImage(src);
          closeTbPop(); focusDoc();
        };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
        go.addEventListener('mousedown', (e) => { e.preventDefault(); apply(); });
        box.appendChild(input); box.appendChild(go);
        openTbPop(anchor, box);
        setTimeout(() => input.focus(), 0);
      }
      // Put one image at the caret. `src` is what the markdown will say; the
      // displayed src is resolved against the doc's folder so a relative path is
      // visible while you edit rather than a broken-image box. `known` is for a
      // file we just wrote — the path index hasn't seen it yet, so resolution by
      // lookup would miss something we already know the location of.
      function insertImage(src: string, alt = '', known?: string) {
        // Spaces and parens end a markdown image target, and copy_path's collision
        // suffix ("shot 2.png") produces exactly that. Encode on the way in; every
        // reader of these paths (resolveDocImage, wireImages) decodes.
        const mdSrc = /^[a-z][a-z0-9+.-]*:/i.test(src)
          ? src
          : src.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
        const img = document.createElement('img');
        img.dataset.mdSrc = mdSrc;
        img.alt = alt;
        const abs = known || (file ? resolveDocImage(mdSrc, file.path) : null);
        img.src = abs ? ipc.rawSrc(abs) : mdSrc;
        insertAtCaret(img);
      }

      // Build the formatting bar. execCommand is deprecated-but-reliable in this
      // WebKit/Chromium runtime and keeps the caret/selection semantics a
      // rich-text editor needs; the exotic actions (inline code, table, checklist)
      // are done with explicit DOM surgery.
      function buildToolbar() {
        toolbar.innerHTML = '';
        // custom heading dropdown (a themed button + .tbmenu popover)
        const head = document.createElement('button');
        head.type = 'button'; head.className = 'tbhead'; head.title = 'Paragraph style';
        head.innerHTML = `<span class="ic">${icon('heading', 15)}</span><span class="lbl">Text</span>${icon('chevron-down', 13)}`;
        head.addEventListener('mousedown', (e) => { e.preventDefault(); openHeadMenu(head); });
        headBtn = head;
        toolbar.appendChild(head);
        const sep = () => { const s = document.createElement('span'); s.className = 'tbsep'; toolbar.appendChild(s); };
        // mousedown (not click) preserves the doc selection — a click would blur
        // the contenteditable first and collapse the range the command needs.
        const btn = (ic: string, title: string, fn: (b: HTMLElement) => void) => {
          const b = document.createElement('button');
          b.type = 'button'; b.className = 'tb'; b.title = title; b.innerHTML = icon(ic, 16);
          b.addEventListener('mousedown', (e) => { e.preventDefault(); fn(b); });
          toolbar.appendChild(b);
          return b;
        };
        sep();
        // What acts on the text you have selected stays on the surface…
        btn('bold', 'Bold (⌘B)', () => exec('bold'));
        btn('italic', 'Italic (⌘I)', () => exec('italic'));
        btn('strikethrough', 'Strikethrough', () => exec('strikeThrough'));
        btn('code', 'Inline code', wrapInlineCode);
        sep();
        // …and everything that ADDS a block folds into one +. Thirteen buttons
        // did not fit this row at any pane width you'd actually use — they
        // silently ran off the end behind an overflow with no scroll affordance,
        // so half the editor was invisible. Six controls fit everywhere. The menu
        // prints each item's markdown shortcut beside it, which is the real
        // affordance: in a markdown editor you type `- `, you don't hunt for a
        // bullet button (see MD_RULES).
        btn('plus', 'Insert…', (b) => openInsertMenu(b));
        // After a frame, not now: the row is still laying out (the tab strip is
        // mid-collapse to one pill), so measuring here reads the pre-edit widths.
        // The ResizeObserver can't rescue it either — the header's own box is the
        // same size before and after, so entering edit mode never fires it.
        requestAnimationFrame(syncToolbarOverflow);
      }
      // Insert menu: label, icon, the markdown that also produces it, and the
      // action. Order is by reach — the blocks you make constantly first.
      const INSERTS: [string, string, string, () => void][] = [
        ['Bulleted list', 'list', '- ', () => exec('insertUnorderedList')],
        ['Numbered list', 'list-numbers', '1. ', () => exec('insertOrderedList')],
        ['Checklist', 'list-check', '[] ', insertTaskItem],
        ['Quote', 'quote', '> ', () => exec('formatBlock', 'blockquote')],
        ['Code block', 'braces', '```', insertCodeBlock],
        ['Divider', 'minus', '---', insertDivider],
      ];
      function openInsertMenu(anchor: HTMLElement) {
        if (tbPop) { closeTbPop(); return; }
        snapshotSel();
        anchor.classList.add('on');
        const menu = document.createElement('div'); menu.className = 'tbmenu tbinsert';
        const row = (label: string, ic: string, hint: string, fn: (b: HTMLElement) => void) => {
          const r = document.createElement('div'); r.className = 'row';
          // The hint is literal, trailing space included — `white-space: pre` on
          // the chip renders that space as chip, which says "then space" without
          // a ␣ glyph the system font may not even have.
          r.innerHTML = `<span class="ic">${icon(ic, 15)}</span><span class="lbl">${label}</span>` +
                        (hint ? `<span class="hint">${hint}</span>` : '');
          r.addEventListener('mousedown', (e) => { e.preventDefault(); fn(anchor); });
          menu.appendChild(r);
          return r;
        };
        for (const [label, ic, hint, fn] of INSERTS) {
          row(label, ic, hint, () => { restoreSel(); fn(); onEditInput(); closeTbPop(); focusDoc(); });
        }
        const rule = document.createElement('div'); rule.className = 'tbmenusep';
        menu.appendChild(rule);
        // These three open a popover of their own, so they must NOT close the
        // menu first — openLinkPop/openTableGrid replace it, anchored to the +.
        row('Link', 'link', '', (b) => { closeTbPop(); openLinkPop(b); });
        row('Image', 'photo', '', (b) => { closeTbPop(); openImagePop(b); });
        row('Table', 'table-plus', '', (b) => { closeTbPop(); openTableGrid(b); });
        openTbPop(anchor, menu);
      }
      // A row that clips with no scrollbar is a row that lies about what it
      // holds. The set above is sized to fit, but a pane can always be dragged
      // narrower than we planned for — so mark the state and let CSS fade the
      // edge, turning a silent truncation into a visible one.
      // Two passes, because the first one changes what the second measures: drop
      // to the compact picker only if the roomy one doesn't fit, then flag any
      // clipping that survives even that.
      function syncToolbarOverflow() {
        const over = () => toolbar.scrollWidth > toolbar.clientWidth + 1;
        toolbar.classList.remove('tight');
        if (over()) toolbar.classList.add('tight');
        toolbar.classList.toggle('clipped', over());
      }
      // Insert a BLOCK at the caret. insertAtCaret drops the node wherever the
      // range happens to be, which for a table or a code block means INSIDE the
      // paragraph you were typing in — block nested in block. Two cases instead:
      // an empty paragraph is REPLACED, and one you are partway through is SPLIT,
      // with the remainder carried into a new paragraph after the insert. That is
      // what every editor does, and it is what keeps the markdown serializable.
      function insertBlockAtCaret(node: Node) {
        const md = editable();
        const sel = window.getSelection();
        if (!md || !sel || !sel.rangeCount || !md.contains(sel.anchorNode)) { insertAtCaret(node); return; }
        const r = sel.getRangeAt(0);
        let block: HTMLElement | null = null;
        for (let n: Node | null = r.startContainer; n && n !== md; n = n.parentNode) {
          if (n.nodeType !== 1) continue;
          if (n.parentNode === md && /^(p|div|h[1-6])$/i.test((n as HTMLElement).tagName)) { block = n as HTMLElement; break; }
        }
        if (!block) { insertAtCaret(node); return; }
        r.deleteContents();
        // a fragment loses its identity the moment it is inserted, so hold its
        // last node now — that is what the remainder has to land after
        const lastNode = node.nodeType === 11 ? (node as DocumentFragment).lastChild : node;
        if (!block.textContent!.replace(/\u200b/g, '').trim()) {
          block.replaceWith(node);
          onEditInput();
          return;
        }
        const tail = document.createRange();
        tail.setStart(r.endContainer, r.endOffset);
        tail.setEnd(block, block.childNodes.length);
        const rest = tail.extractContents();
        block.after(node);
        if (rest.textContent!.trim() || rest.querySelector('img')) {
          const after = document.createElement('p');
          after.appendChild(rest);
          (lastNode as ChildNode | null)?.after(after);
        }
        onEditInput();
      }
      // Insert a fragment at the caret inside the editable surface.
      function insertAtCaret(node: Node) {
        const md = editable();
        if (!md) return;
        md.focus();
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount || !md.contains(sel.anchorNode)) { md.appendChild(node); }
        else { const r = sel.getRangeAt(0); r.deleteContents(); r.insertNode(node); r.collapse(false); }
        onEditInput();
      }
      // Wrap the selection in <code> (turndown → `inline`). Empty selection drops
      // an empty code span and parks the caret inside it.
      function wrapInlineCode() {
        const md = editable();
        if (!md) return;
        md.focus();
        const sel = window.getSelection();
        const code = document.createElement('code');
        if (sel && sel.rangeCount && !sel.isCollapsed && md.contains(sel.anchorNode)) {
          const r = sel.getRangeAt(0); code.textContent = r.toString(); r.deleteContents(); r.insertNode(code);
        } else {
          code.textContent = 'code'; insertAtCaret(code);
        }
        onEditInput();
      }
      // A fenced code block, built as <pre><code> rather than by formatBlock('pre').
      // turndown's fenced rule matches ONLY pre > code; the bare <pre> that
      // formatBlock produces fell through to the default block rule and came back
      // as loose text, so a code block silently stopped being one on the round
      // trip — which is what "Enter keeps splitting my code block" actually was.
      // The zero-width placeholder gives an empty block a line box to sit on and
      // is stripped by editHtmlToMd, so it never reaches the file.
      function insertCodeBlock() {
        const md = editable();
        if (!md) return;
        md.focus();
        const sel = window.getSelection();
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        const picked = sel && sel.rangeCount && !sel.isCollapsed && md.contains(sel.anchorNode)
          ? sel.getRangeAt(0).toString() : '';
        code.textContent = picked || '\u200b';
        pre.appendChild(code);
        const trail = document.createElement('p');   // somewhere to type after the block
        trail.innerHTML = '<br>';
        const frag = document.createDocumentFragment();
        frag.appendChild(pre); frag.appendChild(trail);
        insertBlockAtCaret(frag);
        // caret at the END of the block's first line, so you type over the
        // placeholder instead of in front of it
        try {
          const r = document.createRange(); r.selectNodeContents(code); r.collapse(false);
          const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(r);
        } catch {}
      }
      // A GFM task-list item — turndown-gfm serializes <li> with a leading
      // checkbox to `- [ ] `. Left BLANK (no "To-do" filler) with the caret parked
      // after the box so you just type the task; enabled so you can tick it too.
      function insertTaskItem() {
        const ul = document.createElement('ul');
        ul.className = 'contains-task-list';
        const li = document.createElement('li');
        li.className = 'task-list-item';
        const box = document.createElement('input');
        box.type = 'checkbox';
        li.appendChild(box); li.appendChild(document.createTextNode(' '));   // caret anchor
        ul.appendChild(li);
        insertBlockAtCaret(ul);
        // drop the caret right after the checkbox so typing fills the item
        try {
          const r = document.createRange(); r.selectNodeContents(li); r.collapse(false);
          const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(r);
        } catch {}
      }
      // An N×M GFM table (header row + rows-1 body rows). turndown-gfm renders it
      // back to a pipe table; visible cell edges (CSS) make it editable.
      function insertTable(cols: number, rows: number) {
        const table = document.createElement('table');
        const thead = table.createTHead();
        const hr = thead.insertRow();
        for (let c = 0; c < cols; c++) { const th = document.createElement('th'); th.textContent = 'Column ' + (c + 1); hr.appendChild(th); }
        const tb = table.createTBody();
        for (let r = 0; r < Math.max(1, rows - 1); r++) { const row = tb.insertRow(); for (let c = 0; c < cols; c++) { const td = row.insertCell(); td.textContent = ' '; } }
        const trail = document.createElement('p');   // trailing paragraph to type after the table
        trail.innerHTML = '<br>';
        const frag = document.createDocumentFragment();
        frag.appendChild(table); frag.appendChild(trail);
        insertBlockAtCaret(frag);
      }

      // ── markdown input rules ────────────────────────────────────────────
      // Typing markdown produces the block. This is the load-bearing half of the
      // toolbar collapse: `- ` is how someone writing markdown makes a bullet, so
      // the bullet BUTTON can move into the + menu without costing anything — and
      // the menu prints these shortcuts beside each item, so the surface teaches
      // them. Fires only when the marker is the WHOLE block with the caret at its
      // end, the conventional trigger and the one that cannot eat existing text.
      // Each rule gets `strip`, which deletes the marker characters, and decides
      // WHEN to call it. Order is load-bearing: execCommand's block commands
      // resolve which block they apply to from the live DOM, and an emptied
      // paragraph has no line box, so formatBlock on one reaches across its
      // neighbours and swallows them. Run the command while the marker is still
      // holding the block open, strip afterwards.
      const MD_RULES: [RegExp, (strip: () => void) => void][] = [
        [/^#$/, (strip) => { document.execCommand('formatBlock', false, 'h1'); strip(); }],
        [/^##$/, (strip) => { document.execCommand('formatBlock', false, 'h2'); strip(); }],
        [/^###$/, (strip) => { document.execCommand('formatBlock', false, 'h3'); strip(); }],
        [/^[-*+]$/, (strip) => { document.execCommand('insertUnorderedList'); strip(); }],
        [/^1[.)]$/, (strip) => { document.execCommand('insertOrderedList'); strip(); }],
        [/^\[ ?\]$/, (strip) => { document.execCommand('insertUnorderedList'); strip(); decorateTaskHere(); }],
        [/^>$/, (strip) => { document.execCommand('formatBlock', false, 'blockquote'); strip(); }],
      ];
      // Same idea, committed with Enter rather than a space — these markers have
      // no trailing space in the source. These two BUILD their block rather than
      // transforming the current one, so here the marker goes first: what they
      // want is the empty paragraph insertBlockAtCaret knows how to replace.
      const MD_ENTER_RULES: [RegExp, (strip: () => void) => void][] = [
        [/^```[a-z0-9+#-]*$/i, (strip) => { strip(); insertCodeBlock(); }],
        [/^(---|\*\*\*|___)$/, (strip) => { strip(); insertDivider(); }],
      ];
      // A divider, built rather than execCommand'd: insertHorizontalRule on an
      // empty paragraph has the same block-detection problem as formatBlock, and
      // this way the menu and the `---` rule produce identical DOM.
      function insertDivider() {
        const frag = document.createDocumentFragment();
        frag.appendChild(document.createElement('hr'));
        const trail = document.createElement('p'); trail.innerHTML = '<br>';
        frag.appendChild(trail);
        const last = trail;
        insertBlockAtCaret(frag);
        placeCaretStart(last);
      }
      // Delete the first `n` characters of the block the caret is in — the marker,
      // once whatever command it triggered has run and possibly moved it into a
      // new element (a <li>, the <p> inside a <blockquote>).
      function stripLeading(n: number) {
        const md = editable(); const s = window.getSelection();
        if (!md || !s || !s.rangeCount) return;
        let host: HTMLElement | null = null;
        for (let x: Node | null = s.getRangeAt(0).startContainer; x && x !== md; x = x.parentNode) {
          // blockquote is in the set because formatBlock REPLACES the paragraph
          // with one rather than wrapping it — leave it out and `> ` keeps its
          // marker while every other rule loses its own.
          if (x.nodeType === 1 && /^(p|div|li|h[1-6]|pre|blockquote)$/i.test((x as HTMLElement).tagName)) { host = x as HTMLElement; break; }
        }
        if (!host) return;
        let left = n;
        const walk = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
        let tn = walk.nextNode() as Text | null;
        while (left > 0 && tn) {
          const take = Math.min(left, tn.data.length);
          tn.deleteData(0, take);
          left -= take;
          tn = walk.nextNode() as Text | null;
        }
        placeCaretStart(host);
      }
      // Add the checkbox to the list item the caret is already in — same DOM
      // insertTaskItem builds. Split from the list command so the `[] ` rule can
      // strip its marker in between, before the checkbox claims firstChild.
      function decorateTaskHere() {
        const md = editable(); const s = window.getSelection();
        if (!md || !s || !s.rangeCount) return;
        let li: HTMLElement | null = null;
        for (let n: Node | null = s.getRangeAt(0).startContainer; n && n !== md; n = n.parentNode) {
          if (n.nodeType === 1 && (n as HTMLElement).tagName === 'LI') { li = n as HTMLElement; break; }
        }
        if (!li) return;
        li.classList.add('task-list-item');
        li.parentElement?.classList.add('contains-task-list');
        const box = document.createElement('input'); box.type = 'checkbox';
        li.insertBefore(document.createTextNode(' '), li.firstChild);
        li.insertBefore(box, li.firstChild);
        try {
          const r = document.createRange(); r.selectNodeContents(li); r.collapse(false);
          s.removeAllRanges(); s.addRange(r);
        } catch {}
      }
      /** Did a marker at the caret just become its block? Consumes the keystroke. */
      function applyMdRule(md: HTMLElement, sel: Selection, onEnter: boolean): boolean {
        const r = sel.getRangeAt(0);
        if (!r.collapsed) return false;
        // Only a plain paragraph opts in. A heading, quote, list item or code
        // block already IS what a rule would make, and inside one the marker is
        // content — `# ` in a code block means a comment, not a heading.
        let block: HTMLElement | null = null;
        for (let n: Node | null = r.startContainer; n && n !== md; n = n.parentNode) {
          if (n.nodeType !== 1) continue;
          const tag = (n as HTMLElement).tagName.toLowerCase();
          if (/^(li|pre|blockquote|h[1-6]|td|th|code)$/.test(tag)) return false;
          if (/^(p|div)$/.test(tag)) { block = n as HTMLElement; break; }
        }
        if (!block) return false;
        const text = block.textContent!.replace(/\u200b/g, '');
        const tail = document.createRange();
        tail.setStart(r.endContainer, r.endOffset); tail.setEnd(block, block.childNodes.length);
        if (tail.toString().replace(/\u200b/g, '') !== '') return false;   // caret must end the block
        for (const [re, fn] of (onEnter ? MD_ENTER_RULES : MD_RULES)) {
          if (!re.test(text)) continue;
          fn(() => stripLeading(text.length));   // the marker is syntax, not content
          syncHeadLabel();
          onEditInput();
          return true;
        }
        return false;
      }

      // Enter on an EMPTY list item / checklist row / blockquote line breaks out
      // of the block (→ a plain paragraph) instead of adding another empty one —
      // the Docs/Notion behaviour. A second Enter on the freshly-blank line thus
      // "deletes" it and drops you back to normal text. Inside a code block Enter
      // means a NEWLINE — the block is one multi-line unit, so the browser's
      // "split this block in two" default is exactly wrong there — and the same
      // ⏎-on-a-blank-line bargain is what gets you back out of it. Tab indents:
      // list nesting, the next table cell, a soft tab in code.
      function onEditKeydown(e: KeyboardEvent) {
        if ((e as any).isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key !== 'Enter' && e.key !== 'Tab' && e.key !== ' ') return;
        if (e.key === 'Enter' && e.shiftKey) return;
        const md = editable(); const sel = window.getSelection();
        if (!md || !sel || !sel.rangeCount) return;
        // Space only ever means "did a markdown marker just close?" — otherwise
        // it is an ordinary space and nothing below applies to it.
        if (e.key === ' ') { if (applyMdRule(md, sel, false)) e.preventDefault(); return; }
        if (e.key === 'Enter' && applyMdRule(md, sel, true)) { e.preventDefault(); return; }
        // nearest structural block around the caret (closest first)
        let li: HTMLElement | null = null, para: HTMLElement | null = null, bq: HTMLElement | null = null;
        let pre: HTMLElement | null = null, cell: HTMLElement | null = null;
        for (let n: Node | null = sel.getRangeAt(0).startContainer; n && n !== md; n = n.parentNode) {
          if (n.nodeType !== 1) continue;
          const tag = (n as HTMLElement).tagName.toLowerCase();
          if (tag === 'li' && !li) li = n as HTMLElement;
          else if (tag === 'p' && !para) para = n as HTMLElement;
          else if ((tag === 'td' || tag === 'th') && !cell) cell = n as HTMLElement;
          if (tag === 'blockquote' && !bq) bq = n as HTMLElement;
          if (tag === 'pre' && !pre) pre = n as HTMLElement;
        }
        const empty = (el: HTMLElement) => el.textContent!.replace(/[​ ]/g, '').trim() === '';
        const exitTo = (after: HTMLElement) => {
          const p = document.createElement('p'); p.innerHTML = '<br>';
          after.after(p);
          placeCaretStart(p);
          onEditInput();
        };
        if (e.key === 'Tab') {
          // Uncaught, Tab moves focus out of the document — in a writing surface
          // that reads as the editor losing your place. Every context with a
          // meaning claims it; the rest fall through to that default on purpose,
          // so it stays the keyboard escape from the editable.
          if (cell) { e.preventDefault(); moveCell(cell, e.shiftKey); }
          else if (li) {
            e.preventDefault();
            document.execCommand(e.shiftKey ? 'outdent' : 'indent');
            onEditInput();
          } else if (pre) { e.preventDefault(); insertInPre(pre, '  '); }
          return;
        }
        if (pre) {
          e.preventDefault();
          const r = sel.getRangeAt(0);
          const upto = document.createRange();
          upto.setStart(pre, 0); upto.setEnd(r.startContainer, r.startOffset);
          const rest = document.createRange();
          rest.setStart(r.endContainer, r.endOffset); rest.setEnd(pre, pre.childNodes.length);
          const before = upto.toString(), after = rest.toString().replace(/\u200b/g, '');
          // ⏎ on a blank last line leaves the block and takes the blank line with
          // it — the same bargain as the empty list item below.
          if (!after && /\n[ \t]*$/.test(before)) {
            const host = (pre.querySelector('code') as HTMLElement) || pre;
            host.textContent = before.replace(/\n[ \t]*$/, '');
            exitTo(pre);
            return;
          }
          insertInPre(pre, '\n');
          return;
        }
        if (li && empty(li)) {
          e.preventDefault();
          const list = li.parentElement!;
          exitTo(list);
          li.remove();
          if (!list.querySelector('li')) list.remove();
        } else if (bq && ((para && bq.contains(para) && empty(para)) || empty(bq))) {
          e.preventDefault();
          exitTo(bq);
          if (para && bq.contains(para)) para.remove();
          if (empty(bq)) bq.remove();
        }
      }

      // Drop literal text at the caret inside a code block, caret landing after
      // it. The sentinel is the subtle part: a newline that ENDS a block paints
      // no line box, so with nothing after it the caret appears stuck on the line
      // you just left (which is what "Enter doesn't do multi-line" looks like).
      // A zero-width space is the cheapest thing that occupies that line, and
      // editHtmlToMd already strips zero-widths, so it never reaches the file.
      function insertInPre(pre: HTMLElement, text: string) {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return;
        const r = sel.getRangeAt(0);
        r.deleteContents();
        const node = document.createTextNode(text);
        r.insertNode(node);
        const rest = document.createRange();
        rest.setStartAfter(node); rest.setEnd(pre, pre.childNodes.length);
        if (text.includes('\n') && !rest.toString()) {
          node.parentNode!.insertBefore(document.createTextNode('\u200b'), node.nextSibling);
        }
        const at = document.createRange();
        at.setStartAfter(node); at.collapse(true);
        sel.removeAllRanges(); sel.addRange(at);
        onEditInput();
      }
      // Tab / ⇧Tab between table cells in visual order, across row boundaries.
      // Tab out of the last cell appends a row, so a table grows by typing instead
      // of by reaching for the floating + control.
      function moveCell(cell: HTMLElement, back: boolean) {
        const table = cell.closest('table') as HTMLTableElement | null;
        if (!table) return;
        const cells = Array.from(table.querySelectorAll('th,td')) as HTMLElement[];
        const i = cells.indexOf(cell);
        if (i < 0) return;
        let next = cells[i + (back ? -1 : 1)] || null;
        if (!next && !back) {
          addRow(table);
          next = (table.querySelectorAll('th,td')[i + 1] as HTMLElement) || null;
        }
        if (!next) return;
        const r = document.createRange(); r.selectNodeContents(next);
        const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(r);
        onEditInput();
      }

      // ── table +/- controls (add column · add row) ──
      // Floating "+" bars hugging the right and bottom edge of the table under the
      // cursor. They live in .pvbody (not the contenteditable), so they are never
      // serialized. One pair per pane, repositioned to whichever table is hovered.
      let colCtl: HTMLButtonElement | null = null, rowCtl: HTMLButtonElement | null = null;
      let ctlTable: HTMLTableElement | null = null;
      let ctlHideTimer: ReturnType<typeof setTimeout> | null = null;
      function ensureTableCtls() {
        if (colCtl) return;
        colCtl = document.createElement('button');
        colCtl.className = 'tbtablectl col'; colCtl.type = 'button'; colCtl.title = 'Add column'; colCtl.innerHTML = icon('plus', 14);
        rowCtl = document.createElement('button');
        rowCtl.className = 'tbtablectl row'; rowCtl.type = 'button'; rowCtl.title = 'Add row'; rowCtl.innerHTML = icon('plus', 14);
        const keep = () => { if (ctlHideTimer) { clearTimeout(ctlHideTimer); ctlHideTimer = null; } };
        for (const b of [colCtl, rowCtl]) {
          b.addEventListener('mouseenter', keep);
          b.addEventListener('mouseleave', scheduleHideCtls);
          b.addEventListener('mousedown', (e) => e.preventDefault());   // don't blur the doc
        }
        colCtl.addEventListener('click', () => { if (ctlTable) { addColumn(ctlTable); positionTableCtls(); } });
        rowCtl.addEventListener('click', () => { if (ctlTable) { addRow(ctlTable); positionTableCtls(); } });
        bodyEl.appendChild(colCtl); bodyEl.appendChild(rowCtl);
      }
      function positionTableCtls() {
        if (!ctlTable || !colCtl || !rowCtl) return;
        const tr = ctlTable.getBoundingClientRect(), br = bodyEl.getBoundingClientRect();
        colCtl.style.left = (tr.right - br.left + 4) + 'px';
        colCtl.style.top = (tr.top - br.top) + 'px';
        colCtl.style.height = tr.height + 'px';
        rowCtl.style.left = (tr.left - br.left) + 'px';
        rowCtl.style.top = (tr.bottom - br.top + 4) + 'px';
        rowCtl.style.width = tr.width + 'px';
        colCtl.classList.add('show'); rowCtl.classList.add('show');
      }
      function showTableCtls(table: HTMLTableElement) {
        ensureTableCtls();
        if (ctlHideTimer) { clearTimeout(ctlHideTimer); ctlHideTimer = null; }
        ctlTable = table;
        positionTableCtls();
      }
      function scheduleHideCtls() {
        if (ctlHideTimer) clearTimeout(ctlHideTimer);
        ctlHideTimer = setTimeout(() => {
          colCtl?.classList.remove('show'); rowCtl?.classList.remove('show'); ctlTable = null;
        }, 220);
      }
      function onEditTableHover(e: MouseEvent) {
        if (!editing) return;
        const t = (e.target as HTMLElement).closest('table') as HTMLTableElement | null;
        if (t && renderBox.contains(t)) showTableCtls(t);
        else if (ctlTable) scheduleHideCtls();
      }
      function onEditScroll() { if (ctlTable) positionTableCtls(); }
      function addColumn(table: HTMLTableElement) {
        const headRow = table.tHead?.rows[0];
        const n = headRow ? headRow.cells.length : (table.rows[0]?.cells.length || 0);
        if (headRow) { const th = document.createElement('th'); th.textContent = 'Column ' + (n + 1); headRow.appendChild(th); }
        for (const tb of Array.from(table.tBodies)) for (const row of Array.from(tb.rows)) row.insertCell().textContent = ' ';
        onEditInput();
      }
      function addRow(table: HTMLTableElement) {
        const tb = table.tBodies[0] || table.createTBody();
        const cols = table.tHead?.rows[0]?.cells.length || tb.rows[0]?.cells.length || 1;
        const row = tb.insertRow();
        for (let c = 0; c < cols; c++) row.insertCell().textContent = ' ';
        onEditInput();
      }

      // The pencil is the single edit toggle: enter from read mode, commit+leave
      // from edit mode (it renders as a ✓ there — see enterEdit/exitEdit).
      // The one edit toggle behind BOTH the pencil and ⌘E: HTML in-place edit
      // and markdown WYSIWYG share this control, so the entry point is shared too.
      function toggleAnyEdit() {
        if (htmlEditing) { exitHtmlEdit(true); return; }   // HTML in-place edit shares this pencil
        if (canEditHtml()) { enterHtmlEdit(); return; }
        if (editing) exitEdit(true); else enterEdit();
      }
      pencilBtn.addEventListener('click', toggleAnyEdit);
      const headSelSync = () => { if (editing) syncHeadLabel(); };

      // Live view is a ⌘K command, not a button — off → on; already on → flip the
      // split orientation (stacked ⇄ side by side). Leave live by clicking source
      // or rendered. Only offered for files that actually have a rendered view.
      function toggleLiveSplit() {
        if (!file || !canLiveSplit()) return;
        if (view === 'live') setLiveSplit(liveSplit() === 'col' ? 'row' : 'col');
        else setView('live');
      }
      // Mirrors setView's `showSeg`: media and web/live-URL docs are
      // rendered-only, code/text editor-only. Neither has two halves to split.
      function canLiveSplit() {
        return !!file && !file.media && !(file.web || file.liveurl) && hasRendered(file.name);
      }
      saveEl.addEventListener('click', saveDoc);

      // ── undo/redo (⌘Z / ⇧⌘Z) ────────────────────────────────────────
      // Burst-grained snapshots on the PvDoc: a pause longer than 600ms closes
      // a step, so undo rewinds typing runs, not single characters. History
      // survives tab switches and agent reloads — the two places assigning
      // editor.value silently wiped the native stack.
      function pushUndo(tab: PvDoc, value: string) {
        const u = (tab.undo = tab.undo || []);
        if (u.length && u[u.length - 1].v === value) return;
        u.push({ v: value, s: editor.selectionStart, e: editor.selectionEnd });
        if (u.length > 200) u.shift();   // bound memory on long sessions
        tab.redo = [];
      }
      // set the editor to a snapshot and run the whole post-edit pipeline
      function applySnapshot(text: string, selS: number, selE: number) {
        editor.value = text;
        lastSeen = text;
        lastEditAt = 0;
        if (file) {
          file.draft = text;
          setDirty(text !== file.content);   // undone back to disk state = clean
        }
        try { editor.setSelectionRange(selS, selE); } catch {}
        highlightEditor();
        if (view === 'live') paintRendered();
      }
      editor.addEventListener('keydown', (e) => {
        if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
        const k = e.key.toLowerCase();
        if (k !== 'z' && k !== 'y') return;
        e.preventDefault();   // ours replaces the native stack we keep invalidating
        if (!file) return;
        const redo = k === 'y' || e.shiftKey;
        const from = redo ? file.redo : file.undo;
        if (!from || !from.length) return;
        const to = redo ? (file.undo = file.undo || []) : (file.redo = file.redo || []);
        to.push({ v: editor.value, s: editor.selectionStart, e: editor.selectionEnd });
        const st = from.pop()!;
        applySnapshot(st.v, st.s, st.e);
      });

      let liveTimer: ReturnType<typeof setTimeout> | null = null;
      editor.addEventListener('input', () => {
        // a fresh burst of typing checkpoints the pre-burst text for ⌘Z
        const now = Date.now();
        if (file && now - lastEditAt > 600) pushUndo(file, lastSeen);
        lastEditAt = now;
        // Editing promotes the active tab out of the recyclable live slot — once
        // you've typed into it, no agent/tree open can recycle it shut.
        if (file && file.ephemeral) { file.ephemeral = false; renderPvTabs(); }
        if (file) file.draft = editor.value;   // keep the working copy current for tab switches
        if (!dirty) setDirty(true);
        highlightEditor();
        lastSeen = editor.value;
        // live mode: the rendered half chases the keystrokes (debounced — a
        // full re-render per key would chug on big docs).
        if (view === 'live') {
          if (liveTimer) clearTimeout(liveTimer);
          liveTimer = setTimeout(() => { liveTimer = null; if (view === 'live') paintRendered(); }, 120);
        }
      });
      editor.addEventListener('scroll', syncEditorScroll);
      // ⌘S is handled window-level (saves the focused pane) — see the global
      // keydown by the footer toggles. No per-editor handler, so it can't double-fire.

      // ── comment-to-agent ────────────────────────────────────────────
      // Select text in the preview (source OR rendered markdown) and a chip
      // offers to send a note to the session that owns this work, over the
      // same PTY-write path file-drops and screenshot-pastes already use.
      // The note is anchored by source line range when we can pin it, else
      // by the quoted text — the agent resolves either. The selection is
      // snapshotted on mouseup: opening the composer clears the live DOM
      // selection, so we can't read it back lazily.
      type CmSel = { text: string; loc: string; anchor?: { prefix: string; suffix: string } };
      type CmItem = { sel: CmSel; comment: string };
      let cmChip: HTMLElement | null = null;
      let cmPop: HTMLElement | null = null;
      let cmTrayEl: HTMLElement | null = null;
      let cmDismiss: ((e: Event) => void) | null = null;
      // The pending queue: Add (⌥↵) parks a note here; Send (⌘↵) flushes the
      // queue plus whatever's in the open composer as ONE message. Ephemeral by
      // design — cleared on send, lost if the pane closes. Send-now is the fast
      // path (queue stays empty); the tray only appears once you Add.
      const cmQueue: CmItem[] = [];

      function cmClose() {
        cmChip?.remove(); cmChip = null;
        cmPop?.remove(); cmPop = null;
        if (cmDismiss) {
          document.removeEventListener('mousedown', cmDismiss, true);
          document.removeEventListener('keydown', cmDismiss, true);
          cmDismiss = null;
        }
      }
      function cmArmDismiss() {
        if (cmDismiss) return;
        cmDismiss = (e: Event) => {
          if (e.type === 'keydown') { if ((e as KeyboardEvent).key === 'Escape') cmClose(); return; }
          const t = e.target as Node;
          if (cmChip?.contains(t) || cmPop?.contains(t) || cmTrayEl?.contains(t)) return;
          cmClose();
        };
        document.addEventListener('mousedown', cmDismiss, true);
        document.addEventListener('keydown', cmDismiss, true);
      }
      // Root-relative placement, fully JS-computed so it can never clip: prefer
      // above the anchor, drop below when there's no room, then clamp top AND
      // bottom into the pane. Horizontal centering is the only thing left to CSS
      // (translateX(-50%)); vertical is an explicit top, measured from the
      // element's REAL height — the stale-height-vs-transform mismatch is what
      // used to push the composer's header off the top edge.
      function cmPlace(el: HTMLElement, clientX: number, clientY: number) {
        const r = root.getBoundingClientRect();
        const m = 10, gap = 10;
        const w = el.offsetWidth, h = el.offsetHeight;
        const ax = clientX - r.left, ay = clientY - r.top;
        const x = Math.max(w / 2 + m, Math.min(ax, r.width - w / 2 - m));
        let top = ay - h - gap;                 // above the anchor
        if (top < m) top = ay + gap;            // no room above → below it
        top = Math.max(m, Math.min(top, r.height - h - m));   // never off either edge
        el.style.left = x + 'px';
        el.style.top = top + 'px';
      }
      // best-effort source location for a rendered-view selection: locate the
      // quoted text in the file and turn its offset into a line range.
      function cmLocFor(quote: string): string {
        const fname = file ? file.name : 'this file';
        const src = (dirty ? editor.value : (file ? file.content : '')) || '';
        const needle = quote.trim();
        const i = needle ? src.indexOf(needle) : -1;
        if (i < 0) return fname;
        const a = src.slice(0, i).split('\n').length;
        const b = src.slice(0, i + needle.length).split('\n').length;
        return file ? `${fname}:${a}${b > a ? '-' + b : ''}` : `lines ${a}-${b}`;
      }
      function cmCapture(): CmSel | null {
        // source / live editor: exact line numbers straight from the textarea
        if (view !== 'rendered' && editWrap.classList.contains('show')) {
          const s = editor.selectionStart, e = editor.selectionEnd;
          if (e > s) {
            const text = editor.value.slice(s, e);
            const a = editor.value.slice(0, s).split('\n').length;
            const b = editor.value.slice(0, e).split('\n').length;
            const loc = file ? `${file.name}:${a}${b > a ? '-' + b : ''}` : `lines ${a}-${b}`;
            return { text, loc };
          }
        }
        // rendered markdown / csv: DOM selection, anchored by quoted text
        if (view !== 'source') {
          const sel = window.getSelection();
          if (sel && !sel.isCollapsed && sel.rangeCount &&
              renderBox.contains(sel.getRangeAt(0).commonAncestorContainer)) {
            const range = sel.getRangeAt(0);
            const text = sel.toString();
            if (text.trim()) return { text, loc: cmLocFor(text), anchor: annotAnchorFor(range, text) };
          }
        }
        return null;
      }
      // "the relevant agent": the focused session — the keyboard target, which
      // is whoever you were last talking to. null when none is live.
      function cmTarget(): any { return active && active.ptyAlive ? active : null; }

      function cmShowChip(sel: CmSel, clientX: number, clientY: number) {
        cmClose();
        const chip = document.createElement('button');
        chip.className = 'cmchip';
        // note-first everywhere; the agent is a secondary in the composer.
        // Bubble+plus, NOT a pencil: the pencil in the pane header means "edit
        // this page", and two pencils on one screen read as the same action.
        chip.innerHTML = icon('message-plus', 13) + '<span>Note</span>';
        chip.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
        chip.addEventListener('click', (e) => { e.stopPropagation(); cmShowComposer(sel, clientX, clientY); });
        root.appendChild(chip);
        cmChip = chip;
        cmPlace(chip, clientX, clientY);
        cmArmDismiss();
      }
      function cmShowComposer(sel: CmSel, clientX: number, clientY: number) {
        cmChip?.remove(); cmChip = null;
        const tgt = cmTarget();
        const pop = document.createElement('div');
        pop.className = 'cmpop';
        // One composer, note-first everywhere. KEEP saves your note — the default
        // act of a thinking tool. SEND hands the same passage to the agent and
        // appears ONLY on a working file with a live session; never on an article
        // (reading is read-and-keep, the agent isn't part of it).
        const reading = !!(file && file.web);
        const quote = document.createElement('div'); quote.className = 'cmquote'; quote.textContent = sel.text.trim();
        const ta = document.createElement('textarea');
        ta.className = 'cmta'; ta.rows = 2;
        ta.placeholder = 'Your thought…';
        const foot = document.createElement('div'); foot.className = 'cmfoot';
        // Send targets: EVERY live agent session, not just the focused one. The
        // target chip shows where a send lands; with more than one live agent it
        // opens an inline picker so you can route the passage to a specific one.
        // (Reading an article stays keep-only — the agent isn't part of it.)
        const live = (sessions as any[]).filter((s) => s.ptyAlive);
        let curTarget: any = (tgt && live.indexOf(tgt) >= 0) ? tgt : (live[0] || null);
        let sessList: HTMLElement | null = null;
        const sessColor = (s: any) => { const g = laneGroupFor(s); return (g && g.color) || s.laneColorFrozen || ''; };

        const pickBtn = document.createElement('button'); pickBtn.className = 'cmpick';
        const renderTargetChip = () => {
          pickBtn.textContent = '';
          const dot = document.createElement('span'); dot.className = 'cmpick-dot';
          const c = curTarget ? sessColor(curTarget) : ''; if (c) dot.style.background = c;
          const nm = document.createElement('span'); nm.className = 'cmpick-nm';
          nm.textContent = curTarget ? curTarget.name : 'no agent';
          pickBtn.append(dot, nm);
          if (live.length > 1) pickBtn.insertAdjacentHTML('beforeend', icon('chevron-down', 11));
        };
        const collapseSess = () => { if (sessList) { sessList.remove(); sessList = null; pickBtn.classList.remove('open'); reflow(); } };
        const expandSess = () => {
          if (sessList) { collapseSess(); return; }
          sessList = document.createElement('div'); sessList.className = 'cmsesslist';
          for (const s of live) {
            const row = document.createElement('button'); row.className = 'cmsessrow';
            if (s === curTarget) row.classList.add('sel');
            const dot = document.createElement('span'); dot.className = 'cmsessdot';
            const c = sessColor(s); if (c) dot.style.background = c;
            const nm = document.createElement('span'); nm.className = 'cmsessnm'; nm.textContent = s.name;
            row.append(dot, nm);
            if (s === active) { const me = document.createElement('span'); me.className = 'cmsessyou'; me.textContent = 'focused'; row.append(me); }
            row.addEventListener('click', (e) => { e.stopPropagation(); curTarget = s; renderTargetChip(); collapseSess(); });
            sessList.appendChild(row);
          }
          pickBtn.classList.add('open');
          pop.insertBefore(sessList, foot);
          reflow();
        };

        // secondary: send the passage to the chosen agent (accent-outlined).
        const send = (!reading && curTarget) ? document.createElement('button') : null;
        if (send) {
          send.className = 'cmsendto';
          send.innerHTML = icon('arrow-right', 11) + '<span>Send</span><span class="k">⌥↵</span>';
          send.title = 'Send the passage to the chosen agent';
        }
        // primary: keep as your note. A rendered selection becomes a highlight;
        // a source selection is quote-anchored (it surfaces when you view rendered).
        const keep = document.createElement('button'); keep.className = 'cmsend';
        keep.innerHTML = 'Keep <span class="k">⌘↵</span>';
        keep.title = 'Keep as a note';

        if (!reading && curTarget) {
          renderTargetChip();
          if (live.length > 1) { pickBtn.title = 'Choose which agent to send to'; pickBtn.addEventListener('click', (e) => { e.stopPropagation(); expandSess(); }); }
          else { pickBtn.classList.add('solo'); pickBtn.title = `Send to ${curTarget.name}`; }
          foot.append(pickBtn);
        }
        const actions = document.createElement('div'); actions.className = 'cmactions';
        if (send) actions.append(send);
        actions.append(keep);
        foot.append(actions);

        pop.append(quote, ta, foot);   // no loc line — a line number is noise here
        root.appendChild(pop);
        cmPop = pop;
        const reflow = () => {
          ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
          ta.style.overflowY = ta.scrollHeight > 160 ? 'auto' : 'hidden';   // scrollbar only past the cap, never on the empty box
          const top = parseFloat(pop.style.top);
          if (!isNaN(top)) {
            const r = root.getBoundingClientRect();
            const over = top + pop.offsetHeight - (r.height - 10);
            if (over > 0) pop.style.top = Math.max(10, top - over) + 'px';
          }
        };
        reflow(); cmPlace(pop, clientX, clientY); cmArmDismiss(); ta.focus();
        ta.addEventListener('input', reflow);
        const doKeep = () => { addAnnot(sel, ta.value.trim()); cmClose(); };
        const doSend = () => { if (curTarget) cmFlush([{ sel, comment: ta.value.trim() }], curTarget, clientX, clientY); };
        keep.addEventListener('click', doKeep);
        if (send) send.addEventListener('click', doSend);
        ta.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doKeep(); }
          else if (e.key === 'Enter' && e.altKey && send) { e.preventDefault(); doSend(); }
          else if (e.key === 'Escape') { e.preventDefault(); if (sessList) collapseSess(); else cmClose(); }
        });
      }
      // Compose one bracketed-paste payload from N queued notes (a count header
      // when there's more than one), write it to the session's prompt, submit.
      function cmFlush(items: CmItem[], tgt: any, clientX: number, clientY: number) {
        if (!items.length || !tgt) return;
        const block = (it: CmItem) => {
          const body = it.sel.text.trim();
          const quoted = (body.length > 400 ? body.slice(0, 400) + '…' : body).replace(/\n/g, '\n> ');
          return `Re ${it.sel.loc}:\n> ${quoted}` + (it.comment ? `\n\n${it.comment}` : '');
        };
        const msg = items.length > 1
          ? `${items.length} comments:\n\n` + items.map(block).join('\n\n')
          : block(items[0]);
        // Bracketed paste keeps the inner newlines literal so the REPL doesn't
        // submit on each one; the trailing CR is the actual send. Flip
        // CM_SUBMIT to false to drop it into the prompt for review instead.
        const CM_SUBMIT = true;
        ipc.ptyWrite(tgt.ptyId, '\x1b[200~' + msg + '\x1b[201~')
          .then(() => { if (CM_SUBMIT) return ipc.ptyWrite(tgt.ptyId, '\r'); })
          .catch(() => {});
        try { tgt.term.focus(); } catch {}
        logAction('comment_send', { count: items.length, target: tgt.name });
        cmClose();
        cmRenderTray();   // queue is empty now → tears the tray down
        const n = items.length;
        const toast = document.createElement('div');
        toast.className = 'cmtoast';
        toast.innerHTML = icon('check', 13) + `<span>Sent ${n > 1 ? n + ' ' : ''}to ${tgt.name}</span>`;
        root.appendChild(toast);
        cmPlace(toast, clientX, clientY);
        setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 220); }, 1250);
      }
      // The pending tray: docked bottom-right of the pane, present only while
      // the queue has notes. It IS the spatial record (loc + note per row) —
      // the glanceable "don't forget one" affordance — and the only place to
      // drop a queued note or send the batch.
      function cmRenderTray() {
        cmTrayEl?.remove(); cmTrayEl = null;
        if (!cmQueue.length) return;
        const tray = document.createElement('div');
        tray.className = 'cmtray';
        const list = document.createElement('div'); list.className = 'cmtraylist';
        cmQueue.forEach((it, idx) => {
          const row = document.createElement('div'); row.className = 'cmtrayrow';
          const loc = document.createElement('span'); loc.className = 'loc'; loc.textContent = it.sel.loc;
          const tx = document.createElement('span'); tx.className = 'tx'; tx.textContent = it.comment;
          const del = document.createElement('button'); del.className = 'del'; del.innerHTML = icon('x', 11); del.title = 'Remove';
          del.addEventListener('click', () => { cmQueue.splice(idx, 1); cmRenderTray(); });
          row.append(loc, tx, del);
          list.appendChild(row);
        });
        const foot = document.createElement('div'); foot.className = 'cmtrayfoot';
        const count = document.createElement('span'); count.className = 'cmtraycount';
        count.textContent = `${cmQueue.length} queued`;
        const sendAll = document.createElement('button'); sendAll.className = 'cmsend'; sendAll.textContent = 'Send all';
        const tgt = cmTarget();
        sendAll.disabled = !tgt;
        sendAll.addEventListener('click', () => {
          const r = tray.getBoundingClientRect();
          cmFlush(cmQueue.splice(0), cmTarget(), r.left + r.width / 2, r.top);
        });
        foot.append(count, sendAll);
        tray.append(list, foot);
        root.appendChild(tray);
        cmTrayEl = tray;
      }

      // Mouse-driven trigger in either surface. Deferred a tick so the
      // selection is settled before we read it.
      bodyEl.addEventListener('mouseup', (e: MouseEvent) => {
        if ((e.target as HTMLElement)?.closest?.('.cmchip, .cmpop, .pvfind')) return;
        setTimeout(() => {
          // A selection inside the open editor is a text cursor, not a passage
          // to annotate — offering "Note" there would fight the edit.
          if (editing) return;
          // Nor is a find hit: the bar selects each match as you step through it,
          // so without this every ⌘F lands a Note chip on top of the find bar.
          if (findBar.classList.contains('show')) return;
          const sel = cmCapture();
          if (!sel || !sel.text.trim()) return;
          // Anchor the chip to the selection's ACTIVE end (the focus caret —
          // where you finished dragging), not the bounding box: a multi-line
          // selection's box top would float the chip up by its whole height.
          // Fall back to the last line rect, then the cursor (editor selects).
          let x = e.clientX, y = e.clientY;
          const s = window.getSelection();
          if (s && s.rangeCount && renderBox.contains(s.getRangeAt(0).commonAncestorContainer)) {
            let rc: DOMRect | null = null;
            if (s.focusNode) {
              try {
                const fr = document.createRange();
                fr.setStart(s.focusNode, s.focusOffset); fr.collapse(true);
                rc = fr.getBoundingClientRect();
              } catch {}
            }
            if (!rc || (!rc.width && !rc.height)) {
              const rects = s.getRangeAt(0).getClientRects();
              if (rects.length) rc = rects[rects.length - 1] as DOMRect;
            }
            if (rc && (rc.width || rc.height)) { x = rc.left + rc.width / 2; y = rc.top; }
          }
          cmShowChip(sel, x, y);
        }, 0);
      });
      // Keyboard path: ⌘J opens the composer for the current editor selection
      // (no chip — the keyboard never produced a mouse anchor).
      editor.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'j') {
          const sel = cmCapture();
          if (sel && sel.text.trim()) {
            e.preventDefault();
            const r = editor.getBoundingClientRect();
            cmShowComposer(sel, r.left + r.width / 2, r.top + 90);
          }
        }
      });

      // ── persistent annotations (highlight + note) ─────────────────────
      // Mark up a rendered doc: highlight a passage, optionally attach a note.
      // Stored per-file in localStorage, re-anchored to the rendered text on
      // every render (by quote + surrounding context) and painted with the CSS
      // Custom Highlight API — no DOM mutation, so it survives re-render. Click a
      // highlight to read / edit / delete its note. The self-directed sibling of
      // comment-to-agent: notes you KEEP, vs. notes you send. A selection inside a
      // sandboxed HTML preview reaches here via SPIKE_BRIDGE and roll up into the
      // vault note the same way — the coloured highlight just can't repaint back
      // inside that frame (parent can't reach its DOM), so only the note persists.
      type Annot = { id: string; quote: string; prefix: string; suffix: string; note: string; at: number };
      // Annotations paint as real DOM <span class="spike-annot"> wrappers (not the
      // CSS Custom Highlight API): they style richly, are directly clickable, and —
      // crucially — clear reliably on delete (WKWebView leaves stale Custom-Highlight
      // paint behind). Find still uses Custom Highlight; annotations don't.
      let annotPop: HTMLElement | null = null;

      const annotKey = () => (file ? 'spike-annot:' + file.path : null);
      function loadAnnots(): Annot[] {
        const k = annotKey(); if (!k) return [];
        try { const v = JSON.parse(localStorage.getItem(k) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
      }
      function storeAnnots(list: Annot[]) {
        const k = annotKey(); if (!k) return;
        try { localStorage.setItem(k, JSON.stringify(list)); } catch {}
      }
      // flat rendered-text offset of a DOM boundary within renderBox.
      function annotOffsetOf(node: Node, off: number): number {
        const r = document.createRange();
        try { r.setStart(renderBox, 0); r.setEnd(node, off); } catch { return 0; }
        return r.toString().length;
      }
      // context around a fresh selection, captured for robust re-anchoring later.
      function annotAnchorFor(range: Range, quote: string): { prefix: string; suffix: string } {
        const full = renderBox.textContent || '';
        const start = annotOffsetOf(range.startContainer, range.startOffset);
        const end = start + quote.length;
        return { prefix: full.slice(Math.max(0, start - 32), start), suffix: full.slice(end, end + 32) };
      }
      // flat text offset → DOM (text node, offset) within renderBox.
      function annotPointAt(offset: number): { node: Text; off: number } | null {
        const w = document.createTreeWalker(renderBox, NodeFilter.SHOW_TEXT);
        let acc = 0, n: Node | null;
        while ((n = w.nextNode())) {
          const len = (n.nodeValue || '').length;
          if (offset <= acc + len) return { node: n as Text, off: offset - acc };
          acc += len;
        }
        return null;
      }
      // Fold runs of whitespace to a single space, keeping a map from each
      // folded-string index back to its raw index — so a match found in the
      // collapsed text can be reported in raw-offset terms (which annotPointAt
      // walks). map[i] = raw index where folded char i starts; the trailing
      // sentinel map[len] = raw.length lets us read the end of the last char.
      function foldWs(raw: string): { norm: string; map: number[] } {
        let norm = ''; const map: number[] = []; let ws = false;
        for (let i = 0; i < raw.length; i++) {
          const c = raw.charCodeAt(i);
          const isWs = c === 32 || c === 9 || c === 10 || c === 13 || c === 0xa0 || c === 12;
          if (isWs) { if (!ws) { norm += ' '; map.push(i); ws = true; } }
          else { norm += raw[i]; map.push(i); ws = false; }
        }
        map.push(raw.length);
        return { norm, map };
      }
      // Whitespace-tolerant locate of `quote` in `full`, best occurrence broken
      // by how much saved prefix/suffix context each candidate matches. Returns
      // raw [start,end) offsets into `full`, or null. Both sides are folded so a
      // rendered quote (collapsed spaces) matches raw source (newlines/indent).
      function fuzzyFind(full: string, quote: string, prefix: string, suffix: string): { start: number; end: number } | null {
        const H = foldWs(full);
        const nq = quote.replace(/\s+/g, ' ').trim();
        if (!nq) return null;
        const np = (prefix || '').replace(/\s+/g, ' ');
        const ns = (suffix || '').replace(/\s+/g, ' ');
        let best = -1, bestScore = -1, from = 0, at: number;
        while ((at = H.norm.indexOf(nq, from)) !== -1) {
          const pre = H.norm.slice(Math.max(0, at - 32), at);
          const suf = H.norm.slice(at + nq.length, at + nq.length + 32);
          let s = 0; while (s < pre.length && s < np.length && pre[pre.length - 1 - s] === np[np.length - 1 - s]) s++;
          let s2 = 0; while (s2 < suf.length && s2 < ns.length && suf[s2] === ns[s2]) s2++;
          if (s + s2 > bestScore) { bestScore = s + s2; best = at; }
          from = at + 1;
        }
        if (best < 0) return null;
        return { start: H.map[best], end: H.map[best + nq.length] };
      }
      // best occurrence of the saved quote in the current render → a Range. Ties
      // are broken by how much of the saved prefix/suffix the candidate matches,
      // so a quote that recurs anchors to the spot the user actually marked.
      // The match is WHITESPACE-TOLERANT: the saved quote is RENDERED text (a
      // selection's toString() collapses runs of whitespace to one space), but
      // the haystack is the raw text-node concatenation (newlines + indentation
      // intact). A plain indexOf misses any quote that crossed an element or
      // line-wrap boundary — the "save works on some selections, not others"
      // bug. fuzzyFind folds whitespace on both sides, matches, then maps the
      // hit back to raw offsets so annotPointAt still lands on real DOM points.
      function locateAnnot(a: Annot): Range | null {
        if (!a.quote) return null;
        const full = renderBox.textContent || '';
        const hit = fuzzyFind(full, a.quote, a.prefix, a.suffix);
        if (!hit) return null;
        const sp = annotPointAt(hit.start), ep = annotPointAt(hit.end);
        if (!sp || !ep) return null;
        const r = document.createRange();
        try { r.setStart(sp.node, sp.off); r.setEnd(ep.node, ep.off); } catch { return null; }
        return r;
      }
      // Strip the annotation spans, restoring clean text so the next re-anchor
      // sees the original DOM offsets.
      function unwrapAnnots() {
        renderBox.querySelectorAll('span.spike-annot').forEach((s) => {
          const p = s.parentNode; if (!p) return;
          while (s.firstChild) p.insertBefore(s.firstChild, s);
          p.removeChild(s);
        });
        renderBox.normalize();   // merge the split text nodes back together
      }
      // Wrap a located range as <span class="spike-annot" data-annot=id>, one span
      // per intersected text node (surroundContents only works within a node).
      function wrapRange(range: Range, id: string) {
        const host = range.commonAncestorContainer;
        const nodes: Text[] = [];
        if (host.nodeType === 3) nodes.push(host as Text);
        else {
          const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
          let n: Node | null; while ((n = w.nextNode())) if (range.intersectsNode(n)) nodes.push(n as Text);
        }
        for (const node of nodes) {
          const r = document.createRange();
          r.selectNodeContents(node);
          if (node === range.startContainer) r.setStart(node, range.startOffset);
          if (node === range.endContainer) r.setEnd(node, range.endOffset);
          if (r.collapsed) continue;
          const span = document.createElement('span');
          span.className = 'spike-annot'; span.dataset.annot = id;
          try { r.surroundContents(span); } catch {}
        }
      }
      // (re)paint every annotation for the current file. Locate all ranges on the
      // CLEAN DOM first, then wrap from last to first so wrapping a later range
      // can't shift an earlier one's offsets.
      function renderAnnots() {
        notesRefresh();   // the drawer + count badge track every render / change
        unwrapAnnots();
        if (!file || view === 'source') return;
        const located: { id: string; start: number; range: Range }[] = [];
        for (const a of loadAnnots()) {
          const r = locateAnnot(a);
          if (r) located.push({ id: a.id, start: annotOffsetOf(r.startContainer, r.startOffset), range: r });
        }
        located.sort((x, y) => y.start - x.start);
        for (const it of located) wrapRange(it.range, it.id);
        frameAnnotsSync();   // HTML previews paint inside their sandboxed frame
      }
      // Push the saved notes into the live HTML frame so KEEP paints a highlight
      // there too (the parent can't reach the sandbox's DOM). No-op for markdown /
      // non-HTML views, which paint their highlights directly in renderBox above.
      function frameAnnotsSync() {
        if (!curFrame || !curFrame.contentWindow || !htmlActive()) return;
        const list = loadAnnots().map((a) => ({ id: a.id, quote: a.quote, prefix: a.prefix, suffix: a.suffix }));
        const accent = getComputedStyle(root).getPropertyValue('--accent').trim() || '#B85F4E';
        try { curFrame.contentWindow.postMessage({ __spikeAnnots: list, accent }, '*'); } catch {}
      }

      // ── notes drawer ─────────────────────────────────────────────────────
      // A Google-Docs-style side panel that gathers EVERY note for the open doc
      // in one place — the reliable home for your marginalia, independent of
      // whether the inline highlight managed to paint (it can't inside a
      // sandboxed HTML frame). Click a note to jump to its passage; edit or
      // delete inline. It refreshes on every render + annotation change via
      // notesRefresh(), which renderAnnots calls first thing.
      let sideOpen = false;
      let sideEl: HTMLElement | null = null;

      // The pvhead toggle mirrors the note count: ghost when empty, accent-tinted
      // once notes exist, "pressed" while the drawer is open.
      function updateNotesBtn() {
        const n = file ? loadAnnots().length : 0;
        notesBtn.classList.toggle('on', sideOpen);
        notesBtn.classList.toggle('has', n > 0 && !sideOpen);
        notesBtn.innerHTML = icon('message', 13) + (n ? `<span class="pvnotes-n">${n}</span>` : '');
        notesBtn.title = n ? `${n} note${n > 1 ? 's' : ''} — open the notes drawer` : 'notes drawer (no notes yet)';
      }
      function ensureSide(): HTMLElement {
        if (sideEl) return sideEl;
        const el = document.createElement('div');
        el.className = 'cmside';
        bodyEl.appendChild(el);
        sideEl = el;
        return el;
      }
      function toggleSide(force?: boolean) {
        sideOpen = typeof force === 'boolean' ? force : !sideOpen;
        if (sideOpen) { ensureSide(); renderSide(); }
        else { sideEl?.remove(); sideEl = null; }
        updateNotesBtn();
      }
      // Scroll a note's passage into view and pulse it. In-DOM highlights
      // (markdown / text) pulse directly; a sandboxed HTML frame can't be
      // reached, so we ask its bridge to scroll + flash its own span.
      function jumpToAnnot(id: string) {
        const span = renderBox.querySelector(`span.spike-annot[data-annot="${id}"]`) as HTMLElement | null;
        if (span) {
          span.scrollIntoView({ block: 'center', behavior: 'smooth' });
          span.classList.remove('flash'); void span.offsetWidth; span.classList.add('flash');
          setTimeout(() => span.classList.remove('flash'), 1200);
          return;
        }
        if (curFrame && curFrame.contentWindow && htmlActive())
          try { curFrame.contentWindow.postMessage({ __spikeScrollAnnot: id }, '*'); } catch {}
      }
      // (re)build the drawer contents from the saved annotations. Skipped while a
      // note field is focused so a background re-render (an agent edit landing)
      // can't yank the text out from under you mid-thought.
      function renderSide() {
        if (!sideOpen) return;
        const el = ensureSide();
        if (el.querySelector('.cmside-ta:focus')) return;
        const annots = file ? loadAnnots().slice() : [];
        el.innerHTML = '';
        const hd = document.createElement('div'); hd.className = 'cmside-hd';
        const ttl = document.createElement('span'); ttl.className = 'cmside-ttl';
        ttl.textContent = annots.length ? `Notes · ${annots.length}` : 'Notes';
        const close = document.createElement('button'); close.className = 'cmside-x';
        close.innerHTML = icon('x', 14); close.title = 'close drawer';
        close.addEventListener('click', () => toggleSide(false));
        hd.append(ttl, close);
        el.appendChild(hd);
        if (!annots.length) {
          const empty = document.createElement('div'); empty.className = 'cmside-empty';
          empty.textContent = 'Select any passage and choose Note. Your notes for this doc gather here.';
          el.appendChild(empty);
          return;
        }
        const list = document.createElement('div'); list.className = 'cmside-list';
        for (const a of annots) {
          const card = document.createElement('div'); card.className = 'cmside-card';
          const del = document.createElement('button'); del.className = 'cmside-del';
          del.innerHTML = icon('x', 12); del.title = 'Delete note';
          del.addEventListener('click', () => {
            storeAnnots(loadAnnots().filter((x) => x.id !== a.id));
            renderAnnots(); syncNoteFile(file);   // renderAnnots → notesRefresh repaints the drawer
          });
          const quote = document.createElement('div'); quote.className = 'cmside-q';
          quote.textContent = a.quote.trim(); quote.title = 'Jump to this passage';
          quote.addEventListener('click', () => jumpToAnnot(a.id));
          const ta = document.createElement('textarea'); ta.className = 'cmside-ta'; ta.rows = 1;
          ta.value = a.note; ta.placeholder = 'Add a thought…';
          // no cap — a long note grows to show in full; the panel scrolls
          // between notes, never inside one.
          const reflow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
          ta.addEventListener('input', reflow);
          ta.addEventListener('blur', () => {
            const cur = loadAnnots(); const it = cur.find((x) => x.id === a.id);
            if (it && it.note !== ta.value) { it.note = ta.value; storeAnnots(cur); syncNoteFile(file); }
          });
          ta.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.preventDefault(); (ta as HTMLTextAreaElement).blur(); }
            else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); (ta as HTMLTextAreaElement).blur(); }
          });
          card.append(del, quote, ta);
          list.appendChild(card);
          setTimeout(reflow, 0);
        }
        el.appendChild(list);
      }
      // one entry point the render pipeline + annot mutations call: keep the
      // count badge current and, when open, the drawer list in sync.
      function notesRefresh() { updateNotesBtn(); if (sideOpen) renderSide(); }

      // persist a note from a captured selection (note text optional). A rendered
      // selection carries an anchor → it paints as a highlight; a source selection
      // has none → quote-anchored, so it surfaces as a highlight in rendered view.
      function addAnnot(sel: CmSel, note: string) {
        if (!file) return;
        const a = sel.anchor || { prefix: '', suffix: '' };
        const list = loadAnnots();
        list.push({ id: 'a' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
          quote: sel.text, prefix: a.prefix, suffix: a.suffix, note: note || '', at: Date.now() });
        storeAnnots(list);
        renderAnnots();
        syncNoteFile(file);
      }

      // ── notes → a real markdown note in the vault ───────────────────────
      // Your highlights+thoughts for a source roll up into a note — reading/<slug>
      // for an article, notes/<slug> for a file — (re)written on every change. THAT
      // file is how you view / search / link your notes: it lands in the tree like
      // any note, so the `reading/` and `notes/` folders ARE your notes browser. The
      // coloured highlight on the source is just the pointer back to it.
      const noteSlug = (s: string) =>
        (s || 'note').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'note';
      const noteDirOf = (f: PvDoc) => (f.web ? 'reading' : 'notes');
      function noteFilePath(f: PvDoc): string | null {
        if (!projectPath) return null;
        const base = f.web ? (f.name || f.path) : f.name.replace(/\.[^.]+$/, '');
        return `${projectPath}/${noteDirOf(f)}/${noteSlug(base)}.md`;
      }
      function buildNoteMd(f: PvDoc, annots: Annot[]): string {
        const out = ['---', `type: ${f.web ? 'reading-note' : 'note'}`, `source: ${f.web ? f.path : f.name}`];
        if (f.web && f.byline) out.push(`by: ${f.byline}`);
        out.push('---', '', `# ${f.name || 'Notes'}`, '');
        // Link back to the source: web articles get the external URL, files get a
        // [[wikilink]] that resolves through the tree's fileIndex (basename match),
        // so clicking it in the note opens the original page in the folder.
        if (f.web) out.push(`[Read the original ↗](${f.path})`, '');
        else if (f.name) out.push(`[[${f.name}]]`, '');
        out.push('');
        for (const a of annots) {
          out.push('> ' + a.quote.trim().replace(/\n+/g, '\n> '), '');
          if (a.note.trim()) out.push(a.note.trim(), '');
        }
        return out.join('\n');
      }
      // (re)write the vault note from the current source's saved annotations.
      function syncNoteFile(f: PvDoc | null): Promise<void> {
        if (!f) return Promise.resolve();
        const path = noteFilePath(f);
        const annots = loadAnnots();
        if (!path || !projectPath || !annots.length) return Promise.resolve();
        const md = buildNoteMd(f, annots);
        return ipc.createPath(projectPath, noteDirOf(f), 'folder').catch(() => undefined)
          .then(() => ipc.saveFile(path, md))
          .then(() => { if (projectPath) loadTree(projectPath); })
          .catch(() => {});
      }
      // open the vault note for this source (writing it current first).
      function openNoteFile(f: PvDoc) {
        const path = noteFilePath(f);
        if (!path) return;
        syncNoteFile(f).then(() => openFile(path, path.split('/').pop() || 'note.md', null, { reload: true }));
      }
      function annotClosePop() { annotPop?.remove(); annotPop = null; }
      function annotShowPop(a: Annot, clientX: number, clientY: number) {
        annotClosePop(); cmClose();
        const pop = document.createElement('div');
        pop.className = 'cmpop annotpop';
        const quote = document.createElement('div'); quote.className = 'cmquote'; quote.textContent = a.quote.trim();
        const ta = document.createElement('textarea'); ta.className = 'cmta'; ta.rows = 2; ta.value = a.note; ta.placeholder = 'Your thought…';
        const foot = document.createElement('div'); foot.className = 'cmfoot';
        const del = document.createElement('button'); del.className = 'cmhl'; del.textContent = 'Delete';
        const save = document.createElement('button'); save.className = 'cmsend'; save.textContent = 'Save';
        foot.append(del, save);
        pop.append(quote, ta, foot);
        root.appendChild(pop);
        annotPop = pop;
        cmPlace(pop, clientX, clientY);
        ta.focus();
        const persist = () => {
          const list = loadAnnots(); const it = list.find((x) => x.id === a.id);
          if (it) { it.note = ta.value; storeAnnots(list); }
          annotClosePop(); renderAnnots(); syncNoteFile(file);
        };
        save.addEventListener('click', persist);
        del.addEventListener('click', () => { storeAnnots(loadAnnots().filter((x) => x.id !== a.id)); annotClosePop(); renderAnnots(); syncNoteFile(file); });
        ta.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { e.preventDefault(); annotClosePop(); }
          else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); persist(); }
        });
        const dismiss = (e: Event) => {
          if (annotPop?.contains(e.target as Node)) return;
          document.removeEventListener('mousedown', dismiss, true);
          annotClosePop();
        };
        setTimeout(() => document.addEventListener('mousedown', dismiss, true), 0);
      }
      // click an annotation span → its note popover.
      renderBox.addEventListener('click', (e: MouseEvent) => {
        const span = (e.target as HTMLElement)?.closest?.('span.spike-annot') as HTMLElement | null;
        if (!span) return;
        const a = loadAnnots().find((x) => x.id === span.dataset.annot);
        if (a) { e.preventDefault(); annotShowPop(a, e.clientX, e.clientY); }
      });

      // ── HTML preview zoom + find-in-page ──────────────────────────────
      // The HTML iframe is sandboxed without same-origin, so we can't reach
      // into it: zoom scales the frame ELEMENT (widening its inner viewport as
      // it shrinks, which is what makes an over-wide doc fit), and find talks to
      // a tiny bridge script appended to the srcdoc over postMessage. In-page
      // renders (markdown / code / json / text) are real DOM in renderBox, so
      // find highlights them directly via the CSS Custom Highlight API.
      let htmlZoom = 1;
      let curFrame: HTMLIFrameElement | null = null;   // the live .htmlframe, or null
      let htmlHomeUrl = '';   // the preview's home URL (spikehtml://…); "back" reloads it
      let htmlEditing = false;   // in-place HTML text edit active (see the edit pill)
      let htmlEditSrc = '';      // source snapshot taken on enter; body is spliced into THIS on save
      let htmlBlockTag = 'p';    // block tag under the frame's caret (bridge reports it → heading label)

      function htmlActive(): boolean {
        return view !== 'source' && !!curFrame && renderBox.contains(curFrame);
      }
      // The pill hosts two different affordances. Zoom only means something for
      // an iframe we can scale (HTML, live URLs). Expand-to-focus means
      // something for ANY open doc — markdown, CSV, an image — so the pill
      // shows whenever a doc is open and goes `zoomless` when there's no frame,
      // leaving just the ⤢.
      function paintZoomPill() {
        const zoomable = htmlActive();
        zoomPill.classList.toggle('zoomless', !zoomable);
        zoomPill.classList.toggle('show', zoomable || !!file);
      }
      function applyHtmlZoom() {
        if (!curFrame) return;
        curFrame.style.transformOrigin = 'top left';
        curFrame.style.transform = `scale(${htmlZoom})`;
        curFrame.style.width = `${100 / htmlZoom}%`;
        curFrame.style.height = `${100 / htmlZoom}%`;
        (zoomPill.querySelector('.htmlzoom-pct') as HTMLElement).textContent = Math.round(htmlZoom * 100) + '%';
        paintZoomPill();
      }
      function setHtmlZoom(z: number) {
        htmlZoom = Math.min(3, Math.max(0.3, Math.round(z * 100) / 100));
        applyHtmlZoom();
      }
      function bumpHtmlZoom(dir: number) {   // +1 in, -1 out, 0 reset
        if (dir === 0) setHtmlZoom(1);
        else setHtmlZoom(dir > 0 ? htmlZoom * 1.1 : htmlZoom / 1.1);
      }
      const zoomPill = document.createElement('div');
      zoomPill.className = 'htmlzoom';
      zoomPill.innerHTML =
        '<button class="zi" data-z="out" title="zoom out (⌘−)">−</button>'
        + '<span class="htmlzoom-pct">100%</span>'
        + '<button class="zi" data-z="in" title="zoom in (⌘+)">+</button>'
        + '<button class="zi" data-z="expand" title="expand preview" aria-label="expand preview"></button>';
      const expandBtn = zoomPill.querySelector('[data-z="expand"]') as HTMLButtonElement;
      const paintExpandBtn = () => {
        const expanded = expandedPreviewId === id;
        expandBtn.innerHTML = icon(expanded ? 'minimize' : 'maximize', 14);
        expandBtn.title = expanded ? 'restore previous view' : 'expand preview';
        expandBtn.setAttribute('aria-label', expandBtn.title);
      };
      paintExpandBtn();
      zoomPill.addEventListener('mousedown', (e) => e.preventDefault());   // keep preview focus
      zoomPill.addEventListener('click', (e) => {
        const t = (e.target as HTMLElement).closest('.zi') as HTMLElement | null;
        if (!t) return;
        if (t.dataset.z === 'expand') {
          togglePreviewExpanded(id);
          paintExpandBtn();
        } else {
          bumpHtmlZoom(t.dataset.z === 'in' ? 1 : -1);
        }
      });
      bodyEl.appendChild(zoomPill);

      // ── HTML in-page back ─────────────────────────────────────────────
      // Clicking a link inside the previewed doc navigates the iframe; the bridge
      // reports that a navigation happened and we surface a single floating
      // "‹ back" affordance only while there is somewhere to return to. "Back"
      // re-renders the original document — a sandboxed srcdoc can't be stepped
      // through reliably (hashchange/popstate don't fire, plain links replace the
      // whole doc), so re-rendering the source is the one move that always works.
      // Stays out of the way (no persistent chrome) — the missing browser gesture.
      function htmlBack() {
        if (!curFrame || !htmlHomeUrl) return;
        navPill.classList.remove('show');   // instant feedback; the reloaded bridge re-confirms canBack:false
        curFrame.src = htmlHomeUrl;   // reload the home doc (its token is still registered)
      }
      const navPill = document.createElement('div');
      navPill.className = 'htmlnav';
      navPill.innerHTML = '<button class="ni" title="back (⌘[)">‹ back</button>';
      navPill.addEventListener('mousedown', (e) => e.preventDefault());   // keep preview focus
      navPill.addEventListener('click', htmlBack);
      bodyEl.appendChild(navPill);

      // ── HTML in-place text editor (sandboxed-iframe preview only) ────────
      // Tweak the words on a rendered HTML page without regenerating it or
      // opening the source. Editing happens INSIDE the frame (the parent can't
      // reach a same-origin-less sandbox), driven by SPIKE_BRIDGE over
      // postMessage. The way IN is the header pencil — the SAME .pvpencil control
      // markdown uses — so an editable HTML page reads exactly like an editable
      // doc instead of sprouting a floating pill over the prose. The formatting
      // bar + "Done" then take over the header (the same one-row treatment), and
      // the pencil hides while editing. On save the bridge returns the body's
      // inner HTML and we splice it into the original source between <body> and
      // </body>, so head/doctype/scripts stay byte-for-byte identical. Inline
      // formatting only — a full restructure is a conversation with the agent.
      // Show/hide the header pencil for HTML: visible when this doc is an
      // editable sandboxed frame and we're not already mid-edit (the .editing
      // header hides the pencil in favour of Done). Same class-mirroring reason
      // as markdown's setCanEdit — the state lives on the body, the button on
      // the head, and they're siblings.
      function refreshHtmlPencil() {
        head.classList.toggle('canedithtml', canEditHtml() && !htmlEditing);
      }
      // Editable only for a local HTML file shown as the sandboxed live frame
      // (not browser/reader/web/live-url), and only when the source has a real
      // <body>…</body> we can splice back into.
      function canEditHtml(): boolean {
        if (view === 'source' || !file || file.binary || file.tooBig) return false;
        if (!HTML_EXT.test(file.name) || file.web || file.liveurl || file.browser || file.reader) return false;
        if (!curFrame) return false;
        return /<body[\s\S]*?>[\s\S]*<\/body>/i.test((dirty ? editor.value : file.content) || '');
      }
      // Splice new body inner HTML into the original source, preserving
      // everything outside <body>…</body> exactly. Returns null if there's no
      // body to splice into (then we don't touch the file).
      function spliceBody(src: string, inner: string): string | null {
        const m = /^([\s\S]*?<body[^>]*>)([\s\S]*)(<\/body>[\s\S]*)$/i.exec(src);
        if (!m) return null;
        return m[1] + '\n' + inner.trim() + '\n' + m[3];
      }
      // Post a formatting command into the frame; SPIKE_BRIDGE restores the
      // frame's saved selection and runs it (execCommand / custom code span).
      function frameCmd(cmd: string, val?: string) {
        if (!htmlEditing || !curFrame || !curFrame.contentWindow) return;
        curFrame.contentWindow.postMessage({ __spikeEdit: 'cmd', cmd, val }, '*');
      }
      // The heading label in the header, driven by the block tag the bridge
      // reports on every selection change inside the frame.
      function syncHtmlHeadLabel(tag: string) {
        htmlBlockTag = tag || 'p';
        if (!headBtn) return;
        const lbl = headBtn.querySelector('.lbl');
        const row = HEADINGS.find((h) => h[1] === htmlBlockTag);
        if (lbl) lbl.textContent = row ? row[0]
          : (htmlBlockTag === 'blockquote' ? 'Quote' : htmlBlockTag === 'pre' ? 'Code' : htmlBlockTag === 'li' ? 'List' : 'Text');
      }
      // Heading dropdown for HTML — same .tbmenu chrome as markdown, but each row
      // posts a formatBlock command into the frame.
      function openHtmlHeadMenu(anchor: HTMLElement) {
        if (tbPop) { closeTbPop(); return; }
        anchor.classList.add('open');
        const menu = document.createElement('div'); menu.className = 'tbmenu';
        for (const [label, tag, cls] of HEADINGS) {
          const row = document.createElement('div'); row.className = 'row' + (tag === htmlBlockTag ? ' sel' : '');
          row.innerHTML = `<span class="tick">${icon('check', 13)}</span><span class="${cls}">${label}</span>`;
          row.addEventListener('mousedown', (e) => { e.preventDefault(); frameCmd('formatBlock', tag === 'p' ? 'p' : tag); closeTbPop(); });
          menu.appendChild(row);
        }
        openTbPop(anchor, menu);
      }
      // Link input for HTML — same .tblinkpop chrome; posts createLink into the
      // frame (which restores the selection captured before the input took focus).
      function openHtmlLinkPop(anchor: HTMLElement) {
        if (tbPop) { closeTbPop(); return; }
        const box = document.createElement('div'); box.className = 'tblinkpop';
        const input = document.createElement('input');
        input.type = 'text'; input.placeholder = 'https://…';
        const go = document.createElement('button'); go.className = 'go'; go.textContent = 'Add';
        const apply = () => { const url = input.value.trim(); if (url) frameCmd('createLink', url); closeTbPop(); };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
        go.addEventListener('mousedown', (e) => { e.preventDefault(); apply(); });
        box.appendChild(input); box.appendChild(go);
        openTbPop(anchor, box);
        setTimeout(() => input.focus(), 0);
      }
      // The HTML formatting bar — same themed classes as buildToolbar (so it's
      // visually identical), an inline-formatting subset, wired to the frame.
      function buildHtmlToolbar() {
        toolbar.innerHTML = '';
        const head2 = document.createElement('button');
        head2.type = 'button'; head2.className = 'tbhead'; head2.title = 'Paragraph style';
        head2.innerHTML = `<span class="lbl">Text</span>${icon('chevron-down', 13)}`;
        head2.addEventListener('mousedown', (e) => { e.preventDefault(); openHtmlHeadMenu(head2); });
        headBtn = head2;
        toolbar.appendChild(head2);
        const sep = () => { const s = document.createElement('span'); s.className = 'tbsep'; toolbar.appendChild(s); };
        const btn = (ic: string, title: string, fn: (b: HTMLElement) => void) => {
          const b = document.createElement('button');
          b.type = 'button'; b.className = 'tb'; b.title = title; b.innerHTML = icon(ic, 16);
          b.addEventListener('mousedown', (e) => { e.preventDefault(); fn(b); });
          toolbar.appendChild(b);
          return b;
        };
        sep();
        btn('bold', 'Bold (⌘B)', () => frameCmd('bold'));
        btn('italic', 'Italic (⌘I)', () => frameCmd('italic'));
        btn('strikethrough', 'Strikethrough', () => frameCmd('strikeThrough'));
        btn('code', 'Inline code', () => frameCmd('code'));
        sep();
        btn('list', 'Bulleted list', () => frameCmd('insertUnorderedList'));
        btn('list-numbers', 'Numbered list', () => frameCmd('insertOrderedList'));
        btn('quote', 'Quote', () => frameCmd('formatBlock', 'blockquote'));
        sep();
        btn('link', 'Link', (b) => openHtmlLinkPop(b));
        btn('minus', 'Divider', () => frameCmd('insertHorizontalRule'));
      }
      function enterHtmlEdit() {
        if (htmlEditing || !canEditHtml() || !curFrame || !curFrame.contentWindow) return;
        htmlEditing = true;
        htmlEditSrc = dirty ? editor.value : (file ? file.content : '');
        curFrame.contentWindow.postMessage({ __spikeEdit: 'on' }, '*');
        refreshHtmlPencil();   // hide the pencil; the header Done is the exit now
        buildHtmlToolbar();
        syncHtmlHeadLabel('p');
        head.classList.add('editing');      // one-row themed bar + Done, exactly like markdown
        renderedBtn.title = 'Done — preview';
      }
      // Full teardown of the header edit chrome. Called on Done/save, and when a
      // view/tab switch or repaint pulls the frame out from under the edit.
      function htmlEditTeardown() {
        if (!htmlEditing) return;
        htmlEditing = false;
        closeTbPop();
        toolbar.innerHTML = '';
        headBtn = null;
        head.classList.remove('editing');
        renderedBtn.title = 'rendered';
        refreshHtmlPencil();   // edit chrome gone → the pencil returns (if still editable)
      }
      // keep === false is a cancel (discard): reload the frame from disk so the
      // on-screen edits vanish. keep === true asks the frame to serialize; the
      // '__spikeEdit: html' message that comes back does the actual save.
      function exitHtmlEdit(keep: boolean) {
        if (!htmlEditing) return;
        if (keep && curFrame && curFrame.contentWindow) {
          curFrame.contentWindow.postMessage({ __spikeEdit: 'save' }, '*');
          // the html message finishes the save; tear the chrome down now either
          // way — a lost save beats a stuck header if the frame never answers.
        }
        htmlEditTeardown();
        if (!keep) htmlBack();   // reload home doc → discards unsaved edits
      }
      function commitHtmlEdit(bodyHtml: string) {
        // ⌘S pressed INSIDE the frame saves without the parent's Done path, so the
        // header may still be in edit mode here — tear it down (no-op if Done
        // already did). htmlEditSrc survives teardown, so the splice below is safe.
        htmlEditTeardown();
        if (!file) return;
        const doc = file;
        const next = spliceBody(htmlEditSrc || doc.content, bodyHtml);
        if (next == null || next === (htmlEditSrc || doc.content)) return;   // nothing changed / no body
        ipc.saveFile(doc.path, next).then(() => {
          doc.content = next; doc.draft = next; doc.dirty = false;
          if (file === doc) { setDirty(false); flashSaved(); }
          else if (tabs.length > 1) renderPvTabs();
        }).catch(() => {
          saveEl.classList.add('show', 'dirty'); saveLbl.textContent = 'save failed';
        });
      }

      // find bar
      const findBar = document.createElement('div');
      findBar.className = 'pvfind';
      findBar.innerHTML =
        '<div class="pvfind-row">'
        + '<button class="pvfind-btn pvfind-toggle" title="Replace (⌥⌘F)">›</button>'
        + '<input class="pvfind-in" type="text" placeholder="Find" spellcheck="false" autocomplete="off" />'
        + '<span class="pvfind-count"></span>'
        + '<button class="pvfind-btn pvfind-prev" title="previous (⇧⏎)">↑</button>'
        + '<button class="pvfind-btn pvfind-next" title="next (⏎)">↓</button>'
        + '<button class="pvfind-btn pvfind-close" title="close (esc)">✕</button>'
        + '</div>'
        + '<div class="pvfind-row pvfind-rep">'
        + '<input class="pvfind-rep-in" type="text" placeholder="Replace" spellcheck="false" autocomplete="off" />'
        + '<button class="pvfind-btn wide pvfind-rep-one" title="Replace this match (⏎)">Replace</button>'
        + '<button class="pvfind-btn wide pvfind-rep-all" title="Replace every match">All</button>'
        + '</div>';
      bodyEl.appendChild(findBar);
      const findInput = findBar.querySelector('.pvfind-in') as HTMLInputElement;
      const findCount = findBar.querySelector('.pvfind-count') as HTMLElement;
      const repInput = findBar.querySelector('.pvfind-rep-in') as HTMLInputElement;
      const repOneBtn = findBar.querySelector('.pvfind-rep-one') as HTMLButtonElement;
      const repAllBtn = findBar.querySelector('.pvfind-rep-all') as HTMLButtonElement;

      const HL = 'spike-find', HL_CUR = 'spike-find-current';
      const cssHL: any = (typeof CSS !== 'undefined' && (CSS as any).highlights) ? (CSS as any).highlights : null;
      let findMatches: Range[] = [];
      let findIdx = -1;

      // Source-text matches, as [start,end) offsets into editor.value. Kept
      // separate from findMatches (which are DOM Ranges over the rendered pane)
      // because only these can be replaced — a rendered-DOM offset has no
      // reliable mapping back to the source bytes.
      let srcMatches: Array<[number, number]> = [];
      let srcIdx = -1;

      function clearHighlights() {
        if (cssHL) { cssHL.delete(HL); cssHL.delete(HL_CUR); }
        findMatches = []; findIdx = -1;
        srcMatches = []; srcIdx = -1;
      }

      // Is the SOURCE editor the surface being searched? ⌘F used to always walk
      // the rendered pane, so in source view it reported a hit count from the
      // hidden render tree and highlighted nothing you could see.
      function srcActive(): boolean {
        return view !== 'rendered' && !!file && !file.media && !file.binary && !file.tooBig && !file.liveurl;
      }

      // Map an absolute offset span in the source text onto a DOM Range inside
      // the highlight overlay. The overlay mirrors editor.value exactly (hljs
      // only wraps it in spans), so walking its text nodes and counting
      // characters lands on the same bytes the textarea holds.
      function srcRange(start: number, end: number): Range | null {
        const walker = document.createTreeWalker(hlCode, NodeFilter.SHOW_TEXT);
        let at = 0, node: Node | null;
        let sN: Node | null = null, sO = 0, eN: Node | null = null, eO = 0;
        while ((node = walker.nextNode())) {
          const len = (node.nodeValue || '').length;
          if (!sN && at + len > start) { sN = node; sO = start - at; }
          if (sN && at + len >= end) { eN = node; eO = end - at; break; }
          at += len;
        }
        if (!sN || !eN) return null;
        try {
          const r = document.createRange();
          r.setStart(sN, sO); r.setEnd(eN, eO);
          return r;
        } catch { return null; }
      }

      // Scroll the textarea so the given offset sits mid-pane. setSelectionRange
      // alone doesn't scroll an unfocused textarea, and we deliberately keep
      // focus in the find input so you can keep typing — so compute the line and
      // drive scrollTop ourselves.
      function scrollSrcTo(pos: number) {
        const upto = editor.value.slice(0, pos);
        const line = upto.length - upto.replace(/\n/g, '').length;   // newlines before pos
        const cs = getComputedStyle(editor);
        const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 13) * 1.5;
        const padTop = parseFloat(cs.paddingTop) || 0;
        const want = padTop + line * lh - editor.clientHeight / 2;
        editor.scrollTop = Math.max(0, want);
        syncEditorScroll();
      }

      function focusSrcMatch() {
        if (srcIdx < 0 || !srcMatches[srcIdx]) return;
        findCount.textContent = `${srcIdx + 1}/${srcMatches.length}`;
        const [s, e] = srcMatches[srcIdx];
        if (cssHL) {
          const r = srcRange(s, e);
          if (r) cssHL.set(HL_CUR, new (window as any).Highlight(r));
        }
        // keep the textarea's own selection in step, so closing the bar drops the
        // caret on the match you were looking at
        try { editor.setSelectionRange(s, e); } catch {}
        scrollSrcTo(s);
      }

      function findInSource(query: string) {
        clearHighlights();
        if (!query) { findCount.textContent = ''; return; }
        const hay = editor.value.toLowerCase();
        const needle = query.toLowerCase();
        let from = 0, at: number;
        while ((at = hay.indexOf(needle, from)) !== -1) {
          srcMatches.push([at, at + query.length]);
          from = at + query.length;
        }
        if (cssHL && srcMatches.length) {
          const ranges = srcMatches.map(([s, e]) => srcRange(s, e)).filter(Boolean) as Range[];
          if (ranges.length) cssHL.set(HL, new (window as any).Highlight(...ranges));
        }
        if (srcMatches.length) { srcIdx = 0; focusSrcMatch(); }
        else findCount.textContent = '0';
      }

      // Replace the current match, then re-find so the offsets after it stay
      // right. The index is held steady (clamped) so repeated Replace walks
      // forward through the document instead of snapping back to the top.
      function replaceOne() {
        if (!srcActive() || srcIdx < 0 || !srcMatches[srcIdx]) return;
        const [s, e] = srcMatches[srcIdx];
        const rep = repInput.value;
        const keep = srcIdx;
        const next = editor.value.slice(0, s) + rep + editor.value.slice(e);
        pushUndo(file!, editor.value);
        applySnapshot(next, s + rep.length, s + rep.length);
        findInSource(findInput.value);
        if (srcMatches.length) { srcIdx = Math.min(keep, srcMatches.length - 1); focusSrcMatch(); }
      }

      function replaceAll() {
        if (!srcActive() || !srcMatches.length) return;
        const rep = repInput.value;
        // walk backwards so each splice leaves the earlier offsets untouched
        let out = editor.value;
        for (let i = srcMatches.length - 1; i >= 0; i--) {
          const [s, e] = srcMatches[i];
          out = out.slice(0, s) + rep + out.slice(e);
        }
        const n = srcMatches.length;
        pushUndo(file!, editor.value);
        applySnapshot(out, 0, 0);
        findInSource(findInput.value);
        findCount.textContent = `${n} replaced`;
      }
      function focusMatch() {
        if (findIdx < 0 || !findMatches[findIdx]) return;
        findCount.textContent = `${findIdx + 1}/${findMatches.length}`;
        if (cssHL) cssHL.set(HL_CUR, new (window as any).Highlight(findMatches[findIdx].cloneRange()));
        const host = findMatches[findIdx].startContainer.parentElement;
        if (host && host.scrollIntoView) host.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
      function findInDom(query: string) {
        clearHighlights();
        if (!query) { findCount.textContent = ''; return; }
        const needle = query.toLowerCase();
        const walker = document.createTreeWalker(renderBox, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const hay = (node.nodeValue || '').toLowerCase();
          let from = 0, at: number;
          while ((at = hay.indexOf(needle, from)) !== -1) {
            const r = document.createRange();
            r.setStart(node, at); r.setEnd(node, at + query.length);
            findMatches.push(r);
            from = at + query.length;
          }
        }
        if (cssHL && findMatches.length) cssHL.set(HL, new (window as any).Highlight(...findMatches.map((r) => r.cloneRange())));
        if (findMatches.length) { findIdx = 0; focusMatch(); }
        else findCount.textContent = '0';
      }
      // fresh = a new query: clear the frame's selection first so the search
      // restarts from the top. A step (next/prev) keeps the selection so
      // window.find advances from the current match instead of re-finding #1.
      function frameFind(query: string, back: boolean, fresh: boolean) {
        if (!curFrame || !curFrame.contentWindow) return;
        curFrame.contentWindow.postMessage({ __spikeFind: 'search', q: query, back, fresh }, '*');
        findCount.textContent = query ? '·' : '';   // count is opaque across the sandbox
      }
      function runFind() {
        const q = findInput.value;
        if (htmlActive()) frameFind(q, false, true);
        else if (srcActive()) findInSource(q);
        else findInDom(q);
        syncReplaceEnabled();
      }
      function findStep(dir: number) {
        if (htmlActive()) { frameFind(findInput.value, dir < 0, false); return; }
        if (srcActive()) {
          if (!srcMatches.length) return;
          srcIdx = (srcIdx + dir + srcMatches.length) % srcMatches.length;
          focusSrcMatch();
          return;
        }
        if (!findMatches.length) return;
        findIdx = (findIdx + dir + findMatches.length) % findMatches.length;
        focusMatch();
      }
      function syncReplaceEnabled() {
        const ok = srcActive();
        findBar.classList.toggle('noreplace', !ok);
        if (!ok) findBar.classList.remove('replacing');
        const none = !ok || srcIdx < 0;
        repOneBtn.disabled = none;
        repAllBtn.disabled = !ok || !srcMatches.length;
      }
      // `replace` opens the second row straight away (⌥⌘F). Replace edits the
      // SOURCE text, so it only means anything where the source is the surface —
      // in rendered view we switch to source rather than silently doing nothing.
      function openFind(replace?: boolean) {
        if (replace && !srcActive() && file && !file.media && !file.binary && !file.tooBig && !file.liveurl) {
          setView('source');
        }
        // a chip left over from an earlier selection would sit on top of the bar
        cmClose();
        findBar.classList.add('show');
        if (replace && srcActive()) findBar.classList.add('replacing');
        findInput.focus(); findInput.select();
        if (findInput.value) runFind();
        else syncReplaceEnabled();
      }
      function closeFind() {
        findBar.classList.remove('show');
        clearHighlights();
        findCount.textContent = '';
        if (curFrame && curFrame.contentWindow) curFrame.contentWindow.postMessage({ __spikeFind: 'clear' }, '*');
        if (curFrame) curFrame.focus(); else editor.focus();
      }
      findInput.addEventListener('input', runFind);
      findInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
        else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
      });
      findBar.querySelector('.pvfind-next')!.addEventListener('click', () => findStep(1));
      findBar.querySelector('.pvfind-prev')!.addEventListener('click', () => findStep(-1));
      findBar.querySelector('.pvfind-close')!.addEventListener('click', () => closeFind());
      findBar.querySelector('.pvfind-toggle')!.addEventListener('click', () => {
        const on = findBar.classList.toggle('replacing');
        if (on) repInput.focus(); else findInput.focus();
      });
      repOneBtn.addEventListener('click', () => replaceOne());
      repAllBtn.addEventListener('click', () => replaceAll());
      repInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? replaceAll() : replaceOne(); }
        else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
      });
      findBar.addEventListener('mousedown', (e) => { if (e.target !== findInput) e.preventDefault(); });

      // messages from the in-iframe bridge (find results, and ⌘F/⌘± captured
      // while the iframe itself has focus, which the parent window never sees).
      window.addEventListener('message', (e) => {
        const m: any = e.data;
        if (!m || typeof m !== 'object' || !curFrame || e.source !== curFrame.contentWindow) return;
        if (m.__spikeFind === 'open') openFind();
        else if (m.__spikeFind === 'result') findCount.textContent = m.ok ? '·' : '0';
        else if (m.__spikeFind === 'zoom') bumpHtmlZoom(m.dir | 0);
        else if (m.__spikeNav === 'state') navPill.classList.toggle('show', !!m.canBack && htmlActive());
        else if (m.__spikeNav === 'home') htmlBack();   // ⌘[ pressed while the frame held focus
        else if (m.__spikeNav === 'external' && m.url) ipc.openExternal(m.url).catch(() => {});
        else if (typeof m.__spikeTab === 'number') jumpToStripTab(m.__spikeTab);   // ⌘1..9 while the frame held focus
        // selection inside the sandboxed HTML doc → the same Note chip the parent
        // DOM gets. Map the frame-local caret to root coords (the frame is scaled
        // by htmlZoom from its top-left), then hand off to cmShowChip. Keep writes
        // a vault note; Send hands the passage to the agent — same as markdown.
        else if (m.__spikeSel === 'show' && typeof m.text === 'string' && m.text.trim()) {
          const fr = curFrame.getBoundingClientRect();
          const sel: CmSel = { text: m.text, loc: cmLocFor(m.text),
            anchor: { prefix: String(m.prefix || ''), suffix: String(m.suffix || '') } };
          cmShowChip(sel, fr.left + (Number(m.x) || 0) * htmlZoom, fr.top + (Number(m.y) || 0) * htmlZoom);
        }
        else if (m.__spikeSel === 'hide' && !htmlEditing) cmClose();
        // in-place HTML text editor: 'dirty' surfaces unsaved state; 'block' syncs
        // the heading label; 'html' is the serialized body coming back on save.
        else if (m.__spikeEdit === 'dirty') { saveEl.classList.add('show', 'dirty'); saveLbl.textContent = 'unsaved edits'; }
        else if (m.__spikeEdit === 'block' && typeof m.tag === 'string') syncHtmlHeadLabel(m.tag);
        else if (m.__spikeEdit === 'html' && typeof m.body === 'string') commitHtmlEdit(m.body);
        else if (m.__spikeEdit === 'enter') { if (!htmlEditing && canEditHtml()) enterHtmlEdit(); }   // ⌘E from inside the focused frame
        // click on a painted highlight inside the frame → open its note editor,
        // anchored where they clicked (frame-local → root, scaled by htmlZoom).
        else if (m.__spikeSel === 'annot' && m.id) {
          const a = loadAnnots().find((x) => x.id === m.id);
          if (a) {
            const fr = curFrame.getBoundingClientRect();
            annotShowPop(a, fr.left + (Number(m.x) || 0) * htmlZoom, fr.top + (Number(m.y) || 0) * htmlZoom);
          }
        }
      });

      const pv: Preview = {
        id, root,
        get tabs() { return tabs; },
        get file() { return file; },
        get view() { return view; },
        get dirty() { return dirty; },
        openDoc, openWeb, openLiveUrl, adoptDocs, reloadDoc: reloadTab, markOrphaned, dropPath, save: saveDoc, close: closeInstance, dispose,
        openFind, htmlZoomActive: htmlActive, htmlZoom: bumpHtmlZoom, htmlBack,
        canLiveSplit, toggleLiveSplit,
        canEdit: () => canEdit() || canEditHtml() || htmlEditing, toggleEdit: toggleAnyEdit,
      };
      previews.set(id, pv);
      focusedPreview = pv;   // a new pane is where the next open lands
      return pv;
    }

    // ── drag-to-resize, both dividers ──
    // A full-viewport shield is dropped during the drag. It sits above the
    // terminal and any preview iframe, so move/up events can't be swallowed by
    // them — that was the bug where the divider stayed stuck to the cursor
    // after release. The shield is removed on mouseup; reflow happens once then.
    function makeResizer(handle, onMove, guard, onUp) {
      handle.addEventListener('mousedown', (e) => {
        if (guard && !guard()) return;
        e.preventDefault();
        const shield = document.createElement('div');
        shield.className = 'dragshield';
        // match the shield cursor to the handle's drag axis so it doesn't flip
        // mid-drag (a 'col' splitter drags vertically → row-resize, and vice versa).
        if (handle.classList.contains('col')) shield.style.cursor = 'row-resize';
        else if (handle.classList.contains('row')) shield.style.cursor = 'col-resize';
        document.body.appendChild(shield);
        // panes are click-through during the drag so the shield (in <body>, below
        // the layer) owns the mouse and xterm can't start a stray selection.
        document.documentElement.classList.add('dragging');
        // panes track the slots live as they resize; scheduleLiveSync re-insets
        // the native web board each frame too (it's DOM-external, so syncTermLayer
        // alone leaves it frozen — overlapping its neighbor until the drag ends).
        const move = (ev) => { onMove(ev); syncTermLayer(); scheduleLiveSync(); };
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          shield.remove();
          document.documentElement.classList.remove('dragging');
          reflowTerminal();
          if (onUp) onUp();
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      });
    }

    // ─── tiling layout engine ─────────────────────────────────────────
    // #termcol (tabs + all terminal panes), popped session panes and the
    // preview instances are the live surfaces. renderLayout() rebuilds the
    // split/leaf scaffold inside #tileroot from the model tree, RE-PARENTING
    // those nodes (never recreating them) so xterm canvases + editor state
    // survive the move — the same trick the old dock-flip used, generalized.
    // The file tree is a sidebar (left), driven separately below; its
    // width/visibility ride on the model so they persist alongside the tree.
    const tileRoot = document.getElementById('tileroot');
    const termColNode = document.getElementById('termcol');
    const treeNode = document.getElementById('tree');
    const treeDivideNode = document.getElementById('treedivide');
    const pvDockBtn = document.getElementById('pvDock');   // optional header control (may be absent)
    const LAYOUT_KEY = 'spike-layout';

    // dock side maps to the root split direction: right → row, bottom → col.
    let pvDock = 'right';
    try { const d = localStorage.getItem('spike-pv-dock'); if (d === 'bottom' || d === 'right') pvDock = d; } catch {}

    // Spawn params for popped sessions, keyed by name — a dead pty can't be
    // revived, so to bring a split pane back on reopen we re-create the session
    // from these. Snapshotted alongside every saveLayout() so it stays in sync.
    const SESSIONS_KEY = 'spike-sessions';
    // Full persisted layout (popped terminals intact, previews stripped), kept
    // aside so an auto-reopen of the same project can rebuild the split. The LIVE
    // layout boots clean (no panes for not-yet-spawned sessions); restore swaps
    // this in once the sessions exist. Null when there's nothing to restore.
    let pendingRestore: LayoutState | null = null;
    // Params captured at load, before any saveLayout() can overwrite the key with
    // the (still-empty) live session set during the async reopen window.
    let pendingParams: Record<string, { cwd?: string; cmd?: string; group?: string; agentSessionId?: string }> = {};

    let layout: LayoutState = loadLayout();

    // Composable panels: the terminal column can be HIDDEN without stopping its
    // sessions — they live in #termlayer (outside the layout), so collapsing the
    // column's tile just hides the panes; the ptys keep running. Persisted like
    // the tree/preview visibility.
    let termHidden = false;
    try { termHidden = localStorage.getItem('spike-term-hidden') === '1'; } catch {}
    // A faint hint shown only when the tile area is fully empty (terminal hidden
    // AND no preview open) so you can always summon a panel back.
    const emptyHintEl = document.createElement('div');
    emptyHintEl.id = 'emptyhint';
    emptyHintEl.innerHTML =
      `<img class="emptymark" src="${spikeMark}" alt="" />` +
      '<div class="emptyrow"><span><b>⌘\\</b> terminal</span><span><b>⌘J</b> preview</span><span><b>⌘B</b> tree</span></div>';
    emptyHintEl.style.display = 'none';
    document.getElementById('wrap')?.appendChild(emptyHintEl);

    function loadLayout(): LayoutState {
      let raw = null;
      try { raw = localStorage.getItem(LAYOUT_KEY); } catch {}
      const restored = deserialize(raw);
      if (restored && restored.root) {
        // If the saved layout had popped terminals, stash a full copy (own deep
        // copy via a second deserialize of the same raw, previews removed) for
        // restorePoppedSessions() to rebuild from on same-project reopen.
        if (hasSurface(restored.root, (s) => s.kind === 'terminal' && s.name != null)) {
          const full = deserialize(raw);
          if (full && full.root) { removeSurface(full, (s) => s.kind === 'preview'); pendingRestore = full; }
          try { pendingParams = JSON.parse(localStorage.getItem(SESSIONS_KEY) || '{}') || {}; } catch {}
        }
        // the preview is session-transient (no file is open on a fresh load), so
        // strip any persisted preview leaf — boot always starts preview-closed.
        // Named terminals are stripped from the LIVE layout too (their sessions
        // don't exist yet); restore re-adds them once respawned. Sidebar prefs
        // (width/side/visible) persist.
        removeSurface(restored, (s) => s.kind === 'preview' || (s.kind === 'terminal' && s.name != null));
        if (!restored.root) restored.root = terminalLeaf();
        return restored;
      }
      // first run: synthesize from the legacy sidebar key so nothing changes.
      let hidden = false;
      try { hidden = localStorage.getItem('spike-tree-hidden') === '1'; } catch {}
      return defaultState({ treeVisible: !hidden });
    }

    // Rebuild last session's split panes: spawn a Session for each popped name
    // (by exact name, so the layout's SurfaceRefs resolve) from saved params,
    // then adopt the full split tree. No-op when there's nothing to restore.
    function restorePoppedSessions() {
      if (!pendingRestore || !pendingRestore.root) { pendingRestore = null; return; }
      const params = pendingParams;
      // adopt the structure first so isPoppedSession() reads true as each session
      // is constructed (it keeps them out of the tab strip).
      layout = pendingRestore;
      pendingRestore = null;
      for (const name of poppedNames()) {
        if (sessions.find((s) => s.name === name)) continue;
        const p = params[name] || {};
        // Hand back the conversation id this lane had before the restart: the
        // agent resumes where it left off, and its context ring paints from the
        // first frame instead of after the next turn. Absent (a lane from before
        // ids were minted, or a non-Claude engine) → an ordinary fresh spawn.
        new Session(name, p.cwd || projectPath, p.cmd || defaultSpawnEngine(), p.group || undefined,
                    undefined, p.agentSessionId);
      }
      renderLayout();
      saveLayout();
    }

    function saveLayout() {
      try { localStorage.setItem(LAYOUT_KEY, serialize(layout)); } catch {}
      // Snapshot the popped sessions' spawn params so they can be respawned.
      const m: Record<string, { cwd: string; cmd: string; group?: string; agentSessionId?: string }> = {};
      for (const s of sessions)
        // agentSessionId rides along so the respawn can --resume the same
        // conversation rather than starting an empty one under the old name.
        if (isPoppedSession(s))
          m[s.name] = { cwd: s.cwd, cmd: s.cmd, group: s.spawnGroup || undefined, agentSessionId: s.agentSessionId };
      try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(m)); } catch {}
    }

    // Render one preview as the whole app without mutating the real layout.
    // Reducing merely switches the renderer back to that untouched model.
    function togglePreviewExpanded(id: string) {
      expandedPreviewId = expandedPreviewId === id ? null : id;
      document.documentElement.classList.toggle('preview-focus', expandedPreviewId != null);
      // Arm/disarm the native Esc-exits-full-screen monitor (it catches Escape even
      // when the browser child has keyboard focus, which the DOM never sees).
      ipc.liveWebviewSetExpanded(expandedPreviewId != null).catch(() => {});
      renderLayout();
    }
    // Escape while full-screen — caught natively (works over the focused browser
    // webview too) — collapses back to the user's prior layout.
    ipc.onBrowserEsc(() => { if (expandedPreviewId) togglePreviewExpanded(expandedPreviewId); }).catch(() => {});

    // build the DOM scaffold for the current tree and mount it.
    function renderLayout() {
      if (!layout.root) layout.root = terminalLeaf();
      // Terminal panes live permanently in #termlayer (outside the zoom) and only
      // ever follow a `.termslot` placeholder, so the layout rebuild below can
      // freely tear down #tileroot without touching them. Detach the non-pane
      // live nodes (the shared column + previews) so clearing #tileroot can't
      // destroy them; the scaffold re-places the ones that still have a leaf.
      if (termColNode.parentElement) termColNode.parentElement.removeChild(termColNode);
      for (const pv of previews.values())
        if (pv.root.parentElement) pv.root.parentElement.removeChild(pv.root);
      tileRoot.innerHTML = '';
      // When the terminal is hidden, render the layout WITHOUT the shared column
      // so the remaining panels fill the space (CSS-hiding the leaf doesn't
      // reliably reclaim it in a split). The column's surface stays in the model
      // — restored on toggle — and its sessions stay alive in #termlayer.
      let renderRoot: LayoutNode | null = expandedPreviewId && previews.has(expandedPreviewId)
        ? previewLeaf(expandedPreviewId)
        : layout.root;
      if (expandedPreviewId && !previews.has(expandedPreviewId)) {
        expandedPreviewId = null;
        document.documentElement.classList.remove('preview-focus');
        renderRoot = layout.root;
      }
      if (termHidden && !expandedPreviewId) {
        const copy = deserialize(serialize(layout));
        if (copy && copy.root) {
          removeSurface(copy, (s) => s.kind === 'terminal' && !s.name);
          renderRoot = copy.root;   // null if the column was the only surface → empty canvas
        }
      }
      if (renderRoot) {
        const rootEl = renderTileNode(renderRoot);
        rootEl.style.flex = '1 1 auto';
        tileRoot.appendChild(rootEl);
      }
      syncColActive();
      reflowAllVisible();  // positions panes over the freshly-built slots, then fits each
      updateEmptyHint();
      syncFooterOrder();
    }

    // Collapse one split at the divider between children [i] and [i+1]: send the
    // non-terminal-column side home (popped terminals rejoin the strip, previews
    // close) and let pruneEmpty fold the split away. The shared terminal column
    // always survives, so the terminal never vanishes. The in-context "bring
    // these back together" gesture - double-click the divider (makeSplitter).
    function collapseSplitAt(node: any, i: number) {
      const a = node.children[i], b = node.children[i + 1];
      if (!a || !b) return;
      const hasCol = (n: any) => hasSurface(n, (s) => s.kind === 'terminal' && !s.name);
      // keep whichever side holds the shared column; default to dissolving b.
      const dissolve = hasCol(a) && !hasCol(b) ? b : (hasCol(b) && !hasCol(a) ? a : b);
      for (const lf of leaves(dissolve)) {
        for (const s of lf.surfaces.slice()) {
          if (s.kind === 'preview') {
            const pv = previews.get(s.id);
            removeSurface(layout, (x) => x.kind === 'preview' && x.id === s.id);
            if (pv) pv.dispose();
          } else if (s.kind === 'terminal' && s.name) {
            removeSurface(layout, (x) => x.kind === 'terminal' && x.name === s.name);
          }
          // an unnamed terminal (the shared column) is on the keep side - left be
        }
      }
      renderLayout();
      saveLayout();
      renderTabs();   // any returned sessions reappear in the strip
      logAction('layout_collapse_split', {});
    }

    function renderTileNode(node: LayoutNode): HTMLElement {
      if (node.type === 'leaf') return renderTileLeaf(node);
      const el = document.createElement('div');
      el.className = 'tile-split ' + node.dir;
      el.dataset.nodeId = node.id;
      node.children.forEach((child, i) => {
        const cell = renderTileNode(child);
        const w = node.sizes[i] != null ? node.sizes[i] : 1 / node.children.length;
        cell.style.flex = w + ' 1 0';
        el.appendChild(cell);
        if (i < node.children.length - 1) el.appendChild(makeSplitter(node, i, el));
      });
      return el;
    }

    // resolve a SurfaceRef to its live DOM node. Named terminals resolve to a
    // Session's pane, previews to their instance's root; an id/name with no
    // live owner (closed mid-layout) is null and the surface simply doesn't
    // render — close()/dispose()/loadLayout prune those.
    function surfaceNode(surf: SurfaceRef): HTMLElement | null {
      if (surf.kind === 'preview') {
        const pv = previews.get(surf.id);
        return pv ? pv.root : null;
      }
      if (surf.name) {
        const s = sessions.find((x) => x.name === surf.name);
        return s ? s.pane : null;
      }
      return termColNode;
    }

    function surfaceLabel(surf: SurfaceRef): string {
      if (surf.kind === 'preview') {
        // name the pane after its active doc so stacked previews stay tellable
        // apart (refreshed on every layout render; good enough between renders).
        const pv = previews.get(surf.id);
        return pv && pv.file ? pv.file.name : 'preview';
      }
      return surf.name || 'terminals';
    }

    function renderTileLeaf(node: LeafNode): HTMLElement {
      const el = document.createElement('div');
      el.className = 'tile-leaf';
      el.dataset.leafId = node.id;
      node.activeIndex = Math.max(0, Math.min(node.activeIndex, node.surfaces.length - 1));
      // a stack gets a slim tab bar; a popped-out single terminal gets one too
      // (it's the pane's drag handle + name). The shared terminal column and the
      // preview already carry their own headers, so solo they stay bare.
      const needsBar = node.surfaces.length > 1 ||
        node.surfaces.some((s) => s.kind === 'terminal' && !!s.name);
      if (needsBar) el.appendChild(buildLeafTabs(node));
      node.surfaces.forEach((surf, i) => {
        const content = surfaceNode(surf);
        if (!content) return;
        const on = i === node.activeIndex;
        if (surf.kind === 'terminal' && surf.name) {
          // The pane lives in #termlayer (outside the zoom); render only a
          // placeholder box that syncTermLayer() overlays the live pane onto.
          const slot = document.createElement('div');
          slot.className = 'tile-leaf-body termslot';
          slot.dataset.term = surf.name;
          slot.style.display = on ? '' : 'none';
          el.appendChild(slot);
        } else {
          content.style.display = on ? '' : 'none';
          el.appendChild(content);
        }
      });
      return el;
    }

    // the per-leaf tab bar: click switches the stack, dragging a tab re-docks
    // that surface anywhere else (same engine as dragging a pane header).
    function buildLeafTabs(node: LeafNode): HTMLElement {
      const bar = document.createElement('div');
      bar.className = 'tile-tabs';
      node.surfaces.forEach((surf, i) => {
        const t = document.createElement('span');
        t.className = 'ttab pill' + (i === node.activeIndex ? ' on' : '');
        const nm = document.createElement('span');
        nm.className = 'nm';
        nm.textContent = surfaceLabel(surf);
        t.appendChild(nm);
        // Carry the session's group color onto the popped pill. In the strip the
        // color lives on the group container; a lone popped pill has none, so it
        // looked ungrouped after a pop. Tint the pill directly — alpha encodes the
        // active state so it doesn't fight the .on background.
        if (surf.kind === 'terminal' && surf.name) {
          const gs = sessions.find((ss) => ss.name === surf.name);
          const g = gs && gs.groupId != null ? groups.find((gr) => gr.id === gs.groupId) : null;
          if (g) {
            t.classList.add('grouped');
            if (i === node.activeIndex) t.classList.add('gon');
            t.style.setProperty('--gc', g.color);
          }
        }
        // the pill IS the popped session's tab, so its × means what every
        // tab's × means: close (the session dies, same as the strip ×; a
        // preview closes through its dirty-doc confirm). Going back to the
        // strip is the right-click's job — or drag the pill onto the
        // column's center. The shared column gets no × — it IS home.
        if (!(surf.kind === 'terminal' && !surf.name)) {
          const x = document.createElement('span');
          x.className = 'ctl x';
          x.title = surf.kind === 'preview' ? 'close preview' : 'close session';
          x.innerHTML = icon('x', 12);
          x.addEventListener('mousedown', (e) => e.stopPropagation());   // an × press must never start a drag
          x.addEventListener('click', (e) => {
            e.stopPropagation();
            if (surf.kind === 'preview') {
              const pv = previews.get(surf.id);
              if (pv) pv.close();
            } else {
              const s = sessions.find((ss) => ss.name === surf.name);
              if (s) s.close();
            }
          });
          t.appendChild(x);
        }
        if (surf.kind === 'terminal' && surf.name) {
          t.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const s = sessions.find((ss) => ss.name === surf.name);
            if (!s) return;
            openMenu(e.clientX, e.clientY, [
              { label: 'Move back to tab strip', fn: () => unpopSession(s) },
              { label: 'Hand off to new agent…', fn: () => openHandoffSheet(s) },
              { label: 'Close session', fn: () => s.close(), danger: true },
            ]);
          });
        }
        t.addEventListener('mousedown', (e) => beginDockDrag(e, { leafId: node.id, index: i, surface: surf }, surfaceLabel(surf)));
        t.addEventListener('click', () => {
          if (node.activeIndex === i) return;
          node.activeIndex = i;
          renderLayout();
          saveLayout();
        });
        bar.appendChild(t);
      });
      return bar;
    }

    // a splitter between children[i] and children[i+1] of a split. Dragging it
    // shifts the fractional weight between just those two cells (others hold).
    function makeSplitter(node: SplitNode, i: number, splitEl: HTMLElement): HTMLElement {
      const sp = document.createElement('div');
      sp.className = 'tile-splitter ' + node.dir;
      sp.title = 'drag to resize · double-click to merge';
      // double-click the divider to bring the two panes back together (the
      // in-context twin of ⌘⇧M / the palette's "Merge panes").
      sp.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); collapseSplitAt(node, i); });
      const horiz = node.dir === 'row';
      makeResizer(sp, (e) => {
        const cells = Array.prototype.filter.call(
          splitEl.children, (c: HTMLElement) => !c.classList.contains('tile-splitter')) as HTMLElement[];
        const a = cells[i], b = cells[i + 1];
        if (!a || !b) return;
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        const start = horiz ? ra.left : ra.top;
        const end = horiz ? rb.right : rb.bottom;
        const pos = horiz ? e.clientX : e.clientY;
        const total = end - start;
        if (total <= 0) return;
        const MIN = 90;   // px floor per cell so a pane can't collapse to nothing
        const aPx = Math.max(MIN, Math.min(pos - start, total - MIN));
        const bPx = total - aPx;
        const wSum = node.sizes[i] + node.sizes[i + 1];
        node.sizes[i] = wSum * (aPx / total);
        node.sizes[i + 1] = wSum * (bPx / total);
        a.style.flex = node.sizes[i] + ' 1 0';
        b.style.flex = node.sizes[i + 1] + ' 1 0';
      }, undefined, saveLayout);
      return sp;
    }

    // ─── drag-to-dock ──────────────────────────────────────────────────
    // Grab a pane by its header (the terminal tab strip, the preview header, or
    // a leaf tab), drop on another pane's edge to split that side, or on its
    // center to stack (tabify). src is either an existing surface in the tree
    // ({leafId, index, surface}) or a session popping out of the terminal
    // column ({surface} only — nothing to remove). A 5px threshold separates
    // drags from plain clicks so existing click handlers keep working.
    type DockSrc = { leafId?: string; index?: number; surface: SurfaceRef };
    let dockGhost: HTMLElement | null = null;
    let dockHl: HTMLElement | null = null;
    let dockTarget: { leafId: string; zone: DropZone } | null = null;

    function beginDockDrag(e: MouseEvent, src: DockSrc, label: string) {
      if (e.button !== 0) return;
      e.preventDefault();   // no text selection in the pre-threshold pixels
      const startX = e.clientX, startY = e.clientY;
      let live = false;
      let shield: HTMLElement | null = null;
      const move = (ev: MouseEvent) => {
        if (!live) {
          if (Math.abs(ev.clientX - startX) < 5 && Math.abs(ev.clientY - startY) < 5) return;
          live = true;
          // same trick as makeResizer: a viewport shield so xterm/iframes can't
          // swallow the drag. elementsFromPoint sees through it (we skip it).
          shield = document.createElement('div');
          shield.className = 'dragshield';
          shield.style.cursor = 'grabbing';
          document.body.appendChild(shield);
          dockGhost = document.createElement('div');
          dockGhost.className = 'dockghost';
          dockGhost.textContent = label;
          document.body.appendChild(dockGhost);
        }
        dockGhost!.style.left = ev.clientX + 12 + 'px';
        dockGhost!.style.top = ev.clientY + 12 + 'px';
        updateDockTarget(ev.clientX, ev.clientY, src);
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        if (!live) return;                  // never moved: it was a click
        if (shield) shield.remove();
        if (dockGhost) { dockGhost.remove(); dockGhost = null; }
        const t = dockTarget;
        clearDockHl();
        if (t) finishDock(src, t.leafId, t.zone);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    }

    function updateDockTarget(x: number, y: number, src: DockSrc | null) {
      const els = document.elementsFromPoint(x, y);
      const leafEl = els.find((el) => el.classList && el.classList.contains('tile-leaf')) as HTMLElement | undefined;
      if (!leafEl) { clearDockHl(); return; }
      const leafId = leafEl.dataset.leafId!;
      // dropping a single-surface leaf back onto itself is a no-op — show nothing.
      const srcLeaf = src && src.leafId ? findLeafById(layout.root, src.leafId) : null;
      if (srcLeaf && srcLeaf.id === leafId && srcLeaf.surfaces.length === 1) { clearDockHl(); return; }
      const r = leafEl.getBoundingClientRect();
      if (!r.width || !r.height) { clearDockHl(); return; }
      const xr = (x - r.left) / r.width, yr = (y - r.top) / r.height;
      // nearest edge wins inside its 28% band; the middle stacks (tabify).
      const edges: Array<[DropZone, number]> = [['left', xr], ['right', 1 - xr], ['top', yr], ['bottom', 1 - yr]];
      edges.sort((a, b) => a[1] - b[1]);
      const zone: DropZone = edges[0][1] <= 0.28 ? edges[0][0] : 'center';
      dockTarget = { leafId, zone };
      if (!dockHl) { dockHl = document.createElement('div'); dockHl.className = 'dockhl'; }
      if (dockHl.parentElement !== leafEl) leafEl.appendChild(dockHl);
      const pos = { left: '0', top: '0', right: '0', bottom: '0' };
      if (zone === 'left') pos.right = '50%';
      if (zone === 'right') pos.left = '50%';
      if (zone === 'top') pos.bottom = '50%';
      if (zone === 'bottom') pos.top = '50%';
      Object.assign(dockHl.style, pos);
    }

    function clearDockHl() {
      dockTarget = null;
      if (dockHl) { dockHl.remove(); dockHl = null; }
      clearPaneDropFlags();
    }

    // The terminal pane paints its own `.dropping` ring for image drops. Once
    // the dock engine claims a drag (stopPropagation), the pane's dragleave /
    // drop never fire, so that ring would stay orphaned — strip it whenever we
    // claim or the drag ends.
    function clearPaneDropFlags() {
      document.querySelectorAll('.pane.dropping').forEach((p) => p.classList.remove('dropping'));
    }

    function finishDock(src: DockSrc, targetLeafId: string, zone: DropZone) {
      let surf = src.surface;
      if (src.leafId != null) {
        const taken = takeSurface(layout, src.leafId, src.index!);
        if (!taken) { renderLayout(); return; }   // stale address; just repaint
        surf = taken;
      }
      const target = findLeafById(layout.root, targetLeafId);
      if (!target) {
        // target dissolved with the take (last two leaves collapsing) — keep
        // the surface alive beside whatever is left.
        layout.root = layout.root ? split('row', [layout.root, leaf([surf])], [0.5, 0.5]) : leaf([surf]);
      } else if (zone === 'center') {
        // center-dropping a popped session onto the leaf that holds the shared
        // terminal column returns it to the tab strip instead of stacking a
        // second terminal header inside the same leaf.
        const returnsToStrip = surf.kind === 'terminal' && surf.name &&
          target.surfaces.some((s) => s.kind === 'terminal' && !s.name);
        // two preview instances never share a leaf — stacking them doubled the
        // header (leaf pill bar + the pane's own). A preview center-dropped on
        // a leaf already holding one MERGES its docs into the resident
        // instance (preferring the visible surface) and the dragged instance
        // dissolves. Mixed terminal + preview stacks still stack normally.
        const residentSurf = surf.kind === 'preview'
          ? ([target.surfaces[target.activeIndex], ...target.surfaces].find(
              (s) => s && s.kind === 'preview' && s.id !== surf.id) || null)
          : null;
        const srcPv = surf.kind === 'preview' ? previews.get(surf.id) : null;
        const dstPv = residentSurf && residentSurf.kind === 'preview' ? previews.get(residentSurf.id) : null;
        if (srcPv && dstPv && residentSurf) {
          dstPv.adoptDocs(srcPv.tabs.slice(), srcPv.file);
          srcPv.dispose();   // its surface is already out of the tree (takeSurface above)
          focusedPreview = dstPv;
          target.activeIndex = target.surfaces.indexOf(residentSurf);   // surface the merged pane
        } else if (!returnsToStrip) {
          target.surfaces.push(surf);
          target.activeIndex = target.surfaces.length - 1;
        }
      } else {
        insertBeside(layout, targetLeafId, leaf([surf]), zone);
      }
      renderLayout();
      saveLayout();
      renderTabs();      // popped sessions leave/rejoin the strip
      logAction('layout_dock', { surface: surfaceLabel(surf), zone });
    }

    // which sessions live in their own leaf (popped out of the tab strip)?
    function poppedNames(): Set<string> {
      const out = new Set<string>();
      for (const lf of leaves(layout.root))
        for (const s of lf.surfaces) if (s.kind === 'terminal' && s.name) out.add(s.name);
      return out;
    }
    function isPoppedSession(s: any) {
      return hasSurface(layout.root, (x) => x.kind === 'terminal' && x.name === s.name);
    }

    // ── pop / un-pop without dragging ──────────────────────────────────
    // The drag gesture still works, but these are the discoverable paths:
    // the tab menu's "Open in split pane" and the × on a popped pane's pill.
    // Un-popping never kills the session — renderLayout rides the pane home
    // to the terminal column and the strip tab un-dims.
    function popSession(s: any) {
      if (isPoppedSession(s)) { activate(s); return; }
      if (!layout.root) layout.root = terminalLeaf();
      insertBeside(layout, layout.root.id, leaf([{ kind: 'terminal', name: s.name }]), 'right');
      renderLayout();
      saveLayout();
      activate(s);   // re-renders the strip (tab dims to its popped state)
      logAction('layout_pop', { name: s.name, via: 'menu' });
    }
    function unpopSession(s: any) {
      removeSurface(layout, (x) => x.kind === 'terminal' && x.name === s.name);
      renderLayout();
      saveLayout();
      activate(s);   // no longer popped → comes forward in the column
      logAction('layout_unpop', { name: s.name });
    }
    // every popped terminal home at once — the empty column's escape hatch.
    // Previews stay put (resetLayout is the bigger hammer for those).
    function unpopAllSessions() {
      removeSurface(layout, (x) => x.kind === 'terminal' && !!x.name);
      renderLayout();
      saveLayout();
      renderTabs();
      logAction('layout_unpop_all', { count: sessions.length });
    }

    // keep the column's visible pane honest: it must be a live session that is
    // NOT popped out. Prefers the focused session, else first eligible.
    function syncColActive() {
      const popped = poppedNames();
      if (!colActive || !sessions.includes(colActive) || popped.has(colActive.name)) {
        colActive =
          (active && sessions.includes(active) && !popped.has(active.name)) ? active :
          sessions.find((s) => !popped.has(s.name)) || null;
      }
      // Point the column's slot at colActive (or hide it); the pane follows in
      // syncTermLayer. Panes with no slot anywhere get hidden there too.
      colSlot.dataset.term = colActive ? colActive.name : '';
      colSlot.style.display = colActive ? '' : 'none';
      // sessions exist but none lives here → show the empty state, not bare beige.
      colEmptyEl.classList.toggle('show', sessions.length > 0 && !colActive);
    }

    // drag sources: the empty area of the terminal tab strip moves the whole
    // column. (Each preview header wires its own drag in makePreview — the
    // handler must move THAT instance's surface, not "the" preview.)
    tabsEl.addEventListener('mousedown', (e) => {
      if (e.target !== tabsEl) return;
      const lf = findLeaf(layout.root, (s) => s.kind === 'terminal' && !s.name);
      if (!lf) return;
      const idx = lf.surfaces.findIndex((s) => s.kind === 'terminal' && !s.name);
      beginDockDrag(e, { leafId: lf.id, index: idx, surface: lf.surfaces[idx] }, 'terminals');
    });

    // ── drag a tree item into the layout (mouse engine) ──
    // Same gestures the HTML5 pair used to offer, immune to Tauri's native
    // drag interception: drop on a folder row → move it there; on a terminal
    // pane's center → type the path into the prompt; on a preview's center →
    // open in THAT instance; on a pane edge (files only) → a NEW preview
    // splits open there with the file (this is how two files get side by side).
    // the preview instance a leaf is showing (its active surface), or null.
    function previewAtLeaf(leafId: string): Preview | null {
      const lf = findLeafById(layout.root, leafId);
      const surf = lf && lf.surfaces[lf.activeIndex];
      return surf && surf.kind === 'preview' ? (previews.get(surf.id) || null) : null;
    }
    // the session whose prompt a center-drop should land in: the leaf's visible
    // terminal — a popped session by name, or whatever the shared column shows.
    function sessionAtLeaf(leafId: string) {
      const lf = findLeafById(layout.root, leafId);
      const surf = lf && lf.surfaces[lf.activeIndex];
      if (!surf || surf.kind !== 'terminal') return null;
      return surf.name ? (sessions.find((x) => x.name === surf.name) || null) : colActive;
    }
    // the folder row (or root label) under the cursor, if it can take `nodes` —
    // a folder can be neither its own destination nor its own descendant's.
    function dropdirAt(x: number, y: number, nodes: any[]): HTMLElement | null {
      const el = document.elementsFromPoint(x, y)
        .find((n: any) => n.classList && n.classList.contains('dropdir')) as HTMLElement | undefined;
      const dest = el && el.dataset.dropdir;
      if (!dest) return null;
      return nodes.every((n) => dest !== n.path && !(dest + '/').startsWith(n.path + '/')) ? el! : null;
    }
    // Files dropped onto a pane. A multi-file drop pins as it opens: a preview
    // recycles one ephemeral slot, so an unpinned run of opens would leave only
    // the last file standing — five dragged files have to land as five tabs.
    function openDropped(files: any[]) {
      for (const n of files) openFile(n.path, n.name, null, files.length > 1 ? { pin: true } : undefined);
    }
    // `nodes` is the dragged selection — one row, or every row of a multi-select.
    function beginTreeDrag(e: MouseEvent, nodes: any[]) {
      if (e.button !== 0) return;
      if (!nodes.length) return;
      const node = nodes[0];                      // the drag's shape (dir vs file) reads off the lead
      const files = nodes.filter((n) => !n.dir);  // only files open in a preview
      e.preventDefault();   // no text selection in the pre-threshold pixels
      const startX = e.clientX, startY = e.clientY;
      let live = false;
      let shield: HTMLElement | null = null;
      let folderEl: HTMLElement | null = null;
      const clearFolder = () => { if (folderEl) { folderEl.classList.remove('dropinto'); folderEl = null; } };
      const move = (ev: MouseEvent) => {
        if (!live) {
          if (Math.abs(ev.clientX - startX) < 5 && Math.abs(ev.clientY - startY) < 5) return;
          live = true;   // past the threshold: it's a drag, not a click
          shield = document.createElement('div');
          shield.className = 'dragshield';
          shield.style.cursor = 'grabbing';
          document.body.appendChild(shield);
          dockGhost = document.createElement('div');
          dockGhost.className = 'dockghost';
          dockGhost.textContent = nodes.length > 1 ? `${nodes.length} items` : node.name;
          document.body.appendChild(dockGhost);
        }
        dockGhost!.style.left = ev.clientX + 12 + 'px';
        dockGhost!.style.top = ev.clientY + 12 + 'px';
        // highlights mirror what mouseup would do, in priority order
        clearFolder();
        clearPaneDropFlags();
        const dir = dropdirAt(ev.clientX, ev.clientY, nodes);
        if (dir) {
          clearDockHl();
          folderEl = dir;
          dir.classList.add('dropinto');
          return;
        }
        updateDockTarget(ev.clientX, ev.clientY, null);
        if (!dockTarget) return;
        if (dockTarget.zone === 'center' && !previewAtLeaf(dockTarget.leafId)) {
          // terminal center: the path lands at the prompt — ring the pane, no zone box
          clearDockHl();
          const pane = document.elementsFromPoint(ev.clientX, ev.clientY)
            .find((n: any) => n.classList && n.classList.contains('pane')) as HTMLElement | undefined;
          if (pane) pane.classList.add('dropping');
        } else if (!files.length) {
          clearDockHl();   // folders never dock or stack
        }
      };
      const up = (ev: MouseEvent) => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        if (!live) return;                 // plain click — the row's handlers own it
        if (shield) shield.remove();
        if (dockGhost) { dockGhost.remove(); dockGhost = null; }
        clearFolder();
        clearPaneDropFlags();
        const dir = dropdirAt(ev.clientX, ev.clientY, nodes);
        if (dir) {
          clearDockHl();
          moveAll(nodes.map((n) => n.path), dir.dataset.dropdir);
          return;
        }
        updateDockTarget(ev.clientX, ev.clientY, null);
        const t = dockTarget;
        clearDockHl();
        if (!t) return;
        if (t.zone === 'center') {
          const pv = previewAtLeaf(t.leafId);
          if (pv) {
            if (!files.length) return;     // folders don't open in previews
            focusedPreview = pv;           // openFile routes here
            openDropped(files);
            return;
          }
          const s = sessionAtLeaf(t.leafId);
          if (s && s.ptyAlive) {
            ipc.ptyWrite(s.ptyId, nodes.map((n) => n.path).join(' ') + ' ').catch(() => {});
            for (const n of nodes) logAction('drop_tree_path', { path: n.path });
          }
          return;
        }
        if (!files.length) return;         // folders never dock
        spawnPreviewAt(t.leafId, t.zone);  // makePreview marks it focused
        openDropped(files);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    }

    // ── preview pane creation (model mutations) ──
    function paintDockBtn() {
      if (pvDockBtn) pvDockBtn.innerHTML = icon(pvDock === 'right' ? 'dock-bottom' : 'dock-right', 15);
      if (pvDockBtn) pvDockBtn.title = pvDock === 'right' ? 'dock to bottom' : 'dock to right';
    }
    // Seat a preview surface in the old singleton's default spot: a root split
    // against everything else (42% right / 40% bottom, per pvDock).
    function dockPreviewDefault(pvId: string) {
      const base = layout.root || terminalLeaf();
      const dir: 'row' | 'col' = pvDock === 'bottom' ? 'col' : 'row';
      layout.root = split(dir, [base, previewLeaf(pvId)], dir === 'col' ? [0.6, 0.4] : [0.58, 0.42]);
      renderLayout();
      saveLayout();
    }
    // a fresh instance in the default split — what a plain tree click gets
    // when no preview pane exists yet.
    function spawnPreview(): Preview {
      const pv = makePreview('pv' + (++pvSeq));
      dockPreviewDefault(pv.id);
      return pv;
    }
    // A fresh instance against one edge of the target leaf (tree-file edge
    // drop). A target that dissolved mid-drag falls back to the default split
    // so the instance can never orphan outside the tree.
    function spawnPreviewAt(targetLeafId: string, zone: DropSide): Preview {
      const pv = makePreview('pv' + (++pvSeq));
      insertBeside(layout, targetLeafId, previewLeaf(pv.id), zone);
      if (!hasSurface(layout.root, (s) => s.kind === 'preview' && s.id === pv.id)) {
        dockPreviewDefault(pv.id);
      } else {
        renderLayout();
        saveLayout();
      }
      logAction('layout_dock', { surface: 'preview', zone });
      return pv;
    }
    // flip the preview between right (row) and bottom (col). Kept for a future
    // header trigger; pvDockBtn is currently absent so this isn't wired to a
    // visible control, but it stays correct so one can be added.
    function setPvDock(side) {
      pvDock = side === 'bottom' ? 'bottom' : 'right';
      if (layout.root && layout.root.type === 'split' &&
          hasSurface(layout.root, (s) => s.kind === 'preview')) {
        layout.root.dir = pvDock === 'bottom' ? 'col' : 'row';
        renderLayout();
        saveLayout();
      }
      paintDockBtn();
      try { localStorage.setItem('spike-pv-dock', pvDock); } catch {}
    }
    if (pvDockBtn) pvDockBtn.addEventListener('click', () => setPvDock(pvDock === 'right' ? 'bottom' : 'right'));

    // file-tree sidebar: width, visibility AND side live on the model. The tree
    // stays a direct child of #shell, untouched by renderLayout — DOM order
    // docks it left or right, a class flips its border edge.
    function applyTreeWidth() {
      treeNode.style.flexBasis = layout.treeWidth + 'px';
      treeNode.style.width = layout.treeWidth + 'px';
    }
    function applyTreeSide() {
      const shell = document.getElementById('shell')!;
      shell.classList.toggle('tree-right', layout.treeSide === 'right');
      if (layout.treeSide === 'right') {
        shell.appendChild(treeDivideNode);
        shell.appendChild(treeNode);
      } else {
        shell.insertBefore(treeNode, shell.firstChild);
        shell.insertBefore(treeDivideNode, treeNode.nextSibling);
      }
      reflowAllVisible();
      syncFooterOrder();
    }
    makeResizer(treeDivideNode, (e) => {
      const shellRect = document.getElementById('shell').getBoundingClientRect();
      const raw = layout.treeSide === 'right' ? shellRect.right - e.clientX : e.clientX - shellRect.left;
      const w = Math.max(160, Math.min(raw, 520));
      layout.treeWidth = w;
      applyTreeWidth();
    }, undefined, saveLayout);

    // ─── footer dock toggles ──────────────────────────────────────────
    // Two Zed-style buttons in the bottom status bar:
    //   left  → show / hide the file tree (and its resizer). Persisted, ⌘B.
    //   right → show / hide the preview panel. Closes the open doc, or reopens
    //           the last one. Disabled (dimmed) when there's nothing to reopen.
    // Both reflow the terminal after the layout shifts so xterm stays honest.
    const toggleTreeBtn = document.getElementById('toggleTree');
    const toggleTermBtn = document.getElementById('toggleTerm');
    const togglePreviewBtn = document.getElementById('togglePreview');
    const toggleWebBtn = document.getElementById('toggleWeb');
    // Settings entry point: the footer's right-aligned gear (the top bar lost
    // it). Same .ftog register as the dock trio; ⌘, still works (keydown below).
    const footerSettingsBtn = document.getElementById('footerSettings');
    if (footerSettingsBtn) footerSettingsBtn.addEventListener('click', () => openSettings());

    // tree visibility lives on the model (layout.treeVisible) and persists with it.
    function applyTreeVisible() {
      // no project open → nothing to show; the splash gets the full canvas. The
      // saved pref (layout.treeVisible) is untouched, so the tree returns the
      // moment a folder loads (openProject re-applies this).
      const vis = layout.treeVisible && !!projectPath;
      treeNode.style.display = vis ? '' : 'none';
      treeDivideNode.style.display = vis ? '' : 'none';
      toggleTreeBtn.classList.toggle('on', vis);
      reflowAllVisible();
      syncFooterOrder();
    }
    toggleTreeBtn.addEventListener('click', () => {
      layout.treeVisible = !layout.treeVisible;
      saveLayout();
      applyTreeVisible();
    });
    // Actions that belong to the SIDEBAR itself rather than to whatever is
    // listed in it — so they tail both the file tree's menu and the roster's.
    // Right-clicking empty sidebar space is the natural way to ask "make this
    // go away", and until now the only paths out were ⌘B and the footer icon.
    function sidebarMenuItems() {
      return [
        { label: layout.treeSide === 'right' ? 'Pin sidebar left' : 'Pin sidebar right',
          fn: () => { layout.treeSide = layout.treeSide === 'right' ? 'left' : 'right'; applyTreeSide(); saveLayout(); } },
        { label: 'Hide sidebar', fn: () => toggleTreeBtn.click() },
      ];
    }

    // the tile area is empty when the terminal is hidden and no preview is open.
    function updateEmptyHint() {
      emptyHintEl.style.display = (termHidden && previews.size === 0) ? 'flex' : 'none';
    }

    // the preview is file-driven: lit when any pane is open, available
    // (clickable) when a doc has been opened this session, dimmed otherwise.
    // The toggle acts on ONE pane — the focused/last one — not all of them.
    function paintPreviewToggle() {
      // "Preview" here means a DOC pane (the file/artifact view) — distinct from
      // the web pane, which has its own globe toggle. Lit when any non-web
      // preview is open, so it never reflects (or acts on) the browser.
      const open = [...previews.values()].some((p) => p.id !== webPvId);
      togglePreviewBtn.classList.toggle('on', open);
      togglePreviewBtn.classList.toggle('disabled', !open && !lastFilePath);
      paintWebToggle();    // the web pane is a preview too — repaint on every open/close
      updateEmptyHint();   // a closing preview may empty the tile area
    }
    togglePreviewBtn.addEventListener('click', () => {
      // Act on a DOC pane only — never the web pane (that's the globe's job), so
      // this button can't close the browser out from under you when it's focused.
      const pv = docPreview();
      if (pv) pv.close();
      else if (lastFilePath) openFile(lastFilePath, lastFileName, null);
      // nothing opened yet → no-op (button reads disabled)
    });

    // The web pane's footer twin: lit while the browser pane is open. Clicking
    // it closes an open web pane, or opens one — reusing the last URL you
    // visited this session, else a start page you can retype from in the
    // omnibox. Always clickable (there's always somewhere to go), so it never
    // dims the way the preview toggle does.
    const WEB_START = 'https://www.google.com';
    function paintWebToggle() {
      if (!toggleWebBtn) return;
      toggleWebBtn.classList.toggle('on', !!(webPvId && previews.has(webPvId)));
    }
    if (toggleWebBtn) toggleWebBtn.addEventListener('click', () => {
      if (webPvId && previews.has(webPvId)) previews.get(webPvId)!.close();
      else openUrl(lastLiveUrl || WEB_START);
    });

    // the footer term icon now lights when the terminal is VISIBLE (the toggle
    // hides/shows it; sessions keep running either way).
    function paintTermToggle() {
      if (toggleTermBtn) toggleTermBtn.classList.toggle('on', !termHidden);
    }

    // The footer trio mirrors the screen: each icon lights when its panel is
    // visible (the paint* fns above) and the icons order themselves left-to-
    // right to match where their panels actually sit — tree pinned right puts
    // its icon last, a preview docked left of the terminal leads. The order is
    // derived from the layout on every render, so the preference persists with
    // it. A hidden tree keeps the slot its side implies; no preview slots just
    // right of the terminal.
    function syncFooterOrder() {
      const leftmost = (els: HTMLElement[], fallback: number) => {
        let k = fallback;
        for (const el of els) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.left < k) k = r.left;
        }
        return k;
      };
      const treeKey = layout.treeSide === 'right' ? Infinity : -Infinity;
      const termKey = leftmost([termColNode, ...sessions.map((s: any) => s.pane)], Number.MAX_SAFE_INTEGER);
      // The preview icon tracks DOC panes only — the web pane has its own globe
      // icon (positioned below), so excluding it keeps the two from colliding on
      // the same screen position.
      const docPvs = [...previews.values()].filter((p) => p.id !== webPvId);
      const pvKey = docPvs.length
        ? leftmost(docPvs.map((p) => p.root), termKey + 1)
        : termKey + 1;
      if (!toggleTreeBtn || !toggleTermBtn || !togglePreviewBtn) return;
      // The web pane sits at its own live rect when open; otherwise it trails
      // just right of the preview slot so the quartet keeps a stable shape.
      const webPv = webPvId ? previews.get(webPvId) : null;
      const webKey = webPv ? leftmost([webPv.root], pvKey + 0.5) : pvKey + 0.5;
      const order: Array<[HTMLElement, number]> = [
        [toggleTreeBtn, treeKey], [toggleTermBtn, termKey], [togglePreviewBtn, pvKey],
      ];
      if (toggleWebBtn) order.push([toggleWebBtn, webKey]);
      order.sort((a, b) => a[1] - b[1]);
      const footer = document.getElementById('footer')!;
      // reorder the trio within the footer's left group — always ahead of the
      // settings gear, which margin-left:auto pins to the right edge.
      for (const [btn] of order) {
        if (footerSettingsBtn) footer.insertBefore(btn, footerSettingsBtn);
        else footer.appendChild(btn);
      }
    }

    // ─── drag a footer icon to reorder the panes ──────────────────────────
    // The footer chips mirror pane order (syncFooterOrder); dragging one is the
    // twin gesture — it moves the pane itself. We only enable it on a FLAT row:
    // the root is a `row` split whose every top-level child maps 1:1 to one of
    // the term/doc/web chips (no popped-session panes, no nesting, no two docs).
    // Anything more tangled falls back to click-only — a half-working reorder is
    // worse than none. The tree chip is excluded (the sidebar isn't a row pane).
    // Returns visual-order [{btn, childIdx}] or null when not reorderable.
    function footerRow(): Array<{ btn: HTMLElement; childIdx: number }> | null {
      const root = layout.root;
      if (!root || root.type !== 'split' || root.dir !== 'row') return null;
      const out: Array<{ btn: HTMLElement; childIdx: number }> = [];
      const seen = new Set<HTMLElement>();
      for (let i = 0; i < root.children.length; i++) {
        const c = root.children[i];
        let btn: HTMLElement | null = null;
        if (hasSurface(c, (s) => s.kind === 'terminal' && !s.name)) btn = toggleTermBtn;
        else if (webPvId && hasSurface(c, (s) => s.kind === 'preview' && s.id === webPvId)) btn = toggleWebBtn;
        else if (hasSurface(c, (s) => s.kind === 'preview')) btn = togglePreviewBtn;
        else return null;   // a popped terminal / unknown surface → not a clean row
        if (!btn || seen.has(btn)) return null;   // duplicate kind (e.g. two docs) → bail
        seen.add(btn);
        out.push({ btn, childIdx: i });
      }
      return out.length >= 2 ? out : null;
    }

    // Move root-row child (and its size weight) from → to, then re-render. The
    // footer re-mirrors the new order for free via renderLayout → syncFooterOrder.
    function moveRowChild(from: number, to: number) {
      const root = layout.root;
      if (!root || root.type !== 'split' || from === to) return;
      const [child] = root.children.splice(from, 1);
      const [size] = root.sizes.splice(from, 1);
      root.children.splice(to, 0, child);
      root.sizes.splice(to, 0, size);
      renderLayout();
      saveLayout();
      logAction('footer_reorder_panes', { from, to });
    }

    function beginFooterReorder(e: MouseEvent, btn: HTMLElement) {
      if (e.button !== 0) return;
      const row = footerRow();
      if (!row) return;                       // not a flat row → let the click toggle
      const origIdx = row.findIndex((r) => r.btn === btn);
      if (origIdx < 0) return;
      const startX = e.clientX;
      // frozen pre-drag centers of every chip, in visual order
      const rects = row.map((r) => r.btn.getBoundingClientRect());
      const centers = rects.map((r) => r.left + r.width / 2);
      const slot = rects.length > 1 ? Math.abs(centers[1] - centers[0]) : 28;
      let live = false, shield: HTMLElement | null = null, target = origIdx;

      const move = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        if (!live) {
          if (Math.abs(dx) < 5) return;
          live = true;
          shield = document.createElement('div');
          shield.className = 'dragshield';
          shield.style.cursor = 'grabbing';
          document.body.appendChild(shield);
          btn.classList.add('fdragging');
        }
        // clamp the grabbed chip to the strip so it can't fly off the footer
        const lo = centers[0] - slot, hi = centers[centers.length - 1] + slot;
        const c = Math.max(lo, Math.min(centers[origIdx] + dx, hi));
        btn.style.transform = `translateX(${c - centers[origIdx]}px)`;
        // where would it land? count chips whose center it has crossed
        target = origIdx;
        while (target < row.length - 1 && c > centers[target + 1]) target++;
        while (target > 0 && c < centers[target - 1]) target--;
        // slide the others aside to reveal the gap at `target`
        for (let j = 0; j < row.length; j++) {
          if (j === origIdx) continue;
          let shift = 0;
          if (origIdx < target && j > origIdx && j <= target) shift = -slot;
          else if (origIdx > target && j >= target && j < origIdx) shift = slot;
          row[j].btn.style.transform = shift ? `translateX(${shift}px)` : '';
        }
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        if (shield) shield.remove();
        for (const r of row) { r.btn.style.transform = ''; r.btn.classList.remove('fdragging'); }
        if (!live) return;                    // never crossed threshold → it's a click
        // swallow the click that fires on mouseup so a reorder doesn't also toggle
        const eat = (ce: Event) => { ce.stopImmediatePropagation(); ce.preventDefault(); };
        btn.addEventListener('click', eat, true);
        setTimeout(() => btn.removeEventListener('click', eat, true), 0);
        if (target !== origIdx) moveRowChild(row[origIdx].childIdx, row[target].childIdx);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    }
    for (const b of [toggleTermBtn, togglePreviewBtn, toggleWebBtn])
      if (b) b.addEventListener('mousedown', (e) => beginFooterReorder(e as MouseEvent, b));

    // One predictable way back from any layout tangle (right-click the footer):
    // popped terminals return to the tab strip, extra previews close, and the
    // focused preview re-seats at the classic split. Docs in the closed panes
    // are session-transient by design — the tree re-opens them in one click.
    function resetLayout() {
      removeSurface(layout, (s) => s.kind === 'terminal' && !!s.name);
      // Re-seat a DOC pane at the classic split — never the web pane. Reset is
      // "back to my work", so if a browser happens to be focused it must not
      // become the pane we keep while your artifact panes get closed. The web
      // pane, if open, is preserved as-is (your browser shouldn't vanish on a
      // layout reset — reopen is a click, but the page you're on isn't).
      const keep = docPreview();
      const keepWeb = webPvId ? previews.get(webPvId) : null;
      for (const pv of [...previews.values()]) {
        if (pv !== keep && pv !== keepWeb) {
          removeSurface(layout, (s) => s.kind === 'preview' && s.id === pv.id);
          pv.dispose();
        }
      }
      if (keep) {
        removeSurface(layout, (s) => s.kind === 'preview' && s.id === keep.id);
        dockPreviewDefault(keep.id);   // renders + saves (base keeps any web pane)
      } else {
        renderLayout();
        saveLayout();
      }
      renderTabs();
    }
    document.getElementById('footer')!.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY, [{ label: 'Reset layout', fn: resetLayout }]);
    });
    if (toggleTermBtn) toggleTermBtn.addEventListener('click', () => {
      termHidden = !termHidden;
      try { localStorage.setItem('spike-term-hidden', termHidden ? '1' : '0'); } catch {}
      paintTermToggle();
      renderLayout();   // re-render with / without the terminal column so panels fill
      if (!termHidden && active && active.term) active.term.focus();   // showing it → focus
    });

    // ⌘K palette · ⌘B tree · ⌘J preview · ⌘\ focus terminal · ⌘S save · ⌘T
    // new tab · ⌘⇧M merge panes · ⌘/ shortcuts - held with Cmd so bare letters reach
    // the terminal. ⌘S saves the focused pane's doc (one window-level handler;
    // the per-instance editors don't bind it, so a save can never double-fire).
    // While the palette is up, its own capture-phase handler eats ⌘K first.
    // ⌃Tab / ⌃⇧Tab: step to the next/previous session in the visible strip order
    // (the same flattened left-to-right order ⌘1..9 uses, so the two agree). Wraps
    // around. If the focused session is popped (not in the strip), start from the
    // strip's first tab. Fewer than two tabs → nothing to cycle.
    function cycleSession(dir: number) {
      const names = (Array.from(tabsEl.querySelectorAll('.tab')) as HTMLElement[]).map((t) => t.dataset.sname);
      if (names.length < 2) return;
      let idx = active ? names.indexOf(active.name) : -1;
      if (idx < 0) idx = dir > 0 ? -1 : 0;   // land on names[0] going forward, names[0] going back
      const next = (idx + dir + names.length) % names.length;
      const s = sessions.find((x) => x.name === names[next]);
      if (s && s !== active) activate(s);
    }

    // ⌘W close guard. Closing kills the pty (irreversible), so an accidental
    // keystroke shouldn't lose a running agent: the first ⌘W arms + announces,
    // a second within the window commits. Re-arms per session; the note self-
    // clears. (The menu's "Close session" and the tab × stay one-shot — those
    // are deliberate clicks, not a key you can fat-finger.)
    let armedClose: any = null;
    let armedCloseTimer: any = 0;
    function requestCloseActive() {
      const s = active;
      if (!s) return;
      if (armedClose === s) {
        clearTimeout(armedCloseTimer); armedClose = null;
        updateStatus('', 0);
        s.close();
        return;
      }
      armedClose = s;
      updateStatus(`⌘W again to close “${s.name}”`, 3000);
      clearTimeout(armedCloseTimer);
      armedCloseTimer = setTimeout(() => { armedClose = null; }, 3000);
    }

    window.addEventListener('keydown', (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      // ⌥⌘F is find-and-replace. Every OTHER ⌘-chord in this map is alt-free, and
      // ⌥ changes e.key on macOS (⌥F is "ƒ"), so match the physical key and let
      // nothing else through with alt held.
      if (e.altKey) {
        if (e.code === 'KeyF') {
          const pv = livePreview();
          if (pv) { e.preventDefault(); pv.openFind(true); }
        }
        return;
      }
      const k = e.key.toLowerCase();
      // While a WYSIWYG editor is focused, ⌘B / ⌘I are formatting commands — not
      // the tree toggle — so they must reach the contenteditable, not this map.
      const ae = document.activeElement as HTMLElement | null;
      const inWysiwyg = !!(ae && ae.closest && ae.closest('.pvrender.editing'));
      if (inWysiwyg && (k === 'b' || k === 'i')) { e.preventDefault(); document.execCommand(k === 'b' ? 'bold' : 'italic'); return; }
      // ⌘⇧E flips the focused lane between the chat view and its terminal.
      // Checked before the ⌘E branch below, which is the preview's edit toggle:
      // shift doesn't change e.key's letter, so the plain-⌘E arm would swallow it.
      if (CHAT_ENABLED && k === 'e' && e.shiftKey) {
        if (isAgentLane(active)) { e.preventDefault(); active.toggleChat(); }
        return;
      }
      if (k === 'b') { e.preventDefault(); toggleTreeBtn.click(); }
      // `!e.shiftKey` is load-bearing in the shell edition, where the arm above
      // is compiled past: shift doesn't change e.key's letter, so without it
      // ⌘⇧E would fall through here and toggle the preview's editor.
      else if (k === 'e' && !e.shiftKey) { const pv = livePreview(); if (pv && pv.canEdit()) { e.preventDefault(); pv.toggleEdit(); } }
      else if (k === 'j') { e.preventDefault(); togglePreviewBtn.click(); }
      else if (k === 's') { const pv = livePreview(); if (pv) { e.preventDefault(); pv.save(); } }
      else if (k === 'f') { const pv = livePreview(); if (pv) { e.preventDefault(); pv.openFind(); } }
      else if (k === '[') { const pv = livePreview(); if (pv && pv.htmlZoomActive()) { e.preventDefault(); pv.htmlBack(); } }
      else if (k === '\\') { e.preventDefault(); toggleTermBtn && toggleTermBtn.click(); }
      else if (k === ',') { e.preventDefault(); openSettings(); }
      else if (k === 'k') { e.preventDefault(); palette.toggle(); }
      else if (k === '/') { e.preventDefault(); palette.shortcuts(); }
      else if (k === 't') { e.preventDefault(); beginNewSession(); }
      // ⌘⇧N is quick-capture; checked before the plain-⌘N arm (which spawns a
      // fresh Spike window) because shift doesn't change e.key's letter, so that
      // arm would otherwise swallow it — same guard pattern as ⌘⇧E above.
      else if (k === 'n' && e.shiftKey) { e.preventDefault(); capture(); }
      else if (k === 'n') { e.preventDefault(); ipc.newInstance().catch(() => {}); }   // fresh Spike window (new OS process)
      else if (k === 'm' && e.shiftKey) { e.preventDefault(); resetLayout(); }   // merge panes back into one
      else if (k === '=' || k === '+') { e.preventDefault(); zoomIndex = Math.min(ZOOM_STEPS.length - 1, zoomIndex + 1); applyZoom(); }
      else if (k === '-') { e.preventDefault(); zoomIndex = Math.max(0, zoomIndex - 1); applyZoom(); }
      else if (k === '0') { e.preventDefault(); zoomIndex = BASE_ZOOM_INDEX; applyZoom(); }
      // Chrome-style ⌘1..⌘8 jump to the tab at that position in the strip, ⌘9
      // to the last one — no matter how many tabs there are (that's the Chrome
      // contract). Shift+digit yields a symbol, not a digit, so those combos
      // fall through untouched. ⌘0 stays zoom-reset above, matching Chrome.
      else if (k >= '1' && k <= '9') { e.preventDefault(); jumpToStripTab(Number(k)); }
      // ⌃Tab / ⌃⇧Tab walk the strip like Chrome. Terminals let it through (their
      // custom key handler returns false for ⌃Tab), so it works with a pane focused.
      else if (k === 'tab') { e.preventDefault(); cycleSession(e.shiftKey ? -1 : 1); }
      // ⌘W closes the active session — meta-only on purpose, so ⌃W stays the
      // terminal's word-erase. Guarded: kills a running agent's pty, so it takes
      // a second ⌘W to confirm (see requestCloseActive).
      else if (k === 'w' && e.metaKey) { e.preventDefault(); requestCloseActive(); }
    });

    // ⌘⌥I opens the Web Inspector for the in-pane browser board (dev builds only
    // — the inspector is compiled out of release, so it's a no-op there). Its own
    // handler because the dispatcher above bails on Alt combos on purpose, and it
    // keys off e.code since Option composes e.key on macOS. Only fires when a live
    // board is actually on screen.
    window.addEventListener('keydown', (e) => {
      if (!(e.metaKey || e.ctrlKey) || !e.altKey || e.code !== 'KeyI') return;
      if (!liveRenderBox || !liveRenderBox.isConnected || !liveRenderBox.classList.contains('show')) return;
      e.preventDefault();
      ipc.liveWebviewDevtools().catch(() => {});
    });

    // ─── settings panel ───────────────────────────────────────────────
    // Opened by the footer gear, lower-right (or ⌘,). The panel itself lives in
    // settings.ts (initSettings, below); app.ts keeps only the pieces that
    // touch the live model: the config cache (appConfig), the per-extension
    // default view, and the workspace factory (gseq lives here).

    function loadConfig() {
      return ipc.getConfig().then(c => {
        appConfig = c;
        reconcileTheme(c);
        reconcileAccent(c);
        bookmarks = Array.isArray(c && c.bookmarks) ? c.bookmarks : [];
        // Pins are NOT read from the config any more (see mutatePins) — they
        // have their own file, loaded here alongside it.
        loadPins().then((list) => {
          // Pinned docs are the one set of real paths we know at BOOT — seed the
          // out-of-tree resolver with them so a chip citing a vault file resolves
          // even before the agent has read anything (see resolveFileRef).
          for (const it of list) { try { rememberOpened(it && it.path); } catch {} }
        });
        return c;
      }).catch(() => appConfig);
    }

    // First-run engine resolver — runs once at boot, BEFORE openProject or
    // showWelcome, so the engine choice is settled when the first tab spawns.
    // Also caches the detection result in `detectedEngines` for downstream
    // gating (launcher chip enabledness, defaultSpawnEngine fallback).
    //
    // Cases:
    //  * Flag already set → just cache detection, proceed
    //  * Neither engine installed → mark flag, no engine default; welcome will
    //    show a "no engines detected" hint
    //  * One engine installed → silently set as default + mark flag
    //  * BOTH installed → return 'force-welcome' so boot forces the welcome
    //    surface even if a last project exists. Welcome shows the chip picker.
    //
    // No popup modal. The welcome screen is the right home for this question —
    // it's the surface that already exists for "starting from zero," and the
    // engine choice is just one more thing to settle before opening a folder.
    let pendingFirstRunEngine: string | null = null;   // 'claude' | 'codex' until persisted

    function resolveFirstRunEngine(): Promise<'force-welcome' | 'proceed'> {
      return ipc.detectEngines().then((det) => {
        // Cache for downstream readers (defaultSpawnEngine, launcher chips,
        // Settings segment). Always populated, regardless of the first-run flag.
        detectedEngines = det;
        // The Home composer's model menu was built before this landed — rebuild
        // it now, or an installed Codex never appears in it.
        try { refreshHomeModelPicker && refreshHomeModelPicker(); } catch { /* picker not built yet */ }
        // Surface the "no agents detected" hint on welcome when neither is
        // installed, regardless of first-run flag. The user can still pick a
        // folder; the tab spawns as a plain shell with the cause visible
        // instead of silently degrading.
        renderNoEnginesHint(det);
        if (!appConfig || appConfig.engineFirstRunSeen === true) return 'proceed' as const;
        const both = det.claude.installed && det.codex.installed;
        if (!both) {
          // 0 or 1 engine — no chip picker, set the default to whichever is
          // installed (if any), mark the flag. Scenario C (neither installed)
          // sets no engine default; defaultSpawnEngine's fallback returns 'shell',
          // and the welcome shows the "no engines detected" hint.
          const choice = det.claude.installed ? 'claude' : det.codex.installed ? 'codex' : null;
          const patch: any = { engineFirstRunSeen: true };
          if (choice) patch.spawnDefaults = { ...((appConfig && appConfig.spawnDefaults) || {}), engine: choice };
          patchConfig(patch);
          return 'proceed' as const;
        }
        // Both installed — show welcome chip picker.
        pendingFirstRunEngine = (appConfig.spawnDefaults && appConfig.spawnDefaults.engine) || 'claude';
        renderWelcomeEnginePicker();
        return 'force-welcome' as const;
      }).catch(() => 'proceed' as const);
    }

    // Show / hide the "no agents detected" caption on welcome based on
    // detection. Visible only when BOTH engines are missing — the
    // single-engine case silently sets the available one as default and
    // welcome reads normally.
    function renderNoEnginesHint(det: ipc.EngineDetection) {
      const el = document.getElementById('welcomeNoEngines');
      if (!el) return;
      const neither = !det.claude.installed && !det.codex.installed;
      el.style.display = neither ? 'block' : 'none';
    }

    // Refresh detection on demand (called before opening the + launcher so
    // chips reflect any install/uninstall that happened mid-session). Cheap —
    // two stat calls on the Rust side. Updates the cache; safe to call any
    // time. Returns the latest detection (or the stale one on failure).
    function refreshEngineDetection(): Promise<ipc.EngineDetection | null> {
      return ipc.detectEngines().then((d) => {
        detectedEngines = d;
        // An engine installed (or removed) mid-session shows up in the Home
        // composer too, not just the + launcher chips.
        try { refreshHomeModelPicker && refreshHomeModelPicker(); } catch { /* picker not built yet */ }
        return d;
      }).catch(() => detectedEngines);
    }

    // Render the engine chip picker inside the welcome surface. Toggles its
    // visibility on and wires click handlers that update `pendingFirstRunEngine`
    // (the actual persist happens on "Choose folder" click, alongside opening
    // the project).
    function renderWelcomeEnginePicker() {
      const wrap = document.getElementById('welcomeEnginePick');
      const modes = document.getElementById('welcomeEngineModes');
      if (!wrap || !modes) return;
      modes.innerHTML = '';
      const mk = (engine: string, label: string, iconHtml: string) => {
        const b = document.createElement('div');
        b.className = 'mode' + (engine === pendingFirstRunEngine ? ' on' : '');
        b.dataset.engine = engine;
        b.innerHTML = iconHtml + `<span>${label}</span>`;
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', () => {
          pendingFirstRunEngine = engine;
          modes.querySelectorAll('.mode').forEach((x: any) => x.classList.toggle('on', x.dataset.engine === engine));
        });
        return b;
      };
      modes.appendChild(mk('claude', 'Claude', `<span class="cicon"><img src="${claudeLogo}" width="15" height="15" alt=""></span>`));
      modes.appendChild(mk('codex', 'Codex', `<span class="cicon cicon-codex"><img src="${codexLogo}" width="15" height="15" alt=""></span>`));
      wrap.style.display = 'flex';
    }

    // Called from pickProject / promptForPath at the moment the user commits
    // to a folder. If a first-run pick is pending, persist it now (engine +
    // seen flag) BEFORE the project opens, so the default session that spawns
    // immediately after uses the chosen engine.
    function commitPendingFirstRunEngine() {
      if (!pendingFirstRunEngine) return;
      const engine = pendingFirstRunEngine;
      pendingFirstRunEngine = null;
      patchConfig({
        engineFirstRunSeen: true,
        spawnDefaults: { ...((appConfig && appConfig.spawnDefaults) || {}), engine },
      });
    }
    // The view a file opens in: an explicit per-extension preference from settings,
    // else the built-in rule (md/html/csv → rendered, code/text → source). A
    // 'rendered' preference only applies to files that actually have a rendered view.
    function defaultViewFor(name) {
      const m = /\.([^.\/\\]+)$/.exec(name || '');
      const ext = m ? '.' + m[1].toLowerCase() : '';
      const pref = appConfig && appConfig.previewDefaults && appConfig.previewDefaults[ext];
      if (pref === 'source') return 'source';
      if (pref === 'rendered' && hasRendered(name)) return 'rendered';
      return hasRendered(name) ? 'rendered' : 'source';
    }
    // Merge a settings patch into config.json and keep the local copy in sync.
    function patchConfig(patch) {
      appConfig = { ...(appConfig || {}), ...patch };
      ipc.patchConfig(patch).then(c => { appConfig = c; }).catch(() => {});
    }
    // A workspace with no live tab yet — definable before you open into it.
    // `init` seeds fields (settings' Duplicate clones a card through here);
    // id and createdAt are always fresh, membership always empty.
    function newWorkspace(init?: any) {
      const g = { name: 'New workspace', color: GROUP_COLORS[gseq % GROUP_COLORS.length],
                  collapsed: false, cwd: '', description: '', pinnedPaths: [], isolation: 'shared' as const, mcpEnabled: [],
                  ...(init || {}),
                  id: ++gseq, createdAt: new Date().toISOString() };
      groups.push(g);
      persistGroup(g);
      return g;
    }

    // The panel proper (sections, workspace cards, rows) — settings.ts.
    const settingsUI = initSettings({
      icon,
      groups,
      groupColors: GROUP_COLORS,
      membersOf,
      persistGroup,
      unpersistGroup,
      renderTabs,
      newTabInGroup,
      newWorkspace,
      getConfig: () => appConfig,
      loadConfig,
      patchConfig,
      getEngines: () => detectedEngines,
      openFile: (path, name) => openFile(path, name, null),
      // "Open ↗" on a workspace card: back to the app, focused on this
      // workspace (focusWorkspace — shared with the palette).
      openWorkspace: focusWorkspace,
      getProjectPath: () => projectPath,
      getTheme: themePref,
      setTheme: applyTheme,
      getAccent: accentPref,
      setAccent: applyAccent,
      accentPalette: ACCENTS,
    });
    // Gear / ⌘, entry point. Close any floating UI first (the + launcher, tab
    // and tree menus, the palette) so opening settings never stacks on another modal.
    function openSettings() {
      closeLauncher();
      closeGroupMenu();
      closeMenu();
      palette.close();
      settingsUI.toggle();
    }

    // ─── ⌘K command palette ─────────────────────────────────────────────
    // The registry: every workspace, tab, and action as a searchable item,
    // built fresh per open so it always mirrors the live model. Shortcut and
    // gesture hints ride along on each row — the palette doubles as the app's
    // self-documenting index, so the hidden right-click/drag/double-click
    // paths become accelerators instead of the only door. File search reads
    // the live allPaths index inside palette.ts; no items are built for it.
    function paletteItems(): PaletteItem[] {
      const items: PaletteItem[] = [];

      // Before a project opens most verbs are moot (no cwd to spawn into, no
      // files) — offer just the doorway plus the always-safe commands.
      if (!projectPath) {
        items.push(
          { id: 'c:open-project', label: 'Open project folder…', section: 'command', run: pickProject },
          { id: 'c:import-people', label: 'Import people from a CSV…', section: 'command',
            hint: 'people and companies you can @', run: () => importPeopleCsv?.() },
          themeItem(),
          { id: 'c:settings', label: 'Settings', section: 'command', hint: '⌘,', run: openSettings },
          updateItem(),
          { id: 'c:keys', label: 'Keyboard shortcuts', section: 'command', hint: '⌘/', run: () => palette.shortcuts() },
        );
        return items;
      }

      // jump targets: saved workspaces — INCLUDING empty ones, which the strip
      // never renders; the palette is their quick door back into a live tab
      for (const g of groups) {
        const n = membersOf(g.id).length;
        items.push({ id: 'ws:' + g.id, label: g.name, section: 'workspace', color: g.color,
                     hint: n ? n + (n === 1 ? ' tab' : ' tabs') : 'no live tabs',
                     run: () => focusWorkspace(g) });
      }
      for (const s of sessions) {
        items.push({ id: 'tab:' + s.ptyId, label: s.name, section: 'tab',
                     hint: groupName(s.groupId) || (isPoppedSession(s) ? 'split pane' : ''),
                     run: () => activate(s) });
      }
      // Reopen a preview that was evicted after its lane closed. Cheap
      // resurrection — comes back user-owned (neutral), since you deliberately
      // brought it back; that also drops it from the evicted buffer.
      for (const rec of evictedOrphans) {
        items.push({ id: 'reopen:' + rec.path, label: 'Reopen ' + rec.name, section: 'command', hint: 'closed lane',
                     run: () => {
                       dropEvicted(rec.path);
                       // reopen through the door that matches the surface kind, so
                       // a live URL / web article doesn't come back as a file read
                       if (rec.liveurl) openUrl(rec.path);            // dock the live board
                       else if (rec.web) openWebArticle(rec.path);    // the readable article
                       else openFile(rec.path, rec.name, null);
                     } });
      }

      // Layout reset rises to the TOP of commands while panes are split - the
      // calm (no-query) list caps at a handful, so a buried verb is invisible
      // exactly when you most need it. Labelled for both mental models so
      // "reset", "layout", "merge", or "panes" all find it.
      if (leaves(layout.root).length > 1)
        items.push({ id: 'c:merge-panes', label: 'Reset layout (merge panes into one)', section: 'command', hint: '⌘⇧M', run: resetLayout });

      // workspace verbs
      items.push({ id: 'c:new-ws', label: 'New workspace…', section: 'command',
                   arg: { placeholder: 'workspace name', run: (v) => focusWorkspace(newWorkspace({ name: v })) } });
      for (const g of groups) {
        items.push({ id: 'c:newtab:' + g.id, label: 'New tab in ' + g.name, section: 'command',
                     color: g.color, run: () => newTabInGroup(g) });
        items.push({ id: 'c:rename-ws:' + g.id, label: 'Rename workspace ' + g.name + '…', section: 'command',
                     hint: 'double-click chip',
                     arg: { placeholder: 'new name', run: (v) => renameGroup(g, v) } });
        items.push({ id: 'c:ungroup:' + g.id, label: 'Ungroup ' + g.name, section: 'command',
                     run: () => ungroupWorkspace(g) });
      }

      // verbs scoped to the focused tab (captured now — the model can't change
      // while the palette is up, it eats all keys and any click closes it)
      const a = active;
      if (a) {
        items.push({ id: 'c:rename-tab', label: 'Rename tab ' + a.name, section: 'command',
                     hint: 'double-click tab',
                     // a.tab is the live strip element from the last render; the
                     // inline editor opening ON the tab teaches where the gesture lives
                     run: () => beginTabRename(a, a.tab) });
        if (isPoppedSession(a)) items.push({ id: 'c:unpop', label: 'Move tab back to strip', section: 'command', run: () => unpopSession(a) });
        else items.push({ id: 'c:pop', label: 'Open tab in split pane', section: 'command',
                          hint: 'drag tab out', run: () => popSession(a) });
        items.push({ id: 'c:new-group', label: 'New group from this tab', section: 'command',
                     hint: 'right-click tab', run: () => newGroupFor(a) });
        items.push({ id: 'c:handoff', label: 'Hand off ' + a.name + ' to a new agent…', section: 'command',
                     hint: 'right-click tab', run: () => openHandoffSheet(a) });
        for (const g of groups) {
          if (g.id === a.groupId) continue;
          items.push({ id: 'c:move:' + g.id, label: 'Move tab to ' + g.name, section: 'command',
                       color: g.color, run: () => assignTo(a, g.id) });
        }
        if (a.groupId != null)
          items.push({ id: 'c:degroup', label: 'Remove tab from group', section: 'command', run: () => assignTo(a, null) });
      }

      // Live view (source + rendered together) has no button in the segmented
      // control — this is its only door. Offered only when the focused pane holds
      // a doc with two halves to split; the label says which way it will flip so
      // the palette carries the state the old button's icon used to.
      {
        const pv = livePreview();
        if (pv && pv.canLiveSplit()) {
          const live = pv.view === 'live';
          const stacked = (() => {
            try { return localStorage.getItem('spike-live-split') !== 'row'; } catch { return true; }
          })();
          items.push({
            id: 'c:live-split',
            label: live
              ? (stacked ? 'Live view: flip to side by side' : 'Live view: flip to stacked')
              : 'Live view: source and rendered together',
            section: 'command',
            run: () => pv.toggleLiveSplit(),
          });
        }
      }

      // sessions + app chrome
      const spawn = (mode: string, label: string) => {
        hideWelcome();
        activate(new Session(uniqueSessionName(label), defaultSpawnCwd(), mode, undefined));
      };
      items.push(
        { id: 'c:new-claude', label: 'New Claude session', section: 'command', hint: '+ in tab strip', run: () => spawn('claude', 'Claude') },
        { id: 'c:new-codex', label: 'New Codex session', section: 'command', run: () => spawn('codex', 'Codex') },
        { id: 'c:new-term', label: 'New terminal session', section: 'command', run: () => spawn('shell', 'Terminal') },
        { id: 'c:capture', label: 'New capture (jot to inbox)', section: 'command', hint: '⌘⇧N', run: () => capture() },
        // Offered only when the focused lane is a live agent that can do the
        // filing — it reads inbox/ and proposes moves you approve in the chat.
        ...(isAgentLane(a) && a.ptyAlive ? [{
          id: 'c:tend-inbox',
          label: 'Tend inbox (sort captured notes)',
          section: 'command' as const,
          hint: 'agent proposes → you approve',
          run: () => a.tendInbox(),
        }] : []),
        // The calm face of the focused lane. Label states where you'd land, not
        // where you are — same contract as the other toggles in this list.
        ...(CHAT_ENABLED && isAgentLane(a) ? [{
          id: 'c:chat-view',
          label: a.chatOn ? 'Show the terminal for this session' : 'Chat view for this session',
          section: 'command' as const,
          hint: '⌘⇧E',
          run: () => a.toggleChat(),
        }] : []),
        { id: 'c:tree', label: 'Toggle file tree', section: 'command', hint: '⌘B', run: () => { if (toggleTreeBtn) toggleTreeBtn.click(); } },
        { id: 'c:preview', label: 'Toggle preview panel', section: 'command', hint: '⌘J', run: () => { if (togglePreviewBtn) togglePreviewBtn.click(); } },
        { id: 'c:term', label: 'Toggle terminal', section: 'command', hint: '⌘\\', run: () => { if (toggleTermBtn) toggleTermBtn.click(); } },
        { id: 'c:collapse', label: 'Collapse all folders', section: 'command', run: collapseAllFolders },
        // lands on YOUR workspace's page when the focused tab has one, else
        // the shared Defaults page (settings.ts normalizes the route)
        { id: 'c:ws-settings', label: 'Workspace settings', section: 'command',
          run: () => settingsUI.open(a && a.groupId != null ? 'workspace:' + a.groupId : 'defaults') },
        { id: 'c:settings', label: 'Settings', section: 'command', hint: '⌘,', run: openSettings },
        themeItem(),
        { id: 'c:open-project', label: 'Open project folder…', section: 'command', run: pickProject },
        { id: 'c:import-people', label: 'Import people from a CSV…', section: 'command',
          hint: 'people and companies you can @', run: () => importPeopleCsv?.() },
        { id: 'c:attest', label: attest.label(), section: 'command', hint: 'sources → receipt',
          arg: { placeholder: 'what should the answer be grounded in?', run: (v) => { attest.run(v); } } },
        { id: 'c:playbook', label: playbook.label(), section: 'command', hint: 'do it → checks gate it',
          arg: { placeholder: 'what should I do? (runs your code + verify playbook)', run: (v) => { playbook.run(v); } } },
        { id: 'c:save-template', label: 'Save current setup as template…', section: 'command',
          arg: { placeholder: 'template name', run: (v) => { saveSetupAsTemplate(v); } } },
        { id: 'c:uninstall-template', label: 'Uninstall template…', section: 'command', run: () => { showUninstall(); } },
        updateItem(),
        { id: 'c:keys', label: 'Keyboard shortcuts', section: 'command', hint: '⌘/', run: () => palette.shortcuts() },
      );
      return items;
    }
    // ─── in-app updates ────────────────────────────────────────────────
    // Deliberately minimal: one palette row whose label reflects state, and a
    // self-clearing #status line when the launch check finds something. No
    // banner, no modal, no nag — a check you didn't ask for should never take
    // the screen. Everything the user needs is one ⌘K away.
    let pendingUpdate: ipc.PendingUpdate | null = null;

    // The footer pill is the durable cue the transient #status line couldn't be:
    // it appears only while an update is pending and installs on click. Kept in
    // sync everywhere pendingUpdate changes (boot check, manual check, install).
    const footerUpdateBtn = document.getElementById('footerUpdate') as HTMLButtonElement | null;
    function reflectPendingUpdate(): void {
      if (!footerUpdateBtn) return;
      if (pendingUpdate) {
        footerUpdateBtn.textContent = `↓ ${pendingUpdate.version}`;
        footerUpdateBtn.title = `Update to Spike ${pendingUpdate.version} — click to install and restart`;
        footerUpdateBtn.hidden = false;
      } else {
        footerUpdateBtn.hidden = true;
      }
    }
    footerUpdateBtn?.addEventListener('click', () => runUpdateInstall());

    // Label doubles as the state readout, the way themeItem() does below.
    function updateItem(): PaletteItem {
      if (pendingUpdate) {
        return {
          id: 'c:update', label: `Install Spike ${pendingUpdate.version} and restart`,
          section: 'command', hint: 'restarts Spike', priority: true, run: runUpdateInstall,
        };
      }
      return { id: 'c:update', label: 'Check for updates…', section: 'command', run: runUpdateCheck };
    }

    // #status is the transient line; self-clear so a note never sits forever.
    function updateStatus(msg: string, ms = 8000): void {
      if (!status) return;
      status.textContent = msg;
      if (ms) setTimeout(() => { if (status && status.textContent === msg) status.textContent = ''; }, ms);
    }

    function runUpdateCheck(): void {
      updateStatus('Checking for updates…', 0);
      ipc.checkForUpdate()
        .then((u) => {
          pendingUpdate = u;
          reflectPendingUpdate();
          updateStatus(u ? `Spike ${u.version} available — ⌘K to install` : 'Spike is up to date');
        })
        // A throw is "couldn't reach the endpoint", not "you're current".
        .catch((e) => updateStatus(ipc.errorMessage(e, 'update check failed')));
    }

    function runUpdateInstall(): void {
      const u = pendingUpdate;
      if (!u) return;
      updateStatus(`Downloading Spike ${u.version}…`, 0);
      u.install((done, total) => {
        const pct = total ? Math.round((done / total) * 100) : null;
        updateStatus(pct === null ? `Downloading Spike ${u.version}…` : `Downloading Spike ${u.version}… ${pct}%`, 0);
      })
        // install() relaunches on success, so reaching here means it failed.
        .catch((e) => updateStatus(ipc.errorMessage(e, 'update failed')));
    }

    // theme flips read the current choice at build time so the label tells the truth
    // Fast two-way flip against what's on screen. 'System' is deliberately not
    // a palette item — it's a set-and-forget preference, so it lives in
    // Settings › Appearance rather than adding a third entry here.
    function themeItem(): PaletteItem {
      const next = effectiveTheme() === 'light' ? 'dark' : 'light';
      return { id: 'c:theme', label: 'Switch to ' + next + ' theme', section: 'command', run: () => applyTheme(next) };
    }

    const attest = initAttest({
      getProjectPath: () => projectPath,
      getGroup: () => (active ? laneGroupFor(active) : null),
      openFile: (path, name) => openFile(path, name, null, { reload: true }),
      status: (msg, ms) => updateStatus(msg, ms),
      reloadTree: () => { if (projectPath) loadTree(projectPath); },
    });

    const playbook = initPlaybook({
      getProjectPath: () => projectPath,
      getGroup: () => (active ? laneGroupFor(active) : null),
      openFile: (path, name) => openFile(path, name, null, { reload: true }),
      status: (msg, ms) => updateStatus(msg, ms),
      reloadTree: () => { if (projectPath) loadTree(projectPath); },
    });

    // ── Playbooks library view ──────────────────────────────────────────────
    // The real surface behind the Home "Playbooks" nav (was a "coming soon" stub).
    // A shelf of playbook files from ~/.spike/playbooks: browse, create, edit, and
    // run one against a chosen folder — the receipt renders inline. Reuses the
    // wsv-* card/section styles; only its own bits (checks chips, run bar, receipt)
    // are new. The engine lives in playbookui/attest; this is the Spike-shaped shell.
    {
      const pbEl = document.getElementById('playbooks');
    // [shell edition] Playbooks view is not part of Spike Shell.
    }

    const palette = initPalette({
      icon,
      getItems: paletteItems,
      getFiles: () => allPaths as Set<string>,
      getProjectPath: () => projectPath,
      openFile: (path, name) => openFile(path, name, null),
      beforeOpen: () => { closeLauncher(); closeGroupMenu(); closeMenu(); if (settingsUI.isOpen()) settingsUI.close(); },
      onClose: () => { if (active) active.term.focus(); },
    });

    // The slot markStatus() reserved finally earns its keep: one quiet,
    // clickable "⌘K" glyph at the bar's right edge — the palette's only
    // persistent signpost. No drag-region attribute, so clicks stay clicks.
    {
      // A new note is a global quick-action, so its signpost sits with the
      // palette's — a quiet pencil just left of ⌘K. capture() guards the
      // no-project case, so the glyph is safe to keep always-present like ⌘K.
      const capbtn = document.createElement('span');
      capbtn.id = 'capbtn';
      // The stroked icon, not the '✎' character: as type, that glyph came out
      // heavy and hatched at this size and read as a smudge beside ⌘K's clean
      // letterforms. icon() is the same 2px-stroke currentColor family as the
      // footer and tree chrome, so the pair now agrees on weight.
      capbtn.innerHTML = icon('pencil', 14);
      capbtn.title = 'new capture — jot to inbox (⌘⇧N)';
      capbtn.addEventListener('click', () => capture());
      document.getElementById('bar')!.appendChild(capbtn);

      const kbtn = document.createElement('span');
      kbtn.id = 'kbtn';
      kbtn.textContent = '⌘K';
      kbtn.title = 'command palette (⌘K)';
      kbtn.addEventListener('click', () => palette.toggle());
      document.getElementById('bar')!.appendChild(kbtn);
    }

    applyTreeWidth();
    applyTreeSide();
    renderLayout();      // build the initial tile scaffold (terminal leaf only)
    applyTreeVisible();
    paintPreviewToggle();
    paintTermToggle();

    // Flipping back from another window (e.g. a second Claude) used to leave the
    // terminal unfocused and its geometry stale — you'd have to click or hit
    // Enter, and scrolling felt frozen. On window focus, refit the active
    // terminal (fixes the stale-size scroll) and refocus it, unless you're
    // mid-edit somewhere else (preview editor, a rename field).
    window.addEventListener('focus', () => {
      if (!active) return;
      active.resize();   // geometry can drift while the window is backgrounded
      const ae = document.activeElement;
      const editingElsewhere = !!ae && (ae.tagName === 'INPUT' || (ae.closest && !!ae.closest('.preview')));
      if (!editingElsewhere) active.term.focus();
    });

    // ─── file management: rename + create (traditional-IDE style) ─────
    // Enter / F2 on the focused row renames inline; right-click for new file /
    // new folder / rename. All paths round-trip through the server (/rename,
    // /create); the tree reloads but keeps its expanded folders.
    function startRename(row) {
      const node = row && row.__node;
      if (!node || row.querySelector('input')) return;
      const nm = row.querySelector('.nm');
      if (!nm) return;
      const orig = node.name;
      const input = document.createElement('input');
      input.className = 'renamebox';
      input.value = orig;
      nm.replaceWith(input);
      input.focus();
      // select the basename, leave the extension unselected (files only)
      const dot = orig.lastIndexOf('.');
      if (!node.dir && dot > 0) input.setSelectionRange(0, dot); else input.select();
      let done = false;
      const restore = (label) => {
        if (done) return; done = true;
        const span = document.createElement('span');
        span.className = 'nm'; span.textContent = label;
        input.replaceWith(span);
      };
      const commit = () => {
        const name = input.value.trim();
        if (done) return;
        if (!name || name === orig) { restore(orig); return; }
        ipc.renamePath(node.path, name)
          .then((d) => {
            node.name = d.name; node.path = d.path;
            restore(d.name);
            row.title = d.name;
            const ic = row.querySelector('.ic');           // extension may have changed
            if (ic && !node.dir) { ic.className = 'ic ' + fileTint(d.name); ic.innerHTML = icon(fileIcon(d.name), 15); }
          })
          .catch((e) => { status.textContent = ipc.errorMessage(e, 'rename failed'); restore(orig); });
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); restore(orig); }
      });
      input.addEventListener('blur', () => restore(orig));
    }

    // Quick-capture ("jot down"): a blank markdown note in inbox/ under a
    // timestamp, opened focused so you're typing immediately — no naming, no
    // folder-picker. The agent's "Tend inbox" verb files these later. A blank
    // .md already lands in the source editor with the caret in it (see the
    // empty-file branch in loadTabContent + the holdFocus focus in setView), so
    // this is just the tree's create → reveal → open chain with a fixed target.
    let capturing = false;   // guard a double ⌘⇧N from racing two files into one second
    function captureBase(): string {
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    }
    async function capture() {
      if (!projectPath) { status.textContent = 'Open a project folder first'; return; }
      if (capturing) return;
      capturing = true;
      try {
        const inboxDir = projectPath + '/inbox';
        // inbox/ is made lazily; createPath is create-only, so a rejection here
        // is almost always "already exists" — swallow it and let the file create
        // below surface any genuine failure.
        await ipc.createPath(projectPath, 'inbox', 'folder').catch(() => {});
        const base = captureBase();
        let created: { path: string; name: string; kind: string } | null = null;
        // Same-second collision (two deliberate captures) → -2, -3, … suffix.
        for (let i = 0; i < 5 && !created; i++) {
          const name = (i === 0 ? base : `${base}-${i + 1}`) + '.md';
          try { created = await ipc.createPath(inboxDir, name, 'file'); }
          catch (e) { if (i === 4) throw e; }
        }
        pendingOpen.add(inboxDir);                 // reveal the new note in the tree
        await loadTree(projectPath);
        openFile(created!.path, created!.name, null);   // focused (no keepFocus) → caret in the editor
      } catch (e) {
        status.textContent = ipc.errorMessage(e, 'capture failed');
      } finally {
        capturing = false;
      }
    }

    function startCreate(targetDir, kind, anchorRow) {
      const inputRow = document.createElement('div');
      inputRow.className = 'row file creating';
      inputRow.innerHTML = `<span class="tw"></span><span class="ic">${icon(kind === 'folder' ? 'folder' : 'file', 15)}</span>`;
      const input = document.createElement('input');
      input.className = 'renamebox';
      input.placeholder = kind === 'folder' ? 'new-folder' : 'new-file.md';
      inputRow.appendChild(input);
      // place the input: inside a folder row's children, after a file row, else at root
      let placed = false;
      if (anchorRow && anchorRow.__node) {
        const n = anchorRow.__node;
        if (n.dir) {
          const wrap = anchorRow.parentElement;          // .dirwrap
          const kids = wrap.querySelector(':scope > .children');
          if (kids) { wrap.classList.add('open'); kids.insertBefore(inputRow, kids.firstChild); placed = true; }
        } else { anchorRow.after(inputRow); placed = true; }
      }
      if (!placed) {  // root level: drop in just under the root label row
        const rootLine = treeEl.querySelector(':scope > .root');
        treeEl.insertBefore(inputRow, rootLine ? rootLine.nextSibling : treeEl.firstChild);
      }
      input.focus();
      let done = false;
      const cleanup = () => { if (!done) { done = true; inputRow.remove(); } };
      const commit = () => {
        const name = input.value.trim();
        if (done) return;
        if (!name) { cleanup(); return; }
        ipc.createPath(targetDir, name, kind)
          .then((d) => {
            done = true; inputRow.remove();
            pendingOpen.add(targetDir);                    // reveal the new item
            loadTree(projectPath).then(() => { if (kind === 'file') openFile(d.path, d.name, null); });
          })
          .catch((e) => { status.textContent = ipc.errorMessage(e, 'create failed'); cleanup(); });
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); cleanup(); }
      });
      input.addEventListener('blur', cleanup);
    }

    // Enter / F2 rename the focused row (ignored while typing in the rename box).
    // ⌘/Ctrl+C copies the row's absolute path (⇧ adds relative-to-root), and
    // Delete trashes it — keyboard parallels to the right-click menu so the
    // common file-location actions don't need a right-click to reach.
    treeEl.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      if ((e.key === 'Enter' || e.key === 'F2') && selRow) { e.preventDefault(); startRename(selRow); return; }
      // ↑/↓ walk the visible rows; ⇧ extends the run from the anchor instead of
      // moving alone, so ⇧↓↓ picks three the way ⇧-click picks a range.
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const rows = visibleTreeRows();
        if (!rows.length) return;
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        const at = selRow ? rows.indexOf(selRow) : -1;
        const next = at < 0
          ? rows[step > 0 ? 0 : rows.length - 1]
          : rows[Math.max(0, Math.min(rows.length - 1, at + step))];
        if (e.shiftKey) extendTreeSel(next); else selectTreeRow(next);
        next.scrollIntoView({ block: 'nearest' });
        return;
      }
      // →/← open and close the focused folder; ← on a file (or a closed folder)
      // steps out to the parent, which is how you climb back up a deep tree.
      if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && selRow) {
        e.preventDefault();
        const wrap = selRow.classList.contains('dir') ? selRow.parentElement : null;
        if (wrap && (e.key === 'ArrowRight') !== wrap.classList.contains('open')) { selRow.click(); return; }
        if (e.key === 'ArrowLeft') {
          const kids = selRow.closest('.children');
          const parent = kids && kids.parentElement && kids.parentElement.querySelector(':scope > .row');
          if (parent) { selectTreeRow(parent); (parent as HTMLElement).scrollIntoView({ block: 'nearest' }); }
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {
        const rows = visibleTreeRows();
        if (!rows.length) return;
        e.preventDefault();
        markTreeSel(new Set(rows), selRow && rows.includes(selRow) ? selRow : rows[0]);
        return;
      }
      const nodes = selectedNodes();
      if (!nodes.length) return;
      if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        // a multi-selection copies one path per line — paste-ready for a prompt
        // or a shell.
        const text = nodes.map((n) => (e.shiftKey ? relToRoot(n.path) : n.path)).join('\n');
        try { navigator.clipboard?.writeText(text); } catch {}
        if (status) {
          const many = nodes.length > 1;
          const msg = `Copied ${many ? nodes.length + ' ' : ''}${e.shiftKey ? 'relative ' : ''}path${many ? 's' : ''}`;
          status.textContent = msg;
          setTimeout(() => { if (status && status.textContent === msg) status.textContent = ''; }, 2500);
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteNodes(nodes);
      }
    });

    // ─── tree menus (styled like the tab-group menu, #gmenu) ──────────
    // One generic popup used by both the + button and the right-click menu.
    // items: {label, fn, danger?} or {sep:true}. Closes on outside mousedown/Esc.
    let menuEl = null;
    function closeMenu() {
      if (menuEl) { menuEl.remove(); menuEl = null; }
      document.removeEventListener('mousedown', onDocDownMenu, true);
      scheduleLiveSync();   // menu gone — a live board may re-show
    }
    function onDocDownMenu(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
    function openMenu(x, y, items) {
      closeMenu(); closeGroupMenu();
      const m = document.createElement('div');
      m.className = 'spikemenu';
      for (const it of items) {
        if (it.sep) { const d = document.createElement('div'); d.className = 'sep'; m.appendChild(d); continue; }
        const el = document.createElement('div');
        el.className = 'item' + (it.danger ? ' danger' : '');
        el.textContent = it.label;
        el.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); it.fn(); });
        m.appendChild(el);
      }
      topLayer.appendChild(m);   // above #termlayer, so the menu isn't occluded
      const r = m.getBoundingClientRect();
      m.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 6)) + 'px';
      m.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 6)) + 'px';
      menuEl = m;
      scheduleLiveSync();   // menu lives above the webview — hide the board under it
      setTimeout(() => document.addEventListener('mousedown', onDocDownMenu, true), 0);
    }
    // the + button: a two-item create menu anchored under the clicked +.
    function openCreateMenu(dir, anchorRow, atEl) {
      const r = atEl.getBoundingClientRect();
      openMenu(r.left, r.bottom + 3, [
        { label: 'New File', fn: () => startCreate(dir, 'file', anchorRow) },
        { label: 'New Folder', fn: () => startCreate(dir, 'folder', anchorRow) },
        // Divider sets the agent action apart from the file/folder creators —
        // it's a different kind of thing (spawns a terminal, not a tree entry).
        { sep: true },
        // Spawn an agent rooted at this folder — same launcher as the strip +,
        // but pinned to `dir` and hung under this row's + (naming harmony with
        // the two create actions above).
        { label: 'New Session', fn: () => beginNewSession({ cwd: dir, anchor: atEl }) },
      ]);
    }
    // collapse every expanded folder and forget the open set (stays collapsed).
    function collapseAllFolders() {
      treeEl.querySelectorAll('.dirwrap.open').forEach((w) => {
        w.classList.remove('open');
        const ic = w.querySelector(':scope > .row .ic');
        if (ic) ic.innerHTML = icon('folder', 15);
      });
      openDirs.clear();
    }
    // move a file/folder to the Trash (server uses Finder, reversible). Confirms.
    // Trash one entry or a whole selection behind a single confirm. Each path
    // settles on its own — one failure doesn't strand the rest — and the tree
    // reloads either way so it can't disagree with the disk.
    function deleteNodes(nodes: any[]) {
      const list = (nodes || []).filter(Boolean);
      if (!list.length) return;
      const what = list.length === 1
        ? `${list[0].dir ? 'folder' : 'file'} "${list[0].name}"`
        : `${list.length} items`;
      if (!confirm(`Move ${what} to the Trash?`)) return;
      let failed: any = null;
      Promise.all(list.map((n) => ipc.trashPath(n.path).then(
        () => {
          // any pane showing the doc drops its tab; a pane whose last tab it
          // was goes with it (dispose mutates the registry — iterate a copy).
          for (const pv of [...previews.values()]) pv.dropPath(n.path);
          if (lastFilePath === n.path) {
            lastFilePath = null; lastFileName = null;  // nothing to reopen
            paintPreviewToggle();
          }
        },
        (e) => { failed = failed || e; },
      ))).then(() => {
        if (failed) status.textContent = ipc.errorMessage(failed, 'delete failed');
        loadTree(projectPath);
      });
    }
    // right-click anywhere in the tree → New File/Folder, Rename, Delete, Collapse all.
    treeEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!projectPath) return;
      const row = e.target.closest('.row');
      const node = row && row.__node;
      // Right-clicking inside the selection acts on all of it; right-clicking
      // outside collapses the selection onto that row first, so the menu never
      // describes rows the user can't see it pointing at.
      if (row && node && !selRows.has(row)) selectTreeRow(row);
      const nodes = row && node ? selectedNodes() : [];
      const many = nodes.length > 1;
      const targetDir = node ? (node.dir ? node.path : node.path.slice(0, node.path.lastIndexOf('/'))) : projectPath;
      // A collapsed tree has no file rows on screen, so the file actions have
      // nothing to act on — offering "New File" over a blank sidebar is the menu
      // describing a surface that isn't there. Expanding is the only file-shaped
      // move left; the sidebar actions below still apply.
      const items: any[] = treeCollapsed && !row
        ? [{ label: 'Expand file tree', fn: () => setTreeCollapsed(false) }]
        : [
          { label: 'New File', fn: () => startCreate(targetDir, 'file', row) },
          { label: 'New Folder', fn: () => startCreate(targetDir, 'folder', row) },
        ];
      if (row && node) {
        // File-location actions, mirroring the preview tab menu so a tree row
        // reaches them without opening the file first. Paths are absolute; the
        // relative variant is relative to the project root. With several rows
        // picked, every one of these acts on the whole selection — one path per
        // line for the copies, one Trash confirm for the delete.
        const copy = (s: string) => { try { navigator.clipboard?.writeText(s); } catch {} };
        const fail = (err: unknown, what: string) => { if (status) status.textContent = ipc.errorMessage(err, what); };
        const paths = nodes.map((n) => n.path);
        items.push(
          { label: many ? `Copy ${nodes.length} paths` : 'Copy path', fn: () => copy(paths.join('\n')) },
          { label: many ? `Copy ${nodes.length} relative paths` : 'Copy relative path', fn: () => copy(paths.map(relToRoot).join('\n')) },
          { label: 'Reveal in Finder', fn: () => { for (const p of paths) ipc.revealPath(p).catch((err) => fail(err, 'reveal failed')); } },
        );
        // The share sheet is one-file-at-a-time (and file-oriented) — offer it
        // only when the selection is exactly one file.
        if (nodes.length === 1 && !node.dir) items.push(
          { label: 'Share…', fn: () => ipc.shareFile(node.path, e.clientX, e.clientY).catch((err) => fail(err, 'share failed')) },
        );
        items.push({ sep: true });
        if (!many) items.push(   // renaming is a one-row edit; nothing to type into for a run of rows
          { label: 'Rename', fn: () => { selectTreeRow(row); startRename(row); } },
        );
        items.push(
          { label: many ? `Delete ${nodes.length} items` : 'Delete', fn: () => deleteNodes(nodes), danger: true },
        );
      }
      items.push(
        { sep: true },
      );
      // File-view prefs only make sense when there are files in view.
      if (!(treeCollapsed && !row)) items.push(
        { label: showDotfiles ? 'Hide dotfiles' : 'Show dotfiles', fn: () => { showDotfiles = !showDotfiles; loadTree(projectPath); } },
        { label: 'Collapse all', fn: collapseAllFolders },
      );
      items.push(...sidebarMenuItems());
      openMenu(e.clientX, e.clientY, items);
    });

    // ─── boot ─────────────────────────────────────────────────────────
    // Boot sequence:
    //   1. hydrate groups + load config (needed before any tab spawn so the
    //      composed system prompt picks up workspace + spawn-prompt defaults)
    //   2. resolve first-run engine choice:
    //      - flag already set → proceed
    //      - 0 or 1 engine installed → silently set default, proceed
    //      - both installed → return 'force-welcome' so welcome surface owns
    //        the choice (chip picker rendered inline)
    //   3. open last project (default-engine session spawns), or show welcome
    hydrateGroups();
    loadConfig()
      .then(() => resolveFirstRunEngine())
      .then((mode) => ipc.getLastRoot().then((p) => ({ mode, p })))
      .then(({ mode, p }) => {
        // Force welcome on first-run with both engines so the user picks
        // before any tab spawns. The chosen engine + flag persist on
        // "Choose folder" via commitPendingFirstRunEngine.
        if (mode === 'force-welcome') showWelcome();
        // Land on the Home screen as the login surface even when a last project
        // exists — Home's doors continue into it (bootLastRoot). Previously boot
        // dove straight into the last project, skipping Home entirely.
        else if (p) { bootLastRoot = p; showWelcome(); }
        else showWelcome();
      })
      .catch(showWelcome);

    // Silent update check, once per launch, off the boot critical path. It only
    // ever writes the #status line — if it finds nothing, or can't reach the
    // endpoint, the user never learns it ran. Delayed so it can't contend with
    // the first paint or the initial session spawn.
    setTimeout(() => {
      ipc.checkForUpdate()
        .then((u) => {
          if (!u) return;
          pendingUpdate = u;
          reflectPendingUpdate();
          updateStatus(`Spike ${u.version} available — ⌘K to install`, 12000);
        })
        .catch(() => {});   // offline is not news
    }, 4000);

    // paint the static chrome icons (bar caret, preview header controls).
    (function paintStaticIcons() {
      const car = projectBtn.querySelector('.car');
      if (car) car.innerHTML = icon('chevron-down', 11);
      // (preview header icons are painted per instance in makePreview)
      const tTree = document.getElementById('toggleTree');
      const tTerm = document.getElementById('toggleTerm');
      const tPrev = document.getElementById('togglePreview');
      if (tTree) tTree.innerHTML = icon('list-tree', 16);
      if (tTerm) tTerm.innerHTML = icon('terminal', 16);
      if (tPrev) tPrev.innerHTML = icon('file-text', 16);
      const tWeb = document.getElementById('toggleWeb');
      if (tWeb) tWeb.innerHTML = icon('globe', 16);
      if (footerSettingsBtn) footerSettingsBtn.innerHTML = icon('settings', 16);
      paintDockBtn();   // the move-panel control in the preview header
    })();

    // ─── worktree close prompts ────────────────────────────────────────
    // A finished auto-worktree that can't settle itself (merge conflict,
    // uncommitted changes, or the "always ask" policy) emits worktree:ask
    // from the engine. One dialog at a time; concurrent closes queue. Esc
    // dismisses without acting — branch + worktree stay on disk untouched.
    const wtAskQueue: any[] = [];
    let wtAskEl: HTMLElement | null = null;
    function showNextWorktreeAsk() {
      if (wtAskEl || !wtAskQueue.length) return;
      const ask = wtAskQueue.shift();
      const ov = document.createElement('div');
      ov.id = 'wtask';
      const panel = document.createElement('div');
      panel.className = 'panel';
      const t = document.createElement('div');
      t.className = 't';
      t.textContent = 'Worktree finished — keep its changes?';
      const why = document.createElement('div');
      why.className = 'why';
      why.textContent = ask.reason || '';
      const meta = document.createElement('div');
      meta.className = 'meta';
      const bBranch = document.createElement('b'); bBranch.textContent = ask.branch;
      const bBase = document.createElement('b'); bBase.textContent = ask.base;
      meta.append('branch ', bBranch, ' → base ', bBase, document.createElement('br'), ask.path);
      const out = document.createElement('div');
      out.className = 'out';
      const row = document.createElement('div');
      row.className = 'row';
      const dismiss = () => {
        document.removeEventListener('keydown', onEsc, true);
        ov.remove();
        wtAskEl = null;
        showNextWorktreeAsk();
      };
      const onEsc = (e: KeyboardEvent) => {
        if (e.key !== 'Escape') return;
        e.preventDefault(); e.stopPropagation();
        dismiss();
      };
      const btn = (label: string, choice: 'merge' | 'keep' | 'discard', cls?: string) => {
        const b = document.createElement('button');
        if (cls) b.className = cls;
        b.textContent = label;
        b.addEventListener('click', () => {
          row.querySelectorAll('button').forEach((x: any) => { x.disabled = true; });
          out.textContent = '';
          ipc.worktreeResolve(ask, choice).then((msg) => {
            dismiss();
            if (status) status.textContent = msg || '';
            setTimeout(() => { if (status && status.textContent === msg) status.textContent = ''; }, 6000);
          }).catch((err) => {
            // failed (e.g. the merge still conflicts): keep the dialog, offer
            // the other choices — failure paths never touch the branch.
            out.textContent = ipc.errorMessage(err, choice + ' failed');
            row.querySelectorAll('button').forEach((x: any) => { x.disabled = false; });
          });
        });
        return b;
      };
      row.append(
        btn('Discard', 'discard', 'danger'),
        btn('Keep branch', 'keep'),
        btn(`Merge into ${ask.base}`, 'merge', 'primary'),
      );
      panel.append(t, why, meta, row, out);
      ov.appendChild(panel);
      document.body.appendChild(ov);
      document.addEventListener('keydown', onEsc, true);
      wtAskEl = ov;
    }
    ipc.onWorktreeAsk((ask) => { wtAskQueue.push(ask); showNextWorktreeAsk(); }).catch(() => {});

    // ─── learn-the-voice ───────────────────────────────────────────────
    // The user edits agent-written markdown; Spike records the before/after and,
    // once enough edits accrue, distills the pattern into DO/DON'T voice
    // directives (headless LLM in Rust). Accepted directives ride the workspace's
    // group-md into every future spawn. See docs/mocks/learn-the-voice.html.
    const VOICE_THRESHOLD = 3;             // unanalyzed edits before we propose
    let voiceAskEl: HTMLElement | null = null;
    let voiceBusy = false;                 // one in-flight analysis at a time

    function currentWorkspaceName(): string | null {
      return active ? (active.spawnGroup || groupName(active.groupId)) : null;
    }

    function learnVoiceFromEdit(path: string, before: string, after: string) {
      const slug = currentWorkspaceName();
      if (!slug || before === after) return;
      ipc.recordVoiceEdit(slug, path, before, after).then((pending) => {
        if (pending < VOICE_THRESHOLD || voiceAskEl || voiceBusy) return;
        voiceBusy = true;
        ipc.analyzeVoice(slug).then((cand) => {
          voiceBusy = false;
          const n = (cand?.do?.length || 0) + (cand?.dont?.length || 0);
          if (n) showVoiceProposal(slug, cand);
        }).catch(() => { voiceBusy = false; });
      }).catch(() => {});
    }

    // Merge accepted directives into the workspace's voice and persist (which
    // regenerates <slug>.md so the next spawn obeys them). Dedupes case-insensitively.
    function acceptVoice(slug: string, cand: { do: string[]; dont: string[] }) {
      const g = groups.find((x: any) => x.name === slug);
      if (!g) return;
      g.voice = g.voice || { do: [], dont: [] };
      const merge = (existing: string[], add: string[]) => {
        const seen = new Set(existing.map((s) => s.trim().toLowerCase()));
        for (const it of add || []) {
          const t = (it || '').trim();
          if (t && !seen.has(t.toLowerCase())) { existing.push(t); seen.add(t.toLowerCase()); }
        }
        return existing;
      };
      g.voice.do = merge(g.voice.do || [], cand.do || []);
      g.voice.dont = merge(g.voice.dont || [], cand.dont || []);
      persistGroup(g);
    }

    function dismissVoiceEl() {
      if (voiceAskEl) { voiceAskEl.remove(); voiceAskEl = null; }
    }

    function showVoiceProposal(slug: string, cand: { do: string[]; dont: string[] }) {
      dismissVoiceEl();
      const ov = document.createElement('div');
      ov.id = 'voiceask';
      const tag = document.createElement('div');
      tag.className = 'tag';
      tag.textContent = 'Spike noticed a pattern in your edits';
      const t = document.createElement('div');
      t.className = 't';
      t.textContent = `Add ${(cand.do.length + cand.dont.length) > 1 ? 'these' : 'this'} to ${slug}'s voice?`;
      const items = document.createElement('div');
      items.className = 'items';
      const row2 = (kind: 'do' | 'dont', text: string) => {
        const r = document.createElement('div'); r.className = 'vi';
        const k = document.createElement('span'); k.className = 'k ' + kind;
        k.textContent = kind === 'do' ? 'DO' : "DON'T";
        const s = document.createElement('span'); s.textContent = text;
        r.append(k, s); return r;
      };
      for (const d of cand.do) items.appendChild(row2('do', d));
      for (const d of cand.dont) items.appendChild(row2('dont', d));
      const row = document.createElement('div');
      row.className = 'row';
      const notNow = document.createElement('button');
      notNow.textContent = 'Not now';
      notNow.addEventListener('click', () => {
        ipc.voiceDismiss(slug, [...cand.do, ...cand.dont]).catch(() => {});
        dismissVoiceEl();
      });
      const add = document.createElement('button');
      add.className = 'primary';
      add.textContent = 'Add to Voice';
      add.addEventListener('click', () => {
        acceptVoice(slug, cand);
        dismissVoiceEl();
      });
      row.append(notNow, add);
      ov.append(tag, t, items, row);
      document.body.appendChild(ov);
      voiceAskEl = ov;
      requestAnimationFrame(() => ov.classList.add('show'));
    }

    // ─── template bundles (Stage 0–1: theme + groups) ──────────────────
    // The CLI bridge (`spike export-template` / `import-template`) triggers
    // these; Rust does the file IO via write_bundle/read_bundle and group IO
    // via read_group_steering/install_group. The payload is still fully
    // DECLARATIVE: a theme + workspace groups (name/color/pinned paths/steering
    // and the names of MCP servers a group toggles — never server definitions).
    // Nothing in a bundle executes, so the manifest's executable counts stay 0.
    // the stored preference ('system' when following the OS), so a template
    // uninstall can restore "follow the OS" and not just a pinned mode.
    function currentTheme(): string {
      return themePref();
    }
    function bundleName(dir: string): string {
      return dir.replace(/\/+$/, '').split('/').pop() || 'spike-template';
    }
    async function exportTemplate(dir: string): Promise<{ ok: boolean; name: string; dir: string; groups: number; external: string[]; error?: string }> {
      const theme = currentTheme();
      const name = bundleName(dir);
      const files: Record<string, string> = {};
      files['theme.json'] = JSON.stringify({ mode: theme }, null, 2) + '\n';
      // Groups: each becomes groups/<name>.json plus, only when the user wrote
      // one, groups/<name>.steering.md (the hand-authored tail below the marker,
      // the part save_group can't regenerate). createdAt is dropped (machine
      // time); cwd + pinnedPaths are PARAMETERIZED — every path under the current
      // workspace root becomes ${workspace}/... so the bundle resolves on any
      // machine (install rebases it against the target root). Paths outside the
      // workspace can't be rebased; they're kept absolute and surfaced as
      // `external` so the export isn't silently lossy. mcpEnabled is kept as a
      // list of NAMES the group toggles; it installs nothing, just references
      // servers the target must already have. Surfaced in the manifest too.
      const root = projectPath || '';
      let groups: any[] = [];
      try { groups = await ipc.listGroups(); } catch {}
      const summaries: string[] = [];
      const externalPaths: string[] = [];
      for (const g of groups) {
        if (!g || typeof g.name !== 'string' || !g.name.trim()) continue;
        const { createdAt, id, ...rest } = g;        // drop machine time + client id
        const { group: portable, external } = parameterizeGroup(rest, root);
        if (external.length) externalPaths.push(...external);
        files[`groups/${g.name}.json`] = JSON.stringify(portable, null, 2) + '\n';
        let steering = '';
        try { steering = await ipc.readGroupSteering(g.name); } catch {}
        if (steering.trim()) {
          files[`groups/${g.name}.steering.md`] = steering.endsWith('\n') ? steering : steering + '\n';
        }
        const mcp = Array.isArray(g.mcpEnabled) && g.mcpEnabled.length
          ? ` (mcp: ${g.mcpEnabled.join(', ')})` : '';
        summaries.push(`  # ${g.name}${mcp}`);
      }
      // manifest.yaml — the trust artifact: the install gate reads these counts
      // back and hard-rejects any bundle whose files don't match. The schema is
      // FLAT and must mirror verify_bundle's ManifestCounts exactly (theme,
      // groups, hooks, mcp_servers, skills, permission_grants, spawn_overrides) —
      // serde ignores unknown keys, so a nested/misnamed field silently reads as
      // 0 and rejects the honest bundle it describes. A theme+groups bundle is
      // declarative by construction, so every executable/high-risk count is 0.
      const manifest = [
        `template: "${name}"`,
        `version: "0.1.0"`,
        `author: "annamarie"`,
        `description: >`,
        `  Theme + workspace groups (Stage 1 declarative).`,
        `spike_min_version: "0.2"`,
        ``,
        `contains:`,
        `  theme: 1`,
        `  groups: ${summaries.length}`,
        ...summaries,
        `  hooks: 0`,
        `  mcp_servers: 0`,
        `  skills: 0`,
        `  permission_grants: 0`,
        `  spawn_overrides: 0`,
        ``,
      ].join('\n');
      files['manifest.yaml'] = manifest;
      try {
        await ipc.writeBundle(dir, files);
        console.log(`[template] exported "${name}": theme=${theme}, ${summaries.length} group(s) → ${dir}`);
        if (externalPaths.length) {
          console.warn(`[template] ${externalPaths.length} path(s) outside the workspace root were kept absolute (won't travel): ${externalPaths.join(', ')}`);
        }
        return { ok: true, name, dir, groups: summaries.length, external: externalPaths };
      } catch (e) {
        console.error('[template] export failed', e);
        return { ok: false, name, dir, groups: summaries.length, external: externalPaths, error: ipc.errorMessage(e, 'export failed') };
      }
    }
    // Save the current setup as a reusable template bundle under
    // ~/.spike/templates/<name>/ — the canonical templates home the install
    // picker reads from. Triggered by the palette "Save current setup as
    // template…" command; reuses exportTemplate so the bundle is identical to
    // the one `spike export-template` writes. Result surfaces on the transient
    // #status line (same self-clearing pattern as the drop-import note).
    async function saveSetupAsTemplate(name: string) {
      const seg = (name || '').trim().toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-').replace(/^[.\-]+|[.\-]+$/g, '') || 'spike-template';
      const flash = (msg: string) => {
        if (!status) return;
        status.textContent = msg;
        setTimeout(() => { if (status && status.textContent === msg) status.textContent = ''; }, 6000);
      };
      let base: string;
      try { base = await ipc.templatesDir(); }
      catch (e) { flash(`Couldn't resolve templates folder: ${ipc.errorMessage(e, 'unknown error')}`); return; }
      const r = await exportTemplate(`${base}/${seg}`);
      if (r.ok) {
        const extra = r.external.length ? ` · ${r.external.length} path(s) kept absolute` : '';
        flash(`Saved template "${seg}" — ${r.groups} group${r.groups === 1 ? '' : 's'}${extra}`);
      } else {
        flash(`Save failed: ${r.error || 'unknown error'}`);
      }
    }
    // Import is GATED: verify the bundle, then show the install gate. Nothing
    // applies until the user reviews the disclosure and confirms. An unverified
    // bundle (contents don't match its manifest) is hard-rejected in the gate.
    async function importTemplate(dir: string) {
      let plan: ipc.BundlePlan;
      try { plan = await ipc.verifyBundle(dir); }
      catch (e) { console.error('[template] import: cannot verify bundle', e); return; }
      showGate(dir, plan);
    }

    // Apply the approved tiers of a verified bundle, stamping the provenance
    // ledger (scope-tagged) with every applied item: the declarative tier (theme
    // + groups) page-side, and the executable/high-risk tiers via Rust
    // install_bundle_extras. The ledger is what uninstall later reverses.
    async function applyApprovedTiers(
      dir: string,
      plan: ipc.BundlePlan,
      approved: { declarative: boolean; executable: boolean; high_risk: boolean },
    ): Promise<string> {
      const stamp = `${plan.template}@${plan.version}`;
      const items: any[] = [];
      const notes: string[] = [];

      if (approved.declarative) {
        let files: Record<string, string> = {};
        try { files = await ipc.readBundle(dir); } catch (e) { console.error('[template] read bundle', e); }
        // theme (independent of ${workspace}, so it applies with or without an
        // open project)
        const themeRaw = files['theme.json'];
        if (themeRaw) {
          let mode: unknown;
          try { mode = JSON.parse(themeRaw).mode; } catch {}
          if (mode === 'light' || mode === 'dark') {
            // Restore target = the mode active BEFORE the very first install of
            // this template. On a re-install `currentTheme()` is already the
            // template's mode, so reuse the prior recorded earlier (the ledger
            // entry is replaced, not stacked) instead of capturing it again.
            let prior = currentTheme();
            try {
              const existing = (await ipc.readInstalledTemplates() as any[]).find(
                (e) => e && e.template === plan.template && e.version === plan.version && e.scope === plan.scope);
              const pri = existing?.items?.find((it: any) => it?.type === 'theme')?.prior;
              if (pri === 'light' || pri === 'dark' || pri === 'system') prior = pri;
            } catch {}
            applyTheme(mode);
            items.push({ type: 'theme', mode, prior, _installedBy: stamp });
          }
        }
        // groups pin ${workspace}-relative paths, so they need an open project to
        // resolve against. With none open, resolving would root them at "/" (and
        // set an empty cwd) — skip instead of writing garbage. Resolve must happen
        // pre-plan so a re-imported group's absolute paths match what's on disk
        // and groupmerge skips it rather than installing a " (2)" duplicate.
        const groupKeys = Object.keys(files).filter((k) => k.startsWith('groups/') && k.endsWith('.json'));
        if (groupKeys.length && !projectPath) {
          notes.push(`skipped ${groupKeys.length} group(s) — open a project first (groups pin its paths)`);
        } else if (groupKeys.length) {
          files = resolveBundleGroups(files, projectPath);
          // groups: the skip-if-identical / collision-suffix / install decision is
          // a pure function in groupmerge.ts (unit-tested) — here we just perform
          // the writes it plans. A re-imported unchanged group is skipped (kept
          // yours); a same-name-different-content one gets a " (N)" suffix.
          let existingGroups: any[] = [];
          try { existingGroups = await ipc.listGroups(); } catch {}
          const { installs, skipped } = planGroupInstalls(files, existingGroups);
          const installed: string[] = [];
          for (const { group, steering } of installs) {
            try {
              const written = await ipc.installGroup(group, steering);
              installed.push(written);
              items.push({ type: 'group', name: written, _installedBy: stamp });
              // reflect the new workspace in the live model so it shows in the
              // launcher / group menu without a reload
              if (!groups.some((x: any) => x.name === written)) addGroupToModel({ ...group, name: written });
            } catch (e) { console.error('[template] group install failed', group.name, e); }
          }
          if (installed.length) { renderTabs(); notes.push(`${installed.length} group(s): ${installed.join(', ')}`); }
          if (skipped.length) notes.push(`skipped ${skipped.length} group(s) (kept yours): ${skipped.join(', ')}`);
        }
      }
      // executable + high-risk: apply into the scope-resolved Claude config,
      // merge-never-clobber (Rust install_bundle_extras). Only call when a tier
      // was approved AND has items; only on a verified bundle (the gate already
      // refuses an unverified one). Applied items join the ledger; collisions
      // come back as `skipped` and surface in the result line.
      const wantExec = approved.executable && plan.tiers.executable.length > 0;
      const wantRisk = approved.high_risk && plan.tiers.high_risk.length > 0;
      if (plan.verified && (wantExec || wantRisk)) {
        try {
          const res = await ipc.installBundleExtras(dir, plan.scope, projectPath, wantExec, wantRisk);
          for (const a of res.applied) {
            items.push({ type: a.type, name: a.label, detail: a.detail, scope: a.scope, _installedBy: stamp });
          }
          if (res.applied.length) notes.push(`${res.applied.length} extra(s): ${res.applied.map(a => `${a.type}:${a.label}`).join(', ')}`);
          if (res.skipped.length) notes.push(`skipped ${res.skipped.length} (kept yours): ${res.skipped.map(x => `${x.type}:${x.name}`).join(', ')}`);
          // a per-file write failed — its items are absent from res.applied (so the
          // ledger matches disk); tell the user which category didn't land.
          if (res.errors?.length) notes.push(`couldn't write ${res.errors.map(e => e.stage).join(', ')} (see console)`);
        } catch (e) {
          console.error('[template] extras apply failed', e);
          notes.push('extras apply failed (see console)');
        }
      }

      if (items.length) {
        try {
          await ipc.recordInstalledTemplate({
            template: plan.template, version: plan.version, scope: plan.scope,
            installedAt: new Date().toISOString(), items,
          });
        } catch (e) { console.error('[template] ledger write failed', e); }
      }
      const head = items.length ? `applied ${items.length} item(s)` : 'nothing applied';
      return notes.length ? `${head} — ${notes.join('; ')}` : head;
    }

    // ─── the install gate ───────────────────────────────────────────────
    let gateEl: HTMLElement | null = null;
    function showGate(dir: string, plan: ipc.BundlePlan) {
      if (gateEl) return;                                  // one gate at a time
      const ov = document.createElement('div'); ov.id = 'gate';
      const panel = document.createElement('div'); panel.className = 'panel';

      const t = document.createElement('div'); t.className = 't';
      t.textContent = `Install template: "${plan.template || bundleName(dir)}@${plan.version || '0.0.0'}"`;
      const sub = document.createElement('div'); sub.className = 'sub';
      const scope = document.createElement('span');
      scope.className = 'scope' + (plan.scope === 'global' ? ' global' : '');
      scope.textContent = plan.scope === 'global' ? 'Installs to: GLOBAL ~/.claude' : 'Installs to: this project';
      sub.append(plan.author ? `by ${plan.author}  ·  ` : '', scope);
      panel.append(t, sub);

      const dismiss = () => { document.removeEventListener('keydown', onEsc, true); ov.remove(); gateEl = null; };
      const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismiss(); } };
      const out = document.createElement('div'); out.className = 'out';
      const row = document.createElement('div'); row.className = 'row';
      const cancel = document.createElement('button'); cancel.textContent = 'Cancel';
      cancel.addEventListener('click', dismiss);

      // Hard reject: a bundle whose contents don't match its manifest never
      // reaches the consent UI — show why and offer only Cancel.
      if (!plan.verified) {
        const rej = document.createElement('div'); rej.className = 'reject';
        rej.textContent = 'REJECTED — bundle contents do not match its manifest:\n• '
          + (plan.violations || []).join('\n• ');
        // Disclose the executable/high-risk items the bundle smuggled past its
        // manifest — the whole point of the reject is to show WHAT it would have
        // run (e.g. a hook command), not just that a count was off.
        const smuggled = [...(plan.tiers?.executable || []), ...(plan.tiers?.high_risk || [])];
        if (smuggled.length) {
          rej.textContent += '\n\nUndeclared items it would have run:';
          for (const it of smuggled) {
            rej.textContent += `\n• ${it.kind}: ${it.label}` + (it.detail ? ` → ${it.detail}` : '');
          }
        }
        row.append(cancel);
        panel.append(rej, row);
        ov.appendChild(panel); document.body.appendChild(ov);
        document.addEventListener('keydown', onEsc, true); gateEl = ov;
        return;
      }

      // Risk-tiered consent. declarative pre-checked; executable + high-risk
      // selectable but OFF by default — the user opts each one in deliberately,
      // and their exact contents are always disclosed.
      const toggles: Record<string, HTMLInputElement | null> = { declarative: null, executable: null, high_risk: null };
      const tier = (key: 'declarative' | 'executable' | 'high_risk', title: string, risk: boolean, enabled: boolean) => {
        const list = plan.tiers[key] || [];
        if (!list.length) return;
        const sec = document.createElement('div'); sec.className = 'tier' + (risk ? ' risk' : '');
        const header = document.createElement('header');
        const cb = document.createElement('input'); cb.type = 'checkbox';
        cb.checked = key === 'declarative'; cb.disabled = !enabled;
        toggles[key] = cb;
        const cap = document.createElement('span');
        cap.textContent = `${title} · ${list.length}`;
        header.append(cb, cap);
        header.addEventListener('click', (e) => { if (e.target !== cb && enabled) { cb.checked = !cb.checked; } });
        sec.append(header);
        if (!enabled) {
          const note = document.createElement('div'); note.className = 'note';
          note.textContent = 'disclosure only — apply lands in the next build';
          sec.append(note);
        }
        const items = document.createElement('div'); items.className = 'items';
        for (const it of list) {
          const el = document.createElement('div'); el.className = 'item';
          const lbl = document.createElement('div'); lbl.className = 'lbl';
          lbl.textContent = `${it.kind}: ${it.label}`;
          el.append(lbl);
          if (it.detail) { const d = document.createElement('div'); d.className = 'det'; d.textContent = it.detail; el.append(d); }
          items.append(el);
        }
        sec.append(items);
        panel.append(sec);
      };
      tier('declarative', 'Declarative (safe)', false, true);
      tier('executable', 'Executable (review)', false, true);
      tier('high_risk', 'High risk (off by default)', true, true);

      const install = document.createElement('button'); install.className = 'primary'; install.textContent = 'Install checked';
      const anyEnabled = !!(toggles.declarative || toggles.executable || toggles.high_risk);
      install.disabled = !anyEnabled;
      install.addEventListener('click', () => {
        row.querySelectorAll('button').forEach((b: any) => { b.disabled = true; });
        out.style.color = ''; out.textContent = 'installing…';
        applyApprovedTiers(dir, plan, {
          declarative: !!toggles.declarative?.checked,
          executable: !!toggles.executable?.checked,
          high_risk: !!toggles.high_risk?.checked,
        }).then((msg) => {
          dismiss();
          if (status) {
            status.textContent = `Installed "${plan.template}@${plan.version}" — ${msg}.`;
            const m = status.textContent;
            setTimeout(() => { if (status && status.textContent === m) status.textContent = ''; }, 8000);
          }
        }).catch((e) => {
          out.textContent = ipc.errorMessage(e, 'install failed');
          row.querySelectorAll('button').forEach((b: any) => { b.disabled = false; });
        });
      });
      row.append(cancel, install);
      panel.append(row, out);
      ov.appendChild(panel); document.body.appendChild(ov);
      document.addEventListener('keydown', onEsc, true); gateEl = ov;
    }

    // ─── uninstall: reverse a recorded install ──────────────────────────
    // The inverse of applyApprovedTiers, driven by the same provenance ledger.
    // Groups are removed from the live model (ungroupWorkspace — refreshes the
    // launcher/menu immediately), theme restored to the mode recorded at install,
    // and the executable/high-risk items reversed in Rust (uninstall_bundle_extras
    // — removes only what we added).
    // Reverts one ledger entry's install and returns a human summary. It does NOT
    // persist the trimmed ledger — the caller owns that, so several uninstalls in
    // one modal session compose against a single live ledger instead of each
    // re-trimming a stale snapshot (which resurrected already-removed entries).
    async function uninstallTemplate(entry: any): Promise<string> {
      if (!entry) return 'nothing to uninstall';
      const { groups: gnames, theme, extras } = categorizeItems(entry.items);
      const notes: string[] = [];
      const gone: string[] = [];
      for (const name of gnames) {
        try {
          const g = groups.find((x: any) => x.name === name);
          // ungroupWorkspace detaches members, splices the model, deletes the
          // disk file, and re-renders — so the launcher/menu update immediately.
          // A group not in the live model (never hydrated) just gets its file gone.
          if (g) ungroupWorkspace(g);
          else await ipc.deleteGroup(name);
          gone.push(name);
        } catch (e) { console.error('[uninstall] delete group', name, e); }
      }
      if (gone.length) notes.push(`${gone.length} group(s): ${gone.join(', ')}`);
      if (theme && (theme.prior === 'light' || theme.prior === 'dark' || theme.prior === 'system')) {
        applyTheme(theme.prior); notes.push(`theme → ${theme.prior}`);
      } else if (theme) {
        notes.push('theme left as-is (no prior recorded)');
      }
      if (extras.length) {
        try {
          const res = await ipc.uninstallBundleExtras(
            extras, entry.scope === 'global' ? 'global' : 'project', projectPath);
          if (res.removed.length) notes.push(`removed ${res.removed.length}: ${res.removed.join(', ')}`);
          if (res.missing.length) notes.push(`${res.missing.length} already gone/changed: ${res.missing.join(', ')}`);
        } catch (e) {
          console.error('[uninstall] extras revert failed', e);
          notes.push('extras revert failed (see console)');
        }
      }
      return notes.length ? notes.join('; ') : 'nothing to revert';
    }

    // Picker: list ledger entries, each with a two-click Uninstall button (arm →
    // confirm, since deleting groups is destructive). Reuses the gate overlay.
    let uninstallEl: HTMLElement | null = null;
    async function showUninstall() {
      if (uninstallEl || gateEl) return;                   // one modal at a time
      let ledger: any[] = [];
      try { ledger = await ipc.readInstalledTemplates(); } catch {}
      const ov = document.createElement('div'); ov.id = 'gate';
      const panel = document.createElement('div'); panel.className = 'panel'; panel.style.width = '440px';
      const t = document.createElement('div'); t.className = 't'; t.textContent = 'Installed templates';
      panel.append(t);
      const dismiss = () => { document.removeEventListener('keydown', onEsc, true); ov.remove(); uninstallEl = null; };
      const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismiss(); } };
      const out = document.createElement('div'); out.className = 'out';
      // Close is tracked so a revert can never leave it disabled (the modal must
      // always be dismissable). Esc also dismisses.
      const close = document.createElement('button'); close.textContent = 'Close';
      close.addEventListener('click', dismiss);
      const uninBtns: HTMLButtonElement[] = [];   // every row's Uninstall button
      if (!ledger.length) {
        const sub = document.createElement('div'); sub.className = 'sub'; sub.textContent = 'Nothing installed.';
        panel.append(sub);
      } else {
        ledger.forEach((entry, i) => {
          const r = document.createElement('div'); r.className = 'row';
          const lbl = document.createElement('span'); lbl.style.flex = '1'; lbl.textContent = entryLabel(entry);
          const btn = document.createElement('button'); btn.textContent = 'Uninstall';
          uninBtns.push(btn);
          let armed = false;
          btn.addEventListener('click', async () => {
            if (!armed) { armed = true; btn.textContent = 'Confirm?'; return; }
            // lock the modal during the async revert, then hand control back so
            // the OTHER rows + Close stay usable (only the done row is retired).
            uninBtns.forEach((b) => { b.disabled = true; }); close.disabled = true;
            out.style.color = ''; out.textContent = 'uninstalling…';
            const summary = await uninstallTemplate(entry);
            // Persist against the live ledger by this entry's CURRENT position
            // (rows hold the entry by reference, so indexOf tracks earlier
            // removals) — never a positional index into the original snapshot.
            const at = ledger.indexOf(entry);
            if (at >= 0) {
              ledger = removeLedgerEntry(ledger, at);
              try { await ipc.setInstalledTemplates(ledger); }
              catch (e) { console.error('[uninstall] ledger write failed', e); }
            }
            out.textContent = `Uninstalled "${entry.template}@${entry.version}" — ${summary}`;
            r.style.opacity = '0.45'; btn.textContent = 'Removed'; btn.dataset.removed = '1';
            // hand control back: re-enable the rows NOT yet removed (a removed
            // row's button stays disabled so it can't double-revert), and Close.
            uninBtns.forEach((b) => { if (b.dataset.removed !== '1') b.disabled = false; });
            close.disabled = false;
          });
          r.append(lbl, btn);
          panel.append(r);
        });
      }
      // Footer: result line on the left, Close on the right, on one divided row —
      // so Close reads as a deliberate action, not an orphan floating far right.
      const foot = document.createElement('div'); foot.className = 'row';
      foot.style.justifyContent = 'space-between'; foot.style.alignItems = 'center';
      foot.style.borderTop = '1px solid var(--edge-soft)';
      foot.style.marginTop = '12px'; foot.style.paddingTop = '12px';
      out.style.flex = '1'; out.style.margin = '0'; out.style.textAlign = 'left';
      foot.append(out, close);
      panel.append(foot);
      ov.appendChild(panel); document.body.appendChild(ov);
      document.addEventListener('keydown', onEsc, true); uninstallEl = ov;
    }

    // ─── control channel ───────────────────────────────────────────────
    // `spike open <path>` in the terminal pushes here (via the CLI listener's
    // Tauri `open` event) so files open in Spike's preview instead of launching
    // Cursor/the browser. Folders re-root.
    (function wireControlChannel() {
      ipc.onOpen((m) => {
        // Attribute the open to the lane that fired it. Trust the forwarded id:
        // `spike open` only carries it from a real Spike pty ($SPIKE_SESSION_ID),
        // so attribute by id even if the Session hasn't registered yet (spawn
        // race) — the color resolves once it does. A truly absent id means the
        // open came from outside Spike → user-owned.
        const owner = m.sessionId || undefined;
        if (m.kind === 'open' && m.path) {
          const name = m.path.split('/').pop();
          // When the Home surface owns the screen, the shell preview openFile
          // targets is occluded behind #home (z-index 10) — the file would seem
          // to vanish (only the preview's floating expand pill peeks through). So
          // route to the Home preview column instead, the same surface a file tap
          // in chat opens — openHomeDoc also renders a .spiketable as the
          // interactive grid (readFile would treat it as binary). Fall back to the
          // shell preview when Home is down.
          if (homeEl && homeEl.style.display !== 'none' && homeOpenDoc) homeOpenDoc(m.path, name);
          else openFile(m.path, name, null, { reload: true, owner });
        }
        else if (m.kind === 'project' && m.path) openProject(m.path);
        else if (m.kind === 'url' && m.path) openUrl(m.path, owner);
      }).catch(() => {});
      // `spike export-template <dir>` / `spike import-template <dir>`: Stage 0
      // declarative bundles. v1 payload is themes-only — it proves the whole
      // pipe (read state → bundle → apply → provenance ledger) with a payload
      // that can't harm anything. Rust does the file IO; the page owns what
      // goes in the bundle and how to apply it on the way back.
      ipc.onTemplateExport((dir) => { exportTemplate(dir); }).catch(() => {});
      ipc.onTemplateImport((dir) => { importTemplate(dir); }).catch(() => {});
      // `spike spawn "<task>"`: an orchestrator agent asking Spike to spawn a
      // scoped subagent. The source lane (the one that ran the command, via
      // $SPIKE_SESSION_ID) becomes the parent; fall back to the focused agent
      // lane if the id didn't resolve. No source at all → nothing to nest under,
      // so drop it rather than spawn an orphan. spawnSubagent owns the rest.
      ipc.onSpawn((m) => {
        const task = (m.task || '').trim();
        if (!task) return;   // guard empty/whitespace (the Rust side rejects too)
        let source = m.sessionId ? sessionByPty(m.sessionId) : null;
        if (!source && isAgentLane(active)) source = active;
        if (source) spawnSubagent(source, task);
      }).catch(() => {});
      // The filesystem watcher fires this when the tree changed on disk outside
      // the UI. Re-read it; loadTree keeps open folders as-is. If the open doc
      // was among the changed paths, live-reload it too.
      ipc.onTreeChanged((changed) => {
        // Mark each changed path edited (accent dot). Non-files the watcher may
        // report (dirs, dotfile internals) get dropped by pruneRecentTouched
        // once loadTree rebuilds allPaths below.
        if (Array.isArray(changed)) for (const p of changed) noteTouched(p, 'edited');
        if (projectPath) loadTree(projectPath);
        reloadOpenDoc(changed);
      }).catch(() => {});
      // Agent broker → live preview. When an adapter (Claude hook, future
      // Codex sidecar) reports a file.write, refresh any preview pane showing
      // that path. This is the first user-visible consumer of the broker.
      // The fs watcher would already reload these on its next debounce tick,
      // but the broker arrives synchronously with the agent's action — the
      // preview updates as the edit lands, not after the watcher coalesces.
      // No snapshot replay: the preview pane only cares about future writes
      // (historical file.write events are uninteresting once the file is
      // already on disk, which it is by definition).
      // Throttle for the dock bounce — a multi-batch agent can fire many
      // turn.ended events in quick succession; macOS Informational bounces
      // are one-shot per call, so without this every batch end re-bounces.
      let lastDockBounceAt = 0;
      ipc.onAgentEvent((ev) => {
        // Every event carries both ids: session_id (the Spike tab's ptyId) and
        // run_id (the Claude/Codex transcript filename stem). Latch run_id onto
        // the owning session the first time we see it — it's the key the context
        // ring reads occupancy from, and it's stable for the life of the run.
        // A Claude lane already set this at spawn and the values agree; the
        // latch still matters for Codex (no id until now) and as the correction
        // if the engine ever ends up on an id other than the one we asked for.
        if (ev.run_id && ev.session_id) {
          const owner = sessionByPty(ev.session_id);
          if (owner && owner.runId !== ev.run_id) {
            owner.runId = ev.run_id;
            refreshSessionContext(owner);   // first sighting → paint the ring now
          }
        }
        // Chat view: the broker is the only source that can tell a finished
        // turn apart from one blocked on a permission prompt. Both engines
        // emit tool.start / turn.ended, so this works for Claude and Codex.
        if (ev.kind === 'tool.start' || ev.kind === 'tool.end' || ev.kind === 'turn.ended' || ev.kind === 'question.asked') {
          const owner = sessionByPty(ev.session_id);
          if (owner) owner.chatBrokerEvent(ev.kind, ev.data && ev.data.tool, ev.data);
        }
        // Notification hook: a turn blocked on a permission prompt (or another
        // needs-you dialog). The exact signal the chat view lacked — it hands
        // off to the terminal the instant the prompt shows, instead of the
        // stuck timer's delayed guess.
        if (ev.kind === 'notify') {
          const owner = sessionByPty(ev.session_id);
          if (owner) owner.chatBrokerNotify(ev.data && ev.data.notification_type);
        }
        // Inline approvals (structured path): the PreToolUse hook emits this the
        // instant a sensitive tool blocks, carrying the tool, target, options,
        // and prompt_id it's polling on. The Allow/Deny click resolves that
        // prompt_id via a Tauri command. `permission.resolved` clears the panel
        // when the hook finishes (answered here, in the terminal, or timed out).
        if (ev.kind === 'permission.ask') {
          const owner = sessionByPty(ev.session_id);
          if (owner) owner.chatPermissionAsk(ev.data || {});
        }
        if (ev.kind === 'permission.resolved') {
          const owner = sessionByPty(ev.session_id);
          if (owner) owner.chatPermissionResolved(ev.data || {});
        }
        if (ev.kind === 'file.write') {
          const path = ev.data && ev.data.path;
          if (typeof path === 'string' && path) { reloadOpenDoc([path]); noteTouched(path, 'edited', workspaceColorFor(ev.session_id)); }
          return;
        }
        // Pause-on-question: agent paused — route attention back to the tab
        // it was running in. `session_id` is SPIKE_SESSION_ID, set per-tab
        // in pty.rs to match Session.ptyId. The visible tab gets ignored
        // (you can already see it — covers both the focused tab and the
        // column's currently-shown tab in a popped pane). turn.ended and
        // question.asked are visually identical (single dot): the broker
        // still distinguishes them for future use, but the badge is one
        // shape. The dock bounce is window-level, gated on the same
        // visibility check, plus a 3s throttle so a multi-batch agent
        // doesn't bounce 5 times in 10s.
        // A permission prompt is as much a "route attention back here" moment
        // as a finished turn — arguably more, since the agent is stuck until
        // you look. Badge the tab and bounce the dock for a blocking notify too.
        const notifyType = ev.kind === 'notify' ? (ev.data && ev.data.notification_type) : '';
        // A permission prompt Spike raised ITSELF (permission.ask) is as
        // blocking as one the TUI raised — more so, since the tool sits waiting
        // on that panel. It was missing here, which is why a lane could be
        // stuck on an Allow/Deny with no dot on its tab to say so.
        const blockingNotify = notifyType === 'permission_prompt'
          || notifyType === 'agent_needs_input' || notifyType === 'elicitation_dialog'
          || ev.kind === 'permission.ask';
        if (ev.kind === 'turn.ended' || ev.kind === 'question.asked' || blockingNotify) {
          const sid = ev.session_id;
          const s = sessionByPty(sid);
          // Theme sync and context re-read are turn-BOUNDARY concerns: a held
          // theme lands between turns, and the transcript only grows when a turn
          // ends. A permission prompt is mid-turn with neither, so skip both.
          if (s && !blockingNotify) {
            // A turn ending is the best moment to land a theme sync that was
            // held back: the agent is between turns and the composer is empty
            // unless the user has started typing (composerDirty still gates it).
            flushAgentTheme(s);
            // A turn just landed → the transcript grew → re-read context
            // occupancy and repaint the bar, regardless of tab visibility.
            refreshSessionContext(s);
          }
          const visible = s && (s === active || s === colActive);
          console.log(`[dock] event=${ev.kind} sid=${sid} matched=${!!s} visible=${visible}`);
          if (s && !visible) {
            s.attention = true;
            // A finished turn (turn.ended) — and ONLY that — marks the session
            // "done, go look": the response has fully landed with nothing
            // waiting on you. A question or permission prompt is "needs you",
            // not "done", so it must not set ready. Repaint the Workstreams
            // list so the row's chat-bubble fills solid.
            if (ev.kind === 'turn.ended') { s.ready = true; renderWorkstreams?.(); }
            // Cancel any pending flagActivity debounce — the broker signal
            // is precise, the heuristic timer would otherwise overwrite
            // attention state moments later.
            if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
            if (s.tab) s.tab.classList.add('attn');
            if (s.panelRow) s.panelRow.classList.add('attn');
            // Bounce the dock only when the agent's tab isn't visible AND
            // we haven't bounced in the last 3 seconds. Orphan events
            // (no session_id, or session no longer exists) never bounce —
            // the broker's port shouldn't be a remote dock-attack vector.
            const now = Date.now();
            if (now - lastDockBounceAt > 3000) {
              lastDockBounceAt = now;
              console.log(`[dock] requesting bounce for ${sid}`);
              ipc.requestAttentionIfUnfocused().catch(() => {});
            } else {
              console.log(`[dock] throttled (last bounce ${now - lastDockBounceAt}ms ago)`);
            }
          }
        }
      }).catch(() => {});
    })();

    // ─── native drag-drop (Tauri) ──────────────────────────────────────
    // The OS hands this handler a real filesystem path for every drag flavor —
    // including the macOS screenshot thumbnail, whose file-promise drop gives
    // the DOM no bytes and no path (Session.wireDrop stands down in Tauri for
    // exactly that reason). PNG/JPEG dropped on a Claude session rides the
    // clipboard (Ctrl+V → Claude's own [Image #N] chip); everything else
    // types a path. The drop lands in the pane under the cursor, falling back
    // to the active session so a drop on the tab strip still goes somewhere.
    (function wireNativeDrop() {
      const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|avif|svg|heic|tiff?)$/i;
      // The native drag point arrives in unzoomed viewport px — the space
      // #termlayer lives in, NOT the space elementFromPoint resolves the zoomed
      // body in. So the pane is resolved GEOMETRICALLY against pane rects (both
      // already in that space, so this is exact at every zoom), and
      // elementFromPoint is used only to pick a row once we've decided the point
      // is over the tree. Hit-testing the pane through the DOM was the bug: a
      // point over the chat could resolve into the tree, whose fallback silently
      // imports into the project root.
      const rectAt = (el: HTMLElement, x: number, y: number, pad = 0) => {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return false;   // hidden / zero-box
        return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
      };
      const paneAt = (x: number, y: number) => {
        // Pane rects are inset inside their slot by PANE_INSET (syncTermLayer),
        // so the raw rect is 12-14px smaller than the chat you see. Grow the hit
        // box back to the slot's edges or the gutters read as "not the terminal"
        // — and the left gutter sits right against the tree.
        const pad = Math.max(PANE_INSET.top, PANE_INSET.right, PANE_INSET.bottom, PANE_INSET.left);
        return (sessions as any[]).find(s => s.pane && rectAt(s.pane, x, y, pad)) || null;
      };
      let lit: any = null;   // the pane currently showing the drop ring
      const clear = () => { if (lit) { lit.pane.classList.remove('dropping'); lit = null; } };
      // Finder → vault import: resolve the tree folder under the cursor. A
      // `.dropdir` row (a folder, or the project root) names its dir; a file row
      // imports into its parent; anywhere else over the tree falls back to the
      // project root. null = not over the tree, so the drop belongs to a pane.
      // Callers must rule out a pane FIRST — a pane floats above the tree, so
      // where the two overlap the pane owns the drop.
      const treeRowAt = (x: number, y: number): HTMLElement | null => {
        // treeEl is inside the zoomed body; the point is not. overlayScale maps
        // a body rect into viewport px (toViewportRect), so its inverse maps the
        // point back into whatever space elementFromPoint expects. It's 1 on
        // every current WebKit, so this is a no-op there.
        const k = overlayScale || 1;
        return document.elementFromPoint(x / k, y / k) as HTMLElement | null;
      };
      const treeDestAt = (x: number, y: number): string | null => {
        // Geometry decides whether we're over the tree at all; elementFromPoint
        // only refines WHICH folder. If it disagrees (a stale or mis-mapped hit
        // test), the worst case is an import into the project root — the folder
        // the tree is already showing — never a stray import from over the chat.
        if (!treeEl || !rectAt(treeEl as HTMLElement, x, y)) return null;
        const el = treeRowAt(x, y);
        if (el && treeEl.contains(el)) {
          const dd = el.closest('.dropdir') as HTMLElement | null;
          if (dd && dd.dataset.dropdir) return dd.dataset.dropdir;
          const node = (el.closest('.row') as any)?.__node;
          if (node) return node.dir ? node.path : node.path.slice(0, node.path.lastIndexOf('/'));
        }
        return projectPath || null;
      };
      let litTree: HTMLElement | null = null;
      const clearTree = () => { if (litTree) { litTree.classList.remove('dropinto'); litTree = null; } };
      ipc.onNativeDrag(async (e) => {
        if (e.type === 'enter' || e.type === 'over') {
          // Pane first: a pane floats above the tree, so where they overlap the
          // terminal owns the drop. Asking the tree first let any coordinate
          // slop land in its project-root fallback instead.
          const s = paneAt(e.x, e.y);
          if (!s && treeDestAt(e.x, e.y) != null) {
            clear();   // over the tree, not a pane — drop the pane ring
            const el = treeRowAt(e.x, e.y)?.closest('.dropdir') as HTMLElement | null;
            const hl = (el && treeEl?.contains(el) ? el : null) || treeEl;
            if (hl !== litTree) { clearTree(); if (hl) { hl.classList.add('dropinto'); litTree = hl; } }
            return;
          }
          clearTree();
          if (s !== lit) { clear(); if (s) { s.pane.classList.add('dropping'); lit = s; } }
          return;
        }
        clear();
        clearTree();
        if (e.type !== 'drop' || !e.paths.length) return;

        // Home landing owns the screen: route the drop into its composer before
        // any pane/tree logic — the panes are hidden behind #home, so the usual
        // "drop into the active pane" would stage into a lane you can't see.
        if (homeDropRouter && await homeDropRouter(e.paths)) return;

        // Same precedence as the hover ring: whatever lit up is what receives
        // the drop. A pane under the point wins; only if there is none do we
        // treat this as a tree import.
        const dropPane = paneAt(e.x, e.y);

        // Dropped on the tree → import (copy) each path into that folder, then
        // repaint the tree so the new entries show up.
        const destDir = dropPane ? null : treeDestAt(e.x, e.y);
        if (destDir != null) {
          let imported = 0, failed = 0;
          for (const p of e.paths) {
            try { await ipc.copyPath(p, destDir); imported++; }
            catch { failed++; }
          }
          logAction('drop_import', { paths: e.paths, dir: destDir, imported, failed });
          if (projectPath) await loadTree(projectPath);
          if (status) {
            // #status is the transient worktree/FS line — self-clear so the
            // import note doesn't sit there forever (it had no timeout before).
            const msg = failed
              ? `Imported ${imported}, skipped ${failed}`
              : `Imported ${imported} item${imported === 1 ? '' : 's'}`;
            status.textContent = msg;
            setTimeout(() => { if (status && status.textContent === msg) status.textContent = ''; }, 6000);
          }
          return;
        }

        const target = dropPane || active;
        if (!target) return;

        // PNG/JPEG into a Claude session goes via the clipboard: stage the
        // image, type Ctrl+V, and Claude Code renders its own [Image #N] chip
        // — no /tmp path cluttering the prompt. Everything else falls back to
        // a typed path: other image types via a spaceless temp copy (the
        // thumbnail's source may be transient, and "Screenshot 2026-… AM.png"
        // would split into tokens), non-images as-is, same as a tree drag.
        // Plain-shell tabs always get the path — that's what a shell wants.
        // Engine seam (happy accident): the `target.cmd === 'claude'` guard
        // means a Codex tab falls through to the path route, which is exactly
        // what Codex's `-i path` wants. No change needed when adding Codex.
        const CLIP_RE = /\.(png|jpe?g)$/i;
        let staged = 0, failed = 0;
        const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
        for (const p of e.paths) {
          if (CLIP_RE.test(p) && (!target.cmd || target.cmd === 'claude')) {
            // Clipboard route (Claude's own [Image #N]). Staged, not delivered:
            // in chat mode it waits — retractable via its chip's × — until the
            // message is sent; in the raw terminal stageAttachment pastes it now.
            target.stageAttachment({ route: 'clip', path: p, thumb: ipc.rawSrc(p), name: base(p) });
            staged++;
            continue;
          }
          if (IMG_RE.test(p)) {
            try { const s = await ipc.ingestPath(p); target.stageAttachment({ route: 'typed', path: s, thumb: ipc.rawSrc(s), name: base(p) }); staged++; }
            catch { failed++; }
          } else {
            // Non-image file (PDF, .md, …): typed as a path, shown as a
            // file-glyph chip, and — like the rest — retractable until send.
            target.stageAttachment({ route: 'typed', path: p, name: base(p) });
            staged++;
          }
        }
        logAction('drop_native', { paths: e.paths, staged, failed });
        if (failed)
          target.term.write(`\r\n\x1b[33m[spike] attached ${staged}, skipped ${failed} (unreadable or >12 MB)\x1b[0m\r\n`);
      }).catch(() => {});
    })();
