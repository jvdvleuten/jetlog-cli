import OpenAI from "openai";
import type { AiProvider, StructuredRequest, StructuredResponse } from "./provider.js";
import { buildSystemPrompt } from "./prompt.js";

export const OPENAI_DEFAULT_MODEL = "gpt-5";

export class OpenAiProvider implements AiProvider {
  name = "openai";
  defaultModel = OPENAI_DEFAULT_MODEL;
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
    const model = request.model ?? this.defaultModel;
    const userContent = [
      request.instructions ? `Instructions: ${request.instructions}` : null,
      "Source data:",
      request.input
    ]
      .filter(Boolean)
      .join("\n\n");

    const response = await this.client.responses.create({
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
    });

    const text = response.output_text;
    if (!text) {
      throw new Error("OpenAI response did not include output text");
    }
    return { data: JSON.parse(text), raw: text };
  }
}
