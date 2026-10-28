import { describe, expect, it } from "vitest";
import { deepLinkJSONImporter } from "../../src/import/importers/deeplink-json.js";
import { emptyImportResult, normalizedPersonNotes } from "../../src/import/model.js";
import { importResultToPayload } from "../../src/import/to-payload.js";
import { validatePayload } from "../../src/schema.js";

describe("person notes through the import model", () => {
  it("the Jetlog JSON importer carries notes and the payload keeps them", async () => {
    const json = JSON.stringify({
      entries: [],
      people: [{ ref_id: "p1", first_name: "Jan", last_name: "Jansen", notes: "  prefers the left seat " }]
    });
    const result = await deepLinkJSONImporter.parse(json);
    expect(result.people.find((p) => p.refId === "p1")?.notes).toBe("prefers the left seat");
    const { payload } = importResultToPayload(result);
    expect(payload.people?.[0]?.notes).toBe("prefers the left seat");
    expect(validatePayload(payload).valid).toBe(true);
  });

  it("leaves empty notes out and cuts long notes to the server limit", () => {
    expect(normalizedPersonNotes("  ")).toBeUndefined();
    expect(normalizedPersonNotes(null)).toBeUndefined();
    expect(normalizedPersonNotes("x".repeat(10001))).toHaveLength(10000);
    const result = {
      ...emptyImportResult(),
      people: [{ refId: "p1", firstName: "Jan", lastName: "Jansen", notes: "x".repeat(10001), isExisting: { existing: false as const } }]
    };
    expect(validatePayload(importResultToPayload(result).payload).valid).toBe(true);
  });
});
