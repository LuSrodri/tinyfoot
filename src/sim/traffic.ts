// Road traffic and pedestrians. THESE ARE NOT REAL VEHICLES OR PEOPLE.
// There is no open, world-wide feed of individual cars or pedestrians (and
// there should not be). What is drawn here is an illustration: agents moving
// along the real street geometry, with density and speed estimated from the
// local time of day, the day of the week and the class of each street.

import { type Ctx, type Layer, type LayerState } from '../core';
import { registerMesh } from '../data/aircraftTypes';
import { cachedMesh } from '../gl/meshcache';
import type { WorldMap } from '../world/world';
import type { FrameInfo, Scene } from '../gl/instanced';
import { M, buildCar, type BodyType } from '../gl/meshes';
import { DEG, hash, hsl, mercScale, mercX, mercY, mulberry, solarHour } from '../util/geo';
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
  /** Height of the deck above its banks, in metres (0 for a road on the ground). */
  lift: number;
  /** Whether the road climbs from / descends to the ground at its start and end. */
  rampA: boolean;
  rampB: boolean;
  /** Elevation of the banks; found the first time it is needed. */
  baseZ: number;
  /** Piers as [mercX, mercY, groundZ, heading] quads; built lazily. */
  piers: Float64Array | null;
  /** Street lamps as [mercX, mercY, metres along] triples; built lazily. */
  lamps: Float64Array | null;
}

const smooth = (v: number): number => {
  const c = Math.max(0, Math.min(1, v));
  return c * c * (3 - 2 * c);
};

/** How far above its banks the deck is, `s` metres along the road. */
function liftAt(r: Road, s: number): number {
  if (!r.lift) return 0;
  const ramp = Math.min(70, r.len * 0.45);
  let f = 1;
  if (r.rampA) f = Math.min(f, smooth(s / ramp));
  if (r.rampB) f = Math.min(f, smooth((r.len - s) / ramp));
  return r.lift * f;
}

const latOf = (my: number): number => Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * (180 / Math.PI);

