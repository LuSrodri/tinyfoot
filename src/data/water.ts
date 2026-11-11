// Rivers, lakes and flooding, from four kinds of source:
//  - Open-Meteo Flood (GloFAS): modelled river discharge anywhere on Earth, compared with the
//    river's own recent normal to tell "high" and "flood" from "normal".
//  - USGS Water Data: measured gauge height at US monitoring stations, minutes old.
//  - ANA (Brazil) telemetry: measured level and flow at Brazilian stations.
//  - CGE São Paulo: the city's count of active street-flooding points.

import { getJson, intersects, viewBounds, type Ctx, type Layer, type LayerState } from '../core';
import type { FrameInfo, Scene } from '../gl/instanced';
import { haversine } from '../util/geo';
import { lang } from '../util/i18n';

type Level = 'normal' | 'high' | 'flood' | 'low';

interface Gauge {
  id: string;
  lat: number;
  lon: number;
  level: Level;
  label: string;
  name: string;
  detail: string;
  source: string;
}

const US: [number, number, number, number] = [-170, 18, -65, 72];
const BR: [number, number, number, number] = [-74, -34, -34, 5.5];
const SP_CITY: [number, number, number, number] = [-46.83, -23.8, -46.36, -23.35];
const pt = lang === 'pt';
const fmt = (v: number, digits = 2): string => v.toLocaleString(undefined, { maximumFractionDigits: digits });

export class WaterLayer implements Layer {
  readonly id = 'water';
  enabled = true;
  count = 0;
  state: LayerState = 'idle';
  hint = '';

  private gauges = new Map<string, Gauge>();
  private done = new Map<string, number>();
  private planned = 0;
  private dirty = false;
  private stations: { cod: string; name: string; river: string; lat: number; lon: number }[] | null = null;
  private stationsBusy = false;

  constructor(private readonly ctx: Ctx) {}

  /** True if `key` has not been fetched within `ttl` seconds; marks it as fetched. */
  private due(key: string, ttl: number, now: number): boolean {
    if (now - (this.done.get(key) ?? 0) < ttl * 1000) return false;
    this.done.set(key, now);
    return true;
  }

  private put(g: Gauge): void {
    this.gauges.set(g.id, g);
    this.dirty = true;
  }

  // ------------------------------------------------------------- Open-Meteo Flood
  private async model(points: [number, number][]): Promise<void> {
    const lat = points.map((p) => p[0].toFixed(2)).join(',');
    const lon = points.map((p) => p[1].toFixed(2)).join(',');
    interface R {
      latitude: number;
      longitude: number;
      daily?: { time: string[]; river_discharge: (number | null)[] };
    }
    const res = await getJson<R | R[]>(`https://flood-api.open-meteo.com/v1/flood?latitude=${lat}&longitude=${lon}&daily=river_discharge&past_days=60&forecast_days=1`, 20000);
    if (!res) return;
    for (const r of Array.isArray(res) ? res : [res]) {
      const series = (r.daily?.river_discharge ?? []).filter((v): v is number => typeof v === 'number');
      if (series.length < 20) continue;
      const today = series[series.length - 1];
      const past = series.slice(0, -1).sort((a, b) => a - b);
      const median = past[Math.floor(past.length / 2)];
      const p90 = past[Math.floor(past.length * 0.9)];
      // Cells with almost no flow are not rivers worth marking.
      if (today < 2 && median < 2) continue;
      const ratio = today / Math.max(0.1, median);
      const level: Level = today > p90 * 1.6 && ratio > 2.5 ? 'flood' : today > p90 && ratio > 1.5 ? 'high' : ratio < 0.4 ? 'low' : 'normal';
      const pct = Math.round((ratio - 1) * 100);
      this.put({
        id: `om:${r.latitude.toFixed(2)},${r.longitude.toFixed(2)}`,
        lat: r.latitude,
        lon: r.longitude,
        level,
        label: `${fmt(today, today < 10 ? 1 : 0)} m³/s`,
        name: pt ? 'Vazão do rio (modelo)' : 'River discharge (model)',
        detail: `${fmt(today, 1)} m³/s · ${pct >= 0 ? '+' : ''}${pct}% ${pt ? 'vs. mediana de 60 dias' : 'vs 60-day median'} (${fmt(median, 1)} m³/s)`,
        source: 'Open-Meteo Flood / GloFAS',
      });
    }
  }

