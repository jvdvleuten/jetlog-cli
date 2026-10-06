import { z } from "zod";
import { payloadSchema } from "./schema.js";

export function getJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(payloadSchema, { target: "draft-7" }) as Record<string, unknown>;
}

export function formatJsonSchemaAsMarkdown(): string {
  const schema = getJsonSchema();
  return ["# Jetlog import payload: JSON Schema", "", "```json", JSON.stringify(schema, null, 2), "```"].join(
    "\n"
  );
}
