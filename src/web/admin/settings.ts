/**
 * Server-rendered admin settings page (GET/POST /admin/settings) — the HTML
 * sibling of the JSON API in api/settings.ts and the call pages in pages.ts.
 *
 * Plain HTML form, no frontend framework: the browser posts
 * application/x-www-form-urlencoded (parser registered in this module's
 * encapsulated scope only) and the handler translates the form into the SAME
 * validation/persistence path as PUT /api/settings:
 *
 *   form fields  →  dotted-path changes (only editable paths; empty secrets
 *                    mean "keep current"; only fields that actually differ
 *                    from the effective value become overrides)
 *                →  merged candidate (effective <- changes) validated with
 *                    configSchema (identical to the API)
 *                →  clearSettingsPath(reset[]) then saveSettingsDoc(values)
 *                →  invalidate() hook + 303 redirect to ?saved=1
 *
 * Secrets are write-only: GET renders masked `{set, hint}` state (never the
 * raw value, never a value attribute); POST treats a blank secret as
 * "keep current".
 *
 * The infra paths (INFRA_PATHS: port/host/databaseUrl/publicBaseUrl) are not
 * editable and render read-only at the bottom ("set via environment").
 *
 * Registration (src/app.ts, inside the `if (db)` block next to
 * registerAdminPages — the invalidate hook wires the live-apply cache):
 *
 *   registerSettingsPage(app, {
 *     db: kyselySettingsDb(db),
 *     config,
 *     invalidate: () => resolver.invalidate(),
 *   });
 */
import { basicAuthScope } from "../../auth/basic-auth.js";
import { maskSecretValues, type SettingsDb } from "../../api/settings.js";
import { EDITABLE_SECTIONS } from "../../config/editable.js";
import type { EditableField, EditableSection } from "../../config/editable.js";
import { sourcePathsFromDoc } from "../../config/effective.js";
import { deepMerge } from "../../config/index.js";
import { configSchema, type AppConfig } from "../../config/schema.js";
import { getAtPath, setAtPath } from "../../db/settings.js";
import { logger } from "../../logging.js";
import type { FastifyInstance } from "fastify";
import { escapeHtml } from "./pages.js";

/** Same persistence seam as the settings API (kyselySettingsDb binds it). */
export interface SettingsPageDeps {
  db: SettingsDb;
  /** Startup/base config; effective values are computed per request. */
  config: AppConfig;
  /** Optional cache hook, e.g. EffectiveConfigResolver.invalidate(). */
  invalidate?: () => void;
}

/** Everything the renderer needs; `renderSettingsPage` is pure over this. */
export interface SettingsPageState {
  sections: EditableSection[];
  /** Effective config with secrets replaced by {set, hint} (never raw). */
  values: Record<string, unknown>;
  /** Editable paths that currently have a DB override. */
  overrides: ReadonlySet<string>;
  /** ?saved=1 — render the green "Settings saved" banner. */
  saved: boolean;
  /** Raw submitted strings per dotted path (validation-error re-render). */
  submitted: ReadonlyMap<string, string> | null;
  /** Per-path validation messages (validation-error re-render). */
  errors: ReadonlyMap<string, string> | null;
}

/** urlencoded form body: repeated keys (reset checkboxes) become arrays. */
type FormMap = Record<string, string | string[]>;

/**
 * Read-only infra display (mirrors INFRA_PATHS from config/editable.ts; kept
 * as an ordered list for stable rendering).
 */
const INFRA_FIELDS: Array<{ path: string; label: string }> = [
  { path: "port", label: "Port" },
  { path: "host", label: "Host" },
  { path: "publicBaseUrl", label: "Public base URL" },
  { path: "databaseUrl", label: "Database URL" },
];

/**
 * Register GET/POST /admin/settings inside its own basic-auth scope (same
 * realm/credentials as the /admin pages, mirroring how registerSettingsApi
 * sits beside registerAdminApi under /api). Fails closed when basic auth is
 * not registered on the app.
 */
