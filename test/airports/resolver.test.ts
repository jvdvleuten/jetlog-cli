import { describe, expect, it } from "vitest";
import { buildAirportIndex, canonical, equivalentCodes, normalize, resolve, type CatalogRow, type UserPlace } from "../../src/airports/resolver.js";

let nextId = 0;
function row(over: Partial<CatalogRow>): CatalogRow {
  nextId += 1;
  return { id: `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`, isDeleted: false, ...over };
}
function place(over: Partial<UserPlace>): UserPlace {
  nextId += 1;
  return { id: `00000000-0000-4000-9000-${String(nextId).padStart(12, "0")}`, isDeleted: false, ...over };
}

const EHAM = row({ icao: "EHAM", iata: "AMS", lat: 52.3086, lon: 4.7639, timezone: "Europe/Amsterdam", name: "Amsterdam Schiphol", countryCode: "NL" });
const EGLL = row({ icao: "EGLL", iata: "LHR", lat: 51.47, lon: -0.4543, timezone: "Europe/London", name: "London Heathrow" });

describe("normalize", () => {
  it("trims Unicode White_Space and uppercases", () => {
    expect(normalize(" eham ")).toBe("EHAM");
    expect(normalize(" ams\n")).toBe("AMS");
    expect(normalize("　egll ")).toBe("EGLL");
  });

  it("keeps inner whitespace", () => {
    expect(normalize("EH AM")).toBe("EH AM");
  });

  it("does not strip U+FEFF (JS trim() would, other runtimes do not)", () => {
    expect(normalize("﻿EHAM")).toBe("﻿EHAM");
    expect(normalize("EHAM﻿")).toBe("EHAM﻿");
  });

  it("returns null for null, undefined, empty and whitespace-only input", () => {
    for (const blank of [null, undefined, "", "   ", "\t\n"]) expect(normalize(blank)).toBeNull();
  });

  it("uses the full case mapping", () => {
    expect(normalize("straße")).toBe("STRASSE");
  });
});

describe("canonical and resolve", () => {
  const index = buildAirportIndex([EHAM, EGLL]);

  it("canonicalizes an IATA alias, lowercase and padded code to the ICAO", () => {
    for (const code of ["AMS", "ams", " eham ", "EHAM", "\tAms\n"]) expect(canonical(index, code)).toBe("EHAM");
  });

  it("resolves the same airport through every spelling", () => {
    const a = resolve(index, "AMS");
    expect(a).toEqual(resolve(index, "eham"));
    expect(a).toMatchObject({ identity: "EHAM", hasPosition: true, lat: 52.3086, lon: 4.7639, timezone: "Europe/Amsterdam", countryCode: "NL", isIataOnly: false });
  });

  it("keeps an unknown code as its own identity and resolves it to null", () => {
    expect(canonical(index, "zzzz")).toBe("ZZZZ");
    expect(resolve(index, "ZZZZ")).toBeNull();
  });

  it("returns null for blank codes", () => {
    expect(canonical(index, "  ")).toBeNull();
    expect(resolve(index, null)).toBeNull();
    expect(resolve(index, undefined)).toBeNull();
  });

  it("ignores deleted catalog rows", () => {
    const idx = buildAirportIndex([row({ icao: "ZZZC", lat: 1, lon: 1, isDeleted: true })]);
    expect(resolve(idx, "ZZZC")).toBeNull();
  });

  it("treats a row with one axis (or none) as having no position, never (0, 0)", () => {
    const idx = buildAirportIndex([row({ icao: "ZZZA" }), row({ icao: "ZZZB", lat: 50 })]);
    for (const code of ["ZZZA", "ZZZB"]) {
      expect(resolve(idx, code)).toMatchObject({ identity: code, hasPosition: false, lat: null, lon: null });
    }
  });

  it("keeps a real (0, 0) position", () => {
    const idx = buildAirportIndex([row({ icao: "ZZZD", lat: 0, lon: 0 })]);
    expect(resolve(idx, "ZZZD")).toMatchObject({ hasPosition: true, lat: 0, lon: 0 });
  });
});

