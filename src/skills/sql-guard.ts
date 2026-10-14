/**
 * Load-time guard for manifest SQL (design D3): a db skill may only run a
 * single read-only SELECT/WITH statement. The check is deliberately
 * parser-level and fail-closed — anything that is not clearly one SELECT/WITH
 * statement is rejected. Enforced at manifest load time (invalid manifests are
 * skipped) and re-checked defensively at dispatch.
 */

/** Write/modification keywords, rejected as word-boundary matches anywhere. */
const DENYLIST = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|COPY)\b/i;

/**
 * Return a human-readable rejection reason for a manifest SQL statement, or
 * null when the statement passes the single-statement read-only checks.
 *
 * Note: string literals are NOT stripped, so a quoted keyword (e.g.
 * `WHERE name = 'insert'`) is also rejected — fail-closed by design.
 */
export function findSqlViolation(statement: string): string | null {
  const trimmed = statement.trim();
  if (trimmed === "") return "SQL statement is empty";
  if (!/^(SELECT|WITH)\b/i.test(trimmed)) {
    return "must be a single SELECT or WITH statement";
  }
  const withoutTrailing = trimmed.replace(/;\s*$/, "");
  if (withoutTrailing.includes(";")) {
    return "must be a single statement — only one optional trailing ';' is allowed";
  }
  const denied = DENYLIST.exec(withoutTrailing);
  if (denied) {
    return `write keyword '${denied[1]?.toUpperCase()}' is not allowed`;
  }
  return null;
}
