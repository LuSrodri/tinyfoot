// Procedural low-poly models. Everything is generated at start-up, so the app
// ships no model files at all.
//
// Model space: +x right, +y forward (nose), +z up, in metres.
// Each vertex carries a "part" id that the shader maps to a colour:
//   0 body (instance colour 1)   1 accent (instance colour 2)   2 dark
//   3 light grey                 4 glass (glows at night)       5 skin
//   6 shadow (translucent)       7 trail (instance colour 2, translucent)
//   8 belly / engines (instance colour 3)

type V3 = [number, number, number];

export interface MeshDef {
  /** Interleaved: position(3) normal(3) part(1). */
  data: Float32Array;
  vertexCount: number;
  /** Nominal length of the model in metres (used for minimum on-screen size). */
  length: number;
  /** Drawn without depth writes, before everything else. */
  translucent?: boolean;
}

class Builder {
  private v: number[] = [];

  /** Adds a triangle; the normal is flipped if needed so it points away from `c`. */
  tri(a: V3, b: V3, c2: V3, part: number, c: V3): void {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c2[0] - a[0], vy = c2[1] - a[1], vz = c2[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return;
    nx /= l; ny /= l; nz /= l;
    const mx = (a[0] + b[0] + c2[0]) / 3 - c[0];
    const my = (a[1] + b[1] + c2[1]) / 3 - c[1];
    const mz = (a[2] + b[2] + c2[2]) / 3 - c[2];
    if (nx * mx + ny * my + nz * mz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    for (const p of [a, b, c2]) this.v.push(p[0], p[1], p[2], nx, ny, nz, part);
  }

  quad(a: V3, b: V3, c: V3, d: V3, part: number, center: V3): void {
    this.tri(a, b, c, part, center);
    this.tri(a, c, d, part, center);
  }

  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, part: number): void {
    const c: V3 = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
    const p: V3[] = [
      [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
    ];
    this.quad(p[0], p[1], p[2], p[3], part, c);
    this.quad(p[4], p[5], p[6], p[7], part, c);
    this.quad(p[0], p[1], p[5], p[4], part, c);
    this.quad(p[2], p[3], p[7], p[6], part, c);
    this.quad(p[1], p[2], p[6], p[5], part, c);
    this.quad(p[3], p[0], p[4], p[7], part, c);
  }

  /** Skins a sequence of rings (same point count each) and caps both ends. */
  loft(rings: V3[][], part: number): void {
    const n = rings[0].length;
    const mid = rings[Math.floor(rings.length / 2)];
    const c: V3 = [0, 0, 0];
    for (const p of mid) { c[0] += p[0] / n; c[1] += p[1] / n; c[2] += p[2] / n; }
    for (let r = 0; r < rings.length - 1; r++) {
      const a = rings[r], b = rings[r + 1];
      const rc: V3 = [0, 0, 0];
      for (let i = 0; i < n; i++) {
        rc[0] += (a[i][0] + b[i][0]) / (2 * n);
        rc[1] += (a[i][1] + b[i][1]) / (2 * n);
        rc[2] += (a[i][2] + b[i][2]) / (2 * n);
      }
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        this.quad(a[i], a[j], b[j], b[i], part, rc);
      }
    }
    for (const ring of [rings[0], rings[rings.length - 1]]) {
      for (let i = 1; i < n - 1; i++) this.tri(ring[0], ring[i], ring[i + 1], part, c);
    }
  }

  /** Round-ish tube along y. `profile` is [y, radiusX, radiusZ, centreZ]. */
  tube(profile: [number, number, number, number][], sides: number, part: number, cx = 0): void {
    const rings = profile.map(([y, rx, rz, cz]) => {
      const ring: V3[] = [];
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2 + Math.PI / sides;
        ring.push([cx + Math.cos(a) * rx, y, cz + Math.sin(a) * rz]);
      }
      return ring;
    });
    this.loft(rings, part);
  }

