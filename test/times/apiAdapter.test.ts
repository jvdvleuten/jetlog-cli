import { describe, it, expect } from "vitest";
import { apiEntryToCalcEntry, parseDurationMinutes } from "../../src/times/apiAdapter.js";
import { buildApiAircraftLookup } from "../../src/times/apiAircraft.js";

describe("parseDurationMinutes (Time.parseDurationMinutes parity)", () => {
  it("parses H:MM with any hour length", () => {
    expect(parseDurationMinutes("1:30")).toBe(90);
    expect(parseDurationMinutes("20000:30")).toBe(1_200_030);
  });

  it("accepts 2+ parts (only the first two count) and trims Z", () => {
    expect(parseDurationMinutes("1:30:45")).toBe(90);
    expect(parseDurationMinutes("Z1:30Z")).toBe(90);
  });

  it("treats malformed values as absent", () => {
    expect(parseDurationMinutes("1:75")).toBeUndefined();
    expect(parseDurationMinutes("-1:30")).toBeUndefined();
    expect(parseDurationMinutes("130")).toBeUndefined();
    expect(parseDurationMinutes("a:30")).toBeUndefined();
    expect(parseDurationMinutes("")).toBeUndefined();
  });
});

describe("apiEntryToCalcEntry parity", () => {
  const base = { type: "flight", date: "2026-01-01", derived: {} };

  it("passes is_multi_pilot through and lets it win over a legacy multi_pilot value", () => {
    const r = apiEntryToCalcEntry(
      { ...base, people: [{ person_id: 1, role: "PIC" }], manual_times: { is_multi_pilot: false, multi_pilot: "1:00" } },
      1
    );
    expect(r?.calcEntry.manualTimes?.isMultiPilot).toBe(false);
  });

  it("takes a legacy boolean under multi_pilot as the state, not as minutes", () => {
    const r = apiEntryToCalcEntry({ ...base, people: [{ person_id: 1, role: "PIC" }], manual_times: { multi_pilot: true } }, 1);
    expect(r?.calcEntry.manualTimes?.isMultiPilot).toBe(true);
    expect(r?.calcEntry.manualTimes?.multiPilot).toBeUndefined();
  });

  it("keeps a legacy H:MM multi_pilot as minutes", () => {
    const r = apiEntryToCalcEntry({ ...base, people: [{ person_id: 1, role: "PIC" }], manual_times: { multi_pilot: "1:30" } }, 1);
    expect(r?.calcEntry.manualTimes?.multiPilot).toBe(90);
    expect(r?.calcEntry.manualTimes?.isMultiPilot).toBeUndefined();
  });

  it("resolves the self role to the lowest-ranked live row (Entry.derivedPeople order)", () => {
    const r = apiEntryToCalcEntry(
      {
        ...base,
        people: [
          { person_id: 1, role: "CP" },
          { person_id: 1, role: "PIC", is_deleted: true },
          { person_id: 1, role: "RI_CP" },
          { person_id: 2, role: "PIC" }
        ]
      },
      1
    );
    expect(r?.selfRole).toBe("routeInstructorCoPilot");
  });

  it("returns undefined when only deleted rows match self", () => {
    expect(apiEntryToCalcEntry({ ...base, people: [{ person_id: 1, role: "PIC", is_deleted: true }] }, 1)).toBeUndefined();
  });

  it("keeps an FSTD entry with no live self row (selfRole undefined), like iOS and the backend", () => {
    const r = apiEntryToCalcEntry({ type: "fstd", date: "2026-01-01", derived: {}, start_time: "09:00", end_time: "11:00", people: [] }, 1);
    expect(r).toBeDefined();
    expect(r!.selfRole).toBeUndefined();
    expect(r!.calcEntry.type).toBe("fstd");
    // An FSTD whose only self row is deleted behaves the same.
    expect(apiEntryToCalcEntry({ type: "fstd", date: "2026-01-01", derived: {}, people: [{ person_id: 1, role: "FSTD_TRN", is_deleted: true }] }, 1)?.selfRole).toBeUndefined();
  });
});

describe("tracked entries log the block as IFR (backend/iOS: updateFlightData || ifr)", () => {
  const base = { type: "flight", date: "2026-01-01", derived: {}, people: [{ person_id: 1, role: "PIC" }] };

  it("ifr false stays false for an untracked entry", () => {
    expect(apiEntryToCalcEntry({ ...base, ifr: false, update_flight_data: false }, 1)?.calcEntry.ifr).toBe(false);
  });

  it("ifr false becomes true when the entry is tracked", () => {
    expect(apiEntryToCalcEntry({ ...base, ifr: false, update_flight_data: true }, 1)?.calcEntry.ifr).toBe(true);
  });
});

describe("buildApiAircraftLookup keeps registrations and ICAO type codes apart", () => {
  const client = {
    get: async (path: string) =>
      path === "/api/cli/v1/aircraft"
        ? {
            aircraft: [
              { id: "MD11", use_system: true, aircraft_icao_code: null, system_aircraft_icao_code: null },
              { id: "PHBXA", use_system: true, aircraft_icao_code: null, system_aircraft_icao_code: "B738" }
            ]
          }
        : { system_aircraft_types: [{ icao_code: "MD11", engine_count: 3, easa_certification: "MP" }, { icao_code: "B738", engine_count: 2, easa_certification: "MP" }], sync_cursor: null }
  };

  it("a registration whose aircraft row has no ICAO code is not read as a type code", async () => {
    const l = await buildApiAircraftLookup(client as never);
    expect(l.lookupAircraftType("MD11")).toBeUndefined();
    expect(l.lookupAircraftType("UNKNOWN")).toBeUndefined();
    expect(l.lookupAircraftType("PHBXA")?.engineCount).toBe(2);
  });

  it("bulk entries resolve their ICAO type code directly", async () => {
    const l = await buildApiAircraftLookup(client as never);
    expect(l.lookupAircraftTypeByIcao("MD11")?.engineCount).toBe(3);
  });
});
