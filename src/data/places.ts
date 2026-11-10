// Shops and public places, coloured by whether they are open right now.
// Opening hours come from OpenStreetMap (`opening_hours` tag) and are evaluated
// against the local time of the place itself, not of the viewer.

import type { Ctx, Layer, LayerState } from '../core';
import type { FrameInfo, Scene } from '../gl/instanced';
import { t } from '../util/i18n';

type State = 'open' | 'closed' | 'unknown';

interface Place {
  id: string;
  lat: number;
  lon: number;
  name: string;
  hours: string;
  kind: string;
  state: State;
  /** "closes 18:00" / "opens 09:00" */
  next: string;
  // Parsed opening-hours object, created lazily.
  oh?: OpeningHours | null;
}

interface OpeningHours {
  getState(d?: Date): boolean;
  getUnknown(d?: Date): boolean;
  getNextChange(d?: Date): Date | undefined;
}

interface Tile {
  key: string;
  places: Place[];
  tz: string;
  loaded: boolean;
}

type OhCtor = new (value: string, nominatim?: unknown, mode?: unknown) => OpeningHours;

const MAX_TILES = 4;

export class PlacesLayer implements Layer {
  readonly id = 'places';
  enabled = true;
  count = 0;
  state: LayerState = 'idle';
  hint = '';
  open = 0;
  closed = 0;

  private tiles = new Map<string, Tile>();
  private visible: Tile[] = [];
  private planned = 0;
  private evaluated = 0;
  private dirty = false;
  private libs?: Promise<{ OH: OhCtor; tz: (lat: number, lon: number) => string } | null>;
  private fmt = new Map<string, Intl.DateTimeFormat>();
  /** The public Overpass servers allow very few parallel queries per client, so tiles load one at a time. */
  private fetching = false;

  constructor(private readonly ctx: Ctx) {}

  /** The opening-hours parser and timezone lookup are only downloaded once someone zooms into a street. */
  private load() {
    this.libs ??= Promise.all([import('opening_hours'), import('tz-lookup')])
      .then(([oh, tz]) => ({
        OH: ((oh as { default?: unknown }).default ?? oh) as OhCtor,
        tz: ((tz as { default?: unknown }).default ?? tz) as (lat: number, lon: number) => string,
      }))
      .catch(() => null);
    return this.libs;
  }

