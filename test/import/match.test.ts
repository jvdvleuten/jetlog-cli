import { describe, expect, it } from "vitest";
import { matchExistingAircraft, matchExistingEntry, matchExistingFSTDEntry, normalizeFlightNumber, PersonMatcher } from "../../src/import/match.js";
import type { RemoteMirror } from "../../src/import/remote-mirror.js";
import { time } from "../../src/import/model.js";

function mirror(overrides: Partial<RemoteMirror> = {}): RemoteMirror {
  return { selfPersonId: "self-1", entries: [], people: [], aircraft: [], fstd: [], ...overrides };
}

describe("normalizeFlightNumber", () => {
  it("upcases and strips internal whitespace", () => {
    expect(normalizeFlightNumber("kl 1017")).toBe("KL1017");
    expect(normalizeFlightNumber(undefined)).toBeUndefined();
    expect(normalizeFlightNumber("  ")).toBeUndefined();
  });
});

describe("matchExistingEntry", () => {
  const base = { id: "e1", date: "2026-01-01", type: "flight", flight_number: "KL1017", registration: "PH-ABC", from: "EHAM", to: "LFPG" };

  it("matches by date + flight number", () => {
    const m = matchExistingEntry(mirror({ entries: [base] }), { date: "2026-01-01", flightNumber: "KL1017" });
    expect(m?.entry.id).toBe("e1");
    expect(m?.matchedViaFlightNumberNormalization).toBe(false);
  });

  it("flags normalization-only matches (raw string differs from normalized)", () => {
    const m = matchExistingEntry(mirror({ entries: [base] }), { date: "2026-01-01", flightNumber: "kl 1017" });
    expect(m?.entry.id).toBe("e1");
    expect(m?.matchedViaFlightNumberNormalization).toBe(true);
  });

  it("falls back to registration when no flight number is given", () => {
    const m = matchExistingEntry(mirror({ entries: [base] }), { date: "2026-01-01", registration: "ph-abc" });
    expect(m?.entry.id).toBe("e1");
  });

  it("disambiguates multiple same-day/flight-number candidates by origin", () => {
    const other = { ...base, id: "e2", from: "EDDF", to: "EHAM" };
    const m = matchExistingEntry(mirror({ entries: [base, other] }), { date: "2026-01-01", flightNumber: "KL1017", from: "EDDF" });
    expect(m?.entry.id).toBe("e2");
  });

  it("returns undefined with neither flight number nor registration", () => {
    expect(matchExistingEntry(mirror({ entries: [base] }), { date: "2026-01-01" })).toBeUndefined();
  });

  it("returns undefined when nothing matches that date", () => {
    expect(matchExistingEntry(mirror({ entries: [base] }), { date: "2026-02-01", flightNumber: "KL1017" })).toBeUndefined();
  });
});

describe("matchExistingFSTDEntry", () => {
  const session = { id: "f1", date: "2026-01-01", type: "fstd", fstd_id: "A320-SIM-1", start_time: "09:00:00" };

  it("matches by date + fstd id + start time", () => {
    const m = matchExistingFSTDEntry(mirror({ entries: [session] }), { date: "2026-01-01", fstdId: "A320-SIM-1", startTime: time(9 * 60) });
    expect(m?.id).toBe("f1");
  });

  it("falls back to the same-day session when the fstd id doesn't match", () => {
    const m = matchExistingFSTDEntry(mirror({ entries: [session] }), { date: "2026-01-01", fstdId: "other-device" });
    expect(m?.id).toBe("f1");
  });

  it("returns undefined for a day with no fstd sessions", () => {
    expect(matchExistingFSTDEntry(mirror({ entries: [session] }), { date: "2026-01-02", fstdId: "A320-SIM-1" })).toBeUndefined();
  });
});

describe("matchExistingAircraft", () => {
  it("matches by registration id", () => {
    const m = matchExistingAircraft(mirror({ aircraft: [{ id: "PH-ABC" }] }), "PH-ABC");
    expect(m?.id).toBe("PH-ABC");
  });

  it("returns undefined with no registration", () => {
    expect(matchExistingAircraft(mirror({ aircraft: [{ id: "PH-ABC" }] }), undefined)).toBeUndefined();
  });
});

describe("PersonMatcher", () => {
  const people = [
    { id: "p1", first_name: "John", last_name: "Smith", employee_number: "EMP-001" },
    { id: "p2", first_name: "Jane", last_name: "Doe" }
  ];

  it("matches by employee number, ignoring punctuation/case", () => {
    const matcher = new PersonMatcher(people);
    expect(matcher.match({ employeeNumber: "emp001" })?.id).toBe("p1");
  });

  it("matches by exact normalized name", () => {
    const matcher = new PersonMatcher(people);
    expect(matcher.match({ firstName: "jane", lastName: "doe" })?.id).toBe("p2");
  });

  it("fuzzy-matches a single close candidate", () => {
    const matcher = new PersonMatcher(people);
    expect(matcher.matchByName("Jon Smith")?.id).toBe("p1");
  });

  it("refuses to guess when two names are equally close", () => {
    const matcher = new PersonMatcher([...people, { id: "p3", first_name: "Jan", last_name: "Smith" }]);
    expect(matcher.matchByName("Jon Smith")).toBeUndefined();
  });

  it("returns undefined for an unknown person", () => {
    const matcher = new PersonMatcher(people);
    expect(matcher.match({ firstName: "Nobody", lastName: "Here" })).toBeUndefined();
  });
});
