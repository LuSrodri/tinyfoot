// Live aircraft from community ADS-B receivers (adsb.lol, adsb.fi fallback).
// Covers aircraft in the air and taxiing/parked on the ground with their
// transponder on. Type, registration and callsign come straight from the feed.

import { getJson, type Ctx, type InfoRow, type Layer, type LayerState, type Selection } from '../core';
import type { FrameInfo, Scene } from '../gl/instanced';
import { M } from '../gl/meshes';
import { DEG, bearing, greatCircle, haversine, mercX, mercY } from '../util/geo';
import { Mover } from '../util/mover';
import { t } from '../util/i18n';
import { liveryFor, typeInfo, type TypeInfo } from './aircraftTypes';

interface RawAc {
  hex: string;
  flight?: string;
  r?: string;
  t?: string;
  category?: string;
  alt_baro?: number | 'ground';
  alt_geom?: number;
  gs?: number;
  track?: number;
  true_heading?: number;
  baro_rate?: number;
  geom_rate?: number;
  squawk?: string;
  lat?: number;
  lon?: number;
  seen_pos?: number;
}

interface Airport {
  iata_code: string;
  icao_code: string;
  name: string;
  municipality: string;
  latitude: number;
  longitude: number;
}

interface RouteInfo {
  airline?: string;
  origin?: Airport;
  destination?: Airport;
}

interface Airframe {
  type?: string;
  manufacturer?: string;
  registered_owner?: string;
  registered_owner_country_name?: string;
}

const FT = 0.3048;
const KT = 0.514444;
const TRAIL_MAX = 48;

// The feed only answers "what is within 250 nm of this point", so a whole-planet view cannot be
// tiled. From far away we sample the busiest air-traffic regions that are on the visible side.
const HUBS: [number, number][] = [
  [40.7, -74], [41.9, -87.9], [33.6, -84.4], [32.9, -97], [39.8, -104.7], [34, -118.2], [37.6, -122.4], [47.4, -122.3],
  [25.8, -80.3], [43.7, -79.6], [19.4, -99.1], [4.7, -74.1], [-23.5, -46.5], [-34.7, -58.5], [-33.4, -70.8], [-12, -77.1],
  [51.5, -0.3], [49, 2.5], [50, 8.6], [40.5, -3.6], [41.8, 12.3], [41.3, 28.7], [55.8, 37.6], [59.6, 17.9], [52.2, 21],
  [30.1, 31.4], [25.2, 55.4], [24.9, 46.7], [28.6, 77.1], [19.1, 72.9], [13.2, 77.7], [13.7, 100.7], [1.3, 103.9],
  [-6.1, 106.7], [22.3, 113.9], [31.2, 121.5], [40, 116.6], [37.5, 126.5], [35.6, 139.8], [14.5, 121], [-33.9, 151.2],
  [-37.7, 144.8], [-37, 174.8], [-26.1, 28.2], [-1.3, 36.9], [6.6, 3.3], [9, 38.8], [61.2, -150], [21.3, -157.9], [64, -22.6],
];

class Plane {
  readonly mover = new Mover();
  flight = '';
  reg = '';
  type = '';
  category = '';
  info: TypeInfo = typeInfo(undefined, undefined);
  c1 = 0xf3f4f6;
  c2 = 0x3a6ea5;
  c3 = 0xc9ced4;
  ground = false;
  /** Target and displayed altitude in metres above sea level. */
  altTarget = 0;
  alt = -1;
  gsKt = 0;
  vrate = 0;
  squawk = '';
  seen = 0;
  groundElev = 0;
  groundElevAt = 0;
  /** Photographed runway minus the terrain model, last measured under this aircraft. */
  surfaceDelta = 0;
  /** Recent positions: mercator x, y, altitude. */
  trail: number[] = [];
  route?: RouteInfo | null;
  airframe?: Airframe | null;
  /** Older positions from the flight's recorded track, same layout as `trail`. */
  history: number[] = [];

  constructor(readonly hex: string) {}
}

interface Cell {
  lat: number;
  lon: number;
  next: number;
}

export class AircraftLayer implements Layer {
  readonly id = 'aircraft';
  enabled = true;
  count = 0;
  state: LayerState = 'loading';
  hint = '';

  private planes = new Map<string, Plane>();
  private cells = new Map<string, Cell>();
  private planned = 0;
  private inflight = 0;
  private lastStart = 0;
  private failures = 0;
  private selected: Plane | null = null;
  private routeDirty = true;
  private routeDrawn = 0;

