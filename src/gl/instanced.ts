// One custom WebGL layer that draws every moving thing on the map with hardware instancing.
// It follows Mapbox GL's two camera models: on the globe (far out) positions are placed on a
// sphere, and at street level, where the map is flat, a camera-relative matrix keeps small
// objects free of float-precision jitter. Between the two it blends, as the map itself does.

import type { CustomLayerInterface, Map as MbMap } from 'mapbox-gl';
import { EARTH_C, DEG, mercScale, mercX, mercY } from '../util/geo';
import type { MeshDef } from './meshes';

/** Floats per instance. */
const STRIDE = 17;

export interface FrameInfo {
  /** Epoch ms. */
  now: number;
  /** Seconds since the previous frame (clamped). */
  dt: number;
  zoom: number;
  /** Metres per CSS pixel at the map centre. */
  mpp: number;
  lat: number;
  lon: number;
  globe: boolean;
  /** 0 = day, 1 = night at the map centre. */
  night: number;
}

export class Scene {
  refX = 0;
  refY = 0;
  readonly bufs: Float32Array[];
  readonly counts: number[];
  private px: number[] = [];
  private py: number[] = [];
  private pz: number[] = [];
  private pr: number[] = [];
  private pref: unknown[] = [];

  constructor(meshCount: number) {
    this.bufs = Array.from({ length: meshCount }, () => new Float32Array(STRIDE * 64));
    this.counts = new Array<number>(meshCount).fill(0);
  }

  /** Makes room for a mesh registered after start-up. */
  grow(): void {
    this.bufs.push(new Float32Array(STRIDE * 16));
    this.counts.push(0);
  }

  begin(refX: number, refY: number): void {
    this.refX = refX;
    this.refY = refY;
    this.counts.fill(0);
    this.px.length = this.py.length = this.pz.length = this.pr.length = this.pref.length = 0;
  }

  /**
   * @param mx,my   absolute mercator position (0..1)
   * @param elev    metres above sea level
   * @param heading radians clockwise from north
   * @param sx      scale across and up
   * @param sy      scale along the model's forward axis
   * @param climb   metres gained along the forward axis (trail segments)
   * @param c1,c2,c3 0xRRGGBB
   */
  add(mesh: number, mx: number, my: number, elev: number, heading: number, sx: number, sy: number, climb: number, c1: number, c2: number, c3 = 0xd5d8dc): void {
    let buf = this.bufs[mesh];
    const n = this.counts[mesh];
    const o = n * STRIDE;
    if (o + STRIDE > buf.length) {
      const grown = new Float32Array(buf.length * 2);
      grown.set(buf);
      this.bufs[mesh] = buf = grown;
    }
    let rx = mx - this.refX;
    if (rx > 0.5) rx -= 1;
    else if (rx < -0.5) rx += 1;
    buf[o] = rx;
    buf[o + 1] = my - this.refY;
    buf[o + 2] = elev;
    buf[o + 3] = heading;
    buf[o + 4] = sx;
    buf[o + 5] = sy;
    buf[o + 6] = climb;
    buf[o + 7] = mercScale(my);
    buf[o + 8] = ((c1 >> 16) & 255) / 255;
    buf[o + 9] = ((c1 >> 8) & 255) / 255;
    buf[o + 10] = (c1 & 255) / 255;
    buf[o + 11] = ((c2 >> 16) & 255) / 255;
    buf[o + 12] = ((c2 >> 8) & 255) / 255;
    buf[o + 13] = (c2 & 255) / 255;
    buf[o + 14] = ((c3 >> 16) & 255) / 255;
    buf[o + 15] = ((c3 >> 8) & 255) / 255;
    buf[o + 16] = (c3 & 255) / 255;
    this.counts[mesh] = n + 1;
  }

  /** Registers something clickable. `radius` is in CSS pixels. */
  pickable(mx: number, my: number, elev: number, radius: number, ref: unknown): void {
    this.px.push(mx);
    this.py.push(my);
    this.pz.push(elev);
    this.pr.push(radius);
    this.pref.push(ref);
  }

  get pickCount(): number {
    return this.pref.length;
  }

  pickEntry(i: number): [number, number, number, number, unknown] {
    return [this.px[i], this.py[i], this.pz[i], this.pr[i], this.pref[i]];
  }
}

