/**
 * The condensed README rules an AI model needs to produce a valid
 * Jetlog payload from raw logbook text. Kept short on purpose: this
 * goes into every AI request alongside the JSON Schema.
 */
export const JETLOG_FORMAT_RULES = `
Jetlog import payload rules:
- Top level: { "entries": [...], "people": [...] }.
- Each entry needs "date" as YYYY-MM-DD. Everything else is optional.
- All times (scheduled_off_blocks, scheduled_on_blocks, off_blocks, airborne,
  touchdown, on_blocks) are "HH:MM" in zulu (UTC), relative to "date".
- Airports (from, to, actual_from, actual_to) should be ICAO codes when known;
  a recognised 3-letter IATA code is also accepted.
- registration is the aircraft tail number, e.g. "PH-BXD".
- people is a list of { ref_id, role }. Use ref_id "SELF" for the pilot
  filling in the logbook themselves instead of adding them to the top-level
  people list. Other crew need a matching entry in the top-level "people"
  list: { ref_id, first_name, last_name, default_role?, employee_number? }.
- takeoffs_and_landings is either { takeoffs, landings } or the day/night
  split { takeoffs_day, takeoffs_night, landings_day, landings_night }. Send
  whichever shape your source data provides, with both counts of that shape.
- approaches is a list of { type, count }, type one of: ils_cat1, ils_cat2,
  ils_cat3, gls, rnp, rnp_ar, loc, vor, ndb, visual, circling, par. count >= 1.
- go_arounds, passengers_on_board, fuel_planned, fuel_used are integers >= 0.
  fuel is always in kilograms.
- remarks is free text, max 1000 characters.
- Never invent data that isn't in the source. Leave a field out if you don't
  know it; do not guess times, registrations or routes.
- Only use null for a field when you intend to explicitly clear it on a
  re-import; otherwise omit fields you don't have data for. Never send "".
`.trim();

export function buildSystemPrompt(jsonSchema: unknown): string {
  return [
    "You convert raw pilot logbook data into Jetlog's JSON import format.",
    "Respond only with a payload matching the given JSON Schema.",
    JETLOG_FORMAT_RULES,
    "JSON Schema:",
    JSON.stringify(jsonSchema)
  ].join("\n\n");
}

export function buildRepairPrompt(errors: string[]): string {
  return [
    "The payload you produced failed validation with these errors:",
    errors.map((e) => `- ${e}`).join("\n"),
    "Return a corrected payload that fixes all of these issues, matching the same JSON Schema."
  ].join("\n\n");
}
