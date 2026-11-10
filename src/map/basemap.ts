// Base map: OpenStreetMap vector tiles (OpenFreeMap), real terrain (Mapterhorn),
// extruded buildings and the view modes. No API keys anywhere.

import { Map as MlMap, AttributionControl, GeolocateControl, NavigationControl, setWorkerUrl, type CustomLayerInterface, type LayerSpecification, type StyleSpecification } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { Tier } from '../core';
import { subSolarPoint, DEG } from '../util/geo';

setWorkerUrl(workerUrl);

export type Mode = 'mini' | 'map' | 'sat' | 'night';
export const MODES: Mode[] = ['mini', 'map', 'sat', 'night'];

const STYLE_URL = { light: 'https://tiles.openfreemap.org/styles/liberty', dark: 'https://tiles.openfreemap.org/styles/dark' };
const OVERLAY_SOURCES = ['route', 'orbit', 'places', 'night'] as const;
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const FONT = ['Noto Sans Regular'];
const FONT_BOLD = ['Noto Sans Bold'];
/** Terrain is only switched on once mountains are actually perceptible. */
const TERRAIN_MIN_ZOOM = 8.5;

export class Basemap {
  readonly map: MlMap;
  mode: Mode;
  readonly vectorSource = 'openmaptiles';
  private base = new Map<string, StyleSpecification>();
  private custom: CustomLayerInterface | null = null;
  private terrainOn = false;
  private nightAt = 0;

  private constructor(private readonly tier: Tier, mode: Mode, map: MlMap) {
    this.mode = mode;
    this.map = map;
  }

  static async create(container: string, tier: Tier, mode: Mode): Promise<Basemap> {
    const probe = new Basemap(tier, mode, null as unknown as MlMap);
    const style = await probe.buildStyle(mode, null);
    // Start over the viewer's side of the planet (guessed from their clock, not their location).
    const lon = Math.max(-170, Math.min(170, -(new Date().getTimezoneOffset() / 60) * 15));
    const map = new MlMap({
      container,
      style,
      center: [lon, 12],
      zoom: 1.7,
      minZoom: 0.8,
      maxZoom: 19,
      maxPitch: 80,
      hash: true,
      attributionControl: false,
      pixelRatio: tier.pixelRatio,
      canvasContextAttributes: { antialias: tier.quality !== 'low', powerPreference: 'high-performance' },
      fadeDuration: 150,
      cancelPendingTileRequestsWhileZooming: true,
    });
    const self = new Basemap(tier, mode, map);
    self.base = probe.base;
    map.addControl(new AttributionControl({ compact: true }), 'bottom-right');
    map.addControl(new NavigationControl({ visualizePitch: true }), 'bottom-right');
    map.addControl(new GeolocateControl({ positionOptions: { enableHighAccuracy: false }, trackUserLocation: false }), 'bottom-right');
    map.on('styledata', () => self.ensureCustom());
    map.on('idle', () => self.ensureCustom());
    map.on('zoom', () => self.syncTerrain());
    map.on('error', (e) => {
      // Tile 404s over oceans and beyond a source's max zoom are expected; keep the console quiet.
      if (!/tile|404|Failed to fetch|AbortError/i.test(String(e.error?.message ?? ''))) console.warn('[tinyfoot]', e.error);
    });
    await new Promise<void>((resolve) => (map.loaded() ? resolve() : map.once('load', () => resolve())));
    self.syncTerrain();
    self.updateNight(Date.now());
    return self;
  }

  /** Registers the 3D layer; it is re-inserted whenever the style is swapped. */
  attach(layer: CustomLayerInterface): void {
    this.custom = layer;
    this.ensureCustom();
  }

  private ensureCustom(): void {
    const map = this.map;
    if (!this.custom) return;
    try {
      if (map.getLayer(this.custom.id)) return;
      // Sit above the buildings but below labels, so place names stay readable.
      const layers = map.getStyle().layers;
      const after = layers.findIndex((l) => l.id === 'tf-buildings');
      const before = layers.slice(after + 1).find((l) => l.type === 'symbol' || l.id.startsWith('tf-'));
      map.addLayer(this.custom, before?.id);
    } catch {
      // Style still loading; the next 'styledata' or 'idle' event retries.
    }
  }

