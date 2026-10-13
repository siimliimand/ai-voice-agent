/**
 * OpenRouter conformance check.
 *
 * For every model id configured in config.llm (conversation, summarizer,
 * utility plus per-language conversation overrides, deduplicated) this script:
 *   1. STREAMING CHECK — streams a tiny completion ("Say OK."), asserts at
 *      least one content delta arrives, and measures first-token/total latency;
 *   2. TOOL-CALL READINESS — streams a tool-use prompt with a strict
 *      `get_weather` tool and classifies whether the model emits tool_calls.
 *
 * Usage: npm run conformance
 *
 * Exit codes:
 *   0 — every configured model streamed successfully, or the check was
 *       skipped because OPENROUTER_API_KEY is unset;
 *   1 — at least one configured model failed the basic streaming check.
 * Per-model failures are reported but otherwise non-fatal.
 */

import { loadConfig } from "../../src/config/index.js";
import type { AppConfig } from "../../src/config/schema.js";
import { OpenRouterClient } from "../../src/llm/openrouter.js";
import type { ToolDefinition } from "../../src/llm/openrouter.js";
import { LANGUAGES } from "../../src/types.js";

/** Per-request timeout applied to every conformance check. */
const CHECK_TIMEOUT_MS = 30_000;

const WEATHER_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "City name, e.g. Tallinn" } },
      required: ["city"],
      additionalProperties: false,
    },
    strict: true,
  },
};

interface ModelEntry {
  model: string;
  /** Role labels referencing this model, e.g. ["conversation", "conversation(et)"]. */
  roles: string[];
}

interface StreamResult {
  ok: boolean;
  firstTokenMs: number | null;
  totalMs: number;
  finishReason: string | null;
  error?: string;
}

type ToolReadiness = "tool_calls" | "no_tool_call" | "error";

interface ToolResult {
  readiness: ToolReadiness;
  toolName?: string;
  error?: string;
}

interface ModelReport {
  entry: ModelEntry;
  stream: StreamResult;
  tools: ToolResult;
}

/** Collect every configured model id, deduplicated, with role labels kept for reporting. */
function collectModelEntries(config: AppConfig): ModelEntry[] {
  const byModel = new Map<string, ModelEntry>();
  const add = (role: string, model: string): void => {
    if (!model) return;
    const existing = byModel.get(model);
    if (existing) {
      if (!existing.roles.includes(role)) existing.roles.push(role);
      return;
    }
    byModel.set(model, { model, roles: [role] });
  };
  add("conversation", config.llm.models.conversation);
  add("summarizer", config.llm.models.summarizer);
  add("utility", config.llm.models.utility);
  for (const language of LANGUAGES) {
    add(`conversation(${language})`, config.llm.overrides[language]?.conversation ?? "");
  }
  return [...byModel.values()];
}

async function checkStreaming(client: OpenRouterClient, model: string): Promise<StreamResult> {
  const started = performance.now();
  let firstTokenMs: number | null = null;
  let sawContent = false;
  let finishReason: string | null = null;
  try {
    for await (const delta of client.chatStream({
      model,
      messages: [{ role: "user", content: "Say OK." }],
      temperature: 0,
      maxTokens: 16,
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })) {
      firstTokenMs ??= performance.now() - started;
      if (delta.content) sawContent = true;
      if (delta.finishReason) finishReason = delta.finishReason;
    }
    const totalMs = performance.now() - started;
    if (!sawContent) {
      return {
        ok: false,
        firstTokenMs,
        totalMs,
        finishReason,
        error: "no content deltas received",
      };
    }
    return { ok: true, firstTokenMs, totalMs, finishReason };
  } catch (err) {
    return {
      ok: false,
      firstTokenMs,
      totalMs: performance.now() - started,
      finishReason,
      error: shortError(err),
    };
  }
}

async function checkToolCalls(client: OpenRouterClient, model: string): Promise<ToolResult> {
  try {
    let sawToolCall = false;
    let toolName: string | undefined;
    for await (const delta of client.chatStream({
      model,
      messages: [{ role: "user", content: "What is the weather in Tallinn? Use the tool." }],
      temperature: 0,
      maxTokens: 128,
      tools: [WEATHER_TOOL],
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })) {
      for (const call of delta.toolCalls ?? []) {
        sawToolCall = true;
        toolName ??= call.function?.name;
      }
    }
    return sawToolCall ? { readiness: "tool_calls", toolName } : { readiness: "no_tool_call" };
  } catch (err) {
    return { readiness: "error", error: shortError(err) };
  }
}

function shortError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, " ").trim().slice(0, 120);
}

function describeToolReadiness(tools: ToolResult): string {
  switch (tools.readiness) {
    case "tool_calls":
      return tools.toolName ? `✓ tool_calls (${tools.toolName})` : "✓ tool_calls";
    case "no_tool_call":
      return "✗ no_tool_call";
    case "error":
      return "- error";
  }
}

function describeNotes(report: ModelReport): string {
  const notes: string[] = [];
  if (report.stream.error) {
    notes.push(report.stream.error);
  } else if (report.stream.finishReason) {
    notes.push(`finish_reason=${report.stream.finishReason}`);
  }
  if (report.tools.error) notes.push(report.tools.error);
  if (report.tools.readiness === "no_tool_call") {
    notes.push("model replied without calling the tool (may not support tools)");
  }
  return notes.join("; ");
}

function printTable(reports: ModelReport[]): void {
  const header = [
    "role",
    "model",
    "stream",
    "first-token ms",
    "total ms",
    "tool-call readiness",
    "notes",
  ];
  const rows = reports.map((report) => [
    report.entry.roles.join(", "),
    report.entry.model,
    report.stream.ok ? "✓" : "✗",
    report.stream.firstTokenMs === null ? "-" : String(Math.round(report.stream.firstTokenMs)),
    String(Math.round(report.stream.totalMs)),
    describeToolReadiness(report.tools),
    describeNotes(report),
  ]);
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const format = (cells: string[]) =>
    cells.map((cell, column) => (cell ?? "").padEnd(widths[column] ?? 0)).join("  ");
  console.log(format(header));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) console.log(format(row));
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.llm.apiKey) {
    console.log("OPENROUTER_API_KEY is not set — skipping OpenRouter conformance checks (exit 0).");
    console.log(
      "Set OPENROUTER_API_KEY (plus optional OPENROUTER_BASE_URL / LLM_*_MODEL) and re-run `npm run conformance`.",
    );
    return;
  }

  const client = new OpenRouterClient({ apiKey: config.llm.apiKey, baseUrl: config.llm.baseUrl });
  const entries = collectModelEntries(config);
  console.log(
    `OpenRouter conformance: checking ${entries.length} configured model id(s) against ${config.llm.baseUrl}`,
  );

  const reports: ModelReport[] = [];
  for (const entry of entries) {
    process.stdout.write(`\n  ${entry.model}: streaming check... `);
    const stream = await checkStreaming(client, entry.model);
    process.stdout.write(stream.ok ? "ok" : `FAILED (${stream.error ?? "unknown"})`);
    const tools = stream.ok
      ? await checkToolCalls(client, entry.model)
      : { readiness: "error" as const, error: "skipped: streaming check failed" };
    process.stdout.write(`; tool-call check: ${tools.readiness}`);
    reports.push({ entry, stream, tools });
  }

  console.log("\n");
  printTable(reports);

  const failures = reports.filter((report) => !report.stream.ok);
  if (failures.length > 0) {
    console.error(
      `\nFAILED: ${failures.length} of ${reports.length} configured model(s) did not stream successfully.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`\nOK: all ${reports.length} configured model(s) streamed successfully.`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