/** Absolute elevation of a bridge deck. A bridge stays level between its banks instead of following the valley. */
function bridgeZ(ctx: Ctx, r: Road, s: number): number {
  if (Number.isNaN(r.baseZ)) {
    const n = r.x.length - 1;
    r.baseZ = Math.max(ctx.elevAt(latOf(r.y[0]), r.x[0] * 360 - 180), ctx.elevAt(latOf(r.y[n]), r.x[n] * 360 - 180));
  }
  return r.baseZ + liftAt(r, s);
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

/** OpenStreetMap highway values mapped to the simulation's street classes. */
const OSM_CLASS: Record<string, Cls> = {
  motorway: Cls.Motorway, motorway_link: Cls.Motorway, trunk: Cls.Trunk, trunk_link: Cls.Trunk,
  primary: Cls.Primary, primary_link: Cls.Primary, secondary: Cls.Secondary, secondary_link: Cls.Secondary,
  tertiary: Cls.Tertiary, tertiary_link: Cls.Tertiary, unclassified: Cls.Minor, residential: Cls.Minor,
  living_street: Cls.Minor, service: Cls.Service, pedestrian: Cls.Path, footway: Cls.Path, path: Cls.Path, steps: Cls.Path,
};

interface OsmWay {
  type: string;
  id: number;
  nodes: number[];
  geometry: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

const TILE_Z = 15;

/** The street network around the view, from OpenStreetMap (one z15 tile at a time, cached by the server). */
export class RoadNet {
  roads: Road[] = [];
  nodes = new Map<string, number[]>();
  version = 0;
  left = false;
  private dirty = true;
  private timer = 0;
  private tiles = new Map<string, OsmWay[] | 'loading' | 'failed'>();
  private loaded = '';

  constructor(private readonly map: WorldMap) {
    const mark = () => {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => (this.dirty = true), 300);
    };
    map.on('moveend', mark);
  }

  /** z15 tiles covering the view, nearest to the centre first (at most four). */
  private wanted(): [number, number][] {
    const b = this.map.getBounds();
    const c = this.map.getCenter();
    const n = 2 ** TILE_Z;
    const tx = (lon: number) => Math.floor(((lon + 180) / 360) * n);
    const ty = (lat: number) => Math.floor(((1 - Math.log(Math.tan(lat * DEG) + 1 / Math.cos(lat * DEG)) / Math.PI) / 2) * n);
    const cx = tx(c.lng), cy = ty(c.lat);
    const list: [number, number, number][] = [];
    for (let x = tx(b.getWest()); x <= tx(b.getEast()); x++) {
      for (let y = ty(b.getNorth()); y <= ty(b.getSouth()); y++) list.push([x, y, Math.hypot(x - cx, y - cy)]);
    }
    return list.sort((a, d) => a[2] - d[2]).slice(0, 4).map(([x, y]) => [x, y]);
  }

  private fetchTile(x: number, y: number): void {
    const key = `${x}/${y}`;
    this.tiles.set(key, 'loading');
    void fetch(`/api/roads?x=${x}&y=${y}`, { signal: AbortSignal.timeout(30000) })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { elements?: OsmWay[] }) => {
        this.tiles.set(key, (j.elements ?? []).filter((e) => e.type === 'way' && e.geometry?.length > 1));
        this.dirty = true;
      })
      .catch(() => {
        this.tiles.set(key, 'failed');
        // Allow another try later.
        window.setTimeout(() => this.tiles.delete(key), 30000);
      });
  }

  /** Rebuilds if the view changed. Cheap to call every frame. */
  refresh(zoom: number): void {
    if (!this.dirty) return;
    this.dirty = false;
    if (zoom < 14.9) {
      if (this.roads.length) {
        this.roads = [];
        this.nodes.clear();
        this.loaded = '';
        this.version++;
      }
      return;
    }
    const want = this.wanted();
    let pending = false;
    for (const [x, y] of want) {
      const t = this.tiles.get(`${x}/${y}`);
      if (t === undefined) {
        if (![...this.tiles.values()].includes('loading')) this.fetchTile(x, y);
        pending = true;
      } else if (t === 'loading') pending = true;
    }
    if (pending) {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => (this.dirty = true), 400);
    }
    const ready = want.map(([x, y]) => `${x}/${y}`).filter((k) => Array.isArray(this.tiles.get(k)));
    const signature = ready.join('|');
    if (!ready.length || signature === this.loaded) return;
    this.loaded = signature;
    // Forget far-away tiles.
    if (this.tiles.size > 24) for (const k of [...this.tiles.keys()].slice(0, this.tiles.size - 24)) this.tiles.delete(k);

    // Ways from all ready tiles, each once.
    const ways = new Map<number, OsmWay>();
    for (const k of ready) for (const w of this.tiles.get(k) as OsmWay[]) ways.set(w.id, w);
    // Split ways where they meet other ways, so that agents can turn at every junction.
    const uses = new Map<number, number>();
    for (const w of ways.values()) for (const id of w.nodes) uses.set(id, (uses.get(id) ?? 0) + 1);

    const roads: Road[] = [];
    for (const w of ways.values()) {
      const tags = w.tags ?? {};
      const cls = OSM_CLASS[tags.highway ?? ''];
      if (cls === undefined || tags.tunnel === 'yes' || tags.tunnel === 'building_passage' || tags.area === 'yes') continue;
      const reverse = tags.oneway === '-1';
      const oneway = reverse || tags.oneway === 'yes' || tags.oneway === '1' || tags.junction === 'roundabout' || cls === Cls.Motorway;
      const bridge = tags.bridge !== undefined && tags.bridge !== 'no';
      const lift = bridge ? 6.5 + 5.5 * Math.max(0, (Number(tags.layer) || 1) - 1) : 0;
      let pts = w.geometry.map((g, i) => ({ lat: g.lat, lon: g.lon, id: w.nodes[i] }));
      if (reverse) pts = pts.reverse();
      let start = 0;
      for (let i = 1; i < pts.length; i++) {
        if (i < pts.length - 1 && (uses.get(pts[i].id) ?? 0) < 2) continue;
        const part = pts.slice(start, i + 1);
        start = i;
        const n = part.length;
        const x = new Float64Array(n);
        const y = new Float64Array(n);
        const cum = new Float32Array(n);
        for (let k = 0; k < n; k++) {
          x[k] = mercX(part[k].lon);
          y[k] = mercY(part[k].lat);
          if (k) cum[k] = cum[k - 1] + Math.hypot(x[k] - x[k - 1], y[k] - y[k - 1]) / mercScale(y[k]);
        }
        const len = cum[n - 1];
        if (len < 3) continue;
        const startNode = String(part[0].id);
        const endNode = String(part[n - 1].id);
        roads.push({ key: `${w.id}:${startNode}:${endNode}`, x, y, cum, len, cls, oneway, startNode, endNode, lift, rampA: true, rampB: true, baseZ: NaN, piers: null, lamps: null });
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
    // A bridge only ramps down where it does not continue as another bridge piece.
    for (const road of roads) {
      if (!road.lift) continue;
      const continues = (k: string) => (nodes.get(k) ?? []).some((j) => roads[j] !== road && roads[j].lift > 0);
      road.rampA = !continues(road.startNode);
      road.rampB = !continues(road.endNode);
    }
    this.roads = roads;
    this.nodes = nodes;
    const c = this.map.getCenter();
    this.left = drivesLeft(c.lat, c.lng);
    this.version++;
  }

  /** A few points along main roads (open sky), for matching heights to the photographed surface. */
  probes(): [number, number][] {
    const out: [number, number][] = [];
    for (const r of this.roads) {
      if (r.cls > Cls.Tertiary || r.lift) continue;
      const k = Math.floor(r.x.length / 2);
      out.push([Math.atan(Math.sinh(Math.PI * (1 - 2 * r.y[k]))) / DEG, r.x[k] * 360 - 180]);
      if (out.length >= 60) break;
    }
    // Shuffle so successive calibrations look at different streets.
    return out.sort(() => Math.random() - 0.5);
  }
}

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
  protected col2 = new Int32Array(0);
  protected col3 = new Int32Array(0);
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
  /** Extra height of the agent being drawn, when it is on a bridge. */
  protected liftNow = 0;

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
    this.col2 = copy(this.col2, Int32Array);
    this.col3 = copy(this.col3, Int32Array);
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
      this.liftNow = r.lift ? bridgeZ(this.ctx, r, s) - this.elev[i] : 0;
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