describe("catalog preference", () => {
  it("lets the higher version win a contested IATA between two icao rows (LIM -> SPJC)", () => {
    const idx = buildAirportIndex([
      row({ icao: "SPIM", iata: "LIM", version: 4586, lat: -12.0219, lon: -77.1143 }),
      row({ icao: "SPJC", iata: "LIM", version: 4587, lat: -12.03, lon: -77.11 })
    ]);
    expect(canonical(idx, "LIM")).toBe("SPJC");
    expect(canonical(idx, "SPIM")).toBe("SPIM"); // the closed airport still resolves to itself
    expect(resolve(idx, "SPIM")).not.toBeNull();
  });

  it("lets an icao-ful row win a contested IATA regardless of version", () => {
    const idx = buildAirportIndex([
      row({ icao: "KAAA", iata: "QQA", version: 1, lat: 10, lon: 10 }),
      row({ iata: "QQA", version: 9, lat: 20, lon: 20 })
    ]);
    expect(canonical(idx, "QQA")).toBe("KAAA");
    expect(resolve(idx, "QQA")).toMatchObject({ lat: 10, lon: 10 });
  });

  it("resolves an iata-only row to its IATA, flagged is_iata_only", () => {
    const idx = buildAirportIndex([row({ iata: "QQB", lat: 5, lon: 6, name: "Seaplane base" })]);
    expect(canonical(idx, "qqb")).toBe("QQB");
    expect(resolve(idx, "QQB")).toMatchObject({ identity: "QQB", isIataOnly: true, lat: 5, lon: 6 });
  });

  it("breaks version ties by updated_at, then by id", () => {
    const older = row({ id: "A", icao: "EDDB", version: 1, updatedAt: "2024-01-01T00:00:00.000000Z", lat: 1, lon: 1 });
    const newer = row({ id: "B", icao: "EDDB", version: 1, updatedAt: "2024-02-01T00:00:00.000000Z", lat: 2, lon: 2 });
    expect(resolve(buildAirportIndex([newer, older]), "EDDB")?.lat).toBe(2);
    expect(resolve(buildAirportIndex([older, newer]), "EDDB")?.lat).toBe(2);

    const a = row({ id: "aaaa", icao: "EDDC", lat: 1, lon: 1 });
    const b = row({ id: "bbbb", icao: "EDDC", lat: 2, lon: 2 });
    expect(resolve(buildAirportIndex([b, a]), "EDDC")?.lat).toBe(2);
    // A null version ranks below any real version.
    const versioned = row({ icao: "EDDD", version: 0, lat: 3, lon: 3 });
    const unversioned = row({ icao: "EDDD", version: null, updatedAt: "2099-01-01T00:00:00.000000Z", lat: 4, lon: 4 });
    expect(resolve(buildAirportIndex([unversioned, versioned]), "EDDD")?.lat).toBe(3);
  });
});

describe("local codes", () => {
  it("resolves a local-code-only row at the lowest catalog tier", () => {
    const idx = buildAirportIndex([row({ localCode: "L52", lat: 1, lon: 2 })]);
    expect(canonical(idx, "l52")).toBe("L52");
    expect(resolve(idx, "L52")).toMatchObject({ identity: "L52", lat: 1, lon: 2 });
  });

  it("canonicalizes a local code on an icao row to the ICAO", () => {
    const idx = buildAirportIndex([row({ icao: "KDDD", localCode: "DD1", lat: 1, lon: 2 })]);
    expect(canonical(idx, "DD1")).toBe("KDDD");
    expect(resolve(idx, "DD1")?.identity).toBe("KDDD");
  });

  it("lets an IATA beat a colliding local code (FAA LID collision)", () => {
    const idx = buildAirportIndex([row({ icao: "KBBB", iata: "QQL", lat: 1, lon: 1 }), row({ localCode: "QQL", lat: 2, lon: 2 })]);
    expect(canonical(idx, "QQL")).toBe("KBBB");
    expect(resolve(idx, "QQL")).toMatchObject({ lat: 1, lon: 1 });
  });

  it("lets an ICAO beat a colliding local code", () => {
    const idx = buildAirportIndex([row({ icao: "KCCC", lat: 1, lon: 1 }), row({ localCode: "KCCC", lat: 2, lon: 2 })]);
    expect(resolve(idx, "KCCC")).toMatchObject({ lat: 1, lon: 1 });
  });
});

