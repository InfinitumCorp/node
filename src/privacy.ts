/**
 * Privacy rules for everything Nøde measures and licenses.
 *
 * - Analytics never carry an account id. Sessions are keyed by a random id the device rotates daily.
 * - Places are coarsened to a geohash cell (precision 5, about 4.9 km x 4.9 km) before storage.
 * - Times are coarsened to the hour before storage.
 * - Reports suppress any group smaller than MIN_GROUP distinct sessions (k-anonymity on output).
 * - Counts in reports are rounded to the nearest 5 so neighbouring reports can't be differenced
 *   down to one person.
 */

export const MIN_GROUP = 10;
export const AREA_PRECISION = 5;
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/** Standard geohash. */
export function geohash(lat: number, lng: number, precision = AREA_PRECISION): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new RangeError("lat/lng out of range");
  }
  let latLo = -90, latHi = 90, lngLo = -180, lngHi = 180;
  let out = "", bit = 0, ch = 0, even = true;
  while (out.length < precision) {
    if (even) {
      const mid = (lngLo + lngHi) / 2;
      if (lng >= mid) { ch = (ch << 1) | 1; lngLo = mid; } else { ch <<= 1; lngHi = mid; }
    } else {
      const mid = (latLo + latHi) / 2;
      if (lat >= mid) { ch = (ch << 1) | 1; latLo = mid; } else { ch <<= 1; latHi = mid; }
    }
    even = !even;
    if (++bit === 5) { out += BASE32[ch]; bit = 0; ch = 0; }
  }
  return out;
}

/** Centre of a geohash cell (for showing hotspots on a map at public precision). */
export function geohashCenter(hash: string): { lat: number; lng: number } {
  let latLo = -90, latHi = 90, lngLo = -180, lngHi = 180, even = true;
  for (const c of hash) {
    const v = BASE32.indexOf(c);
    if (v < 0) throw new RangeError("not a geohash");
    for (let b = 4; b >= 0; b--) {
      const on = (v >> b) & 1;
      if (even) { const m = (lngLo + lngHi) / 2; if (on) lngLo = m; else lngHi = m; }
      else { const m = (latLo + latHi) / 2; if (on) latLo = m; else latHi = m; }
      even = !even;
    }
  }
  return { lat: (latLo + latHi) / 2, lng: (lngLo + lngHi) / 2 };
}

export const AREA = /^[0-9bcdefghjkmnpqrstuvwxyz]{1,5}$/;

/** Truncate a timestamp to the start of its hour (UTC). */
export const hourOf = (ms: number): number => Math.floor(ms / 3_600_000) * 3_600_000;

export const roundCount = (n: number): number => Math.round(n / 5) * 5;

export interface Group<T> { key: T; sessions: number }

/** Drop groups under MIN_GROUP sessions and report how many were held back (never which). */
export function suppress<T extends Group<unknown>>(groups: readonly T[], min = MIN_GROUP): { rows: T[]; suppressed: number } {
  const rows = groups.filter((g) => g.sessions >= min);
  return { rows, suppressed: groups.length - rows.length };
}

/** Median of a numeric list; reports use medians and p90s, never individual samples. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i]!;
}
