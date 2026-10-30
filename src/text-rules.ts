/**
 * The Jetlog server's rules for text a client sends, checked here first so a bad value is refused with a
 * readable message instead of a 422 after half of a write. One module for proposals (`changes-schema.ts`),
 * `jetlog import` and the other PUT paths (`putResourceChunked`), and file and batch names.
 *
 * The server refuses NUL (U+0000) and invalid UTF-8 in any string. It refuses control, bidi and zero-width
 * characters only in the code fields of a proposal; on the PUT paths it stores them, so the CLI removes them
 * from code fields (a BOM or a zero-width space in a file is common). Lengths are counted in characters
 * (graphemes), like the server does.
 */

/** The server's own message texts. */
export const MESSAGE_NUL = "must not contain the NUL character (U+0000)";
export const MESSAGE_UTF8 = "must be valid UTF-8 text";
export const MESSAGE_HIDDEN = "must not contain control, bidi or zero-width characters";

/** What `jetlog import` does with hidden characters in a code field. */
export const MESSAGE_REMOVED = "control, bidi and zero-width characters will be removed";

/** The hidden-character class exactly as the server has it. */
const HIDDEN_CHARACTERS = /[\x00-\x1F\x7F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;
const HIDDEN_CHARACTERS_ALL = new RegExp(HIDDEN_CHARACTERS.source, "g");
/** A UTF-16 surrogate without its partner: what a JS string holds where UTF-8 would be invalid. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export const DEFAULT_TEXT_LIMIT = 255;
export const SESSION_TYPE_LIMIT = 100;
export const ENTRY_AIRCRAFT_ICAO_LIMIT = 10;
export const REMARKS_LIMIT = 1000;
export const NOTES_LIMIT = 10000;
export const PROPOSAL_STRING_LIMIT = 2000;
export const SUMMARY_LIMIT = 500;
export const MAX_OPERATIONS = 200;
export const MAX_CREW = 20;

/** Code fields per resource, the ones a proposal refuses hidden characters in (the server's list). */
export const PROPOSAL_CODE_FIELDS: Record<string, readonly string[]> = {
  entry: ["flight_number", "registration", "from", "to"],
  person: ["employee_number", "default_role"],
  place: ["code", "icao", "iata"],
  aircraft: ["id", "aircraft_icao_code", "aircraft_iata_code", "system_aircraft_icao_code", "system_aircraft_iata_code"],
  fstd: ["id", "aircraft_icao_code", "system_aircraft_icao_code"]
};

/**
 * Code fields `jetlog import` cleans, per PUT resource. The proposal list plus the entry fields that carry
 * the same kind of code (a stripped fstd id must still match the entries that point at it).
 */
export const IMPORT_CODE_FIELDS: Record<string, readonly string[]> = {
  entries: ["flight_number", "registration", "from", "to", "actual_from", "actual_to", "fstd_id", "aircraft_icao_code"],
  people: PROPOSAL_CODE_FIELDS.person!,
  aircraft: PROPOSAL_CODE_FIELDS.aircraft!,
  fstd: PROPOSAL_CODE_FIELDS.fstd!
};

/** Why `value` cannot be stored, in the server's words, or undefined. */
export function textProblem(value: string): string | undefined {
  if (value.includes("\u0000")) return MESSAGE_NUL;
  if (LONE_SURROGATE.test(value)) return MESSAGE_UTF8;
  return undefined;
}

export function hasHiddenCharacters(value: string): boolean {
  return HIDDEN_CHARACTERS.test(value);
}

export function stripHiddenCharacters(value: string): string {
  return value.replace(HIDDEN_CHARACTERS_ALL, "");
}

let segmenter: Intl.Segmenter | undefined;

/** Length in characters as the server counts them (graphemes). UTF-16 length is the cheap upper bound. */
export function textLength(value: string): number {
  if (value.length <= 1) return value.length;
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let count = 0;
  for (const _ of segmenter.segment(value)) count++;
  return count;
}

export function exceedsLength(value: string, limit: number): boolean {
  return value.length > limit && textLength(value) > limit;
}

export function lengthMessage(limit: number): string {
  return `must be at most ${limit} characters`;
}

/** The first problem with a string anywhere inside `value` (strings, list items, object keys and values). */
export function nestedTextProblem(value: unknown): string | undefined {
  if (typeof value === "string") return textProblem(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const problem = nestedTextProblem(item);
      if (problem) return problem;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const problem = textProblem(key) ?? nestedTextProblem(item);
      if (problem) return problem;
    }
  }
  return undefined;
}

export interface FieldProblem {
  field: string;
  message: string;
}

/** A name sent to the server as text (batch label, attachment name, photo name): no NUL, at most 255 characters. */
export function nameProblem(value: string): string | undefined {
  return textProblem(value) ?? (exceedsLength(value, DEFAULT_TEXT_LIMIT) ? lengthMessage(DEFAULT_TEXT_LIMIT) : undefined);
}

