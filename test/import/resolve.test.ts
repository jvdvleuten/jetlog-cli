import { describe, expect, it } from "vitest";
import { buildWritePlan } from "../../src/import/resolve.js";
import { emptyImportResult, newImportedEntry, time, type ImportResult } from "../../src/import/model.js";
import type { RemoteEntry, RemoteMirror } from "../../src/import/remote-mirror.js";

function mirror(overrides: Partial<RemoteMirror> = {}): RemoteMirror {
  return { selfPersonId: "self-1", entries: [], people: [], aircraft: [], fstd: [], ...overrides };
}

describe("buildWritePlan", () => {
  it("resolves SELF to the logged-in user's own person id, ensuring that row exists (strict-mode writes need it)", () => {
    const result: ImportResult = {
      ...emptyImportResult(),
      people: [{ refId: "SELF", isExisting: { existing: false } }],
      entries: [newImportedEntry({ date: "2026-01-01", type: "flight", flightNumber: "KL1017", crew: [{ refId: "SELF", role: "PIC" }] })]
    };
    const plan = buildWritePlan(result, mirror());
    expect(plan.people).toEqual([{ fields: { id: "self-1", is_deleted: false }, isNew: true, displayName: "(you)" }]);
    expect(plan.entries[0]!.fields.people).toEqual([{ person_id: "self-1", role: "PIC", is_deleted: false }]);
  });

  it("doesn't re-ensure SELF when that person row already exists in the mirror", () => {
    const result: ImportResult = {
      ...emptyImportResult(),
      people: [{ refId: "SELF", isExisting: { existing: false } }],
      entries: [newImportedEntry({ date: "2026-01-01", type: "flight", flightNumber: "KL1017", crew: [{ refId: "SELF", role: "PIC" }] })]
    };
    const plan = buildWritePlan(result, mirror({ people: [{ id: "self-1", first_name: "Jo" }] }));
    expect(plan.people).toEqual([]);
  });

  it("creates a new person when no existing one matches", () => {
    const result: ImportResult = {
      ...emptyImportResult(),
      people: [{ refId: "p1", firstName: "Jane", lastName: "Doe", isExisting: { existing: false } }]
    };
    const plan = buildWritePlan(result, mirror());
    expect(plan.people).toHaveLength(1);
    expect(plan.people[0]!.isNew).toBe(true);
    expect(plan.people[0]!.fields.first_name).toBe("Jane");
  });

  it("matches an existing person by exact name instead of creating a duplicate", () => {
    const result: ImportResult = {
      ...emptyImportResult(),
      people: [{ refId: "p1", firstName: "Jane", lastName: "Doe", isExisting: { existing: false } }]
    };
    const plan = buildWritePlan(result, mirror({ people: [{ id: "existing-jane", first_name: "Jane", last_name: "Doe" }] }));
    expect(plan.people[0]!.isNew).toBe(false);
    expect(plan.people[0]!.fields.id).toBe("existing-jane");
  });

  it("marks an entry new when nothing matches, and merged when it does", () => {
    const newRow = newImportedEntry({ date: "2026-01-01", type: "flight", flightNumber: "KL1001" });
    const matchedRow = newImportedEntry({ date: "2026-01-02", type: "flight", flightNumber: "KL1002" });
    const result: ImportResult = { ...emptyImportResult(), entries: [newRow, matchedRow] };
    const plan = buildWritePlan(
      result,
      mirror({ entries: [{ id: "existing-kl1002", date: "2026-01-02", type: "flight", flight_number: "KL1002" }] })
    );
    const byFlightNumber = new Map(plan.entries.map((e) => [e.fields.flight_number, e]));
    expect(byFlightNumber.get("KL1001")!.isNew).toBe(true);
    expect(byFlightNumber.get("KL1002")!.isNew).toBe(false);
    expect(byFlightNumber.get("KL1002")!.fields.id).toBe("existing-kl1002");
  });

  it("skips rows flagged as in-file duplicates", () => {
    const row = newImportedEntry({ date: "2026-01-01", type: "flight", flightNumber: "KL1001", isDuplicateInFile: true });
    const result: ImportResult = { ...emptyImportResult(), entries: [row] };
    const plan = buildWritePlan(result, mirror());
    expect(plan.entries).toHaveLength(0);
    expect(plan.skippedDuplicateInFile).toBe(1);
  });

  it("skips an unmatched row that is already marked deleted", () => {
    const row = newImportedEntry({ date: "2026-01-01", type: "flight", flightNumber: "KL1001", isDeleted: true });
    const result: ImportResult = { ...emptyImportResult(), entries: [row] };
    const plan = buildWritePlan(result, mirror());
    expect(plan.entries).toHaveLength(0);
    expect(plan.skippedAlreadyDeletedUnmatched).toBe(1);
  });

  it("resolves a referenced FSTD id that doesn't exist yet", () => {
    const row = newImportedEntry({ date: "2026-01-01", type: "fstd", fstdId: "A320-SIM-1", fstdDeviceCategory: "ffs" });
    const result: ImportResult = { ...emptyImportResult(), entries: [row] };
    const plan = buildWritePlan(result, mirror());
    expect(plan.fstd).toEqual([{ fields: { id: "A320-SIM-1", is_deleted: false, device_category: "ffs", is_imported_from_other_logbook: true }, isNew: true }]);
  });

  it("never overrides an existing FSTD's own device category", () => {
    const row = newImportedEntry({ date: "2026-01-01", type: "fstd", fstdId: "A320-SIM-1", fstdDeviceCategory: "fnpt" });
    const result: ImportResult = { ...emptyImportResult(), entries: [row] };
    const plan = buildWritePlan(result, mirror({ fstd: [{ id: "A320-SIM-1", device_category: "ffs" }] }));
    expect(plan.fstd).toEqual([]);
  });
});

