/**
 * Admin settings JSON API (basic-auth scoped under /api, same scope as the
 * rest of the admin API):
 *
 *   GET /api/settings → { values, overrides, sections }
 *     values:    effective config (startup config <- DB settings) as a nested
 *                object, with every secret field replaced by
 *                { set: boolean, hint: string | null } (hint = "…" + last4).
 *     overrides: dotted paths that currently have a DB override.
 *     sections:  EDITABLE_SECTIONS (rendering contract for the frontend).
 *
 *   PUT /api/settings body { values?: nested partial, reset?: string[] }
 *     - values are flattened to dotted paths; only EDITABLE_PATHS are kept;
 *       infra paths (port/host/databaseUrl/publicBaseUrl) are rejected 400.
 *     - secrets: "" / null / undefined → keep current value.
 *     - the MERGED candidate (current effective <- changes) is parsed with
 *       configSchema; failures answer 400 with the zod issue list.
 *     - reset[] removes per-field overrides from the stored document.
 *
 * Settings changes are NOT call events; a single warn-level log line carries
 * an audit object (old/new; secrets redacted).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { basicAuthScope } from "../auth/basic-auth.js";
import {
  EDITABLE_SECTIONS,
  INFRA_PATHS,
  isEditablePath,
  type EditableField,
  type EditableSection,
} from "../config/editable.js";
import { deepMerge } from "../config/index.js";
import { configSchema, type AppConfig } from "../config/schema.js";
import { sourcePathsFromDoc } from "../config/effective.js";
import {
  clearSettingsPath,
  getAtPath,
  getSettingsDoc,
  saveSettingsDoc,
  setAtPath,
} from "../db/settings.js";
import type { Database } from "../db/schema.js";

/**
 * Persistence seam for the settings document (mirrors the AdminDb pattern so
 * tests can substitute stubs; the server wiring passes kyselySettingsDb(db)).
 */
export interface SettingsDb {
  getSettingsDoc(): Promise<Record<string, unknown>>;
  saveSettingsDoc(partial: Record<string, unknown>): Promise<void>;
  clearSettingsPath(path: string): Promise<void>;
}

/** Bind the settings queries to a Kysely instance. */
export function kyselySettingsDb(db: Kysely<Database>): SettingsDb {
  return {
    getSettingsDoc: () => getSettingsDoc(db),
    saveSettingsDoc: (partial) => saveSettingsDoc(db, partial),
    clearSettingsPath: (path) => clearSettingsPath(db, path),
  };
}

export interface SettingsApiDeps {
  db: SettingsDb;
  /** Startup/base config; the effective config is computed per request. */
  config: AppConfig;
  /** Optional cache hook, e.g. EffectiveConfigResolver.invalidate(). */
  invalidate?: () => void;
}

/** Masked representation of a secret config value (never the raw string). */
export interface SecretValueDto {
  set: boolean;
  /** "…" + last 4 characters, when set. */
  hint: string | null;
}

export interface SettingsResponse {
  values: Record<string, unknown>;
  overrides: string[];
  sections: EditableSection[];
}

const SECRET_REDACTED = "redacted" as const;

/** All editable fields indexed by dotted path. */
function fieldMap(): Map<string, EditableField> {
  return new Map(
    EDITABLE_SECTIONS.flatMap((section) => section.fields).map((field) => [field.path, field]),
  );
}

