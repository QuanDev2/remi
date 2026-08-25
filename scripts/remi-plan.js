// Phase 1 of the Remi pipeline: goal -> plan -> review -> ledger -> brief -> stop at the gate.
//
// HOW THIS RUNS
//
// This file is the body of one Code Mode cell, executed by the orchestrator (`main`).
// `scripts/apply-roles.mjs` deploys it into the orchestrator's workspace, so the model
// never transcribes it. The orchestrator runs a fixed four-line bootstrap instead:
//
//   const src = (await read({ path: "remi-plan.js" })).content;
//   const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
//   const run = new AsyncFunction("input", src);
//   return await run({ request: "<Quan's request, verbatim>" });
//
// That indirection is not decoration. A model asked to reproduce a long literal
// truncates it: `main` mangled a 48-character path three times in a row, and the
// planner did the same. Source that matters travels through `read`, not through a
// prompt.
//
// CONSEQUENCES OF THE RUNTIME
//
// - The body is evaluated by `new AsyncFunction`, which the host does not transpile.
//   So this is plain JavaScript, not TypeScript, and it uses `input` as its one
//   parameter. Top-level `await` and `return` are legal here and are used.
// - `import` and `require` are rejected by Code Mode. Everything comes from guest
//   globals: `agents.run`, `phase`, `log`, `read`, `ledger_write`, `ledger_query`.
// - The orchestrator's `read` reaches its own workspace only, so role thinking levels
//   arrive via `remi-roles.json`, deployed next to this file from `roles/roles.json`.
//   That keeps roles.json the single source of truth (C1).
//
// WHAT IT DELIBERATELY DOES NOT DO
//
// It does not approve anything. Phase 1 ends by writing an open `approval` row and
// briefing Quan (D4: the human gate is a script boundary, because a sub-agent cannot
// request approval). `remi-gate.js` records his answer; `remi-build.js` refuses to
// start without it.


const cfg = JSON.parse((await read({ path: "remi-roles.json" })).content);
const ROOT = cfg.projectRoot;
const thinkingFor = (role) => cfg.thinking[role];

const reference = String(input && input.reference ? input.reference : "").trim();
if (reference.length === 0) {
  return {
    status: "blocked",
    reason:
      "A reference is required. remi-interview.js mints it and freezes the criteria; " +
      "pass the reference it returned.",
  };
}

// ---------------------------------------------------------------------------
// Telemetry and commit anchoring
//
// Duplicated from remi-build.js rather than shared, because Code Mode rejects `import`
// and a cell body has no module system. The alternative — one script reading and eval'ing
// another — buys deduplication at the price of a harder failure mode.
// ---------------------------------------------------------------------------

/** The shell, resolved from the catalog: `exec` is not a plain guest global here. */
const shellHandle = catalog.all().filter(function (t) {
  return t.callableName === "exec";
})[0];

async function shell(command) {
  if (!shellHandle) return null;
  try {
    const res = await shellHandle({ command: command });
    return res && res.aggregated ? String(res.aggregated).trim() : null;
  } catch (err) {
    return null;
  }
}

// A missing commit is reported as unknown rather than guessed: a wrong anchor reads as
// verified, which is worse than an absent one.
const baseCommit =
  (await shell("git -C " + ROOT + " rev-parse --short HEAD")) || "unknown";

let currentStage = "start";

/** Run one child, timed and recorded. Telemetry failures never fail the run. */
async function runRole(role, prompt, schema, label) {
  const started = Date.now();
  try {
    const result = await agents.run(prompt, {
      agentId: role,
      thinking: thinkingFor(role),
      label: label,
      schema: schema,
    });
    await recordRun(role, started, "ok", null, { label: label });
    return result;
  } catch (err) {
    await recordRun(role, started, "failed", String(err), { label: label });
    throw err;
  }
}