describe("buildWritePlan: unchanged-row skip", () => {
  it("marks a matched entry unchanged when the merge produces nothing new", () => {
    const existing = {
      id: "existing-1",
      date: "2026-01-01",
      type: "flight",
      flight_number: "KL1001",
      from: "EHAM",
      to: "LFPG",
      off_blocks: "10:00:00",
      update_flight_data: false,
      is_bulk: false,
      people: [{ person_id: "self-1", role: "PIC" }]
    };
    const row = newImportedEntry({
      date: "2026-01-01",
      type: "flight",
      flightNumber: "KL1001",
      from: "EHAM",
      to: "LFPG",
      updateFlightData: false,
      crew: [{ refId: "SELF", role: "PIC" }]
    });
    const result: ImportResult = { ...emptyImportResult(), entries: [row] };
    const plan = buildWritePlan(result, mirror({ entries: [existing] }));
    expect(plan.entries[0]!.unchanged).toBe(true);
  });

  it("does not mark an entry unchanged when a field actually differs", () => {
    const existing = {
      id: "existing-1",
      date: "2026-01-01",
      type: "flight",
      flight_number: "KL1001",
      from: "EHAM",
      to: "LFPG",
      update_flight_data: false,
      people: []
    };
    const row = newImportedEntry({ date: "2026-01-01", type: "flight", flightNumber: "KL1001", from: "EHAM", to: "EDDF", updateFlightData: false });
    const result: ImportResult = { ...emptyImportResult(), entries: [row] };
    const plan = buildWritePlan(result, mirror({ entries: [existing] }));
    expect(plan.entries[0]!.unchanged).toBe(false);
  });

  it("treats HH:MM:SS and HH:MM as equal for the same time", () => {
    const existing = {
      id: "existing-1",
      date: "2026-01-01",
      type: "flight",
      flight_number: "KL1001",
      update_flight_data: false,
      off_blocks: "10:00:00",
      people: []
    };
    const row = newImportedEntry({ date: "2026-01-01", type: "flight", flightNumber: "KL1001", offBlocks: time(600), updateFlightData: false });
    const result: ImportResult = { ...emptyImportResult(), entries: [row] };
    const plan = buildWritePlan(result, mirror({ entries: [existing] }));
    expect(plan.entries[0]!.unchanged).toBe(true);
  });

  it("a brand-new entry is never unchanged", () => {
    const row = newImportedEntry({ date: "2026-01-01", type: "flight", flightNumber: "KL1001" });
    const result: ImportResult = { ...emptyImportResult(), entries: [row] };
    const plan = buildWritePlan(result, mirror());
    expect(plan.entries[0]!.unchanged).toBe(false);
  });
});

describe("buildWritePlan: --as-new", () => {
  it("materializes a matched row as an independent new entry with a fresh id", () => {
    const existing = {
      id: "existing-1",
      date: "2026-01-01",
      type: "flight",
      flight_number: "KL1001",
      update_flight_data: true,
      people: []
    };
    const row = newImportedEntry({ date: "2026-01-01", type: "flight", flightNumber: "KL1001", registration: "PH-ABC" });
    const result: ImportResult = { ...emptyImportResult(), entries: [row] };
    const plan = buildWritePlan(result, mirror({ entries: [existing] }), { asNew: true });
    expect(plan.entries[0]!.isNew).toBe(true);
    expect(plan.entries[0]!.unchanged).toBe(false);
    expect(plan.entries[0]!.fields.id).not.toBe("existing-1");
    expect(plan.entries[0]!.fields.update_flight_data).toBe(false);
  });
});

