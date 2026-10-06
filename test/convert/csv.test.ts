import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { convertGenericCsv, normalizeDate, normalizeTime } from "../../src/convert/csv.js";
import { payloadSchema } from "../../src/schema.js";

const fixture = readFileSync(new URL("../fixtures/generic.csv", import.meta.url), "utf-8");

describe("normalizeDate", () => {
  it("passes through ISO dates", () => {
    expect(normalizeDate("2026-01-05")).toBe("2026-01-05");
  });
  it("parses DD-MM-YYYY by default (DMY heuristic for ambiguous last-year dates)", () => {
    expect(normalizeDate("05-01-2026")).toBe("2026-01-05");
  });
  it("parses DD/MM/YYYY", () => {
    expect(normalizeDate("05/01/2026")).toBe("2026-01-05");
  });
  it("respects --date-format MDY", () => {
    expect(normalizeDate("01/05/2026", "MDY")).toBe("2026-01-05");
  });
  it("returns null for garbage", () => {
    expect(normalizeDate("not a date")).toBeNull();
  });
});

describe("normalizeTime", () => {
  it("parses HH:MM", () => {
    expect(normalizeTime("14:08")).toBe("14:08");
  });
  it("parses HHMM", () => {
    expect(normalizeTime("1408")).toBe("14:08");
  });
  it("parses zulu-suffixed", () => {
    expect(normalizeTime("1408Z")).toBe("14:08");
  });
  it("returns null for garbage", () => {
    expect(normalizeTime("nope")).toBeNull();
  });
});

describe("convertGenericCsv", () => {
  it("converts the generic fixture into a valid payload", () => {
    const { payload, skipped } = convertGenericCsv(fixture);
    expect(skipped).toHaveLength(0);
    expect(payload.entries).toHaveLength(3);
    expect(payload.entries![0]).toMatchObject({
      date: "2026-01-05",
      flight_number: "KL1023",
      from: "EHAM",
      to: "EGLL",
      registration: "PHBXD",
      off_blocks: "14:00",
      airborne: "14:08",
      touchdown: "14:28",
      on_blocks: "14:55"
    });
    expect(payload.entries![1]!.remarks).toBe("Smooth landing");

    const parsed = payloadSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it("applies --self-role to every entry", () => {
    const { payload } = convertGenericCsv(fixture, { selfRole: "PIC" });
    for (const entry of payload.entries!) {
      expect(entry.people).toEqual([{ ref_id: "SELF", role: "PIC" }]);
    }
  });

  it("supports header overrides via --map", () => {
    const csv = "MyDate,MyFrom,MyTo\n2026-01-05,EHAM,EGLL\n";
    const { payload } = convertGenericCsv(csv, {
      map: { date: "MyDate", from: "MyFrom", to: "MyTo" }
    });
    expect(payload.entries![0]).toMatchObject({ date: "2026-01-05", from: "EHAM", to: "EGLL" });
  });

  it("skips rows with an unparsable date and reports why", () => {
    const csv = "Date,From\nnot-a-date,EHAM\n";
    const { payload, skipped } = convertGenericCsv(csv);
    expect(payload.entries).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toMatch(/unparsable date/);
  });

  it("skips rows with no date at all", () => {
    const csv = "From,To\nEHAM,EGLL\n";
    const { payload, skipped } = convertGenericCsv(csv);
    expect(payload.entries).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toMatch(/missing date/);
  });
});
