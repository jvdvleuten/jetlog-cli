import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { payloadSchema } from "../src/schema.js";

/**
 * EXAMPLES.md in the public JetlogAPI repo (github.com/jvdvleuten/JetlogAPI)
 * is the canonical set of example payloads for both import flows. Every
 * ```json block that looks like a request payload (has an "entries" key)
 * must parse against our schema. Response shape examples
 * (e.g. {"data":"OK","skipped":[...]}) are not payloads and are skipped.
 *
 * Needs a JetlogAPI checkout next to this repo, or JETLOG_API_EXAMPLES set to
 * the path of EXAMPLES.md. Skipped when neither is there.
 */
const EXAMPLES_PATH =
  process.env.JETLOG_API_EXAMPLES ?? fileURLToPath(new URL("../../JetlogAPI/EXAMPLES.md", import.meta.url));
const HAS_EXAMPLES = existsSync(EXAMPLES_PATH);

function extractJsonBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const regex = /```json\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    blocks.push(match[1]!);
  }
  return blocks;
}

describe.skipIf(!HAS_EXAMPLES)("JetlogAPI/EXAMPLES.md payloads", () => {
  const markdown = HAS_EXAMPLES ? readFileSync(EXAMPLES_PATH, "utf-8") : "";
  const blocks = extractJsonBlocks(markdown);

  it("finds at least one json block", () => {
    expect(blocks.length).toBeGreaterThan(0);
  });

  const payloadBlocks = blocks
    .map((block, i) => ({ block, i }))
    .filter(({ block }) => {
      try {
        const data = JSON.parse(block);
        return data && typeof data === "object" && "entries" in data;
      } catch {
        return false;
      }
    });

  it("found payload-shaped blocks to validate", () => {
    expect(payloadBlocks.length).toBeGreaterThan(0);
  });

  for (const { block, i } of payloadBlocks) {
    it(`block #${i} validates against the schema`, () => {
      const data = JSON.parse(block);
      const result = payloadSchema.safeParse(data);
      if (!result.success) {
        throw new Error(
          `Block #${i} failed schema validation: ${JSON.stringify(result.error.issues, null, 2)}\n\n${block}`
        );
      }
      expect(result.success).toBe(true);
    });
  }
});
