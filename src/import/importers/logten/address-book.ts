/**
 * Ported from the Jetlog iOS app's LogTen address book importer.
 *
 * LogTen's "Address Book" export is a separate TXT file (same tab-separated
 * shape as the Flights export, different header schema) listing LogTen's
 * crew directory, `Name`/`Full Name`/`ID`/`Comment`/`This is Me` columns.
 * Cross-referencing it lets an import resolve fuller names/employee numbers
 * for crew that the Flights export only ever names by its own `refId`
 * (whatever LogTen calls that row's selected-crew value).
 *
 * Not ported: stored-user and existing-person lookups (no
 * local store offline, see `model.ts`'s file doc comment). "This is Me" and
 * employee-number-based DB matching therefore always fall through to
 * producing a brand-new `ImportedPerson`, same as every other importer here.
 */
import type { ImportedPerson, ImportError } from "../../model.js";
import { getValue, parseRow, splitIntoProperLines } from "./tsv.js";

export type LogTenTextFileKind = "flights" | "addressBook" | "unknown";

/** Sniffs which of
 * LogTen's two TXT export shapes `content` is, by header row alone. */
export function detectLogTenTextFileKind(content: string): LogTenTextFileKind {
  const headerRow = splitIntoProperLines(content)[0];
  if (headerRow === undefined) return "unknown";
  const headers = parseRow(headerRow);
  if (headers.includes("flight_flightDate") && headers.includes("flight_type")) return "flights";
  if (headers.includes("Name") && headers.includes("Full Name") && headers.includes("Default Capacity")) return "addressBook";
  return "unknown";
}

function value(header: string, headers: string[], columns: string[]): string | undefined {
  const v = getValue(header, columns, headers);
  const trimmed = v?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function normalizeName(name: string): { first?: string; last?: string } {
  const compact = name
    .replace(/,/g, " ")
    .split(" ")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const first = compact[0];
  if (first === undefined) return {};
  const last = compact.slice(1).join(" ");
  return { first, last: last.length > 0 ? last : undefined };
}

function extractEmployeeNumber(id: string | undefined, comment: string | undefined): string | undefined {
  if (id && id.length > 0 && id.toLowerCase() !== "self") return id;
  if (!comment || comment.length === 0) return undefined;
  const digits = comment.replace(/\D/g, "");
  return digits.length > 0 ? digits : undefined;
}

export interface LogTenAddressBookResult {
  people: ImportedPerson[];
  importErrors: ImportError[];
}

/**
 * Parses a LogTen Address Book TXT export into `ImportedPerson`s, `refId`
 * seeded with the export's own `Name` (or `Full Name`) column, the same
 * value the Flights export's `flight_selectedCrew*` columns carry, so
 * `mergeLogTenPeople` can line the two up by that key.
 */
export function parseLogTenAddressBook(content: string): LogTenAddressBookResult {
  const rows = splitIntoProperLines(content);
  const headerRow = rows[0];
  if (headerRow === undefined) {
    return { people: [], importErrors: [{ reason: "Address Book export is empty" }] };
  }

  const headers = parseRow(headerRow);
  if (headers.length === 0) {
    return { people: [], importErrors: [{ reason: "Address Book headers are missing" }] };
  }

  const peopleByRefId = new Map<string, ImportedPerson>();
  const importErrors: ImportError[] = [];

  rows.slice(1).forEach((row, rowIndex) => {
    const columns = parseRow(row);
    if (columns.length !== headers.length) {
      importErrors.push({ reason: "Address Book row has invalid column count", rowNumber: rowIndex + 1 });
      return;
    }

    const name = value("Name", headers, columns) ?? value("Full Name", headers, columns);
    if (!name) return;

    const id = value("ID", headers, columns);
    const employeeNumber = extractEmployeeNumber(id, value("Comment", headers, columns));
    const { first: firstName, last: lastName } = normalizeName(name);

    const person: ImportedPerson = {
      refId: name,
      firstName,
      lastName,
      employeeNumber,
      isExisting: { existing: false },
      isImportedFromOtherLogbook: true
    };
    peopleByRefId.set(name, person);
  });

  return { people: [...peopleByRefId.values()], importErrors };
}

/**
 * Merges Address Book people onto a base people set (from the Flights
 * export), filling in blanks on an already-present `refId` rather than
 * overwriting anything the Flights export itself provided.
 */
export function mergeLogTenPeople(base: ImportedPerson[], addressBookPeople: ImportedPerson[]): ImportedPerson[] {
  const mergedByRefId = new Map<string, ImportedPerson>(base.map((p) => [p.refId, p]));

  for (const addressPerson of addressBookPeople) {
    const existing = mergedByRefId.get(addressPerson.refId);
    if (!existing) {
      mergedByRefId.set(addressPerson.refId, addressPerson);
      continue;
    }

    const merged: ImportedPerson = {
      ...existing,
      firstName: existing.firstName && existing.firstName.length > 0 ? existing.firstName : addressPerson.firstName ?? existing.firstName,
      lastName: existing.lastName && existing.lastName.length > 0 ? existing.lastName : addressPerson.lastName ?? existing.lastName,
      employeeNumber:
        existing.employeeNumber && existing.employeeNumber.length > 0
          ? existing.employeeNumber
          : addressPerson.employeeNumber ?? existing.employeeNumber,
      defaultRole: existing.defaultRole ?? addressPerson.defaultRole,
      isImportedFromOtherLogbook: existing.isImportedFromOtherLogbook ?? addressPerson.isImportedFromOtherLogbook
    };
    if (addressPerson.isExisting.existing) merged.isExisting = addressPerson.isExisting;
    mergedByRefId.set(addressPerson.refId, merged);
  }

  return [...mergedByRefId.values()];
}
