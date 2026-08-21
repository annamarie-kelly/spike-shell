// [shell edition] chat rendering removed; the parsers below are shared.
// chatview.ts — the calm face of an agent session.
//
// Spike's terminal is the chat. That is true and it is also the reason people
// who don't write code bounce off it: ANSI, monospace, a tool call scrolling
// past every 200ms. This module is a *formatting layer* over the same session.
// Nothing here talks to a model. Nothing here needs an SDK. It reads what the
// CLI already wrote to disk (its transcript) and renders it as conversation.
//
// ── Why transcripts, not the PTY stream ─────────────────────────────────────
// Parsing the terminal bytes back into meaning is a losing game: Claude Code
// and Codex are redrawing TUIs, so the same paragraph arrives four times with
// cursor moves in between. But both engines already write a structured JSONL
// transcript per session, and Spike already knows the id (pty.rs owns it; see
// usage.rs `find_claude_transcript`). Tail that file and you get the semantic
// stream for free — user turns, assistant prose, tool calls — with no parsing
// of escape codes and no coupling to any vendor's API.
//
// ── Engine seam ─────────────────────────────────────────────────────────────
// `parse()` dispatches to a per-engine adapter. Claude's shape is verified
// against real transcripts. Codex's is written from its rollout format and is
// tolerant by construction (it walks for known shapes rather than asserting a
// schema) — treat it as unproven until a real rollout file is read. A third
// engine is a third adapter and nothing else.
//
// ── What the layer is allowed to hide ───────────────────────────────────────
// Everything that is machinery rather than meaning: thinking blocks, tool
// inputs, file paths, exit codes, sub-agent chatter. They collapse into one
// quiet line ("Read 4 files · Ran 3 commands") that expands on click. The rule
// is the same as the rest of Spike — capability without chrome. Nothing is
// destroyed, only folded. The raw terminal is always one toggle away, and for
// anything this view cannot express (a permission prompt, an interactive
// select) the terminal is the answer, not a reimplementation of it.

import { CONNECTOR_LOGOS, connectorLogoKey } from './connector-logos';

export type Engine = 'claude' | 'codex';

/**
 * The mark for a connected service: its own logo where we ship one, otherwise
 * its initial. The initial is not a consolation prize — most MCP servers are an
 * internal tool with no logo to ship, and an "S" beside "Using Sonar" still
 * makes two services apart at a glance, which a shared globe never did.
 *
 * `key` is short and stable so callers can diff marks without carrying an SVG
 * through a render signature.
 */
export interface Mark {
  key: string;
  /** Brand SVG (a full `<svg>` element), applied as a mask so it takes color. */
  logo?: string;
  /** A single capital letter, rendered as text. */
  monogram?: string;
}

/** One thing the agent did, already translated out of tool-speak. */
export interface Action {
  /** Coarse bucket, used for the collapsed summary and the icon. */
  kind: 'read' | 'edit' | 'run' | 'search' | 'web' | 'delegate' | 'plan' | 'ask' | 'other';
  /** Plain-language verb, sentence case: "Read", "Edited", "Ran a command". */
  verb: string;
  /**
   * The same act in progress: "Reading", "Editing", "Running a command". The
   * live status line needs the present tense — "Read notes.md" while it is
   * still reading it is just wrong, and this view is for people who will read
   * it literally.
   */
  gerund: string;
  /**
   * The same act with no object to attach — "Reading a file" rather than a
   * bare "Reading". Needed because the broker names a tool the instant it
   * starts but carries none of its input, so for one beat there is a verb and
   * nothing to apply it to. Only set where the gerund doesn't already stand up
   * on its own ("Running a command" needs no help).
   */
  gerundAlone?: string;
  /** What it acted on, already shortened: a basename, a query, a command. */
  object?: string;
  /**
   * The service's own mark, when the action was a call into a connected one.
   * A globe on every MCP call says "the internet" for work that was Slack,
   * Linear, or somebody's internal CRM — the name of the service is right there
   * in the label, so the icon may as well agree with it. See {@link Mark}.
   */
  mark?: Mark;
  /** The unabridged truth, shown only when a row is expanded. */
  detail?: string;
  /**
   * A structured question the agent asked (AskUserQuestion). This is the one
   * tool call that is not background machinery — it is the agent talking to
   * you — so it gets rendered as a panel rather than folded into the work
   * strip. See `askPanel`.
   */
  ask?: AskQuestion[];
  /** The tool_use id, so a later tool_result can be matched back to it. */
  askId?: string;
  /** What was answered, once the result comes back. Undefined = still open. */
  answer?: string;
  /**
   * What the tool reported back, capped. This is the substance the terminal
   * shows and the first version of this view threw away — "Wrote 126 lines
   * to …", a command's output, an error. Expanding a step should reveal what
   * actually happened, not repeat the label you already read.
   */
  result?: string;
  /** Total lines in the result, so a capped preview can say what it cut. */
  resultLines?: number;
  /** A few lines of what was written or run, for the expanded view. */
  preview?: string;
  /** Lines the preview left out. */
  previewMore?: number;
  /** Size of the act, when it's cheaply known: "126 lines". */
  magnitude?: string;
  /**
   * The tool reported an error. Taken from the result block's `is_error`, not
   * guessed from the text — a step that failed has to look different from one
   * that worked, and inferring it from wording would mislabel both ways.
   */
  failed?: boolean;
  /**
   * The plan, structured. Set only for TodoWrite. The terminal draws a live
   * task widget from this; the calm view used to fold the whole list into a
   * single "Updated the plan" line and throw the items away. Kept structured so
   * the pinned checklist can render each item with its status. `detail` still
   * holds the raw JSON for the expanded view.
   */
  todos?: Todo[];
  /**
   * An edit's before/after, capped, for an inline diff peek. `peek` already
   * captures what went in ("+126 lines"); a change is more legible as the two
   * sides side by side, and the tool call already carries both (old_string /
   * new_string). Only set for a single Edit — MultiEdit/apply_patch fall back
   * to the plain preview.
   */
  diffDel?: string;
  diffAdd?: string;
  diffDelMore?: number;
  diffAddMore?: number;
}

/** One line of the plan, already reduced to what the checklist needs. */
export interface Todo {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * A permission prompt, as an inline decision the person can answer without
 * leaving the chat. Unlike a question, the options are not the agent's — they
 * are the fixed set every tool prompt offers (allow once / allow for the
 * session / deny), authored by Spike, so no scraping of the TUI dialog is
 * needed. `keystroke` is what selecting the option sends to the pty; the whole
 * mechanism reuses the AskUserQuestion write path (a digit the TUI's select
 * takes as select-and-submit). `tool`/`target` are informational — what you're
 * being asked to allow — sourced from the tool that triggered the prompt.
 */
export interface PermissionOption {
  id: 'allow_once' | 'allow_session' | 'allow_always' | 'deny';
  label: string;
  keystroke: string;
  scope: 'once' | 'session' | 'always' | 'deny';
  /**
   * The permission rule an `allow_always` grant writes, in the agent's own rule
   * syntax (`Bash(npm run:*)`). Present only on that option — it is the whole
   * of what "always" means, and the card shows it verbatim so a permanent grant
   * is never wider than what the person read.
   */
  rule?: string;
  /**
   * The class an `allow_always` grant covers, in plain language ("node
   * verify/run.mjs …"). The button itself says only "Always allow" — it shares a
   * row with two others and cannot carry a phrase this long — so the card prints
   * this, with `rule`, as the caption under the row.
   */
  what?: string;
  /**
   * True when this option's keystroke means the same thing whatever tool is
   * asking. Only these may be offered on the keystroke fallback, where Spike is
   * typing a digit into a dialog it cannot read.
   *
   * Yes and No are fixed at 1 and 3. The middle option is not: Claude's own
   * option 2 is "apply the suggested rules", and which rules it suggests
   * depends on the tool and the call — so on a file edit it can mean "allow all
   * edits this session" and on a command "don't ask again for this one". Spike
   * offered it as "Allow for this session" and typed 2, which could persist a
   * rule while telling the person the grant ended with the session. It is now
   * offered only where Spike resolves the decision itself and can honour the
   * scope it named. See PERMISSION_OPTIONS_KEYSTROKE.
   */
  stableKeystroke?: boolean;
}
export interface PermissionAsk {
  tool: string;
  /**
   * The answer has been typed into the terminal's dialog, and Spike is waiting
   * to see whether it took. Only the keystroke path sets this: it cannot read
   * the dialog it typed into, so it states that it has sent something rather
   * than that anything was decided. The panel stays up, quiet, until a tool or
   * turn event proves the block lifted — or the person gives up and uses the
   * terminal link, which stays live throughout.
   */
  sent?: boolean;
  target?: string;
  options: PermissionOption[];
  /**
   * The hook's correlation id, present only on the structured path (a
   * `permission.ask` event). When set, the decision resolves the blocked hook
   * via a command; when absent (the older notify-derived panel), it falls back
   * to a keystroke into the pty.
   */
  promptId?: string;
}

/** The fixed choices a tool permission prompt offers, in the TUI's own order. */
export const PERMISSION_OPTIONS: PermissionOption[] = [
  { id: 'allow_once', label: 'Allow once', keystroke: '1', scope: 'once', stableKeystroke: true },
  { id: 'allow_session', label: 'Allow for this session', keystroke: '2', scope: 'session' },
  { id: 'deny', label: 'Deny', keystroke: '3', scope: 'deny', stableKeystroke: true },
];

/**
 * The choices offered when the only way to answer is a keystroke into the
 * terminal's own dialog — the notify-derived panel, which has no prompt id to
 * resolve against.
 *
 * Two, not three. A digit Spike cannot verify must not be sent on behalf of a
 * promise Spike cannot keep: see stableKeystroke. Answering in the terminal
 * remains one click away for anything this narrower set doesn't cover, and
 * offering less is the right trade when the alternative is granting more than
 * the person chose.
 */
export const PERMISSION_OPTIONS_KEYSTROKE: PermissionOption[] =
  PERMISSION_OPTIONS.filter((o) => o.stableKeystroke);

/**
 * Commands whose first token is never offered an "always" grant, however the
 * person clicks. An always-rule is a standing yes for a whole class of call, and
 * these are the classes where the class is the danger: they delete, escalate,
 * reach the network, or push work somewhere other people see. A grant that broad
 * belongs in Settings, typed deliberately, not one click deep in a card you were
 * trying to get past. "Allow once" still covers every one of them.
 */
const NEVER_ALWAYS = new Set([
  'rm', 'rmdir', 'sudo', 'su', 'chmod', 'chown', 'dd', 'mkfs', 'diskutil',
  'kill', 'killall', 'pkill', 'shutdown', 'reboot', 'launchctl',
  'curl', 'wget', 'ssh', 'scp', 'rsync', 'nc', 'ftp', 'npx',
  'eval', 'exec', 'source',
]);

/**
 * Binaries that do whatever their argument says. A rule naming one of these
 * ALONE (`Bash(node:*)`) is a standing yes to arbitrary code, so the bare stem
 * is refused — but `node verify/run.mjs` names a script and is allowed to
 * become `Bash(node verify/run.mjs:*)`.
 */
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'node', 'python', 'python3', 'ruby', 'perl', 'deno', 'bun']);

/**
 * Pairs that make an otherwise-ordinary binary outward-facing or
 * supply-chain-shaped: they publish, install someone else's code, or rewrite
 * history other people will pull.
 */
const NEVER_ALWAYS_PAIR = new Set([
  'git push', 'git commit', 'git reset', 'git clean', 'git checkout',
  'npm install', 'npm i', 'npm ci', 'npm publish', 'npm link',
  'pip install', 'pip3 install', 'brew install', 'gem install', 'cargo install',
  'gh pr', 'gh release', 'gh repo', 'gh workflow',
]);

/**
 * The permission rule an "always allow" would write for this call, plus `what`
 * — the class it covers in plain language, for the caption under the card's
 * button row. Null when no rule can be named safely, in which case the option is
 * simply not offered and the session grant keeps the middle slot.
 *
 * The rule names a CLASS, never the individual call: "always allow reading
 * notes/plan.md" would be worthless, and the reason to click Always is that you
 * are tired of being asked about the whole family. That makes `what` the safety
 * surface — it has to say what the family is, which is why the caller shows it
 * alongside `rule` verbatim.
 *
 * Bash is the sharp edge. A rule is derived from the first two tokens
 * (`npm run` → `Bash(npm run:*)`), never the first alone, so a grant can't
 * widen from "the build script" to "anything npm can do" — and a first token in
 * NEVER_ALWAYS, or a pair in NEVER_ALWAYS_PAIR, returns null instead.
 */
