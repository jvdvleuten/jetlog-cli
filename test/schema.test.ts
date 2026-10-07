import { describe, expect, it } from "vitest";
import { checkModeRequirements, payloadSchema, validatePayload } from "../src/schema.js";

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