  /** Like tube, but with smooth normals and a per-face part chosen from the sine of the angle around the tube. */
  tubeSmooth(profile: [number, number, number, number][], sides: number, partOf: (sinA: number) => number, cx = 0): void {
    const ring = (p: [number, number, number, number]) => {
      const pts: V3[] = [];
      const nrm: V3[] = [];
      for (let i = 0; i <= sides; i++) {
        const ang = (i / sides) * Math.PI * 2;
        const c = Math.cos(ang), sn = Math.sin(ang);
        pts.push([cx + c * p[1], p[0], p[3] + sn * p[2]]);
        const nx = c / Math.max(1e-6, p[1]), nz = sn / Math.max(1e-6, p[2]);
        const l = Math.hypot(nx, nz) || 1;
        nrm.push([nx / l, 0, nz / l]);
      }
      return { pts, nrm };
    };
    const rings = profile.map(ring);
    for (let k = 0; k < rings.length - 1; k++) {
      const A = rings[k], B = rings[k + 1];
      for (let i = 0; i < sides; i++) {
        const part = partOf(Math.sin(((i + 0.5) / sides) * Math.PI * 2));
        const quad: [V3, V3][] = [[A.pts[i], A.nrm[i]], [A.pts[i + 1], A.nrm[i + 1]], [B.pts[i + 1], B.nrm[i + 1]], [B.pts[i], B.nrm[i]]];
        for (const j of [0, 1, 2, 0, 2, 3]) {
          const [p, n] = quad[j];
          this.v.push(p[0], p[1], p[2], n[0], n[1], n[2], part);
        }
      }
    }
    // End caps.
    const caps: [number, number][] = [[0, -1], [rings.length - 1, 1]];
    for (const [idx, dir] of caps) {
      const cap = rings[idx];
      const mid = profile[idx];
      for (let i = 0; i < sides; i++) {
        const tri: V3[] = [[cx, mid[0], mid[3]], cap.pts[i], cap.pts[i + 1]];
        for (const p of tri) this.v.push(p[0], p[1], p[2], 0, dir, 0, partOf(0));
      }
    }
  }

  /** A tapered slab: wings, fins, stabilisers. */
  slab(root: V3, rootChord: number, rootThick: number, tip: V3, tipChord: number, tipThick: number, part: number, vertical = false): void {
    const mk = (p: V3, chord: number, t: number): V3[] =>
      vertical
        ? [
            [p[0] - t / 2, p[1] + chord / 2, p[2]], [p[0] + t / 2, p[1] + chord / 2, p[2]],
            [p[0] + t / 2, p[1] - chord / 2, p[2]], [p[0] - t / 2, p[1] - chord / 2, p[2]],
          ]
        : [
            [p[0], p[1] + chord / 2, p[2] - t / 2], [p[0], p[1] + chord / 2, p[2] + t / 2],
            [p[0], p[1] - chord / 2, p[2] + t / 2], [p[0], p[1] - chord / 2, p[2] - t / 2],
          ];
    this.loft([mk(root, rootChord, rootThick), mk(tip, tipChord, tipThick)], part);
  }

  /** Extrudes a convex outline (x, y) between two heights. */
  extrude(outline: [number, number][], z0: number, z1: number, part: number, topPart = part): void {
    const lo: V3[] = outline.map(([x, y]) => [x, y, z0]);
    const hi: V3[] = outline.map(([x, y]) => [x, y, z1]);
    const n = outline.length;
    const c: V3 = [0, 0, (z0 + z1) / 2];
    for (const [x, y] of outline) { c[0] += x / n; c[1] += y / n; }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.quad(lo[i], lo[j], hi[j], hi[i], part, c);
    }
    for (let i = 1; i < n - 1; i++) {
      this.tri(hi[0], hi[i], hi[i + 1], topPart, c);
      this.tri(lo[0], lo[i], lo[i + 1], part, c);
    }
  }

  build(length: number, translucent = false): MeshDef {
    return { data: new Float32Array(this.v), vertexCount: this.v.length / 7, length, translucent };
  }
}

// ------------------------------------------------------------------ aircraft

export interface AirframeSpec {
  len: number;
  span: number;
  /** Fuselage radius. */
  r: number;
  /** Wing root position along the fuselage, fraction of length from the nose. */
  wingAt: number;
  sweep: number;
  rootChord: number;
  tipChord: number;
  highWing?: boolean;
  tTail?: boolean;
  engines: 'under2' | 'under4' | 'rear2' | 'rear3' | 'prop2' | 'prop4' | 'prop1' | 'none';
  /** Forward upper-deck hump (747). */
  hump?: boolean;
  /** Full-length upper deck (A380). */
  doubleDeck?: boolean;
  winglets?: boolean;
}