  // ------------------------------------------------------------------------ USGS
  private async usgs(b: [number, number, number, number]): Promise<void> {
    const snap = (v: number, up: boolean) => (up ? Math.ceil(v * 2) / 2 : Math.floor(v * 2) / 2);
    const bbox = [snap(b[0], false), snap(b[1], false), snap(b[2], true), snap(b[3], true)].join(',');
    interface F {
      geometry: { coordinates: [number, number] } | null;
      properties: { monitoring_location_id: string; value: string; unit_of_measure: string; time: string };
    }
    const res = await getJson<{ features: F[] }>(`/api/water/usgs?bbox=${bbox}`, 25000);
    for (const f of res?.features ?? []) {
      const v = Number(f.properties.value);
      if (!f.geometry || !Number.isFinite(v)) continue;
      const m = f.properties.unit_of_measure === 'ft' ? v * 0.3048 : v;
      this.put({
        id: `usgs:${f.properties.monitoring_location_id}`,
        lat: f.geometry.coordinates[1],
        lon: f.geometry.coordinates[0],
        level: 'normal',
        label: `${fmt(m)} m`,
        name: f.properties.monitoring_location_id,
        detail: `${pt ? 'Nível medido' : 'Gauge height'}: ${fmt(m)} m (${fmt(v)} ${f.properties.unit_of_measure}) · ${new Date(f.properties.time).toLocaleString()}`,
        source: 'USGS Water Data',
      });
    }
  }

  // ------------------------------------------------------------------------- ANA
  private async loadStations(): Promise<void> {
    if (this.stations || this.stationsBusy) return;
    this.stationsBusy = true;
    try {
      const res = await fetch('/api/water/ana/stations', { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(String(res.status));
      const xml = await res.text();
      const tag = (block: string, name: string): string => block.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1] ?? '';
      const list: NonNullable<WaterLayer['stations']> = [];
      for (const m of xml.matchAll(/<Table [\s\S]*?<\/Table>/g)) {
        const block = m[0];
        if (tag(block, 'StatusEstacao') !== 'Ativo') continue;
        const lat = Number(tag(block, 'Latitude'));
        const lon = Number(tag(block, 'Longitude'));
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
        list.push({ cod: tag(block, 'CodEstacao'), name: tag(block, 'NomeEstacao'), river: tag(block, 'NomeRio'), lat, lon });
      }
      this.stations = list;
    } catch {
      window.setTimeout(() => (this.stationsBusy = false), 60000);
      return;
    }
    this.stationsBusy = false;
  }

  private async ana(frame: FrameInfo, b: [number, number, number, number]): Promise<void> {
    await this.loadStations();
    const near = (this.stations ?? [])
      .filter((s) => s.lat >= b[1] && s.lat <= b[3] && s.lon >= b[0] && s.lon <= b[2])
      .map((s) => ({ s, d: haversine(frame.lat, frame.lon, s.lat, s.lon) }))
      .sort((x, y) => x.d - y.d)
      .slice(0, 8);
    await Promise.all(
      near.map(async ({ s }) => {
        if (!this.due(`ana:${s.cod}`, 900, frame.now)) return;
        try {
          const res = await fetch(`/api/water/ana/data?cod=${s.cod}`, { signal: AbortSignal.timeout(25000) });
          if (!res.ok) return;
          const xml = await res.text();
          // Readings come newest first; take the first one that has a level.
          const rows = [...xml.matchAll(/<DadosHidrometereologicos[\s\S]*?<\/DadosHidrometereologicos>/g)].map((m) => m[0]);
          const row = rows.find((r) => /<Nivel>[^<]+<\/Nivel>/.test(r)) ?? rows[0];
          if (!row) return;
          const get = (name: string): number => Number(row.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1]);
          const nivel = get('Nivel');
          const vazao = get('Vazao');
          if (!Number.isFinite(nivel) && !Number.isFinite(vazao)) return;
          const when = row.match(/<DataHora>([^<]*)<\/DataHora>/)?.[1]?.trim() ?? '';
          this.put({
            id: `ana:${s.cod}`,
            lat: s.lat,
            lon: s.lon,
            level: 'normal',
            label: Number.isFinite(nivel) ? `${fmt(nivel / 100)} m` : `${fmt(vazao, 1)} m³/s`,
            name: `${s.name}${s.river ? ` · ${s.river}` : ''}`,
            detail: [Number.isFinite(nivel) ? `Nível ${fmt(nivel / 100)} m` : '', Number.isFinite(vazao) ? `Vazão ${fmt(vazao, 1)} m³/s` : '', when].filter(Boolean).join(' · '),
            source: 'ANA · Rede Hidrometeorológica Nacional',
          });
        } catch {
          /* station offline */
        }
      }),
    );
  }

