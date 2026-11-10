// Procedural low-poly models. Everything is generated at start-up, so the app
// ships no model files at all.
//
// Model space: +x right, +y forward (nose), +z up, in metres.
// Each vertex carries a "part" id that the shader maps to a colour:
//   0 body (instance colour 1)   1 accent (instance colour 2)   2 dark
//   3 light grey                 4 glass (glows at night)       5 skin
//   6 shadow (translucent)       7 trail (instance colour 2, translucent)

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

interface AirframeSpec {
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
  engines: 'under2' | 'under4' | 'rear2' | 'prop2' | 'prop1' | 'rear1';
  /** Hump on the forward upper deck. */
  hump?: boolean;
  sides?: number;
}

function airframe(s: AirframeSpec): MeshDef {
  const b = new Builder();
  const L = s.len, r = s.r, nose = L / 2, tail = -L / 2;
  const sides = s.sides ?? 8;

  // Fuselage, tail to nose.
  b.tube(
    [
      [tail, r * 0.12, r * 0.18, r * 0.55],
      [tail + L * 0.1, r * 0.5, r * 0.55, r * 0.3],
      [tail + L * 0.26, r, r, 0],
      [nose - L * 0.13, r, r, 0],
      [nose - L * 0.05, r * 0.78, r * 0.75, -r * 0.08],
      [nose - L * 0.012, r * 0.32, r * 0.3, -r * 0.22],
      [nose, r * 0.05, r * 0.05, -r * 0.25],
    ],
    sides,
    0,
  );
  if (s.hump) {
    b.tube(
      [
        [nose - L * 0.42, r * 0.2, r * 0.2, r * 0.75],
        [nose - L * 0.33, r * 0.72, r * 0.55, r * 0.8],
        [nose - L * 0.1, r * 0.72, r * 0.55, r * 0.8],
        [nose - L * 0.04, r * 0.25, r * 0.2, r * 0.45],
      ],
      6,
      0,
    );
  }

  // Cabin window band and cockpit glazing.
  const wz = r * 0.18;
  for (const side of [-1, 1]) {
    b.box(side * r * 0.93, tail + L * 0.27, wz - r * 0.09, side * r * 1.01, nose - L * 0.15, wz + r * 0.09, 4);
  }
  b.box(-r * 0.5, nose - L * 0.085, r * 0.28, r * 0.5, nose - L * 0.05, r * 0.62, 4);

  // Wings.
  const wy = nose - L * s.wingAt;
  const wz0 = s.highWing ? r * 0.85 : -r * 0.45;
  const half = s.span / 2;
  const dihedral = s.highWing ? -half * 0.02 : half * 0.09;
  for (const side of [-1, 1]) {
    b.slab(
      [side * r * 0.5, wy, wz0], s.rootChord, r * 0.34,
      [side * half, wy - s.sweep, wz0 + dihedral], s.tipChord, r * 0.1,
      3,
    );
    if (!s.highWing && s.span > 25) {
      // Winglet.
      b.slab(
        [side * half, wy - s.sweep, wz0 + dihedral], s.tipChord, r * 0.1,
        [side * (half + r * 0.15), wy - s.sweep - s.tipChord * 0.4, wz0 + dihedral + r * 1.1], s.tipChord * 0.45, r * 0.06,
        1,
      );
    }
  }

  // Fin and tailplane.
  const finRootY = tail + L * 0.1;
  const finH = Math.max(r * 2.6, L * 0.14);
  b.slab([0, finRootY + L * 0.01, r * 0.7], L * 0.15, r * 0.22, [0, finRootY - L * 0.055, r * 0.7 + finH], L * 0.065, r * 0.1, 1, true);
  const stabZ = s.tTail ? r * 0.7 + finH : r * 0.35;
  const stabY = s.tTail ? finRootY - L * 0.055 : finRootY - L * 0.02;
  const stabHalf = s.span * 0.19;
  for (const side of [-1, 1]) {
    b.slab([side * r * 0.15, stabY, stabZ], L * 0.085, r * 0.16, [side * stabHalf, stabY - L * 0.045, stabZ + (s.tTail ? 0 : stabHalf * 0.06)], L * 0.04, r * 0.07, 3);
  }

  // Engines.
  const nacelle = (x: number, y: number, z: number, er: number, el: number) => {
    b.tube([[y - el / 2, er * 0.7, er * 0.7, z], [y, er, er, z], [y + el / 2, er * 0.92, er * 0.92, z]], 6, 3, x);
    b.tube([[y + el / 2 - 0.01, er * 0.8, er * 0.8, z], [y + el / 2 + el * 0.04, er * 0.75, er * 0.75, z]], 6, 2, x);
  };
  const prop = (x: number, y: number, z: number, pr: number) => {
    b.box(x - pr, y, z - pr * 0.07, x + pr, y + pr * 0.05, z + pr * 0.07, 2);
    b.box(x - pr * 0.07, y, z - pr, x + pr * 0.07, y + pr * 0.05, z + pr, 2);
  };
  const er = r * 0.62;
  const el = L * 0.11;
  if (s.engines === 'under2' || s.engines === 'under4') {
    const spots = s.engines === 'under2' ? [0.32] : [0.3, 0.58];
    for (const f of spots) {
      for (const side of [-1, 1]) {
        nacelle(side * half * f, wy - s.sweep * f + s.rootChord * 0.42, wz0 + dihedral * f - er * 1.15, er, el);
      }
    }
  } else if (s.engines === 'rear2') {
    for (const side of [-1, 1]) nacelle(side * (r + er * 0.95), tail + L * 0.24, r * 0.35, er * 0.85, el);
  } else if (s.engines === 'prop2') {
    for (const side of [-1, 1]) {
      const x = side * half * 0.3;
      const y = wy + s.rootChord * 0.45;
      nacelle(x, y, wz0 - er * 0.5, er * 0.6, el * 1.3);
      prop(x, y + el * 0.7, wz0 - er * 0.5, r * 1.35);
    }
  } else if (s.engines === 'prop1') {
    prop(0, nose, -r * 0.2, r * 1.5);
  }

  // Gear stubs so parked aircraft sit on something.
  b.box(-r * 0.12, nose - L * 0.1, -r * 1.55, r * 0.12, nose - L * 0.085, -r * 0.9, 2);
  for (const side of [-1, 1]) b.box(side * r * 0.95 - r * 0.14, wy - s.rootChord * 0.2, -r * 1.55, side * r * 0.95 + r * 0.14, wy - s.rootChord * 0.05, -r * 0.7, 2);

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

function car(): MeshDef {
  const b = new Builder();
  b.box(-0.9, -2.2, 0.3, 0.9, 2.2, 0.95, 0);
  b.box(-0.8, -1.3, 0.95, 0.8, 0.75, 1.45, 4);
  b.box(-0.78, -1.2, 1.45, 0.78, 0.6, 1.52, 0);
  for (const y of [-1.45, 1.4]) b.box(-0.95, y - 0.33, 0, 0.95, y + 0.33, 0.45, 2);
  b.box(-0.7, 2.19, 0.6, 0.7, 2.23, 0.8, 3);
  return b.build(4.4);
}

function truck(): MeshDef {
  const b = new Builder();
  b.box(-1.2, 2.3, 0.5, 1.2, 4.2, 2.9, 0);
  b.box(-1.1, 4.18, 1.6, 1.1, 4.24, 2.6, 4);
  b.box(-1.25, -4.2, 0.9, 1.25, 2.1, 3.6, 3);
  for (const y of [-3.2, -2.2, 3.2]) b.box(-1.25, y - 0.45, 0, 1.25, y + 0.45, 0.9, 2);
  return b.build(8.4);
}

function person(): MeshDef {
  const b = new Builder();
  b.box(-0.16, -0.1, 0, 0.16, 0.1, 0.8, 2);
  b.box(-0.22, -0.13, 0.8, 0.22, 0.13, 1.45, 0);
  b.box(-0.11, -0.11, 1.47, 0.11, 0.11, 1.72, 5);
  return b.build(1.75);
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
  Narrow,
  Wide2,
  Wide4,
  Regional,
  Turboprop,
  Light,
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
}

/** Built in the same order as the `M` enum. */
export function buildMeshes(): MeshDef[] {
  return [
    shadow(),
    segment(),
    airframe({ len: 37.6, span: 35.8, r: 1.98, wingAt: 0.46, sweep: 7.5, rootChord: 6.6, tipChord: 1.7, engines: 'under2' }),
    airframe({ len: 66, span: 63, r: 3.0, wingAt: 0.46, sweep: 15, rootChord: 12.5, tipChord: 2.6, engines: 'under2' }),
    airframe({ len: 72, span: 76, r: 3.6, wingAt: 0.45, sweep: 17, rootChord: 15, tipChord: 3.2, engines: 'under4', hump: true }),
    airframe({ len: 30, span: 23, r: 1.3, wingAt: 0.55, sweep: 5, rootChord: 4.6, tipChord: 1.2, engines: 'rear2', tTail: true }),
    airframe({ len: 27, span: 27, r: 1.35, wingAt: 0.42, sweep: 0.4, rootChord: 2.9, tipChord: 1.6, engines: 'prop2', highWing: true, tTail: true }),
    airframe({ len: 8.3, span: 11, r: 0.62, wingAt: 0.3, sweep: 0, rootChord: 1.6, tipChord: 1.2, engines: 'prop1', highWing: true, sides: 6 }),
    helicopter(),
    ship(true),
    ship(false),
    bus(),
    rail(4, 24, 3.0, 3.1),
    rail(2, 15, 2.5, 2.7),
    car(),
    truck(),
    person(),
    satellite(),
  ];
}
