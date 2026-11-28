/**
 * Maths for the Find map: where each hotspot goes on rings around you. No DOM, so it is unit-tested
 * (test/radar.test.ts). Distances are the API's, positions the ~150 m cell centres it returns.
 */

/** The outer ring's distance in km: 1, 2 or 5 km, else the farthest hotspot rounded up. */
export function ringKm(distancesKm) {
  const max = Math.max(1, ...distancesKm);
  return max <= 1 ? 1 : max <= 2 ? 2 : max <= 5 ? 5 : Math.ceil(max);
}

/**
 * Pin positions as {x, y} offsets from the centre, y pointing down as in SVG, for a map of radius
 * `radius`. Pins closer than `gap` to an earlier one are turned around the centre until they're clear,
 * so hotspots in the same cell stay readable.
 */
export function placePins(me, hotspots, radius, gap = 22) {
  const ring = ringKm(hotspots.map((h) => h.distanceKm));
  const rad = Math.PI / 180;
  const out = [];
  for (const h of hotspots) {
    const dy = (h.lat - me.latitude) * 111.32;
    const dx = (h.lng - me.longitude) * 111.32 * Math.cos(me.latitude * rad);
    const r = Math.max(gap, Math.min(radius, (Math.min(h.distanceKm, ring) / ring) * radius));
    let a = Math.hypot(dx, dy) < 1e-6 ? -Math.PI / 2 : Math.atan2(-dy, dx);
    const step = gap / r;
    for (let tries = 0; tries < Math.ceil((2 * Math.PI) / step); tries++) {
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      if (out.every((p) => Math.hypot(p.x - x, p.y - y) >= gap)) break;
      a += tries % 2 ? -step * (tries + 1) : step * (tries + 1);
    }
    out.push({ x: Math.round(Math.cos(a) * r * 10) / 10, y: Math.round(Math.sin(a) * r * 10) / 10 });
  }
  return out;
}
