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
    non_goals: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
  },
  required: ["status", "question", "goal", "criteria", "non_goals", "reason"],
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
  "Expected answer, one of three:",
  '  Still interviewing: status "interviewing", question holding your single next',
  "  question, goal and criteria holding your best current draft so nothing is lost,",
  '  non_goals as known so far, reason "".',
  '  Criteria settled: status "ready", question "", goal holding the goal statement,',
  "  criteria holding one entry per criterion with an id, a statement a test can pass or",
  '  fail on, and a level of unit, integration or e2e. reason "".',
  '  Cannot proceed: status "blocked", question "", reason naming the specific obstacle,',
  "  goal and criteria holding whatever you have. This is a correct answer, not a failure.",
  "",
  "Call structured_output once with exactly that.",
].join("\n");

const result = await agents.run(prompt, {
  agentId: "goal-setter",
  thinking: cfg.thinking["goal-setter"],
  label: "interview:" + reference + ":" + (answers.length + 1),
  schema: CriteriaSchema,
});

if (result.status === "interviewing") {
  // Deliberately unrecorded. A ledger row per question would bury the entries that
  // matter under the conversation that produced them; only the outcome is a decision.
  return {
    status: "interviewing",
    turn: answers.length + 1,
    question: result.question,
    draft: { goal: result.goal, criteria: result.criteria, non_goals: result.non_goals },
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
    " criteria, " +
    answers.length +
    " exchanges)",
  details: {
    goal: result.goal,
    criteria: result.criteria,
    non_goals: result.non_goals,
    request: request,
    answers: answers,
  },
});

return {
  status: "ready",
  entry_id: row.id,
  goal: result.goal,
  criteria: result.criteria,
  non_goals: result.non_goals,
  exchanges: answers.length,
};
