// The criteria interview: one exchange per call, ending in frozen acceptance criteria.
//
// The goal setter cannot talk to Quan. A swarm child is one-shot — it gets a prompt,
// returns a typed result, and dies with no channel to a human. So the interview is
// driven from outside, the same way the gate is: this script runs one turn, the
// orchestrator relays the question, and Quan's answer comes back as data on the next
// call. Same boundary pattern as remi-gate.js, and the same reason — it makes the wait
// unbounded (D4).
//
// HOW THIS RUNS
//
// Deployed into the orchestrator's workspace by `scripts/apply-roles.mjs` and run as
// the body of one Code Mode cell:
//
//   const src = (await read({ path: "remi-interview.js" })).content;
//   const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
//   const run = new AsyncFunction("input", src);
//   return await run({ reference: "feat-x", request: "...", answers: [] });
//
// `answers` is the exchange so far, oldest first: [{ question, answer }, ...]. Pass it
// back grown by one each turn. Nothing is stored between calls, so a dropped
// conversation loses only what was not yet written to the ledger.
//
// Returns one of:
//   { status: "interviewing", question, draft }   -> relay the question, call again
//   { status: "ready", goal, criteria, entry_id } -> criteria frozen; run remi-plan.js
//   { status: "blocked", reason }                 -> stop and tell Quan why

const cfg = JSON.parse((await read({ path: "remi-roles.json" })).content);
const projectRoot = cfg.projectRoot;

/**
 * An opaque, readable feature id that threads every row of a run together.
 *
 * First real words, not first words: an early run minted
 * `the-repository-has-20260824-i2m`, which identifies nothing. The reference is opaque
 * to the pipeline but humans read it in psql and in git log.
 *
 * Duplicated from remi-plan.js on purpose. Code Mode rejects `import`, so two guest
 * scripts cannot share a helper; minting lives here because the interview is what
 * starts a run.
 */
function mintReference(text) {
  const skip = {
    the: 1, and: 1, for: 1, has: 1, have: 1, are: 1, this: 1, that: 1, with: 1,
    from: 1, into: 1, its: 1, was: 1, but: 1, not: 1, any: 1, all: 1, our: 1,
    can: 1, should: 1, would: 1, needs: 1, need: 1, there: 1, they: 1, some: 1,
    make: 1, give: 1, add: 1, run: 1, use: 1,
  };
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(function (w) {
      return w.length > 2 && !skip[w];
    })
    .slice(0, 3)
    .join("-");
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const salt = Math.floor(Math.random() * 46656).toString(36);
  return (words || "change") + "-" + day + "-" + salt;
}

const request = String(input && input.request ? input.request : "").trim();
const answers = Array.isArray(input && input.answers) ? input.answers : [];

if (request.length === 0) {
  return {
    status: "blocked",
    reason: "A request is required. Pass { request }: what Quan asked for, verbatim.",
  };
}

// Minted on the first exchange and passed back on every later one, so the whole
// interview and the run it produces share one reference.
const reference =
  input && input.reference ? String(input.reference).trim() : mintReference(request);

// Bounded, so a goal setter that will not stop asking cannot hold the pipeline open.
// Hitting the cap is a reportable outcome, not a crash: the draft is returned either way.
const MAX_TURNS = 12;
if (answers.length >= MAX_TURNS) {
  return {
    status: "blocked",
    reason:
      "The interview reached " +
      MAX_TURNS +
      " exchanges without settling. Either the request needs splitting into smaller " +
      "features, or the criteria should be frozen as they stand and refined at the gate.",
  };
}

// Milestones live here, with the criteria, rather than in the plan.
//
// A milestone is a group of criteria Quan wants to see working together, so it is part of
// the contract and not implementation sequencing. Two consequences follow. It survives
// re-planning: throw the plan away and the demo structure still stands. And the ordering is
// a priority decision — what do I want to see first — which belongs to the person who will
// be looking at it, not to a planner reasoning about file dependencies.
//
// What the planner still owns is assigning steps to these milestones, and saying so when the
// requested order is not buildable in that order.
// ---------------------------------------------------------------------------
// Telemetry and commit anchoring
//
// Duplicated from the other pipeline scripts rather than shared, because Code Mode rejects
// `import` and a cell body has no module system.
//
// Interview turns are deliberately absent from the ledger — a row per question would bury
// the entries that matter — but they belong in telemetry, which is a different question:
// what does an exchange cost, and how many does a real interview take.
// ---------------------------------------------------------------------------

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

