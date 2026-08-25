// Phase 2 of the Remi pipeline: approved plan -> code and scenarios -> tests -> review.
//
// HOW THIS RUNS
//
// Deployed into the orchestrator's workspace by `scripts/apply-roles.mjs` and run as the
// body of one Code Mode cell, exactly like the other pipeline scripts (D12):
//
//   const src = (await read({ path: "remi-build.js" })).content;
//   const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
//   const run = new AsyncFunction("input", src);
//   return await run({ reference: "<the run's reference>" });
//
// WHAT IT REFUSES TO DO
//
// It refuses to start without an approved gate row for the reference. That refusal is the
// only thing making the gate load-bearing: two scripts with no check between them is one
// script with extra steps.
//
// THE SHAPE OF THE WORK
//
//   executor  ∥  test planner        two roles, one Promise.all, peak width 2
//        tests                       the objective check
//        rework loop                 bounded at 3 passes
//        code review                 only once tests are green
//        fix loop                    bounded at 3 passes
//        brief                       whatever Quan needs to hear
//
// Tests run before review on purpose. A failing test is a fact and a review comment is an
// opinion; the cheap objective check goes first, and review-first would put an approval row
// chronologically ahead of a failing test on the same reference.
//
// The test planner runs in parallel with the executor rather than after it, because it must
// not see the code. It receives the goal and the criteria and nothing else (A4). If that
// isolation ever looks inconvenient, it is doing its job: scenarios written from an
// implementation assert that the implementation exists.
//
// WHAT IT LEAVES ALONE
//
// It does not commit, and it does not push. The working tree is left dirty for Quan to read,
// because a pipeline that commits its own work removes the last cheap place to disagree with
// it.

const cfg = JSON.parse((await read({ path: "remi-roles.json" })).content);
const ROOT = cfg.projectRoot;
const thinkingFor = (role) => cfg.thinking[role];

const reference = String(input && input.reference ? input.reference : "").trim();
if (reference.length === 0) {
  return {
    status: "blocked",
    reason:
      "A reference is required. Call this script as run({ reference: \"...\" }), using the " +
      "reference from remi-plan.js.",
  };
}

// One milestone per invocation. Omitting it runs the first milestone that has no sign-off
// yet, which is what makes repeated calls walk the plan forward without bookkeeping.
const requestedMilestone = String(
  input && input.milestone ? input.milestone : "",
).trim();

// Bounded, both of them. An agent going round a loop for the third time is a signal, not
// something to grind through, and `maxTotalPerGroup` is a backstop rather than a design.
const MAX_TEST_PASSES = 3;
const MAX_REVIEW_PASSES = 3;

// ---------------------------------------------------------------------------
// Telemetry and commit anchoring
//
// `ledger` records what an agent produced. It records nothing about the execution, which
// left the plan's own commitments unanswerable: "revisit the model choice on data rather
// than instinct" needs a mean pass count, and "re-measure whether xhigh is honoured" needs
// per-role latency. Phase 1's first run was timed with a stopwatch on the CLI.
//
// So every child goes through runRole(), which times it, records it, and re-throws on
// failure. A failed run is the more valuable row: it is the one nobody remembers accurately.
//
// The base commit anchors every claim to the tree it was read from. Line ranges written
// against an unrecorded commit are precise until the next edit and misleading afterwards.
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

// Recorded once per run. A missing commit is reported as unknown rather than guessed: a
// wrong anchor is worse than an absent one, because it reads as verified.
const baseCommit =
  (await shell("git -C " + ROOT + " rev-parse --short HEAD")) || "unknown";

let currentStage = "start";
let currentMilestoneId = "";

/**
 * Run one child, timed and recorded.
 *
 * The recording is best-effort on purpose: telemetry that can fail a pipeline run is worse
 * than no telemetry. A lost row costs a data point; a lost run costs the work.
 */
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
      milestone: currentMilestoneId,
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
// Same two rules as phase 1 (D9): every schema has a legal way to say "I cannot", and every
// declared field is required, because an optional escape hatch is not an escape hatch.
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
const SEVERITY = enumOf(["info", "warning", "blocker"]);
const LEVEL = enumOf(["unit", "integration", "e2e"]);
const SCOPE = enumOf(["implementation", "plan", "criteria"]);
const LOCATIONS = { type: "array", items: obj({ path: str, lines: str, role: str }) };

// `deviations` and `blocked` are required, not optional. A detailed plan makes writing code
// easy; it does not make the hard case easy, which is reality contradicting the plan. A model
// under instruction pressure will force the plan onto the code and produce something
// plausible. Requiring the fields makes that failure visible instead of leaving it to
// character.
const CodeChangeSchema = obj({
  status: STATUS,
  reason: str,
  summary: str,
  files_changed: strs,
  deviations: {
    type: "array",
    items: obj({
      plan_step: str,
      expected: str,
      actual: str,
      action_taken: str,
      scope: SCOPE,
    }),
  },
  blocked: { type: "boolean" },
});

const ScenariosSchema = obj({
  status: STATUS,
  reason: str,
  scenarios: {
    type: "array",
    items: obj({
      id: str,
      criterion_id: str,
      given: str,
      when: str,
      then: str,
      level: LEVEL,
    }),
  },
  // A scenario the criteria do not cover is a gap found by the one role that never read the
  // plan. Worth its own field rather than buried in prose.
  criteria_gaps: strs,
});

const TestResultSchema = obj({
  status: STATUS,
  reason: str,
  all_passed: { type: "boolean" },
  command: str,
  results: {
    type: "array",
    items: obj({
      scenario_id: str,
      passed: { type: "boolean" },
      failure: str,
      locations: LOCATIONS,
    }),
  },
});

