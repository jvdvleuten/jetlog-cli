import { describe, expect, it } from "vitest";
import { getJsonSchema } from "../src/json-schema.js";
import { checkModeRequirements, payloadSchema, placeDataSchema, validatePayload } from "../src/schema.js";

describe("payloadSchema", () => {
  it("accepts a minimal valid payload", () => {
    const result = validatePayload({
      entries: [{ date: "2026-01-05", flight_number: "KL1023", from: "EHAM", to: "EGLL" }],
      people: []
    });
    expect(result.valid).toBe(true);
    expect(result.payload?.entries?.[0]?.type).toBe("flight");
  });

  it("defaults entries/people to [] when null", () => {
    const result = validatePayload({ entries: null, people: null });
    expect(result.valid).toBe(true);
    expect(result.payload).toEqual({ entries: [], people: [] });
  });

  it("rejects a bad date format", () => {
    const result = validatePayload({ entries: [{ date: "01-03-2026" }], people: [] });
    expect(result.valid).toBe(false);
    expect(result.structuralErrors.length).toBeGreaterThan(0);
  });

  it("rejects a bad time format", () => {
    const result = validatePayload({
      entries: [{ date: "2026-01-05", off_blocks: "2:5" }],
      people: []
    });
    expect(result.valid).toBe(false);
  });

  it("accepts explicit null on clearable fields", () => {
    const result = validatePayload({
      entries: [
        {
          date: "2026-01-05",
          flight_number: "KL1023",
          registration: null,
          off_blocks: null,
          takeoffs_and_landings: null,
          approaches: null
        }
      ],
      people: []
    });
    expect(result.valid).toBe(true);
  });

  it("accepts cargo_on_board as a non-negative integer or null, rejects negatives", () => {
    const ok = (v: unknown) =>
      validatePayload({ entries: [{ date: "2026-01-05", cargo_on_board: v }], people: [] }).valid;
    expect(ok(1200)).toBe(true);
    expect(ok(null)).toBe(true);
    expect(ok(-1)).toBe(false);
    expect(ok(1.5)).toBe(false);
  });

  it("rejects remarks over 1000 characters", () => {
    const result = validatePayload({
      entries: [{ date: "2026-01-05", remarks: "a".repeat(1001) }],
      people: []
    });
    expect(result.valid).toBe(false);
  });

  it("accepts the day/night takeoffs_and_landings shape", () => {
    const result = validatePayload({
      entries: [
        {
          date: "2026-01-05",
          takeoffs_and_landings: { takeoffs_day: 1, takeoffs_night: 0, landings_day: 1, landings_night: 0 }
        }
      ],
      people: []
    });
    expect(result.valid).toBe(true);
  });

  it("rejects an unknown approach type", () => {
    const parsed = payloadSchema.safeParse({
      entries: [{ date: "2026-01-05", approaches: [{ type: "made_up", count: 1 }] }],
      people: []
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts SELF as a ref_id without a matching people entry", () => {
    const result = validatePayload({
      entries: [{ date: "2026-01-05", people: [{ ref_id: "SELF", role: "PIC" }] }],
      people: []
    });
    expect(result.valid).toBe(true);
  });
});

describe("checkModeRequirements", () => {
  it("requires flight_number or registration for deeplink mode", () => {
    const payload = payloadSchema.parse({ entries: [{ date: "2026-01-05" }], people: [] });
    const issues = checkModeRequirements(payload, "deeplink");
    expect(issues).toHaveLength(1);
  });

  it("passes deeplink mode with just a registration", () => {
    const payload = payloadSchema.parse({
      entries: [{ date: "2026-01-05", registration: "PHBXD" }],
      people: []
    });
    expect(checkModeRequirements(payload, "deeplink")).toHaveLength(0);
  });

  it("requires from and to for api mode", () => {
    const payload = payloadSchema.parse({
      entries: [{ date: "2026-01-05", flight_number: "KL1023" }],
      people: []
    });
    const issues = checkModeRequirements(payload, "api");
    expect(issues).toHaveLength(1);
  });

  it("passes api mode with from and to", () => {
    const payload = payloadSchema.parse({
      entries: [{ date: "2026-01-05", from: "EHAM", to: "EGLL" }],
      people: []
    });
    expect(checkModeRequirements(payload, "api")).toHaveLength(0);
  });
});

describe("person notes", () => {
  const person = { ref_id: "p1", first_name: "Jan", last_name: "Jansen" };

  it("accepts notes, an empty string and null (clears)", () => {
    for (const notes of ["prefers the left seat", "", null]) {
      const result = validatePayload({ people: [{ ...person, notes }] });
      expect(result.valid).toBe(true);
      expect(result.payload?.people?.[0]?.notes).toBe(notes);
    }
  });

  it("rejects notes over 10000 characters", () => {
    expect(validatePayload({ people: [{ ...person, notes: "x".repeat(10000) }] }).valid).toBe(true);
    expect(validatePayload({ people: [{ ...person, notes: "x".repeat(10001) }] }).valid).toBe(false);
  });

  it("keeps the JSON Schema derivable with a notes string", () => {
    expect(JSON.stringify(getJsonSchema())).toContain('"notes":{"anyOf":[{"type":"string","maxLength":10000},{"type":"null"}]}');
  });
});

describe("placeDataSchema", () => {
  it("accepts every place field the backend allows, nulls included", () => {
    const full = {
      code: "EHAM",
      icao: "EHAM",
      iata: "AMS",
      name: "Schiphol",
      latitude: 52.3086,
      longitude: 4.7639,
      country_code: " nl ",
      timezone: "Europe/Amsterdam",
      kind: "airport",
      is_deleted: false
    };
    expect(placeDataSchema.safeParse(full).success).toBe(true);
    expect(placeDataSchema.safeParse({ icao: null, iata: null, name: null, latitude: null, longitude: null, country_code: null, timezone: null }).success).toBe(true);
    expect(placeDataSchema.safeParse({}).success).toBe(true);
    // The server stores a blank country code as null, so blank clears it like null does.
    expect(placeDataSchema.safeParse({ country_code: "" }).success).toBe(true);
    expect(placeDataSchema.safeParse({ country_code: "  " }).success).toBe(true);
  });

  it("is strict about keys and checks types and ranges", () => {
    for (const bad of [
      { id: "pl-1" },
      { timestamp: "2026-01-01T00:00:00Z" },
      { latitude: "52.3" },
      { latitude: -90.1 },
      { longitude: 180.1 },
      { country_code: "N" },
      { kind: null },
      { kind: "seaplane_base" },
      { is_deleted: null },
      { name: 3 }
    ]) {
      expect(placeDataSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("is not part of the import payload", () => {
    expect(payloadSchema.safeParse({ places: [] }).success).toBe(false);
  });
});

describe("text rules of the import", () => {
  const entry = (extra: Record<string, unknown>) => ({ entries: [{ date: "2026-01-01", ...extra }] });

  it("reports NUL and over-long values the import would refuse, by row and field", () => {
    const result = validatePayload({
      entries: [
        { date: "2026-01-01", flight_number: "KL1" },
        { date: "2026-01-02", flight_number: "KL\u0000" },
        { date: "2026-01-03", registration: "R".repeat(256) }
      ]
    });
    expect(result.valid).toBe(true);
    expect(result.textErrors).toEqual([
      "entries[1], flight_number: must not contain the NUL character (U+0000)",
      "entries[2], registration: must be at most 255 characters"
    ]);
  });

  it("reports a lone surrogate and checks people too", () => {
    const result = validatePayload({
      people: [{ ref_id: "p1", first_name: "A\ud800", last_name: "B" }]
    });
    expect(result.textErrors).toEqual(["people[0], first_name: must be valid UTF-8 text"]);
  });

  it("says hidden characters in a code will be removed, without making it an error", () => {
    const result = validatePayload(entry({ flight_number: "\uFEFFKL1", remarks: "a\u200Bb" }));
    expect(result.textErrors).toEqual([]);
    expect(result.textNotes).toEqual(["entries[0], flight_number: control, bidi and zero-width characters will be removed"]);
  });

  it("has nothing to report for clean text", () => {
    const result = validatePayload(entry({ flight_number: "KL1", remarks: "fine" }));
    expect(result.textErrors).toEqual([]);
    expect(result.textNotes).toEqual([]);
  });
});