const baseCommit =
  (await shell("git -C " + projectRoot + " rev-parse --short HEAD")) || "unknown";

async function recordRun(role, started, status, error, extra) {
  try {
    await agent_run_write({
      reference: reference,
      agent: role,
      model: cfg.models && cfg.models[role] ? cfg.models[role] : undefined,
      thinking: cfg.thinking[role],
      stage: "interview",
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

const CriteriaSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["interviewing", "ready", "blocked"] },
    question: { type: "string" },
    goal: { type: "string" },
    criteria: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          statement: { type: "string" },
          level: { type: "string", enum: ["unit", "integration", "e2e"] },
        },
        required: ["id", "statement", "level"],
        additionalProperties: false,
      },
    },
    milestones: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          demonstrates: { type: "string" },
          criteria: { type: "array", items: { type: "string" } },
        },
        required: ["id", "name", "demonstrates", "criteria"],
        additionalProperties: false,
      },
    },
    non_goals: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
  },
  required: [
    "status",
    "question",
    "goal",
    "criteria",
    "milestones",
    "non_goals",
    "reason",
  ],
  additionalProperties: false,
};

function transcript() {
  if (answers.length === 0) return "This is the first exchange. Nothing has been asked yet.";
  return answers
    .map(function (x, i) {
      return "Q" + (i + 1) + ": " + x.question + "\nA" + (i + 1) + ": " + x.answer;
    })
    .join("\n\n");
}

// The prompt states the expected shape of every outcome positively, including the
// no-data and blocked paths. A schema that merely permits an outcome does not get it
// used; a child with no stated way to say "I have no data" either fabricates one or
// abandons the structured_output call entirely (D9).
const prompt = [
  "Quan wants: " + request,
  "",
  "The project is at " + projectRoot + ". Read it before asking anything a glance at the",
  "code would answer. In exec, cd there first and use repo-relative paths.",
  "",
  "Interview so far:",
  transcript(),
  "",
  "Ask one question, or freeze the criteria if they are already verifiable.",
  "",
  "Before freezing, group the criteria into milestones. A milestone is a set of criteria",
  "Quan can watch working together: the pipeline builds one milestone, stops, shows him the",
  "result, and waits. Two to four criteria each is the usual shape, and one milestone is the",
  "right answer for a small change.",
  "",
  "Three rules for the grouping:",
  "  Every criterion belongs to exactly one milestone, so nothing is delivered twice and",
  "  nothing is forgotten.",
  "  Each milestone delivers something demonstrable on its own. Its demonstrates field says",
  "  what Quan will be able to see or run when it lands, in his terms rather than in files.",
  "  The order is his priority, so what he wants working first comes first. Asking him which",
  "  he wants to see first is a good use of one of your questions.",
  "",
  "A criterion too broad to sit in one milestone is a criterion worth splitting, and saying",
  "so is more useful than spreading it across several.",
  "",
  "Expected answer, one of three:",
  '  Still interviewing: status "interviewing", question holding your single next',
  "  question, goal, criteria and milestones holding your best current draft so nothing is",
  '  lost, non_goals as known so far, reason "".',
  '  Criteria settled: status "ready", question "", goal holding the goal statement,',
  "  criteria holding one entry per criterion with an id, a statement a test can pass or",
  "  fail on, and a level of unit, integration or e2e; milestones holding the grouping, in",
  '  build order. reason "".',
  '  Cannot proceed: status "blocked", question "", reason naming the specific obstacle,',
  "  goal, criteria and milestones holding whatever you have. This is a correct answer, not",
  "  a failure.",
  "",
  "Call structured_output once with exactly that.",
].join("\n");

