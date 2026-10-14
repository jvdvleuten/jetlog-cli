import type { AiProvider, StructuredRequest, StructuredResponse } from "./provider.js";
import { buildSystemPrompt } from "./prompt.js";
import { postJson } from "./http.js";

export const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-5";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

interface MessagesResult {
  content?: Array<{ type?: string; input?: unknown }>;
}

export class AnthropicProvider implements AiProvider {
  name = "anthropic";
  defaultModel = ANTHROPIC_DEFAULT_MODEL;

  constructor(private apiKey: string) {}

  async generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
    const model = request.model ?? this.defaultModel;
    const toolName = "emit_jetlog_payload";

    const message = (await postJson(
      "Anthropic",
      MESSAGES_URL,
      { "x-api-key": this.apiKey, "anthropic-version": ANTHROPIC_VERSION },
      {
        model,
        max_tokens: 8192,
        system: buildSystemPrompt(request.jsonSchema),
        tools: [
          {
            name: toolName,
            description: "Emit the converted Jetlog import payload.",
            input_schema: request.jsonSchema
          }
        ],
        tool_choice: { type: "tool", name: toolName },
        messages: [
          {
            role: "user",
            content: [
              request.instructions ? `Instructions: ${request.instructions}` : null,
              "Source data:",
              request.input
            ]
              .filter(Boolean)
              .join("\n\n")
          }
        ]
      }
    )) as MessagesResult;

    const toolUse = message.content?.find((block) => block.type === "tool_use");
    if (!toolUse) {
      throw new Error("Anthropic response did not include a tool_use block");
    }
    return { data: toolUse.input };
  }
}
