/**
 * Skill loader (design D1): reads every *.yaml manifest in config.skills.dir
 * (default ./skills) once at startup. Fail-soft by contract — an unreadable,
 * unparseable, schema-invalid or otherwise unusable manifest is logged as an
 * error naming the file and skipped; the service still boots.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { AppConfig } from "../config/schema.js";
import { logger as rootLogger, type Logger } from "../logging.js";
import { ajv } from "./ajv.js";
import { skillManifestSchema } from "./manifest.js";
import { createRegistry, type LoadedSkill, type SkillRegistry } from "./registry.js";
import { findSqlViolation } from "./sql-guard.js";

export interface LoadSkillsDeps {
  logger?: Logger;
  /** Override the manifest directory (defaults to config.skills.dir). */
  dir?: string;
}

/**
 * Load all valid skill manifests from `config.skills.dir` and return a
 * registry with ajv-compiled validators. Files are processed in sorted order;
 * a duplicate skill name keeps the first (alphabetically earlier) file.
 */
export function loadSkills(config: AppConfig, deps: LoadSkillsDeps = {}): SkillRegistry {
  const log = deps.logger ?? rootLogger;
  const dir = deps.dir ?? config.skills.dir;

  let files: string[];
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".yaml"))
      .map((e) => e.name)
      .sort();
  } catch (err) {
    log.warn(
      { err, dir },
      `skills: cannot read manifest directory ${dir} — starting with no skills`,
    );
    return createRegistry([]);
  }

  const loaded: LoadedSkill[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    try {
      const skill = loadOne(join(dir, file));
      if (seen.has(skill.manifest.name)) {
        throw new Error(`duplicate skill name '${skill.manifest.name}'`);
      }
      seen.add(skill.manifest.name);
      loaded.push(skill);
    } catch (err) {
      log.error({ err, file }, `skills: invalid skill manifest ${file} — skipped`);
    }
  }
  return createRegistry(loaded);
}

/** Parse, validate and compile one manifest file. Throws with the reason. */
function loadOne(path: string): LoadedSkill {
  const raw: unknown = parse(readFileSync(path, "utf8"));
  const manifest = skillManifestSchema.parse(raw);
  if (manifest.execution === "db") {
    const violation =
      typeof manifest.sql === "string" ? findSqlViolation(manifest.sql) : "missing sql";
    if (violation) {
      throw new Error(`SQL is not a single read-only statement: ${violation}`);
    }
  }
  return { manifest, validateArguments: ajv.compile(manifest.parameters) };
}
