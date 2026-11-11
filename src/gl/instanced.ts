// One Cesium primitive that draws every moving thing (aircraft, ships, trains, cars, people,
// satellites) with hardware instancing, depth-tested against the photorealistic 3D tiles.
//
// Each instance is placed on the WGS84 ellipsoid on the CPU in double precision, relative to a
// reference point near the camera (so float32 on the GPU stays precise to millimetres), with its
// local east/north/up frame. The model is turned to its heading in that frame on the GPU.

import * as Cesium from 'cesium';
import { BoundingSphere, Cartesian3, Matrix4, SceneTransforms, type Scene as CesiumScene } from 'cesium';
import { DEG, mercScale } from '../util/geo';
import type { MeshDef } from './meshes';

// Renderer classes that CesiumJS exports but does not type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const C = Cesium as any;

/** Floats per instance: position(3) east(3) north(3) heading/scale/scale/climb(4) colours(9). */
const STRIDE = 22;
const A = 6378137;
const E2 = 6.69437999014e-3;

export interface FrameInfo {
  /** Epoch ms. */
  now: number;
  /** Seconds since the previous frame (clamped). */
  dt: number;
  zoom: number;
  /** Metres per CSS pixel at the view centre. */
  mpp: number;
  lat: number;
  lon: number;
  globe: boolean;
  /** 0 = day, 1 = night at the view centre. */
  night: number;
}

/** Where the camera looks; supplied by the world each frame. */
export interface ViewState {
  lat: number;
  lon: number;
  /** Ground height at the view centre, metres above the ellipsoid. */
  height: number;
  zoom: number;
  mpp: number;
  globe: boolean;
}

const latFromMerc = (y: number): number => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / DEG;

export class Scene {
  /** Reference point (ECEF metres) every instance position is relative to. */
  readonly ref = new Float64Array(3);
  /** Reference point in mercator, kept for code that reasons in map units. */
  refX = 0;
  refY = 0;
  readonly bufs: Float32Array[];
  readonly counts: number[];
  /** Largest distance of any instance from the reference point, for culling. */
  radius = 0;
  private pickPos: number[] = [];
  private pickR: number[] = [];
  private pickRef: unknown[] = [];

  constructor(meshCount: number) {
    this.bufs = Array.from({ length: meshCount }, () => new Float32Array(STRIDE * 64));
    this.counts = new Array<number>(meshCount).fill(0);
  }

  /** Makes room for a mesh registered after start-up. */
  grow(): void {
    this.bufs.push(new Float32Array(STRIDE * 16));
    this.counts.push(0);
  }

  begin(lat: number, lon: number, height: number, refX: number, refY: number): void {
    ecef(lat * DEG, lon * DEG, height, this.ref, 0);
    this.refX = refX;
    this.refY = refY;
    this.radius = 0;
    this.counts.fill(0);
    this.pickPos.length = this.pickR.length = this.pickRef.length = 0;
  }

  /**
   * @param mx,my   absolute mercator position (0..1)
   * @param elev    metres above the ellipsoid
   * @param heading radians clockwise from north
   * @param sx      scale across and up
   * @param sy      scale along the model's forward axis
   * @param climb   metres gained along the forward axis (trail segments)
   * @param c1,c2,c3 0xRRGGBB
   */
  add(mesh: number, mx: number, my: number, elev: number, heading: number, sx: number, sy: number, climb: number, c1: number, c2: number, c3 = 0xd5d8dc): void {
    let buf = this.bufs[mesh];
    if (!buf) return;
    const n = this.counts[mesh];
    const o = n * STRIDE;
    if (o + STRIDE > buf.length) {
      const grown = new Float32Array(buf.length * 2);
      grown.set(buf);
      this.bufs[mesh] = buf = grown;
    }
    const lon = (mx * 360 - 180) * DEG;
    const lat = latFromMerc(my) * DEG;
    const sl = Math.sin(lat), cl = Math.cos(lat), so = Math.sin(lon), co = Math.cos(lon);
    const nn = A / Math.sqrt(1 - E2 * sl * sl);
    const x = (nn + elev) * cl * co - this.ref[0];
    const y = (nn + elev) * cl * so - this.ref[1];
    const z = (nn * (1 - E2) + elev) * sl - this.ref[2];
    const d = Math.hypot(x, y, z);
    if (d > this.radius) this.radius = d;
    buf[o] = x;
    buf[o + 1] = y;
    buf[o + 2] = z;
    // East and north unit vectors of the local tangent frame.
    buf[o + 3] = -so;
    buf[o + 4] = co;
    buf[o + 5] = 0;
    buf[o + 6] = -sl * co;
    buf[o + 7] = -sl * so;
    buf[o + 8] = cl;
    buf[o + 9] = heading;
    buf[o + 10] = sx;
    buf[o + 11] = sy;
    buf[o + 12] = climb;
    buf[o + 13] = ((c1 >> 16) & 255) / 255;
    buf[o + 14] = ((c1 >> 8) & 255) / 255;
    buf[o + 15] = (c1 & 255) / 255;
    buf[o + 16] = ((c2 >> 16) & 255) / 255;
    buf[o + 17] = ((c2 >> 8) & 255) / 255;
    buf[o + 18] = (c2 & 255) / 255;
    buf[o + 19] = ((c3 >> 16) & 255) / 255;
    buf[o + 20] = ((c3 >> 8) & 255) / 255;
    buf[o + 21] = (c3 & 255) / 255;
    this.counts[mesh] = n + 1;
  }