export function registerSettingsPage(app: FastifyInstance, deps: SettingsPageDeps): void {
  basicAuthScope(app, "/admin/settings", (scope) => {
    // Standard HTML form POST. Replace any INHERITED urlencoded parser with a
    // multi-value one scoped to this plugin: the app may already have a
    // last-value-wins parser (the Twilio webhook routes register one at the
    // app level), which would collapse the repeated `reset` keys into one.
    scope.removeContentTypeParser("application/x-www-form-urlencoded");
    scope.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_req, body, done) => {
        done(null, parseFormParams(String(body)));
      },
    );

    scope.get("/", async (req, reply) => {
      const loaded = await loadSettings(deps);
      const saved = (req.query as { saved?: string }).saved === "1";
      return reply.type("text/html; charset=utf-8").send(
        renderSettingsPage({
          sections: EDITABLE_SECTIONS,
          values: loaded.values,
          overrides: loaded.overrides,
          saved,
          submitted: null,
          errors: null,
        }),
      );
    });

    scope.post("/", async (req, reply) => {
      const form = toFormMap(req.body);
      const loaded = await loadSettings(deps);
      const fields = allFields(EDITABLE_SECTIONS);

      // Per-field reset: only paths that currently have a DB override.
      const resetPaths = formList(form, "reset").filter((path) => loaded.overrides.has(path));

      // Form → {values, reset} payload, exactly the paths PUT /api/settings
      // would accept. Only fields that differ from the effective value become
      // changes, so a plain save does not turn every field into an override.
      const { changes, submitted } = collectChanges(fields, form, loaded.effective);

      let partial: Record<string, unknown> = {};
      for (const [path, value] of changes) partial = setAtPath(partial, path, value);

      // Same validation contract as the API: the MERGED candidate (current
      // effective <- changes) must parse before anything is persisted.
      if (changes.size > 0) {
        const candidate = configSchema.safeParse(deepMerge(loaded.effective, partial));
        if (!candidate.success) {
          const errors = new Map<string, string>();
          for (const issue of candidate.error.issues) {
            const path = issue.path.join(".");
            if (!errors.has(path)) errors.set(path, issue.message);
          }
          // Re-render (200) with the submitted values preserved (secrets
          // blank) and per-field messages; nothing was persisted.
          return reply.type("text/html; charset=utf-8").send(
            renderSettingsPage({
              sections: EDITABLE_SECTIONS,
              values: loaded.values,
              overrides: loaded.overrides,
              saved: false,
              submitted,
              errors,
            }),
          );
        }
      }

      for (const path of resetPaths) await deps.db.clearSettingsPath(path);
      if (Object.keys(partial).length > 0) await deps.db.saveSettingsDoc(partial);
      deps.invalidate?.();

      // Audit-friendly log (secrets never reach it: only the paths).
      req.log.warn(
        { changed: [...changes.keys(), ...resetPaths] },
        "settings updated via admin form (live-applied to new calls)",
      );

      return reply.code(303).header("location", "/admin/settings?saved=1").send();
    });
  });
}

/* ------------------------------------------------------------------ */
/* State loading (same data path as GET /api/settings)                  */
/* ------------------------------------------------------------------ */

interface LoadedSettings {
  effective: AppConfig;
  values: Record<string, unknown>;
  overrides: ReadonlySet<string>;
}

/** Effective config <- stored doc; falls back to base on failure (fail-safe). */
async function loadSettings(deps: SettingsPageDeps): Promise<LoadedSettings> {
  let doc: Record<string, unknown> = {};
  try {
    doc = await deps.db.getSettingsDoc();
  } catch (err) {
    logger.error({ err }, "settings page: failed to read settings doc — showing base config");
    doc = {};
  }
  let effective: AppConfig;
  try {
    effective = Object.keys(doc).length === 0 ? deps.config : configSchema.parse(deepMerge(deps.config, doc));
  } catch (err) {
    logger.error({ err }, "settings page: stored settings doc is invalid — using base config");
    effective = deps.config;
  }
  return {
    effective,
    values: maskSecretValues(effective),
    overrides: sourcePathsFromDoc(doc),
  };
}

/* ------------------------------------------------------------------ */
/* Form parsing + payload building                                      */
/* ------------------------------------------------------------------ */

/** "a=1&reset=x&reset=y" → { a: "1", reset: ["x", "y"] }. */
function parseFormParams(body: string): FormMap {
  const out: FormMap = {};
  for (const [key, value] of new URLSearchParams(body)) {
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  }
  return out;
}

function toFormMap(body: unknown): FormMap {
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as FormMap)
    : {};
}

/** First submitted value for a key ("" when absent). */
function formOne(form: FormMap, key: string): string {
  const value = form[key];
  if (Array.isArray(value)) return value[0] ?? "";
  return typeof value === "string" ? value : "";
}

