// Ships from AIS transponders.
//  - Fintraffic / Digitraffic: open, key-less, covers the Baltic Sea around Finland.
//  - aisstream.io: world-wide, used when the server has an AISSTREAM_KEY configured.

import { getJson, inBounds, intersects, viewBounds, type Ctx, type InfoRow, type Layer, type LayerState, type Selection } from '../core';
import type { FrameInfo, Scene } from '../gl/instanced';
import { M } from '../gl/meshes';
import { DEG, hash, hsl, mercX, mercY } from '../util/geo';
import { Mover } from '../util/mover';
import { t, type Key } from '../util/i18n';

const BALTIC: [number, number, number, number] = [9, 53, 31.5, 66.5];
const KT = 0.514444;

interface Meta {
  name?: string;
  destination?: string;
  shipType?: number;
  callSign?: string;
  imo?: number;
  draught?: number;
  referencePointA?: number;
  referencePointB?: number;
}

class Ship {
  readonly mover = new Mover();
  name = '';
  sogKt = 0;
  cog = 0;
  seen = 0;
  meta?: Meta;
  length = 0;
  mesh = M.Ferry;
  c1 = 0x2f3e52;
  c2 = 0xc0392b;
  constructor(readonly mmsi: number) {}
}

function kind(type: number | undefined): Key {
  if (type === undefined) return 'other';
  if (type >= 70 && type <= 79) return 'cargo';
  if (type >= 80 && type <= 89) return 'tanker';
  if (type >= 60 && type <= 69) return 'passenger';
  if (type === 30) return 'fishing';
  if (type === 31 || type === 32 || type === 52) return 'tug';
  if (type === 36 || type === 37) return 'sailing';
  return 'other';
}

export class ShipLayer implements Layer {
  readonly id = 'ships';
  enabled = true;
  count = 0;
  state: LayerState = 'idle';
  hint = '';

  private ships = new Map<number, Ship>();
  private meta = new Map<number, Meta>();
  private metaLoaded = false;
  private nextBaltic = 0;
  private nextAis = 0;
  private busy = false;
  private planned = 0;
  private bounds: [number, number, number, number] = [0, 0, 0, 0];

  constructor(private readonly ctx: Ctx) {}

  private style(s: Ship): void {
    const m = s.meta;
    const k = kind(m?.shipType);
    const len = (m?.referencePointA ?? 0) + (m?.referencePointB ?? 0);
    s.length = len > 5 && len < 460 ? len : k === 'cargo' || k === 'tanker' ? 140 : k === 'passenger' ? 90 : 24;
    s.mesh = k === 'cargo' || k === 'tanker' ? M.Cargo : M.Ferry;
    const h = hash(String(s.mmsi));
    if (k === 'cargo') {
      s.c1 = [0x1f3a5f, 0x7a1f1f, 0x1c1c1c, 0x24513a][h % 4];
      s.c2 = hsl(h % 360, 0.6, 0.5);
    } else if (k === 'tanker') {
      s.c1 = [0x7a1f1f, 0x1c1c1c][h % 2];
      s.c2 = 0xb5651d;
    } else {
      s.c1 = 0xf1f3f5;
      s.c2 = hsl(h % 360, 0.65, 0.45);
    }
    if (m?.name) s.name = m.name.trim();
  }

  private upsert(mmsi: number, lat: number, lon: number, t0: number, sogKt: number, cog: number, heading: number | undefined, name?: string): void {
    let s = this.ships.get(mmsi);
    if (!s) {
      s = new Ship(mmsi);
      s.meta = this.meta.get(mmsi);
      this.style(s);
      this.ships.set(mmsi, s);
    }
    if (name && !s.name) s.name = name;
    s.sogKt = sogKt;
    s.cog = cog;
    // Moored ships report a meaningless course; trust the gyro heading when there is one.
    const brg = sogKt < 0.5 && heading !== undefined ? heading : cog < 360 ? cog : heading;
    s.mover.fix(lat, lon, t0, sogKt < 0.3 ? 0 : sogKt * KT, brg);
    if (heading !== undefined && sogKt < 0.5) s.mover.heading = heading;
    s.seen = Date.now();
  }

  private async pollBaltic(): Promise<void> {
    if (!this.metaLoaded) {
      this.metaLoaded = true;
      void getJson<(Meta & { mmsi: number })[]>('/api/ships/meta', 30000).then((list) => {
        if (!list) {
          this.metaLoaded = false;
          return;
        }
        for (const m of list) this.meta.set(m.mmsi, m);
        for (const s of this.ships.values()) {
          s.meta = this.meta.get(s.mmsi);
          this.style(s);
        }
      });
    }
    interface Loc {
      mmsi: number;
      geometry: { coordinates: [number, number] };
      properties: { sog: number; cog: number; heading: number; timestampExternal: number };
    }
    const data = await getJson<{ features: Loc[] }>('/api/ships', 30000);
    if (!data?.features) return;
    const now = Date.now();
    for (const f of data.features) {
      const p = f.properties;
      // Skip transponders that have been silent for more than 15 minutes.
      if (now - p.timestampExternal > 900000) continue;
      const [lon, lat] = f.geometry.coordinates;
      this.upsert(f.mmsi, lat, lon, p.timestampExternal, p.sog > 100 ? 0 : p.sog, p.cog, p.heading < 360 ? p.heading : undefined);
    }
  }