/** Effective config for a stored document; falls back to base on invalid docs. */
function effectiveFor(base: AppConfig, doc: Record<string, unknown>): AppConfig {
  if (Object.keys(doc).length === 0) return base;
  return configSchema.parse(deepMerge(base, doc));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Flatten a nested object into [dottedPath, leafValue] pairs. */
function flattenLeaves(value: unknown, prefix = ""): Array<[string, unknown]> {
  if (!isPlainObject(value)) return prefix === "" ? [] : [[prefix, value]];
  const out: Array<[string, unknown]> = [];
  for (const [key, child] of Object.entries(value)) {
    out.push(...flattenLeaves(child, prefix === "" ? key : `${prefix}.${key}`));
  }
  return out;
}

/**
 * Replace every secret field's value in the effective config with its masked
 * shape. Pure: returns a new object (path-cloned along secret paths only).
 */
export function maskSecretValues(effective: AppConfig): Record<string, unknown> {
  let out: Record<string, unknown> = { ...effective } as Record<string, unknown>;
  for (const field of EDITABLE_SECTIONS.flatMap((section) => section.fields)) {
    if (field.type !== "secret") continue;
    const current = getAtPath(out, field.path);
    out = setAtPath(
      out,
      field.path,
      typeof current === "string" && current !== ""
        ? { set: true, hint: `…${current.slice(-4)}` }
        : { set: false, hint: null },
    );
  }
  return out;
}

function buildResponse(deps: SettingsApiDeps, doc: Record<string, unknown>): SettingsResponse {
  let effective: AppConfig;
  try {
    effective = effectiveFor(deps.config, doc);
  } catch {
    // Fail-safe: an invalid stored doc must not break the settings page.
    effective = deps.config;
  }
  return {
    values: maskSecretValues(effective),
    overrides: [...sourcePathsFromDoc(doc)],
    sections: EDITABLE_SECTIONS,
  };
}

/** Light form-friendly coercion (strings from HTML inputs → number/boolean). */
function coerceIncoming(field: EditableField, value: unknown): unknown {
  if (field.type === "number" && typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  if (field.type === "boolean") {
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
  }
  return value;
}

/** Audit rendering of one value: secrets never appear (old or new). */
function auditValue(field: EditableField | undefined, value: unknown): unknown {
  return field?.type === "secret" ? SECRET_REDACTED : value;
}

/**
 * Register GET/PUT /api/settings inside a basic-auth scope at /api (matching
 * registerAdminApi; fails closed when basic auth is not registered).
 */
export function registerSettingsApi(app: FastifyInstance, deps: SettingsApiDeps): void {
  const fields = fieldMap();

  basicAuthScope(app, "/api", (api) => {
    api.get("/settings", async (req, reply) => {
      const doc = await readDocSafe(deps, req);
      return reply.send(buildResponse(deps, doc));
    });

    api.put("/settings", async (req, reply) => {
      const body = (req.body ?? {}) as { values?: unknown; reset?: unknown };
      if (body.values !== undefined && !isPlainObject(body.values)) {
        return reply.code(400).send({ error: "body.values must be a nested object" });
      }
      if (body.reset !== undefined && !Array.isArray(body.reset)) {
        return reply.code(400).send({ error: "body.reset must be an array of dotted paths" });
      }
      const leaves = flattenLeaves(body.values);

      // Infra paths are rejected outright (they can never be edited).
      const infraPaths = leaves.map(([path]) => path).filter((path) => INFRA_PATHS.has(path));
      if (infraPaths.length > 0) {
        return reply.code(400).send({
          error: "infra paths are not editable",
          paths: [...new Set(infraPaths)],
        });
      }

      // Sanitize: keep only editable paths. Secrets keep the current value on
      // ""/null/undefined; other fields drop undefined only.
      const changes = new Map<string, unknown>();
      for (const [path, raw] of leaves) {
        const field = fields.get(path);
        if (!field) continue;
        if (raw === undefined || raw === null) continue;
        if (field.type === "secret") {
          const text = typeof raw === "string" ? raw : String(raw);
          if (text.trim() === "") continue;
          changes.set(path, text);
          continue;
        }
        changes.set(path, coerceIncoming(field, raw));
      }

      const resetPaths = (body.reset ?? []).filter(
        (path): path is string => typeof path === "string" && isEditablePath(path),
      );

      const before = await effectiveSafe(deps, req);

      // Validate the MERGED candidate (current effective <- changes) with the
      // full config schema before anything is persisted.
      let partial: Record<string, unknown> = {};
      for (const [path, value] of changes) partial = setAtPath(partial, path, value);
      if (changes.size > 0) {
        const candidate = configSchema.safeParse(deepMerge(before, partial));
        if (!candidate.success) {
          return reply.code(400).send({
            error: "settings validation failed",
            issues: candidate.error.issues.map((issue) => ({
              path: issue.path.join("."),
              code: issue.code,
              message: issue.message,
            })),
          });
        }
      }

      for (const path of resetPaths) await deps.db.clearSettingsPath(path);
      if (Object.keys(partial).length > 0) await deps.db.saveSettingsDoc(partial);
      deps.invalidate?.();

      // Audit-friendly log: changed paths with old/new; secrets redacted.
      const audit: Record<string, { from: unknown; to: unknown }> = {};
      for (const [path, to] of changes) {
        audit[path] = {
          from: auditValue(fields.get(path), getAtPath(before, path)),
          to: auditValue(fields.get(path), to),
        };
      }
      for (const path of resetPaths) {
        audit[path] = { from: auditValue(fields.get(path), getAtPath(before, path)), to: null };
      }
      req.log.warn(
        { changed: [...changes.keys(), ...resetPaths], audit },
        "settings updated (live-applied to new calls)",
      );

      const doc = await readDocSafe(deps, req);
      return reply.send(buildResponse(deps, doc));
    });
  });
}

async function readDocSafe(deps: SettingsApiDeps, req: FastifyRequest): Promise<Record<string, unknown>> {
  try {
    return await deps.db.getSettingsDoc();
  } catch (err) {
    req.log.error({ err }, "settings: failed to read settings doc — showing base config");
    return {};
  }
}

async function effectiveSafe(deps: SettingsApiDeps, req: FastifyRequest): Promise<AppConfig> {
  const doc = await readDocSafe(deps, req);
  try {
    return effectiveFor(deps.config, doc);
  } catch (err) {
    req.log.error({ err }, "settings: stored settings doc is invalid — using base config");
    return deps.config;
  }
}