/** All submitted values for a key (checkbox groups like reset[]). */
function formList(form: FormMap, key: string): string[] {
  const value = form[key];
  if (Array.isArray(value)) return value;
  return typeof value === "string" && value !== "" ? [value] : [];
}

/** Flatten a section list into its fields. */
function allFields(sections: EditableSection[]): EditableField[] {
  return sections.flatMap((section) => section.fields);
}

/**
 * Translate submitted form fields into the API's {values, reset} shape:
 * - only editable paths are considered (the fields come from the contract);
 * - secrets: "" → keep current (dropped); a real value becomes the change;
 * - booleans: rendered as hidden value="false" + checkbox value="true", so
 *   the last submitted value is authoritative (unchecked → "false"); a
 *   boolean entirely absent from the body is skipped (not submitted);
 * - numbers: strings are coerced like the API does; a non-numeric string is
 *   passed through so configSchema rejects it with a per-field message;
 * - other types: a field ABSENT from the body is untouched (browsers submit
 *   every text/select/number input; partial bodies simply skip fields);
 *   present-but-empty strings clear the value toward the schema default,
 *   and only fields that differ from the effective value become changes
 *   (a plain save must not create a DB override for every field).
 * Returns the change map plus the raw submitted strings for re-rendering.
 */
function collectChanges(
  fields: EditableField[],
  form: FormMap,
  effective: AppConfig,
): { changes: Map<string, unknown>; submitted: Map<string, string> } {
  const changes = new Map<string, unknown>();
  const submitted = new Map<string, string>();
  for (const field of fields) {
    if (field.type === "boolean") {
      // The form renders every boolean as hidden value="false" + checkbox
      // value="true" (browsers omit unchecked boxes), so a boolean that is
      // absent from the body was simply not submitted → no change.
      if (form[field.path] === undefined) continue;
      const value = formList(form, field.path).at(-1) === "true";
      submitted.set(field.path, value ? "true" : "false");
      if (getAtPath(effective, field.path) !== value) changes.set(field.path, value);
      continue;
    }
    if (field.type === "secret") {
      const text = formOne(form, field.path);
      submitted.set(field.path, ""); // never echo a submitted secret back
      if (text.trim() === "") continue; // empty = keep current value
      changes.set(field.path, text);
      continue;
    }
    const text = formOne(form, field.path);
    if (form[field.path] === undefined) continue; // not submitted → untouched
    submitted.set(field.path, text);
    const current = getAtPath(effective, field.path);
    if (field.type === "number") {
      const trimmed = text.trim();
      if (trimmed === "") continue; // untouched/empty number → no change
      const n = Number(trimmed);
      const value = Number.isFinite(n) ? n : trimmed; // invalid → zod fails
      if (current !== value) changes.set(field.path, value);
      continue;
    }
    // string / select: clearing a non-empty value is a real change; clearing
    // an already-empty one is not.
    if (text === "" && (current === undefined || current === null || current === "")) continue;
    if (String(current ?? "") !== text) changes.set(field.path, text);
  }
  return { changes, submitted };
}

/* ------------------------------------------------------------------ */
/* Rendering                                                            */
/* ------------------------------------------------------------------ */

/**
 * Pure renderer for the settings page (exported for tests so a stubbed
 * sections dataset can be rendered directly).
 */
export function renderSettingsPage(state: SettingsPageState): string {
  const sections = state.sections.map((section) => renderSection(section, state)).join("\n");
  return renderPage(
    "Settings",
    `${renderBanners(state)}
<form method="post" action="/admin/settings" class="settings">
${sections}
${renderInfra(state.values)}
<div class="actions">
  <button type="submit" class="save">Save settings</button>
  <span class="muted">Blank secret fields keep their current value.</span>
</div>
</form>
${CONFIRM_RESET_SCRIPT}`,
  );
}

function renderBanners(state: SettingsPageState): string {
  const banners = [
    `<div class="banner info">Changes apply to <strong>new calls immediately</strong>; fields marked <span class="badge badge-restart">restart</span> need a server restart.</div>`,
  ];
  if (state.saved) {
    banners.push(`<div class="banner saved"><strong>Settings saved.</strong></div>`);
  }
  if (state.errors !== null && state.errors.size > 0) {
    banners.push(
      `<div class="banner error"><strong>Settings were not saved</strong> — fix the highlighted fields and try again.</div>`,
    );
  }
  return banners.join("\n");
}

