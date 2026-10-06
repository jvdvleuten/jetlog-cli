import { z } from "zod";

/**
 * Mirrors the Jetlog payload schema documented in JetlogAPI/README.md
 * (lines ~45-358). Keep this file in sync with that README; it is the
 * single source of truth for the wire format.
 *
 * Notes on nullability: many fields are "clearable" on a re-import (an
 * explicit `null` clears a previously stored value) but that is a
 * server-side semantic, not a structural one, structurally we just need
 * to accept `null` for those fields so a payload that clears a value
 * still parses. `""` is never valid for any field that isn't a genuinely
 * empty string; the README says `""` is ignored/invalid everywhere, so we
 * don't special-case it beyond normal min-length checks.
 */

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

const dateString = z
  .string()
  .regex(dateRegex, "date must be YYYY-MM-DD");

const timeString = z
  .string()
  .regex(timeRegex, "time must be HH:MM (24h, zulu)");

export const APPROACH_TYPES = [
  "ils_cat1",
  "ils_cat2",
  "ils_cat3",
  "gls",
  "rnp",
  "rnp_ar",
  "loc",
  "vor",
  "ndb",
  "visual",
  "circling",
  "par"
] as const;

export const approachSchema = z.object({
  type: z.enum(APPROACH_TYPES),
  count: z.int().min(1)
});

export const approachesSchema = z.array(approachSchema).nullable();

const takeoffsAndLandingsPlainSchema = z.object({
  takeoffs: z.int().min(0),
  landings: z.int().min(0)
});

const takeoffsAndLandingsSplitSchema = z.object({
  takeoffs_day: z.int().min(0),
  takeoffs_night: z.int().min(0),
  landings_day: z.int().min(0),
  landings_night: z.int().min(0)
});

export const takeoffsAndLandingsSchema = z
  .union([takeoffsAndLandingsPlainSchema, takeoffsAndLandingsSplitSchema])
  .nullable();

export const entryPersonSchema = z.object({
  ref_id: z.string().min(1),
  role: z.string().min(1)
});

export const personSchema = z.object({
  ref_id: z.string().min(1),
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  default_role: z.string().min(1).nullish(),
  employee_number: z.string().min(1).nullish()
});

/**
 * Fields that the README calls "clearable" on a matching existing entry:
 * an explicit `null` clears the stored value, while omitting the key
 * leaves it untouched. Structurally this just means `.nullable()` (as
 * opposed to `.nullish()`, which would also accept the key being
 * entirely absent, these fields are already optional separately).
 */
const clearableString = z.string().min(1).nullable();
const clearableInt = z.int().min(0).nullable();
const clearableTime = timeString.nullable();

export const entrySchema = z
  .object({
    type: z.string().nullish().default("flight"),
    date: dateString,
    flight_number: z.string().min(1).nullish(),
    scheduled_off_blocks: timeString.nullish(),
    scheduled_on_blocks: timeString.nullish(),
    registration: clearableString.optional(),
    from: z.string().min(1).nullish(),
    to: z.string().min(1).nullish(),
    actual_from: clearableString.optional(),
    actual_to: clearableString.optional(),
    off_blocks: clearableTime.optional(),
    airborne: clearableTime.optional(),
    touchdown: clearableTime.optional(),
    on_blocks: clearableTime.optional(),
    people: z.array(entryPersonSchema).nullish(),
    takeoffs_and_landings: takeoffsAndLandingsSchema.optional(),
    approaches: approachesSchema.optional(),
    go_arounds: clearableInt.optional(),
    passengers_on_board: clearableInt.optional(),
    fuel_planned: clearableInt.optional(),
    fuel_used: clearableInt.optional(),
    remarks: z.string().max(1000).nullish(),
    is_deleted: z.boolean().nullish(),
    update_flight_data: z.boolean().nullish()
  })
  .strict();

// Kept transform-free on purpose: z.toJSONSchema() cannot represent a
// `.transform()`/`.default()` pipe, and this schema doubles as the JSON
// Schema we hand to MCP clients and LLMs. The README treats a top-level
// null entries/people the same as an omitted key ([]); that normalization
// happens in validatePayload below instead of in the schema itself.
export const payloadSchema = z
  .object({
    entries: z.array(entrySchema).nullish(),
    people: z.array(personSchema).nullish()
  })
  .strict();

export type Entry = z.infer<typeof entrySchema>;
/** Pre-default-applied shape, convenient for code that builds entries before validation. */
export type EntryInput = z.input<typeof entrySchema>;
export type Person = z.infer<typeof personSchema>;
export type Payload = z.infer<typeof payloadSchema>;
export type PayloadInput = z.input<typeof payloadSchema>;

export type ImportMode = "deeplink" | "api";

export interface RowIssue {
  index: number;
  message: string;
}

/**
 * Per-flow required-field checks that aren't expressible as a single
 * static zod refinement without losing per-row reporting: deeplink needs
 * flight_number OR registration per entry; the partner API needs from
 * AND to. We run the structural schema first, then this pass, so callers
 * get both structural and flow-specific errors per row.
 */
export function checkModeRequirements(payload: Payload, mode: ImportMode): RowIssue[] {
  const issues: RowIssue[] = [];
  const entries = payload.entries ?? [];
  entries.forEach((entry, index) => {
    if (mode === "deeplink") {
      if (!entry.flight_number && !entry.registration) {
        issues.push({
          index,
          message: "deeplink mode requires flight_number or registration"
        });
      }
    } else {
      if (!entry.from || !entry.to) {
        issues.push({
          index,
          message: "api mode requires both from and to"
        });
      }
    }
  });
  return issues;
}

export interface ValidationResult {
  valid: boolean;
  payload?: Payload;
  structuralErrors: { path: string; message: string }[];
  modeErrors: RowIssue[];
}

export function validatePayload(data: unknown, mode?: ImportMode): ValidationResult {
  const parsed = payloadSchema.safeParse(data);
  if (!parsed.success) {
    return {
      valid: false,
      structuralErrors: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message
      })),
      modeErrors: []
    };
  }

  const normalized: Payload = {
    entries: parsed.data.entries ?? [],
    people: parsed.data.people ?? []
  };
  const modeErrors = mode ? checkModeRequirements(normalized, mode) : [];
  return {
    valid: modeErrors.length === 0,
    payload: normalized,
    structuralErrors: [],
    modeErrors
  };
}