// ---------------------------------------------------------------- regional fleets
// Which cars are on the road differs a lot from place to place. Each region lists its
// best-selling models with their real dimensions; simulated cars are drawn from that mix.
// Format: name | body (H hatch, S saloon, U SUV, P pick-up, V van, K kei/microcar, M motorcycle) | length | width | height | share

const FLEETS: Record<string, string> = {
  BR: 'Fiat Strada|P|4.47|1.73|1.6|9;VW Polo|H|4.07|1.75|1.47|8;Chevrolet Onix|H|4.16|1.73|1.47|8;Hyundai HB20|H|4.02|1.72|1.47|7;Fiat Argo|H|4|1.72|1.5|6;VW T-Cross|U|4.2|1.76|1.57|6;Hyundai Creta|U|4.3|1.79|1.63|5;Chevrolet Tracker|U|4.27|1.79|1.63|5;Fiat Mobi|H|3.57|1.63|1.5|5;Toyota Corolla|S|4.63|1.78|1.46|4;Toyota Hilux|P|5.33|1.86|1.82|4;Fiat Toro|P|4.95|1.84|1.68|4;Honda CG 160|M|2.03|0.74|1.1|14',
  US: 'Ford F-150|P|5.89|2.03|1.96|10;Chevrolet Silverado|P|5.89|2.06|1.92|8;Ram 1500|P|5.92|2.08|1.97|6;Toyota RAV4|U|4.6|1.86|1.7|7;Honda CR-V|U|4.69|1.87|1.69|6;Tesla Model Y|U|4.75|1.92|1.62|6;Toyota Camry|S|4.92|1.84|1.45|5;Honda Civic|S|4.67|1.8|1.42|4;Toyota Corolla|S|4.63|1.78|1.44|4;Chevrolet Equinox|U|4.65|1.84|1.66|4;Ford Explorer|U|5.05|2|1.78|3;Ford Transit|V|5.98|2.06|2.5|2',
  EU: 'VW Golf|H|4.28|1.79|1.46|8;Renault Clio|H|4.05|1.8|1.44|8;Dacia Sandero|H|4.09|1.85|1.5|8;Peugeot 208|H|4.06|1.75|1.43|7;Toyota Yaris|H|3.94|1.75|1.5|6;VW T-Roc|U|4.24|1.82|1.57|6;Tesla Model Y|U|4.75|1.92|1.62|6;Skoda Octavia|S|4.69|1.83|1.47|5;Fiat Panda|H|3.65|1.64|1.55|5;VW Tiguan|U|4.51|1.84|1.68|5;Ford Transit Custom|V|4.97|1.99|2|4;Piaggio Liberty|M|1.95|0.7|1.1|3',
  JP: 'Honda N-BOX|K|3.4|1.48|1.79|12;Suzuki Spacia|K|3.4|1.48|1.79|8;Daihatsu Tanto|K|3.4|1.48|1.76|7;Toyota Yaris|H|3.94|1.7|1.5|8;Toyota Corolla|S|4.5|1.75|1.44|7;Toyota Sienta|V|4.26|1.7|1.7|6;Toyota Prius|S|4.6|1.78|1.43|5;Toyota Alphard|V|5|1.85|1.94|4',
  CN: 'BYD Qin Plus|S|4.77|1.84|1.5|8;BYD Song Plus|U|4.71|1.89|1.66|7;Nissan Sylphy|S|4.64|1.82|1.45|7;Tesla Model Y|U|4.75|1.92|1.62|6;VW Lavida|S|4.68|1.81|1.47|6;BYD Seagull|H|3.78|1.72|1.54|6;Wuling Hongguang Mini EV|K|2.92|1.49|1.62|5;Haval H6|U|4.65|1.89|1.73|4;Yadea e-scooter|M|1.8|0.7|1.1|10',
  IN: 'Hero Splendor|M|2|0.72|1.05|16;Maruti Suzuki Swift|H|3.86|1.74|1.52|9;Maruti Suzuki WagonR|K|3.66|1.62|1.68|8;Tata Nexon|U|4|1.8|1.62|7;Hyundai Creta|U|4.33|1.79|1.64|6;Maruti Suzuki Baleno|H|3.99|1.75|1.5|6;Maruti Suzuki Dzire|S|3.99|1.74|1.52|5;Mahindra Scorpio|U|4.66|1.92|1.86|4',
  AU: 'Ford Ranger|P|5.37|1.92|1.88|9;Toyota Hilux|P|5.33|1.86|1.82|8;Toyota RAV4|U|4.6|1.86|1.7|7;Isuzu D-Max|P|5.27|1.87|1.79|5;Mazda CX-5|U|4.58|1.84|1.68|5;Toyota Corolla|H|4.37|1.79|1.44|4;Hyundai i30|H|4.34|1.8|1.46|3',
  XX: 'Toyota Corolla|S|4.63|1.78|1.45|8;Toyota Hilux|P|5.33|1.86|1.82|7;Toyota RAV4|U|4.6|1.86|1.7|6;Hyundai Tucson|U|4.5|1.87|1.65|5;Kia Sportage|U|4.52|1.87|1.65|5;VW Polo|H|4.07|1.75|1.47|5;Toyota Yaris|H|3.94|1.7|1.5|5;Honda CG 125|M|2|0.74|1.08|8',
};