/** Builds one airframe to real dimensions. Parts: 0 body, 8 belly + engines, 1 fin + winglets, 3 wings. */
export function buildAirframe(s: AirframeSpec): MeshDef {
  const b = new Builder();
  const L = s.len, r = s.r, nose = L / 2, tail = -L / 2;
  const sides = L > 20 ? 14 : 10;
  const tall = s.doubleDeck ? 1.24 : 1;
  const lift = s.doubleDeck ? r * 0.12 : 0;

  b.tubeSmooth(
    [
      [tail, r * 0.1, r * 0.14, r * 0.5],
      [tail + L * 0.06, r * 0.38, r * 0.45, r * 0.38],
      [tail + L * 0.14, r * 0.7, r * 0.74 * tall, r * 0.2 + lift],
      [tail + L * 0.24, r, r * tall, lift],
      [nose - L * 0.14, r, r * tall, lift],
      [nose - L * 0.08, r * 0.9, r * 0.88 * tall, lift - r * 0.04],
      [nose - L * 0.04, r * 0.68, r * 0.64, -r * 0.12],
      [nose - L * 0.015, r * 0.38, r * 0.36, -r * 0.2],
      [nose, r * 0.04, r * 0.04, -r * 0.24],
    ],
    sides,
    // The lower third of the fuselage takes the belly colour.
    (sinA) => (sinA < -0.3 ? 8 : 0),
  );
  if (s.hump) {
    b.tubeSmooth(
      [
        [nose - L * 0.43, r * 0.15, r * 0.15, r * 0.78],
        [nose - L * 0.34, r * 0.7, r * 0.55, r * 0.82],
        [nose - L * 0.1, r * 0.7, r * 0.55, r * 0.82],
        [nose - L * 0.045, r * 0.22, r * 0.18, r * 0.45],
      ],
      8,
      () => 0,
    );
  }

  // Cabin windows (two rows on a double-decker) and the cockpit windscreen.
  const rows = s.doubleDeck ? [r * 0.05, r * 0.72] : [r * 0.22];
  for (const wz of rows) {
    for (const side of [-1, 1]) {
      b.box(side * r * 0.95, tail + L * 0.25, wz - r * 0.07, side * r * 1.012, nose - L * 0.15, wz + r * 0.07, 4);
    }
  }
  const cz = lift + r * (s.hump ? 0.95 : 0.3);
  const cy = s.hump ? nose - L * 0.075 : nose - L * 0.062;
  b.box(-r * 0.46, cy - L * 0.018, cz, r * 0.46, cy + L * 0.012, cz + r * 0.3, 4);

  // Wings.
  const wy = nose - L * s.wingAt;
  const wz0 = s.highWing ? r * 0.85 : -r * 0.5;
  const half = s.span / 2;
  const dihedral = s.highWing ? -half * 0.02 : half * 0.1;
  for (const side of [-1, 1]) {
    b.slab([side * r * 0.4, wy, wz0], s.rootChord, r * 0.36, [side * half, wy - s.sweep, wz0 + dihedral], s.tipChord, r * 0.09, 3);
    if (s.winglets) {
      b.slab(
        [side * half, wy - s.sweep, wz0 + dihedral], s.tipChord, r * 0.09,
        [side * (half + r * 0.2), wy - s.sweep - s.tipChord * 0.45, wz0 + dihedral + Math.max(1.2, s.span * 0.045)], s.tipChord * 0.4, r * 0.05,
        1,
      );
    }
  }

  // Fin and tailplane.
  const finRootY = tail + L * 0.095;
  const finH = Math.max(r * 2.5, L * 0.15);
  b.slab([0, finRootY + L * 0.015, r * 0.7 + lift], L * 0.155, r * 0.22, [0, finRootY - L * 0.06, r * 0.7 + lift + finH], L * 0.06, r * 0.09, 1, true);
  const stabZ = s.tTail ? r * 0.7 + finH : r * 0.35;
  const stabY = s.tTail ? finRootY - L * 0.06 : finRootY - L * 0.02;
  const stabHalf = s.span * 0.19;
  for (const side of [-1, 1]) {
    b.slab([side * r * 0.12, stabY, stabZ], L * 0.085, r * 0.16, [side * stabHalf, stabY - L * 0.05, stabZ + (s.tTail ? 0 : stabHalf * 0.08)], L * 0.038, r * 0.06, 3);
  }

  // Engines.
  const jet = (x: number, y: number, z: number, er: number, el: number, pylonTo?: number) => {
    b.tubeSmooth([[y - el * 0.5, er * 0.55, er * 0.55, z], [y - el * 0.15, er * 0.9, er * 0.9, z], [y + el * 0.3, er, er, z], [y + el * 0.5, er * 0.93, er * 0.93, z]], 10, () => 8, x);
    b.tubeSmooth([[y + el * 0.5 - 0.02, er * 0.86, er * 0.86, z], [y + el * 0.5 + 0.03, er * 0.82, er * 0.82, z]], 10, () => 2, x);
    b.tubeSmooth([[y - el * 0.72, er * 0.12, er * 0.12, z], [y - el * 0.5, er * 0.42, er * 0.42, z]], 8, () => 3, x);
    if (pylonTo !== undefined) b.box(x - er * 0.1, y - el * 0.35, z + er * 0.8, x + er * 0.1, y + el * 0.2, pylonTo, 3);
  };
  const prop = (x: number, y: number, z: number, pr: number, nr: number, nl: number) => {
    b.tubeSmooth([[y - nl, nr * 0.5, nr * 0.5, z], [y - nl * 0.3, nr, nr, z], [y, nr * 0.75, nr * 0.75, z], [y + nr * 0.6, nr * 0.1, nr * 0.1, z]], 8, () => 8, x);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI;
      const dx = Math.cos(a) * pr, dz = Math.sin(a) * pr;
      b.slab([x - dx, y + nr * 0.25, z - dz], pr * 0.09, 0.05, [x + dx, y + nr * 0.25, z + dz], pr * 0.09, 0.05, 2);
    }
  };
  const er = s.engines === 'under4' ? r * 0.5 : Math.min(r * 0.72, Math.max(r * 0.55, s.span * 0.028));
  const el = er * 3.3;
  if (s.engines === 'under2' || s.engines === 'under4') {
    for (const f of s.engines === 'under2' ? [0.33] : [0.3, 0.6]) {
      for (const side of [-1, 1]) {
        const wingZ = wz0 + dihedral * f;
        jet(side * half * f, wy - s.sweep * f + s.rootChord * (0.5 - f * 0.25), wingZ - er * 1.25, er, el, wingZ);
      }
    }
  } else if (s.engines === 'rear2' || s.engines === 'rear3') {
    for (const side of [-1, 1]) jet(side * (r + er * 0.9), tail + L * 0.25, r * 0.35, er * 0.85, el * 0.85);
    if (s.engines === 'rear3') jet(0, tail + L * 0.12, r * 1.25, er * 0.8, el * 0.8);
  } else if (s.engines === 'prop2' || s.engines === 'prop4') {
    for (const f of s.engines === 'prop2' ? [0.3] : [0.24, 0.5]) {
      for (const side of [-1, 1]) prop(side * half * f, wy + s.rootChord * 0.75, wz0 - r * 0.25, Math.max(1.3, s.span * 0.07), r * 0.42, s.rootChord * 1.1);
    }
  } else if (s.engines === 'prop1') {
    for (let i = 0; i < 2; i++) {
      const a = (i / 2) * Math.PI;
      const pr = r * 1.5;
      b.slab([-Math.cos(a) * pr, nose + 0.05, -r * 0.24 - Math.sin(a) * pr], pr * 0.1, 0.04, [Math.cos(a) * pr, nose + 0.05, -r * 0.24 + Math.sin(a) * pr], pr * 0.1, 0.04, 2);
    }
  }

  // Landing gear.
  const gear = r * 1.6;
  b.box(-r * 0.1, nose - L * 0.105, -gear, r * 0.1, nose - L * 0.09, -r * 0.9, 2);
  for (const side of [-1, 1]) b.box(side * r * 1.0 - r * 0.13, wy - s.rootChord * 0.22, -gear, side * r * 1.0 + r * 0.13, wy - s.rootChord * 0.04, -r * 0.6, 2);

  return b.build(L);
}