/** Throws a readable error when `value` is not an acceptable name. `what` reads like "the batch label". */
export function assertName(value: string, what: string): void {
  const problem = nameProblem(value);
  if (problem) throw new Error(`${what} ${problem}.`);
}

/**
 * The problems with one operation's `data` in a proposal, per field, before anything is sent.
 * `op` is "create" | "update" | "delete"; `id` is the operation's own id.
 */
export function proposalOperationProblems(
  operation: { op: string; resource: string; id?: string; data?: Record<string, unknown> }
): FieldProblem[] {
  const problems: FieldProblem[] = [];
  const codes = PROPOSAL_CODE_FIELDS[operation.resource] ?? [];
  if (operation.id !== undefined) {
    const problem = textProblem(operation.id);
    if (problem) problems.push({ field: "id", message: problem });
    else if (operation.op === "create" && codes.includes("id") && hasHiddenCharacters(operation.id)) {
      problems.push({ field: "id", message: MESSAGE_HIDDEN });
    }
  }
  const data = operation.data;
  if (!data) return problems;

  for (const [field, value] of Object.entries(data)) {
    const nul = textProblem(field) ?? nestedTextProblem(value);
    if (nul) {
      problems.push({ field, message: nul });
      continue;
    }
    if (typeof value === "string") {
      if (codes.includes(field) && hasHiddenCharacters(value)) {
        problems.push({ field, message: MESSAGE_HIDDEN });
        continue;
      }
      const limit = operation.resource === "person" && field === "notes" ? NOTES_LIMIT : PROPOSAL_STRING_LIMIT;
      if (exceedsLength(value, limit)) problems.push({ field, message: lengthMessage(limit) });
    }
  }
  if (operation.resource === "entry" && Array.isArray(data.people) && data.people.length > MAX_CREW) {
    problems.push({ field: "people", message: `must have at most ${MAX_CREW} crew members` });
  }
  return problems;
}

/** The text limits of a PUT row, per top-level field. Everything else is 255. */
function putLimit(resource: string, field: string): number | undefined {
  if (field === "notes") return NOTES_LIMIT;
  // Token routes refuse a remark over 1000 characters (422) instead of cutting it. The signature is taken as is.
  if (field === "remarks") return REMARKS_LIMIT;
  if (field === "signature") return undefined;
  if (field === "session_type") return SESSION_TYPE_LIMIT;
  if (field === "aircraft_icao_code" && resource === "entries") return ENTRY_AIRCRAFT_ICAO_LIMIT;
  return DEFAULT_TEXT_LIMIT;
}

export interface PreparedRows {
  rows: Record<string, unknown>[];
  /** One line per problem: `<label>, <field>: <message>`. Nothing may be sent when this is not empty. */
  problems: string[];
  /** One line per code field that lost hidden characters: `<label>, <field>: <message>`. Not a problem, a heads-up. */
  removals: string[];
}

/**
 * Checks the rows of a `PUT /api/<resource>` call and cleans their code fields (control, bidi and zero-width
 * characters removed). NUL and invalid text, and values over the changeset limits, are problems, not cut.
 * `label(index)` names a row in the messages, e.g. "entries row 12".
 */
export function prepareWriteRows(
  resource: string,
  rows: Record<string, unknown>[],
  label: (index: number) => string = (i) => `${resource} row ${i + 1}`
): PreparedRows {
  const codes = IMPORT_CODE_FIELDS[resource] ?? [];
  const problems: string[] = [];
  const removals: string[] = [];
  const cleaned = rows.map((row, index) => {
    let out = row;
    for (const [field, value] of Object.entries(row)) {
      const nul = textProblem(field) ?? nestedTextProblem(value);
      if (nul) {
        problems.push(`${label(index)}, ${field}: ${nul}`);
        continue;
      }
      if (typeof value !== "string") continue;
      let text = value;
      if (codes.includes(field) && hasHiddenCharacters(text)) {
        text = stripHiddenCharacters(text);
        removals.push(`${label(index)}, ${field}: ${MESSAGE_REMOVED}`);
        if (out === row) out = { ...row };
        out[field] = text;
      }
      const limit = putLimit(resource, field);
      if (limit !== undefined && exceedsLength(text, limit)) problems.push(`${label(index)}, ${field}: ${lengthMessage(limit)}`);
    }
    return out;
  });
  return { rows: cleaned, problems, removals };
}

/** How many problem lines an error message lists before it summarises the rest. */
const MAX_LISTED_PROBLEMS = 20;

export function problemsError(intro: string, problems: string[]): Error {
  const shown = problems.slice(0, MAX_LISTED_PROBLEMS).map((p) => `  ${p}`);
  if (problems.length > shown.length) shown.push(`  and ${problems.length - shown.length} more`);
  return new Error(`${intro}\n${shown.join("\n")}\nNothing was sent.`);
}
