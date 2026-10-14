/**
 * OpenRouter client speaking the OpenAI-compatible Chat Completions API with
 * server-sent-event (SSE) streaming. All LLM access in the agent goes through
 * this client; model ids are selected per role/language via resolve-model.ts.
 */

/** A tool call made by the assistant (OpenAI chat-completions shape). */
export interface ToolCallRequest {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON-encoded arguments string (not a parsed object), per the API. */
    arguments: string;
  };
}

/** One message of a chat completion request. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Assistant messages only: tool calls requested in this turn (echoed back verbatim when continuing after tool results). */
  tool_calls?: ToolCallRequest[];
  /** Tool messages only: id of the tool call this message answers. */
  tool_call_id?: string;
}

/** One streamed chunk of a chat completion. */
export interface StreamDelta {
  content?: string;
  finishReason?: string | null;
  /** Present when the model streams tool-call arguments. */
  toolCalls?: ToolCallDelta[];
  /**
   * Only on the final delta (the one carrying `finishReason`): every tool call
   * streamed in this completion, accumulated by index from the raw fragments
   * above (`id`/`name` from the first fragment, `arguments` concatenated in
   * arrival order). Absent on plain streams that carry no tool-call deltas.
   */
  completedToolCalls?: CompletedToolCall[];
}

/** Incremental tool_call entry as streamed by the API. */
export interface ToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** A complete tool call assembled from a stream's tool-call deltas. */
export interface CompletedToolCall {
  id: string;
  name: string;
  /** JSON-encoded arguments string, ready for JSON.parse by the caller. */
  arguments: string;
}

/** OpenAI function-tool definition passed through to the API. */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    /** JSON Schema for the arguments object. */
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

/** Options for both streaming and non-streaming chat requests. */
export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

/** Streaming request options; `tools` is an optional passthrough. */
export interface ChatStreamOptions extends ChatOptions {
  tools?: ToolDefinition[];
}

export interface OpenRouterClientConfig {
  apiKey?: string;
  baseUrl?: string;
  /** Site URL sent as the "HTTP-Referer" header (OpenRouter attribution). */
  referer?: string;
  /** App name sent as the "X-Title" header (OpenRouter attribution). */
  title?: string;
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_REFERER = "https://github.com/ai-voice-agent";
const DEFAULT_TITLE = "ai-voice-agent";

interface ChatCompletionsBody {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: ToolDefinition[];
}

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: ToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null };
  }>;
}

export class OpenRouterClient {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly referer: string;
  private readonly title: string;

  constructor(config: OpenRouterClientConfig = {}) {
    this.apiKey = config.apiKey?.trim() || undefined;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.referer = config.referer ?? DEFAULT_REFERER;
    this.title = config.title ?? DEFAULT_TITLE;
    if (!this.apiKey) {
      throw new Error("OPENROUTER_API_KEY is not configured");
    }
  }

  /**
   * Stream a chat completion, yielding content deltas (and tool-call deltas
   * when requested) followed by a final chunk carrying the finish reason.
   * When any tool-call deltas were streamed, the final chunk also carries
   * `completedToolCalls` — the calls assembled from those fragments.
   * SSE comment/keep-alive lines (e.g. ": OPENROUTER PROCESSING") are ignored
   * and the "[DONE]" terminator ends the stream.
   */
  async *chatStream(opts: ChatStreamOptions): AsyncGenerator<StreamDelta> {
    const response = await this.request(
      {
        model: opts.model,
        messages: opts.messages,
        stream: true,
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
        tools: opts.tools,
      },
      opts.signal,
    );
    if (!response.ok) {
      throw await this.errorFrom(response, opts.model);
    }
    if (!response.body) {
      throw new Error(`OpenRouter returned an empty body for model ${opts.model}`);
    }
    // Tool-call accumulation is lazy: the accumulator only exists once a
    // tool-call delta arrives, so plain (tool-free) streams keep today's
    // per-chunk work and event shapes untouched.
    let toolCallAccumulator: ToolCallAccumulator | null = null;
    for await (const line of sseLines(response.body)) {
      if (line === "" || line.startsWith(":")) continue; // keep-alive comments
      if (!line.startsWith("data:")) continue;
      const payload = line.slice("data:".length).trim();
      if (payload === "[DONE]") return;
      let chunk: unknown;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue; // tolerate a partial/garbled frame rather than killing the stream
      }
      const delta = streamDeltaFrom(chunk, opts.model);
      if (!delta) continue;
      if (delta.toolCalls) {
        toolCallAccumulator ??= new Map();
        for (const fragment of delta.toolCalls) {
          accumulateToolCallFragment(toolCallAccumulator, fragment);
        }
      }
      if (delta.finishReason != null && toolCallAccumulator !== null) {
        delta.completedToolCalls = completedToolCalls(toolCallAccumulator);
      }
      yield delta;
    }
  }

  /** Non-streaming chat completion; resolves to the assistant message content. */
  async chat(opts: ChatOptions): Promise<string> {
    const response = await this.request(
      {
        model: opts.model,
        messages: opts.messages,
        stream: false,
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
      },
      opts.signal,
    );
    if (!response.ok) {
      throw await this.errorFrom(response, opts.model);
    }
    const payload = (await response.json()) as ChatCompletionResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
    throw new Error(`OpenRouter response for model ${opts.model} contained no message content`);
  }

  private request(body: ChatCompletionsBody, signal?: AbortSignal): Promise<Response> {
    return fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": this.referer,
      "X-Title": this.title,
    };
  }

  private async errorFrom(response: Response, model: string): Promise<Error> {
    let snippet = "";
    try {
      snippet = (await response.text()).slice(0, 500);
    } catch {
      // body unreadable; report status only
    }
    return new Error(
      `OpenRouter request failed for model ${model}: ` +
        `HTTP ${response.status} ${response.statusText}` +
        (snippet ? ` — ${snippet}` : ""),
    );
  }
}

