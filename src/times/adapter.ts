/**
 * CLI wiring: converts a public-payload `Entry` (`src/schema.ts`) into the
 * calculator's `CalcEntry` + the context fields the calculator needs
 * (`selfRole`, `activeCrewCount`).
 *
 * The public payload (documented in JetlogAPI/README.md, mirrored by
 * `src/schema.ts`) is intentionally smaller than the iOS app's full `Entry`
 * model, see this file's "Known limitations" cross-references into
 * `docs/TIMES.md` for each gap this adapter papers over.
 */
import type { Entry as SchemaEntry } from "../schema.js";
import { mapApiRoleCode, ACTIVE_CREW_ROLES, WIRE_ROLE_TO_CALC_ROLE } from "./roleCodes.js";
import type { CalcEntry, CalcPerson, EntryPersonRoleName } from "./types.js";

/** Re-exported for backward compatibility, the canonical table now lives in
 * `./roleCodes.js` and is shared by the payload adapter, the `ImportedEntry`
 * adapter, and the logged-in API adapter. */
export const PAYLOAD_ROLE_TO_CALC_ROLE = WIRE_ROLE_TO_CALC_ROLE;

/** The public JSON import payload is the iOS app's "JSON imports"
 * case, same alias decoder as the logged-in read API (`apiAdapter.ts`),
 * see `roleCodes.ts`'s header comment for the two-parser split. */
function mapRole(wireRole: string): ReturnType<typeof mapApiRoleCode> {
  return mapApiRoleCode(wireRole);
}

export function payloadEntryToCalcEntry(
  entry: SchemaEntry
): { calcEntry: CalcEntry; selfRole: EntryPersonRoleName; activeCrewCount: number } | undefined {
  const people = entry.people ?? [];
  const selfPerson = people.find((p) => p.ref_id === "SELF");
  if (!selfPerson) return undefined;

  const calcPeople: CalcPerson[] = people.map((p) => ({ personId: p.ref_id, role: mapRole(p.role) }));
  const selfRole = mapRole(selfPerson.role);
  const activeCrewCount = calcPeople.filter((p) => ACTIVE_CREW_ROLES.has(p.role)).length;

  const type = entry.type ?? "flight";

  // The public payload has no FSTD-specific start/end time fields, best
  // effort: reuse off_blocks/on_blocks as startTime/endTime for FSTD-type
  // entries when present. See docs/TIMES.md "Known limitations".
  const startTime = type === "fstd" ? entry.off_blocks ?? undefined : undefined;
  const endTime = type === "fstd" ? entry.on_blocks ?? undefined : undefined;

  const calcEntry: CalcEntry = {
    date: entry.date,
    type,
    from: entry.from ?? undefined,
    to: entry.to ?? undefined,
    offBlocks: entry.off_blocks ?? undefined,
    onBlocks: entry.on_blocks ?? undefined,
    airborne: entry.airborne ?? undefined,
    touchdown: entry.touchdown ?? undefined,
    registration: entry.registration ?? undefined,
    actualFrom: entry.actual_from ?? undefined,
    actualTo: entry.actual_to ?? undefined,
    updateFlightData: entry.update_flight_data ?? false,
    // The iOS `Entry` decode default when absent, the
    // public payload has no slot for this field at all.
    ifr: true,
    isImportedFromOtherLogbook: false,
    isBulk: false,
    startTime,
    endTime,
    people: calcPeople
  };

  return { calcEntry, selfRole, activeCrewCount };
}
