# Resuming in a new session

Paste the block below into a fresh agent session. Everything else it needs is in the
repository and the ledger.

---

## Starter prompt

```text
You are picking up the Remi project mid-build. Read these before doing anything:

1. docs/milestone-1-plan.md — start with "Where this stands" and "Next action".
   D1 to D13 are the decisions that constrain how the remaining work must be built.
2. docs/SETUP.md — how the environment is stood up, and a troubleshooting table.
3. The ledger, for the project's own record:
     docker exec remi-ledger psql -U remi -d remi -c \
       "SELECT id,ts,agent,type,status,severity,needs_human,content \
        FROM ledger WHERE reference='pipeline-bringup' ORDER BY id;"
   Anything with needs_human = true is unresolved and wants attention.
4. git log --oneline, for the rationale behind each commit.

Context you cannot get from those files:

- This is a voice-first dev environment built as a plugin on OpenClaw. Milestone 1 is
  the eight-role pipeline plus a briefer, in text only. No voice, no phone yet.
- Steps 1 to 5 and the sandbox are done and verified. Step 6, the phase-2 script, is
  next, and two blockers listed in the plan stand in front of it.
- Phase 1 runs today: `scripts/remi-plan.js` deployed into the orchestrator's
  workspace, run through the bootstrap in D12. One real run sits at gate row 35 on
  reference `the-repository-has-20260824-i2m`, awaiting Quan's decision.
- Nothing in this project may read or touch any other project on this machine,
  Pholio in particular. That is enforced by the sandbox, not by convention.
- Verify an agent's claims about its environment and its side effects from outside the
  sandbox. Four self-reports have been wrong so far, one of them flattering to the code
  it was testing.

Then confirm the environment is live before making changes:

  openclaw config validate
  openclaw agents list                     # expect 9
  openclaw sandbox explain --agent main    # expect runtime: sandboxed
  docker ps                                # expect remi-ledger
  git status                               # expect clean

Report what you found and what you intend to do first. Do not start editing until
you have read the four sources above.
```

---

## What state lives where

| Where | What | Survives a new session |
|---|---|---|
| `docs/milestone-1-plan.md` | Decisions D1–D13, step results, next action | ✅ committed |
| `docs/SETUP.md` | Environment reproduction, run procedure, troubleshooting | ✅ committed |
| `scripts/remi-plan.js`, `scripts/remi-gate.js` | Phase 1 and the gate recorder | ✅ committed |
| `roles/roles.json` + `scripts/apply-roles.mjs` | The whole roster, all OpenClaw config, and script deployment | ✅ committed |
| `plugin/`, `db/` | Ledger tools and schema | ✅ committed |
| Postgres, `reference: pipeline-bringup` | The project's own audit trail | ✅ on disk in a Docker volume |
| Git log | Why each change was made | ✅ committed |
| `~/.openclaw/openclaw.json` | Live config | regenerate with `apply-roles.mjs` |
| Provider credentials | Anthropic and DeepSeek tokens | in the auth store, not the repo |
| Sandbox image | `openclaw-sandbox:bookworm-slim` | rebuild per SETUP.md step 3 |

Nothing important lives only in a chat transcript. That was the point of seeding the
ledger during bringup rather than after.

## Verifying the handover actually works

This was tested rather than assumed. The planner was spawned cold, with no context
beyond the project path and the `ledger_query` tool, and asked what to do next. It
correctly identified the next action, which steps were complete, and the constraining
decisions — and caught two errors in the documents, which have since been fixed.

To repeat that check after a large change:

```bash
openclaw agent --agent main --message \
  "Use exec to query the ledger for reference pipeline-bringup, then state the single
   next action and the decisions that constrain it. Cite entry ids."
```

If the answer is wrong or vague, the ledger and the plan have drifted from reality and
one of them needs updating before continuing.
