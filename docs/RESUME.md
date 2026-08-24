# Resuming in a new session

Paste the block below into a fresh agent session. Everything else it needs is in the
repository and the ledger.

---

## Starter prompt

```text
You are picking up the Remi project mid-build. Read these before doing anything:

1. docs/milestone-1-plan.md — start with "Where this stands" and "Next action".
   D1 to D11 are the decisions that constrain how the remaining work must be built.
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
- Steps 1 to 4 and the sandbox are done and verified. Step 5 is next.
- Nothing in this project may read or touch any other project on this machine,
  Pholio in particular. That is enforced by the sandbox, not by convention.
- Verify an agent's claims about its own environment from outside the sandbox.
  Three separate agents misdescribed their own environment during bringup.

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
| `docs/milestone-1-plan.md` | Decisions D1–D11, step results, next action | ✅ committed |
| `docs/SETUP.md` | Environment reproduction, troubleshooting | ✅ committed |
| `roles/roles.json` + `scripts/apply-roles.mjs` | The whole roster and all OpenClaw config | ✅ committed |
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