describe("user places", () => {
  const catalog = [EHAM, EGLL];

  it("wins over the catalog position for its own code", () => {
    const idx = buildAirportIndex(catalog, [place({ code: "EHAM", lat: 10, lon: 10 })]);
    expect(resolve(idx, "EHAM")).toMatchObject({ identity: "EHAM", lat: 10, lon: 10 });
    expect(resolve(idx, "AMS")).toMatchObject({ identity: "EHAM", lat: 10, lon: 10 });
  });

  it("claims the IATA slot and inherits the catalog position (MYF / AMS)", () => {
    const idx = buildAirportIndex(catalog, [place({ code: "MYF", iata: "AMS" })]);
    expect(canonical(idx, "MYF")).toBe("AMS");
    expect(canonical(idx, "AMS")).toBe("AMS");
    expect(resolve(idx, "MYF")).toMatchObject({ identity: "AMS", lat: 52.3086, lon: 4.7639, timezone: "Europe/Amsterdam" });
  });

  it("resolves a custom code with its own coordinates, and one without to no position", () => {
    const idx = buildAirportIndex(catalog, [place({ code: "ZZ01", lat: 48, lon: 2 }), place({ code: "ZZ02" }), place({ code: "ZZ03", lat: 52 })]);
    expect(resolve(idx, "ZZ01")).toMatchObject({ identity: "ZZ01", hasPosition: true, lat: 48, lon: 2 });
    expect(resolve(idx, "ZZ02")).toMatchObject({ identity: "ZZ02", hasPosition: false, lat: null });
    expect(resolve(idx, "ZZ03")).toMatchObject({ hasPosition: false, lat: null, lon: null });
  });

  it("merges field by field: one user axis, the other from the catalog", () => {
    const idx = buildAirportIndex(catalog, [place({ code: "EHAM", lat: 52 })]);
    expect(resolve(idx, "EHAM")).toMatchObject({ lat: 52, lon: 4.7639 });
  });

  it("never inherits from a half-filled catalog row", () => {
    const idx = buildAirportIndex([row({ icao: "ZZZB", lat: 50 })], [place({ code: "ZZZB" })]);
    expect(resolve(idx, "ZZZB")).toMatchObject({ hasPosition: false, lat: null, lon: null });
  });

  it("inherits name, time zone and country, but a non-blank user name wins", () => {
    const inherits = resolve(buildAirportIndex(catalog, [place({ code: "EHAM" })]), "EHAM");
    expect(inherits).toMatchObject({ name: "Amsterdam Schiphol", timezone: "Europe/Amsterdam", countryCode: "NL" });
    const own = resolve(buildAirportIndex(catalog, [place({ code: "EHAM", name: "  Home  ", timezone: "UTC" })]), "EHAM");
    expect(own).toMatchObject({ name: "Home", timezone: "UTC" });
    const blankName = resolve(buildAirportIndex(catalog, [place({ code: "EHAM", name: "   " })]), "EHAM");
    expect(blankName?.name).toBe("Amsterdam Schiphol");
  });

  it("normalizes place slots", () => {
    const idx = buildAirportIndex(catalog, [place({ code: " eham ", lat: 60, lon: 10 })]);
    expect(resolve(idx, "EHAM")).toMatchObject({ lat: 60, lon: 10 });
  });

  it("ignores a deleted place", () => {
    const idx = buildAirportIndex(catalog, [place({ code: "EHAM", lat: 60, lon: 10, isDeleted: true })]);
    expect(resolve(idx, "EHAM")).toMatchObject({ lat: 52.3086, lon: 4.7639 });
  });

  it("prefers the newer of two places claiming a code", () => {
    const idx = buildAirportIndex(catalog, [place({ code: "EHAM", version: 2, lat: 61, lon: 11 }), place({ code: "EHAM", version: 1, lat: 60, lon: 10 })]);
    expect(resolve(idx, "EHAM")).toMatchObject({ lat: 61, lon: 11 });
  });

  it("resolves a slot to the identity owner (XYZ -> EHAM owned by the newer place)", () => {
    const idx = buildAirportIndex(catalog, [
      place({ code: "XYZ", icao: "EHAM", version: 1, lat: 60, lon: 10 }),
      place({ icao: "EHAM", version: 2, lat: 61, lon: 11 })
    ]);
    expect(canonical(idx, "XYZ")).toBe("EHAM");
    expect(resolve(idx, "XYZ")).toMatchObject({ identity: "EHAM", lat: 61, lon: 11 });
  });
});

describe("equivalentCodes", () => {
  it("lists every spelling that canonicalizes to the same identity", () => {
    const idx = buildAirportIndex([EHAM, EGLL], [place({ code: "MYF", iata: "AMS" })]);
    expect(equivalentCodes(idx, "ams")).toEqual(["AMS", "MYF"]);
    const plain = buildAirportIndex([EHAM, EGLL]);
    expect(equivalentCodes(plain, " ams ")).toEqual(["AMS", "EHAM"]);
    expect(equivalentCodes(plain, "EHAM")).toEqual(["AMS", "EHAM"]);
  });

  it("gives a contested IATA to its winner only", () => {
    const idx = buildAirportIndex([row({ icao: "SPIM", iata: "LIM", version: 1 }), row({ icao: "SPJC", iata: "LIM", version: 2 })]);
    expect(equivalentCodes(idx, "SPJC")).toEqual(["LIM", "SPJC"]);
    expect(equivalentCodes(idx, "SPIM")).toEqual(["SPIM"]);
  });

  it("is the code itself for an unknown code, and empty for blank", () => {
    const idx = buildAirportIndex([EHAM]);
    expect(equivalentCodes(idx, "zzzz")).toEqual(["ZZZZ"]);
    expect(equivalentCodes(idx, " ")).toEqual([]);
  });
});
