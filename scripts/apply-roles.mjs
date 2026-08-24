#!/usr/bin/env node
// Apply roles/roles.json to the local OpenClaw config, idempotently.
//
//   node scripts/apply-roles.mjs [--dry-run]
//
// Creates one agent per role, points it at a workspace, copies that role's
// AGENTS.md lane contract in, sets model / thinking / codeMode / tool profile,
// and allows the orchestrator to spawn every role.
//
// Idempotent: re-running overwrites role config and lane contracts in place.
// Restart the gateway afterwards.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw");
const configPath = process.env.OPENCLAW_CONFIG_PATH ?? join(stateDir, "openclaw.json");
const dryRun = process.argv.includes("--dry-run");

const spec = JSON.parse(readFileSync(join(repo, "roles", "roles.json"), "utf8"));
const config = JSON.parse(readFileSync(configPath, "utf8"));

config.agents ??= {};
config.agents.entries ??= {};
// A multi-agent roster requires this; without it config validation rejects the file.
config.agents.ownership = "explicit";
const entries = config.agents.entries;
/** Models every role needs, plus whatever is already permitted. */
const models = new Set([
  spec.orchestrator.model,
  ...spec.roles.map((r) => r.model),
  ...Object.keys(config.agents.defaults?.models ?? {}),
]);

config.agents.defaults ??= {};
config.agents.defaults.models = Object.fromEntries(
  [...models].sort().map((m) => [m, config.agents.defaults.models?.[m] ?? {}]),
);
// Both gates must list a model: `models` makes it exist, `modelPolicy` permits it.
config.agents.defaults.modelPolicy = { allow: [...models].sort() };

const applied = [];

function applyAgent({ id, model, thinking, codeMode, profile, contractDir, workspace }) {
  const ws = workspace ?? join(stateDir, `workspace-${id}`);
  const entry = entries[id] ?? {};

  entry.workspace = ws;
  entry.model = model;
  entry.tools = { ...(entry.tools ?? {}), codeMode };
  if (profile) entry.tools.profile = profile;
  // `thinking` is deliberately NOT written here: it is not an agent-entry key, and
  // three roles share claude-sonnet-5 at high / medium / low. The pipeline scripts
  // read roles.json and pass `thinking` per call to agents.run().
  entries[id] = entry;

  const src = join(repo, "roles", contractDir, "AGENTS.md");
  if (!existsSync(src)) throw new Error(`missing lane contract: ${src}`);
  if (!dryRun) {
    mkdirSync(ws, { recursive: true });
    copyFileSync(src, join(ws, "AGENTS.md"));
  }
  applied.push({ id, model, thinking, codeMode, profile: profile ?? "(inherit)", workspace: ws });
}

// Orchestrator keeps the default workspace; it is the session Quan talks to.
applyAgent({
  id: spec.orchestrator.id,
  model: spec.orchestrator.model,
  thinking: spec.orchestrator.thinking,
  codeMode: spec.orchestrator.codeMode,
  contractDir: "orchestrator",
  workspace: config.agents.defaults?.workspace ?? join(stateDir, "workspace"),
});

for (const role of spec.roles) {
  applyAgent({ ...role, contractDir: role.id });
}

// The orchestrator may spawn every role, and itself.
entries[spec.orchestrator.id].subagents = {
  ...(entries[spec.orchestrator.id].subagents ?? {}),
  allowAgents: [spec.orchestrator.id, ...spec.roles.map((r) => r.id)],
};

// Plugin tools are filtered out by the `coding` profile unless re-added here.
config.tools ??= {};
const alsoAllow = new Set([...(config.tools.alsoAllow ?? []), "ledger_write", "ledger_query"]);
config.tools.alsoAllow = [...alsoAllow].sort();

if (dryRun) {
  console.log("DRY RUN — no files written\n");
} else {
  writeFileSync(`${configPath}.bak`, readFileSync(configPath));
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

console.table(applied);
console.log(`\nallowAgents: ${entries[spec.orchestrator.id].subagents.allowAgents.join(", ")}`);
console.log(`models permitted: ${config.agents.defaults.modelPolicy.allow.length}`);
console.log(dryRun ? "\nRe-run without --dry-run to apply." : `\nWrote ${configPath}. Restart the gateway.`);
