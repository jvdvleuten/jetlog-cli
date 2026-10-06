/**
 * Shared time/duration parsing for the CSV-ish logbook importers.
 *
 * Ported from the Jetlog iOS app. All the base "h:mm" exports share
 * the exact same `colonMinutes` semantics; the two genuine format-level
 * differences (PilotLog's raw-integer-minutes variant and RBLogbook's strict
 * "malformed == absent, not midnight" clock-time parsing) are kept as
 * explicit, separately named functions rather than folded into one lenient
 * one, same as the app.
 */
import { time, type Time } from "./model.js";

/**
 * Parses a colon-separated "H:MM"/"HH:MM" string into total minutes.
 * Requires exactly two non-negative integer components; anything else
 * (blank, missing colon, extra components, negative parts) returns `0`.
 */
export function colonMinutes(raw: string): number {
  return validColonMinutes(raw) ?? 0;
}

function validColonMinutes(raw: string): number | undefined {
  const parts = raw.split(":").map((s) => Number.parseInt(s, 10));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n) || n < 0)) return undefined;
  const [h, m] = parts as [number, number];
  return h * 60 + m;
}

/** Parses a duration cell in "h:mm" form. Blank/undefined is "not logged" (`0`). */
export function colonDuration(raw: string | undefined): number {
  if (!raw || raw.length === 0) return 0;
  return colonMinutes(raw);
}

/**
 * Parses a clock-time cell in "h:mm" form into a `Time`, optionally
 * stripping trailing unit suffixes first (e.g. SafeLog's "14:55 LOCAL").
 * Blank/undefined is `undefined`; a non-blank but malformed cell collapses
 * to minute `0` (midnight) rather than `undefined`, matches every importer
 * except RBLogbook (`strictTimeOfDay`, below).
 */
export function timeOfDay(raw: string | undefined, stripSuffixes: string[] = []): Time | undefined {
  if (!raw || raw.length === 0) return undefined;
  let cleaned = raw;
  if (stripSuffixes.length > 0) {
    for (const suffix of stripSuffixes) cleaned = cleaned.split(suffix).join("");
    cleaned = cleaned.trim();
  }
  return time(colonMinutes(cleaned));
}

/**
 * RBLogbook's clock-time variant: a malformed or negative-component cell
 * returns `undefined` (absent) instead of collapsing to midnight.
 */
export function strictTimeOfDay(raw: string | undefined): Time | undefined {
  if (!raw || raw.length === 0) return undefined;
  const minutes = validColonMinutes(raw);
  if (minutes === undefined) return undefined;
  return time(minutes);
}

/**
 * PilotLog's duration variant: accepts both "h:mm" and a bare integer count
 * of minutes. A blank cell is `0`; a negative bare integer clamps to `0`.
 */
export function colonOrBareMinutesDuration(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 0;
  if (trimmed.includes(":")) return colonMinutes(trimmed);
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}