function renderSection(section: EditableSection, state: SettingsPageState): string {
  const rows = section.fields.map((field) => renderField(field, state)).join("\n");
  return `<fieldset class="section" id="section-${escapeHtml(section.id)}">
<legend>${escapeHtml(section.title)}</legend>
${rows}
</fieldset>`;
}

function renderField(field: EditableField, state: SettingsPageState): string {
  const id = inputId(field.path);
  const badges: string[] = [];
  if (state.overrides.has(field.path)) {
    badges.push(`<span class="badge badge-override">override</span>`);
  }
  if (field.restartRequired) {
    badges.push(`<span class="badge badge-restart">restart</span>`);
  }
  // Reset only makes sense for paths that actually have a DB override.
  const reset = state.overrides.has(field.path)
    ? `<label class="reset"><input type="checkbox" name="reset" value="${escapeHtml(field.path)}"> reset</label>`
    : "";
  const error = state.errors?.get(field.path);
  return `<div class="field${error ? " has-error" : ""}">
  <div class="field-head"><label for="${id}">${escapeHtml(field.label)}</label>${badges.join("")}${reset}</div>
  ${renderControl(field, state, id)}
${renderHelp(field, state)}${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
</div>`;
}

/** Render one input/select according to the field type (or the submitted value on re-render). */
function renderControl(field: EditableField, state: SettingsPageState, id: string): string {
  const name = escapeHtml(field.path);
  if (field.type === "boolean") {
    const submitted = state.submitted?.get(field.path);
    const checked = submitted !== undefined ? submitted === "true" : getAtPath(state.values, field.path) === true;
    // Hidden "false" fallback: unchecked boxes are omitted by browsers, the
    // last submitted value wins (checkbox value="true" overrides it).
    return `<input type="hidden" name="${name}" value="false"><input id="${id}" name="${name}" type="checkbox" value="true"${checked ? " checked" : ""}>`;
  }
  if (field.type === "secret") {
    // Write-only: no value attribute, ever. Blank submission keeps the
    // current value.
    return `<input id="${id}" name="${name}" type="password" placeholder="unchanged" autocomplete="new-password">`;
  }
  if (field.type === "select") {
    const current = state.submitted?.get(field.path) ?? textOf(getAtPath(state.values, field.path));
    const options = field.options ?? [];
    // Preserve an out-of-enum submitted value visibly on error re-render.
    const extra = options.includes(current)
      ? ""
      : `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}</option>`;
    const known = options
      .map(
        (option) =>
          `<option value="${escapeHtml(option)}"${option === current ? " selected" : ""}>${escapeHtml(option)}</option>`,
      )
      .join("");
    return `<select id="${id}" name="${name}">${extra}${known}</select>`;
  }
  const current = state.submitted?.get(field.path) ?? textOf(getAtPath(state.values, field.path));
  if (field.type === "number") {
    const attrs = [
      field.min !== undefined ? ` min="${field.min}"` : "",
      field.max !== undefined ? ` max="${field.max}"` : "",
      field.step !== undefined ? ` step="${field.step}"` : "",
    ].join("");
    return `<input id="${id}" name="${name}" type="number"${attrs} value="${escapeHtml(current)}">`;
  }
  return `<input id="${id}" name="${name}" type="text" value="${escapeHtml(current)}">`;
}

function renderHelp(field: EditableField, state: SettingsPageState): string {
  const parts: string[] = [];
  if (field.type === "secret") {
    const current = getAtPath(state.values, field.path) as { set?: unknown; hint?: unknown } | undefined;
    parts.push(
      current?.set === true
        ? `currently set (${escapeHtml(textOf(current.hint))})`
        : "currently not set",
    );
  }
  if (field.restartRequired) parts.push("takes effect after restart");
  if (field.help) parts.push(escapeHtml(field.help));
  if (parts.length === 0) return "";
  return `  <div class="help">${parts.join(" · ")}</div>`;
}

/** Read-only infra display: disabled inputs, never submitted (no name). */
function renderInfra(values: Record<string, unknown>): string {
  const rows = INFRA_FIELDS.map(({ path, label }) => {
    const id = `infra-${escapeHtml(path)}`;
    return `  <div class="field">
  <div class="field-head"><label for="${id}">${escapeHtml(label)}</label><span class="badge badge-infra">read-only</span></div>
  <input id="${id}" type="text" value="${escapeHtml(textOf(getAtPath(values, path)))}" disabled>
  <div class="help">set via environment</div>
</div>`;
  }).join("\n");
  return `<fieldset class="section infra">
<legend>Infrastructure</legend>
${rows}
</fieldset>`;
}