function helicopter(): MeshDef {
  const b = new Builder();
  b.tube([[-3.2, 0.3, 0.4, 0.5], [-1.6, 1.0, 1.05, 0.1], [1.4, 1.05, 1.1, 0], [2.6, 0.7, 0.75, -0.2], [3.1, 0.15, 0.2, -0.35]], 8, 0);
  b.box(-0.75, 1.3, 0.05, 0.75, 2.75, 0.75, 4);
  b.tube([[-8.2, 0.14, 0.16, 0.9], [-3.0, 0.3, 0.36, 0.55]], 6, 1);
  b.slab([0, -8.0, 0.9], 1.1, 0.12, [0, -8.5, 2.3], 0.6, 0.08, 1, true);
  b.box(-0.08, -8.35, 0.5, 0.08, -8.2, 2.5, 2);
  b.box(-0.2, -0.3, 1.0, 0.2, 0.3, 1.7, 2);
  b.box(-6.2, -0.22, 1.7, 6.2, 0.22, 1.82, 2);
  b.box(-0.22, -6.2, 1.7, 0.22, 6.2, 1.82, 2);
  for (const side of [-1, 1]) b.box(side * 1.15 - 0.07, -1.8, -1.55, side * 1.15 + 0.07, 2.2, -1.42, 2);
  return b.build(12.5);
}

