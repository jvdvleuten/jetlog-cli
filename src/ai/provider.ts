/**
 * Minimal provider abstraction for "turn raw text + instructions into a
 * JSON payload matching a schema". Kept narrow so a fake implementation
 * is trivial to write for tests, and so the Anthropic/OpenAI specifics
 * (tool use vs structured outputs) stay out of the CLI/MCP layers.
 */
export interface StructuredRequest {
  /** Raw source text (CSV/TSV/plain text/markdown/JSON) to convert. */
  input: string;
  /** JSON Schema the response must match. */
  jsonSchema: unknown;
  /** Extra user-supplied instructions, appended to the system rules. */
  instructions?: string;
  /** Model override. */
  model?: string;
}

export interface StructuredResponse {
  /** Parsed JSON object the provider returned. */
  data: unknown;
  /** Raw text, for debugging/logging. */
  raw?: string;
}

export interface AiProvider {
  name: string;
  defaultModel: string;
  generateStructured(request: StructuredRequest): Promise<StructuredResponse>;
}
