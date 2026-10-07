import { describe, expect, it } from "vitest";
import { materializeAsNewEntry, mergeImported, resolvedRemarks } from "../../src/import/merge.js";
import { newImportedEntry, time, type ImportedEntry } from "../../src/import/model.js";
import type { RemoteEntry } from "../../src/import/remote-mirror.js";

function flight(partial: Partial<ImportedEntry> = {}): ImportedEntry {
  return newImportedEntry({ date: "2026-01-01", type: "flight", ...partial });
}

describe("resolvedRemarks", () => {
  it("replaces by default", () => {
    expect(resolvedRemarks(flight({ remarks: "new note" }), "old note")).toBe("new note");
  });

  it("appends when remarksMergeMode is append and the text isn't already there", () => {
    const row = flight({ remarks: "diverted to EHRD", remarksMergeMode: "append" });
    expect(resolvedRemarks(row, "normal flight")).toBe("normal flight\ndiverted to EHRD");
  });

  it("doesn't stack the same text on a repeated import", () => {
    const row = flight({ remarks: "diverted to EHRD", remarksMergeMode: "append" });
    expect(resolvedRemarks(row, "normal flight\ndiverted to EHRD")).toBe("normal flight\ndiverted to EHRD");
  });
});

describe("mergeImported: new entry", () => {
  it("builds a fresh id and carries every provided field", () => {
    const row = flight({ flightNumber: "KL1017", registration: "PH-ABC", from: "EHAM", to: "LFPG", offBlocks: time(600), onBlocks: time(700) });
    const merged = mergeImported(row, undefined, false, new Map());
    expect(merged.isNew).toBe(true);
    expect(merged.fields.flight_number).toBe("KL1017");
    expect(merged.fields.registration).toBe("PH-ABC");
    expect(merged.fields.off_blocks).toBe("10:00");
    expect(merged.fields.is_deleted).toBe(false);
  });

  it("carries cargoOnBoard as cargo_on_board", () => {
    const merged = mergeImported(flight({ cargoOnBoard: 1200 }), undefined, false, new Map());
    expect(merged.fields.cargo_on_board).toBe(1200);
  });
});

describe("mergeImported: matched entry", () => {
  const existing: RemoteEntry = {
    id: "existing-1",
    date: "2026-01-01",
    type: "flight",
    flight_number: "KL1017",
    registration: "PH-ABC",
    from: "EHAM",
    to: "LFPG",
    off_blocks: "10:00:00",
    remarks: "normal flight",
    people: [{ person_id: "p1", role: "PIC" }]
  };

  it("plain-overwrites non-conservative fields", () => {
    const row = flight({ registration: "PH-XYZ", from: "EHAM", to: "EDDF" });
    const merged = mergeImported(row, existing, false, new Map());
    expect(merged.id).toBe("existing-1");
    expect(merged.isNew).toBe(false);
    expect(merged.fields.registration).toBe("PH-XYZ");
    expect(merged.fields.to).toBe("EDDF");
  });

  it("gap-fills only on a flight-number-normalization-only match, never overwrites", () => {
    const row = flight({ registration: "PH-XYZ" });
    const merged = mergeImported(row, existing, true, new Map());
    // Conservative: existing registration already set, so the imported value is dropped.
    expect(merged.fields.registration).toBe("PH-ABC");
  });

  it("gap-fills an empty field on a conservative match", () => {
    const row = flight({ registration: "PH-XYZ" });
    const { registration, ...rest } = existing;
    const merged = mergeImported(row, { ...rest, id: existing.id }, true, new Map());
    expect(merged.fields.registration).toBe("PH-XYZ");
  });

  it("resolves append-mode remarks onto the stored text", () => {
    const row = flight({ remarks: "diverted to EHRD", remarksMergeMode: "append" });
    const merged = mergeImported(row, existing, false, new Map());
    expect(merged.fields.remarks).toBe("normal flight\ndiverted to EHRD");
  });

  it("unions crew, overriding a role for a person already present", () => {
    const row = flight({ crew: [{ refId: "SELF", role: "CP" }] });
    const resolvedCrew = new Map([["SELF", "p1"]]);
    const merged = mergeImported(row, existing, false, resolvedCrew);
    expect(merged.crew).toEqual([{ personId: "p1", role: "CP" }]);
  });

  it("adds a new crew member alongside the existing one", () => {
    const row = flight({ crew: [{ refId: "SELF", role: "CP" }] });
    const resolvedCrew = new Map([["SELF", "p2"]]);
    const merged = mergeImported(row, existing, false, resolvedCrew);
    expect(merged.crew.sort((a, b) => a.personId.localeCompare(b.personId))).toEqual([
      { personId: "p1", role: "PIC" },
      { personId: "p2", role: "CP" }
    ]);
  });

  it("un-deletes unconditionally when isDeleted is not stated", () => {
    const row = flight({});
    const merged = mergeImported(row, { ...existing, is_deleted: true }, false, new Map());
    expect(merged.fields.is_deleted).toBe(false);
  });
});