  private syncTerrain(): void {
    const want = this.tier.terrain && this.map.getZoom() >= TERRAIN_MIN_ZOOM;
    if (want === this.terrainOn || !this.map.isStyleLoaded()) return;
    this.terrainOn = want;
    try {
      this.map.setTerrain(want ? { source: 'terrain', exaggeration: this.mode === 'mini' ? 1.2 : 1 } : null);
    } catch {
      this.terrainOn = !want;
    }
  }

  /** Re-applies settings after the quality tier changed at runtime. */
  applyTier(): void {
    this.map.setPixelRatio(this.tier.pixelRatio);
    this.syncTerrain();
  }

  /** Ground elevation in metres, matching what the map draws. */
  elevation(lat: number, lon: number): number {
    if (!this.terrainOn) return 0;
    try {
      return this.map.queryTerrainElevation([lon, lat]) ?? 0;
    } catch {
      return 0;
    }
  }

  async setMode(mode: Mode): Promise<void> {
    if (mode === this.mode) return;
    const style = await this.buildStyle(mode, this.map);
    this.mode = mode;
    this.terrainOn = false;
    this.map.setStyle(style, { diff: false });
    this.map.once('styledata', () => {
      this.syncTerrain();
      this.ensureCustom();
    });
    if (mode === 'mini' && this.map.getZoom() > 9 && this.map.getPitch() < 35) this.map.easeTo({ pitch: 55, duration: 900 });
  }

