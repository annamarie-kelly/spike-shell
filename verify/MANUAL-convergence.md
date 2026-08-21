# Manual verification: the reviewer↔coder convergence loop

The automated tests cover the pieces the harness can reach: the state machine
(`test/converge.test.mjs`), the parsers (`test/chatview.test.mjs`), and the panel
render (`verify/scenarios/chat-convergence.mjs`). What none of them touch is the
**live two-lane handshake** — one real agent's message injected into another real
agent's TUI, and its reply read back off disk. That is exactly the seam most
likely to misbehave, so it gets a written suite.

Everything here assumes the convergence branch is actually the build you're
running. It is unmerged; a stale binary is the first way this wastes an hour.

---

## 0. Preflight: are you running the change?

```sh
# From the repo, build the web bundle the app loads and confirm converge.js exists.
node build.mjs >/dev/null && ls -l dist/web/converge.js
```

- If you're on **`tauri dev`**, it rebuilds the app but reads `src/web` through the
  bundler — a fresh `node build.mjs` (or the dev watcher) must have run since your
  last edit, or the panel logic is stale.
- The **findings convention lives in the Rust base prompt** (`pty.rs`,
  `SPIKE_SYSTEM_PROMPT`). That ships inside the app binary, not the web bundle. If
  the reviewer never emits a ```spike-findings block, you're on an app build from
  before that change — rebuild the app, not just the web bundle.

```sh
# Confirm the base prompt in THIS binary teaches the convention:
strings src-tauri/target/*/Spike 2>/dev/null | grep -m1 spike-findings || echo "NOT in this binary — rebuild the app"
```

---

## 1. Set the scene: two agent lanes

You need a **coder** lane and a **reviewer** lane. Either arrangement works — the
loop pairs them the same way:

- **Sibling tabs** (the common case): open two Claude/Codex lanes in the same repo.
- **Subagent**: from the coder lane, spawn a read-mode subagent as the reviewer.

Then:

1. In the **coder** lane, ask for a small change that contains a **deliberate,
   real bug** — an off-by-one, a dropped `await`, an unhandled null. Let it finish.
2. In the **reviewer** lane, tell it plainly: *"Review the change <coder> just made
   in `<file>` and report issues."* The base prompt does the rest — a genuine review
   ends with a fenced ```spike-findings JSON array.
3. Open the **reviewer** lane's **chat view** (the "Terminal ⇄ chat" flip). Once its
   findings parse and there's another agent lane to send to, a green
   **"Send N findings → coder"** button appears in the chat header.

**Pass:** the button appears, and N matches the number of issues the reviewer
actually raised. If it doesn't appear, jump to Trap A.

---

## 2. Fire it and watch the four stages

Open the **coder** lane's chat view and keep it visible — the findings panel lives
there. Click **"Send N findings → coder"** on the reviewer lane.

### Stage 1 — the ask lands in the coder
- **Watch:** a new message bubble in the coder lane containing a numbered list
  (`#1 [warn] …`, `#2 …`) with the `accept / reject / counter` instruction.
- **Pass:** it arrives as **one coherent block** — not split across several
  submissions, not merged into a word-salad line. (This is the bracketed-paste
  path; a split here is the single most important thing this suite exists to catch.)
- **Panel:** the coder's chat grows a **REVIEW FINDINGS** panel, each row `OPEN`.

### Stage 2 — the coder answers per finding
- **Watch:** the coder replies with `#1 accept`, `#2 reject: …` lines (possibly
  after doing edits first).
- **Pass:** accepted rows go dim + `ACCEPTED`; rejected/countered rows either move
  to `WITH REVIEWER` (a reviewer exists) or `YOUR CALL` (no reviewer / cap hit).
  The tally updates: e.g. `2 settled · 1 with the reviewer`.

### Stage 3 — the reviewer reconsiders
- **Watch:** the reviewer lane receives a "coder pushed back, concede or hold"
  message and replies `#N concede` / `#N hold: …`.
- **Pass:** a `concede` row flips to `RESOLVED`; a `hold` row bounces back to the
  coder (`back to coder` badge) for another pass. This can repeat — **up to 3
  rounds per finding** (`CONVERGE_CAP`).

### Stage 4 — you break the tie
- **Watch:** any finding still contested after the cap shows `YOUR CALL` with two
  buttons: **Keep the coder's approach** / **Apply the reviewer's fix**.
- **Pass:** clicking **Apply the reviewer's fix** injects an instruction into the
  coder lane (watch for the bubble) and the row goes `RESOLVED`. **Keep the coder's
  approach** resolves it with no injection.

**Overall pass:** every finding ends in a terminal state (`ACCEPTED` / `RESOLVED` /
your ruling). The panel's tally reaches `N settled` and nothing is left awaiting.

---

## 3. Confirming a message actually landed (not just "looked like it")

The in-chat bubble is the primary signal. To confirm at the wire level, tail the
broker — every injected message provokes the receiving agent's tool/turn events:

```sh
B=~/.spike/logs/agent-events-$(date +%F).jsonl
# The receiving lane starting a turn right after you clicked = the inject landed.
tail -f $B | jq -c '{seq, kind, sid:.session_id, tool:.data.tool}'
```

Look for a `turn.ended` on the **reviewer** after Stage 2 (it got the pushback),
and on the **coder** after Stage 3 (it got the hold). If you click and see **no**
new events on the target lane within a few seconds, the inject did not take — see
Trap B.

---

## 4. Traps (each cost a real cycle)

**A. The button never appears.** Two independent causes, check both:
  - The reviewer emitted **no** ```spike-findings block. Read its last message. If
    it reviewed in prose only, either it's the old app binary (Preflight §0) or the
    reviewer didn't treat the task as a review — tell it explicitly to *review* and
    *report issues*.
  - There's **no candidate coder** — the button hides unless another **live** agent
    lane exists. A dead/exited lane doesn't count.

**B. The inject "vanished."** The message is written to the target lane's pty via
  the same queued, bracketed-paste path as a typed message. It will **not** be
  processed while that lane is mid-turn at a non-prompt state — it queues. If the
  target agent was busy, wait for it to settle; the message is delivered
  one-at-a-time and shows as a pending bubble until the agent picks it up. If it
  never picks it up, the finding **times out after 4 minutes** and escalates to you
  (Stage 4) rather than hanging — that escalation *is* the expected failure mode.

**C. Nothing advances after you switch tabs.** The loop runs a background tick
  (2s) while anything is awaiting, so it should progress even off-screen. But the
  findings panel only **redraws** when the coder lane's chat is the open view.
  Switch back to the coder lane to see the current state; it will have moved.

**D. The reviewer closed/exited mid-negotiation.** By design the contested finding
  is **escalated to you**, not stranded — verify it shows `YOUR CALL` with a note
  like "the reviewer is no longer available". If it's stuck on `WITH REVIEWER`
  forever, that's a bug worth reporting.

**E. Verdict lines the agent didn't format as `#N`.** The parser is tolerant
  (`1.`, `#2)`, `3 -`) but needs the number + verb. An agent that answers in pure
  prose leaves those findings `OPEN` until it restates them — or until the 4-minute
  timeout escalates them. If a whole review stalls this way, the agent isn't
  following the format; nudge it to answer `#N accept/reject/counter`.

---

## 5. Known limits (not bugs)

- Requires **two live agent lanes**; a single lane reviewing its own work is not
  this feature.
- The reviewer must actually **emit the findings block** — a review it phrases only
  in prose won't trigger anything (no block, no button).
- Round cap is **3** per finding, then it's your call. Raising it is a one-line
  change (`CONVERGE_CAP` in `app.ts`); don't expect infinite back-and-forth.
- Codex lanes participate, but the format-compliance of a Codex reviewer/coder is
  less exercised than Claude — treat a Codex run as its own check.
