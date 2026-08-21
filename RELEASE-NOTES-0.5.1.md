Spike Shell 0.5.1. A correction release: 0.5.0 did not compile from source, its sign-in flow could not finish, and its notes described a product this is not.

## Spike Shell is terminal-only

Read the 0.5.0 notes and the first thing you meet is a chat view on ⌘⇧E. It is not in this app and it was not in 0.5.0 either.

Spike ships two editions from one source tree. The full app has the chat surface; Spike Shell, the public one, is terminals all the way down. `CHAT_ENABLED` decides at build time, and the public build has it off. The notes were written from the full edition's changelog, so they advertised a feature the binary gates out.

What Spike Shell actually gives you: multiple named terminals, one agent session per tab, Claude Code or Codex, with a real PTY underneath. Chrome-style tab groups that carry their own context prompt. Drag-to-dock tiling that survives a restart. A preview panel that renders markdown, HTML, CSV, JSON, images and PDF, and doubles as a syntax-highlighted editor with ⌘S. An in-pane browser. Quick capture on ⌘⇧N. The terminal is the chat here, and that is the whole idea.

Three surfaces had not caught up with that and were still offering chat: the ⌘⇧E binding, its line in the ⌘/ shortcuts overlay, and Settings' "Default view" rows. All three are now behind the same edition flag as everything else.

## Sign-in through the in-pane browser

Google refuses interactive sign-in inside an embedded webview, so Spike relocates it to a real window. Two things were wrong with that.

The pane never stood down. It had been bounced to Google's page and kept rendering it, so the same "Choose an account" screen appeared twice and only the window's could be completed. The pane now hides behind a placeholder, with a Cancel button, until sign-in finishes.

Third-party sign-in could never report success. The completion check was written for the first-party case, where a Docs load carries a `continue=` naming a google.com host. "Sign in to GitHub with Google" inverts that: the `continue=` is itself an accounts.google.com URL, so nothing matched and the window never closed. Landing off Google now counts as done for that shape, narrowly enough that a hop through another Google host mid-flow does not close the window early.

Closing that window by hand now releases the pane instead of stranding it, and a cancel buys a five second quiet window so the poll cannot immediately reopen what you just dismissed.

## The crate did not compile

`lib.rs` declares `pub mod datatable;`, `datatable.rs` opens a SQLite connection, and nothing in the repo declared `rusqlite`. `cargo check` failed on 0.5.0 as published. It is declared now, bundled, so the build does not depend on the host's SQLite.

CI would not have caught it: the workflow runs `publish:shell:check` and `typecheck`, both JavaScript, and neither builds the Rust crate. Worth knowing if you are building from source.

## Smaller

- The capture signpost beside ⌘K is the stroked pencil icon, not the `✎` character, which rendered heavy and cross-hatched next to ⌘K's letterforms
- That pencil sat 30px from ⌘K and now sits 19px away, so the pair reads as one control
- The verify harness can build either edition (`SPIKE_EDITION=shell node verify/run.mjs …`). Until now every scenario ran as the full edition, so the terminal-only contract had no test coverage at all

---

**Install:** download the `.dmg`, open it, drag Spike Shell into Applications. Signed and notarized, so no developer tools needed. You supply the agent: [Claude Code](https://www.anthropic.com/claude-code) (`claude`) or [OpenAI Codex](https://github.com/openai/codex) (`codex`) on your PATH. Spike auto-detects both.

Apple Silicon only. Intel and Windows/Linux are not built yet.

**Updating from 0.5.0:** in place, through the app. The app was renamed between these two releases, and the updater handles it: the archive's contents replace the installed bundle whatever it is called, and the relaunch reads the new Info.plist to find the executable. Two things you will notice. The folder keeps its old name (`Spike.app`) while the app inside is Spike Shell, so rename it if that bothers you. And the bundle identifier changed, so macOS may ask again for permissions you had already granted.

From 0.4.1 or earlier you have to download by hand, because older builds point their updater at a repository that is no longer public.