async function recordRun(role, started, status, error, extra) {
  try {
    await agent_run_write({
      reference: reference,
      agent: role,
      model: cfg.models && cfg.models[role] ? cfg.models[role] : undefined,
      thinking: thinkingFor(role),
      stage: currentStage,
      status: status,
      duration_ms: Date.now() - started,
      error: error === null ? undefined : error,
      base_commit: baseCommit,
      details: extra || {},
    });
  } catch (err) {
    log("Telemetry row failed for " + role + ": " + String(err));
  }
}

// ---------------------------------------------------------------------------
// Schemas
//
// Every schema carries `status` with a legal `blocked` value and a `reason`, and
// every field is required (D9). An optional escape hatch is not an escape hatch: a
// child with no honest way to say "I cannot do this" either fabricates a conforming
// answer or abandons the structured_output call and fails with an error that explains
// nothing. Empty strings and empty arrays are the legal "nothing here" values, and
// each prompt below says so positively.
// ---------------------------------------------------------------------------

const str = { type: "string" };
const strs = { type: "array", items: str };
const enumOf = (values) => ({ type: "string", enum: values });

/** Object schema where every declared property is required. */
function obj(properties) {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

const STATUS = enumOf(["ok", "blocked"]);

// Steps carry a milestone id, and milestones are declared separately with the criteria
// each one satisfies. Phase 2 runs one milestone per invocation and stops, so this is
// what turns a 40-minute opaque run into something Quan watches in stages and can
// redirect between.
const PlanSchema = obj({
  status: STATUS,
  reason: str,
  milestones: {
    type: "array",
    items: obj({
      id: str,
      name: str,
      demonstrates: str,
      criteria: strs,
    }),
  },
  steps: {
    type: "array",
    items: obj({
      id: str,
      milestone: str,
      action: str,
      files: strs,
      rationale: str,
      criteria: strs,
    }),
  },
  risks: strs,
});

const FindingsSchema = obj({
  status: STATUS,
  reason: str,
  items: {
    type: "array",
    items: obj({
      concern: str,
      plan_step: str,
      recommendation: str,
      severity: enumOf(["info", "warning", "blocker"]),
      needs_human: { type: "boolean" },
      locations: {
        type: "array",
        items: obj({ path: str, lines: str, role: str }),
      },
    }),
  },
});

const BriefSchema = obj({
  status: STATUS,
  reason: str,
  headline: str,
  blockers: strs,
  decisions_needed: strs,
  brief: str,
  question: str,
});

// ---------------------------------------------------------------------------
// Prompt fragments
//
// Two rules hold throughout, both learned from failures recorded in the plan:
// phrasing stays positive (S7 — negation-heavy prompts made a child signal a tool
// call and emit nothing), and every task that touches real code states the project
// root and the route to it (D10 — a reviewer with no stated root searched the home
// directory and reviewed an unrelated repository).
// ---------------------------------------------------------------------------

/**
 * How a role with a project bind actually reaches files.
 *
 * Established by probe, not assumed: a role's `read` tool is bridged to its own
 * workspace and refuses paths under the project root, while `exec` runs in the
 * container where the project is bind-mounted at its true absolute path. So project
 * files are reachable through `exec` alone. The `cd` first also keeps long absolute
 * paths out of later commands, which is what keeps them intact.
 */
const FILE_ACCESS = `
The project is at ${ROOT}, mounted in your container at that same absolute path.
Your exec tool reaches it: begin with \`cd ${ROOT}\` and then use repo-relative
paths, such as \`ls docs\`, \`cat plugin/index.ts\`, \`rg ledger_write\`. Reading this
way keeps long absolute paths out of your commands, and repo-relative paths are also
what the ledger accepts as citations.

Cite the repo-relative path of each file you opened this way. When a concern is not
tied to a real file, describing it in words with an empty locations list is the
expected and correct answer.

A file named in the task that is absent from this project is itself a finding worth
reporting. The project root above is the whole search space.`;

const ONE_CALL = `
Call structured_output exactly once, with plain values and no code fence.`;

/**
 * Who writes the stage row.
 *
 * Observed on the first real run: with `ledger_write` in hand and no instruction, the
 * goal setter and the planner each recorded their own stage — the goal setter onto the
 * wrong reference entirely, filed as type `plan`. That is two rows per stage, split
 * attribution, and one polluted thread. The script owns stage persistence (D2), so the
 * boundary is stated in every task rather than left to be guessed.
 *
 * A role's own writes stay welcome for what its schema cannot carry: the plan reviewer
 * discovering that its container has no `node` belongs in the record, and no field of
 * FindingsSchema is the place for it.
 */
function ledgerNote(role) {
  return `
The reference for this run is ${reference}. Your stage is recorded for you: the
orchestrator writes the ledger row for ${role} from the result you return, so returning
the result is the whole job.

Your own ledger_write stays useful for what your result has no field for — an absent
tool, a broken environment, something you learned by doing the work. Those entries use
reference ${reference} so they stay on this thread.`;
}

function planPrompt(goal) {
  return `You are role 2, the planner, working on reference ${reference}.

Goal:
${goal.goal}

Acceptance criteria, as JSON:
${JSON.stringify(goal.criteria, null, 2)}
${FILE_ACCESS}

Read the code that each step would touch before you sequence it. A plan built on
assumed structure produces executor deviations later.

Produce an ordered list of steps, grouped into milestones. Each step names its
milestone, the files it touches, the criterion ids it serves, and why it exists. A step
serving no criterion is scope creep, so leave it out. Add a risks list: what could make
this plan wrong.

Files that a step creates are legitimate entries in that step's files list even
though they are absent today. Say so in the action text, so the reviewer can tell a
planned new file from a mistaken reference.

Milestones are how Quan watches this work happen. Phase 2 runs one milestone, stops,
shows him the diff and the test run, and waits. Between milestones he can redirect,
which is worth more to him than a single long run that finishes with everything already
decided.

So one rule governs the grouping: **a milestone leaves the test suite green and
demonstrates something Quan can look at.** A slice that ends with a half-wired change
and a red suite gives him rubble to review. Vertical slices satisfy this — one criterion
working end to end — where layers usually do not: "add the module, then wire it, then
test it" leaves the first two unreviewable.

State in each milestone's demonstrates field what he will be able to see when it lands.
One milestone is the right answer for work that genuinely cannot be split that way, and
saying so plainly beats inventing a seam that leaves the suite red.

Expected answers, both correct:
- The criteria can be satisfied as they stand: status "ok", reason "", milestones in
  the order they should be built, steps in execution order each naming its milestone,
  risks listed.
- The criteria need a decision only Quan can make: status "blocked", reason naming
  that exact decision, milestones and steps holding whatever sequencing is already
  settled, risks listed. Naming the decision is the useful answer.
${ledgerNote("the planner")}
${ONE_CALL}`;
}

function reviewPrompt(goal, plan) {
  return `You are role 3, the plan reviewer, working on reference ${reference}.
You review before Quan does, so what he reads is scrutiny rather than raw plan text.

Goal:
${goal.goal}

Acceptance criteria, as JSON:
${JSON.stringify(goal.criteria, null, 2)}

The plan under review, as JSON:
${JSON.stringify(
  { milestones: plan.milestones, steps: plan.steps, risks: plan.risks },
  null,
  2,
)}
${FILE_ACCESS}

Check specifically:
- Every criterion has a step that satisfies it.
- Every step traces to a criterion.
- Whether the plan assumes structure that the code lacks. Verify against the files.
- What breaks that the plan leaves out: callers, migrations, existing tests.
- Whether any step is ordered before something it depends on.
- Whether each milestone would leave the test suite green on its own. This one is worth
  real attention: phase 2 stops after each milestone and shows Quan the result, so a
  milestone that ends half-wired hands him rubble and wastes the stop. A milestone whose
  steps only add a module nobody calls yet is the common shape of this mistake.

Set severity and needs_human on each finding yourself. You hold the plan, the
criteria and the code; the briefer holds only your flags and takes them at face
value, so a blocker flagged as info reaches nobody. Use needs_human when Quan
decides before work starts.

Surfacing concerns is your lane, and the planner addresses them, so a concern plus a
recommendation is a complete answer on its own.

Expected answers, all correct:
- Concerns found: status "ok", reason "", items holding one entry each. Set plan_step
  to the step id a concern belongs to, or "" when it concerns the plan as a whole.
  In each location, set lines to a multirange literal such as "{[12,31)}" when you
  are pointing at specific lines, or "" for a whole-file reference.
- The plan is sound: status "ok", reason "the plan is sound", items empty. Reporting
  a sound plan plainly is worth more than a manufactured concern.
- The plan or the code is unreadable from here: status "blocked", reason naming what
  blocked you, items holding anything you did establish.
${ledgerNote("the plan reviewer")}
${ONE_CALL}`;
}

function briefPrompt(rows) {
  return `You are role 9, the briefer. Quan is about to decide whether this plan
proceeds, and he may be walking while he listens.

These are the ledger rows flagged for his attention on reference ${reference},
as JSON. Each arrives with severity and needs_human already set by the role that had
the full context:
${JSON.stringify(rows, null, 2)}

Filter on those flags, order them, and phrase them. Blockers first, then decisions
needed, then status. Every row that was flagged reaches him, because you are the last
step before his ear and nothing downstream checks this.

Lead with the answer. Keep options to one clause of tradeoff each, then recommend
one. End with the single question he answers at the gate. Keep row ids, table names
and file paths out of the spoken text; he asks for detail when he wants it.

Expected answers, both correct:
- Rows to convey: status "ok", reason "", headline holding the one-line answer,
  blockers and decisions_needed holding short phrases, brief holding the spoken
  prose, question holding what he decides.
- No rows were flagged: status "ok", reason "", headline saying the plan drew no
  flags, blockers and decisions_needed empty, brief saying so in one or two
  sentences, question asking whether to proceed.
${ONE_CALL}`;
}

// ---------------------------------------------------------------------------
// Ledger helpers
// ---------------------------------------------------------------------------

const SEVERITY_ORDER = { info: 0, warning: 1, blocker: 2 };

function maxSeverity(a, b) {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b;
}

/**
 * Write one entry, and keep the finding when its citations fail validation.
 *
 * `ledger_write` rejects a whole row if any cited path is absent from the project.
 * That guard is the point — it is what stops fabricated evidence entering the record
 * — but silently losing the finding would trade one failure for a worse one. So the
 * text survives, the rejected paths are named in it, and the row is escalated:
 * a role citing files that do not exist is itself something Quan should see.
 */
async function writeEntry(entry) {
  // Every row carries the commit it was written against, stamped here so no caller can
  // forget it. A line range without an anchor is precise today and misleading tomorrow.
  entry = Object.assign({ base_commit: baseCommit }, entry);
  try {
    const res = await ledger_write(entry);
    return { id: res.id, citations_rejected: false };
  } catch (err) {
    const cited = entry.locations || [];
    if (cited.length === 0) throw err;

    const paths = cited
      .map(function (l) {
        return l.path;
      })
      .join(", ");
    const retry = {
      agent: entry.agent,
      type: entry.type,
      reference: entry.reference,
      status: entry.status,
      severity: maxSeverity(entry.severity || "info", "warning"),
      needs_human: true,
      content:
        entry.content +
        "\n\nCitation validation rejected these paths: " +
        paths +
        ". The finding text is kept; its file references are unverified. " +
        "Rejection: " +
        String(err),
      details: entry.details,
    };
    const res = await ledger_write(Object.assign({ base_commit: baseCommit }, retry));
    log("Citations rejected for a " + entry.agent + " entry: " + paths);
    return { id: res.id, citations_rejected: true };
  }
}

/** Collect the rows Quan is meant to hear, using the briefer's own query (D8). */
async function attentionRows() {
  const res = await ledger_query({ reference: reference, needs_attention: true, limit: 50 });
  return (res.entries || []).map(function (row) {
    return {
      agent: row.agent,
      type: row.type,
      severity: row.severity,
      needs_human: row.needs_human,
      content: row.content,
    };
  });
}

/**
 * End the run: brief Quan on whatever is on the record, and return.
 *
 * Used for both outcomes. A run that stops early because a role reported `blocked`
 * still owes Quan a brief; stopping silently is the one unacceptable ending.
 */
async function briefAndReturn(outcome) {
  phase("Brief");
  const rows = await attentionRows();
  let brief;
  try {
    brief = await runRole("briefer", briefPrompt(rows), BriefSchema, "brief:" + reference);
  } catch (err) {
    // The briefer is the last step before Quan, so its failure is reported rather
    // than swallowed: the rows themselves still reach him, unphrased.
    brief = {
      status: "blocked",
      reason: "The briefer failed: " + String(err),
      headline: "Phase 1 finished; the brief itself failed to generate.",
      blockers: rows
        .filter(function (r) {
          return r.severity === "blocker";
        })
        .map(function (r) {
          return r.content;
        }),
      decisions_needed: [],
      brief: "",
      question: "Read the raw rows below and decide whether to proceed.",
    };
  }
  return Object.assign({ reference: reference, brief: brief, rows: rows }, outcome);
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

log("Phase 1 on reference " + reference);
phase("1 Criteria");

// The criteria are settled before this script runs, by remi-interview.js. That split
// exists because the goal setter has to talk to Quan and a swarm child cannot: it gets
// one prompt and dies with no channel to a human. So the interview is its own boundary,
// like the gate, and phase 1 starts from its frozen output.
const frozen = await ledger_query({
  reference: reference,
  type: "decision",
  status: "resolved",
  limit: 10,
});

const goalRow = (frozen.entries || []).filter(function (r) {
  return r.agent === "goal-setter" && r.details && Array.isArray(r.details.criteria);
})[0];

if (!goalRow) {
  return {
    status: "blocked",
    reason:
      "No frozen criteria for reference " +
      reference +
      ". Run remi-interview.js until it returns status \"ready\", then run this again.",
  };
}

const goal = {
  status: "ok",
  goal: goalRow.details.goal,
  criteria: goalRow.details.criteria,
  non_goals: goalRow.details.non_goals || [],
  reason: "",
};

if (goal.criteria.length === 0) {
  return {
    status: "blocked",
    reason: "The frozen criteria row for " + reference + " holds no criteria.",
  };
}

log(goal.criteria.length + " criteria read from entry " + goalRow.id + ".");
phase("2 Plan");

currentStage = "plan";
const plan = await runRole("planner", planPrompt(goal), PlanSchema, "plan:" + reference);

// No locations on the plan row, deliberately. Plan steps name files they will create,
// and citation validation rejects paths that do not exist yet — correctly, since it
// cannot tell a planned file from an invented one. Step files live in `details`,
// where they are recorded without claiming to be evidence.
const planRow = await writeEntry({
  agent: "planner",
  type: "plan",
  reference: reference,
  status: "open",
  severity: plan.status === "ok" ? "info" : "blocker",
  needs_human: plan.status !== "ok",
  // The row states the plan, rather than counting it. A6 asks a fresh session to
  // reconstruct the work from the ledger alone, and "5 steps recorded" reconstructs
  // nothing without opening details.
  content:
    plan.status === "ok"
      ? plan.steps.length +
        " steps in " +
        plan.milestones.length +
        " milestone(s), " +
        plan.risks.length +
        " risks. " +
        plan.milestones
          .map(function (m) {
            return m.id + " " + m.name + ": " + m.demonstrates;
          })
          .join(" | ")
      : "Planning is blocked: " + plan.reason,
  details: {
    milestones: plan.milestones,
    steps: plan.steps,
    risks: plan.risks,
    status: plan.status,
  },
});

if (plan.status !== "ok" || plan.steps.length === 0) {
  log("Stopping before review: the plan needs a decision from Quan.");
  return await briefAndReturn({
    stopped_at: "plan",
    gate_entry_id: null,
    goal_entry_id: goalRow.id,
    plan_entry_id: planRow.id,
  });
}

log(
  plan.steps.length +
    " steps planned across " +
    plan.milestones.length +
    " milestone(s).",
);
phase("3 Adversarial review");

currentStage = "plan-review";
const review = await runRole(
  "plan-reviewer",
  reviewPrompt(goal, plan),
  FindingsSchema,
  "review:" + reference,
);

const findingIds = [];
let citationsRejected = 0;
let worst = "info";

for (const item of review.items) {
  const locations = item.locations
    .filter(function (loc) {
      return loc.path && loc.path.length > 0;
    })
    .map(function (loc) {
      // "" is the schema's legal whole-file value; the ledger wants the key absent.
      const out = { path: loc.path, role: loc.role || "concern" };
      if (loc.lines && loc.lines.length > 0) out.lines = loc.lines;
      return out;
    });

  const row = await writeEntry({
    agent: "plan-reviewer",
    type: "finding",
    reference: reference,
    status: "open",
    severity: item.severity,
    needs_human: item.needs_human,
    content:
      item.concern +
      (item.plan_step ? " (step " + item.plan_step + ")" : " (whole plan)") +
      " Recommendation: " +
      item.recommendation,
    details: {
      concern: item.concern,
      plan_step: item.plan_step,
      recommendation: item.recommendation,
    },
    locations: locations,
  });

  findingIds.push(row.id);
  if (row.citations_rejected) citationsRejected += 1;
  worst = maxSeverity(worst, item.severity);
}

log(review.items.length + " findings, worst severity " + worst + ".");
phase("4 Gate");

// The gate row. Status stays `open`: this is the request for approval, not the approval.
// `remi-gate.js` appends Quan's answer as a second approval row, and phase 2 refuses to
// start until it finds one marked approved.
//
// `needs_human` is set from the worst review severity rather than always true. Quan is
// interviewed into the criteria before any of this runs, so by the gate he already
// understands the problem; a plan the reviewer found nothing blocking in does not need
// him to read it. A blocker still stops and waits. This is the difference between a gate
// that protects the criteria and a gate that just adds a wait.
//
// `details` carries the full plan because the ledger is what phase 2 reads. The
// executor's instructions come from this row plus Quan's direction, which is what
// makes his redirection provably change the work rather than merely be recorded.
const gateNeedsHuman = worst === "blocker";
const gateRow = await writeEntry({
  agent: "orchestrator",
  type: "approval",
  reference: reference,
  status: "open",
  severity: worst,
  needs_human: gateNeedsHuman,
  content:
    "Gate: plan for " +
    reference +
    " is ready for Quan. " +
    plan.steps.length +
    " steps in " +
    plan.milestones.length +
    " milestone(s), " +
    review.items.length +
    " review findings, worst severity " +
    worst +
    ".",
  details: {
    goal: goal.goal,
    criteria: goal.criteria,
    plan: { milestones: plan.milestones, steps: plan.steps, risks: plan.risks },
    findings: review.items,
    finding_entry_ids: findingIds,
    goal_entry_id: goalRow.id,
    plan_entry_id: planRow.id,
    citations_rejected: citationsRejected,
    review_status: review.status,
    review_reason: review.reason,
  },
});

log("Gate row " + gateRow.id + " written. Phase 1 ends here by design.");

return await briefAndReturn({
  stopped_at: "gate",
  gate_entry_id: gateRow.id,
  goal_entry_id: goalRow.id,
  plan_entry_id: planRow.id,
  finding_entry_ids: findingIds,
  worst_severity: worst,
  citations_rejected: citationsRejected,
  next_step:
    "Record the decision with remi-gate.js: run({ reference: \"" +
    reference +
    "\", decision: \"approved\" | \"rejected\", direction: \"<Quan's words>\" }).",
});