describe("buildWritePlan: identical re-import against the server's wire shape", () => {
  const TIME_KEYS = new Set(["off_blocks", "airborne", "touchdown", "on_blocks", "start_time", "end_time", "scheduled_off_blocks"]);

  /** Shapes a written entry the way `GET /api/cli/v1/entries` (EntrySearchJSON) returns it:
   * times as HH:MM:SS, takeoffs_and_landings always with all seven keys (unused ones null),
   * absent columns as null, map keys in a different order, `approaches` an empty list. */
  function echoed(fields: Record<string, unknown>): RemoteEntry {
    const out: Record<string, unknown> = {
      registration: null,
      from: null,
      to: null,
      remarks: null,
      approaches: [],
      ifr: true,
      is_completed: false,
      updated_at: "2026-01-20T10:00:00Z",
      derived: {},
      calculated_times: null
    };
    for (const [key, value] of Object.entries(fields)) {
      if (key === "id" || key === "type" || key === "date") continue;
      if (TIME_KEYS.has(key) && typeof value === "string") out[key] = `${value}:00`;
      else if (key === "takeoffs_and_landings" && value) {
        out[key] = { type: null, takeoffs: null, landings: null, takeoffs_day: null, takeoffs_night: null, landings_day: null, landings_night: null, ...(value as object) };
      } else if (key === "manual_times" && value) {
        out[key] = Object.fromEntries(Object.entries(value as object).reverse());
      } else out[key] = value;
    }
    return { id: String(fields.id), type: String(fields.type), date: String(fields.date), ...out } as RemoteEntry;
  }

  function fullFlight() {
    return newImportedEntry({
      date: "2026-01-10",
      type: "flight",
      flightNumber: "KL1001",
      registration: "PH-ABC",
      from: "EHAM",
      to: "EGLL",
      offBlocks: time(840),
      airborne: time(848),
      touchdown: time(928),
      onBlocks: time(935),
      updateFlightData: false,
      remarks: "Routine flight",
      takeoffsAndLandings: { type: "manual", takeoffsDay: 1, takeoffsNight: 0, landingsDay: 1, landingsNight: 0 },
      manualTimes: { totalTimeOfFlight: time(95), pilotInCommand: time(95), night: time(10) },
      crew: [{ refId: "SELF", role: "PIC" }]
    });
  }

  function reimportPlan(rows: ReturnType<typeof newImportedEntry>[], tweak?: (e: RemoteEntry) => RemoteEntry) {
    const result: ImportResult = { ...emptyImportResult(), people: [{ refId: "SELF", isExisting: { existing: false } }], entries: rows };
    const first = buildWritePlan(result, mirror());
    const entries = first.entries.map((e) => echoed(e.fields)).map((e) => (tweak ? tweak(e) : e));
    // The server's own `people` rows carry the person_id the first run wrote.
    return buildWritePlan(result, mirror({ entries }));
  }

  it("reports an identical re-import (landings, manual times, HH:MM:SS) as fully unchanged", () => {
    const sim = newImportedEntry({
      date: "2026-01-12",
      type: "fstd",
      fstdId: "NL-249",
      startTime: time(540),
      endTime: time(720),
      updateFlightData: false,
      manualTimes: { fstdSession: time(180) },
      crew: [{ refId: "SELF", role: "FSTD_TRN" }]
    });
    const plan = reimportPlan([fullFlight(), sim]);
    expect(plan.entries.map((e) => [e.isNew, e.unchanged])).toEqual([
      [false, true],
      [false, true]
    ]);
  });

  it("still reports unchanged for a flight with no registration, route or role", () => {
    const sparse = newImportedEntry({
      date: "2026-01-13",
      type: "flight",
      flightNumber: "KL1004",
      offBlocks: time(600),
      touchdown: time(660),
      updateFlightData: false,
      takeoffsAndLandings: { type: "auto", takeoffs: 1, landings: 1 }
    });
    const plan = reimportPlan([sparse]);
    expect(plan.entries[0]!.unchanged).toBe(true);
  });

  it.each([
    ["landings", (e: RemoteEntry) => ({ ...e, takeoffs_and_landings: { ...(e.takeoffs_and_landings as object), landings_night: 2 } })],
    ["takeoffs", (e: RemoteEntry) => ({ ...e, takeoffs_and_landings: { ...(e.takeoffs_and_landings as object), takeoffs_day: 3 } })],
    ["manual times", (e: RemoteEntry) => ({ ...e, manual_times: { ...(e.manual_times as object), pilot_in_command: "0:30" } })],
    ["a time", (e: RemoteEntry) => ({ ...e, airborne: "14:09:00" })],
    ["remarks", (e: RemoteEntry) => ({ ...e, remarks: "Something else" })],
    ["registration", (e: RemoteEntry) => ({ ...e, registration: "PHXYZ" })],
    ["route", (e: RemoteEntry) => ({ ...e, to: "EGKK" })],
    ["crew role", (e: RemoteEntry) => ({ ...e, people: (e.people ?? []).map((p) => ({ ...p, role: "CP" })) })]
  ])("still detects a real change in %s", (_name, change) => {
    const plan = reimportPlan([fullFlight()], change);
    expect(plan.entries[0]!.isNew).toBe(false);
    expect(plan.entries[0]!.unchanged).toBe(false);
  });
});
