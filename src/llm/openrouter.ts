/**
 * OpenRouter client speaking the OpenAI-compatible Chat Completions API with
 * server-sent-event (SSE) streaming. All LLM access in the agent goes through
 * this client; model ids are selected per role/language via resolve-model.ts.
 */

/** One message of a chat completion request. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

/** One streamed chunk of a chat completion. */
export interface StreamDelta {
  content?: string;
  finishReason?: string | null;
  /** Present when the model streams tool-call arguments. */
  toolCalls?: ToolCallDelta[];
}

/** Incremental tool_call entry as streamed by the API. */
export interface ToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
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
      if (delta) yield delta;
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