describe("mergeImported: bulk conversion", () => {
  it("clears route/timeline and sets is_bulk + aircraft_icao_code", () => {
    const row = flight({ isBulk: true, aircraftIcaoCode: "B738", manualTimes: { totalTimeOfFlight: time(600) } });
    const merged = mergeImported(row, undefined, false, new Map());
    expect(merged.fields.is_bulk).toBe(true);
    expect(merged.fields.aircraft_icao_code).toBe("B738");
    expect(merged.fields.off_blocks).toBeNull();
    expect(merged.fields.manual_times).toEqual({ total_time_of_flight: "10:00" });
  });
});

describe("mergeImported: manual times authoritative overwrite", () => {
  const existing: RemoteEntry = {
    id: "existing-1",
    date: "2026-01-01",
    type: "flight",
    manual_times: { night: "0:30" }
  };

  it("wholesale-overwrites (even to null) when manualTimesAreAuthoritative and not conservative", () => {
    const row = flight({ manualTimesAreAuthoritative: true });
    const merged = mergeImported(row, existing, false, new Map());
    expect(merged.fields.manual_times).toBeNull();
  });

  it("gap-fills instead when the match is conservative", () => {
    const row = flight({ manualTimesAreAuthoritative: true });
    const merged = mergeImported(row, existing, true, new Map());
    expect(merged.fields.manual_times).toEqual({ night: "0:30" });
  });
});

describe("mergeImported: update_flight_data", () => {
  it("a brand-new row with no stated intent defaults to auto-tracked (true), not manual", () => {
    const row = flight({ flightNumber: "KL1001" });
    const merged = mergeImported(row, undefined, false, new Map());
    expect(merged.fields.update_flight_data).toBe(true);
  });

  it("a historical import (updateFlightData false, no non-intent flag) switches a new row to manual", () => {
    const row = flight({ flightNumber: "KL1001", offBlocks: time(600), updateFlightData: false });
    const merged = mergeImported(row, undefined, false, new Map());
    expect(merged.fields.update_flight_data).toBe(false);
    expect(merged.fields.off_blocks).toBe("10:00");
  });

  it("future-auto-track rule: a NEW, non-bulk, flight-numbered row dated today-or-later keeps auto-tracking", () => {
    const row = flight({
      date: "2026-06-01",
      flightNumber: "KL1001",
      updateFlightData: false,
      updateFlightDataIsNonIntentDefault: true
    });
    const merged = mergeImported(row, undefined, false, new Map(), "2026-01-01");
    expect(merged.fields.update_flight_data).toBe(true);
  });

  it("future-auto-track rule does not apply to a historical (past-dated) row", () => {
    const row = flight({
      date: "2025-01-01",
      flightNumber: "KL1001",
      updateFlightData: false,
      updateFlightDataIsNonIntentDefault: true
    });
    const merged = mergeImported(row, undefined, false, new Map(), "2026-01-01");
    expect(merged.fields.update_flight_data).toBe(false);
  });

  it("future-auto-track rule leaves an already-auto-tracked MATCHED future entry untouched", () => {
    const existing: RemoteEntry = {
      id: "existing-1",
      date: "2026-06-01",
      type: "flight",
      flight_number: "KL1001",
      update_flight_data: true
    };
    const row = flight({
      date: "2026-06-01",
      flightNumber: "KL1001",
      updateFlightData: false,
      updateFlightDataIsNonIntentDefault: true
    });
    const merged = mergeImported(row, existing, false, new Map(), "2026-01-01");
    expect(merged.fields.update_flight_data).toBe(true);
  });

  it("switching a matched auto-tracked entry to manual adopts the system times onto the manual columns", () => {
    const existing: RemoteEntry = {
      id: "existing-1",
      date: "2026-01-01",
      type: "flight",
      flight_number: "KL1001",
      from: "EHAM",
      to: "LFPG",
      update_flight_data: true,
      registration_system: "PH-XYZ",
      off_blocks_system: "10:05:00",
      airborne_system: "10:20:00",
      touchdown_system: "11:50:00",
      on_blocks_system: "12:00:00"
    };
    // A corrected re-import that now carries its own off/on blocks (e.g. a
    // LogTen export) switches the entry off auto-tracking.
    const row = flight({ flightNumber: "KL1001", offBlocks: time(600), updateFlightData: false });
    const merged = mergeImported(row, existing, false, new Map());
    expect(merged.fields.update_flight_data).toBe(false);
    // The imported off_blocks wins (it's the one field the row actually carries)...
    expect(merged.fields.off_blocks).toBe("10:00");
    // ...but the other three, which the row doesn't carry, are seeded from the system data.
    expect(merged.fields.airborne).toBe("10:20:00");
    expect(merged.fields.touchdown).toBe("11:50:00");
    expect(merged.fields.on_blocks).toBe("12:00:00");
    expect(merged.fields.registration).toBe("PH-XYZ");
  });

  it("adopts actual_from/actual_to only on a genuine diversion", () => {
    const existing: RemoteEntry = {
      id: "existing-1",
      date: "2026-01-01",
      type: "flight",
      flight_number: "KL1001",
      from: "EHAM",
      to: "LFPG",
      update_flight_data: true,
      system_from: "EHRD",
      system_to: "LFPG"
    };
    const row = flight({ flightNumber: "KL1001", offBlocks: time(600), updateFlightData: false });
    const merged = mergeImported(row, existing, false, new Map());
    // system_from (EHRD) differs from the planned from (EHAM) -> diversion adopted.
    expect(merged.fields.actual_from).toBe("EHRD");
    // system_to (LFPG) equals the planned to -> no diversion, actual_to stays unset.
    expect(merged.fields.actual_to).toBeUndefined();
  });

  it("switching to manual is a no-op when the entry is already manual", () => {
    const existing: RemoteEntry = {
      id: "existing-1",
      date: "2026-01-01",
      type: "flight",
      flight_number: "KL1001",
      update_flight_data: false,
      registration: "PH-ABC",
      registration_system: "PH-SYSTEM-SHOULD-NOT-WIN"
    };
    const row = flight({ flightNumber: "KL1001", updateFlightData: false });
    const merged = mergeImported(row, existing, false, new Map());
    expect(merged.fields.registration).toBe("PH-ABC");
  });
});

