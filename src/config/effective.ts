/**
 * Effective config: the startup config overridden by the DB-backed settings
 * document (admin console), re-validated through the full zod schema.
 *
 * Fail-safe contract: a broken/stale stored document must never take calls
 * down. Any read or validation failure logs an error and falls back to the
 * base config.
 */
import type { Kysely } from "kysely";
import { deepMerge } from "./index.js";
import { isEditablePath } from "./editable.js";
import { configSchema, type AppConfig } from "./schema.js";
import { getSettingsDoc } from "../db/settings.js";
import { logger, type Logger } from "../logging.js";
import type { Database } from "../db/schema.js";

/** How long a resolved config is reused before hitting the DB again. */
export const EFFECTIVE_CONFIG_TTL_MS = 2_000;

/**
 * Deep-merge the stored settings document over `base` and re-validate the
 * result with configSchema. Returns `base` unchanged when the document is
 * empty, unreadable or produces an invalid config.
 */
export async function resolveEffectiveConfig(
  base: AppConfig,
  db: Kysely<Database>,
  log: Logger = logger,
): Promise<AppConfig> {
  let doc: Record<string, unknown>;
  try {
    doc = await getSettingsDoc(db);
  } catch (err) {
    log.error({ err }, "settings: failed to read settings doc — using base config");
    return base;
  }
  if (Object.keys(doc).length === 0) return base;
  try {
    return configSchema.parse(deepMerge(base, doc));
  } catch (err) {
    log.error({ err }, "settings: stored settings doc is invalid — using base config");
    return base;
  }
}

/**
 * Flatten a settings document into its dotted leaf paths, keeping only
 * paths that are editable (the frontend uses this for override badges and
 * per-field reset).
 */
export function sourcePathsFromDoc(doc: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const visit = (value: unknown, prefix: string): void => {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) {
        visit(child, prefix === "" ? key : `${prefix}.${key}`);
      }
      return;
    }
    if (prefix !== "" && isEditablePath(prefix)) out.add(prefix);
  };
  visit(doc, "");
  return out;
}

/** Which editable paths currently have DB overrides. */
export async function getSourcePaths(db: Kysely<Database>): Promise<Set<string>> {
  return sourcePathsFromDoc(await getSettingsDoc(db));
}

/**
 * Cached resolver for the effective config. Sessions call get() once per
 * call; the short TTL keeps that cheap (one query per TTL window instead of
 * one per session) while still picking up admin changes within seconds.
 * With no database the base config is returned unchanged.
 */
export class EffectiveConfigResolver {
  private cache: { config: AppConfig; at: number } | null = null;
  private inflight: Promise<AppConfig> | null = null;

  constructor(
    private readonly base: AppConfig,
    private readonly db: Kysely<Database> | undefined,
    private readonly log: Logger = logger,
    private readonly ttlMs: number = EFFECTIVE_CONFIG_TTL_MS,
  ) {}

  /** Effective config (base <- DB settings), cached for ttlMs. */
  async get(): Promise<AppConfig> {
    if (this.db === undefined) return this.base;
    const cached = this.cache;
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.config;
    // Coalesce concurrent misses into one DB read.
    this.inflight ??= resolveEffectiveConfig(this.base, this.db, this.log)
      .then((config) => {
        this.cache = { config, at: Date.now() };
        return config;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /** Drop the cached config (called by the settings API after a save). */
  invalidate(): void {
    this.cache = null;
  }
}