/** [code, west, south, east, north], first match wins. */
const REGIONS: [string, number, number, number, number][] = [
  ['JP', 129, 30, 146, 46], ['IN', 68, 6, 90, 36], ['CN', 73, 18, 135, 54], ['AU', 112, -48, 179, -10],
  ['EU', -11, 35, 40, 71], ['US', -170, 24, -52, 72], ['BR', -82, -56, -34, 13],
];

interface Model {
  name: string;
  /** Index of the mesh; generated (and cached) the first time the model is needed. */
  mesh: number;
  /** Scale across/up and along the mesh (1 for generated cars, which are built to size). */
  sx: number;
  sy: number;
  moto: boolean;
}

/** Battery-electric models: a closed front, no grille. */
const ELECTRIC = /Tesla|BYD|Mini EV|Seagull/;

const fleets = new Map<string, { models: Model[]; cum: number[] }>();
function fleetFor(lat: number, lon: number): { models: Model[]; cum: number[] } {
  const code = REGIONS.find((r) => lon >= r[1] && lon <= r[3] && lat >= r[2] && lat <= r[4])?.[0] ?? 'XX';
  let fleet = fleets.get(code);
  if (!fleet) {
    const models: Model[] = [];
    const cum: number[] = [];
    let total = 0;
    for (const row of FLEETS[code].split(';')) {
      const [name, body, len, w, h, share] = row.split('|');
      if (body === 'M') {
        models.push({ name, mesh: M.Moto, sx: Number(w) / 0.74, sy: Number(len) / 2.1, moto: true });
      } else {
        const spec = { len: Number(len), w: Number(w), h: Number(h), body: body as BodyType, seed: (hash(name) % 1000) / 1000, electric: ELECTRIC.test(name) };
        models.push({ name, mesh: registerMesh(cachedMesh(`car:${name}:${len}`, () => buildCar(spec))), sx: 1, sy: 1, moto: false });
      }
      total += Number(share);
      cum.push(total);
    }
    fleet = { models, cum };
    fleets.set(code, fleet);
  }
  return fleet;
}