export function alwaysRuleFor(
  tool: string,
  target: string | undefined,
  cwd: string | undefined,
): { rule: string; what: string } | null {
  const repo = (cwd || '').split('/').filter(Boolean).pop() || '';
  if (/^(Read|NotebookRead|Glob|Grep|LS)$/.test(tool)) {
    if (!cwd) return null;
    return { rule: 'Read(//' + cwd + '/**)', what: 'reading files in ' + repo + '/' };
  }
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool)) {
    if (!cwd) return null;
    return { rule: 'Edit(//' + cwd + '/**)', what: 'editing files in ' + repo + '/' };
  }
  if (tool === 'WebFetch') {
    const m = /^https?:\/\/([^/?#]+)/i.exec(target || '');
    if (!m) return null;
    const host = m[1].replace(/^www\./i, '').toLowerCase();
    return { rule: 'WebFetch(domain:' + host + ')', what: 'fetching pages from ' + host };
  }
  if (tool === 'Bash') {
    // Only a plain command earns a rule. A pipeline, a redirect, a chain or a
    // substitution means the first tokens do not describe what actually runs.
    const cmd = (target || '').trim();
    if (!cmd || /[|;&><`$(){}]/.test(cmd)) return null;
    const parts = cmd.split(/\s+/);
    const head = parts[0];
    if (!head || NEVER_ALWAYS.has(head)) return null;
    // A flag as the second token is not a subcommand — fall back to the binary.
    const second = parts[1] && !parts[1].startsWith('-') ? parts[1] : '';
    const stem = second ? head + ' ' + second : head;
    if (NEVER_ALWAYS_PAIR.has(stem)) return null;
    if (!second && INTERPRETERS.has(head)) return null;
    return { rule: 'Bash(' + stem + ':*)', what: 'running ' + stem + ' …' };
  }
  return null;
}

export interface AskOption { label: string; description?: string }
/**
 * How the person answered a question panel.
 *  - `pick`: a single-select option, with its 0-based index — the caller sends
 *    the matching digit, which Claude's TUI takes as select-and-submit.
 *  - `words`: a typed answer, or a multi-select set joined as text — the caller
 *    escapes the TUI select and sends it as a normal message.
 */
export type AskAnswer =
  | { type: 'pick'; label: string; index: number }
  | { type: 'words'; text: string };
export interface AskQuestion {
  header?: string;
  question: string;
  multi?: boolean;
  options: AskOption[];
}

/**
 * One thing a reviewer agent flagged, tracked through the coder's response.
 *
 * The whole convergence loop is a list of these shrinking to empty. A finding
 * is born `open` (the reviewer raised it, the coder hasn't answered), moves to
 * `accepted` (coder agreed — it drops out of the contested set) or `contested`
 * (coder pushed back — reject or counter), and any finding still contested when
 * the round cap is hit becomes `escalated`: yours to break. The terminal states
 * are `accepted` / `escalated` / `resolved` (you ruled), and every path reaches
 * one — that is what makes the loop provably terminate rather than ping-pong.
 */
/**
 * A proposed inbox filing: the agent read a stray note in inbox/ and suggests
 * where it belongs. Its own lightweight lane, deliberately NOT folded into the
 * reviewer↔coder Finding machinery — a move is a one-shot approve/skip, not a
 * multi-round negotiation, so it carries none of that state.
 */
export type MoveState = 'proposed' | 'approved' | 'skipped';
export interface Move {
  /** Stable across re-parses (from+to) — the DOM key and the merge key. */
  id: string;
  /** Source path as the agent emits it (relative to the project root). */
  from: string;
  /** Proposed destination path (folder + real filename). */
  to: string;
  /** One-line rationale for filing it there. */
  why?: string;
  state: MoveState;
}

export type FindingState = 'open' | 'accepted' | 'contested' | 'escalated' | 'resolved';
/** How the coder answered a single finding. */
export type FindingVerdict = 'accept' | 'reject' | 'counter';
export interface Finding {
  /** Stable across re-parses (file+line+claim) — also the anti-recursion key. */
  id: string;
  file?: string;
  line?: number;
  /** The reviewer's assertion, in its own words. */
  claim: string;
  severity: 'blocker' | 'warn' | 'nit';
  /** The reviewer's proposed fix — advisory only; the reviewer never applies it. */
  suggestion?: string;
  /** The coder's per-finding verdict, once it has answered. */
  verdict?: FindingVerdict;
  /** The coder's reason, when it rejected or countered. */
  reply?: string;
  /** The reviewer's reason for holding, carried back to the coder next round. */
  reviewerNote?: string;
  state: FindingState;
  /**
   * How many times the coder has contested this finding. The anti-recursion
   * guard: at the round cap it escalates to you instead of bouncing again, so a
   * disagreement can never loop on itself in new words.
   */
  bounces: number;
  /**
   * Whose response is owed right now, while the finding is mid-negotiation —
   * the coder (answer the flag) or the reviewer (reconsider the pushback).
   * Cleared once the finding reaches a terminal state.
   */
  awaiting?: 'coder' | 'reviewer';
  /**
   * The number this finding wore in the last message we sent about it (`#N`).
   * Frozen per ask so a partial answer can't renumber the rest — a reply cites
   * this, and we map it back by askNum rather than by list position.
   */
  askNum?: number;
  /**
   * Monotonic ask counter: bumped every time we inject a message about this
   * finding. `consumedTurn` is the last ask we've already folded a reply for.
   * A reply only counts when consumedTurn < turn, which dedups re-polls and
   * lets the same finding legitimately take a fresh verdict each round.
   */
  turn?: number;
  consumedTurn?: number;
  /**
   * Epoch ms of the last ask about this finding, so a side that never answers
   * can be timed out and escalated rather than wedging the loop forever.
   */
  askedAt?: number;
}
/** The coder's verdict on one finding, parsed out of its reply. */
export interface CoderVerdict {
  /** The finding number the coder cited (`#N …`) — matched back by askNum. */
  index: number;
  verdict: FindingVerdict;
  /** The reason after `reject:`/`counter:`, when given. */
  note?: string;
}
/**
 * The reviewer's response when it reconsiders a contested finding: `concede`
 * (withdraw it — the coder's call stands) or `hold` (it still stands, back to
 * the coder for another round).
 */
export type ReviewerStance = 'concede' | 'hold';
export interface ReviewerVerdict {
  index: number;
  verdict: ReviewerStance;
  note?: string;
}

export type Block =
  | { type: 'text'; text: string }
  | { type: 'actions'; items: Action[] }
  | { type: 'ask'; item: Action };

export interface Turn {
  actor: 'you' | 'agent';
  blocks: Block[];
  ts?: string;
  /** How many images the person dropped on this turn (rendered as a chip). */
  attachments?: number;
}

// ── Adapters ────────────────────────────────────────────────────────────────

/** Parse a transcript's raw lines into turns. Unknown/malformed lines drop. */
export function parse(lines: string[], engine: Engine): Turn[] {
  const t = new Timeline();
  feed(t, lines, engine);
  return t.done();
}

/**
 * A live transcript, fed the tail as it arrives.
 *
 * The point is that `push` is O(new lines), not O(file). A working session's
 * transcript runs to tens of megabytes; re-parsing it on every poll would burn
 * a JSON.parse over the whole history once a second. The Timeline only ever
 * appends, so feeding it just the new rows is equivalent to re-reading the
 * whole file, at a fraction of the cost.
 */
export class ChatStream {
  private line = new Timeline();
  constructor(private engine: Engine) {}

  /** Drop everything — the transcript was replaced (a /clear), not appended. */
  reset() { this.line = new Timeline(); }

  /** Feed newly appended lines. Returns true when anything was understood. */
  push(lines: string[]): boolean {
    if (!lines.length) return false;
    return feed(this.line, lines, this.engine);
  }

  turns(): Turn[] { return this.line.done(); }
}

/** Parse raw lines and hand each row to the engine's adapter. */
function feed(out: Timeline, lines: string[], engine: Engine): boolean {
  let any = false;
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let row: any;
    try { row = JSON.parse(s); } catch { continue; }   // partial tail write
    if (engine === 'codex' ? feedCodex(out, row) : feedClaude(out, row)) any = true;
  }
  return any;
}

/**
 * Claude Code: one JSONL row per event under ~/.claude/projects/<cwd>/<id>.jsonl.
 * Rows we care about are `type: "user"` and `type: "assistant"`, each carrying an
 * Anthropic-shaped `message`. Everything else (mode, permission-mode, ai-title,
 * file-history-snapshot, attachment) is bookkeeping and is dropped.
 *
 * Two rows look like a user turn but are not: a tool_result (the harness feeding
 * output back) and a system-reminder injection. Both must be filtered or the
 * view fills with the agent talking to itself.
 */
function feedClaude(out: Timeline, r: any): boolean {
  if (r?.isSidechain) return false;            // sub-agent chatter, folded elsewhere

  // A message QUEUED while the agent was working is no longer written as a
  // `user` turn — Claude Code now records it as an `attachment` of type
  // `queued_command` (the `queue-operation` enqueue/remove rows are just
  // bookkeeping for the same message). Dropped as "attachment bookkeeping", the
  // queued message never became a turn: its optimistic bubble never reconciled
  // and stayed pinned at the foot of the chat, and anchoring had no turn to
  // place. Surface the human-authored prompt as the person's turn so it renders,
  // clears the pending bubble, and anchors to where it was typed. Only
  // human-origin queued_command carries a real prompt; every other attachment
  // subtype (skill/tool/mcp listings, reminders) is genuine bookkeeping.
  if (r.type === 'attachment') {
    const at = r.attachment;
    if (at && at.type === 'queued_command' && at.origin && at.origin.kind === 'human'
        && typeof at.prompt === 'string' && at.prompt.trim()) {
      out.say(at.prompt.trim(), at.timestamp || r.timestamp);
      return true;
    }
    return false;
  }

  const msg = r?.message;
  if (!msg) return false;

  if (r.type === 'user') {
    // A tool_result is plumbing — with one exception. The result of a question
    // IS the person's answer, so it gets carried back to the panel that asked
    // instead of being dropped with the rest.
    let answered = false;
    for (const b of asBlocks(msg.content)) {
      if (b?.type === 'tool_result' && b.tool_use_id && out.result(b.tool_use_id, resultText(b.content), !!b.is_error)) {
        answered = true;
      }
    }
    const said = userText(msg.content);
    if (!said.text) return answered;
    out.say(said.text, r.timestamp, said.images);
    return true;
  }
  if (r.type !== 'assistant') return false;

  let any = false;
  for (const b of asBlocks(msg.content)) {
    if (b?.type === 'text' && b.text?.trim()) { out.agentText(b.text, r.timestamp); any = true; }
    else if (b?.type === 'tool_use') {
      const a = humanize(b.name, b.input);
      a.askId = b.id;
      out.agentAction(a, r.timestamp);
      any = true;
    }
    else if (b?.type === 'tool_result' && b.tool_use_id) {
      // Some engines inline the result on the assistant row rather than a
      // following user row. Same handling either way.
      if (out.result(b.tool_use_id, resultText(b.content), !!b.is_error)) any = true;
    }
    // thinking / redacted_thinking: deliberately dropped
  }
  return any;
}

/** A tool_result's content is a string, or blocks that carry one. */
function resultText(content: any): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.filter((b: any) => typeof b?.text === 'string').map((b: any) => b.text).join('\n').trim();
  }
  return '';
}

/** Flatten Codex's exec command into the string a human would read. Codex sends
 *  the command as an argv array — usually a shell wrapper like
 *  ["bash","-lc","git status"] — so pull the script after -lc/-c; otherwise join
 *  the argv. A plain string passes through. Returns undefined for nothing. */
function codexCommand(command: any): string | undefined {
  if (command == null) return undefined;
  if (typeof command === 'string') return command.trim() || undefined;
  if (Array.isArray(command)) {
    const parts = command.map((x) => String(x));
    const flag = parts.findIndex((x) => x === '-lc' || x === '-c' || x === '-lic');
    if (flag >= 0 && parts[flag + 1] != null) return String(parts[flag + 1]).trim() || undefined;
    return parts.join(' ').trim() || undefined;
  }
  return undefined;
}

/**
 * Codex: rollout JSONL under ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. The
 * envelope has moved between releases (`payload` vs bare, `response_item` vs
 * typed rows), so this walks for the two shapes that have been stable — a
 * message with a role, and a function/tool call with a name — rather than
 * asserting a schema. Unverified against a live file; see the header note.
 */
function feedCodex(out: Timeline, r: any): boolean {
  // Unwrap the envelope. The rollout wrapper has moved between releases —
  // `payload`, `response_item`, a bare `item` — so try each rather than assume
  // one, or a whole session's tool calls render as nothing but prose.
  const p = r?.payload ?? r?.response_item ?? r?.item ?? r;
  const ts = r?.timestamp ?? p?.timestamp;
  const type = p?.type ?? p?.item_type;

  if (type === 'message' || p?.role) {
    const text = codexText(p?.content);
    if (!text) return false;
    if (p.role === 'user') {
      const cleaned = stripCodexPreamble(text);
      if (!cleaned) return false;
      const said = stripInjections(cleaned);
      if (!said.text) return false;
      out.say(said.text, ts, said.images);
      return true;
    }
    if (p.role !== 'assistant') return false;
    out.agentText(text, ts);
    return true;
  }
  // A tool RESULT: carry it back to the call it answers, so a Codex run shows
  // its output — the command with its result under it — the way Claude's does,
  // instead of a bare "Ran …" with nothing beneath it.
  if (type === 'function_call_output' || type === 'local_shell_call_output' || type === 'tool_result') {
    const id = p.call_id ?? p.id ?? p.tool_use_id;
    if (!id) return false;
    const out2 = p.output ?? p.result ?? p.content;
    // Attach the result even when the command printed nothing. A zero-stdout
    // run still finished, and marking it completed (with a "(no output)" body)
    // is the difference between a step that reads as done and one that looks
    // like it's still hanging — result() ignores an empty string, so give it a
    // placeholder rather than dropping the completion.
    const raw = typeof out2 === 'string' ? out2.trim() : resultText(out2);
    return out.result(String(id), raw || '(no output)', !!p.is_error);
  }

  // A tool CALL. Match the known type strings, but also fall back to the
  // tell-tale shape — a tool name, or a shell action/command — so a renamed or
  // newly-wrapped envelope still renders as a step instead of vanishing. This
  // is the parity fix: Codex tool calls that didn't match the old exact-type
  // check were dropped, leaving the Codex view prose-only while Claude showed
  // full Ran/Explored/Read steps.
  const looksLikeCall =
    type === 'function_call' || type === 'tool_call' || type === 'custom_tool_call' ||
    type === 'local_shell_call' || type === 'shell_call' ||
    (!type && (p?.name || p?.action || p?.command || p?.arguments));
  if (looksLikeCall) {
    // A call is a shell/exec if the row TYPE says so, the tool NAME says so
    // (Codex names it "exec"/"local_shell"/"container.exec"), or there's no name
    // but a command/action to run. Matching only on `type` before let a
    // name="exec" call fall through to a bare "Exec" chip (#21).
    const shellish = /shell|exec/i.test(String(type || '')) || /shell|exec/i.test(String(p.name || '')) || (!p.name && (p.action || p.command));
    let name = p.name ?? (shellish ? 'Bash' : 'Tool');
    let input: any = p.arguments ?? p.input ?? p.action ?? p.parameters ?? (p.command != null ? { command: p.command } : {});
    if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { command: input }; } }
    if (shellish) {
      // Route every shell/exec through the Bash humanizer, and flatten Codex's
      // argv command (["bash","-lc","git status"]) to the real command string
      // so the chip reads "Ran git status", not a JSON blob or bare "Exec".
      name = 'Bash';
      const cmd = codexCommand(input && (input.command ?? input.cmd));
      if (cmd != null) input = { ...input, command: cmd };
    }
    const a = humanize(name, input);
    const id = p.call_id ?? p.id;
    if (id) a.askId = String(id);
    out.agentAction(a, ts);
    return true;
  }
  // reasoning / thinking and anything else unrecognized: dropped, like Claude's
  // thinking blocks.
  return false;
}