  private async pollAis(lat: number, lon: number): Promise<void> {
    interface A {
      mmsi: number;
      name: string;
      lat: number;
      lon: number;
      cog: number;
      sog: number;
      hdg: number;
    }
    const data = await getJson<{ ships: A[] }>(`/api/ships/ais?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`, 20000);
    if (!data?.ships) return;
    const now = Date.now();
    for (const a of data.ships) this.upsert(a.mmsi, a.lat, a.lon, now - 5000, a.sog > 100 ? 0 : a.sog, a.cog, a.hdg < 360 ? a.hdg : undefined, a.name);
  }

  tick(frame: FrameInfo): void {
    if (!this.enabled) return;
    if (frame.now - this.planned > 1000) {
      this.planned = frame.now;
      this.bounds = viewBounds(this.ctx.map, 0.2);
      for (const [id, s] of this.ships) if (frame.now - s.seen > 600000) this.ships.delete(id);
      const baltic = frame.zoom >= 4 && intersects(this.bounds, BALTIC);
      const ais = this.ctx.caps.ais && frame.zoom >= 7;
      if (!this.busy) {
        if (baltic && frame.now >= this.nextBaltic) {
          this.nextBaltic = frame.now + 20000;
          this.busy = true;
          void this.pollBaltic().finally(() => (this.busy = false));
        } else if (ais && frame.now >= this.nextAis) {
          this.nextAis = frame.now + 30000;
          this.busy = true;
          void this.pollAis(frame.lat, frame.lon).finally(() => (this.busy = false));
        }
      }
      let visible = 0;
      for (const s of this.ships.values()) if (inBounds(this.bounds, s.mover.lat, s.mover.lon)) visible++;
      this.count = visible;
      this.state = visible ? 'live' : baltic || ais ? 'loading' : 'idle';
      this.hint = visible ? '' : frame.zoom < 4 ? t('hintZoomIn') : this.ctx.caps.ais ? (frame.zoom < 7 ? t('hintZoomIn') : '') : t('hintShipsBaltic');
    }
  }

  emit(scene: Scene, frame: FrameInfo): void {
    if (!this.enabled || frame.zoom < 4) return;
    const minPx = frame.zoom < 7 ? 7 : frame.zoom < 10 ? 10 : frame.zoom < 13.5 ? 12 : 0;
    const b = this.bounds;
    for (const s of this.ships.values()) {
      const m = s.mover;
      if (!inBounds(b, m.lat, m.lon)) continue;
      m.step(frame.now, frame.dt, 120, 2.5);
      const size = Math.max(1, (minPx * frame.mpp) / s.length);
      const scale = (s.length / 100) * size;
      const mx = mercX(m.lon);
      const my = mercY(m.lat);
      scene.add(s.mesh, mx, my, 0, m.heading * DEG, scale, scale, 0, s.c1, s.c2);
      scene.pickable(mx, my, 6 * scale, Math.max(14, minPx * 0.8), s);
    }
  }

  selectionFor(ref: unknown): Selection | null {
    if (!(ref instanceof Ship)) return null;
    const s = ref;
    const layer = this;
    return {
      layer: this.id,
      id: String(s.mmsi),
      badge: t('live'),
      zoom: 12,
      title: () => s.name || `MMSI ${s.mmsi}`,
      subtitle: () => t(kind(s.meta?.shipType)),
      rows: (): InfoRow[] => {
        const rows: InfoRow[] = [
          { label: t('speed'), value: `${s.sogKt.toFixed(1)} kn · ${(s.sogKt * 1.852).toFixed(1)} km/h` },
          { label: t('course'), value: `${Math.round(s.mover.heading)}°` },
        ];
        if (s.meta?.destination) rows.push({ label: t('destination'), value: s.meta.destination });
        if (s.meta?.referencePointA) rows.push({ label: t('length'), value: `${Math.round(s.length)} m` });
        if (s.meta?.callSign) rows.push({ label: 'Callsign', value: s.meta.callSign });
        if (s.meta?.imo) rows.push({ label: 'IMO', value: String(s.meta.imo) });
        rows.push({ label: 'MMSI', value: String(s.mmsi) });
        return rows;
      },
      position: () => (layer.ships.has(s.mmsi) ? { lat: s.mover.lat, lon: s.mover.lon } : null),
    };
  }
}
