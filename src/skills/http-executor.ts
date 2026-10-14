/**
 * HTTP skill executor (design D3): config-driven endpoint templates with
 * `{param}` substitution — path slots URI-encoded, the validated arguments
 * JSON-encoded as the request body — an optional auth header from the
 * referenced `skills.auth` secret, and an AbortController timeout. Plain
 * fetch, no SDKs; tests inject `fetch`.
 *
 * All failures are thrown as descriptive Errors; the dispatcher converts them
 * into error tool-results.
 */

import type { AppConfig } from "../config/schema.js";
import { PARAM_PATTERN } from "./manifest.js";
import type { SkillExecutor } from "./dispatcher.js";

export interface HttpExecutorDeps {
  config: AppConfig;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** Methods that carry a JSON body; the rest go body-less. */
const BODYLESS_METHODS = new Set(["GET", "HEAD", "OPTIONS", "DELETE"]);

export function createHttpExecutor(deps: HttpExecutorDeps): SkillExecutor {
  const doFetch = deps.fetch ?? fetch.bind(globalThis);
  return async (skill, args) => {
    const manifest = skill.manifest;
    if (manifest.execution !== "http") {
      throw new Error("not an http skill");
    }
    const endpointName = manifest.endpoint ?? "";
    const endpoint = deps.config.skills.http[endpointName];
    if (!endpoint) {
      throw new Error(
        `endpoint '${endpointName}' is not configured — set skills.http.${endpointName}.url`,
      );
    }

    const url = substituteUrl(endpoint.url, args);
    const headers: Record<string, string> = {};
    if (manifest.auth !== undefined) {
      const credential = deps.config.skills.auth[manifest.auth];
      if (!credential) {
        throw new Error(
          `auth reference '${manifest.auth}' is not configured — set skills.auth.${manifest.auth}`,
        );
      }
      if (credential.header !== "") headers[credential.header] = credential.value;
    }

    const method = endpoint.method.toUpperCase();
    const withBody = !BODYLESS_METHODS.has(method);
    if (withBody) headers["content-type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), endpoint.timeoutMs);
    try {
      const response = await doFetch(url, {
        method,
        headers,
        ...(withBody ? { body: JSON.stringify(args) } : {}),
        signal: controller.signal,
      });
      if (!response.ok) {
        const snippet = (await safeText(response)).slice(0, 300);
        throw new Error(
          `HTTP ${response.status} ${response.statusText}${snippet ? ` — ${snippet}` : ""}`,
        );
      }
      const text = (await safeText(response)).trim();
      try {
        return JSON.stringify(JSON.parse(text));
      } catch {
        return text; // not JSON — fall back to the raw text
      }
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`request timed out after ${endpoint.timeoutMs}ms`);
      }
      if (err instanceof Error) {
        throw new Error(`request failed: ${err.message}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Replace every {param} slot with the URI-encoded argument value. */
function substituteUrl(template: string, args: Record<string, unknown>): string {
  return template.replace(PARAM_PATTERN, (slot, name: string) => {
    if (!(name in args)) {
      throw new Error(`URL template references '${slot}' which is not in the validated arguments`);
    }
    return encodeURIComponent(argValue(args[name]));
  });
}

function argValue(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