// Paint colours roughly in the proportions seen on the road.
const CAR_COLORS = [0xf1f3f5, 0xf1f3f5, 0xf1f3f5, 0xd0d4d9, 0xd0d4d9, 0x1b1d20, 0x1b1d20, 0x6c757d, 0x6c757d, 0xa61e1e, 0x1c4f9c, 0x8c6a3f, 0x2b6e4f];
const SKIN = [0xf6d7c3, 0xeec1a4, 0xe0ac8a, 0xc98f6b, 0xa9744f, 0x8a583a, 0x6a412b, 0x4a2c1d];
const TROUSERS = [0x1f2a44, 0x2b2b2e, 0x3d4a5c, 0x6b6257, 0x8d8371, 0x202020, 0x35507a, 0x5a3f2e];

export class TrafficLayer extends Agents {
  readonly id = 'traffic';
  protected readonly minZoom = 15.5;
  private fleet = fleetFor(0, 0);
  private models: Model[] = [];

  protected cap(): number {
    return 1600;
  }

  /** Viaducts and bridges: an elevated deck on piers, so traffic passes over and under. */
  override emit(scene: Scene, frame: FrameInfo): void {
    super.emit(scene, frame);
    if (!this.enabled || frame.zoom < this.minZoom) return;
    if (frame.night > 0.02) this.streetLights(scene, frame);
    let budget = 900;
    for (const r of this.net.roads) {
      if (!r.lift || r.cls === Cls.Path) continue;
      const width = HALF_WIDTH[r.cls] * 2 + 2.5;
      const n = r.x.length;
      for (let i = 0; i < n - 1 && budget > 0; i++, budget--) {
        const dx = r.x[i + 1] - r.x[i];
        const dy = r.y[i + 1] - r.y[i];
        const z0 = bridgeZ(this.ctx, r, r.cum[i]);
        const z1 = bridgeZ(this.ctx, r, r.cum[i + 1]);
        scene.add(M.Deck, r.x[i], r.y[i], z0 - 0.05, Math.atan2(dx, -dy), width, r.cum[i + 1] - r.cum[i] + 0.3, z1 - z0, 0, 0);
      }
      if (!r.piers) {
        // A pier every 30 m or so, wherever the deck is well clear of the ground.
        const list: number[] = [];
        for (let s = 15; s < r.len - 5; s += 30) {
          if (liftAt(r, s) < 3.5) continue;
          let k = 0;
          while (k < n - 2 && r.cum[k + 1] < s) k++;
          const f = (s - r.cum[k]) / Math.max(1e-6, r.cum[k + 1] - r.cum[k]);
          const px = r.x[k] + (r.x[k + 1] - r.x[k]) * f;
          const py = r.y[k] + (r.y[k + 1] - r.y[k]) * f;
          list.push(px, py, this.ctx.elevAt(latOf(py), px * 360 - 180), Math.atan2(r.x[k + 1] - r.x[k], -(r.y[k + 1] - r.y[k])), s);
        }
        r.piers = new Float64Array(list);
      }
      for (let k = 0; k + 4 < r.piers.length + 1 && k < r.piers.length; k += 5) {
        const ground = r.piers[k + 2];
        const height = bridgeZ(this.ctx, r, r.piers[k + 4]) - 0.9 - ground;
        if (height > 2) scene.add(M.Pier, r.piers[k], r.piers[k + 1], ground, r.piers[k + 3] + Math.PI / 2, height, width * 0.55, 0, 0, 0);
      }
    }
  }
  /** Where the street lamps of a road stand: alternating sides, closer together on main roads. */
  private lampsOf(r: Road): Float64Array {
    if (r.lamps) return r.lamps;
    const spacing = r.cls <= Cls.Secondary ? 30 : r.cls === Cls.Path ? 28 : r.cls === Cls.Service ? 45 : 36;
    const off = HALF_WIDTH[r.cls] + 0.6;
    const list: number[] = [];
    const n = r.x.length;
    let k = 0;
    let side = 1;
    for (let s = spacing / 2; s < r.len; s += spacing, side = -side) {
      while (k < n - 2 && r.cum[k + 1] < s) k++;
      const f = (s - r.cum[k]) / Math.max(1e-6, r.cum[k + 1] - r.cum[k]);
      const dx = r.x[k + 1] - r.x[k];
      const dy = r.y[k + 1] - r.y[k];
      const py = r.y[k] + dy * f;
      const h = Math.atan2(dx, -dy);
      const o = off * side * mercScale(py);
      list.push(r.x[k] + dx * f + Math.cos(h) * o, py + Math.sin(h) * o, s);
    }
    r.lamps = new Float64Array(list);
    return r.lamps;
  }