// --------------------------------------------------------------------- others

function ship(cargo: boolean): MeshDef {
  const b = new Builder();
  const L = 100, W = 16;
  const hull: [number, number][] = [
    [-W / 2, -L / 2], [W / 2, -L / 2], [W / 2, L * 0.3], [W * 0.3, L * 0.43], [0, L / 2], [-W * 0.3, L * 0.43], [-W / 2, L * 0.3],
  ];
  b.extrude(hull, -1, 5.5, 0, 3);
  b.extrude(hull.map(([x, y]) => [x * 1.02, y * 1.004]), -1.2, 0.9, 2);
  // Accommodation block and funnel at the stern.
  b.box(-W * 0.4, -L * 0.44, 5.5, W * 0.4, -L * 0.3, 15, 3);
  b.box(-W * 0.42, -L * 0.305, 12, W * 0.42, -L * 0.3, 13.6, 4);
  b.box(-W * 0.14, -L * 0.42, 15, W * 0.14, -L * 0.35, 20, 1);
  if (cargo) {
    for (let i = 0; i < 5; i++) {
      const y0 = -L * 0.26 + i * L * 0.125;
      b.box(-W * 0.4, y0, 5.5, W * 0.4, y0 + L * 0.105, 5.5 + 5 + (i % 2) * 2.5, i % 2 ? 1 : 0);
    }
  } else {
    b.box(-W * 0.36, -L * 0.28, 5.5, W * 0.36, L * 0.22, 9.5, 3);
    b.box(-W * 0.37, -L * 0.27, 6.6, W * 0.37, L * 0.21, 8.2, 4);
    b.box(-W * 0.28, -L * 0.2, 9.5, W * 0.28, L * 0.1, 12.5, 3);
  }
  return b.build(L);
}

function carriage(b: Builder, y0: number, len: number, w: number, h: number, floor: number): void {
  const x = w / 2;
  b.box(-x, y0, floor, x, y0 + len, floor + h, 0);
  // Window band, slightly proud of the body.
  b.box(-x * 1.02, y0 + len * 0.04, floor + h * 0.45, x * 1.02, y0 + len * 0.96, floor + h * 0.78, 4);
  // Accent stripe.
  b.box(-x * 1.025, y0, floor + h * 0.18, x * 1.025, y0 + len, floor + h * 0.3, 1);
  // Roof and running gear.
  b.box(-x * 0.8, y0 + len * 0.05, floor + h, x * 0.8, y0 + len * 0.95, floor + h + 0.2, 3);
  b.box(-x * 0.85, y0 + len * 0.08, 0, x * 0.85, y0 + len * 0.26, floor, 2);
  b.box(-x * 0.85, y0 + len * 0.74, 0, x * 0.85, y0 + len * 0.92, floor, 2);
}

function rail(cars: number, carLen: number, w: number, h: number): MeshDef {
  const b = new Builder();
  const total = cars * carLen + (cars - 1) * 0.6;
  for (let i = 0; i < cars; i++) carriage(b, -total / 2 + i * (carLen + 0.6), carLen, w, h, 0.9);
  // Windscreen on the leading car.
  b.box(-w * 0.4, total / 2 - 0.05, 0.9 + h * 0.45, w * 0.4, total / 2 + 0.06, 0.9 + h * 0.85, 4);
  return b.build(total);
}

function bus(): MeshDef {
  const b = new Builder();
  carriage(b, -6, 12, 2.55, 2.7, 0.4);
  b.box(-1.1, 5.95, 1.5, 1.1, 6.06, 2.7, 4);
  return b.build(12);
}

