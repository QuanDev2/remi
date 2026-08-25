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
| Subagents | Isolated child sessions, fresh transcripts, push-based completion, configurable depth |
| Swarm + Code Mode | Script-driven orchestration with JSON-Schema-validated results from each child |
| Per-agent config | Model, workspace, tool profile, and sandbox per role |
| Hooks | 42 internal lifecycle events a plugin can subscribe to |
| Model providers | Anthropic, OpenAI, and local via Ollama / llama.cpp / vLLM / LM Studio / SGLang |
| Resilience | Session persistence, durable offline outbox, reconnect |

**What OpenClaw does not provide:** a workflow engine, a role registry, or human approval inside a subagent. An OpenClaw "agent" is a persona bound to a channel, not a pipeline stage.

**What we build on top:** the pipeline scripts, the eight role definitions, the ledger, and the briefing layer.

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
| 7 | **Test planner** | Writes test scenarios in plain language — *not* test code. Reads the goal and acceptance criteria **only** |
| 8 | **Test executor** | Turns scenarios into runnable tests, executes, reports |
| — | *Briefer* | Infrastructure, not accountability: turns ledger rows into the spoken brief. Holds no judgement |

**Why 7 and 8 are separate:** if one agent both defines correct behavior and writes the mechanical tests, it will unconsciously write tests that match what was built rather than what was asked for. That defeats the point of verification.

**Why 7 never reads the plan:** acceptance criteria are the observable contract; a plan is implementation sequencing. A test planner that reads the plan writes scenarios shaped like plan steps — asserting the middleware exists rather than that the request returns 400. That is the same contamination, one step upstream and harder to spot. A useful side effect: a scenario with no matching plan step is a hole in the plan, found by an agent that never read it.

### Pipeline order

```
1 → 2 → 3 → GATE → (5 ∥ 7) → 8 ⇄ 5 → 6 ⇄ 5 → done
```

Eleven of thirteen edges are sequential; peak concurrency is 2, at executor ∥ test planner. Rework loops are bounded at three passes, then stop and brief.

**Tests run before code review, not after and not in parallel.** Review is the expensive stage, so the cheap objective check goes first and can short-circuit it. A failing test is a fact; a review comment is an opinion, and facts get resolved first. Reviewing first also produces an incoherent ledger — an `approval` row preceding a failing `test_result` on the same reference reads as a reviewer blessing broken code.

### Verification granularity

- **Unit** — does this function return the right output for a given input?
- **Integration** — does this endpoint actually persist and return the right shape?
- **End-to-end** — does the real user flow work? (Playwright)

Every meaningful unit of work gets reviewed *and* tested. Not spot-checked.

### The dual-output principle

Every agent produces **two** outputs, always:

- **Full technical detail → the ledger.** Stack traces, assertions, diffs, file/line locations, screenshot references. Nothing simplified. This is the audit trail and how a fresh session reconstructs ground truth.
- **A PM-style brief → spoken to Quan.** Short status, explicit roadblocks, options with tradeoffs, then stop and ask. Never a wall of text. Visuals go to the phone screen; narration goes to voice.

The ledger stays complete. The human experience stays voice-first and free of information overload.

### The shared ledger

A durable, queryable log replacing lossy handoff notes. Postgres — already in use for Pholio.

Chosen for **network reachability**, not performance or concurrency: SQLite is faster in-process and peak pipeline width is only 2, but a file cannot be safely shared across machines. Postgres is reachable over Tailscale from the laptop while the Gateway runs on the always-on host, and co-locating with Pholio's instance gives one backup and one monitoring surface. This deliberately deviates from OpenClaw's `node:sqlite` house convention.

**One table, not one per activity type.** A `type` column distinguishes entries. Separate tables would force any agent wanting a full timeline to stitch several queries together; one table with a type field serves both narrow queries ("open findings") and broad ones ("full history").

| Column | Purpose |
|---|---|
| `id` | Unique entry ID |
| `ts` | When written |
| `agent` | Who wrote it |
| `type` | plan / finding / deviation / code_change / test_result / decision / approval |
| `status` | open / resolved / approved / rejected |
| `severity` | info / warning / blocker — set by the agent that had full context |
| `needs_human` | Whether this must reach Quan |
| `reference` | Links to a feature or plan, chaining related entries |
| `content` | Human-readable summary |
| `code_path`, `code_lines` | File path and line range as separate queryable fields, not prose |
| `details` | JSON for specifics: which file, which test |
| `resolved_by` | Points to the entry that closed this one out |

`severity` and `needs_human` exist so that escalation judgement happens in the agent that had the full context and reasoning budget, and lands in the ledger as auditable data. The briefer then filters rather than decides. See [the milestone 1 plan](docs/milestone-1-plan.md) for the full DDL.

