import type { WorldMap as MlMap } from './world/world';
import type { FrameInfo, Scene } from './gl/instanced';

export type Quality = 'low' | 'medium' | 'high';

export interface Tier {
  quality: Quality;
  pixelRatio: number;
  maxFps: number;
  terrain: boolean;
  blurLayers: number;
  /** Multiplier for how many simulated agents and far-away objects are drawn. */
  density: number;
  aircraftCells: number;
  trails: boolean;
}

export function detectTier(): Tier {
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  const cores = nav.hardwareConcurrency ?? 4;
  const mem = nav.deviceMemory ?? 4;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent) || (nav.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 820);
  const saver = nav.connection?.saveData === true;
  const dpr = window.devicePixelRatio || 1;
  const forced = new URLSearchParams(location.search).get('q');
  let quality: Quality = 'high';
  if (saver || cores <= 2 || mem <= 2) quality = 'low';
  else if (mobile || cores <= 4 || mem <= 4) quality = 'medium';
  if (forced === 'low' || forced === 'medium' || forced === 'high') quality = forced;
  return tierFor(quality, dpr);
}

export function tierFor(quality: Quality, dpr = window.devicePixelRatio || 1): Tier {
  if (quality === 'low') {
    return { quality, pixelRatio: 1, maxFps: 30, terrain: false, blurLayers: 1, density: 0.3, aircraftCells: 4, trails: false };
  }
  if (quality === 'medium') {
    return { quality, pixelRatio: Math.min(dpr, 1.5), maxFps: 60, terrain: true, blurLayers: 2, density: 0.6, aircraftCells: 8, trails: true };
  }
  return { quality, pixelRatio: Math.min(dpr, 2), maxFps: 60, terrain: true, blurLayers: 3, density: 1, aircraftCells: 16, trails: true };
}

export type LayerState = 'live' | 'estimate' | 'idle' | 'loading' | 'error';

export interface InfoRow {
  label: string;
  value: string;
}

/** Something the user clicked on. */
export interface Selection {
  layer: string;
  id: string;
  title(): string;
  subtitle(): string;
  rows(): InfoRow[];
  /** Current position, used by "follow". Null once the thing has gone away. */
  position(): { lat: number; lon: number } | null;
  /** Suggested zoom when following. */
  zoom?: number;
  badge?: string;
}

export interface Ctx {
  map: MlMap;
  tier: Tier;
  /** Ground elevation in metres at a place (0 when terrain is off or not loaded). */
  elevAt(lat: number, lon: number): number;
  /** Height of the photographed surface itself (runway, deck, roof), where its tiles are loaded. */
  surfaceAt(lat: number, lon: number): number | undefined;
  selection: Selection | null;
  lang: 'pt' | 'en';
  /** Server capabilities reported by /api/health. */
  caps: { ais: boolean; sptrans: boolean };
}

export interface Layer {
  readonly id: string;
  enabled: boolean;
  count: number;
  state: LayerState;
  /** Short human-readable hint, e.g. why nothing is shown. */
  hint: string;
  /** Called every frame before `emit`; schedules network work. */
  tick(frame: FrameInfo): void;
  emit(scene: Scene, frame: FrameInfo): void;
  /** Called when a selection belonging to this layer is made or cleared. */
  onSelect?(sel: Selection | null): void;
}

export async function getJson<T>(url: string, timeout = 12000): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return null;
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

/** Visible bounds padded by a fraction of their size: [west, south, east, north]. */
export function viewBounds(map: MlMap, pad = 0.15): [number, number, number, number] {
  const b = map.getBounds();
  let w = b.getWest();
  let e = b.getEast();
  let s = b.getSouth();
  let n = b.getNorth();
  if (e - w >= 360 || !Number.isFinite(e - w)) {
    w = -180;
    e = 180;
  }
  const dx = (e - w) * pad;
  const dy = (n - s) * pad;
  return [w - dx, Math.max(-90, s - dy), e + dx, Math.min(90, n + dy)];
}

export function inBounds(b: [number, number, number, number], lat: number, lon: number): boolean {
  if (lat < b[1] || lat > b[3]) return false;
  if (lon >= b[0] && lon <= b[2]) return true;
  // Bounds may be expressed past the antimeridian.
  return (lon + 360 >= b[0] && lon + 360 <= b[2]) || (lon - 360 >= b[0] && lon - 360 <= b[2]);
}

export function intersects(a: [number, number, number, number], b: [number, number, number, number]): boolean {
  if (a[1] > b[3] || a[3] < b[1]) return false;
  for (const shift of [0, 360, -360]) {
    if (a[0] <= b[2] + shift && a[2] >= b[0] + shift) return true;
  }
  return false;
}