// ------------------------------------------------------------------- road vehicles

interface CarSpec {
  len: number;
  w: number;
  /** Roof height above the ground. */
  h: number;
  /** Bonnet length and boot length as fractions of the body; a hatchback has almost no boot. */
  hood: number;
  boot: number;
  /** Open load bed (pick-up) instead of a boot. */
  bed?: boolean;
  /** Height of the body below the windows. */
  belt: number;
  wheel: number;
  clearance: number;
}

function wheel(b: Builder, x: number, y: number, r: number, w: number): void {
  const n = 10;
  const ring = (xx: number, rr: number): V3[] => Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [xx, y + Math.cos(a) * rr, r + Math.sin(a) * rr] as V3;
  });
  b.loft([ring(x - w / 2, r), ring(x + w / 2, r)], 2);
  // Hub cap on the outer face.
  const out = x > 0 ? x + w / 2 + 0.005 : x - w / 2 - 0.005;
  b.loft([ring(out, r * 0.55), ring(out + (x > 0 ? 0.01 : -0.01), r * 0.5)], 3);
}

function roadCar(s: CarSpec): MeshDef {
  const b = new Builder();
  const x = s.w / 2;
  const y0 = -s.len / 2, y1 = s.len / 2;
  const z0 = s.clearance, zb = s.belt, zr = s.h;
  const cabF = y1 - s.len * s.hood;          // base of the windscreen
  const cabR = y0 + s.len * s.boot;          // base of the rear window
  const rect = (xa: number, ya: number, yb: number, z: number): V3[] => [[-xa, ya, z], [xa, ya, z], [xa, yb, z], [-xa, yb, z]];

  // Lower body, slightly tucked in at the sills and rounded at both ends.
  b.loft([rect(x * 0.94, y0 + 0.12, y1 - 0.15, z0), rect(x, y0, y1, (z0 + zb) / 2), rect(x * 0.97, y0 + 0.04, y1 - 0.06, zb)], 0);
  // Bumpers and grille.
  b.box(-x * 0.98, y1 - 0.06, z0, x * 0.98, y1 + 0.03, z0 + 0.22, 2);
  b.box(-x * 0.98, y0 - 0.03, z0, x * 0.98, y0 + 0.06, z0 + 0.22, 2);
  b.box(-x * 0.5, y1 + 0.005, zb - 0.32, x * 0.5, y1 + 0.03, zb - 0.14, 2);
  // Head lamps (light) and tail lamps (accent colour = red).
  for (const side of [-1, 1]) {
    b.box(side * x * 0.9 - 0.16, y1 - 0.02, zb - 0.26, side * x * 0.9 + 0.1, y1 + 0.035, zb - 0.1, 3);
    b.box(side * x * 0.9 - 0.14, y0 - 0.035, zb - 0.24, side * x * 0.9 + 0.1, y0 + 0.02, zb - 0.08, 1);
  }

  if (s.bed) {
    // Pick-up: short cab, then an open bed with walls.
    const cabEnd = cabF - s.len * 0.3;
    b.loft([rect(x * 0.95, cabEnd, cabF, zb), rect(x * 0.84, cabEnd + 0.08, cabF - 0.55, zr - 0.06)], 4);
    b.box(-x * 0.84, cabEnd + 0.08, zr - 0.06, x * 0.84, cabF - 0.55, zr, 0);
    b.box(-x * 0.97, y0 + 0.05, zb, -x * 0.9, cabEnd, zb + 0.28, 0);
    b.box(x * 0.9, y0 + 0.05, zb, x * 0.97, cabEnd, zb + 0.28, 0);
    b.box(-x * 0.97, y0 + 0.04, zb, x * 0.97, y0 + 0.11, zb + 0.28, 0);
    b.box(-x * 0.9, y0 + 0.11, zb - 0.1, x * 0.9, cabEnd, zb + 0.02, 2);
  } else {
    // Glasshouse: glass all round, tapering to a narrower roof, with pillars at the corners.
    const roofF = cabF - (zr - zb) * 0.9;
    const roofR = cabR + (zr - zb) * (s.boot < 0.08 ? 0.25 : 0.75);
    b.loft([rect(x * 0.95, cabR, cabF, zb), rect(x * 0.82, roofR, roofF, zr - 0.05)], 4);
    b.box(-x * 0.82, roofR, zr - 0.05, x * 0.82, roofF, zr, 0);
    for (const side of [-1, 1]) {
      const mid = (roofF + roofR) / 2;
      b.slab([side * x * 0.955, mid, zb], 0.14, 0.04, [side * x * 0.83, mid, zr - 0.03], 0.12, 0.04, 0, true);
      b.box(side * x * 1.0, cabF - 0.35, zb - 0.02, side * (x + 0.12), cabF - 0.2, zb + 0.1, 0);
    }
  }
  for (const yy of [y1 - s.len * 0.17, y0 + s.len * 0.18]) for (const side of [-1, 1]) wheel(b, side * (x - 0.1), yy, s.wheel, 0.21);
  return b.build(s.len);
}