  constructor(private readonly ctx: Ctx) {}

  // ------------------------------------------------------------- network

  private plan(frame: FrameInfo): void {
    const { map, tier } = this.ctx;
    const wanted = new Map<string, Cell>();
    const add = (lat: number, lon: number) => {
      const la = Math.round(lat * 2) / 2;
      const lo = Math.round((((lon + 540) % 360) - 180) * 2) / 2;
      const key = `${la},${lo}`;
      if (!wanted.has(key)) wanted.set(key, this.cells.get(key) ?? { lat: la, lon: lo, next: 0 });
    };
    if (frame.zoom >= 7.2) {
      add(frame.lat, frame.lon);
    } else if (frame.zoom < 5) {
      add(frame.lat, frame.lon);
      const reach = frame.zoom < 3 ? 8.2e6 : 5e6;
      const hubs = HUBS.map(([la, lo]) => [la, lo, haversine(frame.lat, frame.lon, la, lo)] as const)
        .filter((h) => h[2] < reach)
        .sort((a, b2) => a[2] - b2[2]);
      for (const [la, lo] of hubs.slice(0, tier.aircraftCells)) add(la, lo);
    } else {
      // Tile the view with 250 nm circles, nearest to the centre first.
      const b = map.getBounds();
      const south = Math.max(-80, b.getSouth());
      const north = Math.min(80, b.getNorth());
      let west = b.getWest();
      let east = b.getEast();
      if (east - west > 300) {
        west = frame.lon - 150;
        east = frame.lon + 150;
      }
      const step = 5.5;
      const list: [number, number, number][] = [];
      for (let la = Math.floor(south / step) * step; la <= north + step; la += step) {
        const lonStep = Math.min(40, step / Math.max(0.2, Math.cos(la * DEG)));
        for (let lo = Math.floor(west / lonStep) * lonStep; lo <= east + lonStep; lo += lonStep) {
          list.push([la, lo, haversine(frame.lat, frame.lon, la, lo)]);
        }
      }
      list.sort((a, b2) => a[2] - b2[2]);
      for (const [la, lo] of list.slice(0, tier.aircraftCells)) add(la, lo);
    }
    this.cells = wanted;
  }

  private poll(now: number): void {
    if (this.inflight >= 2 || now - this.lastStart < 450) return;
    let due: Cell | null = null;
    for (const cell of this.cells.values()) {
      if (cell.next <= now && (!due || cell.next < due.next)) due = cell;
    }
    if (!due) return;
    const period = Math.max(5000, this.cells.size * 1300) * (this.failures > 2 ? 3 : 1);
    due.next = now + period;
    this.lastStart = now;
    this.inflight++;
    const far = this.cells.size > 4 ? "&far=1" : "";
    // adsb.lol answers { ac, now: ms }, adsb.fi { aircraft, now: s }.
    void getJson<{ ac?: RawAc[]; aircraft?: RawAc[]; now?: number }>(`/api/aircraft?lat=${due.lat}&lon=${due.lon}${far}`, 20000)
      .then((data) => {
        const list = data?.ac ?? data?.aircraft;
        if (!list) {
          this.failures++;
          return;
        }
        this.failures = 0;
        const now = data?.now;
        this.ingest(list, now !== undefined && now < 1e11 ? now * 1000 : now);
      })
      .finally(() => {
        this.inflight--;
      });
  }

