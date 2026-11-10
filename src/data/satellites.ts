// Satellites: orbital elements (TLE) from CelesTrak, propagated in the browser
// with SGP4 so every satellite is where it really is right now.

import { twoline2satrec } from '@sat/io.js';
import { gstime, propagate } from '@sat/propagation.js';
import type { SatRec } from '@sat/propagation/SatRec.js';
import { eciToGeodetic } from '@sat/transforms.js';
import type { Ctx, InfoRow, Layer, LayerState, Selection } from '../core';
import type { FrameInfo, Scene } from '../gl/instanced';
import { M } from '../gl/meshes';
import { DEG, mercX, mercY } from '../util/geo';
import { t } from '../util/i18n';

interface Sat {
  id: string;
  name: string;
  rec: SatRec;
  group: string;
  lat: number;
  lon: number;
  /** Metres. */
  alt: number;
  /** km/s */
  vel: number;
  ok: boolean;
  /** Velocity direction over ground, degrees. */
  heading: number;
}

const GROUP_COLOR: Record<string, [number, number]> = {
  stations: [0xffd166, 0xffffff],
  visual: [0xe9ecef, 0xffffff],
  'gps-ops': [0x80ed99, 0xffffff],
  weather: [0x74c0fc, 0xffffff],
  science: [0xd0bfff, 0xffffff],
  starlink: [0xadb5bd, 0xffffff],
};

export class SatelliteLayer implements Layer {
  readonly id = 'satellites';
  enabled = true;
  count = 0;
  state: LayerState = 'loading';
  hint = '';

  private sats: Sat[] = [];
  private loaded = new Set<string>();
  private lastProp = 0;
  private selected: Sat | null = null;
  private trackAt = 0;

  constructor(private readonly ctx: Ctx) {}