function motorcycle(): MeshDef {
  const b = new Builder();
  wheel(b, 0, 0.72, 0.3, 0.11);
  wheel(b, 0, -0.68, 0.3, 0.13);
  b.box(-0.13, -0.45, 0.42, 0.13, 0.5, 0.78, 0);
  b.box(-0.11, -0.75, 0.72, 0.11, -0.1, 0.86, 2);
  b.box(-0.34, 0.5, 0.98, 0.34, 0.56, 1.03, 2);
  b.slab([0, 0.68, 0.32], 0.08, 0.07, [0, 0.5, 1.0], 0.08, 0.07, 3, true);
  // Rider: legs, torso, arms, helmet.
  b.box(-0.2, -0.25, 0.8, 0.2, 0.15, 1.02, 8);
  b.slab([0, -0.2, 0.98], 0.3, 0.38, [0, 0.12, 1.5], 0.26, 0.4, 8, true);
  for (const side of [-1, 1]) b.slab([side * 0.22, 0.1, 1.42], 0.1, 0.1, [side * 0.3, 0.5, 1.06], 0.08, 0.08, 8);
  b.tube([[0.0, 0.05, 0.05, 1.68], [0.06, 0.14, 0.14, 1.66], [0.2, 0.15, 0.15, 1.64], [0.32, 0.08, 0.08, 1.62]], 8, 1);
  return b.build(2.1);
}

function person(): MeshDef {
  const b = new Builder();
  // Shoes, legs (colour 3), torso and sleeves (colour 1), hands, neck and face (colour 2), hair.
  for (const side of [-1, 1]) {
    b.box(side * 0.1 - 0.065, -0.1, 0, side * 0.1 + 0.065, 0.16, 0.08, 2);
    const leg = (hx: number, hy: number, zz: number): V3[] => [[side * 0.1 - hx, -hy, zz], [side * 0.1 + hx, -hy, zz], [side * 0.1 + hx, hy, zz], [side * 0.1 - hx, hy, zz]];
    b.loft([leg(0.06, 0.07, 0.08), leg(0.075, 0.085, 0.45), leg(0.09, 0.1, 0.86)], 8);
  }
  b.loft(
    [
      [[-0.17, -0.1, 0.84], [0.17, -0.1, 0.84], [0.17, 0.11, 0.84], [-0.17, 0.11, 0.84]],
      [[-0.2, -0.11, 1.15], [0.2, -0.11, 1.15], [0.2, 0.12, 1.15], [-0.2, 0.12, 1.15]],
      [[-0.22, -0.1, 1.42], [0.22, -0.1, 1.42], [0.22, 0.1, 1.42], [-0.22, 0.1, 1.42]],
      [[-0.1, -0.07, 1.48], [0.1, -0.07, 1.48], [0.1, 0.07, 1.48], [-0.1, 0.07, 1.48]],
    ],
    0,
  );
  for (const side of [-1, 1]) {
    b.box(side * 0.27 - 0.05, -0.06, 0.92, side * 0.27 + 0.05, 0.06, 1.42, 0);
    b.box(side * 0.27 - 0.045, -0.05, 0.82, side * 0.27 + 0.045, 0.05, 0.92, 1);
  }
  b.box(-0.05, -0.05, 1.46, 0.05, 0.05, 1.54, 1);
  const head: V3[][] = [];
  for (const [z, r] of [[1.52, 0.06], [1.58, 0.1], [1.66, 0.11], [1.73, 0.09], [1.77, 0.04]]) {
    head.push(Array.from({ length: 8 }, (_, i) => {
      const a = (i / 8) * Math.PI * 2;
      return [Math.cos(a) * r, Math.sin(a) * r * 1.1, z] as V3;
    }));
  }
  b.loft(head.slice(0, 3), 1);
  b.loft(head.slice(2), 2);
  return b.build(1.78);
}