This solves two problems with one structure: a single agent re-orienting after a context reset, and a complete audit trail of what was done and where a human steered.

### Coordination and gating

**The orchestrator is a program, not an agent.** Two Code Mode scripts drive the pipeline: stage sequencing is `await`, parallelism is `Promise.all`, bounded rework is `while`. Each stage is an isolated child session that receives a prompt, returns JSON validated against a declared schema, and dies. No agent messages another. No agent polls for work.

The consequence that matters most: orchestration state lives in JavaScript variables, which cost zero tokens. A thirteen-stage pipeline accumulates no context. Sub-agents also get a stripped bootstrap and their tool output never propagates to the parent, so context rot is structurally prevented rather than managed.

**The ledger is the record, not the message bus.** Superseded from the original design: agents do not query the ledger for work. The plan reviewer *returns* its findings as validated JSON and the script passes them into the next prompt — no query round-trip, no race on whether a child saw a row. The ledger's load-bearing job is carrying prior findings and prior attempts into fresh review and rework rounds.

**Every round is a fresh session.** A reviewer holding its own prior verdict negotiates with itself instead of re-assessing, and by round three its transcript is mostly code that no longer exists. Fresh sessions read files from disk — what is, not what someone claimed to write. Prior findings are passed in explicitly as data, which preserves "I flagged this in round one" without the anchoring.

**No Redis.** The doorbell already exists: OpenClaw's Swarm scheduler lane, 42 host hooks including `subagent_spawned` / `subagent_ended`, and push-based completion via `sessions_yield`.

**The human gate is a script boundary.** A sub-agent cannot request approval — collector children fail closed by design. So phase 1 ends at the gate, briefs Quan, and exits; Quan's reply is an `approval` row that starts phase 2. Unbounded wait, survives a gateway restart, survives a phone going into a pocket. Phase 2 refuses to start without that row.

**Gated by default.** Stages open up to autonomous only once trusted.

### Context self-awareness

The pipeline tracks its own token usage and flags when it's approaching the limit. A fresh session reconstructs context by querying the ledger, not by reading a handoff note.

---

## Milestones

**1. Agent team + ledger, in plain text.** No voice, no phone. Stand up the nine role configs, the two pipeline scripts, and the Postgres ledger, driven through the Gateway as text. **Acceptance criterion:** one non-trivial change to the Remi repo itself goes goal → plan → review → approval → code → test → review → pass, fully traceable in the ledger, with one gate Quan actually used to redirect the plan. Self-hosting is the honest test — a pipeline that can't build Remi can't build Pholio. See [the full plan](docs/milestone-1-plan.md). *Everything below assumes this works.*

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

## Models

| # | Role | Model | Thinking |
|---|---|---|---|
| 1 | Goal setter | `anthropic/claude-sonnet-5` | `high` |
| 2 | Planner | `anthropic/claude-opus-5` | `high` |
| 3 | Plan reviewer | `openai/gpt-5.4` | `xhigh` |
| 4 | Human gate | — | — |
| 5 | Executor | `anthropic/claude-sonnet-5` | `high` |
| 6 | Code reviewer | `openai/gpt-5.4` | `xhigh` |
| 7 | Test planner | `anthropic/claude-sonnet-5` | `medium` |
| 8 | Test executor | `anthropic/claude-sonnet-5` | `low` |
| — | Briefer | `anthropic/claude-haiku-4-5` | `off` |

Only the two reviewers run on a frontier model, and they run on a **different family** from the roles they review. A reviewer sharing the author's training distribution shares its blind spots and will rubber-stamp a predictable class of mistake. The cost is a second provider and more stylistic noise to tune out.

The executor is Sonnet because it sits behind two verifiers — an objective test gate and an adversarial review — which is what an accountable loop is for. It is kept honest by schema rather than capability: `deviations` and `blocked` are required fields, so plan-versus-reality mismatches get reported instead of improvised around. Rework pass counts are logged; if the mean drifts above ~1.5, revisit on data.

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

## Docs

- [Resuming in a new session](docs/RESUME.md) — paste-ready starter prompt, and what state lives where.
- [Setup](docs/SETUP.md) — bare machine to working pipeline in six steps, plus a troubleshooting table.
- [Milestone 1 plan](docs/milestone-1-plan.md) — the pipeline design, ledger DDL, role configs, and six implementation steps, with what OpenClaw does and does not provide verified against source.
- [Merge handoff, 24 Aug](docs/handoff-2026-08-24-merge.md) — what changed when two parallel sessions merged, and what is open.
- [Original handoff note](docs/handoff-2026-08-23.md) — the source document this project was scoped from, with a table of decisions since superseded.

## Status

Just started. Nothing built yet.
