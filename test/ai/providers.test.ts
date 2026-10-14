import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "../../src/ai/anthropic.js";
import { OpenAiProvider } from "../../src/ai/openai.js";

const schema = { type: "object", properties: { entries: { type: "array" } } };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function mockFetch(...responses: Response[]) {
  const fn = vi.fn(async (..._args: unknown[]) => {
    const next = responses.shift();
    if (!next) throw new Error("no canned response left");
    return next;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("AnthropicProvider", () => {
  it("posts a forced tool call and returns the tool input", async () => {
    const fetchFn = mockFetch(json({ content: [{ type: "text", text: "x" }, { type: "tool_use", input: { entries: [] } }] }));
    const result = await new AnthropicProvider("sk-ant-test").generateStructured({
      input: "a,b",
      jsonSchema: schema,
      instructions: "be exact"
    });
    expect(result.data).toEqual({ entries: [] });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("claude-sonnet-5");
    expect(body.max_tokens).toBe(8192);
    expect(body.tool_choice).toEqual({ type: "tool", name: "emit_jetlog_payload" });
    expect(body.tools[0].input_schema).toEqual(schema);
    expect(body.messages[0].content).toBe("Instructions: be exact\n\nSource data:\n\na,b");
  });

  it("fails when there is no tool_use block", async () => {
    mockFetch(json({ content: [{ type: "text", text: "no" }] }));
    await expect(new AnthropicProvider("k").generateStructured({ input: "x", jsonSchema: schema })).rejects.toThrow(
      "Anthropic response did not include a tool_use block"
    );
  });

  it("retries a 429 and then succeeds", async () => {
    const fetchFn = mockFetch(
      json({ error: { message: "slow down" } }, 429, { "retry-after": "0" }),
      json({ content: [{ type: "tool_use", input: { ok: true } }] })
    );
    const result = await new AnthropicProvider("k").generateStructured({ input: "x", jsonSchema: schema });
    expect(result.data).toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 401 and reports the API message", async () => {
    const fetchFn = mockFetch(json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401));
    await expect(new AnthropicProvider("k").generateStructured({ input: "x", jsonSchema: schema })).rejects.toThrow(
      "Anthropic API error 401: invalid x-api-key"
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("OpenAiProvider", () => {
  it("posts to the Responses API and parses the output text", async () => {
    const fetchFn = mockFetch(
      json({ output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: '{"entries":[]}' }] }] })
    );
    const result = await new OpenAiProvider("sk-test").generateStructured({
      input: "a,b",
      jsonSchema: schema,
      model: "gpt-x"
    });
    expect(result.data).toEqual({ entries: [] });
    expect(result.raw).toBe('{"entries":[]}');
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("gpt-x");
    expect(body.input[0].role).toBe("system");
    expect(body.input[1]).toEqual({ role: "user", content: "Source data:\n\na,b" });
    expect(body.text.format).toEqual({ type: "json_schema", name: "jetlog_payload", schema, strict: false });
  });

  it("fails on an empty output", async () => {
    mockFetch(json({ output: [] }));
    await expect(new OpenAiProvider("k").generateStructured({ input: "x", jsonSchema: schema })).rejects.toThrow(
      "OpenAI response did not include output text"
    );
  });

  it("retries a 500 and reports a final 400 with its message", async () => {
    const fetchFn = mockFetch(json({}, 500, { "retry-after": "0" }), json({ error: { message: "bad model" } }, 400));
    await expect(new OpenAiProvider("k").generateStructured({ input: "x", jsonSchema: schema })).rejects.toThrow(
      "OpenAI API error 400: bad model"
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