  /** Day/night shading on the globe, from the real position of the sun. */
  updateNight(now: number): void {
    if (now - this.nightAt < 60000) return;
    const src = this.map.getSource('night') as { setData(d: GeoJSON.FeatureCollection): void } | undefined;
    if (!src) return;
    this.nightAt = now;
    const [sunLon, sunLat] = subSolarPoint(now);
    const tan = Math.tan((Math.abs(sunLat) < 0.5 ? (sunLat < 0 ? -0.5 : 0.5) : sunLat) * DEG);
    const pole = sunLat > 0 ? -85 : 85;
    const edge = (lon: number): number => Math.max(-85, Math.min(85, Math.atan(-Math.cos((lon - sunLon) * DEG) / tan) / DEG));
    // Many narrow strips instead of one planet-sized polygon: those tessellate cleanly on the globe.
    const step = 4;
    const strips: [number, number][][][] = [];
    for (let lon = -180; lon < 180; lon += step) {
      const a = edge(lon);
      const b = edge(lon + step);
      // Split tall strips so that no single piece spans a large part of the sphere.
      const parts = Math.max(1, Math.ceil(Math.abs(pole - (a + b) / 2) / 12));
      for (let i = 0; i < parts; i++) {
        const f0 = i / parts;
        const f1 = (i + 1) / parts;
        const a0 = a + (pole - a) * f0, a1 = a + (pole - a) * f1;
        const b0 = b + (pole - b) * f0, b1 = b + (pole - b) * f1;
        strips.push([[[lon, a0], [lon + step, b0], [lon + step, b1], [lon, a1], [lon, a0]]]);
      }
    }
    src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: strips } }] });
  }

  private async baseStyle(kind: 'light' | 'dark'): Promise<StyleSpecification> {
    let style = this.base.get(kind);
    if (!style) {
      const res = await fetch(STYLE_URL[kind]);
      if (!res.ok) throw new Error(`style ${res.status}`);
      style = (await res.json()) as StyleSpecification;
      this.base.set(kind, style);
    }
    return structuredClone(style);
  }

  private async buildStyle(mode: Mode, map: MlMap | null): Promise<StyleSpecification> {
    const dark = mode === 'night';
    const style = await this.baseStyle(dark ? 'dark' : 'light');
    const previous = map?.getStyle().sources ?? {};

    style.projection = { type: 'globe' };
    style.sources.terrain = { type: 'raster-dem', url: 'https://tiles.mapterhorn.com/tilejson.json' };
    style.sources.hillshade = { type: 'raster-dem', url: 'https://tiles.mapterhorn.com/tilejson.json' };
    if (mode === 'sat') {
      style.sources.imagery = {
        type: 'raster',
        tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg'],
        tileSize: 256,
        maxzoom: 15,
        attribution: '<a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless</a> by EOX (Copernicus Sentinel data 2020)',
      };
    }
    for (const id of OVERLAY_SOURCES) {
      const prev = previous[id] as { data?: unknown } | undefined;
      style.sources[id] = { type: 'geojson', data: (prev?.data as GeoJSON.FeatureCollection | undefined) ?? EMPTY };
    }

    style.sky = dark
      ? { 'sky-color': '#0b1020', 'horizon-color': '#1b2440', 'fog-color': '#0b1020', 'fog-ground-blend': 0.7, 'horizon-fog-blend': 0.6, 'sky-horizon-blend': 0.8, 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.9, 5, 0.9, 7, 0] }
      : { 'sky-color': '#7fbcff', 'horizon-color': '#eaf4ff', 'fog-color': '#ffffff', 'fog-ground-blend': 0.6, 'horizon-fog-blend': 0.5, 'sky-horizon-blend': 0.75, 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0] };
    style.light = { anchor: 'viewport', position: [1.4, 215, 38], intensity: dark ? 0.25 : 0.45, color: '#ffffff' };

    let layers: LayerSpecification[] = style.layers.filter((l) => l.type !== 'fill-extrusion');

    if (mode === 'sat') {
      // Imagery replaces every painted surface; roads, borders and labels stay on top.
      layers = layers.filter((l) => l.type !== 'fill' && l.type !== 'background' && l.id !== 'natural_earth');
      layers.unshift({ id: 'tf-space', type: 'background', paint: { 'background-color': '#0b1a2b' } }, { id: 'tf-imagery', type: 'raster', source: 'imagery', paint: { 'raster-fade-duration': 150 } });
      for (const l of layers) {
        if (l.type === 'line' && l['source-layer'] === 'transportation') l.paint = { ...l.paint, 'line-opacity': 0.55 };
      }
    } else if (mode === 'mini') {
      // A touch more colour for the model-railway look.
      for (const l of layers) {
        if (l.id === 'background') l.paint = { 'background-color': '#f3efe6' };
        if (l.id === 'water' && l.type === 'fill') l.paint = { ...l.paint, 'fill-color': '#8ccbf2' };
        if ((l.id === 'landcover_wood' || l.id === 'park') && l.type === 'fill') l.paint = { ...l.paint, 'fill-color': l.id === 'park' ? '#bfe6a8' : '#9ed48a', 'fill-opacity': 0.75 };
        if (l.id === 'landcover_grass' && l.type === 'fill') l.paint = { ...l.paint, 'fill-color': '#c9ecb0', 'fill-opacity': 0.7 };
      }
    }

    const firstLine = layers.findIndex((l) => l.type === 'line');
    const hillshade: LayerSpecification = {
      id: 'tf-hillshade',
      type: 'hillshade',
      source: 'hillshade',
      maxzoom: 16,
      paint: {
        'hillshade-exaggeration': mode === 'sat' ? 0.25 : dark ? 0.35 : 0.42,
        'hillshade-shadow-color': dark ? '#000000' : '#5a4a3a',
        'hillshade-highlight-color': dark ? '#3a4763' : '#ffffff',
        'hillshade-accent-color': dark ? '#0a0d14' : '#6b5d4d',
      },
    };
    layers.splice(firstLine < 0 ? layers.length : firstLine, 0, hillshade);

    const night: LayerSpecification = {
      id: 'tf-night',
      type: 'fill',
      source: 'night',
      maxzoom: 9,
      paint: { 'fill-color': '#050a1c', 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 0, dark ? 0.45 : 0.34, 5, dark ? 0.4 : 0.28, 9, 0], 'fill-antialias': false },
    };

    const buildings: LayerSpecification = {
      id: 'tf-buildings',
      type: 'fill-extrusion',
      source: this.vectorSource,
      'source-layer': 'building',
      minzoom: 13,
      filter: ['!=', ['get', 'hide_3d'], true],
      paint: {
        'fill-extrusion-color': dark
          ? ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 6], 0, '#262b38', 60, '#313849', 200, '#414c63']
          : mode === 'mini'
            ? ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 6], 0, '#f4ead9', 25, '#efe2cf', 80, '#e3dfe4', 200, '#cfdcec', 400, '#bfd2ea']
            : ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 6], 0, '#ece8e1', 60, '#dfdcd6', 200, '#ccd5e0', 400, '#bccbe0'],
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13, 0, 14.2, ['coalesce', ['get', 'render_height'], 6]],
        'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 13, 0, 14.2, ['coalesce', ['get', 'render_min_height'], 0]],
        'fill-extrusion-opacity': mode === 'sat' ? 0.88 : 1,
        'fill-extrusion-vertical-gradient': true,
      },
    };

    const firstSymbol = layers.findIndex((l) => l.type === 'symbol');
    const at = firstSymbol < 0 ? layers.length : firstSymbol;
    const halo = dark ? '#10141f' : '#ffffff';
    const ink = dark ? '#e9ecef' : '#1f2933';
    const overlays: LayerSpecification[] = [
      { id: 'tf-orbit', type: 'line', source: 'orbit', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ffc83d', 'line-width': 1.6, 'line-opacity': 0.85, 'line-dasharray': [2, 2] } },
      { id: 'tf-route-ahead', type: 'line', source: 'route', filter: ['==', ['get', 'kind'], 'ahead'], layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ffc83d', 'line-width': 2, 'line-opacity': 0.9, 'line-dasharray': [1.5, 2] } },
      { id: 'tf-route-flown', type: 'line', source: 'route', filter: ['==', ['get', 'kind'], 'flown'], layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ffc83d', 'line-width': 2, 'line-opacity': 0.45 } },
      { id: 'tf-route-airport', type: 'circle', source: 'route', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 5, 'circle-color': '#ffc83d', 'circle-stroke-color': '#1f2933', 'circle-stroke-width': 1.5 } },
      {
        id: 'tf-places',
        type: 'circle',
        source: 'places',
        minzoom: 14.7,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 14.7, 2.4, 17, 5, 19, 7],
          'circle-color': ['match', ['get', 'state'], 'open', '#2fb344', 'closed', '#e5484d', '#8b949e'],
          'circle-stroke-color': halo,
          'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 14.7, 0.6, 17, 1.4],
          'circle-opacity': ['match', ['get', 'state'], 'unknown', 0.7, 1],
        },
      },
    ];
    const labels: LayerSpecification[] = [
      {
        id: 'tf-route-airport-label',
        type: 'symbol',
        source: 'route',
        filter: ['==', ['geometry-type'], 'Point'],
        layout: { 'text-field': ['get', 'label'], 'text-font': FONT_BOLD, 'text-size': 12, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-allow-overlap': true },
        paint: { 'text-color': ink, 'text-halo-color': halo, 'text-halo-width': 1.6 },
      },
      {
        id: 'tf-places-label',
        type: 'symbol',
        source: 'places',
        minzoom: 16.4,
        filter: ['!=', ['get', 'name'], ''],
        layout: { 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 11, 'text-offset': [0, 0.8], 'text-anchor': 'top', 'text-max-width': 8, 'text-optional': true },
        paint: {
          'text-color': ['match', ['get', 'state'], 'open', dark ? '#69db7c' : '#1c7c2c', 'closed', dark ? '#ff8787' : '#b42318', dark ? '#adb5bd' : '#57606a'],
          'text-halo-color': halo,
          'text-halo-width': 1.4,
        },
      },
    ];
    // The stock POI icons would sit under our open/closed dots; ours carry more information.
    layers = layers.filter((l) => !/^poi_r/.test(l.id));
    const at2 = layers.findIndex((l) => l.type === 'symbol');
    layers.splice(at2 < 0 ? Math.min(at, layers.length) : at2, 0, night, buildings, ...overlays);
    layers.push(...labels);
    style.layers = layers;
    return style;
  }
}
