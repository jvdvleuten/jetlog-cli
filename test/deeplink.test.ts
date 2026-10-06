import { describe, expect, it } from "vitest";
import { buildImportLinks } from "../src/deeplink.js";
import { payloadSchema, type Payload } from "../src/schema.js";

function entry(i: number): Payload["entries"] extends (infer T)[] | null | undefined ? T : never {
  return {
    date: "2026-01-05",
    flight_number: `KL${1000 + i}`,
    people: [{ ref_id: `REF${i}`, role: "FO" }]
  } as never;
}

describe("buildImportLinks", () => {
  it("builds a single https link for a small payload", () => {
    const payload = payloadSchema.parse({
      entries: [{ date: "2026-01-05", flight_number: "KL1023" }],
      people: []
    });
    const links = buildImportLinks(payload);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatch(/^https:\/\/jetlog\.app\/import\?data=/);
  });

  it("builds a jetlog:// scheme link when requested", () => {
    const payload = payloadSchema.parse({ entries: [{ date: "2026-01-05", flight_number: "KL1" }], people: [] });
    const links = buildImportLinks(payload, { scheme: "jetlog" });
    expect(links[0]).toMatch(/^jetlog:\/\/import\?data=/);
  });

  it("splits into multiple links when over max-length, keeping people with their entry", () => {
    const people = Array.from({ length: 20 }, (_, i) => ({
      ref_id: `REF${i}`,
      first_name: `First${i}`,
      last_name: `Last${i}`
    }));
    const entries = Array.from({ length: 20 }, (_, i) => entry(i));
    const payload = payloadSchema.parse({ entries, people });

    const links = buildImportLinks(payload, { maxLength: 500 });
    expect(links.length).toBeGreaterThan(1);

    for (const link of links) {
      const encoded = link.split("?data=")[1]!;
      const decoded = JSON.parse(decodeURIComponent(encoded));
      const refIdsInEntries = new Set(
        decoded.entries.flatMap((e: { people?: { ref_id: string }[] }) => (e.people ?? []).map((p) => p.ref_id))
      );
      const refIdsInPeople = new Set(decoded.people.map((p: { ref_id: string }) => p.ref_id));
      for (const refId of refIdsInEntries) {
        expect(refIdsInPeople.has(refId)).toBe(true);
      }
    }

    const totalEntries = links.reduce((sum, link) => {
      const encoded = link.split("?data=")[1]!;
      const decoded = JSON.parse(decodeURIComponent(encoded));
      return sum + decoded.entries.length;
    }, 0);
    expect(totalEntries).toBe(20);
  });

  it("emits an empty-entries link for an empty payload", () => {
    const payload = payloadSchema.parse({ entries: [], people: [] });
    const links = buildImportLinks(payload);
    expect(links).toHaveLength(1);
  });
});
