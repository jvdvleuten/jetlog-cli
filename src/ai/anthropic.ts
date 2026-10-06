import Anthropic from "@anthropic-ai/sdk";
import type { AiProvider, StructuredRequest, StructuredResponse } from "./provider.js";
import { buildSystemPrompt } from "./prompt.js";

export const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-5";

export class AnthropicProvider implements AiProvider {
  name = "anthropic";
  defaultModel = ANTHROPIC_DEFAULT_MODEL;
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
    const model = request.model ?? this.defaultModel;
    const toolName = "emit_jetlog_payload";

    const message = await this.client.messages.create({
      model,
      max_tokens: 8192,
      system: buildSystemPrompt(request.jsonSchema),
      tools: [
        {
          name: toolName,
          description: "Emit the converted Jetlog import payload.",
          input_schema: request.jsonSchema as Anthropic.Messages.Tool.InputSchema
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
    });

    const toolUse = message.content.find((block) => block.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("Anthropic response did not include a tool_use block");
    }
    return { data: toolUse.input };
  }
}