function inputId(path: string): string {
  return `f-${path.replace(/[^a-zA-Z0-9]+/g, "-")}`;
}

/** Unknown leaf → display string (undefined/null → ""). */
function textOf(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

/** Tiny nicety: confirm before per-field resets are submitted. */
const CONFIRM_RESET_SCRIPT = `<script>
(function () {
  var form = document.querySelector("form.settings");
  if (!form) return;
  form.addEventListener("submit", function (event) {
    var count = form.querySelectorAll('input[name="reset"]:checked').length;
    if (count > 0 && !window.confirm("Reset " + count + " field" + (count === 1 ? "" : "s") + " to its inherited value?")) {
      event.preventDefault();
    }
  });
})();
</script>`;

/* ------------------------------------------------------------------ */
/* Page shell (kept in visual sync with pages.ts renderPage)            */
/* ------------------------------------------------------------------ */

function renderPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Voice Agent Admin</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f6f7f9; color: #1c2733;
         font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif; }
  main { max-width: 960px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  h1 .sub { color: #5b6b7b; font-weight: 400; font-size: .95rem; }
  .topnav { font-size: .88rem; margin: 0 0 14px; }
  .section-title { font-size: 1.1rem; margin: 28px 0 10px; }
  .muted { color: #5b6b7b; font-size: .88rem; }
  a { color: #2563eb; }
  .badge { display: inline-block; padding: 2px 9px; border-radius: 999px;
           font-size: .74rem; font-weight: 600; white-space: nowrap; }
  .badge-override { background: #fdf2d7; color: #8a6116; }
  .badge-restart { background: #ece9fd; color: #5b3fb8; }
  .badge-infra { background: #eef2f6; color: #52616f; }
  .banner { border-radius: 8px; padding: 12px 16px; margin: 0 0 14px; font-size: .92rem; }
  .banner.info { background: #e8f1fd; border: 1px solid #bcd7f7; color: #1d4ed8; }
  .banner.saved { background: #e3f5e9; border: 1px solid #b7e2c3; color: #1c7c3d; }
  .banner.error { background: #fde5e5; border: 1px solid #f5b5b5; color: #b02a2a; }
  fieldset.section { background: #fff; border: 1px solid #e2e7ec; border-radius: 8px;
                     margin: 0 0 16px; padding: 8px 18px 14px; }
  fieldset.section legend { font-size: .78rem; text-transform: uppercase; letter-spacing: .05em;
                            color: #52616f; font-weight: 700; padding: 0 6px; }
  .field { padding: 12px 0; border-bottom: 1px solid #eef1f4; }
  .field:last-child { border-bottom: none; }
  .field-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 6px; }
  .field-head label { font-weight: 600; font-size: .92rem; }
  .help { color: #5b6b7b; font-size: .8rem; margin-top: 4px; }
  .field .error { color: #b02a2a; font-size: .82rem; font-weight: 600; margin-top: 4px; }
  .field.has-error input[type="text"], .field.has-error input[type="number"],
  .field.has-error select { border-color: #b02a2a; }
  input[type="text"], input[type="number"], input[type="password"], select {
    width: 100%; max-width: 420px; padding: 7px 10px; font: inherit; font-size: .9rem;
    border: 1px solid #cbd5de; border-radius: 6px; background: #fff; color: #1c2733; }
  input[type="checkbox"] { width: 15px; height: 15px; accent-color: #2563eb; }
  input:disabled { background: #f0f3f6; color: #52616f; }
  label.reset { display: inline-flex; align-items: center; gap: 5px; margin-left: auto;
                color: #b02a2a; font-size: .8rem; cursor: pointer; }
  .actions { display: flex; align-items: center; gap: 14px; margin: 20px 0; }
  button.save { background: #2563eb; color: #fff; border: none; border-radius: 6px;
                padding: 9px 20px; font: inherit; font-weight: 600; cursor: pointer; }
  button.save:hover { background: #1d4ed8; }
</style>
</head>
<body>
<main>
<h1>Voice Agent Admin <span class="sub">· ${escapeHtml(title)}</span></h1>
<p class="topnav"><a href="/admin">Calls</a> · <a href="/admin/settings">Settings</a></p>
${body}
</main>
</body>
</html>`;
}
