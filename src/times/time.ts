/**
 * Time arithmetic helpers, ports the pieces of the iOS `Time` type the calculator
 * needs, operating on plain minute integers instead of a wrapped `Time`
 * struct.
 */

/** Parses a time-of-day string ("H:MM"/"HH:MM") into total minutes since midnight. */
export function parseTimeOfDay(s: string): number {
  const [h, m] = s.split(":");
  return Number(h) * 60 + Number(m);
}

/**
 * The iOS `Time` type's `-` operator: if either operand is >= 24h
 * (1440 minutes), plain clamped subtraction (`max(0, end - start)`);
 * otherwise mod-1440 wraparound subtraction (handles midnight crossing,
 * e.g. 00:30 - 23:45 = 45 minutes).
 */
export function subtractTimes(endMinutes: number, startMinutes: number): number {
  if (endMinutes >= 24 * 60 || startMinutes >= 24 * 60) {
    return Math.max(0, endMinutes - startMinutes);
  }
  return (((endMinutes - startMinutes) % (24 * 60)) + 24 * 60) % (24 * 60);
}

/**
 * `DetailedTimes.remainder(of:minus:)`:
 * `max(0, (whole ?? 0) - part)`, collapsed to `undefined` when the result is
 * `<= 0` (NOT just `< 0`, a zero remainder also collapses to absent).
 */
export function remainderOf(wholeMinutes: number | undefined, minusMinutes: number): number | undefined {
  const minutes = Math.max(0, (wholeMinutes ?? 0) - minusMinutes);
  return minutes > 0 ? minutes : undefined;
}