function truck(): MeshDef {
  const b = new Builder();
  // Cab-over tractor unit with a box trailer.
  b.loft([[[-1.22, 3.6, 0.55], [1.22, 3.6, 0.55], [1.22, 5.5, 0.55], [-1.22, 5.5, 0.55]], [[-1.22, 3.6, 2.2], [1.22, 3.6, 2.2], [1.22, 5.5, 2.2], [-1.22, 5.5, 2.2]], [[-1.15, 3.6, 3.0], [1.15, 3.6, 3.0], [1.15, 5.25, 3.0], [-1.15, 5.25, 3.0]]], 0);
  b.box(-1.1, 5.4, 1.75, 1.1, 5.52, 2.75, 4);
  for (const side of [-1, 1]) b.box(side * 1.16, 4.3, 1.8, side * 1.24, 5.2, 2.7, 4);
  b.box(-1.2, 5.45, 0.5, 1.2, 5.56, 0.95, 2);
  b.box(-1.27, -5.6, 1.15, 1.27, 3.35, 3.9, 3);
  b.box(-1.0, -5.5, 0.75, 1.0, 5.0, 1.15, 2);
  for (const y of [-4.6, -3.4, 2.5, 4.6]) for (const side of [-1, 1]) wheel(b, side * 1.05, y, 0.52, 0.3);
  return b.build(11.2);
}

function satellite(): MeshDef {
  const b = new Builder();
  b.box(-1.1, -1.6, -1.1, 1.1, 1.6, 1.1, 0);
  b.box(-0.5, 1.6, -0.5, 0.5, 2.3, 0.5, 3);
  for (const side of [-1, 1]) {
    b.box(side * 1.1, -0.12, -0.12, side * 2, 0.12, 0.12, 2);
    b.box(side * 2, -1.4, -0.06, side * 8, 1.4, 0.06, 4);
  }
  return b.build(16);
}

function shadow(): MeshDef {
  const b = new Builder();
  const n = 14;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
    b.tri([0, 0, 0], [Math.cos(a0) * 0.5, Math.sin(a0) * 0.5, 0], [Math.cos(a1) * 0.5, Math.sin(a1) * 0.5, 0], 6, [0, 0, -1]);
  }
  return b.build(1, true);
}

function segment(): MeshDef {
  const b = new Builder();
  b.box(-0.5, 0, -0.5, 0.5, 1, 0.5, 7);
  return b.build(1, true);
}

export enum M {
  Shadow,
  Segment,
  Heli,
  Cargo,
  Ferry,
  Bus,
  Train,
  Tram,
  Car,
  Truck,
  Person,
  Sat,
  Sedan,
  Suv,
  Pickup,
  Van,
  Kei,
  Moto,
}

/** Built in the same order as the `M` enum. */
export function buildMeshes(): MeshDef[] {
  return [
    shadow(),
    segment(),
    helicopter(),
    ship(true),
    ship(false),
    bus(),
    rail(4, 24, 3.0, 3.1),
    rail(2, 15, 2.5, 2.7),
    roadCar({ len: 4.05, w: 1.75, h: 1.48, hood: 0.26, boot: 0.03, belt: 0.92, wheel: 0.3, clearance: 0.17 }),
    truck(),
    person(),
    satellite(),
    roadCar({ len: 4.65, w: 1.8, h: 1.45, hood: 0.26, boot: 0.2, belt: 0.9, wheel: 0.31, clearance: 0.16 }),
    roadCar({ len: 4.5, w: 1.85, h: 1.68, hood: 0.25, boot: 0.03, belt: 1.05, wheel: 0.36, clearance: 0.22 }),
    roadCar({ len: 5.35, w: 1.9, h: 1.8, hood: 0.24, boot: 0, bed: true, belt: 1.1, wheel: 0.4, clearance: 0.25 }),
    roadCar({ len: 5, w: 1.95, h: 2, hood: 0.12, boot: 0.01, belt: 1.15, wheel: 0.34, clearance: 0.2 }),
    roadCar({ len: 3.4, w: 1.48, h: 1.7, hood: 0.14, boot: 0.01, belt: 0.95, wheel: 0.27, clearance: 0.16 }),
    motorcycle(),
  ];
}
