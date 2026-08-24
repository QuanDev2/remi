# Setup

Everything needed to get from a bare machine to a working pipeline. Most of it is one
script; the rest is listed here because a script cannot install a package manager, paste
a credential, or build a container image for you.

Run the numbered steps in order. Step 5 is idempotent and safe to re-run.

---

## 0. Prerequisites

| Requirement | Why | Check |
|---|---|---|
| Node `>=22.22.3 <23`, `>=24.15.0 <25`, or `>=25.9.0` | OpenClaw beta's engine range. Node 25.5 is **rejected** | `node -v` |
| Docker running | Sandbox backend, and the ledger Postgres | `docker info` |
| An Anthropic credential | Seven of the nine roles | — |
| A DeepSeek API key | The two cross-family reviewers | — |

## 1. Install OpenClaw from the beta channel

```bash
npm i -g openclaw@beta
openclaw --version     # expect 2026.8.1-beta.N or later
```

**The beta channel is required, not preferred.** `agents.run`, `phase`, and `log` — the
Swarm guest API the pipeline is built on — do not exist in `latest` or
`extended-stable`. On stable, `sessions_spawn` resolves at `accepted` rather than at
child completion, which makes the pipeline a cross-turn state machine instead of a
program. See D1 and step 1 in the milestone plan.

Then create baseline config and repair it for the beta schema:

```bash
openclaw setup --non-interactive --accept-risk
openclaw doctor --fix
```

`setup` ends by failing a Gateway health probe because no Gateway is running yet. That is
cosmetic; the config and workspace are written. `doctor --fix` migrates the config to the
beta schema and is required before some keys will validate.

## 2. Authenticate the providers

Anthropic, via a long-lived token from the Claude CLI:

```bash
claude setup-token                                                  # copy the token
openclaw models auth paste-api-key --provider anthropic --agent main
```

DeepSeek:

```bash
openclaw models auth paste-api-key --provider deepseek --agent main
```

Both prompt for the value. Type the command literally and paste at the prompt — never on
the command line, where it would land in shell history and the process list.

`--agent main` is required once a multi-agent roster exists, and credentials on `main`
reach the other roles through the shared-profile fallback.

Install the DeepSeek provider plugin:

```bash
openclaw plugins install clawhub:@openclaw/deepseek-provider
```

Verify:

```bash
openclaw models auth list --agent main    # expect anthropic:... and deepseek:manual
```

## 3. Build the sandbox image

Not shipped with the npm package. OpenClaw fails fast rather than substituting plain
`debian:bookworm-slim`, because its own image carries `python3` for the sandbox
write/edit helpers.

```bash
docker build -t openclaw-sandbox:bookworm-slim - <<'DOCKERFILE'
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
  bash ca-certificates curl git jq python3 ripgrep \
  && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --shell /bin/bash sandbox
USER sandbox
WORKDIR /home/sandbox
CMD ["sleep", "infinity"]
DOCKERFILE
```

## 4. Start the ledger and install the plugin

```bash
cd db && docker compose up -d && cd ..
docker exec remi-ledger psql -U remi -d remi -c '\dt'   # expect ledger, ledger_location
```

The migration in `db/migrations/` runs automatically, but **only on the first boot of an
empty volume**. To re-apply after changing it: `docker compose down -v && docker compose up -d`.

```bash
cd plugin && npm install && cd ..
openclaw plugins install --link "$PWD/plugin" --force
```

`--force` is needed because a local path is outside ClawHub's trust metadata.

## 5. Apply the roles

```bash
node scripts/apply-roles.mjs --dry-run    # inspect
node scripts/apply-roles.mjs              # apply
```

This owns everything reproducible: the nine agents, their models, per-agent `codeMode`,
tool profiles, sandbox policy and project binds, the model allowlist and model policy,
`tools.swarm`, `tools.alsoAllow`, `tools.elevated`, the ledger plugin's connection string
and project root, and each role's lane contract copied into its workspace.

Edit `roles/roles.json` rather than the OpenClaw config; re-run to apply.

If the project moves, change `projectRoot` in `roles/roles.json` and re-run.

## 6. Start the Gateway and verify

```bash
openclaw gateway run          # or: openclaw gateway install
openclaw config validate
openclaw agents list
openclaw plugins inspect remi --runtime --json | head -30
openclaw sandbox explain --agent plan-reviewer
```

Expected from `sandbox explain`: `runtime: sandboxed`, `mode: all`, two mounts (the agent
workspace `rw`, the project `ro`), and `ledger_write` / `ledger_query` in the allow list.

Containment check — every one of these should fail:

```bash
openclaw agent --agent plan-reviewer --message \
  "Run with exec and report verbatim: ls ~/.ssh; ls /Users/*/projects/apps"
```

The project should be the only visible entry under `projects/apps`, and `~/.ssh` should
not exist.

## 7. Run phase 1

`apply-roles.mjs` deploys `remi-plan.js`, `remi-gate.js` and a derived `remi-roles.json` into the
orchestrator's workspace. That deployment is the only route by which a committed script reaches the
runtime: the orchestrator's `read` tool is confined to its own workspace, and Code Mode rejects
`import` (D12).

```bash
openclaw agent --agent main --timeout 900 --message \
  "Run phase 1 of the pipeline on this request, following the Running a pipeline script section of
   your AGENTS.md: <the request, in Quan's words>"
```

Expect roughly ten minutes and a brief that ends at the gate. Then record the decision:

```bash
openclaw agent --agent main --timeout 300 --message \
  "Run remi-gate.js with reference <ref>, decision approved, direction '<your words>'"
```

Verify the run from outside the sandbox rather than from the agent's summary — four self-reports
have been wrong so far, one of them about a side effect:

```bash
docker exec remi-ledger psql -U remi -d remi -c \
  "SELECT id,agent,type,status,severity,needs_human,left(content,90) \
     FROM ledger WHERE reference='<ref>' ORDER BY id;"
```

Changing a pipeline script means re-running `apply-roles.mjs`; the deployed copy is what executes.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Config validation failed: tools: Invalid input` on `tools.swarm` | Running `latest`, not `@beta` |
| `Unrecognized key: "thinking"` under an agent entry | `thinking` is per-call, not per-agent. Do not hand-add it |
| `multi-agent rosters require agents.ownership="explicit"` | Run `apply-roles.mjs`, which sets it |
| `model not allowed: <ref>` | Two gates: `agents.defaults.models` and `modelPolicy.allow`. The script writes both |
| `Remi ledger is not configured` | Plugin cannot read its config, or `apply-roles.mjs` has not run |
| `bind mount source is outside allowed roots` | `dangerouslyAllowExternalBindSources` missing; the script sets it |
| A role reports a tool is missing | With `codeMode` on, tools are top-level async globals in the cell, not a flat tool list. `tools` and `ALL_TOOLS` are `undefined`; use `catalog.search(...)` |
| `structured_output was not called` | The child hit an error on an earlier step, or the prompt used negations. See D9 |
| `Path escapes sandbox root` from `read` | Expected. `read` reaches the agent's own workspace; project files go through `exec` after `cd <project root>` |
| A role reports the project as empty | Its prompt sent it to `read` instead of `exec`, or it has `projectAccess: none` |
| A pipeline script edit has no effect | The deployed copy in the orchestrator's workspace is what runs. Re-run `apply-roles.mjs` |
| `These paths do not exist in the project` | Citation validation. A cited file is absent — often a file the plan proposes to create. The finding is kept and flagged; the citation is dropped |
| `No open approval row exists for reference` | `remi-gate.js` ran before `remi-plan.js`, or against the wrong reference |
