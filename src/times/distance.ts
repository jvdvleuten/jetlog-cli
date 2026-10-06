/**
 * Plain float64 haversine great-circle distance, in nautical miles, used
 * only for the aggregator's cross-country-by-distance classification
 * (see `aggregator.ts`). Deliberately kept separate
 * from the night algorithm (`night.ts`), which has its own great-circle
 * interpolation. This is plain reporting math, matching
 * the iOS app's `GreatCircle.haversineDistance`.
 */

const EARTH_RADIUS_METERS = 6371e3;
const METERS_PER_NM = 1852;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance between two lat/lon points, in nautical miles. */
export function haversineDistanceNM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const deltaPhi = toRadians(lat2 - lat1);
  const deltaLambda = toRadians(lon2 - lon1);

  const a = Math.sin(deltaPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const meters = EARTH_RADIUS_METERS * c;
  return meters / METERS_PER_NM;
}

/** Cross-country-by-distance threshold, nautical miles. */
export const CROSS_COUNTRY_DISTANCE_THRESHOLD_NM = 300.0;
