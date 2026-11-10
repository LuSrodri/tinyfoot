export const EARTH_C = 40075016.686;
export const EARTH_R = 6371008.8;
export const DEG = Math.PI / 180;

export const mercX = (lon: number): number => (lon + 180) / 360;
export const mercY = (lat: number): number => {
  const s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * DEG);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
export const lonFromMerc = (x: number): number => x * 360 - 180;
export const latFromMerc = (y: number): number => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / DEG;

/** Mercator units per metre at a given mercator y. */
export const mercScale = (my: number): number => Math.cosh(Math.PI * (1 - 2 * my)) / EARTH_C;

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing in degrees, clockwise from north. */
export function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * DEG;
  const p2 = lat2 * DEG;
  const dl = (lon2 - lon1) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

/** Point reached from (lat, lon) travelling `dist` metres on `brg` degrees. Returns [lat, lon]. */
export function destination(lat: number, lon: number, brg: number, dist: number): [number, number] {
  const d = dist / EARTH_R;
  const b = brg * DEG;
  const p1 = lat * DEG;
  const sinP2 = Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b);
  const p2 = Math.asin(Math.max(-1, Math.min(1, sinP2)));
  const l2 = lon * DEG + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * sinP2);
  return [p2 / DEG, ((l2 / DEG + 540) % 360) - 180];
}

/** Great-circle polyline as [lon, lat] pairs, unwrapped across the antimeridian. */
export function greatCircle(lat1: number, lon1: number, lat2: number, lon2: number, steps = 64): [number, number][] {
  const total = haversine(lat1, lon1, lat2, lon2);
  const brg0 = bearing(lat1, lon1, lat2, lon2);
  const out: [number, number][] = [[lon1, lat1]];
  if (total < 1000) return [[lon1, lat1], [lon2, lat2]];
  const p1 = lat1 * DEG;
  const l1 = lon1 * DEG;
  const p2 = lat2 * DEG;
  const l2 = lon2 * DEG;
  const d = total / EARTH_R;
  let prev = lon1;
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    const a = Math.sin((1 - f) * d) / Math.sin(d);
    const b = Math.sin(f * d) / Math.sin(d);
    const x = a * Math.cos(p1) * Math.cos(l1) + b * Math.cos(p2) * Math.cos(l2);
    const y = a * Math.cos(p1) * Math.sin(l1) + b * Math.cos(p2) * Math.sin(l2);
    const z = a * Math.sin(p1) + b * Math.sin(p2);
    const lat = Math.atan2(z, Math.hypot(x, y)) / DEG;
    let lon = Math.atan2(y, x) / DEG;
    while (lon - prev > 180) lon -= 360;
    while (lon - prev < -180) lon += 360;
    prev = lon;
    out.push([lon, lat]);
  }
  void brg0;
  return out;
}

/** Shortest signed difference between two angles in degrees. */
export const angleDiff = (from: number, to: number): number => ((to - from + 540) % 360) - 180;

/** Local mean solar time in hours (0..24) at a longitude. */
export function solarHour(lon: number, now: number): number {
  const utc = (now / 3600000) % 24;
  return (((utc + lon / 15) % 24) + 24) % 24;
}

/** Sub-solar point [lon, lat] for a timestamp (good to a fraction of a degree). */
export function subSolarPoint(now: number): [number, number] {
  const d = now / 86400000 - 10957.5; // days since J2000
  const g = (357.529 + 0.98560028 * d) * DEG;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const e = (23.439 - 0.00000036 * d) * DEG;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  let lon = (ra / DEG - gmst * 15) % 360;
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  return [lon, dec / DEG];
}

/** Sun elevation in degrees above the horizon at a place. */
export function sunElevation(lat: number, lon: number, now: number): number {
  const [sl, sd] = subSolarPoint(now);
  const cosz = Math.sin(lat * DEG) * Math.sin(sd * DEG) + Math.cos(lat * DEG) * Math.cos(sd * DEG) * Math.cos((lon - sl) * DEG);
  return 90 - Math.acos(Math.max(-1, Math.min(1, cosz))) / DEG;
}

/** Deterministic 32-bit hash of a string. */
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Tiny seeded PRNG. */
export function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hsl(h: number, s: number, l: number): number {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return (f(0) << 16) | (f(8) << 8) | f(4);
}
