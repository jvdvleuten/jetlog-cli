import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveProfile } from "../../src/auth/credentials.js";
import { placesList } from "../../src/commands/places.js";
import { TestServer, jsonHandler } from "../helpers/test-server.js";

// The row shape GET /api/cli/v1/places sends (backend PlacesJSON.place/1).
function place(id: string, code: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    code,
    icao: null,
    iata: null,
    name: null,
    latitude: null,
    longitude: null,
    country_code: null,
    timezone: null,
    kind: "airport",
    ...extra
  };
}

const EHAM = place("p1", "EHAM", {
  icao: "EHAM",
  iata: "AMS",
  name: "Schiphol",
  latitude: 52.3086,
  longitude: 4.7639,
  country_code: "NL",
  timezone: "Europe/Amsterdam"
});
const FIELD = place("p2", "ZZ01", { name: "Farm strip\u001b[31m" });

describe("jetlog places", () => {
  let dir: string;
  const originalXdg = process.env.XDG_CONFIG_HOME;
  let out: string[];
  let server: TestServer | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jetlog-cli-places-"));
    process.env.XDG_CONFIG_HOME = join(dir, "config");
    delete process.env.JETLOG_TOKEN;
    delete process.env.JETLOG_BASE_URL;
    out = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => (out.push(String(chunk)), true));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server?.stop();
    server = undefined;
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    await rm(dir, { recursive: true, force: true });
  });

  async function serve(...handlers: ReturnType<typeof jsonHandler>[]): Promise<TestServer> {
    server = new TestServer(handlers);
    await server.start();
    await saveProfile("default", { token: "jlp_abc", baseUrl: server.baseUrl });
    return server;
  }

  it("lists every place by following next_offset, like people and aircraft list everything", async () => {
    const s = await serve(
      jsonHandler(200, { places: [EHAM], limit: 1000, offset: 0, next_offset: 1000 }),
      jsonHandler(200, { places: [FIELD], limit: 1000, offset: 1000, next_offset: null })
    );
    await placesList({ profile: "default", format: "json" });
    expect(s.requests.map((r) => r.path)).toEqual([
      "/api/cli/v1/places?limit=1000&offset=0",
      "/api/cli/v1/places?limit=1000&offset=1000"
    ]);
    expect(JSON.parse(out.join("\n"))).toEqual([EHAM, FIELD]);
  });

  it("stops when next_offset does not move forward", async () => {
    const s = await serve(jsonHandler(200, { places: [EHAM], limit: 1000, offset: 0, next_offset: 0 }));
    await placesList({ profile: "default", format: "json" });
    expect(s.requests).toHaveLength(1);
  });

  it("searches with q, trimmed, and prints a table with the code columns and a sanitized name", async () => {
    const s = await serve(jsonHandler(200, { places: [EHAM, FIELD], limit: 1000, offset: 0, next_offset: null }));
    await placesList({ profile: "default", format: "table", search: "  eh " });
    expect(s.requests[0]!.path).toBe("/api/cli/v1/places?q=eh&limit=1000&offset=0");
    const lines = out.join("\n").split("\n").map((l) => l.trimEnd());
    expect(lines[0]).toMatch(/^id\s+code\s+icao\s+iata\s+name\s+country_code\s+timezone\s+latitude\s+longitude$/);
    expect(lines[2]).toMatch(/^p1\s+EHAM\s+EHAM\s+AMS\s+Schiphol\s+NL\s+Europe\/Amsterdam\s+52\.3086\s+4\.7639$/);
    expect(lines[3]).toContain("Farm strip[31m");
    expect(out.join("\n")).not.toContain("\u001b");
  });

  it("asks for one page with --limit or --offset and says where the next page starts", async () => {
    const s = await serve(jsonHandler(200, { places: [EHAM], limit: 1, offset: 5, next_offset: 6 }));
    const hints: string[] = [];
    await placesList({ profile: "default", format: "csv", limit: 1, offset: 5, log: (l) => hints.push(l) });
    expect(s.requests[0]!.path).toBe("/api/cli/v1/places?limit=1&offset=5");
    expect(out.join("").split("\r\n")[1]).toMatch(/^p1,EHAM,EHAM,AMS,Schiphol,NL,Europe\/Amsterdam,52\.3086,4\.7639$/);
    expect(hints).toEqual(["More places with --offset 6."]);
  });

  it("gives no hint on the last page", async () => {
    await serve(jsonHandler(200, { places: [], limit: 50, offset: 0, next_offset: null }));
    const hints: string[] = [];
    await placesList({ profile: "default", format: "table", limit: 50, log: (l) => hints.push(l) });
    expect(hints).toEqual([]);
    expect(out.join("\n")).toContain("(no rows)");
  });

  it("refuses a bad --limit or --offset before any request", async () => {
    const s = await serve();
    await expect(placesList({ profile: "default", format: "table", limit: 0 })).rejects.toThrow("--limit must be a whole number from 1 to 1000");
    await expect(placesList({ profile: "default", format: "table", limit: 1001 })).rejects.toThrow("--limit");
    await expect(placesList({ profile: "default", format: "table", limit: Number.NaN })).rejects.toThrow("--limit");
    await expect(placesList({ profile: "default", format: "table", offset: -1 })).rejects.toThrow("--offset must be a whole number from 0 up");
    await expect(placesList({ profile: "default", format: "table", offset: 1.5 })).rejects.toThrow("--offset");
    // 128 two-byte characters: 256 bytes, over the server's cap although under 255 characters.
    await expect(placesList({ profile: "default", format: "table", search: "é".repeat(128) })).rejects.toThrow(
      "--search must be at most 255 bytes"
    );
    expect(s.requests).toHaveLength(0);
  });

  it("passes a server error on", async () => {
    await serve(jsonHandler(403, { error: "insufficient_scope" }));
    await expect(placesList({ profile: "default", format: "table" })).rejects.toThrow("permission");
  });
});
