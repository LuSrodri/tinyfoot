// Procedural building facades.
// OpenStreetMap knows a building's footprint and height but not what its walls look like, so the
// walls are generated: floors, window bays, mullions and lit windows at night, in a handful of
// materials. They are plausible for the building's size, not a photograph of the real thing.

import type { Map as MlMap } from 'maplibre-gl';
import { mulberry } from '../util/geo';

interface Material {
  wall: string;
  frame: string;
  glass: [string, string];
  /** Share of the bay taken by glass, horizontally and vertically. */
  gw: number;
  gh: number;
}

const MATERIALS: Record<string, Material> = {
  plaster: { wall: '#e9dfcd', frame: '#f7f2e8', glass: ['#5d7890', '#8fb0c8'], gw: 0.46, gh: 0.5 },
  cream: { wall: '#f1e3c2', frame: '#fff7e2', glass: ['#566f86', '#86a6bd'], gw: 0.42, gh: 0.5 },
  brick: { wall: '#b5694c', frame: '#e6d9c8', glass: ['#3f566b', '#7191a8'], gw: 0.4, gh: 0.52 },
  concrete: { wall: '#bfc1c0', frame: '#d9dad9', glass: ['#4b6378', '#7f9fb6'], gw: 0.62, gh: 0.46 },
  white: { wall: '#f4f4f1', frame: '#ffffff', glass: ['#58748c', '#92b3ca'], gw: 0.5, gh: 0.48 },
  pastel: { wall: '#d9c3b0', frame: '#f3e7da', glass: ['#516a80', '#84a4bb'], gw: 0.44, gh: 0.5 },
  // Curtain wall: almost all glass, thin mullions.
  glass: { wall: '#5f7c93', frame: '#3d5263', glass: ['#6f93ad', '#a9cbe0'], gw: 0.9, gh: 0.86 },
  dark: { wall: '#3c4651', frame: '#2a323b', glass: ['#52728b', '#87abc4'], gw: 0.88, gh: 0.84 },
};

export const FACADES = Object.keys(MATERIALS);
const BAYS = 8;
const FLOORS = 8;
/** Logical pixels per bay/floor. MapLibre draws one logical pixel per screen pixel at the tile's zoom, */
/** which at street zoom works out to roughly 2 to 3.5 m per bay. */
const CELL = 6;
const RATIO = 6;

function draw(name: string, night: boolean): ImageData {
  const mat = MATERIALS[name.replace(/^fa-(n-)?/, '')] ?? MATERIALS.plaster;
  const px = CELL * RATIO;
  const canvas = document.createElement('canvas');
  canvas.width = BAYS * px;
  canvas.height = FLOORS * px;
  const g = canvas.getContext('2d')!;
  const rnd = mulberry(name.length * 7919 + name.charCodeAt(3) * 31);
  g.fillStyle = night ? shade(mat.wall, 0.34) : mat.wall;
  g.fillRect(0, 0, canvas.width, canvas.height);
  for (let f = 0; f < FLOORS; f++) {
    // Floor slab line.
    g.fillStyle = night ? shade(mat.frame, 0.3) : shade(mat.wall, 0.9);
    g.fillRect(0, f * px, canvas.width, Math.max(1, px * 0.06));
    for (let b = 0; b < BAYS; b++) {
      const w = px * mat.gw;
      const h = px * mat.gh;
      const x = b * px + (px - w) / 2;
      const y = f * px + (px - h) * 0.45;
      g.fillStyle = night ? shade(mat.frame, 0.4) : mat.frame;
      g.fillRect(x - 1.5, y - 1.5, w + 3, h + 3);
      if (night) {
        // At night some rooms are lit, in warm and cool whites; the rest are dark glass.
        const lit = rnd() < 0.34;
        g.fillStyle = lit ? ['#ffd98a', '#ffe9b8', '#fff4d6', '#dfeaff'][Math.floor(rnd() * 4)] : '#141c26';
        g.fillRect(x, y, w, h);
      } else {
        const grad = g.createLinearGradient(0, y, 0, y + h);
        grad.addColorStop(0, mat.glass[1]);
        grad.addColorStop(1, mat.glass[0]);
        g.fillStyle = grad;
        g.fillRect(x, y, w, h);
        // A blind or curtain behind some windows.
        if (rnd() < 0.3) {
          g.fillStyle = 'rgba(255,255,255,0.28)';
          g.fillRect(x, y, w, h * (0.25 + rnd() * 0.5));
        }
      }
      // Mullion.
      g.fillStyle = night ? shade(mat.frame, 0.4) : mat.frame;
      g.fillRect(x + w / 2 - 0.75, y, 1.5, h);
    }
  }
  return g.getImageData(0, 0, canvas.width, canvas.height);
}

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

/**
 * Registers every facade image as soon as a style is in place, before its tiles are laid out.
 * (Buildings whose pattern image is missing when their tile is built are dropped, so adding the
 * images on demand is too late.) Repeats after each style swap, which discards images.
 */
export function installFacades(map: MlMap): void {
  const addAll = (): void => {
    for (const name of FACADES) {
      for (const id of ['fa-' + name, 'fa-n-' + name]) {
        try {
          if (!map.hasImage(id)) map.addImage(id, draw(id, id.startsWith('fa-n-')), { pixelRatio: RATIO });
        } catch {
          return; // style not ready yet; the next styledata event retries
        }
      }
    }
  };
  map.on('styledata', addAll);
  map.on('styleimagemissing', (e) => {
    if (e.id.startsWith('fa-')) addAll();
  });
  addAll();
}
