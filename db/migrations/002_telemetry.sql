-- Execution telemetry, commit anchoring, and superseded decisions.
--
-- Three additions, each closing a gap the ledger alone could not:
--
-- 1. `agent_run` records executions, where `ledger` records what executions produced.
--    Without it, questions the plan already commits to answering with data cannot be
--    answered at all: the executor's mean pass count, whether `xhigh` costs more wall
--    clock than `high`, which role is the expensive one. Phase 1's first run was timed
--    with a stopwatch on the CLI, which is not a measurement anyone can repeat.
--
-- 2. `base_commit` anchors a claim to the tree it was made against. Line ranges in
--    `ledger_location` were precise on the day they were written and quietly wrong after
--    the next edit; a guard that validates ranges against a moving target validates
--    nothing after the target moves.
--
-- 3. `supersedes` lets a decision replace an earlier one. There is no update path — every
--    tool call appends — so a reversal previously existed only as prose in two documents.
--    D14 reversed a committed handoff on the same day it was written.

BEGIN;

CREATE TYPE agent_run_status AS ENUM ('ok', 'failed');

-- One row per agents.run call. Deliberately not the transcript: this answers "who ran,
-- for how long, on what model, and did it work", and the outputs live in `ledger`.
CREATE TABLE agent_run (
  id           bigserial        PRIMARY KEY,
  ts           timestamptz      NOT NULL DEFAULT now(),
  reference    text             NOT NULL,
  -- The role id, matching ledger.agent: 'planner', 'executor', 'code-reviewer'.
  agent        text             NOT NULL,
  -- Resolved per call from roles.json, so a change of model or level is visible here
  -- rather than inferred from the date.
  model        text,
  thinking     text,
  -- The pipeline stage, e.g. 'build', 'test', 'review', and the milestone if there is one.
  stage        text,
  milestone    text,
  status       agent_run_status NOT NULL,
  duration_ms  integer          NOT NULL,
  error        text,
  base_commit  text,
  details      jsonb            NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON TABLE agent_run IS
  'One agent execution. Records the run, not the conversation; outputs live in ledger.';
COMMENT ON COLUMN agent_run.duration_ms IS
  'Wall clock inside the pipeline script, which is what a walk actually costs.';

-- The commit a claim was made against. Every location on an entry shares it, since one
-- entry is written from one reading of the tree.
ALTER TABLE ledger ADD COLUMN base_commit text;
COMMENT ON COLUMN ledger.base_commit IS
  'Commit the entry was written against. Line ranges are only meaningful with it.';

-- Points at the entry this one replaces. `resolved_by` points the other way and cannot be
-- set without an update, so a reversal is recorded by the row doing the reversing.
ALTER TABLE ledger ADD COLUMN supersedes bigint REFERENCES ledger(id);
COMMENT ON COLUMN ledger.supersedes IS
  'The entry this one replaces. Set by the newer entry, since the ledger only appends.';

CREATE INDEX agent_run_reference_idx ON agent_run (reference, ts DESC);
CREATE INDEX agent_run_agent_idx     ON agent_run (agent, ts DESC);
-- "Which runs failed" is the first question after a bad night.
CREATE INDEX agent_run_failed_idx    ON agent_run (reference) WHERE status = 'failed';
CREATE INDEX ledger_supersedes_idx   ON ledger (supersedes) WHERE supersedes IS NOT NULL;

-- What the project currently believes: decisions with nothing superseding them.
-- Reading the decision history and working out which parts still hold is exactly the
-- work this view exists to avoid.
CREATE VIEW current_decision AS
SELECT l.*
  FROM ledger l
 WHERE l.type = 'decision'
   AND NOT EXISTS (
     SELECT 1 FROM ledger newer WHERE newer.supersedes = l.id
   );

COMMENT ON VIEW current_decision IS
  'Decisions no later entry has superseded. The project''s current beliefs.';

-- Per-role cost and reliability, which is what the open model questions need.
CREATE VIEW agent_run_stats AS
SELECT agent,
       model,
       thinking,
       count(*)                                        AS runs,
       count(*) FILTER (WHERE status = 'failed')       AS failures,
       round(avg(duration_ms))                         AS mean_ms,
       max(duration_ms)                                AS max_ms,
       round(sum(duration_ms) / 1000.0)                AS total_seconds
  FROM agent_run
 GROUP BY agent, model, thinking;

COMMIT;
