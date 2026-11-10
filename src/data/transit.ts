// Real-time buses, trams, metros and trains from open agency feeds.
// There is no single world-wide source, so this layer loads whichever feeds in
// the registry (shared/feeds.ts) cover what is on screen.

import { TRANSIT_FEEDS, type TransitFeed, type TransitMode } from '../../shared/feeds';
import { inBounds, intersects, viewBounds, type Ctx, type InfoRow, type Layer, type LayerState, type Selection } from '../core';
import type { FrameInfo, Scene } from '../gl/instanced';
import { M } from '../gl/meshes';
import { DEG, hash, haversine, hsl, mercX, mercY } from '../util/geo';
import { Mover } from '../util/mover';
import { t } from '../util/i18n';
import { decodeVehiclePositions } from './gtfsrt';

interface Report {
  id: string;
  lat: number;
  lon: number;
  bearing?: number;
  /** m/s */
  speed?: number;
  route?: string;
  label?: string;
  mode?: TransitMode;
  /** Epoch ms. */
  time?: number;
  dest?: string;
  extra?: string;
}

class Vehicle {
  readonly mover = new Mover();
  route = '';
  label = '';
  dest = '';
  extra = '';
  mode: TransitMode = 'bus';
  seen = 0;
  elev = 0;
  elevAt = 0;
  c1 = 0xf1f3f5;
  c2 = 0x1971c2;
  constructor(readonly key: string, readonly feed: TransitFeed) {}
}

const COMPASS: Record<string, number> = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };

/** Per-feed hints for telling rail from road vehicles, since GTFS-RT does not say. */
function modeOf(feed: TransitFeed, route: string | undefined): TransitMode {
  const r = route ?? '';
  switch (feed.id) {
    case 'mbta':
      if (/^(Red|Orange|Blue)/.test(r)) return 'metro';
      if (/^(Green|Mattapan)/.test(r)) return 'tram';
      if (/^CR-/.test(r)) return 'train';
      if (/^Boat/.test(r)) return 'ferry';
      return 'bus';
    case 'hsl':
      if (/^31M/.test(r)) return 'metro';
      if (/^300[12]/.test(r)) return 'train';
      if (/^10(0\d|1[0-5])/.test(r)) return 'tram';
      if (/^1019/.test(r)) return 'ferry';
      return 'bus';
    case 'zet':
      return Number(r) > 0 && Number(r) < 100 ? 'tram' : 'bus';
    default:
      return feed.mode;
  }
}