  private async load(group: string): Promise<void> {
    if (this.loaded.has(group)) return;
    this.loaded.add(group);
    try {
      const res = await fetch(`/api/tle?group=${group}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(String(res.status));
      const lines = (await res.text()).split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
      const seen = new Set(this.sats.map((s) => s.id));
      for (let i = 0; i + 2 < lines.length; i += 3) {
        const l1 = lines[i + 1];
        const l2 = lines[i + 2];
        if (!l1?.startsWith('1 ') || !l2?.startsWith('2 ')) continue;
        const id = l1.slice(2, 7).trim();
        if (seen.has(id)) continue;
        seen.add(id);
        try {
          this.sats.push({ id, name: lines[i].trim(), rec: twoline2satrec(l1, l2), group, lat: 0, lon: 0, alt: 0, vel: 0, ok: false, heading: 0 });
        } catch {
          /* skip malformed element sets */
        }
      }
      this.count = this.sats.length;
      this.state = 'live';
    } catch {
      // CelesTrak throttles now and then; keep what we have and try this group again shortly.
      if (!this.sats.length) this.state = 'error';
      window.setTimeout(() => {
        this.loaded.delete(group);
        void this.load(group);
      }, 30000);
    }
  }

  private place(s: Sat, date: Date, gmst: number): boolean {
    try {
      const pv = propagate(s.rec, date);
      const pos = pv?.position;
      if (!pos || typeof pos !== 'object' || Number.isNaN(pos.x)) return false;
      const geo = eciToGeodetic(pos, gmst);
      const lat = geo.latitude / DEG;
      let lon = geo.longitude / DEG;
      lon = ((lon + 540) % 360) - 180;
      if (s.ok) {
        const dLon = ((lon - s.lon + 540) % 360) - 180;
        const dLat = lat - s.lat;
        if (Math.abs(dLon) + Math.abs(dLat) > 1e-7) s.heading = (Math.atan2(dLon * Math.cos(lat * DEG), dLat) / DEG + 360) % 360;
      }
      s.lat = lat;
      s.lon = lon;
      s.alt = geo.height * 1000;
      const v = pv.velocity;
      if (v && typeof v === 'object') s.vel = Math.hypot(v.x, v.y, v.z);
      return true;
    } catch {
      return false;
    }
  }

  tick(frame: FrameInfo): void {
    if (!this.enabled) return;
    if (!this.loaded.size) {
      void this.load('stations').then(() => this.load('visual'));
      if (this.ctx.tier.quality !== 'low') {
        void this.load('gps-ops');
        void this.load('weather');
        void this.load('science');
      }
    }
    // Satellites move ~7 km/s; a few updates per second is smooth at globe scale.
    const every = this.ctx.tier.quality === 'high' ? 60 : 200;
    if (frame.now - this.lastProp >= every) {
      this.lastProp = frame.now;
      const date = new Date(frame.now);
      const gmst = gstime(date);
      for (const s of this.sats) s.ok = this.place(s, date, gmst);
    }
    this.hint = '';
    if (this.selected && frame.now - this.trackAt > 20000) this.drawTrack(frame.now);
  }

  emit(scene: Scene, frame: FrameInfo): void {
    if (!this.enabled || frame.zoom > 9) return;
    const minPx = frame.zoom < 3 ? 13 : 18;
    for (const s of this.sats) {
      if (!s.ok) continue;
      const mx = mercX(s.lon);
      const my = mercY(s.lat);
      const big = s.group === 'stations' ? 1.5 : 1;
      const scale = Math.max(1, (minPx * big * frame.mpp) / 16);
      const [c1, c2] = GROUP_COLOR[s.group] ?? GROUP_COLOR.visual;
      // Altitude is true to scale up to 2,500 km; higher orbits (GPS, geostationary)
      // are drawn at that ceiling so they stay inside the view.
      const elev = Math.min(s.alt, 2.5e6);
      scene.add(M.Sat, mx, my, elev, s.heading * DEG, scale, scale, 0, s === this.selected ? 0xffc83d : c1, c2);
      scene.pickable(mx, my, elev, 16, s);
    }
  }

  selectionFor(ref: unknown): Selection | null {
    const s = ref as Sat;
    if (!s || typeof s !== 'object' || !('rec' in s)) return null;
    const layer = this;
    return {
      layer: this.id,
      id: s.id,
      badge: t('live'),
      zoom: 3,
      title: () => s.name,
      subtitle: () => (s.alt > 30e6 ? 'GEO' : s.alt > 2e6 ? 'MEO' : 'LEO'),
      rows: (): InfoRow[] => {
        const periodMin = (2 * Math.PI) / s.rec.no;
        return [
          { label: t('altitude'), value: `${Math.round(s.alt / 1000).toLocaleString()} km` },
          { label: t('speed'), value: `${s.vel.toFixed(2)} km/s · ${Math.round(s.vel * 3600).toLocaleString()} km/h` },
          { label: t('period'), value: `${periodMin.toFixed(1)} min` },
          { label: t('inclination'), value: `${(s.rec.inclo / DEG).toFixed(1)}°` },
          { label: t('norad'), value: s.id },
          { label: 'Lat / Lon', value: `${s.lat.toFixed(2)}°, ${s.lon.toFixed(2)}°` },
        ];
      },
      position: () => (layer.sats.includes(s) && s.ok ? { lat: s.lat, lon: s.lon } : null),
    };
  }

  /** Selects a satellite by (part of) its name, e.g. the ISS. */
  find(name: string): unknown {
    return this.sats.find((s) => s.ok && s.name.toUpperCase().includes(name)) ?? null;
  }

  onSelect(sel: Selection | null): void {
    this.selected = sel && sel.layer === this.id ? (this.sats.find((s) => s.id === sel.id) ?? null) : null;
    this.trackAt = 0;
    if (!this.selected) this.setTrack([]);
  }

  /** Ground track for the next orbit. */
  private drawTrack(now: number): void {
    this.trackAt = now;
    const s = this.selected;
    if (!s) return;
    const periodMin = Math.min(180, (2 * Math.PI) / s.rec.no);
    const probe: Sat = { ...s, ok: false };
    const coords: [number, number][] = [];
    let prev = NaN;
    for (let i = 0; i <= 120; i++) {
      const date = new Date(now + (i / 120) * periodMin * 60000);
      if (!this.place(probe, date, gstime(date))) continue;
      let lon = probe.lon;
      if (!Number.isNaN(prev)) {
        while (lon - prev > 180) lon -= 360;
        while (lon - prev < -180) lon += 360;
      }
      prev = lon;
      coords.push([lon, probe.lat]);
    }
    this.setTrack(coords);
  }

  private setTrack(coords: [number, number][]): void {
    const src = this.ctx.map.getSource('orbit') as { setData(d: GeoJSON.FeatureCollection): void } | undefined;
    src?.setData({
      type: 'FeatureCollection',
      features: coords.length > 1 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }] : [],
    });
  }
}
