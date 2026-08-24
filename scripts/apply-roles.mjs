#!/usr/bin/env node
// Apply roles/roles.json to the local OpenClaw config, idempotently.
//
//   node scripts/apply-roles.mjs [--dry-run]
//
// Creates one agent per role, points it at a workspace, copies that role's
// AGENTS.md lane contract in, sets model / thinking / codeMode / tool profile,
// and allows the orchestrator to spawn every role.
//
// It also deploys the pipeline scripts and a derived remi-roles.json into the
// orchestrator's workspace. That is the only route by which they reach the runtime:
// the orchestrator's `read` tool is confined to its own workspace, and Code Mode
// rejects `import`, so a committed script is reachable only if it is copied there.
//
// Idempotent: re-running overwrites role config, lane contracts and scripts in place.
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
const projectRoot = spec.projectRoot;

// Sandbox defaults: no network egress, read-only root, all capabilities dropped.
// The Gateway itself stays on the host; only tool execution moves into a container.
// This is what stops a role from reading unrelated projects or ~/.ssh: those paths
// simply are not present inside the container.
config.agents.defaults.sandbox = {
  mode: "all",
  backend: "docker",
  scope: "agent",
  workspaceAccess: "rw",
  docker: {
    image: "openclaw-sandbox:bookworm-slim",
    readOnlyRoot: true,
    tmpfs: ["/tmp", "/var/tmp", "/run"],
    network: "none",
    capDrop: ["ALL"],
    // Required because the project lives outside the agent workspace roots.
    // Per OpenClaw's docs this lifts only the workspace-root restriction: the
    // blocked system-path, credential, Docker-socket, symlink-parent and
    // reserved-target checks all still apply. The only external source we mount
    // is the one project directory named in roles.json.
    dangerouslyAllowExternalBindSources: true,
  },
};

// Plugin tools execute Gateway-side, so they still reach Postgres from a sandboxed
// session — but only if the sandbox tool policy admits them as well.
config.tools.sandbox = {
  ...(config.tools.sandbox ?? {}),
  tools: { alsoAllow: ["ledger_write", "ledger_query"] },
};

// Swarm supplies agents.run / phase / log, which the pipeline scripts are built on.
// Without it the orchestrator cannot spawn a role or await its typed result.
config.tools.swarm = true;

// Elevated exec bypasses the sandbox by design. It defaults to requiring an
// allowlisted sender, but that is not a default worth relying on.
config.tools.elevated = { ...(config.tools.elevated ?? {}), enabled: false };

// The ledger plugin is linked from this repo (see docs/SETUP.md) and needs both a
// connection string and the project root that citation validation checks against.
config.plugins ??= {};
config.plugins.entries ??= {};
config.plugins.entries.remi = {
  ...(config.plugins.entries.remi ?? {}),
  enabled: true,
  config: {
    ...(config.plugins.entries.remi?.config ?? {}),
    connectionString:
      process.env.REMI_LEDGER_URL ??
      config.plugins.entries.remi?.config?.connectionString ??
      "postgresql://remi:remi@127.0.0.1:55432/remi",
    projectRoot,
  },
};

// Provider plugin for the two cross-family reviewers. The API key lives in the
// auth store, not here.
config.plugins.entries.deepseek = { ...(config.plugins.entries.deepseek ?? {}), enabled: true };

function applyAgent({ id, model, thinking, codeMode, profile, contractDir, workspace, projectAccess, sandboxImage }) {
  const ws = workspace ?? join(stateDir, `workspace-${id}`);
  const entry = entries[id] ?? {};

  entry.workspace = ws;
  entry.model = model;
  entry.tools = { ...(entry.tools ?? {}), codeMode };
  if (profile) entry.tools.profile = profile;
  // `thinking` is deliberately NOT written here: it is not an agent-entry key, and
  // three roles share claude-sonnet-5 at high / medium / low. The pipeline scripts
  // read roles.json and pass `thinking` per call to agents.run().

  // Bind the project at its identical host path, so a relative path means the same
  // thing inside and outside the container and D10 validation stays coherent.
  const docker = {};
  if (projectAccess === "ro" || projectAccess === "rw") {
    docker.binds = [`${projectRoot}:${projectRoot}:${projectAccess}`];
  }
  // The two roles that write and run code need Node. The base image has none, and with
  // network "none" they cannot install it during a turn, so it has to be in the image.
  if (sandboxImage) {
    const resolved = spec.sandboxImages?.[sandboxImage];
    if (!resolved) throw new Error(`unknown sandboxImage "${sandboxImage}" for role ${id}`);
    docker.image = resolved;
  }
  if (Object.keys(docker).length > 0) entry.sandbox = { docker };
  else delete entry.sandbox;
  entries[id] = entry;

  const src = join(repo, "roles", contractDir, "AGENTS.md");
  if (!existsSync(src)) throw new Error(`missing lane contract: ${src}`);
  if (!dryRun) {
    mkdirSync(ws, { recursive: true });
    copyFileSync(src, join(ws, "AGENTS.md"));
  }
  applied.push({ id, model, thinking, codeMode, profile: profile ?? "(inherit)",
                 project: projectAccess ?? "none", image: sandboxImage ?? "default" });
}

// Orchestrator keeps the default workspace; it is the session Quan talks to.
applyAgent({
  id: spec.orchestrator.id,
  model: spec.orchestrator.model,
  thinking: spec.orchestrator.thinking,
  codeMode: spec.orchestrator.codeMode,
  projectAccess: spec.orchestrator.projectAccess,
  contractDir: "orchestrator",
  workspace: config.agents.defaults?.workspace ?? join(stateDir, "workspace"),
});

for (const role of spec.roles) {
  applyAgent({ ...role, contractDir: role.id });
}

// Deploy the pipeline scripts and the role table the orchestrator reads at runtime.
//
// Two things make this necessary rather than tidy. The orchestrator's `read` tool is
// bridged to its own workspace and refuses paths under the project root, and Code Mode
// rejects `import`, so a script in this repository is unreachable from a cell unless it
// is copied here. And a script the model has to retype is a script it will corrupt:
// `main` and the planner each truncated the middle of a 48-character path on every
// attempt. Source travels by file; only a four-line bootstrap goes through the prompt.
//
// remi-roles.json carries the per-call thinking levels, which are deliberately not
// agent-entry keys (three roles share one model at three levels). roles.json stays the
// single source of truth; this is a derived projection of it.
const orchestratorWorkspace = entries[spec.orchestrator.id].workspace;
const pipelineScripts = ["remi-interview.js", "remi-plan.js", "remi-gate.js"];
const deployed = [];

for (const name of pipelineScripts) {
  const src = join(repo, "scripts", name);
  if (!existsSync(src)) throw new Error(`missing pipeline script: ${src}`);
  if (!dryRun) copyFileSync(src, join(orchestratorWorkspace, name));
  deployed.push(name);
}

const roleTable = {
  projectRoot,
  thinking: Object.fromEntries([
    [spec.orchestrator.id, spec.orchestrator.thinking],
    ...spec.roles.map((r) => [r.id, r.thinking]),
  ]),
};
if (!dryRun) {
  writeFileSync(
    join(orchestratorWorkspace, "remi-roles.json"),
    `${JSON.stringify(roleTable, null, 2)}\n`,
  );
}
deployed.push("remi-roles.json");

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
console.log(`deployed to ${orchestratorWorkspace}: ${deployed.join(", ")}`);
console.log(dryRun ? "\nRe-run without --dry-run to apply." : `\nWrote ${configPath}. Restart the gateway.`);