  private async fetchTile(x: number, y: number): Promise<void> {
    const key = `${x}/${y}`;
    if (this.tiles.has(key) || this.fetching) return;
    this.fetching = true;
    const tile: Tile = { key, places: [], tz: 'UTC', loaded: false };
    this.tiles.set(key, tile);
    try {
      const [res, libs] = await Promise.all([fetch(`/api/places?x=${x}&y=${y}`, { signal: AbortSignal.timeout(65000) }), this.load()]);
      if (!res.ok) throw new Error(String(res.status));
      const text = await res.text();
      const n = 2 ** 14;
      const lon = ((x + 0.5) / n) * 360 - 180;
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) / Math.PI;
      try {
        tile.tz = libs?.tz(lat, lon) ?? 'UTC';
      } catch {
        tile.tz = 'UTC';
      }
      for (const line of text.split('\n')) {
        const c = line.split('\t');
        if (c.length < 6 || !c[5]) continue;
        const plat = Number(c[2]);
        const plon = Number(c[3]);
        if (!Number.isFinite(plat) || !Number.isFinite(plon) || (plat === 0 && plon === 0)) continue;
        const kind = c[6] || c[7] || c[8] || c[9] || c[10] || c[11] || c[12] || '';
        tile.places.push({ id: `${c[0][0]}${c[1]}`, lat: plat, lon: plon, name: c[4], hours: c[5], kind: kind.replace(/_/g, ' '), state: 'unknown', next: '' });
      }
      tile.loaded = true;
      this.evaluated = 0;
    } catch {
      // Let it be retried on a later pass.
      window.setTimeout(() => this.tiles.delete(key), 20000);
    } finally {
      this.fetching = false;
    }
  }

  /** A Date whose *local* fields read as the wall-clock time in `tz`. */
  private wallClock(now: number, tz: string): Date {
    let f = this.fmt.get(tz);
    if (!f) {
      try {
        f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
      } catch {
        f = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
      }
      this.fmt.set(tz, f);
    }
    const p: Record<string, number> = {};
    for (const part of f.formatToParts(new Date(now))) if (part.type !== 'literal') p[part.type] = Number(part.value);
    return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  }

  private async evaluate(now: number): Promise<void> {
    const libs = await this.load();
    if (!libs) return;
    let open = 0;
    let closed = 0;
    for (const tile of this.visible) {
      if (!tile.loaded) continue;
      const when = this.wallClock(now, tile.tz);
      for (const p of tile.places) {
        if (p.oh === undefined) {
          try {
            p.oh = new libs.OH(p.hours, null, { tag_key: 'opening_hours' });
          } catch {
            p.oh = null;
          }
        }
        p.state = 'unknown';
        p.next = '';
        if (p.oh) {
          try {
            if (!p.oh.getUnknown(when)) {
              const isOpen = p.oh.getState(when);
              p.state = isOpen ? 'open' : 'closed';
              const change = p.oh.getNextChange(when);
              if (change) {
                const sameDay = change.getDate() === when.getDate();
                const hm = `${String(change.getHours()).padStart(2, '0')}:${String(change.getMinutes()).padStart(2, '0')}`;
                const day = sameDay ? '' : ` ${change.toLocaleDateString(undefined, { weekday: 'short' })}`;
                p.next = `${isOpen ? t('closesAt') : t('opensAt')} ${hm}${day}`;
              }
            }
          } catch {
            p.state = 'unknown';
          }
        }
        if (p.state === 'open') open++;
        else if (p.state === 'closed') closed++;
      }
    }
    this.open = open;
    this.closed = closed;
    this.dirty = true;
  }

  private publish(): void {
    this.dirty = false;
    const src = this.ctx.map.getSource('places') as { setData(d: GeoJSON.FeatureCollection): void } | undefined;
    if (!src) return;
    const features: GeoJSON.Feature[] = [];
    if (this.enabled) {
      for (const tile of this.visible) {
        for (const p of tile.places) {
          features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
            properties: { id: p.id, name: p.name, hours: p.hours, kind: p.kind, state: p.state, next: p.next },
          });
        }
      }
    }
    this.count = features.length;
    src.setData({ type: 'FeatureCollection', features });
  }

  /** Clears the map when the layer is switched off. */
  refresh(): void {
    this.dirty = true;
    this.evaluated = 0;
  }

  tick(frame: FrameInfo): void {
    if (!this.enabled) {
      if (this.dirty) this.publish();
      return;
    }
    if (frame.now - this.planned > 700) {
      this.planned = frame.now;
      if (frame.zoom < 14.7) {
        if (this.visible.length) {
          this.visible = [];
          this.dirty = true;
        }
        this.state = 'idle';
        this.hint = t('hintZoomIn');
      } else {
        const b = this.ctx.map.getBounds();
        const n = 2 ** 14;
        const tx = (lon: number) => Math.floor(((lon + 180) / 360) * n);
        const ty = (lat: number) => Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
        const x0 = tx(b.getWest()), x1 = tx(b.getEast()), y0 = ty(b.getNorth()), y1 = ty(b.getSouth());
        const cx = tx(frame.lon), cy = ty(frame.lat);
        const keys: [number, number, number][] = [];
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) keys.push([x, y, Math.abs(x - cx) + Math.abs(y - cy)]);
        keys.sort((a, c) => a[2] - c[2]);
        const wanted = keys.slice(0, MAX_TILES);
        for (const [x, y] of wanted) void this.fetchTile(x, y);
        const visible = wanted.map(([x, y]) => this.tiles.get(`${x}/${y}`)).filter((v): v is Tile => Boolean(v));
        if (visible.length !== this.visible.length || visible.some((v, i) => v !== this.visible[i])) {
          this.visible = visible;
          this.evaluated = 0;
        }
        const loading = visible.some((v) => !v.loaded);
        this.state = this.count ? 'live' : loading ? 'loading' : 'idle';
        this.hint = this.count ? `${this.open} ${t('open').toLowerCase()} · ${this.closed} ${t('closed').toLowerCase()}` : '';
      }
    }
    // Opening state can flip at any minute boundary.
    if (this.visible.length && frame.now - this.evaluated > 30000) {
      this.evaluated = frame.now;
      void this.evaluate(frame.now);
    }
    if (this.dirty) this.publish();
  }

  emit(_scene: Scene, _frame: FrameInfo): void {
    // Drawn by regular map layers (see basemap.ts), not by the 3D layer.
  }
}
