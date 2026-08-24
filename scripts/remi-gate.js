// The human gate: records Quan's decision on a plan as a ledger row.
//
// Phase 1 ends with an open `approval` row and a brief. This script appends Quan's
// answer, and phase 2 refuses to start until it finds an approved one. Splitting the
// two is what makes the wait unbounded — it survives a gateway restart and a phone
// going back into a pocket, which an inline approval prompt does not (D4).
//
// HOW THIS RUNS
//
// Deployed into the orchestrator's workspace by `scripts/apply-roles.mjs` and run as
// the body of one Code Mode cell:
//
//   const src = (await read({ path: "remi-gate.js" })).content;
//   const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
//   const run = new AsyncFunction("input", src);
//   return await run({ reference: "...", decision: "approved", direction: "..." });
//
// `direction` is Quan's own wording, kept verbatim. It is the payload of the whole
// gate: phase 2 hands it to the executor alongside the plan, so a redirection changes
// the work rather than merely being minuted.
//
// This script writes only. It reaches no conclusion of its own, which is why the
// decision text arrives as data rather than being inferred from a conversation.

const reference = String(input && input.reference ? input.reference : "").trim();
const decision = String(input && input.decision ? input.decision : "").trim();
const direction = String(input && input.direction ? input.direction : "").trim();

if (reference.length === 0) {
  return { status: "blocked", reason: "A reference is required. Pass { reference }." };
}
if (decision !== "approved" && decision !== "rejected") {
  return {
    status: "blocked",
    reason:
      "Decision must be \"approved\" or \"rejected\". Received: " +
      JSON.stringify(decision),
  };
}

// The gate request written by phase 1. Finding it first means this script cannot
// approve a plan that was never presented, and it gives the row a parent to point at.
const open = await ledger_query({
  reference: reference,
  type: "approval",
  status: "open",
  limit: 10,
});
const request = (open.entries || [])[0];

if (!request) {
  return {
    status: "blocked",
    reason:
      "No open approval row exists for reference " +
      reference +
      ". Phase 1 writes that row; run remi-plan.js first, or check the reference.",
  };
}

// `resolved_by` would be the natural link, but it lives on the row being closed and
// the ledger has no update path — every tool call appends. So the pointer goes the
// other way, in details, and the pair is read newest-first on the reference.
const res = await ledger_write({
  agent: "orchestrator",
  type: "approval",
  reference: reference,
  status: decision === "approved" ? "approved" : "rejected",
  severity: "info",
  needs_human: false,
  content:
    "Quan " +
    decision +
    " the plan for " +
    reference +
    (direction.length > 0 ? ". Direction: " + direction : ". No changes requested."),
  details: {
    decision: decision,
    direction: direction,
    resolves_entry: Number(request.id),
    gate_request: request.content,
  },
});

log("Gate decision recorded as entry " + res.id + " (" + decision + ").");

return {
  status: "ok",
  reference: reference,
  decision: decision,
  direction: direction,
  entry_id: res.id,
  resolves_entry: Number(request.id),
  next_step:
    decision === "approved"
      ? "Phase 2 may start: remi-build.js reads this row and passes the direction to the executor."
      : "Phase 2 stays closed. Re-plan with remi-plan.js when the goal is settled.",
};
