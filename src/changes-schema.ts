import { z } from "zod";

/**
 * The propose payload: one definition for the MCP `propose_changes` tool and `jetlog changes propose`.
 * Keep it free of `.transform()` and `.default()` so `z.toJSONSchema` can represent it.
 */
export const proposeChangesShape = {
  summary: z.string().describe("A short, human-readable summary of what this change does."),
  operations: z
    .array(
      z.object({
        op: z.enum(["create", "update", "delete"]),
        resource: z.enum(["entry", "person", "aircraft", "fstd", "entry_attachment", "signature_link"]),
        id: z.string().optional().describe("Required for update/delete; omit for create."),
        data: z.record(z.string(), z.unknown()).optional(),
        add_self: z
          .boolean()
          .optional()
          .describe(
            "Entry creates only. Default true: the server adds the pilot to `people` with their default role if missing. " +
              "Set false ONLY when the pilot was genuinely not crew on this flight."
          )
      })
    )
    .max(200)
    .describe("The proposed operations, at most 200.")
};

export const proposeChangesSchema = z.object(proposeChangesShape);

export type ProposeChangesInput = z.infer<typeof proposeChangesSchema>;

export function getProposeChangesJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(proposeChangesSchema, { target: "draft-7" }) as Record<string, unknown>;
}

/** A parsed payload, or readable problems ("operations.0.op: Invalid option ...") per field. */
export function parseProposeChanges(
  raw: unknown
): { ok: true; value: ProposeChangesInput } | { ok: false; errors: string[] } {
  const parsed = proposeChangesSchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => `${i.path.length > 0 ? i.path.join(".") : "(payload)"}: ${i.message}`)
  };
}
