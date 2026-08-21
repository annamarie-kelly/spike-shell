// agent_broker.rs — append-only event broker for agent-state events.
//
// OWNER: agent-broker agent.
//
// First Tier 1 primitive from
// `02-Thinking/Spike event broker — build plan.md`. Spike already has good
// per-name Tauri events (tree:changed, pty:exit, open) and a Channel<String>
// for PTY bytes — those stay. The gap is "what is the agent doing": file
// writes, tool calls, pause-on-question. This module is the new surface for
// that class of events.
//
// ── Shape ────────────────────────────────────────────────────────────────────
//   AgentEvent { seq, ts, run_id, session_id, kind, data }
//     • seq        — monotonic, broker-assigned (u64, starts at 1)
//     • ts         — ISO-8601 UTC, broker-assigned via fs_ops::now_parts()
//     • run_id     — groups events from one agent session (caller-supplied)
//     • session_id — Spike tab id, optional (caller-supplied)
//     • kind       — string label ("file.write", "tool.start", …); broker
//                    doesn't enforce a closed set — schema lock-in deferred
//                    per the plan's mitigation
//     • data       — arbitrary JSON object, per-kind payload
//
// ── Storage ──────────────────────────────────────────────────────────────────
//   In-memory ring (VecDeque, cap RING_CAP=1000) + best-effort jsonl mirror in
//   ~/.spike/logs/agent-events-YYYY-MM-DD.jsonl. Same logging.enabled gate as
//   fs_ops::log_action — disable logs, broker keeps emitting + ring keeps
//   filling; only the disk write drops.
//
// ── Emit ─────────────────────────────────────────────────────────────────────
//   Every append fires Tauri event "agent:event" with the full AgentEvent JSON.
//   Frontend subscribes via Tauri event listener + a one-shot
//   `invoke('agent_recent', { since })` for replay. Dedup contract: drop any
//   live event with seq <= since_seq returned from agent_recent.
//
// ── Threading ────────────────────────────────────────────────────────────────
//   AppState holds AgentBroker; all internal state behind Mutex/Atomic. Append
//   is fast — no I/O on the hot path beyond the jsonl line write, which is
//   already what fs_ops::log_action does.

use std::collections::VecDeque;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

/// Bounded ring capacity. Sized for ~10 minutes of moderate tool activity
/// (10 tool calls/min × 10 min × ~10 events/call) with headroom. Per-session
/// slicing happens on read (recent's `run_id` filter, future work), so a
/// noisy session can crowd out a quiet one — revisit if that bites.
const RING_CAP: usize = 1000;

/// One canonical event on the broker. `data` is intentionally a free-form
/// Value: v1 mitigation for schema lock-in (per the build plan's open
/// questions). Consumers that need a closed schema project into their own
/// type at the call site.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentEvent {
    pub seq: u64,
    pub ts: String,
    pub run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub kind: String,
    pub data: Value,
}

/// Append-only ring + monotonic counter. Default-constructible so AppState
/// can hold one without Tauri's setup-time async dance.
#[derive(Default)]
pub struct AgentBroker {
    next_seq: AtomicU64,
    ring: Mutex<VecDeque<AgentEvent>>,
}

impl AgentBroker {
    /// Append one event. Assigns `seq` + `ts`, pushes onto the bounded ring,
    /// mirrors a line to today's jsonl (best-effort, gated by logging.enabled),
    /// and emits Tauri event "agent:event" so live subscribers see it. Returns
    /// the assigned seq so the caller (HTTP handler) can echo it in the
    /// response — useful for hooks to confirm intake.
    pub fn append(
        &self,
        app: &AppHandle,
        run_id: String,
        session_id: Option<String>,
        kind: String,
        data: Value,
    ) -> u64 {
        let seq = self.next_seq.fetch_add(1, Ordering::SeqCst) + 1;
        let (ts, day) = crate::fs_ops::now_parts();
        let event = AgentEvent {
            seq,
            ts,
            run_id,
            session_id,
            kind,
            data,
        };
        {
            let mut ring = self.ring.lock().unwrap();
            if ring.len() == RING_CAP {
                ring.pop_front();
            }
            ring.push_back(event.clone());
        }
        write_jsonl(&day, &event);
        let _ = app.emit("agent:event", &event);
        seq
    }

    /// Events with seq > `since`, in ascending seq order. `since = 0` returns
    /// the whole ring (the snapshot a fresh subscriber pulls). Caller dedupes
    /// the live stream by dropping events with seq <= the largest seq seen in
    /// this response.
    pub fn recent(&self, since: u64) -> Vec<AgentEvent> {
        let ring = self.ring.lock().unwrap();
        ring.iter().filter(|e| e.seq > since).cloned().collect()
    }