  /** Registers something clickable. `radius` is in CSS pixels. */
  pickable(mx: number, my: number, elev: number, radius: number, ref: unknown): void {
    this.pickPos.push(mx, my, elev);
    this.pickR.push(radius);
    this.pickRef.push(ref);
  }

  get pickCount(): number {
    return this.pickRef.length;
  }

  pickEntry(i: number): [number, number, number, number, unknown] {
    return [this.pickPos[i * 3], this.pickPos[i * 3 + 1], this.pickPos[i * 3 + 2], this.pickR[i], this.pickRef[i]];
  }
}

function ecef(lat: number, lon: number, h: number, out: Float64Array, o: number): void {
  const sl = Math.sin(lat);
  const cl = Math.cos(lat);
  const n = A / Math.sqrt(1 - E2 * sl * sl);
  out[o] = (n + h) * cl * Math.cos(lon);
  out[o + 1] = (n + h) * cl * Math.sin(lon);
  out[o + 2] = (n * (1 - E2) + h) * sl;
}

const VERT = `
in vec3 a_pos;
in vec3 a_nrm;
in float a_part;
in vec3 i_pos;
in vec3 i_east;
in vec3 i_north;
in vec4 i_b;
in vec3 i_c1;
in vec3 i_c2;
in vec3 i_c3;
uniform float u_night;
out vec4 v_color;

void main() {
  float ch = cos(i_b.x), sh = sin(i_b.x);
  vec3 l = vec3(a_pos.x * i_b.y, a_pos.y * i_b.z, a_pos.z * i_b.y + a_pos.y * i_b.w);
  float e = l.x * ch + l.y * sh;
  float n = -l.x * sh + l.y * ch;
  vec3 up = cross(i_east, i_north);
  vec3 p = i_pos + i_east * e + i_north * n + up * l.z;
  gl_Position = czm_modelViewProjection * vec4(p, 1.0);

  // Normal turned to the heading, lit by a fixed light in the local frame (the miniature look).
  vec3 nl = vec3(a_nrm.x * ch + a_nrm.y * sh, -a_nrm.x * sh + a_nrm.y * ch, a_nrm.z);
  float diff = max(dot(nl, normalize(vec3(-0.45, 0.35, 0.82))), 0.0);
  float light = mix(0.55 + 0.55 * diff, 0.28 + 0.3 * diff, u_night);

  int part = int(a_part + 0.5);
  vec3 c = i_c1;
  float a = 1.0;
  float glow = 0.0;
  if (part == 1) c = i_c2;
  else if (part == 2) c = vec3(0.12, 0.13, 0.15);
  else if (part == 3) c = vec3(0.86, 0.87, 0.89);
  else if (part == 4) {
    // Glass: sky reflected on the upward-facing panes, darker on the sides.
    c = mix(mix(vec3(0.22, 0.3, 0.38), vec3(0.55, 0.66, 0.76), max(nl.z, 0.0)), vec3(1.0, 0.82, 0.45), u_night * 0.85);
    glow = u_night;
  }
  else if (part == 5) c = vec3(0.86, 0.68, 0.55);
  else if (part == 6) { c = vec3(0.0); a = 0.22; light = 1.0; }
  else if (part == 7) { c = i_c2; a = 0.85; light = 1.0; }
  else if (part == 8) c = i_c3;
  else if (part == 9) { c = vec3(1.0, 0.96, 0.84); glow = u_night; }
  if (part == 10) {
    // Light thrown on the ground: added on top of what is there, strongest at the centre.
    float k = max(0.0, 1.0 - 2.0 * length(a_pos.xy));
    float s = u_night * k * k * 0.75;
    v_color = vec4(i_c1 * s, s * 0.2);
    return;
  }
  vec3 rgb = c * mix(light, 1.25, glow);
  v_color = vec4(rgb * a, a);
}`;

