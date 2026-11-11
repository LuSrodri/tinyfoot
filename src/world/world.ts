// The 3D world: CesiumJS streaming Google Photorealistic 3D Tiles through Cesium ion, seen through
// a near-isometric camera with a tilt-shift lens. From orbit the planet is shown as today's NASA
// satellite image; the photorealistic city takes over as you come down.
//
// It also offers the small map-like interface (centre, zoom, bounds, data sources, camera moves,
// events) that the data layers were written against, so they do not need to know about Cesium.

import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  CesiumTerrainProvider,
  CesiumWidget,
  Color,
  Ellipsoid,
  Globe,
  HeadingPitchRange,
  ImageryLayer,
  Ion,
  IonGeocodeProviderType,
  IonGeocoderService,
  JulianDate,
  LabelCollection,
  LabelStyle,
  Math as CMath,
  Matrix4,
  NearFarScalar,
  PerspectiveFrustum,
  PointPrimitiveCollection,
  PolylineCollection,
  PostProcessStage,
  Ray,
  Rectangle,
  SceneTransforms,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  UrlTemplateImageryProvider,
  VerticalOrigin,
  createGooglePhotorealistic3DTileset,
  sampleTerrainMostDetailed,
  Material,
  DistanceDisplayCondition,
  type Cesium3DTileset,
  type PointPrimitive,
  type Label,
} from 'cesium';
import { CESIUM_ION_TOKEN } from '../config';
import type { Tier } from '../core';
import { DEG, EARTH_C, solarHour, sunElevation } from '../util/geo';

export type Mode = 'mini' | 'photo' | 'night';
export const MODES: Mode[] = ['mini', 'photo', 'night'];

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

export interface LngLat {
  lng: number;
  lat: number;
}

export interface CameraOptions {
  center?: [number, number];
  zoom?: number;
  /** Degrees from straight down (0) toward the horizon. */
  pitch?: number;
  /** Degrees clockwise from north. */
  bearing?: number;
  /** Milliseconds. */
  duration?: number;
}

interface Bounds {
  getWest(): number;
  getEast(): number;
  getSouth(): number;
  getNorth(): number;
}

export interface MapEvent {
  point: { x: number; y: number };
  lngLat: LngLat;
}

export interface Feature {
  properties: Record<string, unknown>;
  geometry: GeoJSON.Geometry;
}

/** The subset of a map API the data layers use. */
export interface WorldMap {
  getCenter(): LngLat;
  getZoom(): number;
  getPitch(): number;
  getBounds(): Bounds;
  getCanvas(): HTMLCanvasElement;
  project(p: [number, number] | LngLat): { x: number; y: number };
  getSource(id: string): { setData(d: GeoJSON.FeatureCollection): void } | undefined;
  getLayer(id: string): boolean;
  queryRenderedFeatures(box: [[number, number], [number, number]], opts: { layers: string[] }): Feature[];
  on(event: string, fn: (e: MapEvent) => void): void;
  once(event: string, fn: () => void): void;
  jumpTo(o: CameraOptions): void;
  easeTo(o: CameraOptions): void;
  flyTo(o: CameraOptions & { speed?: number; curve?: number; essential?: boolean }): void;
  fitBounds(b: [[number, number], [number, number]], o?: { maxZoom?: number; pitch?: number; duration?: number; padding?: number }): void;
}

/** Narrow field of view: the camera stands far back, so the city reads almost isometric. */
const FOV = 22 * DEG;
const GLOBE_ABOVE = 260_000;
const CITY_BELOW = 200_000;
const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';

// ---------------------------------------------------------------------- post-processing

