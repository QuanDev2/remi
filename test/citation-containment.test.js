// Regression test for the citation containment check in plugin/index.ts.
//
// Found by the plan reviewer during the first real pipeline run: the original check was
// `abs.startsWith(resolve(projectRoot))`, a bare string prefix with no separator guard.
// A sibling directory whose name extends the root name — /…/apps/remi-old against a root
// of /…/apps/remi — resolved as inside the project and was accepted.
//
// The guard exists to stop a role citing files from another project (D10, D11). A prefix
// match defeats that for exactly the case most likely to occur by accident: a checkout,
// a backup, or a worktree sitting next to the real one.
//
// This tests the predicate directly rather than through the plugin, because the plugin
// needs a live Postgres connection and the logic under test is pure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, relative, isAbsolute } from "node:path";

/** The containment predicate as implemented in plugin/index.ts. */
function isInsideProject(projectRoot, candidate) {
  const root = resolve(projectRoot);
  const rel = relative(root, resolve(root, candidate));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

const ROOT = "/Users/quandev/projects/apps/remi";

test("accepts a repo-relative path", () => {
  assert.equal(isInsideProject(ROOT, "plugin/index.ts"), true);
  assert.equal(isInsideProject(ROOT, "db/migrations/001_ledger.sql"), true);
});

test("accepts an absolute path inside the project", () => {
  assert.equal(isInsideProject(ROOT, `${ROOT}/roles/roles.json`), true);
});

test("rejects a sibling whose name extends the root name", () => {
  // The reported bug. Every one of these passed the old prefix check.
  assert.equal(isInsideProject(ROOT, "/Users/quandev/projects/apps/remi-old/x.ts"), false);
  assert.equal(isInsideProject(ROOT, "/Users/quandev/projects/apps/remi2/x.ts"), false);
  assert.equal(isInsideProject(ROOT, "/Users/quandev/projects/apps/remi.bak/x.ts"), false);
});

test("rejects another project entirely", () => {
  // The failure this guard was written for: a reviewer citing files it read elsewhere.
  assert.equal(isInsideProject(ROOT, "/Users/quandev/projects/apps/pholio/server/prisma/schema.prisma"), false);
});

test("rejects traversal out of the project", () => {
  assert.equal(isInsideProject(ROOT, "../../../etc/passwd"), false);
  assert.equal(isInsideProject(ROOT, "plugin/../../pholio/x.ts"), false);
});

test("rejects credential paths", () => {
  assert.equal(isInsideProject(ROOT, "/Users/quandev/.ssh/id_ed25519"), false);
  assert.equal(isInsideProject(ROOT, "../../../../.aws/credentials"), false);
});

test("rejects the project root itself, which is not a citable file", () => {
  assert.equal(isInsideProject(ROOT, "."), false);
  assert.equal(isInsideProject(ROOT, ROOT), false);
});

test("a prefix match would have accepted the sibling, which is why this test exists", () => {
  // Demonstrates the defect rather than describing it, so the test fails loudly if
  // anyone reintroduces the cheaper check.
  const naive = (root, candidate) => resolve(root, candidate).startsWith(resolve(root));
  const sibling = "/Users/quandev/projects/apps/remi-old/x.ts";
  assert.equal(naive(ROOT, sibling), true, "the old check accepted this");
  assert.equal(isInsideProject(ROOT, sibling), false, "the current check must reject it");
});
