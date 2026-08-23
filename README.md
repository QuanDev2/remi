# Remi

A voice-first personal assistant and development environment.

**Wake word:** `Remi`

---

## What this is

Two things that share one architecture:

1. **A voice-first way to build software.** Walk outside, talk through what should be built, and a team of agents does the work. They brief you at a high level, push anything visual to your phone screen for a glance, and wait for direction. This is meant to replace sit-down coding sessions as the primary way work gets done — not to be a novelty voice feature bolted onto a terminal.

2. **A personal assistant.** The same voice-plus-visual-glance loop, pointed at personal data instead of code: documents, photos, calendar, email. Ask it things hands-free. Let it take actions.

The interaction pattern is identical either way, which is why they're one project. Remi is the tool used to build other things — starting with Pholio, and with Remi itself — and it grows into the assistant over time.

## Why

Being tied to a desk, typing and reading, is the bottleneck. The work itself doesn't require sitting still; the interface does. Remi removes that constraint.

## Non-goals

- **Not a chatbot.** If it can't take actions, it isn't useful.
- **Not multi-user.** Single operator, by design.
- **Not a product, yet.** Monetization is explicitly parked. The point is to live with it daily and find the rough edges first.

---

## Architecture

### Foundation: OpenClaw

Remi is built as a plugin on [OpenClaw](https://github.com/openclaw/openclaw) (MIT, OpenClaw Foundation). Not a fork — a dependency, so upstream stays pullable.

OpenClaw already provides the parts that would otherwise take months:

| Layer | What it gives us |
|---|---|
| Gateway | Local control plane for sessions, tools, events; WebSocket transport over LAN/tailnet |
| iOS app | Native Swift, with Apple Watch node. Realtime voice, dictation, TTS, voice wake, push |
| Visual channel | Inline image rendering, syntax-highlighted workspace previews |
| Subagents | Isolated child contexts, orchestrator nesting, spawn/yield gating |
| Model providers | Anthropic, OpenAI, and local via Ollama / llama.cpp / vLLM / LM Studio / SGLang |
| Resilience | Session persistence, durable offline outbox, reconnect |

**What we build on top:** the agent team, the ledger, and the briefing layer.

### The agent team

Eight roles. Every role has a distinct job with no overlap — this was pressure-tested, and a reduced three-role version was deliberately rejected in favor of the full accountable loop, since everything is grounded in verifiable acceptance criteria rather than subjective judgement.

| # | Role | Job |
|---|---|---|
| 1 | **Goal setter** | Writes the goal and verifiable acceptance criteria in plain language, before planning starts |
| 2 | **Planner** | Sequences the work needed to satisfy those criteria |
| 3 | **Plan reviewer** | Scrutinizes the plan and surfaces concerns *before* Quan sees it |
| 4 | **Human gate (Quan)** | Approves, or directs specific changes |
| 5 | **Executor** | Builds per the approved plan |
| 6 | **Code reviewer** | Reviews the executor's output |
| 7 | **Test planner** | Writes test scenarios in plain language — *not* test code |
| 8 | **Test executor** | Turns scenarios into runnable tests, executes, reports |

**Why 7 and 8 are separate:** if one agent both defines correct behavior and writes the mechanical tests, it will unconsciously write tests that match what was built rather than what was asked for. That defeats the point of verification.

### Verification granularity

- **Unit** — does this function return the right output for a given input?
- **Integration** — does this endpoint actually persist and return the right shape?
- **End-to-end** — does the real user flow work? (Playwright)

Every meaningful unit of work gets reviewed *and* tested. Not spot-checked.

### The dual-output principle

Every agent produces **two** outputs, always:

- **Full technical detail → the ledger.** Stack traces, assertions, diffs, file/line locations, screenshot references. Nothing simplified. This is how agents talk to each other and how a fresh session reconstructs ground truth.
- **A PM-style brief → spoken to Quan.** Short status, explicit roadblocks, options with tradeoffs, then stop and ask. Never a wall of text. Visuals go to the phone screen; narration goes to voice.

The ledger stays complete. The human experience stays voice-first and free of information overload.

### The shared ledger

A durable, queryable log replacing lossy handoff notes. Postgres — already in use for Pholio.

**One table, not one per activity type.** A `type` column distinguishes entries. Separate tables would force any agent wanting a full timeline to stitch several queries together; one table with a type field serves both narrow queries ("open findings") and broad ones ("full history").

| Column | Purpose |
|---|---|
| `id` | Unique entry ID |
| `timestamp` | When written |
| `agent` | Who wrote it |
| `type` | plan / finding / code_change / test_result / decision / approval |
| `status` | open / resolved / approved / rejected |
| `reference` | Links to a feature or plan, chaining related entries |
| `content` | Human-readable summary |
| `code_location` | File path and line range — structured, not buried in prose |
| `details` | JSON for specifics: which file, which test |
| `resolved_by` | Points to the entry that closed this one out |

This solves two problems with one structure: a single agent re-orienting after a context reset, and multiple agents coordinating without ever being in the same conversation.

### Coordination and gating

Agents don't message each other. They read and write the shared ledger, like a structured meeting log.

> Plan reviewer finds an issue → writes a row (`type: finding`, `status: open`, referencing the plan section). Planner queries for open findings on its plan, addresses them, writes its own row marking the finding resolved with reasoning.

**Full autonomy is not the default.** A lightweight event bus (Redis) sits on top for real-time wake-up between agents — *the ledger is the record, the event bus is the doorbell*. A per-stage policy decides what happens when an event fires:

- **Autonomous** — the event bus wakes the next agent directly.
- **Gated** — Quan is notified first, briefed verbally, and gives a go-ahead or specific direction.

**Gated by default.** Stages open up to autonomous only once trusted.

Quan's approval is itself a ledger entry (`type: approval` or `decision`), referencing what it unlocks. The next agent checks for that entry before proceeding. Net effect: the ledger records not just what agents did, but every point a human steered — a complete audit trail.

### Context self-awareness

The pipeline tracks its own token usage and flags when it's approaching the limit. A fresh session reconstructs context by querying the ledger, not by reading a handoff note.

---

## Milestones

**1. Agent team + ledger, in plain text.** No voice, no phone. Stand up the eight roles and the Postgres ledger, driven through Claude Code as-is. Prove the loop works and saves time. *Everything below assumes this works.*

**2. Pipe end to end.** The pipeline reachable from the iOS app over the Gateway. Text and voice both directions, no style shaping yet — just prove the connection holds.

**3. PM-style briefing layer.** Prompt engineering, not a new tool. Short status, explicit roadblocks, options with tradeoffs, then stop and ask.

**4. Visual handoff.** The agent recognizes when something is inherently visual and pushes it to the phone instead of narrating it. Glance, tap back, keep steering.

**5. Hardening.** Session persistence across a closed app, graceful handling of dropped connections. Largely provided by OpenClaw; needs verification under real conditions.

**Later:** document ingestion, RAG over personal data, calendar and email tools, local models.

---

## Phases

**Phase 1 (now).** Cloud models as the brain. Build the surrounding architecture cleanly so phase 2 is a swap, not a rebuild.

**Phase 2 (later).** Local models via Ollama for privacy and cost, plus document ingestion, vector search, persistent memory. OpenClaw already supports local providers, so this is configuration rather than migration.

The likely first step into phase 2 isn't replacing the coding agents — frontier models are needed there. It's moving the cheap, high-frequency calls local: intent classification, transcript cleanup, summarizing ledger entries into voice briefs. Those dominate the cost of a chatty voice loop.

---

## Environment

**Development:** MacBook Air M4, 24GB unified memory, 10 cores. Everything runs locally. The laptop sleeping is fine — this is development, not deployment.

**Later:** Synology DS923+ as the always-on host, once the design settles. Tailscale is already configured, so the transport path exists. Note the NAS is a 2-core Ryzen R1600 with no GPU — it can host the Gateway, but not local inference. Phase 2 needs the Mac or dedicated hardware.

---

## Prior art

| Project | Relevance |
|---|---|
| [openclaw/openclaw](https://github.com/openclaw/openclaw) | The foundation. MIT |
| [open-jarvis/OpenJarvis](https://github.com/open-jarvis/OpenJarvis) | Stanford local-first agent framework. Strong on cost/energy evals; no mobile or voice transport. Apache-2.0 |
| [isair/jarvis](https://github.com/isair/jarvis) | Best-in-class voice interaction design — wake words, echo filtering, context rot. **Non-commercial license; read for ideas, do not copy code** |
| [rezaulhreza/jarvis](https://github.com/rezaulhreza/jarvis) | Small Ollama assistant. MIT claimed in README, but no LICENSE file |

---

## Status

Just started. Nothing built yet.
