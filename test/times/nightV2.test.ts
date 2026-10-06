/**
 * Night v2 conformance: `night-v2-vectors.json` (2150 vectors, shared
 * verbatim with the backend and the iOS app). Every vector must match exactly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { nightMinutes, nightMinutesBrute } from "../../src/times/night.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Vector {
  from: string;
  to: string;
  date: string;
  off_blocks_minutes: number;
  total_minutes: number;
  origin_lat: number;
  origin_lon: number;
  dest_lat: number;
  dest_lon: number;
  night: number;
}

const vectors: Vector[] = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "night-v2-vectors.json"), "utf-8"));

const run = (v: Vector, fn: typeof nightMinutes = nightMinutes): number =>
  fn(v.date, v.off_blocks_minutes, v.total_minutes, v.origin_lat, v.origin_lon, v.dest_lat, v.dest_lon);

describe("night v2", () => {
  it("has 2150 conformance vectors", () => {
    expect(vectors.length).toBe(2150);
  });

  it("reproduces every conformance vector exactly", () => {
    const failures = vectors
      .map((v) => ({ v, got: run(v) }))
      .filter(({ v, got }) => got !== v.night)
      .map(({ v, got }) => `${v.from}-${v.to} ${v.date} off=${v.off_blocks_minutes} got=${got} expected=${v.night}`);
    expect(failures).toEqual([]);
  });

  it("never exceeds the block time and is never negative", () => {
    for (const v of vectors) {
      const night = run(v);
      expect(night).toBeGreaterThanOrEqual(0);
      expect(night).toBeLessThanOrEqual(v.total_minutes);
    }
  });

  it("returns 0 for a non-positive block", () => {
    expect(nightMinutes("2026-01-15", 0, 0, 52, 4, 40, -73)).toBe(0);
    expect(nightMinutes("2026-01-15", 0, -5, 52, 4, 40, -73)).toBe(0);
  });

  it("adaptive count equals brute force over every minute (sample of vectors)", () => {
    const sample = vectors.filter((_, i) => i % 7 === 0);
    expect(sample.length).toBeGreaterThan(200);
    for (const v of sample) {
      expect(run(v), `${v.from}-${v.to} ${v.date} off=${v.off_blocks_minutes}`).toBe(run(v, nightMinutesBrute));
    }
  });
});