const turnStarted = Date.now();
let result;
try {
  result = await agents.run(prompt, {
    agentId: "goal-setter",
    thinking: cfg.thinking["goal-setter"],
    label: "interview:" + reference + ":" + (answers.length + 1),
    schema: CriteriaSchema,
  });
  await recordRun("goal-setter", turnStarted, "ok", null, { turn: answers.length + 1 });
} catch (err) {
  await recordRun("goal-setter", turnStarted, "failed", String(err), {
    turn: answers.length + 1,
  });
  throw err;
}

if (result.status === "interviewing") {
  // Deliberately unrecorded. A ledger row per question would bury the entries that
  // matter under the conversation that produced them; only the outcome is a decision.
  return {
    status: "interviewing",
    turn: answers.length + 1,
    question: result.question,
    draft: {
      goal: result.goal,
      criteria: result.criteria,
      milestones: result.milestones,
      non_goals: result.non_goals,
    },
  };
}

if (result.status === "blocked") {
  const row = await ledger_write({
    agent: "goal-setter",
    type: "decision",
    reference: reference,
    status: "open",
    severity: "blocker",
    needs_human: true,
    content: "Criteria could not be settled: " + result.reason,
    details: { request: request, answers: answers, draft: result },
  });
  return { status: "blocked", reason: result.reason, entry_id: row.id };
}

if (result.criteria.length === 0) {
  return {
    status: "blocked",
    reason:
      "The goal setter reported ready with no criteria. Nothing downstream can run: " +
      "the planner sequences against criteria and the test planner writes scenarios from " +
      "them. Re-run the interview.",
  };
}

// The grouping is checked mechanically rather than trusted, because both failure modes are
// silent and expensive. A criterion in no milestone is work that never gets built, and a
// criterion in two is a milestone that cannot be signed off on its own.
const claimed = {};
const doubled = [];
for (const m of result.milestones) {
  for (const id of m.criteria) {
    if (claimed[id]) doubled.push(id);
    claimed[id] = true;
  }
}
const orphans = result.criteria
  .filter(function (c) {
    return !claimed[c.id];
  })
  .map(function (c) {
    return c.id;
  });
const emptyMilestones = result.milestones
  .filter(function (m) {
    return m.criteria.length === 0;
  })
  .map(function (m) {
    return m.id;
  });

if (
  result.milestones.length === 0 ||
  orphans.length > 0 ||
  doubled.length > 0 ||
  emptyMilestones.length > 0
) {
  return {
    status: "blocked",
    reason:
      "The milestone grouping does not cover the criteria cleanly." +
      (result.milestones.length === 0 ? " No milestones were produced." : "") +
      (orphans.length > 0 ? " Criteria in no milestone: " + orphans.join(", ") + "." : "") +
      (doubled.length > 0 ? " Criteria in more than one: " + doubled.join(", ") + "." : "") +
      (emptyMilestones.length > 0
        ? " Milestones claiming nothing: " + emptyMilestones.join(", ") + "."
        : "") +
      " Every criterion belongs to exactly one milestone, so re-run the interview with that" +
      " stated.",
    draft: {
      goal: result.goal,
      criteria: result.criteria,
      milestones: result.milestones,
    },
  };
}

// The freeze. This row is the contract for everything downstream: the planner reads it,
// the test planner reads it and never sees the plan, and the gate exists to protect it.
// Amendments come from Quan at the gate in his own words, not from a second interview.
const row = await ledger_write({
  agent: "goal-setter",
  type: "decision",
  reference: reference,
  status: "resolved",
  severity: "info",
  needs_human: false,
  content:
    "Criteria frozen: " +
    result.goal +
    " (" +
    result.criteria.length +
    " criteria in " +
    result.milestones.length +
    " milestone(s), " +
    answers.length +
    " exchanges) " +
    result.milestones
      .map(function (m) {
        return m.id + " " + m.name + ": " + m.demonstrates;
      })
      .join(" | "),
  details: {
    goal: result.goal,
    criteria: result.criteria,
    milestones: result.milestones,
    non_goals: result.non_goals,
    request: request,
    answers: answers,
  },
  base_commit: baseCommit,
});

return {
  status: "ready",
  entry_id: row.id,
  goal: result.goal,
  criteria: result.criteria,
  milestones: result.milestones,
  non_goals: result.non_goals,
  exchanges: answers.length,
};
