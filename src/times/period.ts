/**
 * The shared period predicate (`inPeriod`): a period
 * `[from, to]` contains an entry when `from <= derivedDate <= to`, both ends
 * inclusive. Every totals bucket and filter goes through this one function with
 * the entry's DERIVED date (`derivedDate`), never the planned `date`.
 */
export interface Period {
  /** `YYYY-MM-DD`, inclusive. Omitted = open start. */
  from?: string | null;
  /** `YYYY-MM-DD`, inclusive. Omitted = open end. */
  to?: string | null;
}

export function inPeriod(derivedDate: string | undefined, period: Period): boolean {
  if (derivedDate === undefined) return false;
  if (period.from && derivedDate < period.from) return false;
  if (period.to && derivedDate > period.to) return false;
  return true;
}