  /** At night, the warm pools of the street lamps along every street in view. */
  private streetLights(scene: Scene, frame: FrameInfo): void {
    const c = this.ctx.map.getCenter();
    const cx = mercX(c.lng);
    const cy = mercY(c.lat);
    const reach = frame.mpp * this.ctx.map.getCanvas().clientWidth * 1.1 * mercScale(cy);
    let budget = this.ctx.tier.quality === 'low' ? 900 : 2600;
    for (const r of this.net.roads) {
      const lamps = this.lampsOf(r);
      const size = r.cls <= Cls.Secondary ? 17 : 13;
      for (let k = 0; k < lamps.length && budget > 0; k += 3) {
        const x = lamps[k];
        const y = lamps[k + 1];
        if (Math.abs(x - cx) > reach || Math.abs(y - cy) > reach) continue;
        const z = r.lift ? bridgeZ(this.ctx, r, lamps[k + 2]) : this.ctx.elevAt(latOf(y), x * 360 - 180);
        scene.add(M.Glow, x, y, z + 0.25, 0, size, size, 0, 0xffc477, 0);
        budget--;
      }
    }
  }

  protected perKm(cls: Cls): number {
    return CARS[cls];
  }
  protected demandNow(hour: number, weekend: boolean): number {
    const c = this.ctx.map.getCenter();
    this.fleet = fleetFor(c.lat, c.lng);
    return carDemand(hour, weekend);
  }
  protected init(i: number, r: Road): void {
    // Busier hours mean slower arterials.
    const congestion = r.cls <= Cls.Tertiary ? 1 - 0.55 * this.demand ** 2 : 1;
    const lanes = r.cls <= Cls.Trunk ? 3 : r.cls <= Cls.Secondary ? 2 : 1;
    const lane = Math.floor(this.rnd() * lanes);
    this.side[i] = r.oneway ? (lane - (lanes - 1) / 2) * 3.3 : 1.7 + lane * 3.3;
    const truck = r.cls <= Cls.Primary && this.rnd() < 0.06;
    this.kind[i] = truck ? 255 : this.pick();
    const model = truck ? null : this.fleet.models[this.kind[i]];
    this.models[i] = model as Model;
    this.vel[i] = SPEED[r.cls] * congestion * (0.8 + this.rnd() * 0.4) * (model?.moto ? 1.15 : 1);
    if (model?.moto) this.side[i] += (this.rnd() - 0.5) * 1.6;
    this.color[i] = truck ? [0xc92a2a, 0x1864ab, 0xf1f3f5, 0x2b8a3e][Math.floor(this.rnd() * 4)] : CAR_COLORS[Math.floor(this.rnd() * CAR_COLORS.length)];
    this.col2[i] = model?.moto ? [0x1b1d20, 0xf1f3f5, 0xc92a2a, 0xf2c100][Math.floor(this.rnd() * 4)] : 0xb3261e;
    this.col3[i] = TROUSERS[Math.floor(this.rnd() * TROUSERS.length)];
  }
  private pick(): number {
    const { cum } = this.fleet;
    const x = this.rnd() * cum[cum.length - 1];
    let k = 0;
    while (cum[k] < x) k++;
    return k;
  }
  protected atEnd(i: number, r: Road): boolean {
    const ok = this.hop(i, r, (next) => next.cls !== Cls.Path);
    if (ok) {
      const next = this.net.roads[this.road[i]];
      const lanes = next.cls <= Cls.Trunk ? 3 : next.cls <= Cls.Secondary ? 2 : 1;
      const lane = Math.floor(this.rnd() * lanes);
      this.side[i] = next.oneway ? (lane - (lanes - 1) / 2) * 3.3 : 1.7 + lane * 3.3;
      this.vel[i] = SPEED[next.cls] * (0.8 + this.rnd() * 0.4);
    }
    return ok;
  }
  protected draw(scene: Scene, frame: FrameInfo, i: number, mx: number, my: number, heading: number): void {
    // Always real size: a four-metre car on a real-width street.
    const model = this.models[i];
    const z = this.elev[i] + this.liftNow;
    if (!model) scene.add(M.Truck, mx, my, z, heading, 1, 1, 0, this.color[i], 0xb3261e);
    else scene.add(model.mesh, mx, my, z, heading, model.sx, model.sy, 0, this.color[i], this.col2[i], this.col3[i]);
    if (frame.night > 0.05) {
      // Headlights on the road ahead.
      const moto = model?.moto ?? false;
      const ahead = (moto ? 4.5 : 7.5) * mercScale(my);
      scene.add(M.Glow, mx + Math.sin(heading) * ahead, my - Math.cos(heading) * ahead, z + 0.15, heading, moto ? 2.6 : 4.4, moto ? 7 : 10, 0, 0xfff0d0, 0);
    }
  }
}