const FRAG = `
in vec4 v_color;
void main() { out_FragColor = v_color; }`;

const ATTRS = { a_pos: 0, a_nrm: 1, a_part: 2, i_pos: 3, i_east: 4, i_north: 5, i_b: 6, i_c1: 7, i_c2: 8, i_c3: 9 };

interface Slot {
  vb: unknown;
  ib: unknown;
  va: unknown;
  capacity: number;
  command: unknown;
}

export class InstancedLayer {
  readonly scene: Scene;
  /** Frames per second ceiling; applied by the world to the render loop. */
  maxFps = 60;
  /** Smoothed frame time in ms, used for adaptive quality. */
  frameMs = 16;

  private slots: (Slot | null)[] = [];
  private program: unknown = null;
  private opaque: unknown = null;
  private translucent: unknown = null;
  private last = 0;
  private night = 0;
  private readonly modelMatrix = new Matrix4();
  private readonly bounds = new BoundingSphere();
  private cesium: CesiumScene | null = null;
  private readonly tmp = new Cartesian3();

  constructor(
    private readonly meshes: MeshDef[],
    private readonly onFrame: (scene: Scene, frame: FrameInfo) => void,
    /** 0 = day, 1 = night where the camera looks (or always, in Night mode). */
    private readonly nightAt: (lat: number, lon: number, now: number) => number,
    private readonly view: () => ViewState,
  ) {
    this.scene = new Scene(meshes.length);
  }

  /** Registers a mesh built after start-up (aircraft types are generated on first sight). Returns its index. */
  addMesh(mesh: MeshDef): number {
    this.meshes.push(mesh);
    this.scene.grow();
    return this.meshes.length - 1;
  }

  /** Called by Cesium once per frame. */
  update(frameState: { context: unknown; commandList: unknown[]; passes: { render: boolean; pick: boolean } }): void {
    if (!frameState.passes.render) return;
    const context = frameState.context;
    const nowPerf = performance.now();
    const rawDt = this.last ? nowPerf - this.last : 16;
    this.last = nowPerf;
    this.frameMs += (Math.min(rawDt, 250) - this.frameMs) * 0.05;

    const v = this.view();
    const now = Date.now();
    this.night = this.nightAt(v.lat, v.lon, now);
    const frame: FrameInfo = { now, dt: Math.min(rawDt, 100) / 1000, zoom: v.zoom, mpp: v.mpp, lat: v.lat, lon: v.lon, globe: v.globe, night: this.night };
    const sx = (v.lon + 180) / 360;
    const sinL = Math.sin(Math.max(-85, Math.min(85, v.lat)) * DEG);
    const sy = 0.5 - Math.log((1 + sinL) / (1 - sinL)) / (4 * Math.PI);
    this.scene.begin(v.lat, v.lon, v.height, sx, sy);
    this.onFrame(this.scene, frame);

    if (!this.program) this.setup(context);
    const ref = this.scene.ref;
    Matrix4.fromTranslation(Cartesian3.fromElements(ref[0], ref[1], ref[2], this.tmp), this.modelMatrix);
    Cartesian3.fromElements(ref[0], ref[1], ref[2], this.bounds.center);
    this.bounds.radius = this.scene.radius + 200;

    for (let i = 0; i < this.meshes.length; i++) {
      const count = this.scene.counts[i];
      if (!count) continue;
      const slot = this.slot(context, i, count);
      const cmd = slot.command as { instanceCount: number; modelMatrix: Matrix4; boundingVolume: BoundingSphere };
      (slot.ib as { copyFromArrayView(a: ArrayBufferView, o: number): void }).copyFromArrayView(this.scene.bufs[i].subarray(0, count * STRIDE), 0);
      cmd.instanceCount = count;
      cmd.modelMatrix = this.modelMatrix;
      cmd.boundingVolume = this.bounds;
      frameState.commandList.push(cmd);
    }
  }

