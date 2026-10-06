/**
 * Table-driven tests for `roleCodes.ts`'s two alias decoders, pinned
 * directly against the Jetlog iOS app's role decoders:
 *
 * - `mapApiRoleCode` mirrors the app's Codable role decoder, used for the logged-in read
 *   API (`apiAdapter.ts`) and the public JSON import payload
 *   (`adapter.ts`).
 * - `mapImportedRoleCode` mirrors the app's raw-string role parser, used for `ImportedEntry.role`
 *   (`importedEntryAdapter.ts`).
 *
 * The two tables deliberately diverge (see `roleCodes.ts`'s header
 * comment): parser 1 is case-sensitive except for a narrow
 * captain/first_officer fallback and has cabin-crew aliases; parser 2
 * upper-cases everything first, has a wider instructor/examiner/student
 * alias set, but no cabin-crew aliases at all.
 */
import { describe, it, expect } from "vitest";
import { mapApiRoleCode, mapImportedRoleCode, WIRE_ROLE_TO_CALC_ROLE } from "../../src/times/roleCodes.js";
import { apiEntryToCalcEntry } from "../../src/times/apiAdapter.js";
import { importedEntryToCalcEntry } from "../../src/times/importedEntryAdapter.js";
import { newImportedEntry } from "../../src/import/model.js";
import type { EntryPersonRole } from "../../src/import/model.js";
import type { EntryPersonRoleName } from "../../src/times/types.js";

// ---------------------------------------------------------------------------
// Canonical wire codes: both parsers must agree with WIRE_ROLE_TO_CALC_ROLE
// ---------------------------------------------------------------------------

// Parser 2 (`fromRawString`) has no cabin-crew cases at all
// (it never matches "CA"/"CS"/"Purser"/"SP"),
// those canonical codes correctly fall through to "unknown" there, unlike
// parser 1. See `roleCodes.ts`'s header comment.
const NO_IMPORTED_ALIAS: ReadonlySet<string> = new Set(["CA", "CS", "Purser", "SP"]);