const VERT = `#version 300 es
precision highp float;
const float PI = 3.141592653589793;
// Mapbox's globe is a sphere of this radius in its own units; one metre is GLOBE_R / EARTH_R.
const float GLOBE_R = 8192.0 / (2.0 * PI);
const float EARTH_R = 6371008.8;
uniform mat4 u_rtc;      // flat map: camera matrix * translate(reference point)
uniform mat4 u_merc;     // camera matrix (absolute mercator)
uniform mat4 u_globe;    // camera matrix * globe-to-mercator
uniform float u_t;       // -1: flat map. Otherwise globe, blending toward the flat map as it nears 1.
uniform vec2 u_ref;
uniform vec2 u_center;
uniform float u_ppm;
uniform float u_night;
in vec3 a_pos;
in vec3 a_nrm;
in float a_part;
in vec4 i_a;
in vec4 i_b;
in vec3 i_c1;
in vec3 i_c2;
in vec3 i_c3;
out vec4 v_color;

void main() {
  float ch = cos(i_a.w), sh = sin(i_a.w);
  vec3 l = vec3(a_pos.x * i_b.x, a_pos.y * i_b.y, a_pos.z * i_b.x + a_pos.y * i_b.z);
  vec2 en = vec2(l.x * ch + l.y * sh, -l.x * sh + l.y * ch);
  vec2 d = vec2(en.x, -en.y) * i_b.w;
  float elev = i_a.z + l.z;
  if (u_t < 0.0) {
    gl_Position = u_rtc * vec4(i_a.xy + d, elev * i_b.w, 1.0);
  } else {
    vec2 m = u_ref + i_a.xy;
    float lon = (m.x * 2.0 - 1.0) * PI;
    float lat = 2.0 * atan(exp(PI * (1.0 - 2.0 * m.y))) - PI * 0.5;
    float cl = cos(lat), sl = sin(lat), co = cos(lon), so = sin(lon);
    vec3 up = vec3(cl * so, -sl, cl * co);
    vec3 east = vec3(co, 0.0, -so);
    vec3 north = vec3(-sl * so, -cl, -sl * co);
    float mu = GLOBE_R / EARTH_R;
    vec4 g = u_globe * vec4(up * (GLOBE_R + elev * mu) + (east * en.x + north * en.y) * mu, 1.0);
    if (u_t > 0.0) {
      vec4 f = vec4(m + d, elev * i_b.w, 1.0);
      f.xy = (f.xy - u_center) * u_ppm + u_center;
      f.z *= u_ppm;
      f = u_merc * f;
      g = mix(g / g.w, f / f.w, u_t);
    }
    gl_Position = g;
  }

  vec3 n = vec3(a_nrm.x * ch + a_nrm.y * sh, -a_nrm.x * sh + a_nrm.y * ch, a_nrm.z);
  // A fixed "studio" light keeps the miniature look readable at any hour.
  float diff = max(dot(n, normalize(vec3(-0.45, 0.35, 0.82))), 0.0);
  float light = mix(0.5 + 0.6 * diff, 0.3 + 0.32 * diff, u_night);

  int part = int(a_part + 0.5);
  vec3 c = i_c1;
  float a = 1.0;
  float glow = 0.0;
  if (part == 1) c = i_c2;
  else if (part == 2) c = vec3(0.13, 0.14, 0.16);
  else if (part == 3) c = vec3(0.84, 0.85, 0.87);
  else if (part == 4) { c = mix(vec3(0.2, 0.3, 0.42), vec3(1.0, 0.82, 0.45), u_night); glow = u_night; }
  else if (part == 5) c = vec3(0.86, 0.68, 0.55);
  else if (part == 6) { c = vec3(0.0); a = 0.2; light = 1.0; }
  else if (part == 7) { c = i_c2; a = 0.85; light = 1.0; }
  else if (part == 8) c = i_c3;
  vec3 rgb = c * mix(light, 1.0, glow);
  v_color = vec4(rgb * a, a);
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 fragColor;
void main() { fragColor = v_color; }`;

const ATTRS = ['a_pos', 'a_nrm', 'a_part', 'i_a', 'i_b', 'i_c1', 'i_c2', 'i_c3'];
const UNIFORMS = ['u_rtc', 'u_merc', 'u_globe', 'u_t', 'u_ref', 'u_center', 'u_ppm', 'u_night'];