  private setup(context: unknown): void {
    this.program = C.ShaderProgram.fromCache({ context, vertexShaderSource: VERT, fragmentShaderSource: FRAG, attributeLocations: ATTRS });
    this.opaque = C.RenderState.fromCache({ depthTest: { enabled: true }, depthMask: true, cull: { enabled: false }, blending: Cesium.BlendingState.DISABLED });
    this.translucent = C.RenderState.fromCache({ depthTest: { enabled: true }, depthMask: false, cull: { enabled: false }, blending: Cesium.BlendingState.PRE_MULTIPLIED_ALPHA_BLEND });
  }

  /** The GPU buffers for one mesh, grown when it has more instances than room. */
  private slot(context: unknown, i: number, count: number): Slot {
    const existing = this.slots[i];
    if (existing && existing.capacity >= count) return existing;
    if (existing) {
      (existing.va as { destroy(): void }).destroy();
    }
    const mesh = this.meshes[i];
    const capacity = Math.max(64, 2 ** Math.ceil(Math.log2(count)));
    const vb = existing?.vb ?? C.Buffer.createVertexBuffer({ context, typedArray: mesh.data, usage: C.BufferUsage.STATIC_DRAW });
    // The model's vertices outlive the vertex array, which is rebuilt whenever the instance buffer grows.
    (vb as { vertexArrayDestroyable: boolean }).vertexArrayDestroyable = false;
    const ib = C.Buffer.createVertexBuffer({ context, sizeInBytes: capacity * STRIDE * 4, usage: C.BufferUsage.DYNAMIC_DRAW });
    const F = Cesium.ComponentDatatype.FLOAT;
    const per = (index: number, size: number, offset: number) => ({ index, vertexBuffer: ib, componentsPerAttribute: size, componentDatatype: F, offsetInBytes: offset * 4, strideInBytes: STRIDE * 4, instanceDivisor: 1 });
    const va = new C.VertexArray({
      context,
      attributes: [
        { index: 0, vertexBuffer: vb, componentsPerAttribute: 3, componentDatatype: F, offsetInBytes: 0, strideInBytes: 28 },
        { index: 1, vertexBuffer: vb, componentsPerAttribute: 3, componentDatatype: F, offsetInBytes: 12, strideInBytes: 28 },
        { index: 2, vertexBuffer: vb, componentsPerAttribute: 1, componentDatatype: F, offsetInBytes: 24, strideInBytes: 28 },
        per(3, 3, 0),
        per(4, 3, 3),
        per(5, 3, 6),
        per(6, 4, 9),
        per(7, 3, 13),
        per(8, 3, 16),
        per(9, 3, 19),
      ],
    });
    const command = new C.DrawCommand({
      owner: this,
      primitiveType: Cesium.PrimitiveType.TRIANGLES,
      vertexArray: va,
      count: mesh.vertexCount,
      shaderProgram: this.program,
      renderState: mesh.translucent ? this.translucent : this.opaque,
      pass: mesh.translucent ? C.Pass.TRANSLUCENT : C.Pass.OPAQUE,
      uniformMap: { u_night: () => this.night },
      instanceCount: 0,
    });
    const slot: Slot = { vb, ib, va, capacity, command };
    this.slots[i] = slot;
    return slot;
  }

  attach(scene: CesiumScene): void {
    this.cesium = scene;
    scene.primitives.add(this);
  }

  isDestroyed(): boolean {
    return false;
  }

  destroy(): void {
    /* lives as long as the page */
  }

  /** Finds the closest clickable thing to a point given in CSS pixels. */
  pick(x: number, y: number): unknown {
    const scene = this.scene;
    const cs = this.cesium;
    if (!cs) return null;
    let best: unknown = null;
    let bestScore = Infinity;
    const p = new Cartesian3();
    const out = new Cesium.Cartesian2();
    const camPos = cs.camera.positionWC;
    for (let i = 0; i < scene.pickCount; i++) {
      const [mx, my, elev, radius, ref] = scene.pickEntry(i);
      const lon = mx * 360 - 180;
      const lat = latFromMerc(my);
      Cartesian3.fromDegrees(lon, lat, elev, undefined, p);
      // Skip things on the far side of the planet.
      if (Cartesian3.dot(p, Cartesian3.subtract(camPos, p, this.tmp)) < 0 && Cartesian3.magnitude(camPos) > 7.5e6) continue;
      const w = SceneTransforms.worldToWindowCoordinates(cs, p, out);
      if (!w) continue;
      const d = Math.hypot(w.x - x, w.y - y);
      if (d <= radius && d / radius < bestScore) {
        bestScore = d / radius;
        best = ref;
      }
    }
    void mercScale;
    return best;
  }
}