describe("mapApiRoleCode / mapImportedRoleCode: canonical wire codes", () => {
  for (const [wireCode, calcRole] of Object.entries(WIRE_ROLE_TO_CALC_ROLE)) {
    it(`"${wireCode}" -> "${calcRole}" (mapApiRoleCode)`, () => {
      expect(mapApiRoleCode(wireCode)).toBe(calcRole);
    });

    if (NO_IMPORTED_ALIAS.has(wireCode)) {
      it(`"${wireCode}" -> "unknown" (mapImportedRoleCode has no cabin-crew cases)`, () => {
        expect(mapImportedRoleCode(wireCode)).toBe("unknown");
      });
    } else {
      it(`"${wireCode}" -> "${calcRole}" (mapImportedRoleCode)`, () => {
        expect(mapImportedRoleCode(wireCode)).toBe(calcRole);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Parser 1 (the app's Codable role decoder)
// ---------------------------------------------------------------------------

describe("mapApiRoleCode: aliases the iOS app accepts when decoding", () => {
  const cases: Array<[string, EntryPersonRoleName]> = [
    ["FO", "coPilot"],
    ["Co-Pilot", "coPilot"],
    ["CA1/2", "cabinAttendant"],
    ["CA2/3", "cabinAttendant"],
    ["Cabin Crew", "cabinAttendant"],
    // Fallback branch: lowercased + spaces -> underscores.
    ["captain", "pilotInCommand"],
    ["CAPTAIN", "pilotInCommand"],
    ["Captain", "pilotInCommand"],
    ["first_officer", "coPilot"],
    ["FIRST_OFFICER", "coPilot"],
    ["first officer", "coPilot"],
    ["First Officer", "coPilot"]
  ];

  for (const [input, expected] of cases) {
    it(`"${input}" -> "${expected}"`, () => {
      expect(mapApiRoleCode(input)).toBe(expected);
    });
  }

  it("junk and unrecognized values -> unknown", () => {
    expect(mapApiRoleCode(" (FO)")).toBe("unknown");
    expect(mapApiRoleCode("")).toBe("unknown");
    // Case-sensitive exact match: lowercase "fo" isn't "FO" and isn't
    // caught by the fallback (only captain/first_officer are).
    expect(mapApiRoleCode("fo")).toBe("unknown");
    expect(mapApiRoleCode("co-pilot")).toBe("unknown");
    expect(mapApiRoleCode("totally-made-up")).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Parser 2 (the app's raw-string role parser)
// ---------------------------------------------------------------------------

describe("mapImportedRoleCode: aliases the iOS app accepts for raw role strings", () => {
  const cases: Array<[string, EntryPersonRoleName]> = [
    ["CPT", "pilotInCommand"],
    ["CAPTAIN", "pilotInCommand"],
    ["captain", "pilotInCommand"], // whole string is upper-cased first
    ["FO", "coPilot"],
    ["fo", "coPilot"],
    ["FIRST_OFFICER", "coPilot"],
    ["first officer", "coPilot"], // space folded to underscore after upper-casing
    ["SO", "cruiseReliefCoPilot"],
    ["INSTRUCTOR", "flightInstructor"],
    ["instructor", "flightInstructor"],
    ["EXAMINER", "flightExaminer"],
    ["STUDENT", "student"],
    ["DHD", "deadHead"],
    ["DEADHEAD", "deadHead"],
    ["TRAINEE", "fstdTrainee"]
  ];

  for (const [input, expected] of cases) {
    it(`"${input}" -> "${expected}"`, () => {
      expect(mapImportedRoleCode(input)).toBe(expected);
    });
  }

  it("has no cabin-crew aliases at all, unlike mapApiRoleCode", () => {
    expect(mapImportedRoleCode("CA1/2")).toBe("unknown");
    expect(mapImportedRoleCode("Cabin Crew")).toBe("unknown");
    expect(mapImportedRoleCode("Co-Pilot")).toBe("unknown"); // hyphen survives the space-fold, no "CO-PILOT" case
  });

  it("junk and unrecognized values -> unknown", () => {
    expect(mapImportedRoleCode(" (FO)")).toBe("unknown");
    expect(mapImportedRoleCode("")).toBe("unknown");
    expect(mapImportedRoleCode("totally-made-up")).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Golden-corpus-style regression: re-feeding every canonical wire code
// through the full apiAdapter.ts / importedEntryAdapter.ts adapters (not
// just the bare mapper functions) must still yield exactly the canonical
// EntryPersonRoleName: the new alias handling must not perturb the
// already-correct canonical path.
// ---------------------------------------------------------------------------

describe("golden-corpus-style regression: canonical wire codes through the real adapters", () => {
  for (const [wireCode, calcRole] of Object.entries(WIRE_ROLE_TO_CALC_ROLE)) {
    it(`apiEntryToCalcEntry: "${wireCode}" -> "${calcRole}"`, () => {
      const entry: Record<string, unknown> = {
        date: "2026-01-01",
        type: "flight",
        people: [{ person_id: "self-1", role: wireCode }]
      };
      const result = apiEntryToCalcEntry(entry, "self-1");
      expect(result).toBeDefined();
      expect(result!.selfRole).toBe(calcRole);
    });

    // Cabin-crew wire codes have no alias in parser 2 (raw-string parser) at
    // all, so importedEntryToCalcEntry correctly resolves them to
    // "unknown", matching mapImportedRoleCode's behavior above, not a
    // regression.
    const expectedImportedRole = NO_IMPORTED_ALIAS.has(wireCode) ? "unknown" : calcRole;
    it(`importedEntryToCalcEntry: "${wireCode}" -> "${expectedImportedRole}"`, () => {
      const entry = newImportedEntry({
        date: "2026-01-01",
        type: "flight",
        crew: [{ refId: "SELF", role: wireCode as EntryPersonRole }]
      });
      const result = importedEntryToCalcEntry(entry);
      expect(result).toBeDefined();
      expect(result!.selfRole).toBe(expectedImportedRole);
    });
  }
});
