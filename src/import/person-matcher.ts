/**
 * Person matching, ported from the Jetlog iOS app (offline-usable parts only).
 *
 * The app's matcher resolves a People-sheet row (or crew name) against the
 * user's existing `Person` records in priority order: Jetlog ID (UUID) ->
 * short code -> employee number -> exact normalized name -> fuzzy name. The
 * first three strategies all require the local database this CLI doesn't
 * have, so they're skipped entirely here: there's nothing to match against
 * offline. What's kept is the name-normalization and fuzzy-matching
 * machinery itself (`normalizeName`, `normalizeEmployee`, `levenshtein`),
 * useful for de-duplicating crew names within one import file (e.g. "J.
 * Smith" appearing on five rows should resolve to one `ImportedPerson`, not
 * five), the one thing an importer can usefully do with no DB at all.
 */

/** Lowercased, diacritic-folded, punctuation-stripped, whitespace-collapsed
 * name so "José-Maria O'Neil" matches "Jose Maria ONeil". */
export function normalizeName(name: string): string {
  const folded = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  const chars = Array.from(folded).map((ch) => (/[a-z0-9]/i.test(ch) ? ch : " "));
  return chars
    .join("")
    .split(/\s+/)
    .filter((s) => s.length > 0)
    .join(" ");
}

/** Employee numbers compared case-insensitively, ignoring whitespace/punctuation. */
export function normalizeEmployee(employee: string): string {
  return employee
    .toLowerCase()
    .split("")
    .filter((ch) => /[a-z0-9]/.test(ch))
    .join("");
}

/** Standard iterative Levenshtein distance. */
export function levenshtein(lhs: string, rhs: string): number {
  if (lhs === rhs) return 0;
  const a = Array.from(lhs);
  const b = Array.from(rhs);
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
}

/**
 * In-file name matcher: given the distinct crew names seen so far (as
 * normalized -> original-name groups), resolves a new name to an existing
 * group when it's an unambiguous exact or fuzzy match, so repeated
 * spellings of the same crew member collapse to one `ImportedPerson`.
 */
export class InFileNameMatcher {
  private readonly byNormalizedName = new Map<string, string[]>();

  /** Registers a name as belonging to a (possibly new) person group;
   * returns the canonical key to use as that person's `refId` seed. */
  resolve(fullName: string): string {
    const normalized = normalizeName(fullName);
    if (normalized.length === 0) return fullName;

    const exact = this.byNormalizedName.get(normalized);
    if (exact) {
      exact.push(fullName);
      return normalized;
    }

    const fuzzy = this.fuzzyMatch(normalized);
    if (fuzzy) {
      this.byNormalizedName.get(fuzzy)!.push(fullName);
      return fuzzy;
    }

    this.byNormalizedName.set(normalized, [fullName]);
    return normalized;
  }

  private fuzzyMatch(normalizedName: string): string | undefined {
    if (normalizedName.length < 5) return undefined;
    const budget = Math.max(1, Math.floor(normalizedName.length / 6));
    let best: { key: string; distance: number } | undefined;
    let tied = false;

    for (const key of this.byNormalizedName.keys()) {
      const distance = levenshtein(normalizedName, key);
      if (distance > budget) continue;
      if (!best || distance < best.distance) {
        best = { key, distance };
        tied = false;
      } else if (distance === best.distance) {
        tied = true;
      }
    }

    if (!best || tied) return undefined;
    return best.key;
  }
}