/** out = a * b for column-major 4x4 matrices. */
function mul(a: ArrayLike<number>, b: ArrayLike<number>, out: Float64Array): void {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
}

export class InstancedLayer implements CustomLayerInterface {
  readonly id = 'tinyfoot-3d';
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;

  readonly scene: Scene;
  /** Frames per second ceiling; lowered on weak devices to save battery. */
  maxFps = 60;
  /** Smoothed frame time in ms, used for adaptive quality. */
  frameMs = 16;

  private map!: MbMap;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private uni: Record<string, WebGLUniformLocation | null> = {};
  private vaos: WebGLVertexArrayObject[] = [];
  private instBufs: WebGLBuffer[] = [];
  private last = 0;
  private timer = 0;
  private rtc = new Float64Array(16);
  private globe = new Float64Array(16);
  private f32 = new Float32Array(16);
  private isGlobe = true;
  private listening = false;

  constructor(
    private readonly meshes: MeshDef[],
    private readonly onFrame: (scene: Scene, frame: FrameInfo) => void,
    private readonly nightAt: (lat: number, lon: number, now: number) => number,
  ) {
    this.scene = new Scene(meshes.length);
  }

  onAdd(map: MbMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    // A style swap removes and re-adds the layer on the same GL context; build GPU resources once.
    if (this.gl !== gl) this.setup(gl);
    if (this.listening) return;
    this.listening = true;
    map.on('webglcontextrestored', () => {
      if (this.gl) this.setup(this.gl);
      map.triggerRepaint();
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) map.triggerRepaint();
    });
  }

  /** Registers a mesh built after start-up (aircraft types are generated on first sight). Returns its index. */
  addMesh(mesh: MeshDef): number {
    this.meshes.push(mesh);
    this.scene.grow();
    if (this.gl) this.upload(this.gl, mesh);
    return this.meshes.length - 1;
  }

  private setup(gl: WebGL2RenderingContext): void {
    this.gl = gl;
    this.vaos = [];
    this.instBufs = [];
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error('[tinyfoot] shader', gl.getShaderInfoLog(s));
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
    ATTRS.forEach((name, i) => gl.bindAttribLocation(program, i, name));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) console.error('[tinyfoot] link', gl.getProgramInfoLog(program));
    this.program = program;
    for (const name of UNIFORMS) this.uni[name] = gl.getUniformLocation(program, name);
    for (const mesh of this.meshes) this.upload(gl, mesh);
  }

  private upload(gl: WebGL2RenderingContext, mesh: MeshDef): void {
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vb = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 28, 24);
    const ib = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, ib);
    const layout: [number, number, number][] = [[3, 4, 0], [4, 4, 16], [5, 3, 32], [6, 3, 44], [7, 3, 56]];
    for (const [loc, size, off] of layout) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE * 4, off);
      gl.vertexAttribDivisor(loc, 1);
    }
    this.vaos.push(vao);
    this.instBufs.push(ib);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  render(
    gl: WebGL2RenderingContext,
    matrix: number[],
    projection?: unknown,
    globeToMerc?: number[],
    transition?: number,
    centerInMercator?: number[],
    pixelsPerMeterRatio?: number,
  ): void {
    const map = this.map;
    const nowPerf = performance.now();
    const rawDt = this.last ? nowPerf - this.last : 16;
    this.last = nowPerf;
    this.frameMs += (Math.min(rawDt, 250) - this.frameMs) * 0.05;

    const center = map.getCenter();
    const zoom = map.getZoom();
    // The globe-only arguments are passed only while the map is still (partly) a globe.
    this.isGlobe = Boolean(projection && globeToMerc && (transition ?? 1) < 1);
    const now = Date.now();
    const frame: FrameInfo = {
      now,
      dt: Math.min(rawDt, 100) / 1000,
      zoom,
      mpp: (EARTH_C * Math.cos(center.lat * DEG)) / (512 * 2 ** zoom),
      lat: center.lat,
      lon: center.lng,
      globe: this.isGlobe,
      night: this.nightAt(center.lat, center.lng, now),
    };

    const scene = this.scene;
    scene.begin(mercX(center.lng), mercY(center.lat));
    this.onFrame(scene, frame);

    // Camera-relative matrix: camera * translate(ref), computed in doubles.
    const r = this.rtc;
    for (let i = 0; i < 16; i++) r[i] = matrix[i];
    for (let i = 0; i < 4; i++) r[12 + i] = matrix[i] * scene.refX + matrix[4 + i] * scene.refY + matrix[12 + i];

    if (this.program) {
      const u = this.uni;
      gl.useProgram(this.program);
      this.f32.set(r);
      gl.uniformMatrix4fv(u.u_rtc, false, this.f32);
      this.f32.set(matrix);
      gl.uniformMatrix4fv(u.u_merc, false, this.f32);
      if (this.isGlobe && globeToMerc) {
        mul(matrix, globeToMerc, this.globe);
        this.f32.set(this.globe);
        gl.uniformMatrix4fv(u.u_globe, false, this.f32);
        gl.uniform1f(u.u_t, transition ?? 0);
        gl.uniform2f(u.u_center, centerInMercator?.[0] ?? scene.refX, centerInMercator?.[1] ?? scene.refY);
        gl.uniform1f(u.u_ppm, pixelsPerMeterRatio ?? 1);
      } else {
        gl.uniform1f(u.u_t, -1);
      }
      gl.uniform2f(u.u_ref, scene.refX, scene.refY);
      gl.uniform1f(u.u_night, frame.night);

      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      for (const pass of [true, false]) {
        gl.depthMask(!pass);
        for (let i = 0; i < this.meshes.length; i++) {
          const count = scene.counts[i];
          if (!count || Boolean(this.meshes[i].translucent) !== pass) continue;
          gl.bindVertexArray(this.vaos[i]);
          gl.bindBuffer(gl.ARRAY_BUFFER, this.instBufs[i]);
          gl.bufferData(gl.ARRAY_BUFFER, scene.bufs[i].subarray(0, count * STRIDE), gl.DYNAMIC_DRAW);
          gl.drawArraysInstanced(gl.TRIANGLES, 0, this.meshes[i].vertexCount, count);
        }
      }
      gl.depthMask(true);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
    this.schedule();
  }

  /** Keeps the animation running, capped at `maxFps`, and paused in background tabs. */
  private schedule(): void {
    if (document.hidden) return;
    if (this.maxFps >= 60) {
      this.map.triggerRepaint();
      return;
    }
    if (this.timer) return;
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.map.triggerRepaint();
    }, 1000 / this.maxFps);
  }

  /** Finds the closest clickable thing to a point given in CSS pixels. */
  pick(x: number, y: number): unknown {
    const scene = this.scene;
    const canvas = this.map.getCanvas();
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const r = this.rtc;
    let best: unknown = null;
    let bestScore = Infinity;
    for (let i = 0; i < scene.pickCount; i++) {
      const [mx, my, elev, radius, ref] = scene.pickEntry(i);
      let sx: number;
      let sy: number;
      if (this.isGlobe) {
        // On the globe, fall back to the ground point under the object.
        const lng = mx * 360 - 180;
        const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) / DEG;
        const c = this.map.getCenter();
        const cosd = Math.sin(lat * DEG) * Math.sin(c.lat * DEG) + Math.cos(lat * DEG) * Math.cos(c.lat * DEG) * Math.cos((lng - c.lng) * DEG);
        if (cosd < 0.15) continue; // far side
        const p = this.map.project([lng, lat]);
        sx = p.x;
        sy = p.y;
      } else {
        let rx = mx - scene.refX;
        if (rx > 0.5) rx -= 1;
        else if (rx < -0.5) rx += 1;
        const ry = my - scene.refY;
        const ez = elev * mercScale(my);
        const cw = r[3] * rx + r[7] * ry + r[11] * ez + r[15];
        if (cw <= 0) continue;
        sx = ((r[0] * rx + r[4] * ry + r[8] * ez + r[12]) / cw * 0.5 + 0.5) * w;
        sy = (0.5 - (r[1] * rx + r[5] * ry + r[9] * ez + r[13]) / cw * 0.5) * h;
      }
      const dist = Math.hypot(sx - x, sy - y);
      if (dist <= radius && dist / radius < bestScore) {
        bestScore = dist / radius;
        best = ref;
      }
    }
    return best;
  }
}