// The reviewer audits the executor's own deviation classifications.
//
// The executor grades its own homework here, and the grades are not neutral:
// "implementation" means nobody interrupts it, "criteria" means it stops and gets
// scrutinised. The stated backstop was that the test lane catches under-classification,
// which holds only when a scenario happens to cover the criterion in question.
//
// The reviewer already holds the diff and the plan, and it runs on a different model
// family, so auditing the labels costs no extra call and does not share the executor's
// blind spots. What it is looking for is the one failure that matters: a change filed as
// "implementation" that quietly moved observable behaviour.
const ReviewSchema = obj({
  status: STATUS,
  reason: str,
  approved: { type: "boolean" },
  items: {
    type: "array",
    items: obj({
      concern: str,
      recommendation: str,
      severity: SEVERITY,
      needs_human: { type: "boolean" },
      locations: LOCATIONS,
    }),
  },
  misclassified: {
    type: "array",
    items: obj({
      plan_step: str,
      claimed_scope: SCOPE,
      actual_scope: SCOPE,
      why: str,
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
// ---------------------------------------------------------------------------

const FILE_ACCESS = `
The project is at ${ROOT}, mounted in your container at that same absolute path.
Both read and exec reach it. Use read for a known file. Use exec for anything needing a
command, starting with \`cd ${ROOT}\` and then repo-relative paths: \`ls test\`,
\`cat plugin/index.ts\`, \`rg validateCitations\`. Repo-relative paths are also what the
ledger accepts as citations, and one cd keeps long absolute paths out of later commands.

Cite the repo-relative path of each file you opened. When a concern is not tied to a real
file, describing it in words with an empty locations list is the expected answer.`;

const ONE_CALL = `
Call structured_output exactly once, with plain values and no code fence.`;

function ledgerNote(role) {
  return `
The reference for this run is ${reference}. Your stage is recorded for you: the orchestrator
writes the ledger row for ${role} from the result you return, so returning the result is the
whole job.

Your own ledger_write stays useful for what your result has no field for — an absent tool, a
broken environment, something you learned by doing the work. Those entries use reference
${reference} so they stay on this thread.`;
}

const DEVIATION_RULES = `
Adapt freely while every acceptance criterion stays satisfiable, and stop when one does not.
The plan is scaffolding; the criteria are the contract. Rewriting a step to fit the code you
actually found is the job rather than an escalation.

Record every deviation with what the plan expected, what you found, what you did, and a scope:

- scope "implementation" — same outcome, a different shape, no criterion affected. Work
  continues and nobody is interrupted.
- scope "plan" — a step or its ordering is wrong while the criteria still hold. The planner
  amends the affected steps and the reviewer looks only at the delta.
- scope "criteria" — a criterion cannot be met, or was wrong. Set blocked true; this reaches
  Quan.

Classify honestly. An implementation deviation labelled criteria costs a round trip through
two roles and a human. Under-classification is caught by the test lane, since scenarios come
from the criteria.

Collect deviations and continue where you can: reporting five together costs one amendment
cycle instead of five. A reported deviation is a good outcome.`;

/** The frozen contract every code-side prompt opens with. */
function contractBlock(goal, criteria) {
  return `Goal:
${goal}

Acceptance criteria, as JSON. These are the contract:
${JSON.stringify(criteria, null, 2)}`;
}

function directionBlock(direction) {
  if (direction.length === 0) {
    return `
Quan approved this plan at the gate with no changes requested.`;
  }
  return `
Quan approved this plan at the gate with a direction, in his own words:

<<<DIRECTION
${direction}
DIRECTION

His direction takes precedence over the plan text where the two differ. Following it is
expected rather than a deviation.`;
}

/**
 * What milestone this invocation is building, and what Quan will look at when it lands.
 *
 * A plan predating milestones has none, and the whole plan is then one implicit milestone.
 * That keeps a plan approved before this existed runnable rather than stranded.
 */
function milestoneBlock(milestone) {
  if (!milestone) {
    return `This plan has one stage: every step below, in one run.`;
  }
  return `Milestone ${milestone.id} — ${milestone.name}.
When it lands, Quan sees: ${milestone.demonstrates}
It carries these criteria: ${
    milestone.criteria.length > 0 ? milestone.criteria.join(", ") : "the plan's criteria"
  }.`;
}

function executorPrompt(goal, criteria, steps, direction, attempts, milestone) {
  const history =
    attempts.length === 0
      ? `
This is the first attempt on this milestone.`
      : `
Earlier attempts on this milestone, oldest first, as JSON. This is a fresh session, so this
is everything you know about what has already been tried:
${JSON.stringify(attempts, null, 2)}

Reading these first is worth the time: a failure that survived a previous pass is usually a
misunderstanding of the code rather than a typo.`;

  return `You are role 5, the executor, working on reference ${reference}.

${contractBlock(goal, criteria)}

${milestoneBlock(milestone)}

The steps for this milestone, as JSON. These are the only steps in scope:
${JSON.stringify(steps, null, 2)}
${directionBlock(direction)}
${history}
${FILE_ACCESS}

Build what these steps describe. Write the code. Keep the change to what the steps and the
criteria require: retries, telemetry, validation and abstraction that no step asked for and
no criterion needs belong to a later conversation.

Leave the suite green. This milestone stops and gets shown to Quan when it lands, so a
half-wired change with a red suite gives him rubble to look at. Later milestones handle
later steps, and reaching for one of them early is how a stopping point stops being one.
${DEVIATION_RULES}

Expected answers, all correct:
- The work is done: status "ok", reason "", summary describing what changed, files_changed
  listing repo-relative paths you actually wrote, deviations holding any you made, blocked
  false.
- The work is done and reality differed: the same, with deviations describing each difference
  and its scope.
- A criterion cannot be met: status "ok", blocked true, deviations holding the criteria-scoped
  entry that explains which criterion and why. Stopping here is the correct answer.
- The task itself is unworkable from here: status "blocked", reason naming what blocked you,
  files_changed holding anything you did write, blocked true.
${ledgerNote("the executor")}
${ONE_CALL}`;
}

function fixPrompt(goal, criteria, steps, direction, findings, attempts, milestone) {
  return `You are role 5, the executor, working on reference ${reference}.
The tests are green and the code reviewer has raised findings on the diff.

${contractBlock(goal, criteria)}

${milestoneBlock(milestone)}

The steps for this milestone, as JSON:
${JSON.stringify(steps, null, 2)}
${directionBlock(direction)}

The reviewer's findings, as JSON:
${JSON.stringify(findings, null, 2)}

Earlier attempts on this milestone, oldest first, as JSON:
${JSON.stringify(attempts, null, 2)}
${FILE_ACCESS}

Address the findings, keeping the tests green. A finding you disagree with is worth
answering rather than obeying: record it as a deviation with scope "implementation" and say
in action_taken why the current shape is right. The reviewer reports and you fix, so a
reasoned refusal on the record is a legitimate outcome.
${DEVIATION_RULES}

Expected answers, all correct:
- Findings addressed: status "ok", reason "", summary describing the changes, files_changed
  listing what you wrote, deviations holding any disagreement you recorded, blocked false.
- A finding cannot be addressed without breaking a criterion: status "ok", blocked true, with
  a criteria-scoped deviation explaining which criterion and why.
${ledgerNote("the executor")}
${ONE_CALL}`;
}

/**
 * The test planner's prompt, and the one place in this script where what is *absent* matters
 * more than what is present.
 *
 * It receives the goal and the criteria. It receives no plan, no steps, no file list, no
 * diff, and no direction text — because Quan's direction is written about a plan and would
 * carry implementation shape with it. That absence is criterion A4, and it is checkable by
 * reading this function.
 */
function scenarioPrompt(goal, criteria) {
  return `You are role 7, the test planner, working on reference ${reference}.

${contractBlock(goal, criteria)}

Write test scenarios in plain language, one per criterion at minimum, each in given / when /
then form and tagged unit, integration or e2e. Cover the boundaries a criterion implies: a
criterion about "larger than 10MB" wants scenarios just under, exactly at, and just over.

Work from the criteria alone. You have deliberately not been given the plan or the code, so
that your scenarios describe the promise made to Quan rather than the shape of somebody's
implementation. A scenario you need that no criterion covers is a gap in the criteria found
by the one role that never read the plan: put it in criteria_gaps.

Expected answers, all correct:
- Scenarios written: status "ok", reason "", scenarios holding one entry per case with the
  criterion id it verifies, criteria_gaps holding anything the criteria left out.
- A criterion is untestable as written: status "ok", reason "", scenarios covering the
  testable criteria, criteria_gaps naming the untestable one and why. That is a real finding
  about the criterion.
- The criteria are unusable as a whole: status "blocked", reason naming the problem,
  scenarios empty, criteria_gaps holding what you did establish.
${ledgerNote("the test planner")}
${ONE_CALL}`;
}

function testPrompt(scenarios, attempts, changedFiles, milestone, deferred) {
  const history =
    attempts.length === 0
      ? `
This is the first test run for this milestone.`
      : `
Earlier passes, oldest first, as JSON. This is a fresh session, so this is everything you
know about what has been tried:
${JSON.stringify(attempts, null, 2)}`;

  const later =
    deferred.length === 0
      ? ``
      : `
Scenarios belonging to later milestones, as JSON. They are listed so you can recognise them
rather than verify them: work that satisfies these is not in yet, and reporting them as
failures here would bury the results that matter.
${JSON.stringify(deferred, null, 2)}`;

  return `You are role 8, the test executor, working on reference ${reference}.

${milestoneBlock(milestone)}

The scenarios to verify now, as JSON:
${JSON.stringify(scenarios, null, 2)}
${later}

Files the executor reports changing:
${JSON.stringify(changedFiles, null, 2)}
${history}
${FILE_ACCESS}

Turn the scenarios into runnable tests, match the project's existing conventions, and run
them. Read a neighbouring test in \`test/\` before writing a new one: the suite runs on
\`node --test\` with no external dependencies, and your container has no network, so a test
framework that needs installing is out of reach. Zero-dependency assertions from
\`node:assert/strict\` are the house style.

Run the suite with \`cd ${ROOT} && npm test\` and report what actually happened. Where a test
fails, give the scenario id, what was expected, what happened, and the location with
role "failure-site".

Run the whole suite, not only the tests you added. A milestone is a stopping point Quan
looks at, so an existing test this work broke matters as much as a new one that fails, and
it belongs in results with its scenario id set to "regression".

Deciding what correct behaviour is belongs to the scenarios, and fixing the code belongs to
the executor. A failing test is your output. Reporting a real failure plainly protects the
only objective signal in this pipeline.

Expected answers, all correct:
- Everything passed: status "ok", reason "", all_passed true, command holding what you ran,
  results holding one entry per scenario with passed true and failure "".
- Some failed: status "ok", reason "", all_passed false, results holding the failures with
  their locations alongside the passes.
- A scenario looks wrong: status "ok", all_passed reflecting the real run, and the scenario's
  result carrying your concern in failure rather than an assertion bent until it passes.
- The suite could not run: status "blocked", reason naming exactly what stopped it — a missing
  runtime, a missing script — with all_passed false.
${ledgerNote("the test executor")}
${ONE_CALL}`;
}

function reviewPrompt(goal, criteria, steps, changedFiles, deviations, priorFindings) {
  return `You are role 6, the code reviewer, working on reference ${reference}.
The tests are green, so behaviour against the criteria is already established.

${contractBlock(goal, criteria)}

The approved plan for this milestone, as JSON:
${JSON.stringify(steps, null, 2)}

Files the executor reports changing:
${JSON.stringify(changedFiles, null, 2)}

Deviations the executor reported, with the scope it assigned each one, as JSON:
${JSON.stringify(deviations, null, 2)}

Findings already on the record for this run, as JSON. A concern raised in an earlier round
and still unaddressed is more serious than a first-time finding, and saying so is useful:
${JSON.stringify(priorFindings, null, 2)}
${FILE_ACCESS}

Read the diff with \`cd ${ROOT} && git diff\` and \`git status --short\`, and read the changed
files themselves. Spend your attention on what tests cannot see: design, security,
maintainability, missed callsites, error paths no criterion covers.

Behavioural correctness against the criteria belongs to the test executor, which ran before
you, so a passing test is settled. Rewriting the code belongs to the executor: you report.

**Audit the deviation scopes.** The executor classified its own deviations, and the labels
carry consequences: "implementation" continues silently, "plan" is recorded as a plan that
drifted, "criteria" stops the run and reaches Quan. You hold the diff and the plan, so you
are the one reader positioned to check those labels against what the code actually does.

The label worth your attention is "implementation" on a change that moved observable
behaviour — an input now accepted that was refused before, a different status code, a
changed default. That is criteria-scoped whatever it was called, and catching it here is the
difference between Quan learning about it now and discovering it in use. A scope you agree
with needs no entry.

Set severity and needs_human yourself. Style preference is info. Something that corrupts
data, leaks a credential, or breaks a caller is a blocker, and Quan sees it.

Expected answers, all correct:
- The code is sound and the scopes are right: status "ok", reason "", approved true, items
  empty, misclassified empty. Saying so plainly is worth more than a manufactured concern.
- Concerns found: status "ok", reason "", approved false, items holding one entry each with
  locations. Set lines to a multirange literal such as "{[12,31)}" when pointing at specific
  lines, or "" for a whole-file reference.
- A scope is wrong: misclassified holding one entry per label you disagree with, naming the
  step, what it was called, what it actually is, and why. This is compatible with approved
  true: the code can be good and the label still wrong.
- The diff is unreadable from here: status "blocked", reason naming what blocked you, items
  holding anything you did establish, approved false.
${ledgerNote("the code reviewer")}
${ONE_CALL}`;
}


function briefPrompt(rows, outcome) {
  return `You are role 9, the briefer. Phase 2 has finished and Quan needs to know how it
went. He may be walking while he listens.

The outcome in numbers, as JSON:
${JSON.stringify(outcome, null, 2)}

The ledger rows flagged for his attention on reference ${reference}, as JSON. Each arrives
with severity and needs_human already set by the role that had the full context:
${JSON.stringify(rows, null, 2)}

Filter on those flags, order them, and phrase them. Blockers first, then decisions needed,
then status. Every row that was flagged reaches him, because you are the last step before his
ear and nothing downstream checks this.

Lead with the answer: whether the work is done, tested and reviewed. Keep options to one
clause of tradeoff each, then recommend one. End with the single question he answers next.
Keep row ids, table names and file paths out of the spoken text; he asks for detail when he
wants it. The working tree is left uncommitted for him, which is worth one sentence.

Expected answers, both correct:
- Rows to convey: status "ok", reason "", headline holding the one-line answer, blockers and
  decisions_needed holding short phrases, brief holding the spoken prose, question holding
  what he decides next.
- Nothing was flagged: status "ok", reason "", headline saying the work went green and clean,
  blockers and decisions_needed empty, brief saying so in one or two sentences, question
  asking whether to commit.
${ONE_CALL}`;
}

// ---------------------------------------------------------------------------
// Ledger helpers
// ---------------------------------------------------------------------------

const SEVERITY_ORDER = { info: 0, warning: 1, blocker: 2 };

// Deviation scopes, ordered by how much they interrupt. Used to tell an understated label
// from an overstated one when the reviewer disputes the executor's classification.
const SEVERITY_ORDER_SCOPE = { implementation: 0, plan: 1, criteria: 2 };

function maxSeverity(a, b) {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b;
}

/** Drop the schema's legal "" placeholders, which the ledger wants absent instead. */
function cleanLocations(locations) {
  return (locations || [])
    .filter(function (loc) {
      return loc && loc.path && loc.path.length > 0;
    })
    .map(function (loc) {
      const out = { path: loc.path, role: loc.role || "finding" };
      if (loc.lines && loc.lines.length > 0) out.lines = loc.lines;
      return out;
    });
}

/**
 * Write one entry, keeping the content when its citations fail validation.
 *
 * Same fallback as phase 1, for the same reason: the guard against fabricated evidence is
 * worth keeping, and losing a real finding to it would trade one failure for a worse one.
 * Here it matters more — a test failure's location is the most useful thing in the row.
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
    const res = await ledger_write({
      agent: entry.agent,
      type: entry.type,
      reference: entry.reference,
      base_commit: baseCommit,
      status: entry.status,
      severity: maxSeverity(entry.severity || "info", "warning"),
      needs_human: true,
      content:
        entry.content +
        "\n\nCitation validation rejected these paths: " +
        paths +
        ". The text is kept; its file references are unverified. Rejection: " +
        String(err),
      details: entry.details,
    });
    log("Citations rejected for a " + entry.agent + " entry: " + paths);
    return { id: res.id, citations_rejected: true };
  }
}

const written = { code_change: 0, deviation: 0, test_result: 0, finding: 0, plan: 0 };

function count(type) {
  written[type] = (written[type] || 0) + 1;
}

/** Every finding on this reference, oldest first, for a fresh reviewer to read (D5). */
async function priorFindings() {
  const res = await ledger_query({ reference: reference, type: "finding", limit: 60 });
  return (res.entries || [])
    .map(function (row) {
      return {
        id: Number(row.id),
        agent: row.agent,
        severity: row.severity,
        status: row.status,
        concern: row.content,
      };
    })
    .reverse();
}

async function attentionRows() {
  const res = await ledger_query({ reference: reference, needs_attention: true, limit: 60 });
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
 * End the run with a brief, whatever the outcome.
 *
 * Every exit from this script comes through here. A phase that stops because a criterion
 * turned out to be wrong owes Quan an explanation at least as much as one that succeeds, and
 * stopping silently is the single unacceptable ending.
 */
async function briefAndReturn(outcome) {
  currentStage = "brief";
  phase("Brief");
  const rows = await attentionRows();
  const summary = Object.assign({ reference: reference, rows_written: written }, outcome);
  let brief;
  try {
    brief = await runRole(
      "briefer",
      briefPrompt(rows, summary),
      BriefSchema,
      "brief2:" + reference,
    );
  } catch (err) {
    brief = {
      status: "blocked",
      reason: "The briefer failed: " + String(err),
      headline: "Phase 2 finished; the brief itself failed to generate.",
      blockers: rows
        .filter(function (r) {
          return r.severity === "blocker";
        })
        .map(function (r) {
          return r.content;
        }),
      decisions_needed: [],
      brief: "",
      question: "Read the raw rows below and decide what happens next.",
    };
  }
  return Object.assign({ brief: brief, rows: rows }, summary);
}

/** Record one executor result: the code_change row, then a row per deviation. */
async function recordAttempt(result, label) {
  const changeRow = await writeEntry({
    agent: "executor",
    type: "code_change",
    reference: reference,
    status: result.blocked ? "open" : "resolved",
    severity: result.blocked ? "blocker" : "info",
    needs_human: Boolean(result.blocked),
    content:
      label +
      ": " +
      (result.summary || "no summary given") +
      " Files: " +
      (result.files_changed.length > 0 ? result.files_changed.join(", ") : "none reported") +
      ".",
    details: {
      summary: result.summary,
      files_changed: result.files_changed,
      blocked: result.blocked,
      status: result.status,
      reason: result.reason,
      label: label,
    },
    locations: cleanLocations(
      result.files_changed.map(function (p) {
        return { path: p, lines: "", role: "changed" };
      }),
    ),
  });
  count("code_change");

  for (const dev of result.deviations) {
    // Severity follows scope, so the briefer's filter does the right thing without judgement:
    // an implementation deviation is a note, a plan deviation costs an amendment cycle, and a
    // criteria deviation is the pipeline telling Quan his contract was wrong.
    const severity =
      dev.scope === "criteria" ? "blocker" : dev.scope === "plan" ? "warning" : "info";
    await writeEntry({
      agent: "executor",
      type: "deviation",
      reference: reference,
      status: dev.scope === "implementation" ? "resolved" : "open",
      severity: severity,
      needs_human: dev.scope === "criteria",
      content:
        "[" +
        dev.scope +
        "] step " +
        (dev.plan_step || "unattributed") +
        ": expected " +
        dev.expected +
        "; found " +
        dev.actual +
        "; did " +
        dev.action_taken,
      details: dev,
    });
    count("deviation");
  }

  return changeRow;
}

async function recordTestResult(result, pass) {
  const failures = result.results.filter(function (r) {
    return !r.passed;
  });
  const locations = [];
  for (const r of failures) {
    for (const loc of cleanLocations(r.locations)) locations.push(loc);
  }

  // One location row per (entry, path), so a repeated path would collide on the primary key.
  const seen = {};
  const unique = locations.filter(function (loc) {
    if (seen[loc.path]) return false;
    seen[loc.path] = true;
    return true;
  });

  const row = await writeEntry({
    agent: "test-executor",
    type: "test_result",
    reference: reference,
    status: result.all_passed ? "resolved" : "open",
    severity: result.all_passed ? "info" : "warning",
    needs_human: false,
    content:
      "Pass " +
      pass +
      ": " +
      (result.all_passed
        ? "all " + result.results.length + " scenarios green"
        : failures.length + " of " + result.results.length + " scenarios failing") +
      " via `" +
      (result.command || "unreported command") +
      "`." +
      (failures.length > 0
        ? " First failure: " + (failures[0].failure || "unreported")
        : ""),
    details: {
      pass: pass,
      all_passed: result.all_passed,
      command: result.command,
      results: result.results,
      status: result.status,
      reason: result.reason,
    },
    locations: unique,
  });
  count("test_result");
  return row;
}

async function recordFindings(agent, items) {
  const ids = [];
  let worst = "info";
  for (const item of items) {
    const row = await writeEntry({
      agent: agent,
      type: "finding",
      reference: reference,
      status: "open",
      severity: item.severity,
      needs_human: item.needs_human,
      content: item.concern + " Recommendation: " + item.recommendation,
      details: { concern: item.concern, recommendation: item.recommendation },
      locations: cleanLocations(item.locations),
    });
    count("finding");
    ids.push(row.id);
    worst = maxSeverity(worst, item.severity);
  }
  return { ids: ids, worst: worst };
}

/**
 * Every deviation reported so far this run, for the reviewer to audit.
 *
 * Read back from the ledger rather than accumulated in a variable, so the reviewer audits
 * what was actually recorded. A deviation that failed to persist is not one the reviewer
 * should be grading, and the difference would otherwise be invisible.
 */
async function allDeviations() {
  const res = await ledger_query({ reference: reference, type: "deviation", limit: 60 });
  return (res.entries || [])
    .map(function (row) {
      return Object.assign({ entry_id: Number(row.id) }, row.details || {});
    })
    .reverse();
}

/**
 * Record the reviewer's disagreements with the executor's own scope labels.
 *
 * A claimed `implementation` that is really `criteria` is the case worth catching: it means
 * observable behaviour moved while the run continued silently, so it reaches Quan. A
 * disagreement in the other direction is over-caution and only worth a note.
 */
async function recordMisclassifications(entries) {
  const ids = [];
  for (const m of entries || []) {
    const understated =
      SEVERITY_ORDER_SCOPE[m.actual_scope] > SEVERITY_ORDER_SCOPE[m.claimed_scope];
    const row = await writeEntry({
      agent: "code-reviewer",
      type: "finding",
      reference: reference,
      status: "open",
      severity: understated
        ? m.actual_scope === "criteria"
          ? "blocker"
          : "warning"
        : "info",
      needs_human: understated && m.actual_scope === "criteria",
      content:
        "Deviation scope audit on step " +
        (m.plan_step || "unattributed") +
        ": the executor called it " +
        m.claimed_scope +
        " and the reviewer reads it as " +
        m.actual_scope +
        ". " +
        m.why,
      details: m,
    });
    count("finding");
    ids.push(row.id);
  }
  if ((entries || []).length > 0) {
    log((entries || []).length + " deviation scope(s) disputed by the reviewer.");
  }
  return ids;
}

// ---------------------------------------------------------------------------
// The gate check
//
// This is the whole reason phase 2 is a separate script. Without it, the gate is a pause
// rather than a control, and A3 is unverifiable.
// ---------------------------------------------------------------------------

log("Phase 2 on reference " + reference);
phase("0 Gate check");

const approvals = await ledger_query({
  reference: reference,
  type: "approval",
  status: "approved",
  limit: 10,
});

// remi-gate.js stamps details.decision, which distinguishes Quan's answer from any other
// approved row that might land on this reference later.
const decision = (approvals.entries || []).filter(function (row) {
  return row.details && row.details.decision === "approved";
})[0];

if (!decision) {
  return {
    status: "blocked",
    reference: reference,
    reason:
      "No approved gate row exists for reference " +
      reference +
      ". Phase 2 starts from Quan's decision: run remi-gate.js, or check the reference.",
  };
}

const direction = String(
  decision.details && decision.details.direction ? decision.details.direction : "",
).trim();

// The plan and criteria live on the gate request that this decision resolved. The approval
// row carries the answer; the request carries what was answered.
const requests = await ledger_query({
  reference: reference,
  type: "approval",
  status: "open",
  limit: 10,
});
const resolvedId =
  decision.details && decision.details.resolves_entry
    ? Number(decision.details.resolves_entry)
    : null;
const gateRequest =
  (requests.entries || []).filter(function (row) {
    return resolvedId !== null && Number(row.id) === resolvedId;
  })[0] || (requests.entries || [])[0];

if (!gateRequest || !gateRequest.details || !gateRequest.details.plan) {
  return {
    status: "blocked",
    reference: reference,
    reason:
      "The approved decision on " +
      reference +
      " points at no gate request carrying a plan. Phase 1 writes that row; re-run " +
      "remi-plan.js if the thread is incomplete.",
  };
}

const goal = String(gateRequest.details.goal || "");
const criteria = gateRequest.details.criteria || [];
let steps = (gateRequest.details.plan && gateRequest.details.plan.steps) || [];

if (steps.length === 0 || criteria.length === 0) {
  return {
    status: "blocked",
    reference: reference,
    reason:
      "The approved plan on " +
      reference +
      " has " +
      steps.length +
      " steps and " +
      criteria.length +
      " criteria. Phase 2 needs both.",
  };
}

log(
  "Gate cleared: entry " +
    decision.id +
    " approved " +
    steps.length +
    " steps against " +
    criteria.length +
    " criteria" +
    (direction.length > 0 ? ", with direction" : "") +
    ".",
);

// Quan's direction reshapes the plan side only. The criteria the test planner works from are
// the ones frozen before the plan existed, so a direction that changes what "done" means
// would leave the scenarios testing the old contract. That gap is surfaced rather than
// papered over: the run reports it, and amending criteria is a fresh interview.
const directionRecorded =
  direction.length > 0
    ? (
        await writeEntry({
          agent: "orchestrator",
          type: "decision",
          reference: reference,
          status: "resolved",
          severity: "info",
          needs_human: false,
          content:
            "Quan's gate direction is in force for the executor and the planner: " +
            direction +
            " Scenarios continue to come from the frozen criteria, so a direction that " +
            "changes what done means wants a fresh interview rather than this run.",
          details: { direction: direction, applied_to: ["executor", "planner"] },
        })
      ).id
    : null;

// ---------------------------------------------------------------------------
// Milestone selection
//
// One milestone per invocation, then stop and brief. Quan asked for the work in stages he
// can look at and redirect between, and short runs make an in-flight interrupt unnecessary:
// the stopping point is the plan's own seam rather than a checkpoint bolted into a loop.
//
// A plan approved before milestones existed carries none, and the whole plan is then one
// implicit stage. Keeping that path alive matters — there is a real approved plan in the
// ledger from before this change.
// ---------------------------------------------------------------------------

const allMilestones =
  (gateRequest.details.plan && gateRequest.details.plan.milestones) || [];

// Sign-offs already on the record tell us which milestones are behind us, so a repeated call
// walks the plan forward with no bookkeeping passed in.
const signOffs = await ledger_query({
  reference: reference,
  type: "decision",
  limit: 60,
});
const done = {};
for (const row of signOffs.entries || []) {
  if (row.details && row.details.sign_off && row.details.milestone) {
    done[row.details.milestone] = true;
  }
}

let milestone = null;
if (allMilestones.length > 0) {
  if (requestedMilestone.length > 0) {
    milestone = allMilestones.filter(function (m) {
      return m.id === requestedMilestone;
    })[0];
    if (!milestone) {
      return {
        status: "blocked",
        reference: reference,
        reason:
          "Milestone " +
          requestedMilestone +
          " is not in this plan. It holds: " +
          allMilestones
            .map(function (m) {
              return m.id;
            })
            .join(", ") +
          ".",
      };
    }
  } else {
    milestone = allMilestones.filter(function (m) {
      return !done[m.id];
    })[0];
    if (!milestone) {
      return {
        status: "ok",
        reference: reference,
        reason:
          "Every milestone on this plan has a sign-off: " +
          Object.keys(done).join(", ") +
          ". There is nothing left to build.",
        milestones_complete: Object.keys(done),
      };
    }
  }
}

// Steps for this milestone only. A plan without milestones runs whole, which is what the
// pre-milestone approved plan needs.
const milestoneSteps = milestone
  ? steps.filter(function (s) {
      return s.milestone === milestone.id;
    })
  : steps;

if (milestoneSteps.length === 0) {
  return {
    status: "blocked",
    reference: reference,
    reason:
      "Milestone " +
      milestone.id +
      " has no steps assigned to it. The plan's steps name milestones " +
      JSON.stringify(
        steps.map(function (s) {
          return s.milestone;
        }),
      ) +
      ".",
  };
}

const remaining = allMilestones.filter(function (m) {
  return !done[m.id] && (!milestone || m.id !== milestone.id);
});

log(
  milestone
    ? "Milestone " +
        milestone.id +
        " (" +
        milestone.name +
        "): " +
        milestoneSteps.length +
        " steps, " +
        remaining.length +
        " milestone(s) after it."
    : "No milestones on this plan; running all " + steps.length + " steps as one stage.",
);

// ---------------------------------------------------------------------------
// Stage 1: build and plan the tests, in parallel
// ---------------------------------------------------------------------------

currentStage = "build";
currentMilestoneId = milestone ? milestone.id : "whole-plan";
phase(
  milestone
    ? "1 Build " + milestone.id + " and plan the tests"
    : "1 Build and test planning",
);
log("Executor and test planner running in parallel.");

const attempts = [];
let executorResult;
let scenarioResult;

try {
  const both = await Promise.all([
    runRole(
      "executor",
      executorPrompt(goal, criteria, milestoneSteps, direction, attempts, milestone),
      CodeChangeSchema,
      "build:" + reference,
    ),
    runRole(
      "test-planner",
      scenarioPrompt(goal, criteria),
      ScenariosSchema,
      "scenarios:" + reference,
    ),
  ]);
  executorResult = both[0];
  scenarioResult = both[1];
} catch (err) {
  // One of a parallel pair failing leaves the other's work unrecorded and unknowable, so the
  // honest report is that the stage failed rather than a guess at which half survived.
  await writeEntry({
    agent: "orchestrator",
    type: "finding",
    reference: reference,
    status: "open",
    severity: "blocker",
    needs_human: true,
    content:
      "Phase 2 stopped in its first stage: a parallel child failed. " +
      String(err) +
      " Nothing was recorded from either the executor or the test planner in this pass.",
    details: { stage: "build-and-scenarios", error: String(err) },
  });
  count("finding");
  return await briefAndReturn({
    status: "blocked",
    stopped_at: "build",
    reason: String(err),
  });
}

const changeRow = await recordAttempt(executorResult, "Initial build");

const scenarioRow = await writeEntry({
  agent: "test-planner",
  type: "plan",
  reference: reference,
  status: scenarioResult.status === "ok" ? "resolved" : "open",
  severity: scenarioResult.criteria_gaps.length > 0 ? "warning" : "info",
  needs_human: false,
  content:
    scenarioResult.scenarios.length +
    " scenarios from " +
    criteria.length +
    " criteria" +
    (scenarioResult.criteria_gaps.length > 0
      ? ", plus " + scenarioResult.criteria_gaps.length + " gap(s) in the criteria: " +
        scenarioResult.criteria_gaps.join(" | ")
      : "") +
    ".",
  details: {
    scenarios: scenarioResult.scenarios,
    criteria_gaps: scenarioResult.criteria_gaps,
    status: scenarioResult.status,
    reason: scenarioResult.reason,
  },
});
count("plan");

log(
  scenarioResult.scenarios.length +
    " scenarios written; " +
    executorResult.files_changed.length +
    " files changed.",
);

if (scenarioResult.scenarios.length === 0) {
  return await briefAndReturn({
    status: "blocked",
    stopped_at: "scenarios",
    reason:
      "The test planner produced no scenarios: " +
      (scenarioResult.reason || "no reason given") +
      ". There is nothing to verify the build against.",
    code_change_entry_id: changeRow.id,
    scenario_entry_id: scenarioRow.id,
  });
}

// The test planner works from the whole criteria set, because it never sees the plan and so
// has no idea milestones exist — which is the point of its isolation (A4). Splitting its
// output by the milestone's criteria is the script's job, not its.
const milestoneCriteria = {};
if (milestone) {
  for (const id of milestone.criteria) milestoneCriteria[id] = true;
}
const currentScenarios = milestone
  ? scenarioResult.scenarios.filter(function (s) {
      return milestoneCriteria[s.criterion_id];
    })
  : scenarioResult.scenarios;
const deferredScenarios = milestone
  ? scenarioResult.scenarios.filter(function (s) {
      return !milestoneCriteria[s.criterion_id];
    })
  : [];

// A milestone that claims criteria the planner wrote no scenario for cannot be verified, and
// running it anyway would produce a green result that means nothing.
if (currentScenarios.length === 0) {
  return await briefAndReturn({
    status: "blocked",
    stopped_at: "scenario-coverage",
    reason:
      "Milestone " +
      milestone.id +
      " claims criteria " +
      milestone.criteria.join(", ") +
      ", and none of the " +
      scenarioResult.scenarios.length +
      " scenarios cover them. Verifying this milestone is not possible as planned.",
    code_change_entry_id: changeRow.id,
    scenario_entry_id: scenarioRow.id,
  });
}

log(
  currentScenarios.length +
    " scenarios in scope for this milestone, " +
    deferredScenarios.length +
    " deferred.",
);

// ---------------------------------------------------------------------------
// Stage 2: the test and rework loop
// ---------------------------------------------------------------------------

let attempt = executorResult;
let testResult = null;
let planDrift = 0;
let pass = 0;

while (pass < MAX_TEST_PASSES) {
  pass += 1;

  // A criteria-scoped deviation, or an explicit block, stops the loop. The executor has said
  // the contract itself is wrong, and grinding another pass against a broken contract wastes
  // wall clock and buries the finding.
  const criteriaDeviations = attempt.deviations.filter(function (d) {
    return d.scope === "criteria";
  });
  if (attempt.blocked || criteriaDeviations.length > 0) {
    log("Stopping: the executor reports a criterion cannot be met.");
    return await briefAndReturn({
      status: "blocked",
      stopped_at: "criteria",
      reason:
        criteriaDeviations.length > 0
          ? "Criterion at risk: " + criteriaDeviations[0].expected
          : attempt.reason || "The executor reported blocked.",
      passes: pass - 1,
      code_change_entry_id: changeRow.id,
      criteria_deviations: criteriaDeviations,
    });
  }

  // Plan-scoped deviations are recorded and the run continues. There was an amendment loop
  // here — planner rewrites the affected steps, plan reviewer reviews the rewrite — and it
  // was deleted on purpose. The code is already written by the time a deviation is reported,
  // so the planner was documenting a fait accompli and the reviewer was reviewing something
  // it could not prevent: two agent calls that changed nothing and left a plan row reading
  // as though the drift had been the plan all along.
  //
  // The plan stays as Quan approved it, visibly stale, and the deviation rows carry what
  // actually happened. The reviewer audits the scope labels later, which is the check that
  // does have teeth.
  const planDeviations = attempt.deviations.filter(function (d) {
    return d.scope === "plan";
  });
  planDrift += planDeviations.length;
  if (planDeviations.length > 0) {
    log(
      planDeviations.length +
        " plan-scoped deviation(s) recorded; the plan stands as approved and the run continues.",
    );
  }

  currentStage = "test";
  phase("2 Tests, pass " + pass);
  testResult = await runRole(
    "test-executor",
    testPrompt(currentScenarios, attempts, attempt.files_changed, milestone, deferredScenarios),
    TestResultSchema,
    "test" + pass + ":" + reference,
  );
  await recordTestResult(testResult, pass);

  const failures = testResult.results.filter(function (r) {
    return !r.passed;
  });

  attempts.push({
    pass: pass,
    summary: attempt.summary,
    files_changed: attempt.files_changed,
    deviations: attempt.deviations,
    command: testResult.command,
    all_passed: testResult.all_passed,
    failures: failures.map(function (f) {
      return { scenario_id: f.scenario_id, failure: f.failure };
    }),
  });

  if (testResult.all_passed) {
    log("Green on pass " + pass + ".");
    break;
  }

  if (testResult.status === "blocked") {
    log("Stopping: the suite could not run.");
    return await briefAndReturn({
      status: "blocked",
      stopped_at: "test-run",
      reason: testResult.reason || "The test executor could not run the suite.",
      passes: pass,
    });
  }

  if (pass === MAX_TEST_PASSES) break;

  currentStage = "rework";
  phase("2 Rework, pass " + pass);
  log(failures.length + " failing; reworking.");
  attempt = await runRole(
    "executor",
    executorPrompt(goal, criteria, milestoneSteps, direction, attempts, milestone),
    CodeChangeSchema,
    "rework" + pass + ":" + reference,
  );
  await recordAttempt(attempt, "Rework after pass " + pass);
}

if (!testResult || !testResult.all_passed) {
  // The cap is the point. An agent that cannot go green in three passes is telling you
  // something, and raising the cap converts a signal into a longer wait.
  await writeEntry({
    agent: "orchestrator",
    type: "finding",
    reference: reference,
    status: "open",
    severity: "blocker",
    needs_human: true,
    content:
      "Phase 2 hit its rework cap of " +
      MAX_TEST_PASSES +
      " passes on " +
      reference +
      " with tests still failing. The loop stopped rather than continuing, and the working " +
      "tree holds the last attempt for inspection.",
    details: { passes: MAX_TEST_PASSES, attempts: attempts },
  });
  count("finding");
  return await briefAndReturn({
    status: "blocked",
    stopped_at: "rework-cap",
    reason: "Tests still failing after " + MAX_TEST_PASSES + " passes.",
    passes: MAX_TEST_PASSES,
    plan_drift: planDrift,
  });
}

// ---------------------------------------------------------------------------
// Stage 3: code review, and a bounded fix loop
// ---------------------------------------------------------------------------

let review = null;
let reviewPass = 0;
let changedFiles = attempt.files_changed;

while (reviewPass < MAX_REVIEW_PASSES) {
  reviewPass += 1;
  currentStage = "review";
  phase("3 Code review, pass " + reviewPass);

  review = await runRole(
    "code-reviewer",
    reviewPrompt(
      goal,
      criteria,
      milestoneSteps,
      changedFiles,
      await allDeviations(),
      await priorFindings(),
    ),
    ReviewSchema,
    "review" + reviewPass + ":" + reference,
  );

  const recorded = await recordFindings("code-reviewer", review.items);
  await recordMisclassifications(review.misclassified);
  log(
    "Review pass " +
      reviewPass +
      ": " +
      (review.approved ? "approved" : review.items.length + " findings, worst " + recorded.worst),
  );

  // Approval with no blocking finding ends the loop. `info` findings are notes, and holding
  // the loop open for a style preference would spend a frontier model on taste.
  if (review.approved && recorded.worst !== "blocker") break;
  if (reviewPass === MAX_REVIEW_PASSES) break;

  currentStage = "fix";
  phase("3 Fix, pass " + reviewPass);
  const fix = await runRole(
    "executor",
    fixPrompt(goal, criteria, milestoneSteps, direction, review.items, attempts, milestone),
    CodeChangeSchema,
    "fix" + reviewPass + ":" + reference,
  );
  await recordAttempt(fix, "Fix after review pass " + reviewPass);
  changedFiles = fix.files_changed.length > 0 ? fix.files_changed : changedFiles;

  if (fix.blocked) {
    return await briefAndReturn({
      status: "blocked",
      stopped_at: "review-fix",
      reason: fix.reason || "The executor reported blocked while addressing review findings.",
      passes: pass,
      review_passes: reviewPass,
    });
  }

  // Re-run the suite after a fix. A review-driven edit is still an edit, and the objective
  // signal has to hold: this is the cheap leg paid twice so the expensive one is not.
  currentStage = "retest";
  phase("3 Tests after fix " + reviewPass);
  testResult = await runRole(
    "test-executor",
    testPrompt(currentScenarios, attempts, changedFiles, milestone, deferredScenarios),
    TestResultSchema,
    "retest" + reviewPass + ":" + reference,
  );
  await recordTestResult(testResult, pass + reviewPass);

  attempts.push({
    pass: pass + reviewPass,
    summary: fix.summary,
    files_changed: fix.files_changed,
    deviations: fix.deviations,
    command: testResult.command,
    all_passed: testResult.all_passed,
    failures: testResult.results
      .filter(function (r) {
        return !r.passed;
      })
      .map(function (f) {
        return { scenario_id: f.scenario_id, failure: f.failure };
      }),
  });

  if (!testResult.all_passed) {
    return await briefAndReturn({
      status: "blocked",
      stopped_at: "regression",
      reason:
        "A fix for review findings broke the suite, which had been green. The working tree " +
        "holds it for inspection.",
      passes: pass,
      review_passes: reviewPass,
    });
  }
}

// ---------------------------------------------------------------------------
// Sign-off, and the stop
// ---------------------------------------------------------------------------

const approved = Boolean(review && review.approved);
const label = milestone ? "Milestone " + milestone.id + " (" + milestone.name + ")" : "Plan";

// A `decision` row rather than an `approval` row, deliberately. `approval` means the human
// gate here, and the gate check above looks for exactly that; a sign-off wearing the same
// type would make a second run mistake the reviewer for Quan.
//
// `details.milestone` is what the next invocation reads to know this stage is behind it, so
// calling the script again with no milestone walks the plan forward on its own.
const signOff = await writeEntry({
  agent: "code-reviewer",
  type: "decision",
  reference: reference,
  status: approved ? "resolved" : "open",
  severity: approved ? "info" : "warning",
  needs_human: !approved,
  content: approved
    ? label +
      " complete on " +
      reference +
      ": tests green after " +
      pass +
      " pass(es), code review approved on review pass " +
      reviewPass +
      ". " +
      (remaining.length > 0
        ? remaining.length + " milestone(s) remain. "
        : "This was the last milestone. ") +
      "The working tree is uncommitted."
    : label +
      " finished on " +
      reference +
      " with tests green and review unresolved after " +
      reviewPass +
      " passes. The findings stand and the working tree is uncommitted.",
  details: {
    sign_off: approved,
    milestone: milestone ? milestone.id : "whole-plan",
    milestone_name: milestone ? milestone.name : "",
    demonstrates: milestone ? milestone.demonstrates : "",
    test_passes: pass,
    review_passes: reviewPass,
    plan_drift: planDrift,
    files_changed: changedFiles,
    direction_entry_id: directionRecorded,
    remaining_milestones: remaining.map(function (m) {
      return m.id;
    }),
  },
});

log("Sign-off row " + signOff.id + " written.");

// The stop is the feature. Quan sees a diff and a test run he can actually hold in his head,
// and the next milestone waits for him rather than arriving alongside three others. Between
// stops he can redirect, which is worth more than finishing sooner.
return await briefAndReturn({
  status: approved ? "ok" : "review-unresolved",
  stopped_at: "milestone",
  approved: approved,
  milestone: milestone ? milestone.id : "whole-plan",
  demonstrates: milestone ? milestone.demonstrates : "",
  remaining_milestones: remaining.map(function (m) {
    return { id: m.id, name: m.name, demonstrates: m.demonstrates };
  }),
  passes: pass,
  review_passes: reviewPass,
  plan_drift: planDrift,
  files_changed: changedFiles,
  sign_off_entry_id: signOff.id,
  gate_entry_id: Number(decision.id),
  next_step:
    remaining.length > 0
      ? "Read the diff, then continue with the next milestone by running remi-build.js again " +
        "on this reference. Redirecting instead is a fresh interview on the criteria."
      : "Every milestone is signed off. The working tree holds the change, uncommitted: read " +
        "it, then commit it yourself or ask for a diff walkthrough.",
});
