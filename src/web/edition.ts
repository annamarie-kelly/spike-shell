// Which edition this bundle is, in one place so every module reads the same
// answer. app.ts owned this privately, which was fine while it was the only
// module that cared — but the chat surface is also reachable from the ⌘/
// shortcuts overlay (palette.ts) and Settings' "Default view" rows
// (settings.ts), and both were advertising a feature the shell edition doesn't
// have. Re-declaring the define in three files invites them to drift.
//
// `build-web.mjs` defines __SPIKE_EDITION__ when SPIKE_EDITION=shell; left
// undefined (verify's harness, plain builds) it reads as the full edition, so
// the typeof guard is what keeps an undeclared global from throwing.
declare const __SPIKE_EDITION__: string | undefined;
export const SPIKE_EDITION = typeof __SPIKE_EDITION__ === 'undefined' ? 'full' : __SPIKE_EDITION__;
export const CHAT_ENABLED = SPIKE_EDITION !== 'shell';