  // ------------------------------------------------------------------- CGE São Paulo
  private async cge(): Promise<void> {
    try {
      const res = await fetch('/api/water/cge', { signal: AbortSignal.timeout(20000) });
      if (!res.ok) return;
      const html = new TextDecoder('iso-8859-1').decode(await res.arrayBuffer());
      // The first two counters on the page are the points flooded right now.
      const counts = [...html.matchAll(/ransit[^<=]*=\s*(\d+)\s*pts/g)].slice(0, 2).map((m) => Number(m[1]));
      if (counts.length < 2) return;
      const [passable, blocked] = counts;
      const total = passable + blocked;
      this.put({
        id: 'cge:sp',
        lat: -23.5505,
        lon: -46.6333,
        level: blocked > 0 ? 'flood' : total > 0 ? 'high' : 'normal',
        label: total ? `${total} alagamento${total > 1 ? 's' : ''}` : 'Sem alagamentos',
        name: 'São Paulo · pontos de alagamento ativos',
        detail: `${blocked} intransitáveis · ${passable} transitáveis`,
        source: 'CGE · Prefeitura de São Paulo',
      });
    } catch {
      /* page unavailable */
    }
  }

  tick(frame: FrameInfo): void {
    if (!this.enabled) {
      if (this.count) this.publish(true);
      return;
    }
    if (frame.now - this.planned > 2500) {
      this.planned = frame.now;
      if (frame.zoom >= 6.5) {
        const b = viewBounds(this.ctx.map, 0);
        // A 3x3 grid of model points across the view (snapped, so results are reused while panning).
        const snap = frame.zoom >= 10 ? 0.05 : frame.zoom >= 8 ? 0.25 : 1;
        const pts: [number, number][] = [];
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 3; j++) {
            const la = Math.round((b[1] + ((i + 0.5) / 3) * (b[3] - b[1])) / snap) * snap;
            const lo = Math.round((b[0] + ((j + 0.5) / 3) * (b[2] - b[0])) / snap) * snap;
            if (Math.abs(la) < 85 && this.due(`om:${la.toFixed(2)},${lo.toFixed(2)}`, 3600, frame.now)) pts.push([la, lo]);
          }
        }
        if (pts.length) void this.model(pts);
        if (frame.zoom >= 8 && intersects(b, US) && this.due(`usgs:${Math.round(frame.lat * 2)},${Math.round(frame.lon * 2)}`, 300, frame.now)) void this.usgs(b);
        if (frame.zoom >= 8 && intersects(b, BR)) void this.ana(frame, b);
        if (frame.zoom >= 8 && intersects(b, SP_CITY) && this.due('cge', 300, frame.now)) void this.cge();
      }
      this.state = this.gauges.size ? 'live' : frame.zoom < 6.5 ? 'idle' : 'loading';
    }
    if (this.dirty) this.publish(false);
  }

  private publish(clear: boolean): void {
    this.dirty = false;
    const src = this.ctx.map.getSource('water') as unknown as { setData(d: GeoJSON.FeatureCollection): void } | undefined;
    if (!src) return;
    const list = clear ? [] : [...this.gauges.values()];
    this.count = list.length;
    src.setData({
      type: 'FeatureCollection',
      features: list.map((g) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [g.lon, g.lat] },
        properties: { id: g.id, level: g.level, label: g.label, name: g.name, detail: g.detail, source: g.source },
      })),
    });
  }

  emit(_scene: Scene, _frame: FrameInfo): void {
    // Drawn by regular map layers (see basemap.ts).
  }
}