/** In-progress tool call keyed by its streamed index. */
type ToolCallAccumulator = Map<number, { id?: string; name?: string; arguments: string }>;

/**
 * Fold one streamed tool-call fragment into the accumulator. Fragments arrive
 * keyed by `index`: the first carries `id`/`name`, later ones append argument
 * string fragments in arrival order (OpenAI chat-completions streaming shape).
 */
function accumulateToolCallFragment(acc: ToolCallAccumulator, fragment: ToolCallDelta): void {
  const key = typeof fragment.index === "number" ? fragment.index : acc.size;
  const existing = acc.get(key);
  if (!existing) {
    acc.set(key, {
      id: fragment.id,
      name: fragment.function?.name,
      arguments: fragment.function?.arguments ?? "",
    });
    return;
  }
  if (existing.id === undefined && fragment.id !== undefined) existing.id = fragment.id;
  if (existing.name === undefined && fragment.function?.name !== undefined) {
    existing.name = fragment.function.name;
  }
  if (fragment.function?.arguments) existing.arguments += fragment.function.arguments;
}

/** Snapshot the accumulator as complete calls, ordered by streamed index. */
function completedToolCalls(acc: ToolCallAccumulator): CompletedToolCall[] {
  return [...acc.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => ({
      id: call.id ?? "",
      name: call.name ?? "",
      arguments: call.arguments,
    }));
}

/**
 * Yield complete SSE lines from a response body, buffering partial frames
 * across network chunks.
 */
async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineAt = buffer.indexOf("\n");
      while (newlineAt >= 0) {
        yield buffer.slice(0, newlineAt).replace(/\r$/, "");
        buffer = buffer.slice(newlineAt + 1);
        newlineAt = buffer.indexOf("\n");
      }
    }
    const tail = buffer + decoder.decode();
    if (tail !== "") yield tail.replace(/\r$/, "");
  } finally {
    reader.releaseLock();
  }
}

/** Map one chat.completion.chunk JSON frame to a StreamDelta, or null if it carries nothing. */
function streamDeltaFrom(chunk: unknown, model: string): StreamDelta | null {
  if (typeof chunk !== "object" || chunk === null) return null;
  const record = chunk as { error?: unknown; choices?: unknown };
  if (record.error !== undefined) {
    const message =
      typeof record.error === "object" && record.error !== null && "message" in record.error
        ? String((record.error as { message?: unknown }).message)
        : JSON.stringify(record.error);
    throw new Error(`OpenRouter stream error for model ${model}: ${message}`);
  }
  const choices = record.choices as ChatCompletionChunk["choices"];
  const choice = choices?.[0];
  if (!choice) return null;
  const delta: StreamDelta = {};
  if (typeof choice.delta?.content === "string" && choice.delta.content !== "") {
    delta.content = choice.delta.content;
  }
  if (choice.delta?.tool_calls && choice.delta.tool_calls.length > 0) {
    delta.toolCalls = choice.delta.tool_calls;
  }
  if (choice.finish_reason != null) delta.finishReason = choice.finish_reason;
  if (delta.content === undefined && delta.finishReason === undefined && !delta.toolCalls) {
    return null;
  }
  return delta;
}