  private ingest(list: RawAc[], serverNow?: number): void {
    const now = Date.now();
    const base = serverNow && Math.abs(serverNow - now) < 30000 ? serverNow : now;
    for (const a of list) {
      if (a.lat === undefined || a.lon === undefined || !a.hex) continue;
      let p = this.planes.get(a.hex);
      if (!p) {
        p = new Plane(a.hex);
        this.planes.set(a.hex, p);
      }
      const fixT = base - (a.seen_pos ?? 0) * 1000;
      // Some transponders send '@' padding instead of a callsign.
      const flight = (a.flight ?? '').replace(/[^A-Za-z0-9-]/g, '').trim();
      if (flight !== p.flight || (a.t ?? '') !== p.type) {
        p.flight = flight;
        p.type = a.t ?? '';
        p.category = a.category ?? '';
        p.info = typeInfo(a.t, a.category);
        [p.c1, p.c2, p.c3] = liveryFor(flight, a.hex);
        if (p === this.selected) this.routeDirty = true;
      }
      p.reg = a.r ?? p.reg;
      p.ground = a.alt_baro === 'ground';
      const altFt = a.alt_geom ?? (typeof a.alt_baro === 'number' ? a.alt_baro : 0);
      p.altTarget = p.ground ? 0 : Math.max(0, altFt * FT);
      p.gsKt = a.gs ?? 0;
      p.vrate = a.geom_rate ?? a.baro_rate ?? 0;
      p.squawk = a.squawk ?? '';
      const heading = p.ground ? (a.true_heading ?? a.track) : (a.track ?? a.true_heading);
      const speed = p.gsKt * KT;
      // A parked aircraft has no meaningful course; keep whatever heading it had.
      p.mover.fix(a.lat, a.lon, fixT, speed < 1 ? 0 : speed, heading);
      if (now - p.seen > 800) {
        const mx = mercX(a.lon);
        const my = mercY(a.lat);
        const n = p.trail.length;
        if (n === 0 || Math.abs(p.trail[n - 3] - mx) + Math.abs(p.trail[n - 2] - my) > 2e-6) {
          p.trail.push(mx, my, p.altTarget);
          if (p.trail.length > TRAIL_MAX * 3) p.trail.splice(0, 3);
        }
      }
      p.seen = now;
    }
  }

  // --------------------------------------------------------------- frame

  tick(frame: FrameInfo): void {
    if (!this.enabled) return;
    if (frame.now - this.planned > 900) {
      this.planned = frame.now;
      this.plan(frame);
      for (const [hex, p] of this.planes) {
        if (frame.now - p.seen > 60000 && p !== this.selected) this.planes.delete(hex);
        else if (frame.now - p.seen > 300000) this.planes.delete(hex);
      }
      this.count = this.planes.size;
      this.state = this.count ? 'live' : this.failures > 3 ? 'error' : 'loading';
      this.hint = this.failures > 3 && !this.count ? t('hintFeedDown') : frame.zoom < 5 ? t('hintAircraftFar') : '';
    }
    this.poll(frame.now);
    if (this.selected && (this.routeDirty || frame.now - this.routeDrawn > 4000)) this.drawRoute(frame.now);
  }

  emit(scene: Scene, frame: FrameInfo): void {
    if (!this.enabled) return;
    const { ctx } = this;
    // Real size up close. From far away an aircraft would be smaller than a pixel, so it is
    // enlarged just enough to remain a small marker, never a giant over the city.
    const minPx = frame.zoom < 4 ? 7 : frame.zoom < 7 ? 10 : frame.zoom < 11 ? 12 : frame.zoom < 14.5 ? 13 : 0;
    const trails = ctx.tier.trails && frame.zoom > 5;
    const trailW = Math.max(1.6 * frame.mpp, 1.2);

    for (const p of this.planes.values()) {
      const m = p.mover;
      m.step(frame.now, frame.dt, 25, 0.9);
      if (p.alt < 0) p.alt = p.altTarget;
      p.alt += (p.altTarget - p.alt) * Math.min(1, frame.dt * 0.8);

      const mx = mercX(m.lon);
      const my = mercY(m.lat);
      const len = p.info.length;
      const size = Math.max(1, (minPx * frame.mpp) / len);
      const scale = p.info.scale * size;

      let elev = p.alt;
      const nearGround = p.ground || p.alt < 3000;
      if (nearGround && frame.zoom > 8) {
        if (frame.now - p.groundElevAt > 1500) {
          p.groundElevAt = frame.now + Math.random() * 400;
          let g = ctx.elevAt(m.lat, m.lon);
          // The terrain model can be metres off the photographed runway: stand on what is drawn.
          // Measurements come in a little later, so keep the last difference while the aircraft rolls on.
          if (p.ground && frame.zoom > 12.5) {
            const s = ctx.surfaceAt(m.lat, m.lon);
            if (s !== undefined && s > g - 15 && s < g + 8) p.surfaceDelta = s - g;
            g += p.surfaceDelta;
          }
          p.groundElev = g;
        }
        // Wheels on the tarmac; never let a low approach sink into a hill.
        const gear = len * 0.085 * size;
        elev = p.ground ? p.groundElev + gear : Math.max(p.alt, p.groundElev + gear);
      }
      const selected = p === this.selected;

      scene.add(p.info.mesh(), mx, my, elev, m.heading * DEG, scale, scale, 0, p.c1, p.c2, p.c3);
      scene.pickable(mx, my, elev, Math.max(16, (len * size) / frame.mpp * 0.6), p);

      // A shadow only makes sense while the aircraft is drawn near its real size.
      if (size < 2.5 && !p.ground) {
        const s = len * size * 0.8;
        scene.add(M.Shadow, mx, my, p.groundElev + 0.6, m.heading * DEG, s * 0.9, s, 0, 0, 0);
      }

      if ((trails || selected) && !p.ground) {
        const w = selected ? trailW * 2 : trailW;
        const color = selected ? 0xffc83d : p.c2;
        if (selected && p.history.length) this.segments(scene, p.history, w, color, p.trail[0], p.trail[1], p.trail[2]);
        this.segments(scene, p.trail, w, color, mx, my, elev);
      }
    }
  }