/** Accumulates rows into turns: a user message opens an exchange, the agent's
 *  prose and actions stack under it in the order they happened. Consecutive
 *  actions merge into one strip so a 40-call stretch reads as a single line. */
class Timeline {
  private turns: Turn[] = [];
  /** Calls by tool_use id, so their results can be matched back later. */
  private byId = new Map<string, Action>();

  say(text: string, ts?: string, images = 0) {
    // Dedupe a user turn that a transcript recorded twice back-to-back with no
    // agent turn between — seen on the Codex path, where one submit could land
    // as two identical `you` rows. A genuine repeat has the agent answering in
    // between, so two identical user turns with nothing between them is a
    // double-record, not two real sends.
    const last = this.turns[this.turns.length - 1];
    if (last && last.actor === 'you' && last.blocks[0]?.type === 'text'
        && (last.blocks[0] as any).text === text) return;
    this.turns.push({ actor: 'you', blocks: [{ type: 'text', text }], ts, attachments: images || undefined });
  }

  agentText(text: string, ts?: string) {
    const t = text.trim();
    const blocks = this.agent(ts).blocks;
    // Skip an EXACT consecutive duplicate: the Codex rollout can re-emit the
    // same assistant message (as prior-turn input context on the next turn),
    // which would otherwise append it twice — growing the turn on each poll and
    // shifting the content under a reader. Identical back-to-back agent text is
    // never something the model actually wrote twice.
    const last = blocks[blocks.length - 1];
    if (last && last.type === 'text' && last.text === t) return;
    blocks.push({ type: 'text', text: t });
  }

  agentAction(a: Action, ts?: string) {
    // Skip a re-emitted call: the Codex rollout restates prior-turn items (its
    // tool calls included) as input context on later turns, and an overlapping
    // tail can hand the same rows back more than once. A tool call carries a
    // stable call_id, so one we've already recorded is a duplicate, never a
    // second real call (a genuine repeat gets a fresh id). Without this the
    // last turn's action strip GREW on every poll — the transcript signature
    // changed each time, so the view rebuilt the whole conversation DOM
    // constantly and a reader could never hold a scroll position (#20 leak).
    if (a.askId && this.byId.has(a.askId)) return;
    const blocks = this.agent(ts).blocks;
    if (a.askId) this.byId.set(a.askId, a);
    // A question is addressed to you; it never folds into the quiet work strip.
    if (a.kind === 'ask') {
      blocks.push({ type: 'ask', item: a });
      return;
    }
    const last = blocks[blocks.length - 1];
    if (last?.type === 'actions') last.items.push(a);
    else blocks.push({ type: 'actions', items: [a] });
  }

  /**
   * Carry a tool_result back to the call that produced it. Returns whether
   * anything changed — a result landing is a render-worthy event even though
   * the row it arrived on contributes no turn of its own.
   *
   * The text is capped hard. A Read of a large file comes back whole, and
   * keeping every byte of every result would make an hour-long session's
   * transcript resident in memory twice over. Six lines is enough to show
   * what happened; the file itself is a click away in the tree.
   */
  result(toolUseId: string, text: string, failed = false): boolean {
    const a = this.byId.get(toolUseId);
    if (!a || !text || a.result === text) return false;
    const lines = text.split('\n');
    a.resultLines = lines.length;
    a.result = lines.slice(0, RESULT_LINES).join('\n').slice(0, RESULT_CHARS);
    if (failed) a.failed = true;
    if (a.kind === 'ask') a.answer = text;
    return true;
  }

  private agent(ts?: string): Turn {
    const last = this.turns[this.turns.length - 1];
    if (last?.actor === 'agent') return last;
    const t: Turn = { actor: 'agent', blocks: [], ts };
    this.turns.push(t);
    return t;
  }

  done() { return this.turns.filter((t) => t.blocks.length > 0); }
}

function asBlocks(content: any): any[] {
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

/** A real user turn, or empty text for the harness talking to itself. */
function userText(content: any): { text: string; images: number } {
  if (typeof content === 'string') return stripInjections(content);
  if (!Array.isArray(content)) return { text: '', images: 0 };
  // Any tool_result in the array means this row is plumbing, not a person.
  if (content.some((b: any) => b?.type === 'tool_result')) return { text: '', images: 0 };
  const said = stripInjections(content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n'));
  // One attachment surfaces in BOTH shapes at once: a real `image` content
  // block AND an "[Image #N]" marker the harness writes into the text beside
  // it. Summing them double-counts — one dropped image reads as "2 images
  // attached". They describe the same set, so take the larger of the two
  // representations, never their sum.
  const imageBlocks = content.filter((b: any) => b?.type === 'image').length;
  said.images = Math.max(said.images, imageBlocks);
  return said;
}

function codexText(content: any): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => typeof b?.text === 'string')
    .map((b: any) => b.text)
    .join('\n')
    .trim();
}

/**
 * Codex staples its system preamble onto the FIRST user turn: the project's
 * AGENTS.md (usually wrapped in <user_instructions>, sometimes headed by a
 * "# AGENTS.md instructions" line), an <INSTRUCTIONS> block ("You are running
 * inside Spike…"), and an <environment_context> block (cwd, shell, timezone,
 * roots, permissions). None of it is something the person typed.
 *
 * Excise ONLY the preamble, and KEEP any real message the harness stapled after
 * it — dropping the whole turn would throw away the person's actual first words
 * when they ride along in the same row. Named blocks and the AGENTS.md heading
 * line are the markers; the residue is what the person said. Return '' only when
 * nothing real is left, so the caller drops a preamble-only turn.
 */
