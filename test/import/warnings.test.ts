import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { formatNotices, importNotices, terminalNoticeLines } from "../../src/import/warnings.js";
import { emptyImportResult, newImportedEntry, type ImportResult } from "../../src/import/model.js";
import { getImporter } from "../../src/import/registry.js";
import { buildWritePlan } from "../../src/import/resolve.js";

const PILOTLOG = new URL("../fixtures/ios/pilotlog/mcc-classic.csv", import.meta.url);

describe("importNotices / formatNotices", () => {
  it("groups several warnings of one row on one line with row number and flight identity", () => {
    const entry = newImportedEntry({ date: "2026-01-13", type: "flight", flightNumber: "KL1004", sourceRow: 5 });
    const result: ImportResult = {
      ...emptyImportResult(),
      entries: [entry],
      importErrors: [
        { code: "registrationMissing", reason: "Registration missing", entryId: entry.id },
        { code: "originAirportMissing", reason: "Origin airport missing", entryId: entry.id },
        { code: "roleMissingFlight", reason: "You have no role set on this flight", entryId: entry.id }
      ]
    };
    const lines = formatNotices(importNotices(result));
    expect(lines).toEqual([
      { kind: "warning", text: "row 5 (2026-01-13 KL1004): Registration missing; Origin airport missing; You have no role set on this flight" }
    ]);
  });

  it("includes the route when the entry has one and omits the row when the importer does not know it", () => {
    const entry = newImportedEntry({ date: "2026-01-13", type: "flight", flightNumber: "KL1004", from: "EHAM", to: "EGLL" });
    const result: ImportResult = {
      ...emptyImportResult(),
      entries: [entry],
      importErrors: [{ code: "registrationMissing", reason: "Registration missing", entryId: entry.id }]
    };
    expect(terminalNoticeLines(importNotices(result))).toEqual(["warning: 2026-01-13 KL1004 EHAM-EGLL: Registration missing"]);
  });

  it("reports a dropped row as skipped, and keeps file-level notes as plain warnings", () => {
    const result: ImportResult = {
      ...emptyImportResult(),
      importErrors: [{ reason: "Could not parse date", rowNumber: 3 }],
      notes: ['Treating "Jane Doe" as you.']
    };
    expect(terminalNoticeLines(importNotices(result))).toEqual(["skipped row 3: Could not parse date", 'warning: Treating "Jane Doe" as you.']);
  });

  it("collapses identical notices for the same row", () => {
    const entry = newImportedEntry({ date: "2026-01-13", type: "flight", flightNumber: "KL1004", sourceRow: 5 });
    const err = { code: "registrationMissing" as const, reason: "Registration missing", entryId: entry.id };
    const result: ImportResult = { ...emptyImportResult(), entries: [entry], importErrors: [err, err] };
    expect(importNotices(result)).toHaveLength(1);
  });
});

describe("pilotlog fixture", () => {
  it("labels every row warning with its file line, names the duplicate rows once, and no longer talks about selecting rows", async () => {
    const result = await getImporter("pilotlog")!.parse(readFileSync(PILOTLOG), { filename: "mcc-classic.csv" });
    const lines = terminalNoticeLines(importNotices(result));
    expect(lines).toContain("warning: row 5 (2026-01-13 KL1004): Registration missing; Origin airport missing; Destination airport missing");
    expect(lines.filter((l) => /listed 2×/.test(l))).toHaveLength(1);
    expect(lines.join("\n")).toMatch(/\(rows 2, 6\)/);
    expect(lines.join("\n")).not.toMatch(/select the other row/);
    // The duplicate warning also reaches the write plan; the CLI prints it from the notices only.
    const plan = buildWritePlan(result, { selfPersonId: "s", entries: [], people: [], aircraft: [], fstd: [] });
    expect(plan.warnings.filter((w) => /listed 2×/.test(w))).toHaveLength(1);
  });
});