describe("materializeAsNewEntry", () => {
  it("never reuses the matched entry's id", () => {
    const existing: RemoteEntry = { id: "existing-1", date: "2026-01-01", type: "flight", flight_number: "KL1001", update_flight_data: true };
    const row = flight({ flightNumber: "KL1001", registration: "PH-ABC" });
    const merged = materializeAsNewEntry(row, existing, false, new Map());
    expect(merged.id).not.toBe("existing-1");
    expect(merged.fields.id).toBe(merged.id);
    expect(merged.isNew).toBe(true);
  });

  it("forces manual flight data, adopting system times first when still auto-tracked", () => {
    const existing: RemoteEntry = {
      id: "existing-1",
      date: "2026-01-01",
      type: "flight",
      flight_number: "KL1001",
      update_flight_data: true,
      off_blocks_system: "10:05:00",
      airborne_system: "10:20:00"
    };
    const row = flight({ flightNumber: "KL1001" });
    const merged = materializeAsNewEntry(row, existing, false, new Map());
    expect(merged.fields.update_flight_data).toBe(false);
    expect(merged.fields.off_blocks).toBe("10:05:00");
    expect(merged.fields.airborne).toBe("10:20:00");
  });

  it("forces is_deleted false even when the matched row carried a deletion intent", () => {
    const existing: RemoteEntry = { id: "existing-1", date: "2026-01-01", type: "flight", flight_number: "KL1001", update_flight_data: false };
    const row = flight({ flightNumber: "KL1001", isDeleted: true });
    const merged = materializeAsNewEntry(row, existing, false, new Map());
    expect(merged.fields.is_deleted).toBe(false);
  });

  it("keeps everything else mergeImported would have resolved (route, remarks)", () => {
    const existing: RemoteEntry = {
      id: "existing-1",
      date: "2026-01-01",
      type: "flight",
      flight_number: "KL1001",
      from: "EHAM",
      to: "LFPG",
      update_flight_data: false,
      remarks: "normal flight"
    };
    const row = flight({ flightNumber: "KL1001", remarks: "diverted", remarksMergeMode: "append" });
    const merged = materializeAsNewEntry(row, existing, false, new Map());
    expect(merged.fields.from).toBe("EHAM");
    expect(merged.fields.to).toBe("LFPG");
    expect(merged.fields.remarks).toBe("normal flight\ndiverted");
  });
});
