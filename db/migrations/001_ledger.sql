-- Remi shared ledger.
--
-- One table for entries, one child table for code locations. A `type` column
-- distinguishes entry kinds so a single query can serve both "open findings on
-- this feature" and "full chronological history".
--
-- Requires Postgres 14+ for int4multirange.

BEGIN;

CREATE TYPE ledger_type AS ENUM (
  'plan', 'finding', 'deviation', 'code_change',
  'test_result', 'decision', 'approval'
);

CREATE TYPE ledger_status AS ENUM ('open', 'resolved', 'approved', 'rejected');

CREATE TYPE ledger_severity AS ENUM ('info', 'warning', 'blocker');

CREATE TABLE ledger (
  id           bigserial       PRIMARY KEY,
  ts           timestamptz     NOT NULL DEFAULT now(),
  agent        text            NOT NULL,
  type         ledger_type     NOT NULL,
  status       ledger_status   NOT NULL DEFAULT 'open',
  -- severity and needs_human are set by the agent that had full context.
  -- The briefer filters on them; it does not decide them.
  severity     ledger_severity NOT NULL DEFAULT 'info',
  needs_human  boolean         NOT NULL DEFAULT false,
  reference    text            NOT NULL,
  content      text            NOT NULL,
  details      jsonb           NOT NULL DEFAULT '{}'::jsonb,
  resolved_by  bigint          REFERENCES ledger(id)
);

COMMENT ON COLUMN ledger.reference IS
  'Opaque feature id minted by the planning script and threaded through both phases.';
COMMENT ON COLUMN ledger.resolved_by IS
  'The entry that closed this one out, e.g. bug found -> fixed -> retested.';

-- One finding routinely references several files, and several disjoint line
-- ranges within one file. Keeping locations here preserves one-finding-one-row.
CREATE TABLE ledger_location (
  entry_id bigint         NOT NULL REFERENCES ledger(id) ON DELETE CASCADE,
  path     text           NOT NULL,
  -- int4multirange, e.g. '{[12,31),[88,94)}' for a check duplicated twice in
  -- one file. Half-open: [12,31) covers lines 12..30. NULL means whole file.
  lines    int4multirange,
  -- Why this file is attached: 'duplicate', 'missing-check', 'failure-site'.
  role     text,
  PRIMARY KEY (entry_id, path)
);

CREATE INDEX ledger_reference_status_idx ON ledger (reference, status);
CREATE INDEX ledger_type_ts_idx          ON ledger (type, ts DESC);
-- The briefer's only query, served directly by a partial index.
CREATE INDEX ledger_brief_idx            ON ledger (reference)
  WHERE needs_human OR severity <> 'info';
CREATE INDEX ledger_details_idx          ON ledger USING gin (details);
CREATE INDEX ledger_loc_path_idx         ON ledger_location (path);
-- GiST supports `lines @> 47` containment: what touches this line?
CREATE INDEX ledger_loc_lines_idx        ON ledger_location USING gist (lines);

COMMIT;
