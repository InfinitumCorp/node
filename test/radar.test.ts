import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-ignore plain browser module
import { placePins, ringKm } from "../web/radar.js";

const me = { latitude: 55.75, longitude: 37.6 };
const at = (dLat: number, dLng: number, distanceKm: number) => ({ lat: me.latitude + dLat, lng: me.longitude + dLng, distanceKm });

test("the outer ring is 1, 2 or 5 km, else the farthest hotspot rounded up", () => {
  assert.equal(ringKm([]), 1);
  assert.equal(ringKm([0.3, 0.9]), 1);
  assert.equal(ringKm([1.4]), 2);
  assert.equal(ringKm([3]), 5);
  assert.equal(ringKm([6.2, 1]), 7);
});

test("pins point the right way: north is up, east is right", () => {
  const [n, e, s, w] = placePins(me, [at(0.005, 0, 0.5), at(0, 0.009, 0.5), at(-0.005, 0, 0.5), at(0, -0.009, 0.5)], 140);
  assert.ok(n.y < 0 && Math.abs(n.x) < 1, "north");
  assert.ok(e.x > 0 && Math.abs(e.y) < 1, "east");
  assert.ok(s.y > 0 && Math.abs(s.x) < 1, "south");
  assert.ok(w.x < 0 && Math.abs(w.y) < 1, "west");
});

test("distance sets the radius, capped at the outer ring", () => {
  const [half, edge] = placePins(me, [at(0.004, 0, 0.5), at(0.009, 0, 1)], 140);
  assert.ok(Math.abs(Math.hypot(half.x, half.y) - 70) < 1);
  assert.ok(Math.abs(Math.hypot(edge.x, edge.y) - 140) < 1);
});

test("hotspots in the same cell are spread apart, and one where you stand still shows", () => {
  const same = placePins(me, [at(0.004, 0, 0.5), at(0.004, 0, 0.5), at(0.004, 0, 0.5)], 140);
  for (let i = 0; i < same.length; i++) for (let j = i + 1; j < same.length; j++) {
    assert.ok(Math.hypot(same[i].x - same[j].x, same[i].y - same[j].y) >= 22 - 0.2, `${i} and ${j} overlap`);
  }
  const [here] = placePins(me, [at(0, 0, 0)], 140);
  assert.ok(Math.hypot(here.x, here.y) >= 22 - 0.1, "not hidden under the you-are-here dot");
});
