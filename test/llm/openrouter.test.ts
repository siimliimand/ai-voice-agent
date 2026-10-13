import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OpenRouterClient,
  type StreamDelta,
  type ToolDefinition,
} from "../../src/llm/openrouter.js";

const encoder = new TextEncoder();

/** Build a 200 Response whose body is a web ReadableStream of SSE frames. */
function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const STREAM_FRAMES = [
  ": OPENROUTER PROCESSING\n\n",
  'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}\n\n',
  ": OPENROUTER PROCESSING\n\n",
  'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
  'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  "data: [DONE]\n\n",
];

const TOOL_FRAMES = [
  'data: {"id":"c2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}\n\n',
  'data: {"id":"c2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"Tallinn\\"}"}}]},"finish_reason":null}]}\n\n',
  'data: {"id":"c2","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  "data: [DONE]\n\n",
];

const WEATHER_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
    strict: true,
  },
};

async function collect(
  client: OpenRouterClient,
  opts: Parameters<OpenRouterClient["chatStream"]>[0],
): Promise<StreamDelta[]> {
  const deltas: StreamDelta[] = [];
  for await (const delta of client.chatStream(opts)) deltas.push(delta);
  return deltas;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenRouterClient.chatStream", () => {
  it("parses deltas in order, skips comments, and stops at [DONE]", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(STREAM_FRAMES));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenRouterClient({ apiKey: "test-key" });

    const deltas = await collect(client, {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(deltas).toEqual([{ content: "Hel" }, { content: "lo" }, { finishReason: "stop" }]);
  });

  it("emits nothing for a stream of only keep-alive comment lines", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(sseResponse([": OPENROUTER PROCESSING\n\n", ":\n\n"])),
    );
    const client = new OpenRouterClient({ apiKey: "test-key" });

    const deltas = await collect(client, {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(deltas).toEqual([]);
  });

  it("posts to {baseUrl}/chat/completions with attribution headers and stream payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(STREAM_FRAMES));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenRouterClient({
      apiKey: "test-key",
      baseUrl: "https://openrouter.ai/api/v1/",
    });

    await collect(client, {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.5,
      maxTokens: 32,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("http-referer")).toBeTruthy();
    expect(headers.get("x-title")).toBeTruthy();
    expect(JSON.parse(String(init.body))).toEqual({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      temperature: 0.5,
      max_tokens: 32,
    });
  });

  it("passes the tools array through to the request and surfaces tool_call deltas", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(TOOL_FRAMES));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenRouterClient({ apiKey: "test-key" });

    const deltas = await collect(client, {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "What is the weather in Tallinn? Use the tool." }],
      tools: [WEATHER_TOOL],
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.tools).toEqual([WEATHER_TOOL]);
    expect(deltas[0]?.toolCalls?.[0]?.function?.name).toBe("get_weather");
    expect(deltas[1]?.toolCalls?.[0]?.function?.arguments).toBe('{"city":"Tallinn"}');
    expect(deltas[2]?.finishReason).toBe("tool_calls");
  });

  it("throws an informative error (status + body snippet) on non-200 responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("rate limit exceeded", { status: 429 })),
    );
    const client = new OpenRouterClient({ apiKey: "test-key" });

    await expect(collect(client, { model: "openai/gpt-4o-mini", messages: [] })).rejects.toThrow(
      /HTTP 429 .*rate limit exceeded/,
    );
  });

  it("throws on in-stream error frames", async () => {
    const frames = ['data: {"error":{"message":"model is overloaded"}}\n\n', "data: [DONE]\n\n"];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse(frames)));
    const client = new OpenRouterClient({ apiKey: "test-key" });

    await expect(collect(client, { model: "openai/gpt-4o-mini", messages: [] })).rejects.toThrow(
      "OpenRouter stream error for model openai/gpt-4o-mini: model is overloaded",
    );
  });
});

describe("OpenRouterClient.chat", () => {
  it("returns the assistant message content from a non-streaming request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "SUMMARY" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenRouterClient({ apiKey: "test-key" });

    const out = await client.chat({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "summarize" }],
    });

    expect(out).toBe("SUMMARY");
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.stream).toBe(false);
  });

  it("throws an informative error on non-200 responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }),
        ),
    );
    const client = new OpenRouterClient({ apiKey: "test-key" });

    await expect(client.chat({ model: "openai/gpt-4o-mini", messages: [] })).rejects.toThrow(
      /HTTP 401 .*bad key/,
    );
  });
});

describe("OpenRouterClient construction", () => {
  it("throws when the API key is missing or empty", () => {
    expect(() => new OpenRouterClient({})).toThrow("OPENROUTER_API_KEY is not configured");
    expect(() => new OpenRouterClient({ apiKey: "  " })).toThrow(
      "OPENROUTER_API_KEY is not configured",
    );
  });
});