/** Miniature colour: livelier saturation and contrast, a gentle vignette, and the night look. */
const STYLE_FS = `
uniform sampler2D colorTexture;
uniform float u_amount;
uniform float u_night;
in vec2 v_textureCoordinates;
void main() {
  vec3 c = texture(colorTexture, v_textureCoordinates).rgb;
  // Local contrast: a cheap unsharp mask brings out window frames and kerbs.
  vec2 px = 1.0 / czm_viewport.zw;
  vec3 blur = (texture(colorTexture, v_textureCoordinates + vec2(px.x, 0.0)).rgb + texture(colorTexture, v_textureCoordinates - vec2(px.x, 0.0)).rgb
             + texture(colorTexture, v_textureCoordinates + vec2(0.0, px.y)).rgb + texture(colorTexture, v_textureCoordinates - vec2(0.0, px.y)).rgb) * 0.25;
  c = mix(c, c + (c - blur) * 0.9, u_amount);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, 1.0 + 0.38 * u_amount);
  c = (c - 0.5) * (1.0 + 0.1 * u_amount) + 0.5 + 0.015 * u_amount;
  // Night: the photographs were taken by day, so dim them, shift to blue and lift the lights.
  vec3 night = c * vec3(0.26, 0.3, 0.45) + pow(max(c - 0.82, 0.0), vec3(2.0)) * vec3(3.0, 2.4, 1.4);
  c = mix(c, night, u_night);
  vec2 d = v_textureCoordinates - 0.5;
  c *= 1.0 - dot(d, d) * 0.5 * u_amount;
  out_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

/** One direction of the tilt-shift blur: sharp across a band, increasingly soft above and below it. */
const tiltShiftFS = (dir: string) => `
uniform sampler2D colorTexture;
uniform float u_strength;
uniform float u_focus;
uniform float u_band;
in vec2 v_textureCoordinates;
void main() {
  vec2 uv = v_textureCoordinates;
  float k = smoothstep(u_band, u_band + 0.34, abs(uv.y - u_focus));
  float r = k * u_strength;
  if (r < 0.05) { out_FragColor = texture(colorTexture, uv); return; }
  vec2 stepUv = ${dir} * (r / 3.0) / czm_viewport.zw;
  vec4 sum = vec4(0.0);
  float total = 0.0;
  for (int i = -6; i <= 6; i++) {
    float f = float(i);
    float wgt = exp(-0.5 * (f / 3.0) * (f / 3.0));
    sum += texture(colorTexture, uv + stepUv * f) * wgt;
    total += wgt;
  }
  out_FragColor = sum / total;
}`;

/** Rain, snow and fog drawn over the view, from the live weather where you are looking. */
const WEATHER_FS = `
uniform sampler2D colorTexture;
uniform float u_rain;
uniform float u_snow;
uniform float u_fog;
uniform float u_wind;
uniform float u_time;
in vec2 v_textureCoordinates;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 uv = v_textureCoordinates;
  vec4 c = texture(colorTexture, uv);
  vec2 res = czm_viewport.zw;
  vec2 p = uv * res;
  // Fog thickens toward the top of the view, which is further away.
  c.rgb = mix(c.rgb, vec3(0.82, 0.85, 0.88), u_fog * (0.45 + 0.55 * uv.y));
  if (u_rain > 0.0) {
    float streaks = 0.0;
    for (int i = 0; i < 3; i++) {
      float s = float(i) + 1.0;
      vec2 q = p / (vec2(6.0, 64.0) * s) + vec2(u_wind * p.y / (64.0 * s), u_time * (2.6 + s));
      vec2 cell = floor(q);
      float h = hash(cell + s * 17.0);
      vec2 f = fract(q);
      float drop = step(1.0 - u_rain * 0.55, h) * smoothstep(0.5, 0.0, abs(f.x - h)) * smoothstep(1.0, 0.0, f.y);
      streaks += drop * (0.6 / s);
    }
    c.rgb = mix(c.rgb, vec3(0.78, 0.82, 0.88), clamp(streaks, 0.0, 0.7));
    c.rgb *= 1.0 - 0.18 * u_rain;
  }
  if (u_snow > 0.0) {
    float flakes = 0.0;
    for (int i = 0; i < 3; i++) {
      float s = float(i) + 1.0;
      vec2 q = p / (18.0 * s) + vec2(sin(u_time * 0.7 + s) * 0.4 + u_wind * u_time * 0.3, u_time * (0.25 * s + 0.2));
      vec2 cell = floor(q);
      float h = hash(cell + s * 31.0);
      float d = length(fract(q) - vec2(h, fract(h * 13.0)));
      flakes += step(1.0 - u_snow * 0.5, h) * smoothstep(0.09 / s + 0.03, 0.0, d);
    }
    c.rgb = mix(c.rgb, vec3(1.0), clamp(flakes, 0.0, 1.0));
  }
  out_FragColor = c;
}`;

// ---------------------------------------------------------------------- heights

/** Ground heights from Cesium World Terrain, sampled in batches and kept on a ~55 m grid. */
class Heights {
  private cells = new Map<number, number>();
  private queue = new Set<number>();
  private busy = false;
  private provider: CesiumTerrainProvider | null = null;
  /** Difference between the photogrammetry surface and the terrain model, measured on open ground. */
  offset = 0;
  last = 0;
  private static readonly RES = 2048;

  constructor() {
    void CesiumTerrainProvider.fromIonAssetId(1).then((p) => (this.provider = p)).catch(() => undefined);
    window.setInterval(() => void this.pump(), 250);
  }

  private key(i: number, j: number): number {
    return (i + 200000) * 800000 + (j + 400000);
  }

  private cell(i: number, j: number): number | undefined {
    const k = this.key(i, j);
    const v = this.cells.get(k);
    if (v === undefined && this.queue.size < 4000) this.queue.add(k);
    return v;
  }

  get(lat: number, lon: number): number {
    const fi = lat * Heights.RES;
    const fj = lon * Heights.RES;
    const i = Math.floor(fi), j = Math.floor(fj);
    const a = this.cell(i, j), b = this.cell(i, j + 1), c = this.cell(i + 1, j), d = this.cell(i + 1, j + 1);
    if (a === undefined || b === undefined || c === undefined || d === undefined) {
      const known = [a, b, c, d].filter((v): v is number => v !== undefined);
      return (known.length ? known.reduce((s, v) => s + v, 0) / known.length : this.last) + this.offset;
    }
    const u = fj - j, v = fi - i;
    const h = (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
    this.last = h;
    return h + this.offset;
  }

  private async pump(): Promise<void> {
    if (this.busy || !this.provider || !this.queue.size) return;
    this.busy = true;
    const keys = [...this.queue].slice(0, 400);
    for (const k of keys) this.queue.delete(k);
    const carts = keys.map((k) => {
      const i = Math.floor(k / 800000) - 200000;
      const j = (k % 800000) - 400000;
      return Cartographic.fromDegrees(j / Heights.RES, i / Heights.RES);
    });
    try {
      const out = await sampleTerrainMostDetailed(this.provider, carts);
      out.forEach((c, n) => this.cells.set(keys[n], Number.isFinite(c.height) ? c.height : 0));
    } catch {
      /* tiles unavailable; they are asked for again when next needed */
    }
    if (this.cells.size > 300000) this.cells.clear();
    this.busy = false;
  }
}

// ---------------------------------------------------------------------- overlays

type OverlayId = 'route' | 'orbit' | 'places' | 'water';
const OVERLAYS: OverlayId[] = ['route', 'orbit', 'places', 'water'];

interface Marker {
  layer: string;
  position: Cartesian3;
  feature: Feature;
}

/** Points, lines and labels for the data layers (flight routes, orbits, shops, river gauges). */
class Overlays {
  private lines = new PolylineCollection();
  private points = new PointPrimitiveCollection();
  private labels = new LabelCollection();
  private items = new Map<OverlayId, { lines: unknown[]; points: PointPrimitive[]; labels: Label[]; markers: Marker[] }>();

  constructor(private readonly world: World) {
    const scene = world.widget.scene;
    scene.primitives.add(this.lines);
    scene.primitives.add(this.points);
    scene.primitives.add(this.labels);
  }

  set(id: OverlayId, data: GeoJSON.FeatureCollection): void {
    const old = this.items.get(id);
    if (old) {
      for (const l of old.lines) this.lines.remove(l as never);
      for (const p of old.points) this.points.remove(p);
      for (const l of old.labels) this.labels.remove(l);
    }
    const entry = { lines: [] as unknown[], points: [] as PointPrimitive[], labels: [] as Label[], markers: [] as Marker[] };
    this.items.set(id, entry);
    const elev = (lat: number, lon: number) => this.world.elevAt(lat, lon);
    for (const f of data.features) {
      const props = (f.properties ?? {}) as Record<string, unknown>;
      const g = f.geometry;
      if (g.type === 'LineString') {
        // Lines float above the city so that they are never hidden inside buildings.
        const lift = id === 'orbit' ? 25000 : 3000;
        const positions = g.coordinates.map(([lon, lat]) => Cartesian3.fromDegrees(lon, lat, lift));
        const ahead = props.kind === 'ahead';
        entry.lines.push(
          this.lines.add({
            positions,
            width: 2.5,
            material: Material.fromType(ahead || id === 'orbit' ? 'PolylineDash' : 'Color', ahead || id === 'orbit' ? { color: Color.fromCssColorString('#ffc83d'), dashLength: 18 } : { color: Color.fromCssColorString('#ffc83d').withAlpha(0.55) }),
          }),
        );
      } else if (g.type === 'Point') {
        const [lon, lat] = g.coordinates;
        const position = Cartesian3.fromDegrees(lon, lat, elev(lat, lon) + (id === 'places' ? 4 : 12));
        const state = String(props.state ?? props.level ?? '');
        const color =
          id === 'places'
            ? state === 'open' ? '#2fb344' : state === 'closed' ? '#e5484d' : '#8b949e'
            : id === 'water'
              ? state === 'flood' ? '#e5484d' : state === 'high' ? '#f59f00' : state === 'low' ? '#9aa7b4' : '#2f80ed'
              : '#ffc83d';
        entry.points.push(
          this.points.add({
            position,
            pixelSize: id === 'places' ? 7 : 11,
            color: Color.fromCssColorString(color),
            outlineColor: Color.WHITE,
            outlineWidth: 1.5,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            distanceDisplayCondition: id === 'places' ? new DistanceDisplayCondition(0, 4500) : undefined,
          }),
        );
        const text = String(props.label ?? (id === 'places' ? props.name ?? '' : ''));
        if (text && id !== 'places') {
          entry.labels.push(
            this.labels.add({
              position,
              text,
              font: '600 13px system-ui, sans-serif',
              fillColor: Color.fromCssColorString(id === 'water' ? '#0b3a75' : '#1f2933'),
              outlineColor: Color.WHITE,
              outlineWidth: 3,
              style: LabelStyle.FILL_AND_OUTLINE,
              verticalOrigin: VerticalOrigin.TOP,
              pixelOffset: new Cartesian2(0, 9),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              scaleByDistance: new NearFarScalar(2000, 1, 40000, 0.7),
              distanceDisplayCondition: id === 'water' ? new DistanceDisplayCondition(0, 60000) : undefined,
            }),
          );
        }
        entry.markers.push({ layer: `tf-${id}`, position, feature: { properties: props, geometry: g } });
      }
    }
  }

  /** Markers drawn within a screen box. */
  query(box: [[number, number], [number, number]], layers: string[]): Feature[] {
    const scene = this.world.widget.scene;
    const out: { f: Feature; d: number }[] = [];
    const cx = (box[0][0] + box[1][0]) / 2;
    const cy = (box[0][1] + box[1][1]) / 2;
    const tmp = new Cartesian2();
    for (const entry of this.items.values()) {
      for (const m of entry.markers) {
        if (!layers.includes(m.layer)) continue;
        const w = SceneTransforms.worldToWindowCoordinates(scene, m.position, tmp);
        if (!w || w.x < box[0][0] || w.x > box[1][0] || w.y < box[0][1] || w.y > box[1][1]) continue;
        out.push({ f: m.feature, d: Math.hypot(w.x - cx, w.y - cy) });
      }
    }
    return out.sort((a, b) => a.d - b.d).map((o) => o.f);
  }
}

// ---------------------------------------------------------------------- world

export class World implements WorldMap {
  readonly widget: CesiumWidget;
  mode: Mode;
  tiles: Cesium3DTileset | null = null;
  readonly heights = new Heights();
  private overlays!: Overlays;
  private style!: PostProcessStage;
  private blurH!: PostProcessStage;
  private blurV!: PostProcessStage;
  private weatherStage!: PostProcessStage;
  private weather: Weather | null = null;
  private night = 0;
  private listeners = new Map<string, ((e: MapEvent) => void)[]>();
  private frame = -1;
  private cached = { lat: 0, lng: 0, h: 0, range: 1000, mpp: 1, zoom: 2, globe: true };
  private probes: () => [number, number][] = () => [];
  private readonly t0 = performance.now();

  private constructor(container: string, private readonly tier: Tier, mode: Mode) {
    Ion.defaultAccessToken = CESIUM_ION_TOKEN;
    this.mode = mode;
    const globe = new Globe(Ellipsoid.WGS84);
    globe.enableLighting = true;
    globe.showGroundAtmosphere = true;
    globe.baseColor = Color.fromCssColorString('#0b1a2b');
    this.widget = new CesiumWidget(container, {
      globe,
      // Yesterday's complete daily image of the whole Earth from NASA (today's is still being assembled).
      baseLayer: new ImageryLayer(
        new UrlTemplateImageryProvider({
          url: `${GIBS}/VIIRS_NOAA20_CorrectedReflectance_TrueColor/default/${new Date(Date.now() - 86400000).toISOString().slice(0, 10)}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`,
          maximumLevel: 8,
          credit: 'NASA GIBS / VIIRS',
        }),
      ),
      shouldAnimate: true,
      orderIndependentTranslucency: false,
      useBrowserRecommendedResolution: tier.quality !== 'high',
      targetFrameRate: tier.maxFps,
      msaaSamples: tier.quality === 'low' ? 1 : 4,
    });
    const scene = this.widget.scene;
    scene.backgroundColor = Color.fromCssColorString('#0b1a2b');
    scene.highDynamicRange = false;
    scene.postProcessStages.fxaa.enabled = tier.quality !== 'low';
    // Latest measured precipitation from space, over the globe.
    globe.imageryLayers.addImageryProvider(
      new UrlTemplateImageryProvider({ url: `${GIBS}/IMERG_Precipitation_Rate/default/default/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`, maximumLevel: 6, credit: 'NASA GIBS / IMERG' }),
    ).alpha = 0.45;
    // Real time, so the sun, and day and night on the globe, are where they are now.
    this.widget.clock.currentTime = JulianDate.now();
    this.widget.clock.multiplier = 1;

    const camera = scene.camera;
    (camera.frustum as PerspectiveFrustum).fov = FOV;
    const ctl = scene.screenSpaceCameraController;
    ctl.minimumZoomDistance = 180;
    ctl.maximumZoomDistance = 1.2e8;
    ctl.inertiaZoom = 0.6;
    // Collision checks against the coarse first tiles push the camera up by a kilometre while the
    // city is still loading; the minimum zoom distance already keeps it out of the buildings.
    ctl.enableCollisionDetection = false;
  }

  static async create(container: string, tier: Tier, mode: Mode): Promise<World> {
    const w = new World(container, tier, mode);
    w.overlays = new Overlays(w);
    w.setupStages();
    w.wireEvents();
    try {
      const tiles = await createGooglePhotorealistic3DTileset({ onlyUsingWithGoogleGeocoder: true }, { maximumScreenSpaceError: w.sse(), showCreditsOnScreen: true });
      w.tiles = tiles;
      w.widget.scene.primitives.add(tiles);
    } catch (err) {
      console.error('[tinyfoot] photorealistic tiles', err);
    }
    w.widget.scene.preRender.addEventListener(() => w.switchScale());
    w.applyMode();
    return w;
  }

  private sse(): number {
    return this.tier.quality === 'high' ? 10 : this.tier.quality === 'medium' ? 16 : 26;
  }

  /** Re-applies settings after the quality tier changed at runtime. */
  applyTier(): void {
    const w = this.widget;
    w.useBrowserRecommendedResolution = this.tier.quality !== 'high';
    w.targetFrameRate = this.tier.maxFps;
    if (this.tiles) this.tiles.maximumScreenSpaceError = this.sse();
    w.scene.postProcessStages.fxaa.enabled = this.tier.quality !== 'low';
  }

  /** Photorealistic city below ~200 km, today's satellite picture of the planet above. */
  private switchScale(): void {
    const h = this.widget.scene.camera.positionCartographic.height;
    const globe = this.widget.scene.globe;
    if (this.tiles) {
      if (this.tiles.show && h > GLOBE_ABOVE) {
        this.tiles.show = false;
        globe.show = true;
      } else if (!this.tiles.show && h < CITY_BELOW) {
        this.tiles.show = true;
        globe.show = false;
      } else if (this.tiles.show) {
        globe.show = false;
      }
    }
  }

  private setupStages(): void {
    const stages = this.widget.scene.postProcessStages;
    this.style = new PostProcessStage({ fragmentShader: STYLE_FS, uniforms: { u_amount: () => (this.mode === 'mini' ? 1 : 0.35), u_night: () => this.night } });
    const strength = () => {
      if (this.mode !== 'mini') return 0;
      // A real tilt-shift lens blurs more the further out the scene; ease it off at globe scale.
      const z = this.view().zoom;
      return Math.max(0, Math.min(1, (z - 9) / 5)) * (this.tier.quality === 'low' ? 4 : 6);
    };
    const uniforms = { u_strength: strength, u_focus: () => 0.46, u_band: () => 0.1 };
    this.blurH = new PostProcessStage({ fragmentShader: tiltShiftFS('vec2(1.0, 0.0)'), uniforms });
    this.blurV = new PostProcessStage({ fragmentShader: tiltShiftFS('vec2(0.0, 1.0)'), uniforms });
    const w = () => this.weather;
    const near = () => this.view().zoom > 13;
    this.weatherStage = new PostProcessStage({
      fragmentShader: WEATHER_FS,
      uniforms: {
        u_rain: () => (near() && w() && w()!.snow <= 0 ? Math.min(1, (w()!.rain || 0) / 6) : 0),
        u_snow: () => (near() && w() ? Math.min(1, (w()!.snow || 0) / 2.5) : 0),
        u_fog: () => (w() && w()!.visibility < 6000 ? (1 - Math.max(0, w()!.visibility - 300) / 5700) * 0.75 : 0),
        u_wind: () => {
          const ww = w();
          if (!ww) return 0;
          // How far the rain leans on screen depends on the wind relative to the camera heading.
          const rel = ((ww.windDir + 180) * DEG) - this.widget.scene.camera.heading;
          return Math.sin(rel) * Math.min(0.6, ww.windSpeed / 60);
        },
        u_time: () => (performance.now() - this.t0) / 1000,
      },
    });
    stages.add(this.style);
    stages.add(this.blurH);
    stages.add(this.blurV);
    stages.add(this.weatherStage);
  }

  private applyMode(): void {
    this.blurH.enabled = this.blurV.enabled = this.mode === 'mini';
  }

  async setMode(mode: Mode): Promise<void> {
    this.mode = mode;
    this.applyMode();
  }

  /** Night falls with the real sun at the place you are looking at (or always, in Night mode). */
  updateLight(now: number): void {
    const v = this.view();
    const sun = sunElevation(v.lat, v.lng, now);
    const natural = Math.max(0, Math.min(1, (2 - sun) / 10));
    this.night = this.mode === 'night' ? 1 : natural * 0.85;
    void solarHour;
  }

  setWeather(w: Weather | null): void {
    this.weather = w;
  }

  /** Lets the traffic layer hand over points on open road to calibrate heights against. */
  setProbeSource(fn: () => [number, number][]): void {
    this.probes = fn;
    window.setInterval(() => this.calibrate(), 4000);
  }

  /**
   * The terrain model and the photographed city surface can differ by a few metres. Measure the
   * photographed surface on a few open road points and shift all ground heights to match it.
   */
  private calibrate(): void {
    const scene = this.widget.scene;
    if (!scene.sampleHeightSupported || !this.tiles?.show || this.view().zoom < 15) return;
    const canvas = scene.canvas;
    const diffs: number[] = [];
    for (const [lat, lon] of this.probes()) {
      const terrain = this.heights.get(lat, lon) - this.heights.offset;
      // Only points in view: the photographed surface is only known where tiles are loaded.
      const win = SceneTransforms.worldToWindowCoordinates(scene, Cartesian3.fromDegrees(lon, lat, terrain));
      if (!win || win.x < 20 || win.y < 20 || win.x > canvas.clientWidth - 20 || win.y > canvas.clientHeight - 20) continue;
      let surface: number | undefined;
      try {
        surface = scene.sampleHeight(Cartographic.fromDegrees(lon, lat), this.exclude, 0.5);
      } catch {
        surface = undefined;
      }
      if (surface !== undefined && Number.isFinite(surface) && Math.abs(surface - terrain) < 12) diffs.push(surface - terrain);
      if (diffs.length >= 9) break;
    }
    if (diffs.length < 3) return;
    diffs.sort((a, b) => a - b);
    // The lower half: trees and awnings over a road only ever read too high.
    const median = diffs[Math.floor(diffs.length / 3)];
    this.heights.offset += (median - this.heights.offset) * 0.6;
  }

  /** Our own primitives, left out when measuring the photographed surface. */
  exclude: object[] = [];

  elevAt(lat: number, lon: number): number {
    return this.heights.get(lat, lon);
  }

  // ------------------------------------------------------------------ view

  /** Where the camera looks, refreshed once per rendered frame. */
  view(): { lat: number; lng: number; h: number; range: number; mpp: number; zoom: number; globe: boolean } {
    const scene = this.widget.scene;
    const f = (scene as unknown as { frameState: { frameNumber: number } }).frameState.frameNumber;
    if (f === this.frame) return this.cached;
    this.frame = f;
    const camera = scene.camera;
    const canvas = scene.canvas;
    const h0 = this.cached.h;
    const e = new Ellipsoid(6378137 + h0, 6378137 + h0, 6356752.3142 + h0);
    const ray = new Ray(camera.positionWC, camera.directionWC);
    const hit = rayEllipsoid(ray, e);
    let lat: number, lng: number, range: number;
    if (hit) {
      const c = Cartographic.fromCartesian(hit);
      lat = c.latitude / DEG;
      lng = c.longitude / DEG;
      range = Cartesian3.distance(camera.positionWC, hit);
    } else {
      const c = camera.positionCartographic;
      lat = c.latitude / DEG;
      lng = c.longitude / DEG;
      range = c.height;
    }
    const w = canvas.clientWidth || 1;
    const aspect = w / (canvas.clientHeight || 1);
    const fovx = aspect >= 1 ? FOV : 2 * Math.atan(Math.tan(FOV / 2) * aspect);
    const mpp = (2 * range * Math.tan(fovx / 2)) / w;
    const zoom = Math.log2((EARTH_C * Math.max(0.05, Math.cos(lat * DEG))) / (512 * mpp));
    const h = range < 400000 ? this.heights.get(lat, lng) : 0;
    this.cached = { lat, lng, h, range, mpp, zoom, globe: camera.positionCartographic.height > GLOBE_ABOVE };
    return this.cached;
  }

  getCenter(): LngLat {
    const v = this.view();
    return { lng: v.lng, lat: v.lat };
  }

  getZoom(): number {
    return this.view().zoom;
  }

  getPitch(): number {
    return 90 + this.widget.scene.camera.pitch / DEG;
  }

  getBounds(): Bounds {
    const v = this.view();
    const canvas = this.widget.scene.canvas;
    // Footprint of the screen on the ground, padded generously for the far (upper) part of the view.
    const halfW = (v.mpp * canvas.clientWidth) / 2;
    const halfH = (v.mpp * canvas.clientHeight) / 2 / Math.max(0.35, Math.cos((90 - this.getPitch()) * DEG));
    const r = Math.max(halfW, halfH) * 1.25;
    const dLat = r / 111320;
    const dLon = r / (111320 * Math.max(0.05, Math.cos(v.lat * DEG)));
    if (dLon > 180 || v.globe) return { getWest: () => -180, getEast: () => 180, getSouth: () => -85, getNorth: () => 85 };
    return { getWest: () => v.lng - dLon, getEast: () => v.lng + dLon, getSouth: () => Math.max(-90, v.lat - dLat), getNorth: () => Math.min(90, v.lat + dLat) };
  }

  getCanvas(): HTMLCanvasElement {
    return this.widget.scene.canvas;
  }

  project(p: [number, number] | LngLat): { x: number; y: number } {
    const lng = Array.isArray(p) ? p[0] : p.lng;
    const lat = Array.isArray(p) ? p[1] : p.lat;
    const w = SceneTransforms.worldToWindowCoordinates(this.widget.scene, Cartesian3.fromDegrees(lng, lat, this.elevAt(lat, lng)));
    return w ? { x: w.x, y: w.y } : { x: -1e6, y: -1e6 };
  }

  getSource(id: string): { setData(d: GeoJSON.FeatureCollection): void } | undefined {
    if (!(OVERLAYS as string[]).includes(id)) return id === 'night' ? { setData: () => undefined } : undefined;
    return { setData: (d) => this.overlays.set(id as OverlayId, d) };
  }

  getLayer(id: string): boolean {
    return id === 'tf-places' || id === 'tf-water';
  }

  queryRenderedFeatures(box: [[number, number], [number, number]], opts: { layers: string[] }): Feature[] {
    return this.overlays.query(box, opts.layers);
  }

  // ---------------------------------------------------------------- events

  private emit(name: string, e: MapEvent): void {
    for (const fn of this.listeners.get(name) ?? []) fn(e);
  }

  on(event: string, fn: (e: MapEvent) => void): void {
    const list = this.listeners.get(event);
    if (list) list.push(fn);
    else this.listeners.set(event, [fn]);
  }

  once(event: string, fn: () => void): void {
    const wrap = () => {
      const list = this.listeners.get(event) ?? [];
      list.splice(list.indexOf(wrap), 1);
      fn();
    };
    this.on(event, wrap);
  }

  private wireEvents(): void {
    const scene = this.widget.scene;
    const camera = scene.camera;
    const empty = (): MapEvent => ({ point: { x: 0, y: 0 }, lngLat: this.getCenter() });
    camera.moveStart.addEventListener(() => this.emit('movestart', empty()));
    camera.moveEnd.addEventListener(() => {
      this.emit('moveend', empty());
      this.emit('idle', empty());
    });
    camera.percentageChanged = 0.05;
    camera.changed.addEventListener(() => this.emit('pitch', empty()));
    const handler = new ScreenSpaceEventHandler(scene.canvas);
    const at = (pos: Cartesian2): MapEvent => {
      let lngLat = this.getCenter();
      const hit = scene.pickPositionSupported ? scene.pickPosition(pos) : undefined;
      if (hit) {
        const c = Cartographic.fromCartesian(hit);
        lngLat = { lng: c.longitude / DEG, lat: c.latitude / DEG };
      }
      return { point: { x: pos.x, y: pos.y }, lngLat };
    };
    handler.setInputAction((e: { position: Cartesian2 }) => this.emit('click', at(e.position)), ScreenSpaceEventType.LEFT_CLICK);
    handler.setInputAction((e: { endPosition: Cartesian2 }) => this.emit('mousemove', { point: { x: e.endPosition.x, y: e.endPosition.y }, lngLat: this.getCenter() }), ScreenSpaceEventType.MOUSE_MOVE);
    handler.setInputAction(() => this.emit('dragstart', empty()), ScreenSpaceEventType.LEFT_DOWN);
  }

  // ---------------------------------------------------------------- camera

  private rangeFor(zoom: number, lat: number): number {
    const canvas = this.widget.scene.canvas;
    const w = canvas.clientWidth || 1;
    const aspect = w / (canvas.clientHeight || 1);
    const fovx = aspect >= 1 ? FOV : 2 * Math.atan(Math.tan(FOV / 2) * aspect);
    const mpp = (EARTH_C * Math.max(0.05, Math.cos(lat * DEG))) / (512 * 2 ** zoom);
    return (mpp * w) / 2 / Math.tan(fovx / 2);
  }

  private target(o: CameraOptions): { sphere: BoundingSphere; offset: HeadingPitchRange } {
    const v = this.view();
    const camera = this.widget.scene.camera;
    const [lng, lat] = o.center ?? [v.lng, v.lat];
    const zoom = o.zoom ?? v.zoom;
    const pitch = o.pitch ?? this.getPitch();
    const heading = o.bearing !== undefined ? o.bearing * DEG : camera.heading;
    const ground = this.elevAt(lat, lng);
    const range = o.zoom !== undefined || o.center === undefined ? this.rangeFor(zoom, lat) : v.range;
    // Near the globe scale look straight down; below it keep the requested tilt.
    const p = zoom < 6 ? 0 : Math.max(0, Math.min(75, pitch));
    return {
      sphere: new BoundingSphere(Cartesian3.fromDegrees(lng, lat, ground), 0),
      offset: new HeadingPitchRange(heading, -(90 - p) * DEG, range),
    };
  }

  jumpTo(o: CameraOptions): void {
    const camera = this.widget.scene.camera;
    const { sphere, offset } = this.target(o);
    camera.lookAt(sphere.center, offset);
    camera.lookAtTransform(Matrix4.IDENTITY);
    this.frame = -1;
  }

  easeTo(o: CameraOptions): void {
    this.flyTo({ ...o, duration: o.duration ?? 900 });
  }

  flyTo(o: CameraOptions & { speed?: number; curve?: number; essential?: boolean }): void {
    const { sphere, offset } = this.target(o);
    const camera = this.widget.scene.camera;
    camera.flyToBoundingSphere(sphere, { offset, duration: (o.duration ?? 2600) / 1000 });
    this.frame = -1;
  }

  fitBounds(b: [[number, number], [number, number]], o: { maxZoom?: number; pitch?: number; duration?: number } = {}): void {
    const [[w, n], [e, s]] = b;
    const lat = (n + s) / 2;
    const widthM = Math.abs(e - w) * 111320 * Math.cos(lat * DEG);
    const heightM = Math.abs(n - s) * 111320;
    const canvas = this.widget.scene.canvas;
    const mpp = Math.max(widthM / (canvas.clientWidth * 0.8), heightM / (canvas.clientHeight * 0.8));
    const zoom = Math.min(o.maxZoom ?? 18, Math.log2((EARTH_C * Math.cos(lat * DEG)) / (512 * mpp)));
    this.flyTo({ center: [(w + e) / 2, lat], zoom, pitch: o.pitch, duration: o.duration });
  }

  /** Google geocoding through Cesium ion (the only geocoder allowed with the Google tiles). */
  async search(text: string): Promise<{ name: string; detail: string; center: [number, number]; extent?: [number, number, number, number] }[]> {
    const service = new IonGeocoderService({ scene: this.widget.scene, geocodeProviderType: IonGeocodeProviderType.GOOGLE });
    const results = await service.geocode(text);
    return results.slice(0, 6).map((r) => {
      const [name, ...rest] = r.displayName.split(',');
      const d = r.destination;
      if (d instanceof Rectangle) {
        const c = Rectangle.center(d);
        return { name: name.trim(), detail: rest.join(',').trim(), center: [c.longitude / DEG, c.latitude / DEG], extent: [d.west / DEG, d.south / DEG, d.east / DEG, d.north / DEG] };
      }
      const c = Cartographic.fromCartesian(d as Cartesian3);
      return { name: name.trim(), detail: rest.join(',').trim(), center: [c.longitude / DEG, c.latitude / DEG] };
    });
  }
}

/** Nearest intersection of a ray with an ellipsoid (or undefined). */
function rayEllipsoid(ray: Ray, e: Ellipsoid): Cartesian3 | undefined {
  // Scale space so the ellipsoid becomes a unit sphere.
  const r = e.radii;
  const o = new Cartesian3(ray.origin.x / r.x, ray.origin.y / r.y, ray.origin.z / r.z);
  const d = new Cartesian3(ray.direction.x / r.x, ray.direction.y / r.y, ray.direction.z / r.z);
  const a = Cartesian3.dot(d, d);
  const b = 2 * Cartesian3.dot(o, d);
  const c = Cartesian3.dot(o, o) - 1;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return undefined;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  if (t < 0) return undefined;
  return Cartesian3.add(ray.origin, Cartesian3.multiplyByScalar(ray.direction, t, new Cartesian3()), new Cartesian3());
}

void CMath;
