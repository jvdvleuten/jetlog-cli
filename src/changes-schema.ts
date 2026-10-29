import { z } from "zod";
import { placeDataSchema } from "./schema.js";
import { MAX_OPERATIONS, SUMMARY_LIMIT, exceedsLength, lengthMessage, proposalOperationProblems, textProblem } from "./text-rules.js";

/** Marks an issue that belongs to one field of one operation, so it reads `operation 0, remarks: ...`. */
const OPERATION_FIELD = "operationField";

/**
 * The propose payload: one definition for the MCP `propose_changes` tool and `jetlog changes propose`.
 * Keep it free of `.transform()` and `.default()` so `z.toJSONSchema` can represent it.
 */
export const proposeChangesShape = {
  summary: z
    .string()
    .describe("A short, human-readable summary of what this change does, at most 500 characters.")
    .superRefine((summary, ctx) => {
      const problem = textProblem(summary) ?? (exceedsLength(summary, SUMMARY_LIMIT) ? lengthMessage(SUMMARY_LIMIT) : undefined);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    }),
  operations: z
    .array(
      z.object({
        op: z.enum(["create", "update", "delete"]),
        resource: z.enum(["entry", "person", "aircraft", "fstd", "place", "entry_attachment", "signature_link"]),
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
      // A place's data is checked here, before anything is sent. The other resources leave that to the server.
      // A refinement, not a union, so z.toJSONSchema still represents the payload (it skips refinements).
      .superRefine((operation, ctx) => {
        // Text the server refuses, checked before anything is sent.
        for (const problem of proposalOperationProblems(operation)) {
          ctx.addIssue({
            code: "custom",
            path: problem.field === "id" ? ["id"] : ["data", problem.field],
            message: problem.message,
            params: { [OPERATION_FIELD]: problem.field }
          });
        }
        if (operation.resource !== "place" || operation.data === undefined) return;
        const parsed = placeDataSchema.safeParse(operation.data);
        if (parsed.success) return;
        for (const issue of parsed.error.issues) {
          const keys = issue.code === "unrecognized_keys" ? issue.keys : [];
          ctx.addIssue({
            code: "custom",
            path: ["data", ...issue.path],
            message:
              keys.length > 0
                ? `a place does not have ${keys.map((k) => `"${k}"`).join(", ")}. Place fields: ${Object.keys(placeDataSchema.shape).join(", ")}`
                : issue.message
          });
        }
      })
    )
    .max(MAX_OPERATIONS, `at most ${MAX_OPERATIONS} operations in one proposal`)
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
    errors: parsed.error.issues.map((i) => {
      const field = i.code === "custom" ? i.params?.[OPERATION_FIELD] : undefined;
      if (typeof field === "string" && i.path[0] === "operations" && typeof i.path[1] === "number") {
        return `operation ${i.path[1]}, ${field}: ${i.message}`;
      }
      return `${i.path.length > 0 ? i.path.join(".") : "(payload)"}: ${i.message}`;
    })
  };
}