  /** Draws a polyline (mercator x, y, altitude triples) ending at the given point. */
  private segments(scene: Scene, pts: number[], width: number, color: number, endX?: number, endY?: number, endZ?: number): void {
    const n = pts.length / 3;
    for (let i = 0; i < n; i++) {
      const x0 = pts[i * 3], y0 = pts[i * 3 + 1], z0 = pts[i * 3 + 2];
      let x1: number, y1: number, z1: number;
      if (i < n - 1) {
        x1 = pts[i * 3 + 3]; y1 = pts[i * 3 + 4]; z1 = pts[i * 3 + 5];
      } else if (endX !== undefined && endY !== undefined && endZ !== undefined) {
        x1 = endX; y1 = endY; z1 = endZ;
      } else break;
      let dx = x1 - x0;
      if (dx > 0.5) dx -= 1;
      else if (dx < -0.5) dx += 1;
      const dy = y1 - y0;
      const k = 1 / (Math.cosh(Math.PI * (1 - 2 * y0)) / 40075016.686);
      const dist = Math.hypot(dx, dy) * k;
      if (dist < 1 || dist > 400000) continue;
      scene.add(M.Segment, x0, y0, z0, Math.atan2(dx, -dy), width, dist, z1 - z0, 0, color);
    }
  }

  // ----------------------------------------------------------- selection

  selectionFor(ref: unknown): Selection | null {
    if (!(ref instanceof Plane)) return null;
    const p = ref;
    const layer = this;
    return {
      layer: this.id,
      id: p.hex,
      badge: t('live'),
      // Close enough to see the aircraft itself while it taxis; a wider view of its flight in the air.
      zoom: p.ground ? 17.5 : 12,
      title: () => p.flight || p.reg || p.hex.toUpperCase(),
      subtitle: () => {
        const model = p.airframe?.type ? `${p.airframe.manufacturer ?? ''} ${p.airframe.type}`.trim() : p.info.name || p.type || t('unknownType');
        return model;
      },
      rows: () => layer.describe(p),
      position: () => (layer.planes.has(p.hex) ? { lat: p.mover.lat, lon: p.mover.lon } : null),
    };
  }

  private describe(p: Plane): InfoRow[] {
    const rows: InfoRow[] = [];
    const r = p.route;
    if (r?.origin && r.destination) {
      rows.push({ label: t('route'), value: `${r.origin.iata_code || r.origin.icao_code} → ${r.destination.iata_code || r.destination.icao_code}` });
      rows.push({ label: t('from'), value: `${r.origin.municipality} · ${r.origin.name}` });
      rows.push({ label: t('to'), value: `${r.destination.municipality} · ${r.destination.name}` });
    } else if (r === undefined && p.flight) {
      rows.push({ label: t('route'), value: '…' });
    }
    const op = p.airframe?.registered_owner ?? r?.airline;
    if (op) rows.push({ label: t('operator'), value: op });
    if (p.reg) rows.push({ label: t('registration'), value: p.reg });
    if (p.type) rows.push({ label: t('icaoType'), value: p.type });
    rows.push({
      label: t('altitude'),
      value: p.ground ? t('onGround') : `${Math.round(p.alt).toLocaleString()} m · ${Math.round(p.alt / FT / 100) * 100} ft`,
    });
    rows.push({ label: t('speed'), value: `${Math.round(p.gsKt * 1.852)} km/h · ${Math.round(p.gsKt)} kt` });
    if (!p.ground && Math.abs(p.vrate) > 150) {
      rows.push({ label: t('vertical'), value: `${p.vrate > 0 ? '↑' : '↓'} ${Math.abs(Math.round(p.vrate * FT))} m/min` });
    }
    rows.push({ label: t('heading'), value: `${Math.round(p.mover.heading)}°` });
    if (p.squawk) rows.push({ label: 'Squawk', value: p.squawk });
    rows.push({ label: 'ICAO 24-bit', value: p.hex.toUpperCase() });
    return rows;
  }

