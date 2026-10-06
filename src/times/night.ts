/**
 * Night time v2: the canonical night-minutes algorithm shared by iOS,
 * the backend and this CLI. Conformance
 * vectors: `test/times/fixtures/night-v2-vectors.json` (2150 vectors, all of
 * which must match exactly, see `test/times/nightV2.test.ts`).
 *
 * A minute index `i` in `0 ..< total` is night when the sun's elevation at
 * the great-circle position at that minute's midpoint is below -6 degrees.
 * Everything is IEEE-754 double precision (plain JS numbers) and the result
 * is an integer minute count. The count is evaluated adaptively (20-minute
 * blocks, bisection on state changes) and is identical to evaluating every
 * minute, see `nightMinutesBrute`.
 *
 * The operation order of the arithmetic is part of the contract: do not
 * simplify or reorder it.
 */

const D2R = Math.PI / 180;
const SIN_LIMIT = Math.sin(-6 * D2R);
const BLOCK = 20;
const MS_PER_DAY = 86_400_000;
const EPOCH_2000_MS = Date.UTC(2000, 0, 1);

type Vec3 = readonly [number, number, number];

interface FlightContext {
  /** Whole days from 2000-01-01 to the date, minus 0.5. */
  n0: number;
  off: number;
  total: number;
  delta: number;
  sinDelta: number;
  v1: Vec3;
  v2: Vec3;
}

/** Whole UTC days from 2000-01-01 to `dateStr` ("YYYY-MM-DD"). */
function daysSince2000(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Math.round((Date.UTC(y ?? 2000, (m ?? 1) - 1, d ?? 1) - EPOCH_2000_MS) / MS_PER_DAY);
}

function buildContext(
  dateStr: string,
  offMinutes: number,
  totalMinutes: number,
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): FlightContext {
  const p1 = lat1 * D2R;
  const l1 = lon1 * D2R;
  const p2 = lat2 * D2R;
  const l2 = lon2 * D2R;
  const shP = Math.sin((p2 - p1) / 2);
  const shL = Math.sin((l2 - l1) / 2);
  const a = shP * shP + Math.cos(p1) * Math.cos(p2) * shL * shL;
  const delta = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return {
    n0: daysSince2000(dateStr) - 0.5,
    off: offMinutes,
    total: totalMinutes,
    delta,
    sinDelta: Math.sin(delta),
    v1: [Math.cos(p1) * Math.cos(l1), Math.cos(p1) * Math.sin(l1), Math.sin(p1)],
    v2: [Math.cos(p2) * Math.cos(l2), Math.cos(p2) * Math.sin(l2), Math.sin(p2)]
  };
}

/** State of minute index `i`: night at the midpoint of that minute. */
function isNight(ctx: FlightContext, i: number): boolean {
  const m = i + 0.5;

  let x: number;
  let y: number;
  let z: number;
  if (ctx.sinDelta < 1e-9) {
    [x, y, z] = ctx.v1;
  } else {
    const fr = m / ctx.total;
    const ac = Math.sin((1 - fr) * ctx.delta) / ctx.sinDelta;
    const bc = Math.sin(fr * ctx.delta) / ctx.sinDelta;
    const [x1, y1, z1] = ctx.v1;
    const [x2, y2, z2] = ctx.v2;
    x = ac * x1 + bc * x2;
    y = ac * y1 + bc * y2;
    z = ac * z1 + bc * z2;
  }

  const n = ctx.n0 + (ctx.off + m) / 1440;
  const g = ((357.528 + 0.9856003 * n) % 360) * D2R;
  const lambda = ((280.46 + 0.9856474 * n) % 360) * D2R + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * D2R;
  const eps = (23.439 - 0.0000004 * n) * D2R;
  const sl = Math.sin(lambda);
  const sx = Math.cos(lambda);
  const sy = Math.cos(eps) * sl;
  const sz = Math.sin(eps) * sl;
  const gmst = ((280.46061837 + 360.98564736629 * n) % 360) * D2R;
  const cg = Math.cos(gmst);
  const sg = Math.sin(gmst);
  const ex = sx * cg + sy * sg;
  const ey = sy * cg - sx * sg;
  return x * ex + y * ey + z * sz < SIN_LIMIT;
}

const bit = (q: boolean): number => (q ? 1 : 0);

/** First index in (lo, hi] whose state differs from `q`; state(lo) === q and state(hi) !== q. */
function bisect(ctx: FlightContext, loIn: number, hiIn: number, q: boolean): number {
  let lo = loIn;
  let hi = hiIn;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (isNight(ctx, mid) === q) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Night minutes among minute indices a..b inclusive, given the states at a and b. */
function count(ctx: FlightContext, a: number, b: number, qa: boolean, qb: boolean): number {
  if (a === b) return bit(qa);
  if (b === a + 1) return bit(qa) + bit(qb);
  if (qa !== qb) {
    const hi = bisect(ctx, a, b, qa);
    return qa ? hi - a : b - hi + 1;
  }
  const mid = Math.floor((a + b) / 2);
  const qm = isNight(ctx, mid);
  if (qm === qa) return qa ? b - a + 1 : 0;
  return count(ctx, a, mid, qa, qm) + count(ctx, mid, b, qm, qb) - bit(qm);
}

/**
 * Night minutes of a flight.
 *
 * @param dateStr UTC calendar date ("YYYY-MM-DD") that `offMinutes` is relative to
 *   (the entry's derived date: `systemDate` when flight data tracking is on).
 * @param offMinutes minutes after 00:00 UTC of `dateStr` at off-blocks (may exceed 1439).
 * @param totalMinutes block minutes; `<= 0` returns 0.
 */
export function nightMinutes(
  dateStr: string,
  offMinutes: number,
  totalMinutes: number,
  originLat: number,
  originLon: number,
  destLat: number,
  destLon: number
): number {
  if (totalMinutes <= 0) return 0;
  const ctx = buildContext(dateStr, offMinutes, totalMinutes, originLat, originLon, destLat, destLon);

  let acc = 0;
  for (let a = 0; a < totalMinutes; a += BLOCK) {
    const b = Math.min(a + BLOCK - 1, totalMinutes - 1);
    acc += count(ctx, a, b, isNight(ctx, a), isNight(ctx, b));
  }
  return acc;
}

/** Oracle: evaluates every minute index. Must always equal `nightMinutes`. */
export function nightMinutesBrute(
  dateStr: string,
  offMinutes: number,
  totalMinutes: number,
  originLat: number,
  originLon: number,
  destLat: number,
  destLon: number
): number {
  if (totalMinutes <= 0) return 0;
  const ctx = buildContext(dateStr, offMinutes, totalMinutes, originLat, originLon, destLat, destLon);
  let acc = 0;
  for (let i = 0; i < totalMinutes; i++) acc += bit(isNight(ctx, i));
  return acc;
}