function stripCodexPreamble(s: string): string {
  return s
    // The tagged blocks, wherever they sit.
    .replace(/<(INSTRUCTIONS|environment_context|user_instructions)>[\s\S]*?<\/\1>/gi, '')
    // A leading "# AGENTS.md instructions" heading LINE — the marker only, so a
    // real instruction typed after it survives. (The AGENTS.md body itself is
    // carried inside <user_instructions> above in the shapes we've seen.)
    .replace(/^\s*#{0,6}\s*AGENTS\.md instructions[^\n]*\n?/i, '')
    .trim();
}

/**
 * Strip the machinery the harness staples onto a user turn, and count the
 * images the person actually attached.
 *
 * A lot rides on this. Claude Code writes slash-command echoes, task
 * notifications, system reminders, IDE state and image-cache pointers as
 * `type: "user"` rows — same shape as something a person typed. Left in, the
 * calm view fills with XML and reads worse than the terminal. So: strip every
 * known wrapper, then drop anything that is still nothing but a tag. Real prose
 * effectively never survives that test, and a false drop costs one message
 * while a false keep costs the whole premise.
 */
function stripInjections(s: string): { text: string; images: number } {
  let text = s
    .replace(/<(system-reminder|local-command-caveat|task-notification|ide_[a-z_]+)>[\s\S]*?<\/\1>/g, '')
    .replace(/<(command-name|command-message|command-args|command-contents|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g, '')
    // Named wrappers only. A catch-all for anything tag-shaped used to live
    // here, and it silently ate real content: "why is <Header /> broken" lost
    // the tag before it ever rendered. A stray harness tag slipping through is
    // a much smaller harm than deleting words someone actually wrote, so
    // unknown tags are now left alone. Any new wrapper gets named above.
    .replace(/^\s*<(system-reminder|local-command-caveat|task-notification)[\s\S]*$/i, '')
    // Interrupt / tool-rejection plumbing. When the person answers while a tool
    // is pending (e.g. clicking an elicitation option mid-tool), the harness
    // injects a "[Request interrupted by user …]" marker and a "The user doesn't
    // want to proceed with this tool use … STOP what you are doing …" rejection
    // block as message rows. Neither is something a person or the agent wrote —
    // they are the interrupt machinery talking to itself, so drop them (both
    // engines). Fixed harness strings, matched loosely on the apostrophe.
    .replace(/\[Request interrupted by user[^\]]*\]/gi, '')
    .replace(/The user does(?:n['’]?t| not) want to proceed with this tool use\.[\s\S]*?how to proceed\./gi, '')
    // `!` shell mode. Claude records the command you ran and everything it
    // printed as USER rows, so without this they arrive as your messages —
    // rendered as bubbles containing raw <bash-input> tags, and, worse,
    // counted as your recent messages when an optimistic bubble is matched
    // against the transcript. Four `!` commands is eight rows, which is the
    // whole matching window: a message you sent just before them never found
    // its landed copy and sat at the foot of the conversation for good. A
    // shell command you ran yourself is not a turn in this conversation.
    .replace(/<bash-(input|stdout|stderr)>[\s\S]*?<\/bash-\1>/g, '');

  // A skill run injects the whole SKILL.md as a USER row — "Base directory for
  // this skill: /…/skills/<name>\n\n# <heading> …". That's the skill's own
  // instructions, context the agent reads, not a message in this conversation.
  // The "Used a skill" activity chip already says it ran; drop the dump so the
  // calm view isn't a wall of the skill's markdown (see the verifier-web dump).
  if (/^\s*Base directory for this skill:/i.test(text)) text = '';

  // "[Image: source: /…/image-cache/…/11.png]" is the harness's pointer, not a
  // message; "[Image #11] it worked" is a real message with an attachment.
  const pointerOnly = /^\s*\[Image:[^\]]*\]\s*$/.test(text);
  let images = pointerOnly ? 0 : (text.match(/\[Image #\d+\]/g) || []).length;
  text = text.replace(/\[Image #\d+\]/g, '').replace(/\[Image:[^\]]*\]/g, '').trim();
  if (pointerOnly) text = '';

  return { text, images };
}

// ── Humanizer ───────────────────────────────────────────────────────────────

/**
 * Tool call → something a person who has never opened a terminal can read.
 *
 * The bar: no path unless it's a filename, no flags, no ids, no jargon. When a
 * tool carries its own human description (Bash does), prefer it — the agent
 * already wrote the sentence.
 */
export function humanize(name: string, input: any = {}): Action {
  const n = String(name || 'Tool');
  const base = (p: any) => (typeof p === 'string' ? p.split('/').filter(Boolean).pop() || p : undefined);
  const raw = (v: any) => (typeof v === 'string' ? v : v == null ? undefined : JSON.stringify(v));

  switch (n) {
    case 'Read':
    case 'NotebookRead':
      return { kind: 'read', verb: 'Read', gerund: 'Reading', gerundAlone: 'Reading a file', object: base(input.file_path ?? input.path), detail: raw(input.file_path ?? input.path) };
    case 'Write':
      return {
        kind: 'edit', verb: 'Created', gerund: 'Creating', gerundAlone: 'Creating a file',
        object: base(input.file_path), detail: raw(input.file_path),
        ...peek(input.content),
      };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'apply_patch':
      return {
        kind: 'edit', verb: 'Edited', gerund: 'Editing', gerundAlone: 'Editing a file',
        object: base(input.file_path ?? input.path), detail: raw(input.file_path ?? input.path),
        ...peek(input.new_string ?? input.new_source ?? input.patch),
        ...diffPeek(input.old_string, input.new_string),
      };
    case 'Bash':
    case 'shell':
    case 'local_shell':
    case 'exec': {
      const cmd = raw(input.command);
      // Claude writes a human description for every Bash call. It is better
      // than anything we could synthesize from the command line, so it wins —
      // "Check the runbook sections" beats "Ran npm".
      const desc = typeof input.description === 'string' ? input.description : undefined;
      // No description (Codex's exec never sends one): show the COMMAND itself
      // as the object — "Ran git status", not a bare "Exec" or the vague
      // "Ran a command git". feedCodex normalizes the argv array to a string.
      const short = cmd ? (cmd.length > 80 ? cmd.slice(0, 80) + '…' : cmd) : undefined;
      return {
        kind: 'run',
        verb: desc || 'Ran',
        gerund: desc || 'Running',
        object: desc ? undefined : short,
        detail: cmd,
        // The command itself IS the substance of a run, the same way the
        // terminal shows it. It goes in the preview, not just the tooltip.
        preview: cmd,
      };
    }
    case 'Glob':
    case 'Grep':
      return { kind: 'search', verb: 'Searched the project', gerund: 'Searching the project', object: raw(input.pattern), detail: raw(input.pattern) };
    case 'WebSearch':
      return { kind: 'web', verb: 'Searched the web', gerund: 'Searching the web', object: raw(input.query), detail: raw(input.query) };
    case 'WebFetch':
      return { kind: 'web', verb: 'Read a web page', gerund: 'Reading a web page', object: host(raw(input.url)), detail: raw(input.url) };
    case 'AskUserQuestion':
      return {
        kind: 'ask',
        verb: 'Asked you a question',
        gerund: 'Waiting on your answer',
        ask: normalizeAsk(input),
      };
    case 'Task':
    case 'Agent':
      return { kind: 'delegate', verb: 'Asked a helper', gerund: 'Waiting on a helper', object: raw(input.description), detail: raw(input.prompt) };
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return { kind: 'plan', verb: 'Updated the plan', gerund: 'Updating the plan', detail: raw(input), todos: normalizeTodos(input) };
    case 'Skill':
      return { kind: 'other', verb: 'Used a skill', gerund: 'Using a skill', object: raw(input.skill), detail: raw(input.args) };
    case 'ToolSearch':
      // The query is a machine string ("select:mcp__a__b,mcp__c__d"). Showing
      // it buys nothing and wraps the line; it stays in `detail`.
      return { kind: 'other', verb: 'Looked for a tool', gerund: 'Looking for a tool', detail: raw(input.query) };
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(n);
  if (mcp) return mcpAction(mcp[1], mcp[2], raw(input));

  return { kind: 'other', verb: titleize(n), gerund: titleize(n), detail: raw(input) };
}

/**
 * A tool name as the plain action it performs, for the permission panel:
 * "Allow the agent to <run this command>?". The point of this view is people
 * who don't know what "Bash" is, so the raw tool name is the last resort.
 */
export function toolLabel(tool: string): string {
  switch (tool) {
    case 'Bash': case 'shell': case 'local_shell': return 'run this command';
    case 'Read': case 'NotebookRead': return 'read this file';
    case 'Write': return 'create this file';
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': case 'apply_patch': return 'change this file';
    case 'WebFetch': return 'open this web page';
    case 'WebSearch': return 'search the web';
    case 'Glob': case 'Grep': return 'search the project';
    case 'Task': case 'Agent': return 'start a helper';
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp) return `use ${titleize(mcp[1].replace(/^claude[_-]?ai[_-]/i, '').split('__').pop() || mcp[1])}`;
  return `use ${tool}`;
}

/** "Read notes.md" — one action as a phrase, past tense. */
export function phrase(a: Action): string { return a.object ? `${a.verb} ${a.object}` : a.verb; }

/** "Reading notes.md" — the same action while it is still happening. */
export function nowPhrase(a: Action): string {
  if (a.object) return `${a.gerund} ${a.object}`;
  // A run has no gerund of its own: it reuses the agent's command description
  // ("Read the chat block", "Check the runbook"), written in the imperative.
  // Next to a live spinner that reads as past tense — "it already read it" —
  // the one action type that can't tell you it's still going. Frame it as in
  // progress without discarding the description, which is the informative part.
  if (a.kind === 'run' && a.gerund && a.gerund !== 'Running a command') {
    return `Working · ${a.gerund}`;
  }
  return a.gerundAlone || a.gerund;
}

/**
 * How many helpers the agent is parked on right now.
 *
 * A Task/Agent delegation (kind 'delegate') is a subagent — what Claude Code's
 * status line calls a "background agent". Its tool_result lands only when the
 * subagent finishes, so a delegate with no result yet is one the main agent is
 * waiting on. The terminal says "Waiting for N background agent to finish" in
 * exactly this state; the calm view was showing a bare "Thinking", which reads
 * as the model generating when it is actually blocked on a helper.
 *
 * It is NOT enough to look at the last turn: a background agent is dispatched
 * and then the main agent keeps talking ("I'll report back"), and if the person
 * interjects, the unresolved delegation lands in an earlier agent turn while a
 * later one holds only prose. So count every delegation whose result never
 * arrived, wherever it sits — a resolved one carries its result and drops out,
 * so only the genuinely-open helpers are counted.
 */
export function openDelegateCount(turns: Turn[]): number {
  let n = 0;
  for (const t of turns) {
    if (t.actor !== 'agent') continue;
    for (const b of t.blocks) {
      if (b.type !== 'actions') continue;
      for (const a of b.items) {
        if (a.kind === 'delegate' && a.result === undefined && !a.failed) n++;
      }
    }
  }
  return n;
}

/**
 * The lifecycle of composer attachments, as pure data so it is testable without
 * a DOM.
 *
 * Staged attachments are HELD — retractable — until the message they belong to
 * is committed. This is what makes the chip's × real: `stage` hands back a
 * disposer that removes the attachment before it is ever bound to a message, so
 * a removed file never reaches the delivery step. `commit` binds the current
 * staged set to the message being sent (in order) and starts a clean slate, so
 * each queued message carries its own files and the next one begins empty. The
 * queued sets come back out FIFO via `next`, stay index-aligned with the
 * message queue for `cancelAt`, and `clear` drops everything on a stop.
 */
export class AttachmentQueue<T> {
  private staged: T[] = [];
  private queued: T[][] = [];
  /** Hold an attachment; the returned disposer retracts it if called pre-commit. */
  stage(a: T): () => void {
    this.staged.push(a);
    return () => { const i = this.staged.indexOf(a); if (i >= 0) this.staged.splice(i, 1); };
  }
  /** What is staged right now (a copy) — for a fresh tray, or a test. */
  pending(): T[] { return this.staged.slice(); }
  /** Bind the staged set to the message being sent; the composer starts clean. */
  commit(): void { this.queued.push(this.staged); this.staged = []; }
  /** The next committed message's attachments, off the front. */
  next(): T[] { return this.queued.shift() || []; }
  /** Drop the attachments bound to the queued message at index i (a cancel). */
  cancelAt(i: number): void { if (i >= 0 && i < this.queued.length) this.queued.splice(i, 1); }
  /** Forget everything staged and queued (a stop). */
  clear(): void { this.staged = []; this.queued = []; }
}

/** Whitespace a message can pick up passing through the pty, made comparable
 *  WITHOUT collapsing newlines — two messages that differ only by a line break
 *  must stay distinct, or sending one would clear the other. Tolerates CRLF↔LF,
 *  runs of spaces/tabs, and leading/trailing space around each line. */
function reflowKey(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

/**
 * Reconcile the optimistic "pending" bubbles against the user turns the
 * transcript has actually absorbed, one-to-one.
 *
 * The pending list is what we painted the instant the person hit send, before
 * the agent's transcript caught up. A pending item is cleared only when a
 * transcript turn matches it — but each transcript turn may clear AT MOST ONE
 * pending item: without that, two near-identical queued messages both matched a
 * single landed turn and the unsent one was wrongly evicted (and, worse, its
 * "SENT ✓" chip vanished while the message was never delivered). Exact matches
 * are consumed before reflow-tolerant ones so the surest evidence wins.
 *
 * A third, weakest tier catches a "leaked-prefix" corruption seen on the Codex
 * path: the transcript's own copy of the turn arrives with a partial repeat of
 * its own start ("what's on deck" recorded as "whatwhat's on deck"). That never
 * matches exactly, so the optimistic clean bubble used to linger BESIDE the
 * corrupted transcript turn — two bubbles for one send. When a recent turn is
 * exactly the pending text with a prefix-of-itself prepended, treat it as the
 * same turn so the duplicate collapses. It is deliberately narrow (the extra
 * must be a prefix of the message) to avoid matching unrelated messages.
 */
function leakedPrefixOf(pn: string, tn: string): boolean {
  if (tn.length <= pn.length || !tn.endsWith(pn)) return false;
  const extra = tn.slice(0, tn.length - pn.length);
  return extra.length > 0 && pn.startsWith(extra);
}

/**
 * The reading order of the conversation, with late-filed messages put back
 * where they were said.
 *
 * A message typed while the agent is mid-answer is not written to the
 * transcript when you send it — Claude files it when it PICKS IT UP, which is
 * after the answer that was already streaming. Read back, your question sits
 * under a reply it did not prompt, and its own reply is somewhere below that.
 * The transcript cannot fix this: it never knew when you typed.
 *
 * Spike does know — it painted the bubble the moment you hit send — and passes
 * that position in `anchored`.
 *
 * The cut is per BLOCK, not per turn, because the answer you interrupted keeps
 * growing inside the turn it already owns: Claude appends the rest of its prose
 * to the same turn, so moving whole turns around would leave your message after
 * the whole answer anyway — exactly where it started. So an agent turn with a
 * message anchored inside it is emitted as two turns with the message between
 * them, which is what actually happened.
 *
 * Everything else keeps the transcript's own order, and every piece keeps its
 * true turn index so freshness, the reveal and the copy button still line up.
 */
export interface Piece { turn: Turn; i: number; blocks: Block[]; tail: boolean }

export function anchorPlan(
  turns: Turn[],
  anchored?: Map<number, { turn: number; block: number }>,
): Piece[] {
  const whole = (i: number): Piece => ({ turn: turns[i], i, blocks: turns[i].blocks, tail: true });
  if (!anchored || !anchored.size) return turns.map((_, i) => whole(i));
  // Only a cut that lands strictly EARLIER than where the transcript filed the
  // message is a move; anything else is already in the right place.
  const cuts: Array<{ landed: number; at: number; block: number }> = [];
  for (const [landed, point] of anchored) {
    if (!turns[landed] || !turns[point.turn]) continue;
    if (point.turn > landed || (point.turn === landed && point.block > 0)) continue;
    cuts.push({ landed, at: point.turn, block: point.block });
  }
  if (!cuts.length) return turns.map((_, i) => whole(i));
  // A BATCH sent while the agent streamed — two messages typed at the same
  // instant — carries the same typed point, so both would cut there and STACK
  // together with their answers detached below: [Q1][Q2]…[A1][A2]. Anchor only
  // the FIRST to land at each point; the rest stay in transcript order, so each
  // question reads next to its own answer: [Q1]…[A1][Q2][A2]. Keep the
  // earliest-landing cut per (turn, block); the others fall through to whole().
  const firstPerPoint = new Map<string, { landed: number; at: number; block: number }>();
  for (const c of cuts) {
    const key = c.at + ':' + c.block;
    const prev = firstPerPoint.get(key);
    if (!prev || c.landed < prev.landed) firstPerPoint.set(key, c);
  }
  const anchoredCuts = [...firstPerPoint.values()];
  const movedAway = new Set(anchoredCuts.map((c) => c.landed));
  const out: Piece[] = [];
  for (let t = 0; t < turns.length; t++) {
    if (movedAway.has(t)) continue;                     // it is rendered at its cut instead
    const here = anchoredCuts.filter((c) => c.at === t).sort((a, b) => a.block - b.block);
    if (!here.length) { out.push(whole(t)); continue; }
    let cursor = 0;
    for (const c of here) {
      const b = Math.max(cursor, Math.min(c.block, turns[t].blocks.length));
      const seg = turns[t].blocks.slice(cursor, b);
      if (seg.length) out.push({ turn: turns[t], i: t, blocks: seg, tail: false });
      out.push(whole(c.landed));
      cursor = b;
    }
    const rest = turns[t].blocks.slice(cursor);
    // The remainder carries the turn's tail furniture (the copy row) even when
    // it is empty of blocks, so an interruption never costs a turn its actions.
    if (rest.length || !out.some((pc) => pc.i === t)) {
      out.push({ turn: turns[t], i: t, blocks: rest, tail: true });
    }
  }
  return out;
}

// ── drafts: a composed artifact, not a wall of chat prose ─────────────────
// When the agent WRITES something for you — a cold email, a message, a post —
// it arrives as flat markdown pasted into the conversation, indistinguishable
// from its commentary about the draft. splitDrafts finds those runs so the view
// can render each one as its own editable card (edit in place, copy, hand your
// version back), the way ChatGPT's canvas-lite drafts read.
//
// Two triggers, on purpose:
//   1. An explicit fence — ```draft / ```email / ```message / … — which an agent
//      told about the convention can emit deliberately.
//   2. Shape, for every agent that wasn't told: a run that opens with a
//      "Subject:" line or a greeting ("Hi [Name] —") and closes with a sign-off
//      ("Best,\nAnnamarie" / "— Annamarie"), an <hr>, or the end of the message.
//
// A run must be at least MIN_DRAFT_BLOCKS blocks — a bare "Hi Sam," in passing
// is a sentence, not a draft — and code fences are never scanned into.
export interface DraftSeg { draft: boolean; md: string }

const DRAFT_FENCE = /^\s*```+\s*(draft|email|message|post|letter)\b/i;
const FENCE = /^\s*(```+|~~~+)/;
const SUBJECT = /^\s*(?:\*\*|__)?\s*subject\s*:/i;
const GREETING = /^\s*(?:hi|hey|hello|dear|good (?:morning|afternoon|evening))\b[^\n]{0,80}$/i;
const SIGNOFF = /^\s*(?:—|--|–)\s*\S|^\s*(?:best|thanks|thank you|cheers|sincerely|warmly|regards|best regards|talk soon)\b[,.!]?\s*$/i;
const HR = /^\s*(?:---+|\*\*\*+|___+)\s*$/;
const HEADING = /^\s*#{1,6}\s/;
const MIN_DRAFT_BLOCKS = 3;

// The message split into blank-line-separated blocks, with a fenced code block
// (however many blank lines it contains) kept whole as ONE block.
function mdBlocks(text: string): string[] {
  const lines = text.split('\n');
  const blocks: string[] = [];
  let cur: string[] = [];
  let fence: string | null = null;
  const flush = () => { const b = cur.join('\n'); if (b.trim()) blocks.push(b.replace(/\s+$/, '')); cur = []; };
  for (const ln of lines) {
    const f = FENCE.exec(ln);
    if (fence) {
      cur.push(ln);
      if (f && ln.trim().startsWith(fence)) { fence = null; flush(); }
      continue;
    }
    if (f) { flush(); fence = f[1][0].repeat(3); cur.push(ln); continue; }
    if (!ln.trim()) { flush(); continue; }
    cur.push(ln);
  }
  if (fence) flush();   // unterminated fence — still one block
  else flush();
  return blocks;
}

const isFenced = (b: string) => FENCE.test(b);
// Strip the ```draft wrapper, leaving the draft body as plain markdown.
function unfence(b: string): string {
  const lines = b.split('\n');
  if (lines.length && FENCE.test(lines[0])) lines.shift();
  if (lines.length && FENCE.test(lines[lines.length - 1])) lines.pop();
  return lines.join('\n').trim();
}

// Did the PERSON ask for something to be written? Shape alone can't separate a
// two-line draft ("Hey! Just wanted to say hi…") from a two-line conversational
// reply — they are the same shape. The ask disambiguates: when the request was
// "write me an email", the reply IS the artifact, however short it is.
const ASK_VERBS = ['write', 'draft', 'compose', 'craft', 'rewrite', 'reword', 'send', 'give', 'make', 'word'];
const ASK_NOUNS = ['email', 'emails', 'message', 'messages', 'note', 'notes', 'post', 'posts', 'tweet',
  'intro', 'introduction', 'letter', 'reply', 'blurb', 'bio', 'outreach', 'pitch', 'subject', 'dm'];
// One edit apart, counting a transposition as one ("gvie" → "give"). Fuzzy only
// kicks in from five letters up, so short words still have to match exactly —
// "most" must not read as "post". This exists because the ask is typed fast and
// full of typos ("gvie me a 2 setnce emal"), and a missed typo would silently
// turn a draft back into a wall of chat text.
function nearWord(a: string, b: string, minLen = 5): boolean {
  if (a === b) return true;
  if (Math.max(a.length, b.length) < minLen) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  // transposition of adjacent letters
  if (a.length === b.length) {
    let diff = -1;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      if (diff >= 0) {
        return diff === i - 1 && a[diff] === b[i] && a[i] === b[diff]
          && a.slice(i + 1) === b.slice(i + 1);
      }
      diff = i;
    }
    return diff >= 0;
  }
  // one insertion / deletion
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  for (let i = 0; i < long.length; i++) {
    if (long.slice(0, i) + long.slice(i + 1) === short) return true;
  }
  return false;
}
export function asksForDraft(text: string): boolean {
  const toks = ((text || '').slice(0, 400).toLowerCase().match(/[a-z][a-z'-]*/g) || []);
  if (!toks.length) return false;
  if (toks.some((t) => nearWord(t, 'draft'))) return true;
  // Verbs tolerate a typo from four letters ("gvie" → "give"); nouns hold the
  // line at five, since a fuzzy four-letter noun ("node" → "note") is exactly
  // how an ordinary reply would get mistaken for a draft.
  return toks.some((t) => ASK_VERBS.some((v) => nearWord(t, v, 4)))
    && toks.some((t) => ASK_NOUNS.some((n) => nearWord(t, n)));
}

// Lead-in ("Here's a draft —", "Sure:") and tail-offer ("Want me to shorten
// it?") blocks are the agent TALKING, not the artifact. In asked-mode they get
// peeled off the ends so the card holds the draft and nothing else.
const LEAD_IN = /^\s*(?:here(?:'|’)?s|here is|sure|of course|got it|okay|ok|absolutely|happy to)\b/i;
const TAIL_OFFER = /^\s*(?:want|would you like|let me know|i can|happy to|shall i|should i|tell me)\b/i;

export function splitDrafts(text: string, opts?: { asked?: boolean }): DraftSeg[] {
  const blocks = mdBlocks(text || '');
  const segs: DraftSeg[] = [];
  const pushText = (md: string) => {
    const last = segs[segs.length - 1];
    if (last && !last.draft) last.md += '\n\n' + md;
    else segs.push({ draft: false, md });
  };
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    // 1. Explicitly tagged.
    if (DRAFT_FENCE.test(b)) { segs.push({ draft: true, md: unfence(b) }); continue; }
    if (isFenced(b)) { pushText(b); continue; }             // ordinary code — never a draft
    // 2. Shape. Find where this run would END before committing to it.
    const opens = SUBJECT.test(b) || GREETING.test(b);
    if (!opens) { pushText(b); continue; }
    let end = -1;                                            // last block of the draft (inclusive)
    for (let j = i; j < blocks.length; j++) {
      const nb = blocks[j];
      if (j > i && (HR.test(nb) || HEADING.test(nb) || DRAFT_FENCE.test(nb))) { end = j - 1; break; }
      if (j > i && SIGNOFF.test(nb)) { end = j; break; }     // sign-off closes it, inclusive
      if (j === blocks.length - 1) end = j;                  // ran to the end of the message
    }
    // A closing offer ("Want me to make it shorter?") is the agent talking, not
    // part of the letter — never let it ride inside the card.
    while (end > i && TAIL_OFFER.test(blocks[end])) end--;
    const n = end - i + 1;
    if (end < i || n < MIN_DRAFT_BLOCKS) { pushText(b); continue; }
    segs.push({ draft: true, md: blocks.slice(i, end + 1).join('\n\n') });
    i = end;
  }
  const out = segs.filter((sg) => sg.md.trim());
  // Asked-mode fallback: the person asked for a written thing and the shape scan
  // found no draft (a short one has no sign-off and no Subject: line). Take the
  // reply itself as the artifact, minus the agent's own framing at either end.
  if (opts && opts.asked && !out.some((sg) => sg.draft)) {
    const body = blocks.slice();
    while (body.length && (LEAD_IN.test(body[0]) && body[0].length < 200 || isFenced(body[0]) === false && /:\s*$/.test(body[0]) && body[0].length < 200)) body.shift();
    while (body.length && TAIL_OFFER.test(body[body.length - 1])) body.pop();
    // A draft has to say something: at least one block that isn't a question
    // back to you ("Sure — what tone?" is a conversation, not a draft).
    const substantive = body.filter((b) => !/\?\s*$/.test(b) && b.trim().length > 12);
    if (body.length && substantive.length) {
      const lead = blocks.slice(0, blocks.indexOf(body[0]));
      const tail = blocks.slice(blocks.indexOf(body[body.length - 1]) + 1);
      const res: DraftSeg[] = [];
      if (lead.length) res.push({ draft: false, md: lead.join('\n\n') });
      res.push({ draft: true, md: body.join('\n\n') });
      if (tail.length) res.push({ draft: false, md: tail.join('\n\n') });
      return res;
    }
  }
  return out;
}

export function reconcilePending(pending: string[], recentYouTexts: string[]): { kept: string[]; landed: string[]; pairs: Array<{ pending: number; recent: number }> } {
  // Carry each candidate's ORIGINAL position: matches are consumed out of the
  // pool as they are used, so a bare index into the shrinking pool would point
  // at the wrong turn. The caller needs the true one to put a late-filed
  // message back where it was said (see anchorOrder).
  const pool = recentYouTexts.map((s, at) => ({ at, exact: s.trim(), reflow: reflowKey(s) }));
  const kept: string[] = [];
  const landed: string[] = [];
  const pairs: Array<{ pending: number; recent: number }> = [];
  const take = (idx: number, p: string, pi: number) => {
    pairs.push({ pending: pi, recent: pool[idx].at });
    pool.splice(idx, 1);
    landed.push(p);
  };
  pending.forEach((p, pi) => {
    const ex = pool.findIndex((r) => r.exact === p.trim());
    if (ex >= 0) { take(ex, p, pi); return; }
    const pn = reflowKey(p);
    const rf = pool.findIndex((r) => r.reflow === pn);
    if (rf >= 0) { take(rf, p, pi); return; }
    const lk = pool.findIndex((r) => leakedPrefixOf(pn, r.reflow));
    if (lk >= 0) { take(lk, p, pi); return; }
    // Attachments wrap the typed text on BOTH ends — image refs are prepended
    // ("[Image #1] …") and a dropped folder's path is appended (" /Users/…/x")
    // — so the landed turn neither equals nor is a clean prefix of the pending
    // text. Match when the landed turn simply CONTAINS the pending text, which
    // an attachment-decorated send always does. Guarded by length so a short
    // "ok"/"yes" can't latch onto an unrelated long turn.
    const ct = pn.length >= 8 ? pool.findIndex((r) => r.reflow.includes(pn)) : -1;
    if (ct >= 0) { take(ct, p, pi); return; }
    kept.push(p);
  });
  return { kept, landed, pairs };
}

/**
 * A connected-service call, named the way a person would say it.
 *
 * The raw tool name is unreadable — `mcp__claude_ai_Slack__slack_search_public_and_private`
 * titleized lands on "Used Claude ai Slack slack search public and private",
 * which is worse than saying nothing. So: drop the harness's `claude_ai_`
 * prefix to get the service, drop the method's redundant repeat of that
 * service, and map the leading token to a verb. The result is "Searched Slack".
 */
function mcpAction(server: string, method: string, detail?: string): Action {
  const svc = titleize(
    server.replace(/^claude[_-]?ai[_-]/i, '').replace(/[_-]mcp$/i, '').split('__').pop() || server,
  );
  const mark = serviceMark(server, svc);
  const words = method.split(/[_-]+/).filter(Boolean);
  // "slack_search_public_and_private" under the Slack server — the repeat adds
  // nothing once the service is named.
  if (words.length > 1 && words[0].toLowerCase() === svc.toLowerCase().replace(/\s+/g, '')) words.shift();

  const VERBS: Record<string, [string, string]> = {
    search: ['Searched', 'Searching'], query: ['Searched', 'Searching'], find: ['Searched', 'Searching'],
    read: ['Read', 'Reading'], get: ['Looked up', 'Looking up'], list: ['Listed', 'Listing'],
    fetch: ['Read', 'Reading'], send: ['Sent a message in', 'Sending a message in'],
    post: ['Posted in', 'Posting in'], create: ['Created something in', 'Creating something in'],
    update: ['Updated something in', 'Updating something in'], save: ['Saved something in', 'Saving something in'],
    delete: ['Removed something in', 'Removing something in'],
  };
  const hit = VERBS[(words[0] || '').toLowerCase()];
  if (!hit) return { kind: 'web', verb: `Used ${svc}`, gerund: `Using ${svc}`, detail, mark };
  // What is left after the verb names the thing ("issues", "channel"). Two
  // words at most: past that it stops describing and starts listing
  // ("public and private"), which is the method name leaking through again.
  const rest = words.slice(1);
  let object = rest.length && rest.length <= 2 ? rest.join(' ').toLowerCase() : undefined;
  const verb = `${hit[0]} ${svc}`;
  // Some verb phrases already name their object ("Sent a message in Slack"),
  // so appending it again gives "Sent a message in Slack message".
  if (object && rest.some((w) => verb.toLowerCase().includes(w.toLowerCase()))) object = undefined;
  return { kind: 'web', verb, gerund: `${hit[1]} ${svc}`, object, detail, mark };
}

/**
 * The mark for a connected service. Logo when we ship one for it, else the
 * first letter of the service name as we just printed it — so the mark and the
 * label always agree ("Sonar" → S).
 */
function serviceMark(server: string, svc: string): Mark | undefined {
  const key = connectorLogoKey(server);
  if (key) return { key, logo: CONNECTOR_LOGOS[key] };
  const letter = (/[a-z0-9]/i.exec(svc) || [''])[0].toUpperCase();
  return letter ? { key: `.${letter}`, monogram: letter } : undefined;
}

/**
 * AskUserQuestion's input, defensively. The shape has been stable
 * (`{questions: [{question, header, options: [{label, description}], multiSelect}]}`)
 * but this panel is the one place where a schema drift would show the person a
 * blank box instead of the question they need to answer, so every field is
 * treated as optional and a question with no options still renders its text.
 */
function normalizeAsk(input: any): AskQuestion[] {
  const raw = Array.isArray(input?.questions) ? input.questions : [input];
  const out: AskQuestion[] = [];
  for (const q of raw) {
    const text = typeof q?.question === 'string' ? q.question : '';
    if (!text) continue;
    const options: AskOption[] = (Array.isArray(q.options) ? q.options : [])
      .map((o: any) => (typeof o === 'string'
        ? { label: o }
        : { label: String(o?.label ?? ''), description: typeof o?.description === 'string' ? o.description : undefined }))
      .filter((o: AskOption) => o.label);
    out.push({
      question: text,
      header: typeof q.header === 'string' ? q.header : undefined,
      multi: !!q.multiSelect,
      options,
    });
  }
  return out;
}

/**
 * TodoWrite's list, defensively, reduced to {text, status}. The field has been
 * `todos: [{content, status, activeForm}]` but this feeds a pinned strip, so —
 * like normalizeAsk — every field is optional and an unreadable shape yields no
 * strip rather than a broken one. Statuses collapse to the three the checklist
 * draws; anything unrecognised reads as pending (not-done is the safe default).
 */
function normalizeTodos(input: any): Todo[] | undefined {
  const rows = Array.isArray(input?.todos) ? input.todos
    : Array.isArray(input?.tasks) ? input.tasks : null;
  if (!rows) return undefined;
  const out: Todo[] = [];
  for (const t of rows) {
    const text = typeof t?.content === 'string' ? t.content
      : typeof t?.title === 'string' ? t.title
      : typeof t?.text === 'string' ? t.text : '';
    if (!text.trim()) continue;
    const s = String(t?.status || '').toLowerCase();
    const status: Todo['status'] =
      s === 'completed' || s === 'done' ? 'completed'
      : s === 'in_progress' || s === 'active' || s === 'doing' ? 'in_progress'
      : 'pending';
    out.push({ text: text.trim(), status });
  }
  return out.length ? out : undefined;
}

/**
 * The current plan: the most recent TodoWrite's list. Claude re-emits the whole
 * list on every write, so the last one IS the live state — no accumulation
 * needed. Returns null when nothing is left to do (all completed), because a
 * pinned strip of struck-through lines is clutter once the work is done.
 */
export function latestTodos(turns: Turn[]): Todo[] | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const blocks = turns[i].blocks;
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j];
      if (b.type !== 'actions') continue;
      for (let k = b.items.length - 1; k >= 0; k--) {
        const todos = b.items[k].todos;
        if (todos && todos.length) {
          return todos.some((t) => t.status !== 'completed') ? todos : null;
        }
      }
    }
  }
  return null;
}

/** A plan step with the work that ran under it — see {@link stepsWithActions}. */
export interface Step { text: string; status: Todo['status']; actions: Action[] }

/**
 * The live plan, each step carrying the tool calls that happened WHILE it was
 * the in-progress one — so "what is the agent actually doing" is answerable at a
 * glance, and each step opens to the reads/edits/commands it took.
 *
 * Claude re-emits the whole todo list on every TodoWrite, flipping one item to
 * in_progress at a time; the tool calls between one write and the next belong to
 * whichever step was active then. So we walk every block in order, and whenever a
 * TodoWrite names a new in-progress step we start attributing subsequent actions
 * to it. Steps are keyed by text (stable across re-emits). Returns null on the
 * same terms as {@link latestTodos} — nothing to show once it's all done — so the
 * panel disappears rather than lingering as a list of struck-through lines.
 */
export function stepsWithActions(turns: Turn[]): Step[] | null {
  const todos = latestTodos(turns);
  if (!todos) return null;
  const buckets = new Map<string, Action[]>();
  for (const t of todos) buckets.set(t.text, []);
  let active: string | null = null;
  for (const turn of turns) {
    for (const b of turn.blocks) {
      if (b.type !== 'actions') continue;
      for (const it of b.items) {
        if (it.todos && it.todos.length) {
          // A plan write: the step it marks in_progress becomes the one that
          // owns the work that follows (only if it's a step we still show).
          const ip = it.todos.find((t) => t.status === 'in_progress');
          active = ip && buckets.has(ip.text) ? ip.text : active;
          continue;
        }
        // A real tool call (not the plan write, not a question) is attributed to
        // whichever step is active. Only a CURRENT step is ever active (see above),
        // so work done before the plan named a step — or under a DIFFERENT, earlier
        // plan — stays unattributed rather than being force-fit under step one. The
        // Home view keeps showing that work in its chronological trail (it folds
        // into the steps panel only the calls that a step actually owns).
        if (it.kind === 'ask') continue;
        if (active) buckets.get(active)!.push(it);
      }
    }
  }
  return todos.map((t) => ({ text: t.text, status: t.status, actions: buckets.get(t.text) || [] }));
}

/** Lines of an edit's two sides kept for the inline diff peek. */
const DIFF_LINES = 6;

/**
 * An edit's before/after, capped, so a change can render as a diff. Both sides
 * are already in the tool call; capping keeps a large replacement from parking
 * a whole file in memory (peek does the same for what was written).
 */
function diffPeek(oldStr: any, newStr: any): Partial<Action> {
  if (typeof newStr !== 'string' || !newStr) return {};
  const del = typeof oldStr === 'string' ? oldStr.split('\n') : [];
  const add = newStr.split('\n');
  return {
    diffDel: del.slice(0, DIFF_LINES).join('\n'),
    diffDelMore: Math.max(0, del.length - DIFF_LINES),
    diffAdd: add.slice(0, DIFF_LINES).join('\n'),
    diffAddMore: Math.max(0, add.length - DIFF_LINES),
  };
}

/** Lines of a result kept in memory, and the hard character ceiling on them. */
const RESULT_LINES = 6;
const RESULT_CHARS = 600;
/** Lines of written content shown in an expanded step. */
const PREVIEW_LINES = 5;

/**
 * The first few lines of what was written, plus how big the whole thing was.
 *
 * This is the single biggest thing the terminal gives you that a bare
 * "Created playbook.ts" does not: the scale of the change and a glimpse of
 * what actually went in. Cheap to compute — the content is already in the
 * tool call's input — and it turns the expanded view from a repeat of the
 * label into something worth expanding.
 */
function peek(content: any): Partial<Action> {
  if (typeof content !== 'string' || !content) return {};
  const lines = content.split('\n');
  return {
    magnitude: `${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`,
    preview: lines.slice(0, PREVIEW_LINES).join('\n').slice(0, RESULT_CHARS),
    previewMore: Math.max(0, lines.length - PREVIEW_LINES),
  };
}

const firstWord = (s?: string) => (s ? s.trim().split(/\s+/)[0] : undefined);
const host = (u?: string) => { try { return u ? new URL(u).hostname.replace(/^www\./, '') : undefined; } catch { return u; } };
const titleize = (s: string) =>
  s.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^\w/, (c) => c.toUpperCase());

/**
 * The collapsed line for a run of actions, as icon + text parts.
 *
 * A short run is named, not counted: "2 commands run" tells you nothing, while
 * "Check the runbook sections · List the tools" tells you what happened. Only
 * once a run is long enough that naming every step would be a wall does it fall
 * back to counts — and even then the files that CHANGED are named, because a
 * changed file is the thing a person actually wants to know about.
 */
export function summaryParts(items: Action[]): Array<{ kind: Action['kind']; text: string; mark?: Mark }> {
  if (!items.length) return [{ kind: 'other', text: 'Worked on it' }];
  // A named step carries its size when we know it: "Created playbook.ts ·
  // 126 lines" is the difference between knowing a file appeared and knowing
  // how much work went into it.
  if (items.length <= NAMED_MAX) {
    return items.map((a) => ({
      kind: a.kind,
      text: a.magnitude ? `${phrase(a)} · ${a.magnitude}` : phrase(a),
      mark: a.mark,
    }));
  }

  const of = (k: Action['kind']) => items.filter((a) => a.kind === k);
  const parts: Array<{ kind: Action['kind']; text: string; mark?: Mark }> = [];

  const edits = of('edit');
  const names = [...new Set(edits.map((a) => a.object).filter(Boolean))] as string[];
  if (edits.length && names.length && names.length <= 2) {
    parts.push({ kind: 'edit', text: `Changed ${names.join(' and ')}` });
  } else if (edits.length) {
    parts.push({ kind: 'edit', text: `${edits.length} files changed` });
  }

  const count = (kinds: Action['kind'][], one: string, many: string) => {
    const hits = kinds.flatMap(of);
    if (!hits.length) return;
    // A counted run keeps its mark when every step was the same service — five
    // Sonar calls are still Sonar, and the logo says so where "5 lookups" can't.
    const same = new Set(hits.map((a) => a.mark?.key)).size === 1;
    parts.push({
      kind: kinds[0],
      text: hits.length === 1 ? one : `${hits.length} ${many}`,
      mark: same ? hits[0].mark : undefined,
    });
  };
  count(['read'], 'Read a file', 'files read');
  count(['run'], 'Ran a command', 'commands run');
  count(['search', 'web'], 'Looked something up', 'lookups');
  count(['delegate'], 'Asked a helper', 'helpers asked');
  count(['plan', 'other'], 'One more step', 'other steps');
  return parts;
}

/** How many actions can be named before a run collapses to counts. */
const NAMED_MAX = 3;

/** The collapsed line as plain text (what the parts read as, joined). */
export function summarize() { return ''; }
export interface RenderOpts {
  /** Inject a real markdown renderer (Spike vendors marked + DOMPurify). */
  markdown?: (src: string) => string;
  /** Show the timeline mid-flight: a live status line under the last turn. */
  working?: boolean;
  /**
   * What it is doing right now, present tense ("Reading notes.md"). Three
   * anonymous dots tell you the machine is alive; they don't tell you it is
   * reading your file, which is the thing that makes waiting feel fine. Falls
   * back to "Thinking" when the caller has nothing specific.
   */
  status?: string;
  /** Which mark to show beside the status. */
  statusKind?: Action['kind'];
  /** The service's own mark, when the live tool is a call into one. */
  statusMark?: Mark;
  /**
   * The person answered a question panel — see {@link AskAnswer}. This module
   * never touches a pty; the caller turns the answer into the keystrokes the
   * TUI wants (a digit for a single pick, an Escape + typed text otherwise).
   * The old design loaded the label into the composer and let the person send
   * it, because we didn't know what the select wanted; we do now (the digit
   * select-and-submits), so a single pick answers on the click.
   */
  onAnswer?: (ans: AskAnswer) => void;
  /** Epoch ms the current turn started, for the elapsed clock. */
  since?: number;
  /** One line under the empty state, e.g. what engine this lane runs. */
  emptyHint?: string;
  /**
   * A few concrete things to ask, shown as clickable rows in the empty state.
   *
   * "Type below to get started" is still a blank canvas to someone who has
   * never driven an agent — the hard part was never the typing, it was knowing
   * what is even askable. A handful of real openers turns the empty page into a
   * menu. Clicking one loads it into the composer (via onStarter) rather than
   * firing it, for the same reason onPick does: the words stay theirs to edit
   * or send, and they learn the shape of a request by watching it land.
   */
  starters?: string[];
  /** A starter row was clicked. The caller decides what that means. */
  onStarter?: (text: string) => void;
  /**
   * Messages typed here that the transcript hasn't caught up to yet.
   *
   * A message goes to the pty instantly but only reaches the transcript once
   * the agent picks it up — which, if it is mid-turn, can be a while. Without
   * these the view swallowed what you just typed and showed a spinner instead,
   * which reads as "it ignored me". Rendered muted, and marked queued when
   * more than one is waiting.
   */
  pending?: string[];
  /**
   * Thumbnails a message was sent WITH, looked up by its text. Applied to both
   * the optimistic pending bubble and the landed "you" turn, so an image you
   * attached stays visible in the conversation instead of vanishing on send.
   */
  attFor?: (text: string) => Array<{ thumb?: string; name: string }> | undefined;
  /**
   * Where a late-filed message actually belongs: the index of the turn the
   * transcript filed it as → the cut it should be read at, as a turn index and
   * a block position within that turn.
   *
   * Claude writes a message you typed mid-turn into the transcript when it
   * picks the message up, not when you sent it — so your question lands under
   * an answer it did not prompt. Spike knows the real moment (it painted the
   * bubble when you hit send) and passes it here. See anchorPlan.
   */
  anchored?: Map<number, { turn: number; block: number }>;
  /** Of those, the ones not yet written to the pty — still cancellable. */
  cancellable?: string[];
  /** Take a queued message back. */
  onCancel?: (text: string) => void;
  /**
   * The history could not be read. Shown as a banner, never swallowed.
   *
   * Swallowing this was the worst bug in the view: a failing read left a blank
   * rectangle forever, indistinguishable from a brand-new session, with
   * nothing to act on. Whoever this view is for cannot debug that.
   */
  error?: string;
  /** Try the read again. */
  onRetry?: () => void;
  /**
   * How many turns from the end to actually render.
   *
   * Every update rebuilds the list, which means running the markdown renderer
   * over every message in it. Measured on a real session that is 46ms for 70
   * turns and it grows linearly, so an all-day conversation would spend a
   * fifth of a second rebuilding itself once a second. Rendering a window
   * makes the cost a function of what is on screen instead of how long you
   * have been working. Nothing is discarded — see `onShowEarlier`.
   */
  window?: number;
  /** Widen the window. */
  onShowEarlier?: () => void;
  /**
   * A question delivered by the broker before the transcript has it.
   *
   * AskUserQuestion is the one moment the calm view cannot afford to lag: the
   * agent has stopped and is waiting on the person, and until the options are
   * on screen the only fallback is "go to the terminal" — the exact handoff
   * this view exists to avoid. The assistant row carrying the question can take
   * a beat to reach the on-disk transcript the poller reads, so the broker
   * hands the question over directly and it renders at once. The caller stops
   * passing it the moment the transcript's own (answer-tracking) copy lands.
   */
  liveAsk?: Action;
  /**
   * Open a file the agent touched, in Spike's own preview pane. A basename in a
   * work strip is the thing a person most wants to click — "you changed
   * notes.ts, let me see it" — and answering that in-app is the whole premise:
   * you never drop to a terminal or a Finder window to look at what happened.
   * The caller routes the path to its preview (openFile). Undefined = the
   * basenames render as plain text, unclickable.
   */
  onOpenFile?: (path: string) => void;
  /**
   * A permission prompt to answer inline. Like `liveAsk`, it's driven by the
   * broker (a `permission_prompt` notification) rather than the transcript —
   * the prompt only exists in the live TUI, never on disk — so it renders the
   * instant the agent blocks and clears the moment work resumes. When set, it
   * replaces the "answer in the terminal" nudge with real Allow/Deny buttons.
   */
  livePermission?: PermissionAsk;
  /** The person chose an option — the caller sends its keystroke to the pty. */
  onDecide?: (opt: PermissionOption) => void;
  /**
   * "Answer in the terminal instead" — the escape hatch. The inline panel
   * assumes the TUI dialog answers to a digit; if that ever drifts, this hands
   * off to the terminal, the same honest fallback the view had before.
   */
  onDeferToTerminal?: () => void;
  /**
   * The reviewer's findings, tracked through the coder's replies — the
   * convergence panel. Rendered like `livePermission`: controller state, not
   * transcript-derived, appended near the tail and rebuilt each poll. Absent or
   * empty renders nothing.
   */
  findings?: Finding[];
  /**
   * You broke a tie on an escalated finding. `side` is whose call to keep —
   * `'coder'` (proceed with its approach) or `'reviewer'` (apply the flagged
   * fix). The caller writes the resolution back into the coder lane and marks
   * the finding `resolved`.
   */
  onFindingDecide?: (id: string, side: 'coder' | 'reviewer') => void;
  /**
   * Proposed inbox filings from a "Tend inbox" run — same rendering contract as
   * `findings` (controller state, rebuilt each poll, empty renders nothing) but
   * its own flat panel: each row is a one-shot approve/skip.
   */
  moves?: Move[];
  /**
   * You decided a proposed move: `'approve'` files it (the caller instructs the
   * agent to perform the move) or `'skip'` leaves it in the inbox. Either way the
   * caller marks the row terminal.
   */
  onMoveDecide?: (id: string, action: 'approve' | 'skip') => void;
}

/**
 * A hover timestamp a person actually reads: "10:24 AM" for today, "Aug 1,
 * 10:24 AM" for anything older. Seconds and the machine-shaped full date are
 * dropped — the point of a hover time is "roughly when", not a log line.
 */
export function friendlyTime(t: Date, now = new Date()): string {
  const time = t.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const sameDay = t.getFullYear() === now.getFullYear()
    && t.getMonth() === now.getMonth() && t.getDate() === now.getDate();
  if (sameDay) return time;
  const day = t.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${day}, ${time}`;
}

/** "48s", "2m 58s" — the terminal's own shape for elapsed time. */
export function elapsed(since: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - since) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

// ── Convergence: findings in, verdicts out ───────────────────────────────────
// The reviewer and coder never speak the same channel directly. The reviewer
// emits findings as a fenced ```spike-findings JSON block at the end of its
// turn; the coder answers each with a one-line `#N accept|reject|counter`. Both
// halves are parsed out of transcript text here — pure, so they can be tested
// against fixtures without a pty. Everything that decides state or injects text
// lives in the caller (the Session controller in app.ts).

/** Stable id for a finding, so its state survives re-parsing the transcript. */
export function findingId(file: string | undefined, line: number | undefined, claim: string): string {
  // djb2 over the identifying triple. Not cryptographic — just a compact, stable
  // key for dedup and DOM identity; collisions across distinct findings in one
  // review are vanishingly unlikely and cost only a merged row if they happen.
  const key = `${file || ''}:${line ?? ''}:${claim}`;
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  return 'f' + (h >>> 0).toString(36);
}

/**
 * Pull the reviewer's findings out of its transcript text. Reads the LAST
 * ```spike-findings block (the reviewer re-emits the whole list if it revises),
 * JSON-parses it, and keeps only well-formed items — a malformed block yields
 * nothing rather than throwing, so a reviewer that fumbles the format simply
 * produces no findings instead of breaking the loop. State/bounces are born
 * fresh here; the caller merges them by id to carry prior progress forward.
 */
export function parseFindings(text: string): Finding[] {
  const blocks = [...text.matchAll(/```spike-findings\s*\n?([\s\S]*?)```/g)];
  if (!blocks.length) return [];
  let arr: any;
  try { arr = JSON.parse(blocks[blocks.length - 1][1].trim()); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const it of arr) {
    if (!it || typeof it.claim !== 'string' || !it.claim.trim()) continue;
    const file = typeof it.file === 'string' && it.file.trim() ? it.file.trim() : undefined;
    const line = typeof it.line === 'number' && isFinite(it.line) ? it.line : undefined;
    const severity = it.severity === 'blocker' || it.severity === 'nit' ? it.severity : 'warn';
    const id = findingId(file, line, it.claim.trim());
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id, file, line,
      claim: it.claim.trim(),
      severity,
      suggestion: typeof it.suggestion === 'string' && it.suggestion.trim() ? it.suggestion.trim() : undefined,
      state: 'open',
      bounces: 0,
    });
  }
  return out;
}

/** Stable id for a proposed move, so its approve/skip survives re-parsing. */
export function moveId(from: string, to: string): string {
  const key = `${from}→${to}`;
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  return 'm' + (h >>> 0).toString(36);
}

/**
 * Pull proposed inbox filings out of the tend agent's transcript. Reads the LAST
 * ```spike-moves block — the agent re-emits the whole list if it revises — and
 * keeps only well-formed `{ from, to, why? }` items; a malformed block yields
 * nothing rather than throwing. State is born 'proposed'; the caller merges by
 * id to carry an already-decided move's approve/skip forward.
 */
export function parseMoves(text: string): Move[] {
  const blocks = [...text.matchAll(/```spike-moves\s*\n?([\s\S]*?)```/g)];
  if (!blocks.length) return [];
  let arr: any;
  try { arr = JSON.parse(blocks[blocks.length - 1][1].trim()); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: Move[] = [];
  const seen = new Set<string>();
  for (const it of arr) {
    if (!it || typeof it.from !== 'string' || !it.from.trim()) continue;
    if (typeof it.to !== 'string' || !it.to.trim()) continue;
    const from = it.from.trim();
    const to = it.to.trim();
    const id = moveId(from, to);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id, from, to,
      why: typeof it.why === 'string' && it.why.trim() ? it.why.trim() : undefined,
      state: 'proposed',
    });
  }
  return out;
}

/**
 * Pull the sparring partner's questions out of its reply. Reads the LAST
 * ```spike-questions block — the agent may restate — as a JSON array of short
 * question strings (or `{ q }` / `{ question }` / `{ text }` objects). Trims,
 * dedupes, drops empties, and caps at 6 so a runaway list can't flood the
 * canvas. A malformed block yields nothing rather than throwing. Used by
 * Canvases' sparring loop, which drops each returned question as a sticky.
 */
export function parseQuestions(text: string): string[] {
  const blocks = [...text.matchAll(/```spike-questions\s*\n?([\s\S]*?)```/g)];
  if (!blocks.length) return [];
  let arr: any;
  try { arr = JSON.parse(blocks[blocks.length - 1][1].trim()); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const it of arr) {
    const raw = typeof it === 'string' ? it
      : (it && typeof (it.q ?? it.question ?? it.text) === 'string' ? (it.q ?? it.question ?? it.text) : '');
    const q = String(raw).trim();
    if (!q) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * Pull the coder's per-finding verdicts out of its reply text. Each verdict is
 * one line the coder was asked to write: `#N accept`, `#N reject: <reason>`, or
 * `#N counter: <alternative>`. Only the last verdict for a given number wins (a
 * coder that restates its answer shouldn't double-count). A reply with no
 * parseable verdict for a finding leaves that finding unanswered — the caller
 * escalates it rather than assuming agreement, so silence never reads as yes.
 */
export function parseCoderVerdicts(text: string): CoderVerdict[] {
  return parseNumberedVerdicts(text, ['accept', 'reject', 'counter']) as CoderVerdict[];
}

/**
 * The reviewer's `#N concede` / `#N hold: <why>` lines, parsed the same way the
 * coder's are. Same tolerance, same last-wins rule. Drives the reviewer half of
 * a bounce: concede settles the finding, hold sends it back to the coder.
 */
export function parseReviewerVerdicts(text: string): ReviewerVerdict[] {
  return parseNumberedVerdicts(text, ['concede', 'hold']) as ReviewerVerdict[];
}

/**
 * The shared shape both halves speak: `#N <verb>[: note]`, one per line,
 * tolerant of `1.`/`#2)`/`3 -` punctuation, last mention of a number winning.
 * `verbs` is the closed set of verdict words this side accepts.
 */
function parseNumberedVerdicts(text: string, verbs: string[]): Array<{ index: number; verdict: any; note?: string }> {
  const re = new RegExp(`^\\s*#?\\s*(\\d+)\\s*[:.)\\-\\s]\\s*(${verbs.join('|')})\\b\\s*[:.\\-]?\\s*(.*)$`, 'i');
  const byIndex = new Map<number, { index: number; verdict: any; note?: string }>();
  for (const raw of text.split('\n')) {
    const m = raw.match(re);
    if (!m) continue;
    const index = Number(m[1]);
    if (!index) continue;
    byIndex.set(index, { index, verdict: m[2].toLowerCase(), note: m[3].trim() || undefined });
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

// ── SPIKE marquee loader ─────────────────────────────────────────────────────
// The working indicator spells S · P · I · K · E on a 6×7 dot grid, each letter
// dissolving to nothing before the next fades in. The letterforms and timing
// were hand-tuned in a playground and are frozen here.
//
// Why a module-level element + a self-scheduling timer, not a fresh build per
// render: render() rebuilds the whole conversation on every poll, so anything
// created inline would restart its animation each time and never get past the
// first letter. Instead one <div> is created once and its dots' opacities are
// driven by a setTimeout chain that keeps its own time. render() detaches and
// re-appends this same node freely; the timer pauses itself when the node is
// off-screen (see spikeTick) and spikeMarquee() RESUMES it — continuing from the
// current step WITHIN a run, and restarting from 'S' only when a NEW run begins
// (the loader had been gone; tracked by spikeStopped, which render() sets).
const SPIKE_W = 6, SPIKE_H = 7;
const SPIKE_ORDER = ['S', 'P', 'I', 'K', 'E'];
const SPIKE_LETTERS: Record<string, string[]> = {
  S: ['######', '##....', '##....', '######', '....##', '....##', '######'],
  P: ['######', '##..##', '##..##', '######', '##....', '##....', '##....'],
  I: ['######', '..##..', '..##..', '..##..', '..##..', '..##..', '######'],
  K: ['##..##', '##.###', '##.##.', '####..', '##.##.', '##.###', '##..##'],
  E: ['######', '##....', '##....', '#####.', '##....', '##....', '######'],
};
// seconds
const SPIKE_HOLD = 0.55, SPIKE_MORPH = 0.25, SPIKE_STAG = 0.03,
      SPIKE_LGAP = 0.10, SPIKE_LOOP = 0.5, SPIKE_DIM = 0.08;
// Dot and gap in SVG user units (see spikeMarquee). Whole numbers on purpose:
// the viewBox does the scaling, so the pitch stays exactly even at any size.
const SPIKE_DOT = 2, SPIKE_GAP = 1;
const SPIKE_MATS: Record<string, number[][]> = Object.fromEntries(
  SPIKE_ORDER.map(k => [k, SPIKE_LETTERS[k].map(row => [...row].map(ch => ch === '#' ? 1 : 0))]));
// letter, gap, letter, gap, … — the final gap after E is the longer loop breath
const SPIKE_SEQ: Array<{ t: 'L' | 'gap' | 'loop'; k?: string }> =
  SPIKE_ORDER.flatMap((k, i) => [{ t: 'L' as const, k }, { t: i === SPIKE_ORDER.length - 1 ? 'loop' as const : 'gap' as const }]);

// The grid: one <svg> whose children are the 42 dots spikePaint drives.
let spikeEl: SVGSVGElement | null = null;
let spikeTimer: any = null;
let spikeStep = 0;
// True while no run is in progress — so the NEXT time the marquee appears it is
// a fresh start and spells the name from 'S'. render() flips this on whenever
// the working indicator is gone (turn over). It is deliberately NOT flipped by
// a tool icon briefly replacing the marquee mid-run: that keeps opts.working
// true, so the run — and the sequence — continue. Starts true: the very first
// appearance is a fresh run.
let spikeStopped = true;
// The opacity each dot is currently resting at, so a fade animates from where
// it actually is rather than snapping. Module-level because the element is.
const spikeCur: number[] = new Array(SPIKE_W * SPIKE_H).fill(SPIKE_DIM);
// A direct handle to each dot's in-flight fade. Kept because spikeMarquee
// repaints while the node is DETACHED, where element.getAnimations() returns
// nothing — but the stored Animation can still be cancelled, which is what
// stops a previous letter's fade holding a dot bright through the next frame.
const spikeAnims: (Animation | null)[] = new Array(SPIKE_W * SPIKE_H).fill(null);

/** The working indicator is gone (the turn ended). Mark the run over so the
 *  marquee restarts at 'S' the next time it appears — see spikeMarquee. */
function spikeStop(): void { spikeStopped = true; }

/**
 * Paint one frame — a letter's mat, or null to dissolve the whole grid to dim.
 *
 * The fade is a Web Animation, NOT a CSS transition. render() rebuilds the
 * whole conversation on every poll, which detaches and re-appends this node —
 * and a CSS transition is cancelled the instant its element leaves the DOM. On
 * the Codex path renders are rare enough that the transition usually finished
 * first; on the Claude path the byte-by-byte stream re-renders many times a
 * second, so every fade was cancelled mid-flight and the marquee looked frozen.
 * A Web Animation is owned by the element, not the document, and sails through
 * the synchronous detach/reattach untouched — smooth at any render frequency.
 * The resting opacity is also written to inline style, so if a browser lacks
 * WAAPI the grid still lands on the right frame (it just snaps instead of fades).
 */
function spikePaint(mat: number[][] | null): void {
  if (!spikeEl) return;
  const dots = spikeEl.children;
  for (let r = 0; r < SPIKE_H; r++) for (let c = 0; c < SPIKE_W; c++) {
    const i = r * SPIKE_W + c;
    const d = dots[i] as HTMLElement;
    const target = mat && mat[r][c] ? 1 : SPIKE_DIM;
    const from = spikeCur[i];
    spikeCur[i] = target;
    // Retire this dot's previous fade via its stored handle (works detached),
    // then set the RESTING opacity as inline. The animation carries only the
    // FADE, with fill:'backwards' so a finished fade has no forwards effect and
    // the dot rests at the inline value — belt (cancel) and suspenders (no
    // forwards fill) against a previous letter bleeding bright into the next.
    if (spikeAnims[i]) { try { (spikeAnims[i] as Animation).cancel(); } catch { /* already gone */ } spikeAnims[i] = null; }
    d.style.opacity = String(target);   // the resting value the fade reverts to
    if (from === target || typeof d.animate !== 'function') continue;
    spikeAnims[i] = d.animate(
      [{ opacity: from }, { opacity: target }],
      { duration: 250, delay: (r + c) * SPIKE_STAG * 1000, easing: 'ease', fill: 'backwards' },   // (r+c) delay = diagonal wipe
    );
  }
}
function spikeTick(): void {
  // Pause the moment we're no longer on screen — spikeMarquee() will resume us.
  if (!spikeEl || !spikeEl.isConnected) { spikeTimer = null; return; }
  const e = SPIKE_SEQ[spikeStep % SPIKE_SEQ.length];
  spikeStep++;
  spikePaint(e.t === 'L' ? SPIKE_MATS[e.k!] : null);
  const wait = SPIKE_MORPH + (e.t === 'L' ? SPIKE_HOLD : e.t === 'gap' ? SPIKE_LGAP : SPIKE_LOOP);
  spikeTimer = setTimeout(spikeTick, wait * 1000);
}
/**
 * The marquee element (created once), with its timer guaranteed running.
 *
 * SVG, not a CSS grid of 1px boxes. The dots are ~1px apart at ~1px across, and
 * a laid-out box is snapped to whole device pixels when it paints: at that
 * pitch the rounding lands differently from one track to the next, so some gaps
 * closed up and others survived — the stray gap in the bottom row, worse again
 * under Spike's zoom, where the fractions drift further. SVG shapes are not
 * snapped; they rasterize with antialiasing wherever the geometry actually
 * puts them, so an even pitch stays even at any scale. The grid is authored in
 * whole user units (a 2-unit dot, a 1-unit gap) and the viewBox does the
 * scaling.
 */
export function spikeMarquee() {}
export function render() {}
export function renderStatus() {}
export function plainMarkdown(src: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fences: string[] = [];
  let s = esc(src).replace(/```[\w-]*\n?([\s\S]*?)```/g, (_m, code) => ` ${fences.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`) - 1} `);
  s = s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  const out = s
    .split(/\n{2,}/)
    .map((para) => {
      const lines = para.split('\n');
      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        return `<ul>${lines.map((l) => `<li>${l.replace(/^\s*[-*]\s+/, '')}</li>`).join('')}</ul>`;
      }
      if (/^ \d+ $/.test(para.trim())) return para.trim();
      return `<p>${lines.join('<br>')}</p>`;
    })
    .join('');
  return out.replace(/ (\d+) /g, (_m, i) => fences[Number(i)]);
}

// ── Composer ────────────────────────────────────────────────────────────────

/** One image staged into the next message, shown as a thumbnail in the tray. */
export interface Attachment {
  /** A URL the tray can render as a thumbnail — a data: URL or an asset src. */
  thumb?: string;
  /** The filename, shown beside the thumb and used to identify a chip. */
  name?: string;
  /** Called when the chip's × is clicked, so the host can retract the real
   *  attachment (not just hide the chip) — see the session's pending model. */
  onRemove?: () => void;
}

/**
 * The composer element, plus the small surface the host uses to reflect dropped
 * images. The tray is the composer's — not the transcript's — because an
 * attachment is part of the message you are still writing, and it has to clear
 * the instant that message is sent.
 */
export interface Composer extends HTMLElement {
  /** Show a dropped image as a thumbnail chip above the input. */
  addAttachment(a: Attachment): void;
  /** Drop the tray — the message went out, or was cleared. */
  clearAttachments(): void;
  /** How many chips are showing, so the host can skip work when it's zero. */
  attachmentCount(): number;
}

/**
 * The one input. It does not "send to an API" — the caller writes the text into
 * the lane's PTY, exactly as if it had been typed. That is what keeps this a
 * formatting layer: the session underneath is an ordinary agent CLI, and every
 * feature it grows (slash commands, resume, plan mode) still works.
 */
export function composer() { return null; }
export const CHAT_CSS = '';