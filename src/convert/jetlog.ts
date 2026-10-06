import { payloadSchema, type Payload } from "../schema.js";

/**
 * Passthrough "converter" for a file that's already Jetlog JSON: just
 * parse and let the caller run it through the normal validator.
 */
export function convertJetlogJson(content: string): Payload {
  const data = JSON.parse(content);
  return payloadSchema.parse(data);
}
