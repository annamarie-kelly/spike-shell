Spike Shell 0.5.0 — the first release under its own name, and the biggest one yet. 96 commits since 0.4.1.

> **Correction (0.5.1).** The chat sections below describe Spike's full edition, not Spike Shell. The public build has `CHAT_ENABLED` off: there is no chat view, no ⌘⇧E, and the subagent strip and Codex-in-chat items do not apply. Everything about terminals, panes, preview, connectors, permissions and quick capture is accurate. See RELEASE-NOTES-0.5.1.md.

## A chat view over any session

⌘⇧E (or right-click a tab) flips a lane from terminal to conversation: your messages, the agent's prose, and every tool call folded into one plain-language line you can expand. It is a formatting layer, not a second client. It renders the JSONL transcript the agent CLI already writes, sends by typing into the same PTY, and works with Claude Code or Codex. The terminal stays alive underneath, one click away.

- Permission prompts hand off the instant they appear, instead of the view going quiet
- Questions get answered in-view; picking an option loads the composer rather than guessing at a TUI select
- Attach files by drag or paste, with per-chip removal and non-image files (PDF, .md, anything) shown properly
- Rich code blocks: syntax highlighting, language label, one copy button per turn
- File links in chat open in the Spike preview panel
- Starter openers on the empty state
- A thinking indicator that spells SPIKE

## Subagents you can watch

Child agents spawned from a parent lane nest under it, with a live strip in the parent's chat showing each one's identity and its own words. Click in to read a subagent's transcript read-only. The agent can drive this itself with `spike spawn "<task>"`.

## Connectors

A GUI manager for MCP connectors, for both Claude and ChatGPT. No more hand-editing config.

## Permissions

Spike shows and revokes; Claude authors. Spike never owns a second permission model, it reads and edits Claude's own settings.

## Quick capture

⌘⇧N captures a note without leaving what you are doing. "Tend inbox" hands the pile to an agent that proposes filings for you to approve.

## Preview and panes

- The web browser gets its own pane beside your work
- In-place text editing for HTML previews, with the pencil in the header
- A markdown toolbar that fits, and keys that behave
- Finder-style multi-select in the file tree
- Tab-overflow shows "+N" hidden-count badges instead of squeezing
- Tab bar and composer stay pinned across zoom; only content scales

## Codex parity

The startup trust gate is surfaced in chat instead of swallowed, tool calls render at parity with Claude, the injected system preamble is hidden, sends no longer double the user bubble, and long messages scroll and hold position.

## Fixes worth naming

- ⌘S no longer discards edits; ⌘F works in source view
- Attachment × actually retracts the file, not just the chip
- Reveal animations never strand content hidden
- Status ticks no longer rebuild the transcript, which is what made Codex chat unscrollable
- Chat overlay wheel events scroll the chat, not the hidden terminal underneath

---

**Install:** download the `.dmg`, open it, drag Spike into Applications. It is signed and notarized, so no developer tools are needed. You supply the agent: [Claude Code](https://www.anthropic.com/claude-code) (`claude`) or [OpenAI Codex](https://github.com/openai/codex) (`codex`) on your PATH. Spike auto-detects both.

Apple Silicon only. Intel and Windows/Linux are not built yet.

**Updating from 0.4.1 or earlier:** you have to download this one by hand. Older builds point their updater at a repository that is no longer public, so they cannot see this release. Builds from 0.5.0 onward update in place.