function parse(feed: TransitFeed, res: Response): Promise<Report[]> {
  switch (feed.format) {
    case 'gtfsrt':
      return res.arrayBuffer().then((buf) =>
        decodeVehiclePositions(buf).map((v) => ({
          id: v.id,
          lat: v.lat,
          lon: v.lon,
          bearing: v.bearing,
          speed: v.speed,
          route: v.route,
          label: v.label,
          time: v.time ? v.time * 1000 : undefined,
        })),
      );
    case 'gtfsrt-json':
      return res.json().then((j: { entity?: { id: string; vehicle?: { trip?: { tripId?: string; routeId?: string }; position?: { latitude: number; longitude: number; bearing?: number }; timestamp?: string; vehicle?: { id?: string; label?: string } } }[] }) =>
        (j.entity ?? []).flatMap((e) => {
          const p = e.vehicle?.position;
          if (!p) return [];
          const label = e.vehicle?.vehicle?.label ?? '';
          return [{
            id: e.vehicle?.vehicle?.id ?? e.id,
            lat: p.latitude,
            lon: p.longitude,
            bearing: p.bearing,
            route: label.split('-')[0] || e.vehicle?.trip?.routeId,
            label,
            time: e.vehicle?.timestamp ? Number(e.vehicle.timestamp) * 1000 : undefined,
          }];
        }),
      );
    case 'amtraker':
      return res.json().then((j: Record<string, { trainID: string; trainNum: string; routeName: string; lat: number; lon: number; heading: string; velocity: number; destName: string; trainState: string; trainTimely: string; updatedAt: string }[]>) =>
        Object.values(j).flat().filter((x) => x.trainState === 'Active').map((x) => ({
          id: x.trainID,
          lat: x.lat,
          lon: x.lon,
          bearing: COMPASS[x.heading],
          speed: x.velocity * 0.44704,
          route: x.routeName,
          label: `#${x.trainNum}`,
          dest: x.destName,
          extra: x.trainTimely,
          time: Date.parse(x.updatedAt) || undefined,
        })),
      );
    case 'fintraffic-trains':
      return res.json().then((j: { trainNumber: number; speed: number; location: { coordinates: [number, number] }; timestamp: string }[]) =>
        j.map((x) => ({
          id: String(x.trainNumber),
          lat: x.location.coordinates[1],
          lon: x.location.coordinates[0],
          speed: x.speed / 3.6,
          route: `${x.trainNumber}`,
          label: `#${x.trainNumber}`,
          time: Date.parse(x.timestamp) || undefined,
        })),
      );
    case 'septa-bus':
      return res.json().then((j: { routes?: Record<string, { lat: string; lng: string; VehicleID: string; route_id: string; heading: number | null; destination: string; late: number; timestamp: number }[]>[] }) =>
        (j.routes ?? []).flatMap((group) => Object.values(group).flat()).filter((v) => v.VehicleID && v.VehicleID !== 'None').map((v) => ({
          id: v.VehicleID,
          lat: Number(v.lat),
          lon: Number(v.lng),
          bearing: typeof v.heading === 'number' ? v.heading : undefined,
          route: v.route_id,
          label: v.VehicleID,
          dest: v.destination,
          extra: v.late > 0 && v.late < 900 ? `${v.late} min ${t('late')}` : '',
          time: v.timestamp * 1000,
          mode: (/^(T\d|G\d|D\d|10|11|13|15|34|36|101|102)$/.test(v.route_id) ? 'tram' : /^(L\d?|B\d?|MFL|BSL|M\d)$/.test(v.route_id) ? 'metro' : 'bus') as TransitMode,
        })),
      );
    case 'septa-rail':
      return res.json().then((j: { lat: string; lon: string; trainno: string; line: string; dest: string; heading: string | number; late: number; nextstop: string }[]) =>
        j.map((v) => ({
          id: v.trainno,
          lat: Number(v.lat),
          lon: Number(v.lon),
          bearing: v.heading === '' ? undefined : Number(v.heading),
          route: v.line,
          label: `#${v.trainno}`,
          dest: v.dest,
          extra: v.late > 0 ? `${v.late} min ${t('late')}` : t('onTime'),
        })),
      );
    case 'rio-brt':
      return res.json().then((j: { veiculos?: { codigo: string; linha: string; latitude: number; longitude: number; dataHora: number; velocidade: number; direcao: number; trajeto: string; ignicao: number }[] }) =>
        (j.veiculos ?? []).filter((v) => Date.now() - v.dataHora < 600000 && v.linha).map((v) => ({
          id: v.codigo,
          lat: v.latitude,
          lon: v.longitude,
          bearing: v.direcao,
          speed: v.velocidade / 3.6,
          route: v.linha,
          label: v.codigo,
          dest: v.trajeto,
          time: v.dataHora,
        })),
      );
    case 'tallinn':
      return res.text().then((text) =>
        text.split('\n').flatMap((line) => {
          const c = line.split(',');
          if (c.length < 7) return [];
          const type = c[0];
          const mode: TransitMode = type === '3' ? 'tram' : type === '10' ? 'train' : 'bus';
          return [{ id: `${type}-${c[6]}`, lat: Number(c[3]) / 1e6, lon: Number(c[2]) / 1e6, bearing: Number(c[5]), route: c[1], label: c[6], dest: c[9], mode }];
        }),
      );
    case 'sptrans':
      return res.json().then((j: { l?: { c: string; lt0: string; lt1: string; sl: number; vs: { p: number; py: number; px: number; ta: string }[] }[] }) =>
        (j.l ?? []).flatMap((line) =>
          line.vs.map((v) => ({
            id: String(v.p),
            lat: v.py,
            lon: v.px,
            route: line.c,
            label: String(v.p),
            dest: line.sl === 1 ? line.lt0 : line.lt1,
            time: Date.parse(v.ta) || undefined,
          })),
        ),
      );
  }
}

