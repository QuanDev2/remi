// The test lane needs a real target before the pipeline can be exercised end to end.
//
// The runner is Node's built-in `node --test`. That is a constraint, not a preference:
// sandboxed roles run with network "none", so a role cannot `npm install` a framework
// during a turn. Anything not built in would have to be baked into the sandbox image or
// vendored into the repository.
//
// These assert the ledger migration's shape, which is the one contract the whole
// pipeline depends on and the one place a silent change would corrupt the audit trail.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const migration = readFileSync(join(repo, "db/migrations/001_ledger.sql"), "utf8");

test("ledger types cover every entry kind the pipeline writes", () => {
  // Each corresponds to a stage that writes: goal setter, reviewers, executor,
  // test executor, and the gate. A missing value fails at INSERT, mid-run.
  for (const kind of [
    "plan",
    "finding",
    "deviation",
    "code_change",
    "test_result",
    "decision",
    "approval",
  ]) {
    assert.match(migration, new RegExp(`'${kind}'`), `ledger_type is missing ${kind}`);
  }
});

test("severity and needs_human exist, since the briefer filters on them", () => {
  // D8: escalation judgement happens in the agent that had full context and lands as
  // queryable data. Without these the briefer would have to decide what matters.
  assert.match(migration, /severity\s+ledger_severity\s+NOT NULL/);
  assert.match(migration, /needs_human\s+boolean\s+NOT NULL/);
});

test("locations are a child table, so one finding stays one row", () => {
  // A review finding routinely spans several files. Columns on `ledger` would force
  // either one row per location, breaking the resolved_by thread, or a primary-location
  // lie with the rest buried in prose.
  assert.match(migration, /CREATE TABLE ledger_location/);
  assert.match(migration, /entry_id\s+bigint\s+NOT NULL REFERENCES ledger\(id\) ON DELETE CASCADE/);
});

test("line ranges are a multirange, so disjoint hits in one file are one row", () => {
  // "duplicated at 12-31 and again at 88-94" is one finding about one file.
  assert.match(migration, /lines\s+int4multirange/);
});

test("the briefer's query is served by a partial index", () => {
  assert.match(migration, /CREATE INDEX ledger_brief_idx[\s\S]*?WHERE needs_human OR severity <> 'info'/);
});

test("line containment is GiST-indexed", () => {
  // Supports `lines @> 47`: what touches this line?
  assert.match(migration, /CREATE INDEX ledger_loc_lines_idx\s+ON ledger_location USING gist \(lines\)/);
});

test("resolved_by is self-referential, so a thread can be traced", () => {
  // bug found -> fixed -> retested, as one chain.
  assert.match(migration, /resolved_by\s+bigint\s+REFERENCES ledger\(id\)/);
});
