import type { AiProvider, StructuredRequest, StructuredResponse } from "./provider.js";
import { buildSystemPrompt } from "./prompt.js";
import { postJson } from "./http.js";

export const OPENAI_DEFAULT_MODEL = "gpt-5";

const RESPONSES_URL = "https://api.openai.com/v1/responses";

interface ResponsesResult {
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
}

export class OpenAiProvider implements AiProvider {
  name = "openai";
  defaultModel = OPENAI_DEFAULT_MODEL;

  constructor(private apiKey: string) {}

  async generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
    const model = request.model ?? this.defaultModel;
    const userContent = [
      request.instructions ? `Instructions: ${request.instructions}` : null,
      "Source data:",
      request.input
    ]
      .filter(Boolean)
      .join("\n\n");

    const result = (await postJson(
      "OpenAI",
      RESPONSES_URL,
      { authorization: `Bearer ${this.apiKey}` },
      {
        model,
        input: [
          { role: "system", content: buildSystemPrompt(request.jsonSchema) },
          { role: "user", content: userContent }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "jetlog_payload",
            schema: request.jsonSchema as Record<string, unknown>,
            strict: false
          }
        }
      }
    )) as ResponsesResult;

    // Same as the SDK's `output_text`: all output_text parts of all messages, joined.
    const text = (result.output ?? [])
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === "output_text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
    if (!text) {
      throw new Error("OpenAI response did not include output text");
    }
    return { data: JSON.parse(text), raw: text };
  }
}
