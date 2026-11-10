// Road traffic and pedestrians. THESE ARE NOT REAL VEHICLES OR PEOPLE.
// There is no open, world-wide feed of individual cars or pedestrians (and
// there should not be). What is drawn here is an illustration: agents moving
// along the real street geometry, with density and speed estimated from the
// local time of day, the day of the week and the class of each street.

import type { Map as MlMap } from 'maplibre-gl';
import { viewBounds, type Ctx, type Layer, type LayerState } from '../core';
import type { FrameInfo, Scene } from '../gl/instanced';
import { M } from '../gl/meshes';
import { hsl, mercScale, mercX, mercY, mulberry, solarHour } from '../util/geo';
import { t } from '../util/i18n';

const enum Cls {
  Motorway,
  Trunk,
  Primary,
  Secondary,
  Tertiary,
  Minor,
  Service,
  Path,
}

const CLASS: Record<string, Cls> = {
  motorway: Cls.Motorway,
  trunk: Cls.Trunk,
  primary: Cls.Primary,
  secondary: Cls.Secondary,
  tertiary: Cls.Tertiary,
  minor: Cls.Minor,
  service: Cls.Service,
  path: Cls.Path,
};

// Per class: cars per km per direction at peak, free-flow speed (m/s),
// half-width of the carriageway (m), pedestrians per km at peak.
const CARS = [30, 22, 16, 10, 6, 2.5, 0.5, 0];
const SPEED = [27, 20, 13.5, 11, 9, 6.5, 3, 0];
const HALF_WIDTH = [7, 6, 5.5, 4.5, 3.8, 3, 2, 1];
const WALKERS = [0, 0, 16, 16, 12, 7, 2, 18];

interface Road {
  key: string;
  x: Float64Array;
  y: Float64Array;
  /** Cumulative length in metres at each vertex. */
  cum: Float32Array;
  len: number;
  cls: Cls;
  oneway: boolean;
  startNode: string;
  endNode: string;
}

const bump = (h: number, mid: number, sd: number): number => {
  let d = Math.abs(h - mid);
  if (d > 12) d = 24 - d;
  return Math.exp(-0.5 * (d / sd) ** 2);
};

/** 0..1 share of peak road traffic for a local hour. */
export function carDemand(hour: number, weekend: boolean): number {
  const v = weekend
    ? 0.05 + 0.6 * bump(hour, 14, 4.2) + 0.2 * bump(hour, 21, 2.5)
    : 0.05 + 0.5 * bump(hour, 13, 5) + 0.5 * bump(hour, 8, 1.3) + 0.55 * bump(hour, 17.8, 1.6) + 0.15 * bump(hour, 21, 2);
  return Math.min(1, v);
}

/** 0..1 share of peak footfall for a local hour. */
export function walkDemand(hour: number, weekend: boolean): number {
  const v = weekend
    ? 0.03 + 0.85 * bump(hour, 15, 3.6) + 0.25 * bump(hour, 21, 2)
    : 0.03 + 0.7 * bump(hour, 13, 3.8) + 0.3 * bump(hour, 8.3, 1.1) + 0.4 * bump(hour, 18.3, 1.8);
  return Math.min(1, v);
}

/** Rough list of places that drive on the left: [west, south, east, north]. */
const LEFT_HAND: [number, number, number, number][] = [
  [-11, 49.8, 2, 61], // UK & Ireland
  [129, 30, 146, 46], // Japan
  [112, -44, 154, -10], // Australia
  [166, -48, 179, -34], // New Zealand
  [68, 6, 90, 36], // India, Sri Lanka, Bangladesh (approx.)
  [95, -11, 141, 6], // Indonesia, Malaysia, Singapore
  [97.3, 5.5, 105.7, 20.5], // Thailand
  [16, -35, 41, -8], // Southern & East Africa (approx.)
];
const drivesLeft = (lat: number, lon: number): boolean => LEFT_HAND.some((b) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3]);

/** The street network currently on screen, read from the map's own vector tiles. */
export class RoadNet {
  roads: Road[] = [];
  nodes = new Map<string, number[]>();
  version = 0;
  left = false;
  private dirty = true;
  private timer = 0;

