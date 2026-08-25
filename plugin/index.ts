import { Type, type Static } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Pool } from "pg";
import { existsSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";

const LEDGER_TYPES = [
  "plan",
  "finding",
  "deviation",
  "code_change",
  "test_result",
  "decision",
  "approval",
] as const;
const LEDGER_STATUSES = ["open", "resolved", "approved", "rejected"] as const;
const LEDGER_SEVERITIES = ["info", "warning", "blocker"] as const;

/**
 * A code location attached to a ledger entry.
 *
 * `lines` is a Postgres int4multirange literal, e.g. `{[12,31),[88,94)}` for a
 * finding that hits the same file in two disjoint places. Half-open ranges:
 * `[12,31)` covers lines 12 through 30.
 */
const LocationSchema = Type.Object(
  {
    path: Type.String({ description: "Repository-relative file path." }),
    lines: Type.Optional(
      Type.String({
        description:
          "int4multirange literal, e.g. '{[12,31),[88,94)}'. Omit for a whole-file reference.",
      }),
    ),
    role: Type.Optional(
      Type.String({
        description:
          "Why this file is attached, e.g. 'duplicate', 'missing-check', 'failure-site'.",
      }),
    ),
  },
  { additionalProperties: false },
);

const MULTIRANGE = /^\{\s*(\[|\()\s*-?\d+\s*,\s*-?\d+\s*(\]|\))(\s*,\s*(\[|\()\s*-?\d+\s*,\s*-?\d+\s*(\]|\)))*\s*\}$/;

/**
 * Read the entry-scoped plugin config (`plugins.entries.remi.config.*`).
 *
 * This is outside-controlled data from a config file, so each field is narrowed
 * rather than asserted. A wrong type in the file becomes a missing value, which
 * surfaces as the actionable "not configured" error below.
 */
type LedgerConfig = { connectionString?: string; poolMax?: number; projectRoot?: string };

function readLedgerConfig(source: unknown): LedgerConfig {
  if (!source || typeof source !== "object") return {};
  const out: LedgerConfig = {};
  if ("connectionString" in source && typeof source.connectionString === "string") {
    out.connectionString = source.connectionString;
  }
  if ("poolMax" in source && typeof source.poolMax === "number" && Number.isInteger(source.poolMax)) {
    out.poolMax = source.poolMax;
  }
  if ("projectRoot" in source && typeof source.projectRoot === "string") {
    out.projectRoot = source.projectRoot;
  }
  return out;
}

const WriteParams = Type.Object(
  {
    agent: Type.String({ description: "Role id writing this entry, e.g. 'plan-reviewer'." }),
    type: Type.Union(LEDGER_TYPES.map((t) => Type.Literal(t))),
    reference: Type.String({ description: "Feature id threading related entries together." }),
    content: Type.String({ description: "Human-readable summary. One or two sentences." }),
    status: Type.Optional(Type.Union(LEDGER_STATUSES.map((s) => Type.Literal(s)))),
    severity: Type.Optional(Type.Union(LEDGER_SEVERITIES.map((s) => Type.Literal(s)))),
    needs_human: Type.Optional(
      Type.Boolean({ description: "True when Quan must see this before work continues." }),
    ),
    details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    locations: Type.Optional(Type.Array(LocationSchema)),
    resolved_by: Type.Optional(
      Type.Integer({ description: "Id of the entry that closes this one out." }),
    ),
    supersedes: Type.Optional(
      Type.Integer({
        description:
          "Id of the entry this one replaces. Use it when a decision reverses an earlier " +
          "one: the ledger only appends, so the newer entry carries the pointer.",
      }),
    ),
    base_commit: Type.Optional(
      Type.String({
        description:
          "Commit the claim was made against. Line ranges are only meaningful with it.",
      }),
    ),
  },
  { additionalProperties: false },
);
type WriteParams = Static<typeof WriteParams>;

const QueryParams = Type.Object(
  {
    reference: Type.Optional(Type.String({ description: "Restrict to one feature id." })),
    type: Type.Optional(Type.Union(LEDGER_TYPES.map((t) => Type.Literal(t)))),
    status: Type.Optional(Type.Union(LEDGER_STATUSES.map((s) => Type.Literal(s)))),
    needs_attention: Type.Optional(
      Type.Boolean({
        description:
          "True returns only entries flagged needs_human or with severity above info. " +
          "This is the briefer's query.",
      }),
    ),
    touching_path: Type.Optional(
      Type.String({ description: "Restrict to entries referencing this file path." }),
    ),
    touching_line: Type.Optional(
      Type.Integer({ description: "Restrict to entries whose line ranges contain this line." }),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  { additionalProperties: false },
);
type QueryParams = Static<typeof QueryParams>;

const RunParams = Type.Object(
  {
    reference: Type.String({ description: "Feature id this execution belongs to." }),
    agent: Type.String({ description: "Role id that ran, e.g. 'executor'." }),
    model: Type.Optional(Type.String({ description: "Model the role resolved to." })),
    thinking: Type.Optional(
      Type.String({ description: "Thinking level passed for this call." }),
    ),
    stage: Type.Optional(
      Type.String({ description: "Pipeline stage: 'plan', 'build', 'test', 'review'." }),
    ),
    milestone: Type.Optional(Type.String({ description: "Milestone id, when there is one." })),
    status: Type.Union([Type.Literal("ok"), Type.Literal("failed")]),
    duration_ms: Type.Integer({ description: "Wall clock for the call, in milliseconds." }),
    error: Type.Optional(Type.String({ description: "Failure text, when it failed." })),
    base_commit: Type.Optional(Type.String({ description: "Commit the run started from." })),
    details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
type RunParams = Static<typeof RunParams>;

export default definePluginEntry({
  id: "remi",
  name: "Remi",
  description: "Shared ledger for the Remi agent pipeline.",
  register(api) {
    let pool: Pool | undefined;

    /** Entry-scoped plugin config: `plugins.entries.remi.config.*`. */
    const config = (): LedgerConfig =>
      readLedgerConfig(
        api && typeof api === "object" && "pluginConfig" in api ? api.pluginConfig : undefined,
      );

    const getPool = (): Pool => {
      if (pool) return pool;
      const cfg = config();
      const connectionString =
        cfg.connectionString ?? process.env.REMI_LEDGER_URL;
      if (!connectionString) {
        throw new Error(
          "Remi ledger is not configured. Set plugins.entries.remi.config.connectionString " +
            "or the REMI_LEDGER_URL environment variable.",
        );
      }
      pool = new Pool({
        connectionString,
        max: cfg.poolMax ?? 4,
        // The pipeline is bursty and short-lived; do not hold sockets open between runs.
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 5_000,
      });
      return pool;
    };

    api.registerTool({
      name: "ledger_write",
      label: "Ledger write",
      description:
        "Append one entry to the Remi shared ledger and return its id. Use this for every " +
        "plan, finding, deviation, code change, test result, decision, and approval. " +
        "Set severity and needs_human yourself: you have the full context, the briefer does not.",
      parameters: WriteParams,
      outputSchema: Type.Object(
        { id: Type.Integer(), locations_written: Type.Integer() },
        { additionalProperties: false },
      ),
      async execute(_id: string, params: WriteParams) {
        // Every cited path must exist. A reviewer running at high reasoning effort has
        // been observed fabricating file citations wholesale — plausible paths, plausible
        // contents, none of it real. File citations are exactly what makes a finding
        // credible and actionable, so an unverified one is worse than no citation at all.
        // The database is the fact-checker: fabricated evidence cannot enter the ledger.
        const projectRoot = config().projectRoot ?? process.env.REMI_PROJECT_ROOT;
        const bad: string[] = [];
        for (const loc of params.locations ?? []) {
          if (loc.lines !== undefined && !MULTIRANGE.test(loc.lines)) {
            throw new Error(
              `Invalid lines value for ${loc.path}: ${loc.lines}. ` +
                "Expected an int4multirange literal such as '{[12,31),[88,94)}'.",
            );
          }
          if (projectRoot !== undefined) {
            // `startsWith` on the resolved root was wrong: a sibling whose name extends
            // the root name — /…/apps/remi-old/x against a root of /…/apps/remi — passed
            // containment. Found by the plan reviewer during the first real pipeline run
            // and verified independently. `relative` is the correct test: inside means a
            // relative path that neither escapes with ".." nor is itself absolute.
            const rel = relative(resolve(projectRoot), resolve(projectRoot, loc.path));
            const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
            if (!inside || !existsSync(resolve(projectRoot, loc.path))) {
              bad.push(loc.path);
            }
          }
        }
        if (bad.length > 0) {
          throw new Error(
            `These paths do not exist in the project: ${bad.join(", ")}. ` +
              "Cite only files you actually opened. If the concern is not tied to a real " +
              "file, omit locations and describe it in content instead.",
          );
        }

        const client = await getPool().connect();
        try {
          await client.query("BEGIN");
          const entry = await client.query<{ id: string }>(
            `INSERT INTO ledger
               (agent, type, status, severity, needs_human, reference, content, details,
                resolved_by, supersedes, base_commit)
             VALUES ($1,
                     $2::ledger_type,
                     COALESCE($3::ledger_status, 'open'),
                     COALESCE($4::ledger_severity, 'info'),
                     COALESCE($5::boolean, false),
                     $6, $7,
                     COALESCE($8::jsonb, '{}'::jsonb),
                     $9::bigint,
                     $10::bigint,
                     $11)
             RETURNING id`,
            [
              params.agent,
              params.type,
              params.status ?? null,
              params.severity ?? null,
              params.needs_human ?? null,
              params.reference,
              params.content,
              params.details ? JSON.stringify(params.details) : null,
              params.resolved_by ?? null,
              params.supersedes ?? null,
              params.base_commit ?? null,
            ],
          );
          const id = Number(entry.rows[0].id);

          const locations = params.locations ?? [];
          for (const loc of locations) {
            await client.query(
              `INSERT INTO ledger_location (entry_id, path, lines, role)
               VALUES ($1, $2, $3::int4multirange, $4)
               ON CONFLICT (entry_id, path) DO UPDATE
                 SET lines = EXCLUDED.lines, role = EXCLUDED.role`,
              [id, loc.path, loc.lines ?? null, loc.role ?? null],
            );
          }
          await client.query("COMMIT");

          const details = { id, locations_written: locations.length };
          return {
            content: [
              {
                type: "text",
                text: `ledger entry ${id} written (${locations.length} location(s))`,
              },
            ],
            details,
          };
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      },
    });

    api.registerTool({
      name: "ledger_query",
      label: "Ledger query",
      description:
        "Read entries from the Remi shared ledger. Use this to recover prior findings and prior " +
        "attempts when starting a fresh review or rework round, and to reconstruct state after a " +
        "context reset. Locations come back aggregated onto their entry.",
      parameters: QueryParams,
      outputSchema: Type.Object(
        { count: Type.Integer(), entries: Type.Array(Type.Unknown()) },
        { additionalProperties: false },
      ),
      async execute(_id: string, params: QueryParams) {
        const where: string[] = [];
        const args: unknown[] = [];
        const add = (clause: string, value: unknown) => {
          args.push(value);
          where.push(clause.replace("?", `$${args.length}`));
        };

        if (params.reference !== undefined) add("l.reference = ?", params.reference);
        if (params.type !== undefined) add("l.type = ?::ledger_type", params.type);
        if (params.status !== undefined) add("l.status = ?::ledger_status", params.status);
        if (params.needs_attention) where.push("(l.needs_human OR l.severity <> 'info')");
        if (params.touching_path !== undefined) {
          add(
            "EXISTS (SELECT 1 FROM ledger_location x WHERE x.entry_id = l.id AND x.path = ?)",
            params.touching_path,
          );
        }
        if (params.touching_line !== undefined) {
          add(
            "EXISTS (SELECT 1 FROM ledger_location x WHERE x.entry_id = l.id AND x.lines @> ?::integer)",
            params.touching_line,
          );
        }

        args.push(params.limit ?? 50);
        const sql = `
          SELECT l.id, l.ts, l.agent, l.type, l.status, l.severity, l.needs_human,
                 l.reference, l.content, l.details, l.resolved_by,
                 COALESCE(
                   (SELECT json_agg(json_build_object('path', x.path, 'lines', x.lines::text, 'role', x.role)
                                    ORDER BY x.path)
                      FROM ledger_location x WHERE x.entry_id = l.id),
                   '[]'::json
                 ) AS locations
          FROM ledger l
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY l.ts DESC
          LIMIT $${args.length}`;

        const res = await getPool().query(sql, args);
        const details = { count: res.rowCount ?? 0, entries: res.rows };
        return {
          content: [
            { type: "text", text: `${res.rowCount ?? 0} ledger entr(ies)\n${JSON.stringify(res.rows, null, 2)}` },
          ],
          details,
        };
      },
    });

    // Execution telemetry, kept separate from the ledger on purpose. The ledger records
    // what an agent produced and is read by the briefer and by fresh sessions; this
    // records what an execution cost and is read by nobody but us, when a question about
    // model choice or wall clock needs an answer that is not a guess.
    api.registerTool({
      name: "agent_run_write",
      label: "Agent run write",
      description:
        "Record one agent execution: role, model, thinking level, duration, and whether it " +
        "succeeded. Called by the pipeline scripts around every agents.run, so per-role cost " +
        "and failure rates are queryable instead of estimated.",
      parameters: RunParams,
      outputSchema: Type.Object({ id: Type.Integer() }, { additionalProperties: false }),
      async execute(_id: string, params: RunParams) {
        const res = await getPool().query<{ id: string }>(
          `INSERT INTO agent_run
             (reference, agent, model, thinking, stage, milestone, status, duration_ms,
              error, base_commit, details)
           VALUES ($1, $2, $3, $4, $5, $6, $7::agent_run_status, $8,
                   $9, $10, COALESCE($11::jsonb, '{}'::jsonb))
           RETURNING id`,
          [
            params.reference,
            params.agent,
            params.model ?? null,
            params.thinking ?? null,
            params.stage ?? null,
            params.milestone ?? null,
            params.status,
            params.duration_ms,
            params.error ?? null,
            params.base_commit ?? null,
            params.details ? JSON.stringify(params.details) : null,
          ],
        );
        const id = Number(res.rows[0].id);
        return {
          content: [{ type: "text", text: `agent_run ${id} recorded` }],
          details: { id },
        };
      },
    });
  },
});