export class PeopleLayer extends Agents {
  readonly id = 'people';
  protected readonly minZoom = 16.8;
  private height = new Float32Array(0);

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
    if (this.height.length < this.road.length) {
      const next = new Float32Array(this.road.length);
      next.set(this.height);
      this.height = next;
    }
    // People are not all alike: build, height, age, skin and clothes all vary.
    const child = this.rnd() < 0.08;
    this.height[i] = child ? 0.6 + this.rnd() * 0.2 : 0.87 + this.rnd() * 0.2;
    this.vel[i] = (child ? 0.9 : 1.05) + this.rnd() * 0.6;
    // On streets, walk on the pavement either side; on footpaths, anywhere across it.
    this.side[i] = r.cls === Cls.Path ? (this.rnd() - 0.5) * 2 : (this.rnd() < 0.5 ? -1 : 1) * (HALF_WIDTH[r.cls] + 0.8 + this.rnd() * 1.4);
    this.color[i] = hsl(Math.floor(this.rnd() * 360), 0.25 + this.rnd() * 0.5, 0.28 + this.rnd() * 0.5);
    this.col2[i] = SKIN[Math.floor(this.rnd() * SKIN.length)];
    this.col3[i] = TROUSERS[Math.floor(this.rnd() * TROUSERS.length)];
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
  protected draw(scene: Scene, _frame: FrameInfo, i: number, mx: number, my: number, heading: number): void {
    const h = this.height[i] || 1;
    scene.add(M.Person, mx, my, this.elev[i] + this.liftNow, heading, h, h, 0, this.color[i], this.col2[i], this.col3[i]);
  }
}
