# Handoff — merge of two parallel sessions, 24 Aug 2026

Two agents worked this repository in parallel. This records what merged, what changed
under your feet, and what is open. Read it once and then work from
[the milestone plan](milestone-1-plan.md) as usual.

Your work is committed as `745b03c` and none of it was discarded.

---

## 1. Your bug report was correct, and it was a real defect

Your `plan-reviewer` found this during the first real phase-1 run, on reference
`the-repository-has-20260824-i2m`:

> The containment check is a bare string prefix test (`abs.startsWith(resolve(projectRoot))`)
> with no separator guard, so a sibling directory whose name extends the root name passes
> containment.

True, verified independently, and now fixed. `remi-old`, `remi2` and `remi.bak` all
resolved as inside a project rooted at `remi` — which defeats the guard for the case most
likely to happen by accident, a backup or worktree beside the real checkout.

`plugin/index.ts` now uses a relative-path test: inside means a relative path that neither
escapes with `..` nor is absolute. `test/citation-containment.test.js` carries eight
regression tests, one of which asserts the old prefix check *would* have accepted the
sibling, so the cheaper version cannot return quietly.

Your entry 47 also noted that the multirange format check runs unconditionally while
containment is gated on `projectRoot`. Left as it is on purpose: folding the format check
under the guard would lose a friendly error when no root is configured.

## 2. The runtime drift is settled, and both of us were partly right

Our contracts disagreed about what the runtime offers. Probed all three runtimes to
settle it:

| Claim | Verdict |
|---|---|
| `tools` and `ALL_TOOLS` are undefined; use `catalog` | **Yours. Correct.** Kept |
| `read` refuses paths under the project root | **Mine was right for the current runtime.** `read` reaches the project from the orchestrator and from both workers probed |
| The orchestrator has no shell | `exec` is present |

Neither of us probed carelessly: the runtime changed between our probes as per-agent
`codeMode`, the sandbox and the project binds landed. So the read/shell sentences were
corrected in all seven contracts, and every contract now carries this:

> **Capability claims in this contract can go stale.** If a tool behaves differently from
> what you read here, trust the runtime, say so in your result, and do not work around it
> silently.

Prefer `catalog.search(...)` over a remembered tool name. Assume this file is a snapshot.

Your path-truncation finding is kept and generalised — every worker contract now opens
project work with a `cd` to the root, which also matches what the ledger accepts as a
citation.

## 3. `remi-plan.js` changed shape. Read it before extending it

The goal setter became an **interviewer**, at Quan's request: he describes what he wants,
it interrogates him, pushes back, and only then writes criteria. A swarm child cannot
interview anyone — one prompt, one typed result, no channel to a human — so the interview
is its own boundary script, exactly like your gate and for the same reason.

| Was | Now |
|---|---|
| `remi-plan.js` called `goal-setter` as stage 1 | It reads the **frozen criteria row** from the ledger |
| Took `{ request }`, minted the reference | Takes `{ reference }` and **requires** it |
| `goalPrompt`, `GoalSchema`, `mintReference` | Removed. `mintReference` moved to `remi-interview.js`, which is now what starts a run |

`scripts/remi-interview.js` runs one exchange per call: it returns
`{ status: "interviewing", question, draft }`, and you pass `answers` back grown by one.
It ends by writing the criteria freeze and returning `{ status: "ready", ... }`. Twelve
exchanges is a hard cap. Interview turns are deliberately **not** ledgered — only the
freeze is a decision; a row per question would bury the entries that matter.

Deployment is unchanged and still yours: `apply-roles.mjs` copies all three scripts plus
`remi-roles.json` into the orchestrator workspace, because Code Mode rejects `import`.
`remi-interview.js` was added to that list.

## 4. The gate is softer

`needs_human` on the gate row now derives from the worst review severity instead of being
always true:

```js
const gateNeedsHuman = worst === "blocker";
```

Quan is interviewed into the criteria before a plan exists, so by the gate he already
understands the problem. A plan the reviewer found nothing blocking in does not need him
to read it. A blocker still stops and waits.

This is one of two answers to a concern he raised: a rigid pipeline turns one small drift
into a full replay through the planner and the goal setter. The other answer is in §5.

## 5. Deviations are classified, and this is yours to implement

The plan is scaffolding; the **acceptance criteria are the contract**. The executor's
contract now says: *adapt freely while every criterion stays satisfiable, stop when one
does not.* A licence, not a confession.

`CodeChangeSchema` gains `scope` per deviation, and `remi-build.js` routes on it:

| `scope` | Means | Route |
|---|---|---|
| `implementation` | Same outcome, different shape | Continue. Record it. Interrupt nobody |
| `plan` | A step or its ordering is wrong; criteria hold | Planner amends the affected steps. Reviewer reviews **only the delta** |
| `criteria` | A criterion cannot be met, or was wrong | Stop. `blocked: true`. Reaches Quan |

Two rules that make this safe: under-classification is caught by the test lane, because
scenarios are written from the criteria; and deviations are **batched**, so the executor
collects them and reports once rather than halting on the first.

The goal setter is not in the amendment loop. If a criterion must change, Quan changes it
at the gate and his words become the criterion.

## 6. The test lane is unblocked

Your entry 34 was right that `node` and `npm` were missing from the container.

- `docker/sandbox-node.Dockerfile` adds Node 24 on top of the base image. `executor` and
  `test-executor` use it via `sandboxImage: "node"` in `roles.json`.
- Root `package.json` exists. The runner is `node --test`.

**The runner choice is a constraint, not a preference.** Sandboxed roles run with
`network: "none"`, so a role cannot `npm install` a framework during a turn. Anything else
would have to be baked into the image or vendored. Do not add a test dependency without
solving that first.

15 tests, green. Verified by mutation: removing a ledger type and downgrading the
multirange each fail the assertions covering them.

## 7. Also changed

- Goal setter: `anthropic/claude-opus-5`, `projectAccess: "ro"`, `coding` profile. It is
  the highest-leverage role and cannot ask good questions about code it cannot read.
- `roles.json` gained `sandboxImages` and per-role `sandboxImage`.
- `docs/SETUP.md` and `docs/RESUME.md` exist. `apply-roles.mjs` now owns every
  reproducible setting, including `tools.swarm`, `tools.elevated` and the plugin config.

---

## Open, and waiting on Quan

| Entry | |
|---|---|
| **35** | Your plan is parked at its gate. Its goal — give the repo a test target — is now satisfied by §6, so it may be moot. Its citation-validation test is not redundant and may be worth keeping |
| **32** | Your reviewer flagged the restoration proof in that plan as vacuous: `git diff` on an untracked file shows nothing whether or not a mutation was reverted. Its recommendation, a recorded checksum, is sound |
| **44** | Step 5's own gate |

## Next

`scripts/remi-build.js` — phase 2, and the only script still missing. It reads an approved
gate row, runs `executor ∥ test-planner`, then the bounded test/rework loop, then code
review. Tests run **before** review, and §5 governs deviation routing.

## One coordination rule

We independently built toward the same goal — your plan and my commit both aimed at giving
the repo a test target. That is the real cost of parallel sessions.

**One reference per feature, and check the ledger before starting.**

```bash
docker exec remi-ledger psql -U remi -d remi -c \
  "SELECT id,reference,agent,type,status,severity,needs_human,content \
   FROM ledger ORDER BY id DESC LIMIT 20;"
```

An open `plan` or `approval` row on a reference means someone is mid-flight. Pick that
thread up or pick a different one.
