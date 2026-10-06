import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { convertForeflight } from "../../src/convert/presets.js";
import { payloadSchema } from "../../src/schema.js";

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf-8");
}

describe("convertForeflight", () => {
  it("extracts only the Flights Table section", () => {
    const { payload, skipped } = convertForeflight(fixture("foreflight.csv"));
    expect(skipped).toHaveLength(0);
    expect(payload.entries).toHaveLength(2);
    expect(payload.entries![0]).toMatchObject({
      date: "2026-02-01",
      from: "EHAM",
      to: "EGLL",
      flight_number: "KL1023",
      registration: "PHBXD"
    });
    expect(payloadSchema.safeParse(payload).success).toBe(true);
  });
});

// The old best-effort `convertLogten`/`convertMccPilotLog` generic-CSV
// presets (and their `logten.csv`/`mccpilotlog.csv` fixtures) were removed
// once the real ported importers landed, see `src/convert/presets.ts`'s
// comment. Real-format coverage now lives in `test/import/logten.test.ts`
// and `test/import/pilotlog.test.ts`; `--from logten`/`--from pilotlog`
// CLI wiring is covered in `test/convert/index.test.ts`.