  onSelect(sel: Selection | null): void {
    const p = sel && sel.layer === this.id ? (this.planes.get(sel.id) ?? null) : null;
    this.selected = p;
    this.routeDirty = true;
    if (!p) {
      this.setRoute(null);
      return;
    }
    if (p.route === undefined && p.flight) {
      void getJson<{ response?: { flightroute?: { airline?: { name: string }; origin: Airport; destination: Airport } } }>(
        `/api/flight/route?cs=${encodeURIComponent(p.flight)}`,
      ).then((d) => {
        const fr = d?.response?.flightroute;
        p.route = fr ? { airline: fr.airline?.name, origin: fr.origin, destination: fr.destination } : null;
        this.routeDirty = true;
      });
    } else if (!p.flight) {
      p.route = null;
    }
    if (p.airframe === undefined) {
      void getJson<{ response?: { aircraft?: Airframe } }>(`/api/flight/aircraft?hex=${p.hex}`).then((d) => {
        p.airframe = d?.response?.aircraft ?? null;
      });
    }
    if (!p.history.length && !p.ground) {
      void getJson<{ path?: [number, number | null, number | null, number | null, number | null, boolean][] }>(
        `/api/flight/track?hex=${p.hex}`,
      ).then((d) => {
        if (!d?.path?.length) return;
        const firstOwn = p.trail.length ? p.seen - 1 : Infinity;
        const out: number[] = [];
        for (const [time, lat, lon, alt] of d.path) {
          if (lat === null || lon === null || time * 1000 > firstOwn) continue;
          out.push(mercX(lon), mercY(lat), Math.max(0, alt ?? 0));
        }
        // Only keep it if it plausibly joins up with what we have seen ourselves.
        if (out.length >= 6 && p.trail.length >= 3) {
          const gap = Math.abs(out[out.length - 3] - p.trail[0]) + Math.abs(out[out.length - 2] - p.trail[1]);
          if (gap < 0.02) p.history = out;
        }
      });
    }
  }

  /** Planned route: origin → aircraft (flown) → destination (remaining). */
  private drawRoute(now: number): void {
    this.routeDirty = false;
    this.routeDrawn = now;
    const p = this.selected;
    if (!p?.route?.origin || !p.route.destination) {
      this.setRoute(null);
      return;
    }
    const { origin: o, destination: d } = p.route;
    const { lat, lon } = p.mover;
    // Some route databases are out of date; do not draw a route the aircraft is clearly not on.
    const direct = haversine(o.latitude, o.longitude, d.latitude, d.longitude);
    const via = haversine(o.latitude, o.longitude, lat, lon) + haversine(lat, lon, d.latitude, d.longitude);
    if (via > direct * 1.6 + 150000) {
      this.setRoute(null);
      return;
    }
    const feature = (coords: [number, number][], kind: string) => ({
      type: 'Feature' as const,
      properties: { kind },
      geometry: { type: 'LineString' as const, coordinates: coords },
    });
    const point = (a: Airport, kind: string) => ({
      type: 'Feature' as const,
      properties: { kind, label: `${a.iata_code || a.icao_code} · ${a.municipality}` },
      geometry: { type: 'Point' as const, coordinates: [a.longitude, a.latitude] },
    });
    void bearing;
    this.setRoute({
      type: 'FeatureCollection',
      features: [
        feature(greatCircle(o.latitude, o.longitude, lat, lon), 'flown'),
        feature(greatCircle(lat, lon, d.latitude, d.longitude), 'ahead'),
        point(o, 'origin'),
        point(d, 'destination'),
      ],
    });
  }

  private setRoute(data: GeoJSON.FeatureCollection | null): void {
    const src = this.ctx.map.getSource('route') as { setData(d: GeoJSON.FeatureCollection): void } | undefined;
    src?.setData(data ?? { type: 'FeatureCollection', features: [] });
  }
}