    /// The most recently assigned seq. Useful for tests; also lets the
    /// frontend ask "where are we now?" without pulling the full ring.
    #[allow(dead_code)]
    pub fn current_seq(&self) -> u64 {
        self.next_seq.load(Ordering::SeqCst)
    }
}

/// Append one line to `~/.spike/logs/agent-events-YYYY-MM-DD.jsonl`. Mirrors
/// fs_ops::log_action's gating + best-effort semantics: logging.enabled=false
/// silently skips, all I/O errors swallowed.
fn write_jsonl(day: &str, event: &AgentEvent) {
    let cfg = crate::fs_ops::read_config_resolved();
    if cfg["logging"]["enabled"] == Value::Bool(false) {
        return;
    }
    let line = match serde_json::to_string(event) {
        Ok(s) => s,
        Err(_) => return,
    };
    let dir = crate::state::spike_dir().join("logs");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(format!("agent-events-{}.jsonl", day)))
    {
        let _ = f.write_all(line.as_bytes());
        let _ = f.write_all(b"\n");
    }
}

// ── Tauri command ───────────────────────────────────────────────────────────

/// `invoke('agent_recent', { since })` — frontend snapshot pull. Returned
/// events have seq > `since`; pass 0 for the full ring. Always Ok — broker
/// reads are infallible.
#[tauri::command]
pub fn agent_recent(
    state: tauri::State<'_, crate::state::AppState>,
    since: Option<u64>,
) -> Result<Vec<AgentEvent>, String> {
    Ok(state.agent_broker.recent(since.unwrap_or(0)))
}

// ── tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(seq: u64, kind: &str) -> AgentEvent {
        AgentEvent {
            seq,
            ts: "1970-01-01T00:00:00.000Z".into(),
            run_id: "r1".into(),
            session_id: None,
            kind: kind.into(),
            data: json!({}),
        }
    }

    /// recent() returns ring contents in ascending seq order, filtered by `since`.
    #[test]
    fn recent_filters_by_since_and_preserves_order() {
        let broker = AgentBroker::default();
        // Direct ring push to avoid needing an AppHandle.
        let mut ring = broker.ring.lock().unwrap();
        ring.push_back(ev(1, "a"));
        ring.push_back(ev(2, "b"));
        ring.push_back(ev(3, "c"));
        drop(ring);
        broker.next_seq.store(3, Ordering::SeqCst);

        let all = broker.recent(0);
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].seq, 1);
        assert_eq!(all[2].seq, 3);

        let tail = broker.recent(1);
        assert_eq!(tail.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![2, 3]);

        assert!(broker.recent(99).is_empty());
    }

    /// The ring caps at RING_CAP — oldest events are evicted FIFO.
    #[test]
    fn ring_evicts_oldest_at_capacity() {
        let broker = AgentBroker::default();
        let mut ring = broker.ring.lock().unwrap();
        for i in 1..=RING_CAP as u64 {
            ring.push_back(ev(i, "x"));
        }
        // One more — simulate what append() does at capacity.
        if ring.len() == RING_CAP {
            ring.pop_front();
        }
        ring.push_back(ev(RING_CAP as u64 + 1, "x"));
        drop(ring);

        let all = broker.recent(0);
        assert_eq!(all.len(), RING_CAP);
        assert_eq!(all.first().unwrap().seq, 2);
        assert_eq!(all.last().unwrap().seq, RING_CAP as u64 + 1);
    }

    /// Seq is monotonic across concurrent appends — no collisions.
    #[test]
    fn seq_is_monotonic_under_concurrency() {
        use std::sync::Arc;
        use std::thread;

        let broker = Arc::new(AgentBroker::default());
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let b = broker.clone();
                thread::spawn(move || {
                    let mut seqs = vec![];
                    for _ in 0..100 {
                        seqs.push(b.next_seq.fetch_add(1, Ordering::SeqCst) + 1);
                    }
                    seqs
                })
            })
            .collect();
        let mut all: Vec<u64> = threads.into_iter().flat_map(|t| t.join().unwrap()).collect();
        all.sort();
        // 800 distinct, contiguous seqs starting at 1.
        assert_eq!(all.len(), 800);
        assert_eq!(*all.first().unwrap(), 1);
        assert_eq!(*all.last().unwrap(), 800);
        for w in all.windows(2) {
            assert_eq!(w[1], w[0] + 1);
        }
    }
}