  constructor(private readonly map: MlMap, private readonly sourceId: () => string | null) {
    const mark = () => {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => (this.dirty = true), 350);
    };
    map.on('moveend', mark);
    map.on('sourcedata', (e) => {
      if (e.isSourceLoaded && e.sourceId === this.sourceId()) mark();
    });
  }

  /** Rebuilds if the view changed. Cheap to call every frame. */
  refresh(zoom: number): void {
    if (!this.dirty) return;
    this.dirty = false;
    const src = this.sourceId();
    if (zoom < 13.4 || !src) {
      if (this.roads.length) {
        this.roads = [];
        this.nodes.clear();
        this.version++;
      }
      return;
    }
    let feats: ReturnType<MlMap['querySourceFeatures']>;
    try {
      feats = this.map.querySourceFeatures(src, { sourceLayer: 'transportation' });
    } catch {
      return;
    }
    const b = viewBounds(this.map, 0.12);
    const roads: Road[] = [];
    const seen = new Set<string>();
    const node = (lon: number, lat: number) => `${lon.toFixed(5)},${lat.toFixed(5)}`;
    for (const f of feats) {
      const p = f.properties as { class?: string; brunnel?: string; oneway?: number; subclass?: string; access?: string };
      const cls = CLASS[p.class ?? ''];
      if (cls === undefined || p.brunnel === 'tunnel') continue;
      if (cls === Cls.Path && p.subclass && !/footway|pedestrian|path|steps/.test(p.subclass)) continue;
      const g = f.geometry;
      const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
      for (const line of lines) {
        if (line.length < 2) continue;
        let minX = 180, maxX = -180, minY = 90, maxY = -90;
        for (const c of line) {
          if (c[0] < minX) minX = c[0];
          if (c[0] > maxX) maxX = c[0];
          if (c[1] < minY) minY = c[1];
          if (c[1] > maxY) maxY = c[1];
        }
        if (maxX < b[0] || minX > b[2] || maxY < b[1] || minY > b[3]) continue;
        const a = line[0];
        const z = line[line.length - 1];
        const startNode = node(a[0], a[1]);
        const endNode = node(z[0], z[1]);
        const key = `${cls}|${startNode}|${endNode}|${line.length}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const n = line.length;
        const x = new Float64Array(n);
        const y = new Float64Array(n);
        const cum = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          x[i] = mercX(line[i][0]);
          y[i] = mercY(line[i][1]);
          if (i) cum[i] = cum[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]) / mercScale(y[i]);
        }
        const len = cum[n - 1];
        if (len < 4) continue;
        roads.push({ key, x, y, cum, len, cls, oneway: p.oneway === 1 || cls === Cls.Motorway, startNode, endNode });
      }
    }
    const nodes = new Map<string, number[]>();
    roads.forEach((r, i) => {
      for (const k of [r.startNode, r.endNode]) {
        const list = nodes.get(k);
        if (list) list.push(i);
        else nodes.set(k, [i]);
      }
    });
    this.roads = roads;
    this.nodes = nodes;
    const c = this.map.getCenter();
    this.left = drivesLeft(c.lat, c.lng);
    this.version++;
  }
}

const CAR_COLORS = [0xf1f3f5, 0xf1f3f5, 0xdee2e6, 0x212529, 0x212529, 0x868e96, 0xadb5bd, 0xc92a2a, 0x1c7ed6, 0x2b8a3e, 0xe8590c, 0xfcc419];

abstract class Agents implements Layer {
  abstract readonly id: string;
  enabled = true;
  count = 0;
  state: LayerState = 'idle';
  hint = '';

  protected n = 0;
  protected road = new Int32Array(0);
  protected pos = new Float32Array(0);
  protected dir = new Int8Array(0);
  protected vel = new Float32Array(0);
  protected side = new Float32Array(0);
  protected color = new Int32Array(0);
  protected kind = new Uint8Array(0);
  protected elev = new Float32Array(0);
  protected elevAt = new Float64Array(0);
  protected keys: string[] = [];
  protected weights = new Float32Array(0);
  protected totalWeight = 0;
  protected version = -1;
  protected demand = 0;
  protected checked = 0;
  protected readonly rnd = mulberry(0x51f15e);

  constructor(protected readonly ctx: Ctx, protected readonly net: RoadNet) {}

  protected abstract readonly minZoom: number;
  protected abstract cap(): number;
  /** Agents per km for a street class (one direction). */
  protected abstract perKm(cls: Cls): number;
  protected abstract demandNow(hour: number, weekend: boolean): number;
  protected abstract init(i: number, r: Road): void;
  protected abstract draw(scene: Scene, frame: FrameInfo, i: number, mx: number, my: number, heading: number): void;
  protected abstract atEnd(i: number, r: Road): boolean;

  private grow(n: number): void {
    if (n <= this.road.length) return;
    const size = Math.max(n, this.road.length * 2, 64);
    const copy = <T extends Int32Array | Float32Array | Int8Array | Uint8Array | Float64Array>(old: T, Ctor: new (n: number) => T): T => {
      const next = new Ctor(size);
      next.set(old);
      return next;
    };
    this.road = copy(this.road, Int32Array);
    this.pos = copy(this.pos, Float32Array);
    this.dir = copy(this.dir, Int8Array);
    this.vel = copy(this.vel, Float32Array);
    this.side = copy(this.side, Float32Array);
    this.color = copy(this.color, Int32Array);
    this.kind = copy(this.kind, Uint8Array);
    this.elev = copy(this.elev, Float32Array);
    this.elevAt = copy(this.elevAt, Float64Array);
  }

  protected spawn(i: number): void {
    // Pick a street with probability proportional to how busy it should be.
    let target = this.rnd() * this.totalWeight;
    let lo = 0;
    let hi = this.weights.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.weights[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    target = 0;
    const r = this.net.roads[lo];
    this.road[i] = lo;
    this.pos[i] = this.rnd() * r.len;
    this.dir[i] = r.oneway || this.rnd() < 0.5 ? 1 : -1;
    this.elevAt[i] = 0;
    this.elev[i] = 0;
    this.init(i, r);
  }

  /** Re-attaches agents to the new network after the view moved. */
  private rebind(): void {
    const roads = this.net.roads;
    const weights = new Float32Array(roads.length);
    let total = 0;
    roads.forEach((r, i) => {
      total += (r.len / 1000) * this.perKm(r.cls) * (r.oneway ? 1 : 2);
      weights[i] = total;
    });
    const index = new Map<string, number>();
    roads.forEach((r, i) => index.set(r.key, i));
    const oldKeys = this.keys;
    this.weights = weights;
    this.totalWeight = total;
    this.keys = roads.map((r) => r.key);
    if (!total) {
      this.n = 0;
      return;
    }
    for (let i = 0; i < this.n; i++) {
      const kept = index.get(oldKeys[this.road[i]]);
      if (kept !== undefined) this.road[i] = kept;
      else this.spawn(i);
    }
  }

  tick(frame: FrameInfo): void {
    if (!this.enabled) return;
    this.net.refresh(frame.zoom);
    if (this.net.version !== this.version) {
      this.version = this.net.version;
      this.rebind();
      this.checked = 0;
    }
    if (frame.now - this.checked > 2000) {
      this.checked = frame.now;
      const local = new Date(frame.now + (frame.lon / 15) * 3600000);
      const day = local.getUTCDay();
      this.demand = this.demandNow(solarHour(frame.lon, frame.now), day === 0 || day === 6);
      const active = frame.zoom >= this.minZoom && this.totalWeight > 0;
      const want = active ? Math.min(Math.round(this.cap() * this.ctx.tier.density), Math.round(this.totalWeight * this.demand)) : 0;
      this.grow(want);
      for (let i = this.n; i < want; i++) this.spawn(i);
      this.n = want;
      this.count = want;
      this.state = want ? 'estimate' : 'idle';
      this.hint = frame.zoom < this.minZoom ? t('hintZoomIn') : `${t('hintEstimated')} · ${Math.round(this.demand * 100)}%`;
    }
  }

  emit(scene: Scene, frame: FrameInfo): void {
    if (!this.enabled || frame.zoom < this.minZoom || !this.n) return;
    const roads = this.net.roads;
    const sign = this.net.left ? -1 : 1;
    const terrain = this.ctx.tier.terrain;
    for (let i = 0; i < this.n; i++) {
      let r = roads[this.road[i]];
      if (!r) {
        this.spawn(i);
        r = roads[this.road[i]];
      }
      let s = this.pos[i] + this.vel[i] * frame.dt * this.dir[i];
      if (s < 0 || s > r.len) {
        if (!this.atEnd(i, r)) this.spawn(i);
        r = roads[this.road[i]];
        s = this.pos[i];
      } else {
        this.pos[i] = s;
      }
      // Locate the segment containing s.
      const cum = r.cum;
      let lo = 0;
      let hi = cum.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= s) lo = mid;
        else hi = mid;
      }
      const f = (s - cum[lo]) / Math.max(1e-6, cum[hi] - cum[lo]);
      let dx = r.x[hi] - r.x[lo];
      let dy = r.y[hi] - r.y[lo];
      let mx = r.x[lo] + dx * f;
      let my = r.y[lo] + dy * f;
      if (this.dir[i] < 0) {
        dx = -dx;
        dy = -dy;
      }
      const heading = Math.atan2(dx, -dy);
      const off = this.side[i] * sign * mercScale(my);
      mx += Math.cos(heading) * off;
      my += Math.sin(heading) * off;
      if (terrain && frame.now > this.elevAt[i]) {
        this.elevAt[i] = frame.now + 1200 + this.rnd() * 800;
        const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * (180 / Math.PI);
        this.elev[i] = this.ctx.elevAt(lat, mx * 360 - 180);
      }
      this.draw(scene, frame, i, mx, my, heading);
    }
  }

  /** Moves agent `i` onto a street that meets the end it just reached. */
  protected hop(i: number, r: Road, allow: (next: Road) => boolean): boolean {
    const roads = this.net.roads;
    const nodeKey = this.dir[i] > 0 ? r.endNode : r.startNode;
    const options = this.net.nodes.get(nodeKey);
    if (!options || options.length < 2) return false;
    const current = this.road[i];
    for (let tries = 0; tries < 4; tries++) {
      const j = options[Math.floor(this.rnd() * options.length)];
      if (j === current) continue;
      const next = roads[j];
      if (!allow(next)) continue;
      const fromStart = next.startNode === nodeKey;
      if (next.oneway && !fromStart) continue;
      this.road[i] = j;
      this.dir[i] = fromStart ? 1 : -1;
      this.pos[i] = fromStart ? 0 : next.len;
      return true;
    }
    return false;
  }
}

export class TrafficLayer extends Agents {
  readonly id = 'traffic';
  protected readonly minZoom = 13.5;
  protected cap(): number {
    return 1800;
  }
  protected perKm(cls: Cls): number {
    return CARS[cls];
  }
  protected demandNow(hour: number, weekend: boolean): number {
    return carDemand(hour, weekend);
  }
  protected init(i: number, r: Road): void {
    // Busier hours mean slower arterials.
    const congestion = r.cls <= Cls.Tertiary ? 1 - 0.55 * this.demand ** 2 : 1;
    this.vel[i] = SPEED[r.cls] * congestion * (0.8 + this.rnd() * 0.4);
    const lanes = r.cls <= Cls.Trunk ? 3 : r.cls <= Cls.Secondary ? 2 : 1;
    const lane = Math.floor(this.rnd() * lanes);
    this.side[i] = r.oneway ? (lane - (lanes - 1) / 2) * 3.3 : 1.7 + lane * 3.3;
    this.kind[i] = r.cls <= Cls.Primary && this.rnd() < 0.08 ? 1 : 0;
    this.color[i] = this.kind[i] ? [0xc92a2a, 0x1864ab, 0xf1f3f5, 0x2b8a3e][Math.floor(this.rnd() * 4)] : CAR_COLORS[Math.floor(this.rnd() * CAR_COLORS.length)];
  }
  protected atEnd(i: number, r: Road): boolean {
    const ok = this.hop(i, r, (next) => next.cls !== Cls.Path);
    if (ok) this.init(i, this.net.roads[this.road[i]]);
    return ok;
  }
  protected draw(scene: Scene, frame: FrameInfo, i: number, mx: number, my: number, heading: number): void {
    const truck = this.kind[i] === 1;
    const len = truck ? 8.4 : 4.4;
    const minPx = frame.zoom < 15 ? 4 : 6;
    const scale = Math.max(1, (minPx * frame.mpp) / len);
    scene.add(truck ? M.Truck : M.Car, mx, my, this.elev[i], heading, scale, scale, 0, this.color[i], 0);
  }
}

export class PeopleLayer extends Agents {
  readonly id = 'people';
  protected readonly minZoom = 15.3;
  protected cap(): number {
    return 1400;
  }
  protected perKm(cls: Cls): number {
    return WALKERS[cls];
  }
  protected demandNow(hour: number, weekend: boolean): number {
    return walkDemand(hour, weekend);
  }
  protected init(i: number, r: Road): void {
    this.vel[i] = 1.0 + this.rnd() * 0.7;
    // On streets, walk on the pavement either side; on footpaths, anywhere across it.
    this.side[i] = r.cls === Cls.Path ? (this.rnd() - 0.5) * 2 : (this.rnd() < 0.5 ? -1 : 1) * (HALF_WIDTH[r.cls] + 0.8 + this.rnd() * 1.4);
    this.color[i] = hsl(Math.floor(this.rnd() * 360), 0.35 + this.rnd() * 0.4, 0.3 + this.rnd() * 0.35);
  }
  protected atEnd(i: number, r: Road): boolean {
    const side = this.side[i];
    if (this.hop(i, r, (next) => WALKERS[next.cls] > 0)) {
      const next = this.net.roads[this.road[i]];
      this.side[i] = next.cls === Cls.Path ? Math.max(-1, Math.min(1, side)) : Math.sign(side || 1) * (HALF_WIDTH[next.cls] + 1.2);
      return true;
    }
    // Dead end: turn around.
    this.dir[i] = (this.dir[i] > 0 ? -1 : 1) as 1 | -1;
    this.pos[i] = Math.max(0, Math.min(r.len, this.pos[i]));
    this.side[i] = -side;
    return true;
  }
  protected draw(scene: Scene, frame: FrameInfo, i: number, mx: number, my: number, heading: number): void {
    const scale = Math.max(1, (3.2 * frame.mpp) / 1.75);
    scene.add(M.Person, mx, my, this.elev[i], heading, scale, scale, 0, this.color[i], 0);
  }
}
