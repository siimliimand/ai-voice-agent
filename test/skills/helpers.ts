/**
 * Shared test helpers for the skills suites: a recording logger, config
 * builders, throwaway manifest directories, and a minimal Kysely-shaped fake
 * for asserting skill_invocation audit rows without a database.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/schema.js";
import type { Logger } from "../../src/logging.js";
import { configSchema, type AppConfig } from "../../src/config/schema.js";
import type { LoadedSkill, SkillRegistry } from "../../src/skills/registry.js";

/** pino-shaped logger whose error/warn calls can be asserted on. */
export function fakeLogger(): Logger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

/** A fully-parsed AppConfig with only the skills section overridden. */
export function skillsConfig(skills: Record<string, unknown>): AppConfig {
  return configSchema.parse({ skills });
}

/** Write yaml files into a throwaway directory; cleanup() removes it. */
export function withSkillDir(files: Record<string, string>): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "skills-test-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Registry accessor that fails the test setup instead of using `!`. */
export function mustGet(registry: SkillRegistry, name: string): LoadedSkill {
  const skill = registry.get(name);
  if (!skill) throw new Error(`test setup: skill '${name}' was not loaded`);
  return skill;
}

/** Minimal Kysely fake covering the insertCallEvent chain in queries.ts. */
export function fakeEventDb(): {
  db: Kysely<Database>;
  events: Array<{ call_id: number; type: string; detail?: unknown }>;
} {
  const events: Array<{ call_id: number; type: string; detail?: unknown }> = [];
  const db = {
    insertInto(_table: string) {
      return {
        values(values: { call_id: number; type: string; detail?: unknown }) {
          return {
            returning() {
              return {
                async executeTakeFirstOrThrow() {
                  events.push(values);
                  return { id: 101 };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Kysely<Database>;
  return { db, events };
}
