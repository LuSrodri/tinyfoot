// Base map: Mapbox Standard (3D buildings, detailed landmarks, trees, dynamic lighting, terrain)
// with NASA GIBS on top for what the planet actually looks like today.

import mapboxgl, { type CustomLayerInterface, type Map as MbMap } from 'mapbox-gl';
import { MAPBOX_TOKEN } from '../config';
import type { Tier } from '../core';
import { DEG, solarHour, subSolarPoint, sunElevation } from '../util/geo';

export type Mode = 'mini' | 'map' | 'sat' | 'night';
export const MODES: Mode[] = ['mini', 'map', 'sat', 'night'];

const STYLE = { std: 'mapbox://styles/mapbox/standard', sat: 'mapbox://styles/mapbox/standard-satellite' };
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const DATA_SOURCES = ['route', 'orbit', 'places', 'night', 'water'];
const FONT = ['DIN Pro Medium', 'Arial Unicode MS Regular'];
const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';

export interface Weather {
  /** mm/h */
  rain: number;
  /** cm/h */
  snow: number;
  /** metres */
  visibility: number;
  /** 0..1 */
  cloud: number;
  /** degrees the wind blows from, and km/h */
  windDir: number;
  windSpeed: number;
}

export class Basemap {
  mode: Mode;
  /** Vector source the traffic simulation reads street geometry from. */
  readonly vectorSource = 'tf-streets';
  private custom: CustomLayerInterface | null = null;
  private data: Record<string, GeoJSON.FeatureCollection> = {};
  private nightAt = 0;
  private preset = '';
  private autoTilt = true;
  private weather: Weather | null = null;

  private constructor(readonly map: MbMap, private readonly tier: Tier, mode: Mode) {
    this.mode = mode;
  }

  static async create(container: string, tier: Tier, mode: Mode): Promise<Basemap> {
    mapboxgl.accessToken = MAPBOX_TOKEN;
    // Start over the viewer's side of the planet (guessed from their clock, not their location).
    const lon = Math.max(-170, Math.min(170, -(new Date().getTimezoneOffset() / 60) * 15));
    const map = new mapboxgl.Map({
      container,
      style: mode === 'sat' ? STYLE.sat : STYLE.std,
      projection: 'globe',
      center: [lon, 12],
      zoom: 1.7,
      minZoom: 0.8,
      maxPitch: 80,
      hash: true,
      antialias: tier.quality !== 'low',
      attributionControl: true,
    });
    const self = new Basemap(map, tier, mode);
    map.on('style.load', () => self.decorate());
    map.on('moveend', () => self.tilt());
    map.on('pitchstart', (e) => {
      if ((e as { originalEvent?: unknown }).originalEvent) self.autoTilt = false;
    });
    map.on('error', (e) => {
      if (!/tile|404|Failed to fetch|AbortError/i.test(String(e.error?.message ?? ''))) console.warn('[tinyfoot]', e.error);
    });
    await new Promise<void>((resolve) => (map.loaded() ? resolve() : map.once('load', () => resolve())));
    if (!map.getSource('night')) self.decorate();
    self.tilt();
    return self;
  }

  /**
   * Seen from straight above, 3D buildings and aircraft look flat. So once a move ends the camera
   * leans over to suit the zoom: top-down at globe scale, about 60 degrees at street scale.
   * It stops as soon as you set the tilt yourself, until you zoom back out to the globe.
   */
  private tilt(): void {
    const map = this.map;
    const zoom = map.getZoom();
    if (zoom < 5) this.autoTilt = true;
    if (!this.autoTilt) return;
    const f = Math.max(0, Math.min(1, (zoom - 5.5) / 7));
    const target = 60 * f * f * (3 - 2 * f);
    if (Math.abs(target - map.getPitch()) > 3) map.easeTo({ pitch: target, duration: 700 });
  }

  /** Registers the 3D layer; it is re-inserted whenever the style is swapped. */
  attach(layer: CustomLayerInterface): void {
    this.custom = layer;
    if (this.map.isStyleLoaded() && !this.map.getLayer(layer.id)) this.map.addLayer(layer);
  }

