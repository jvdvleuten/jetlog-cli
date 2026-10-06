import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiClient } from "../../src/api/client.js";
import { fetchAirlineCatalog, normalizeWithAirlineCatalog, type AirlineCatalog } from "../../src/import/airlines.js";
import { normalizeFlightNumber } from "../../src/import/match.js";
import { TestServer, jsonHandler } from "../helpers/test-server.js";

function catalog(rows: { name: string; iata: string; icao: string }[]): AirlineCatalog {
  const byIata = new Map(rows.map((r) => [r.iata.toUpperCase(), r]));
  const byIcao = new Map(rows.map((r) => [r.icao.toUpperCase(), r]));
  return { byIata, byIcao };
}

const KLM = catalog([{ name: "KLM", iata: "KL", icao: "KLM" }]);

describe("normalizeWithAirlineCatalog", () => {
  it("rewrites a recognized ICAO prefix to its canonical IATA form", () => {
    expect(normalizeWithAirlineCatalog("KLM1017", KLM)).toBe("KL1017");
  });

  it("tolerates a single optional space between the prefix and the digits", () => {
    expect(normalizeWithAirlineCatalog("KLM 1017", KLM)).toBe("KL1017");
  });

  it("leaves an already-IATA-prefixed flight number as is (IATA-to-IATA, unchanged content)", () => {
    expect(normalizeWithAirlineCatalog("KL1017", KLM)).toBe("KL1017");
  });

  it("tolerates one trailing letter after the digits (e.g. a codeshare suffix)", () => {
    expect(normalizeWithAirlineCatalog("KLM1017A", KLM)).toBe("KL1017A");
  });

  it("returns the input UNCHANGED (not even trimmed/uppercased) when no prefix matches", () => {
    expect(normalizeWithAirlineCatalog(" uNkNown123 ", KLM)).toBe(" uNkNown123 ");
  });

  it("does not match a prefix whose remainder doesn't look like a flight number", () => {
    // "KLM" alone (no digits after the 3-letter prefix) must not match.
    expect(normalizeWithAirlineCatalog("KLM", KLM)).toBe("KLM");
  });

  it("prefers the 2-letter IATA prefix over the 3-letter ICAO one when both could apply", () => {
    // A pathological catalog where the input's first 2 chars AND first 3
    // chars both resolve to a real prefix with a valid-looking remainder:
    // the iOS app always tries the 2-letter (IATA) candidate first.
    const mixed = catalog([
      { name: "KLM", iata: "KL", icao: "KLM" },
      { name: "Fictitious", iata: "YY", icao: "KL1" }
    ]);
    expect(normalizeWithAirlineCatalog("KL1123", mixed)).toBe("KL1123");
  });
});

describe("normalizeFlightNumber with a catalog", () => {
  it("applies the airline-prefix rewrite then the usual upcase/strip-whitespace", () => {
    expect(normalizeFlightNumber("klm 1017", KLM)).toBe("KL1017");
  });

  it("falls back to today's behavior (no rewrite) when no catalog is given", () => {
    expect(normalizeFlightNumber("klm 1017")).toBe("KLM1017");
  });
});

describe("fetchAirlineCatalog", () => {
  let cacheDir: string;
  const originalXdgCache = process.env.XDG_CACHE_HOME;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "jetlog-cli-airlines-cache-"));
    process.env.XDG_CACHE_HOME = cacheDir;
  });

  afterEach(async () => {
    if (originalXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalXdgCache;
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("fetches and caches the catalog on a cold run", async () => {
    const server = new TestServer([
      jsonHandler(200, { airlines: [{ name: "KLM", iata: "KL", icao: "KLM" }] }, { etag: '"v1"' })
    ]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc" });
      const result = await fetchAirlineCatalog(client);
      expect(result?.byIcao.get("KLM")?.iata).toBe("KL");
    } finally {
      await server.stop();
    }
  });

  it("revalidates with If-None-Match and reuses the cache on a 304", async () => {
    const server1 = new TestServer([
      jsonHandler(200, { airlines: [{ name: "KLM", iata: "KL", icao: "KLM" }] }, { etag: '"v1"' })
    ]);
    await server1.start();
    const client1 = new ApiClient({ baseUrl: server1.baseUrl, token: "jlp_abc" });
    await fetchAirlineCatalog(client1);
    await server1.stop();

    const server2 = new TestServer([(req, res) => res.writeHead(304).end()]);
    await server2.start();
    try {
      const client2 = new ApiClient({ baseUrl: server2.baseUrl, token: "jlp_abc" });
      const result = await fetchAirlineCatalog(client2);
      expect(server2.requests[0]!.headers["if-none-match"]).toBe('"v1"');
      expect(result?.byIcao.get("KLM")?.iata).toBe("KL");
    } finally {
      await server2.stop();
    }
  });

  it("falls back to undefined (not a crash) when the fetch fails and nothing is cached", async () => {
    const server = new TestServer([(req, res) => res.writeHead(500).end(JSON.stringify({ error: "boom" }))]);
    await server.start();
    try {
      const client = new ApiClient({ baseUrl: server.baseUrl, token: "jlp_abc", maxRetries: 0 });
      const result = await fetchAirlineCatalog(client);
      expect(result).toBeUndefined();
    } finally {
      await server.stop();
    }
  });
});
