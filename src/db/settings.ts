/**
 * Persistence for the DB-backed settings document (migrations/0002).
 *
 * The admin console stores config overrides as ONE nested JSON document in
 * settings(key='global'). Dotted config paths ("llm.models.conversation")
 * map to nested object keys. Writes are read-modify-write inside a
 * transaction so concurrent admin saves cannot lose each other's fields
 * (a bare SQL `jsonb ||` merge is only one level deep).
 */
import type { Kysely } from "kysely";
import { deepMerge } from "../config/index.js";
import type { Database } from "./schema.js";

/** The single settings row used by the admin console. */
export const SETTINGS_KEY = "global";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Read the value at a dotted path ("llm.models.conversation"); undefined
 * when any segment along the way is missing or not an object.
 */
export function getAtPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const segment of path.split(".")) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Pure functional setter: returns a copy of `obj` with `value` placed at the
 * dotted path, creating intermediate objects as needed. Existing non-object
 * prefixes on the path are replaced. The input is never mutated.
 */
export function setAtPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const segments = path.split(".");
  const place = (node: unknown, depth: number): Record<string, unknown> => {
    const base = isPlainObject(node) ? { ...node } : {};
    const segment = segments[depth];
    if (segment === undefined) return base;
    if (depth === segments.length - 1) {
      base[segment] = value;
    } else {
      base[segment] = place(base[segment], depth + 1);
    }
    return base;
  };
  return place(obj, 0);
}

/**
 * Pure functional unset: returns a copy of `obj` with the leaf at the dotted
 * path removed (missing paths are a no-op). Branches that become empty are
 * pruned, so clearing the last override of a section removes the section key
 * too. The input is never mutated.
 */
export function deleteAtPath(
  obj: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  const segments = path.split(".");
  const remove = (node: unknown, depth: number): Record<string, unknown> => {
    // A non-object segment means the path does not exist in doc form; the
    // empty object normalizes the corrupt branch away.
    const base = isPlainObject(node) ? { ...node } : {};
    const segment = segments[depth];
    if (segment === undefined) return base;
    if (depth === segments.length - 1) {
      delete base[segment];
    } else if (segment in base) {
      base[segment] = remove(base[segment], depth + 1);
      const child = base[segment];
      if (isPlainObject(child) && Object.keys(child).length === 0) {
        delete base[segment];
      }
    }
    return base;
  };
  return remove(obj, 0);
}

/** Read the stored settings document; {} when the row is absent or not an object. */
export async function getSettingsDoc(db: Kysely<Database>): Promise<Record<string, unknown>> {
  const row = await db
    .selectFrom("settings")
    .select("value")
    .where("key", "=", SETTINGS_KEY)
    .executeTakeFirst();
  const value = row?.value;
  return isPlainObject(value) ? value : {};
}

/**
 * Deep-merge `partial` (nested object built from dotted paths) into the
 * stored document, transactionally. Creates the row on first write and
 * refreshes updated_at on every write.
 */
export async function saveSettingsDoc(
  db: Kysely<Database>,
  partial: Record<string, unknown>,
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    const current = await getSettingsDoc(tx);
    const merged = deepMerge(current, partial);
    await writeDoc(tx, merged);
  });
}

/** Delete the leaf at a dotted path from the stored document (per-field reset). */
export async function clearSettingsPath(db: Kysely<Database>, path: string): Promise<void> {
  await db.transaction().execute(async (tx) => {
    const next = deleteAtPath(await getSettingsDoc(tx), path);
    if (Object.keys(next).length === 0) {
      await tx.deleteFrom("settings").where("key", "=", SETTINGS_KEY).execute();
    } else {
      await writeDoc(tx, next);
    }
  });
}

async function writeDoc(db: Kysely<Database>, doc: Record<string, unknown>): Promise<void> {
  await db
    .insertInto("settings")
    .values({ key: SETTINGS_KEY, value: doc, updated_at: new Date() })
    .onConflict((oc) => oc.column("key").doUpdateSet({ value: doc, updated_at: new Date() }))
    .execute();
}