  /** Adds everything that is ours to a freshly loaded Mapbox style. */
  private decorate(): void {
    const map = this.map;
    const sat = this.mode === 'sat';

    map.addSource('mapbox-dem', { type: 'raster-dem', url: 'mapbox://mapbox.mapbox-terrain-dem-v1', tileSize: 512, maxzoom: 14 });
    this.applyTier();

    // NASA GIBS: the most recent daily true-colour image of the whole Earth (real clouds, real
    // snow cover, real smoke), and the latest satellite-measured precipitation.
    // Today's image is still being assembled orbit by orbit, so use yesterday's, which is complete.
    const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    map.addSource('gibs-color', {
      type: 'raster',
      tiles: [`${GIBS}/VIIRS_NOAA20_CorrectedReflectance_TrueColor/default/${day}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`],
      tileSize: 256,
      maxzoom: 9,
      attribution: 'Imagery: <a href="https://earthdata.nasa.gov/gibs" target="_blank" rel="noopener">NASA GIBS</a>',
    });
    map.addSource('gibs-rain', {
      type: 'raster',
      tiles: [`${GIBS}/IMERG_Precipitation_Rate/default/default/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`],
      tileSize: 256,
      maxzoom: 6,
    });
    map.addLayer({
      id: 'tf-gibs',
      type: 'raster',
      slot: 'bottom',
      source: 'gibs-color',
      maxzoom: 9.5,
      paint: {
        // Macro view: the real planet. It gives way to the map (or to aerial imagery) as you come down.
        'raster-opacity': sat ? ['interpolate', ['linear'], ['zoom'], 5.5, 1, 8.5, 0] : ['interpolate', ['linear'], ['zoom'], 3.5, 0.92, 6.5, 0],
        'raster-fade-duration': 200,
      },
    });
    map.addLayer({
      id: 'tf-gibs-rain',
      type: 'raster',
      slot: 'middle',
      source: 'gibs-rain',
      maxzoom: 10,
      paint: { 'raster-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.42, 7, 0.38, 10, 0], 'raster-resampling': 'linear' },
    });

    // Street geometry for the traffic and pedestrian simulation (never drawn).
    map.addSource(this.vectorSource, { type: 'vector', url: 'mapbox://mapbox.mapbox-streets-v8' });
    map.addLayer({ id: 'tf-streets-probe', type: 'line', slot: 'bottom', source: this.vectorSource, 'source-layer': 'road', minzoom: 14.5, paint: { 'line-opacity': 0.01, 'line-width': 0.1 } });

    for (const id of DATA_SOURCES) {
      map.addSource(id, { type: 'geojson', data: this.data[id] ?? EMPTY });
      // Remember what each source holds so that a style swap does not lose it.
      const src = map.getSource(id) as unknown as { setData(d: GeoJSON.FeatureCollection): unknown };
      const original = src.setData.bind(src);
      src.setData = (d) => {
        this.data[id] = d;
        return original(d);
      };
    }

    const top = { slot: 'top' } as const;
    map.addLayer({ id: 'tf-night', type: 'fill', ...top, source: 'night', maxzoom: 7, paint: { 'fill-color': '#050a1c', 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.4, 4.5, 0.32, 7, 0], 'fill-antialias': false } });
    map.addLayer({ id: 'tf-orbit', type: 'line', ...top, source: 'orbit', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ffc83d', 'line-width': 1.6, 'line-opacity': 0.85, 'line-dasharray': [2, 2], 'line-emissive-strength': 1 } });
    map.addLayer({ id: 'tf-route-ahead', type: 'line', ...top, source: 'route', filter: ['==', ['get', 'kind'], 'ahead'], layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ffc83d', 'line-width': 2, 'line-opacity': 0.9, 'line-dasharray': [1.5, 2], 'line-emissive-strength': 1 } });
    map.addLayer({ id: 'tf-route-flown', type: 'line', ...top, source: 'route', filter: ['==', ['get', 'kind'], 'flown'], layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ffc83d', 'line-width': 2, 'line-opacity': 0.45, 'line-emissive-strength': 1 } });
    map.addLayer({ id: 'tf-route-airport', type: 'circle', ...top, source: 'route', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 5, 'circle-color': '#ffc83d', 'circle-stroke-color': '#1f2933', 'circle-stroke-width': 1.5, 'circle-emissive-strength': 1 } });
    map.addLayer({ id: 'tf-route-airport-label', type: 'symbol', ...top, source: 'route', filter: ['==', ['geometry-type'], 'Point'], layout: { 'text-field': ['get', 'label'], 'text-font': FONT, 'text-size': 12, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-allow-overlap': true }, paint: { 'text-color': '#1f2933', 'text-halo-color': '#ffffff', 'text-halo-width': 1.6, 'text-emissive-strength': 1 } });

    // Shops and places: a small dot, green when open and red when closed, only at street level.
    map.addLayer({
      id: 'tf-places',
      type: 'circle',
      ...top,
      source: 'places',
      minzoom: 17.3,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 17.3, 2, 19.5, 4.5],
        'circle-color': ['match', ['get', 'state'], 'open', '#2fb344', 'closed', '#e5484d', '#8b949e'],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1,
        'circle-opacity': ['match', ['get', 'state'], 'unknown', 0.6, 0.95],
        'circle-emissive-strength': 1,
      },
    });

    // River gauges and flood points: blue is normal, amber is high, red is flooding.
    map.addLayer({
      id: 'tf-water',
      type: 'circle',
      ...top,
      source: 'water',
      minzoom: 5,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 3, 10, 6, 15, 9],
        'circle-color': ['match', ['get', 'level'], 'flood', '#e5484d', 'high', '#f59f00', 'low', '#9aa7b4', '#2f80ed'],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5,
        'circle-emissive-strength': 1,
      },
    });
    map.addLayer({
      id: 'tf-water-label',
      type: 'symbol',
      ...top,
      source: 'water',
      minzoom: 9,
      layout: { 'text-field': ['get', 'label'], 'text-font': FONT, 'text-size': 11, 'text-offset': [0, 1], 'text-anchor': 'top', 'text-optional': true, 'text-max-width': 9 },
      paint: { 'text-color': ['match', ['get', 'level'], 'flood', '#b42318', 'high', '#9a5b00', '#0b4a99'], 'text-halo-color': '#ffffff', 'text-halo-width': 1.4, 'text-emissive-strength': 1 },
    });

    if (this.custom && !map.getLayer(this.custom.id)) map.addLayer(this.custom);
    this.preset = '';
    this.nightAt = 0;
    this.updateLight(Date.now());
    this.applyWeather();
  }

  /** Re-applies settings after the quality tier changed at runtime. */
  applyTier(): void {
    try {
      this.map.setTerrain(this.tier.terrain ? { source: 'mapbox-dem', exaggeration: 1 } : null);
    } catch {
      /* style not ready */
    }
  }

  /** Ground elevation in metres, matching what the map draws. */
  elevation(lat: number, lon: number): number {
    try {
      return this.map.queryTerrainElevation([lon, lat]) ?? 0;
    } catch {
      return 0;
    }
  }

  async setMode(mode: Mode): Promise<void> {
    if (mode === this.mode) return;
    const before = this.mode === 'sat' ? STYLE.sat : STYLE.std;
    const after = mode === 'sat' ? STYLE.sat : STYLE.std;
    this.mode = mode;
    if (before !== after) {
      this.map.setStyle(after);
      await new Promise<void>((resolve) => this.map.once('style.load', () => resolve()));
    } else {
      this.preset = '';
      this.updateLight(Date.now());
    }
  }

  /**
   * Lighting follows the real sun at the place you are looking at (dawn, day, dusk or night),
   * and the day/night boundary is drawn on the globe.
   */
  updateLight(now: number): void {
    const map = this.map;
    const c = map.getCenter();
    const sun = sunElevation(c.lat, c.lng, now);
    const preset = this.mode === 'night' || sun < -5 ? 'night' : sun > 7 ? 'day' : solarHour(c.lng, now) < 12 ? 'dawn' : 'dusk';
    if (preset !== this.preset) {
      try {
        map.setConfigProperty('basemap', 'lightPreset', preset);
        this.preset = preset;
      } catch {
        /* style still loading */
      }
    }
    if (now - this.nightAt < 60000) return;
    const src = map.getSource('night') as { setData(d: GeoJSON.FeatureCollection): void } | undefined;
    if (!src) return;
    this.nightAt = now;
    const [sunLon, sunLat] = subSolarPoint(now);
    const tan = Math.tan((Math.abs(sunLat) < 0.5 ? (sunLat < 0 ? -0.5 : 0.5) : sunLat) * DEG);
    const pole = sunLat > 0 ? -85 : 85;
    const edge = (lon: number): number => Math.max(-85, Math.min(85, Math.atan(-Math.cos((lon - sunLon) * DEG) / tan) / DEG));
    // Many small pieces instead of one planet-sized polygon: those tessellate cleanly on the globe.
    const step = 4;
    const strips: [number, number][][][] = [];
    for (let lon = -180; lon < 180; lon += step) {
      const a = edge(lon);
      const b = edge(lon + step);
      const parts = Math.max(1, Math.ceil(Math.abs(pole - (a + b) / 2) / 12));
      for (let i = 0; i < parts; i++) {
        const f0 = i / parts, f1 = (i + 1) / parts;
        const a0 = a + (pole - a) * f0, a1 = a + (pole - a) * f1;
        const b0 = b + (pole - b) * f0, b1 = b + (pole - b) * f1;
        strips.push([[[lon, a0], [lon + step, b0], [lon + step, b1], [lon, a1], [lon, a0]]]);
      }
    }
    src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: strips } }] });
  }

  /** Shows the weather that is really happening where you are looking: rain, snow and fog. */
  setWeather(w: Weather | null): void {
    this.weather = w;
    this.applyWeather();
  }

  private applyWeather(): void {
    const map = this.map;
    const w = this.weather;
    try {
      // Precipitation is only drawn once you are close enough to be "in" it.
      const near = map.getZoom() > 9;
      if (w && near && w.rain > 0.05 && w.snow <= 0) {
        const k = Math.min(1, w.rain / 8);
        map.setRain({
          density: 0.2 + 0.6 * k,
          intensity: 0.4 + 0.6 * k,
          color: '#a8b3c4',
          opacity: 0.55 + 0.3 * k,
          vignette: 0.3 + 0.5 * k,
          'vignette-color': '#56606e',
          direction: [(w.windDir + 180) % 360, Math.max(55, 85 - w.windSpeed * 0.6)],
          'droplet-size': [1.1, 9 + 9 * k],
          'distortion-strength': 0.5,
          'center-thinning': 0,
        });
      } else {
        map.setRain(null);
      }
      if (w && near && w.snow > 0) {
        const k = Math.min(1, w.snow / 3);
        map.setSnow({ density: 0.3 + 0.7 * k, intensity: 0.5 + 0.5 * k, color: '#ffffff', opacity: 0.9, vignette: 0.3 * k, 'flake-size': 0.7, direction: [(w.windDir + 180) % 360, 55] });
      } else {
        map.setSnow(null);
      }
      // Fog and low cloud shorten how far you can see.
      if (w && w.visibility < 6000) {
        const k = 1 - Math.max(0, w.visibility - 300) / 5700;
        map.setFog({ range: [0.4 - 0.9 * k, 7 - 5.5 * k], color: '#d9dee3', 'high-color': '#c5ccd4', 'horizon-blend': 0.25, 'space-color': '#0b1a2b', 'star-intensity': 0 });
      } else {
        map.setFog(null);
      }
    } catch {
      /* effects are optional */
    }
  }
}