const MODE_COLOR: Record<TransitMode, number> = { bus: 0xf59f00, tram: 0x37b24d, metro: 0xe03131, train: 0x1971c2, ferry: 0x1098ad };

interface FeedState {
  next: number;
  busy: boolean;
  failures: number;
  count: number;
}

export class TransitLayer implements Layer {
  readonly id = 'transit';
  enabled = true;
  count = 0;
  state: LayerState = 'idle';
  hint = '';

  private vehicles = new Map<string, Vehicle>();
  private feeds = new Map<string, FeedState>();
  private active: TransitFeed[] = [];
  private planned = 0;
  private bounds: [number, number, number, number] = [0, 0, 0, 0];

  constructor(private readonly ctx: Ctx) {}

  /** Names of the networks currently being shown. */
  get networks(): string[] {
    return this.active.filter((f) => (this.feeds.get(f.id)?.count ?? 0) > 0).map((f) => f.name);
  }

  private async poll(feed: TransitFeed, st: FeedState): Promise<void> {
    st.busy = true;
    try {
      const res = await fetch(`/api/transit/${feed.id}`, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(String(res.status));
      const reports = await parse(feed, res);
      const now = Date.now();
      let n = 0;
      for (const r of reports) {
        if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon) || !r.id) continue;
        // Ignore vehicles whose last report is older than ten minutes (parked, logged off).
        if (r.time && now - r.time > 600000) continue;
        const key = `${feed.id}:${r.id}`;
        let v = this.vehicles.get(key);
        if (!v) {
          v = new Vehicle(key, feed);
          this.vehicles.set(key, v);
        }
        const route = r.route ?? '';
        if (route !== v.route || !v.seen) {
          v.route = route;
          v.mode = r.mode ?? modeOf(feed, route);
          const accent = route ? hsl(hash(feed.id + route) % 360, 0.7, 0.45) : MODE_COLOR[v.mode];
          if (v.mode === 'bus') {
            v.c1 = accent;
            v.c2 = 0xf8f9fa;
          } else {
            v.c1 = 0xe9ecef;
            v.c2 = accent;
          }
        }
        v.label = r.label ?? v.label;
        v.dest = r.dest ?? v.dest;
        v.extra = r.extra ?? v.extra;
        const bearing = r.bearing !== undefined && Number.isFinite(r.bearing) && !(r.bearing === 0 && r.speed === 0) ? r.bearing : undefined;
        v.mover.fix(r.lat, r.lon, r.time ?? now, r.speed, bearing);
        v.seen = now;
        n++;
      }
      st.count = n;
      st.failures = 0;
    } catch {
      st.failures++;
    } finally {
      st.busy = false;
    }
  }

  tick(frame: FrameInfo): void {
    if (!this.enabled) return;
    if (frame.now - this.planned > 1000) {
      this.planned = frame.now;
      this.bounds = viewBounds(this.ctx.map, 0.2);
      const candidates = TRANSIT_FEEDS.filter((f) => {
        if (f.secret === 'SPTRANS_TOKEN' && !this.ctx.caps.sptrans) return false;
        // Long-distance rail is worth showing from far away; city networks only once zoomed in.
        const minZoom = f.mode === 'train' ? 4.5 : 8;
        return frame.zoom >= minZoom && intersects(this.bounds, f.bbox);
      });
      const centre = (f: TransitFeed) => haversine(frame.lat, frame.lon, (f.bbox[1] + f.bbox[3]) / 2, (f.bbox[0] + f.bbox[2]) / 2);
      candidates.sort((a, b) => centre(a) - centre(b));
      this.active = candidates.slice(0, this.ctx.tier.quality === 'low' ? 2 : 5);

      for (const [key, v] of this.vehicles) {
        if (frame.now - v.seen > Math.max(90000, v.feed.ttl * 6000)) this.vehicles.delete(key);
      }
      let visible = 0;
      for (const v of this.vehicles.values()) if (inBounds(this.bounds, v.mover.lat, v.mover.lon)) visible++;
      this.count = visible;
      const failing = this.active.length > 0 && this.active.every((f) => (this.feeds.get(f.id)?.failures ?? 0) > 2);
      this.state = visible ? 'live' : failing ? 'error' : this.active.length ? 'loading' : 'idle';
      this.hint = visible
        ? this.networks.join(' · ')
        : this.active.length
          ? failing ? t('hintFeedDown') : ''
          : frame.zoom < 8 ? t('hintZoomIn') : t('hintNoFeed');
    }
    for (const feed of this.active) {
      let st = this.feeds.get(feed.id);
      if (!st) {
        st = { next: 0, busy: false, failures: 0, count: 0 };
        this.feeds.set(feed.id, st);
      }
      if (!st.busy && frame.now >= st.next) {
        st.next = frame.now + feed.ttl * 1000 * (st.failures > 2 ? 4 : 1);
        void this.poll(feed, st);
      }
    }
  }

  emit(scene: Scene, frame: FrameInfo): void {
    if (!this.enabled || frame.zoom < 4.5) return;
    const b = this.bounds;
    const far = frame.zoom < 11;
    for (const v of this.vehicles.values()) {
      const m = v.mover;
      if (!inBounds(b, m.lat, m.lon)) continue;
      // Feeds refresh every 8-30 s: glide for about one refresh interval, then hold.
      m.step(frame.now, frame.dt, v.feed.ttl * 1.5, 1.5);
      const rail = v.mode === 'train' || v.mode === 'metro';
      const mesh = rail ? M.Train : v.mode === 'tram' ? M.Tram : v.mode === 'ferry' ? M.Ferry : M.Bus;
      const len = rail ? 98 : v.mode === 'tram' ? 30.6 : v.mode === 'ferry' ? 100 : 12;
      const real = v.mode === 'ferry' ? 0.4 : v.mode === 'metro' ? 0.8 : 1;
      const minPx = rail ? (far ? 16 : 30) : v.mode === 'bus' ? (far ? 7 : 14) : far ? 10 : 20;
      const scale = Math.max(real, (minPx * frame.mpp) / len);
      if (frame.zoom > 11 && frame.now - v.elevAt > 2000) {
        v.elevAt = frame.now + Math.random() * 500;
        v.elev = this.ctx.elevAt(m.lat, m.lon);
      }
      const mx = mercX(m.lon);
      const my = mercY(m.lat);
      scene.add(mesh, mx, my, v.elev, m.heading * DEG, scale, scale, 0, v.c1, v.c2);
      scene.pickable(mx, my, v.elev + 2 * scale, Math.max(13, minPx * 0.7), v);
    }
  }

  selectionFor(ref: unknown): Selection | null {
    if (!(ref instanceof Vehicle)) return null;
    const v = ref;
    const layer = this;
    return {
      layer: this.id,
      id: v.key,
      badge: t('live'),
      zoom: 15.5,
      title: () => (v.route ? `${t(v.mode)} ${v.route}` : t(v.mode)),
      subtitle: () => v.dest || v.feed.name,
      rows: (): InfoRow[] => {
        const rows: InfoRow[] = [{ label: t('network'), value: v.feed.name }];
        if (v.route) rows.push({ label: t('line'), value: v.route });
        if (v.label) rows.push({ label: t('vehicle'), value: v.label });
        if (v.dest) rows.push({ label: t('destination'), value: v.dest });
        if (v.extra) rows.push({ label: t('status'), value: v.extra });
        rows.push({ label: t('speed'), value: `${Math.round(v.mover.speed * 3.6)} km/h` });
        return rows;
      },
      position: () => (layer.vehicles.has(v.key) ? { lat: v.mover.lat, lon: v.mover.lon } : null),
    };
  }
}
