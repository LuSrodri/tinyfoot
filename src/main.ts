import './style.css';
import { detectTier, getJson, tierFor, type Ctx, type Layer, type Quality, type Selection } from './core';
import { AircraftLayer } from './data/aircraft';
import { setMeshRegistrar } from './data/aircraftTypes';
import { PlacesLayer } from './data/places';
import { SatelliteLayer } from './data/satellites';
import { ShipLayer } from './data/ships';
import { TransitLayer } from './data/transit';
import { WaterLayer } from './data/water';
import { WeatherWatch } from './data/weather';
import { loadMeshCache } from './gl/meshcache';
import { InstancedLayer, type FrameInfo, type Scene } from './gl/instanced';
import { buildMeshes } from './gl/meshes';
import { Minimap } from './world/minimap';
import { Popup } from './world/popup';
import { MODES, World, type Mode } from './world/world';
import { PeopleLayer, RoadNet, TrafficLayer } from './sim/traffic';
import { solarHour, sunElevation } from './util/geo';
import { lang, t, type Key } from './util/i18n';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(`tinyfoot:${key}`);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(`tinyfoot:${key}`, JSON.stringify(value));
    } catch {
      /* private mode */
    }
  },
};

const ICONS: Record<string, string> = {
  aircraft: '<path d="M21 15.5v-1.8l-7.5-4.7V4.2a1.5 1.5 0 0 0-3 0V9L3 13.7v1.8l7.5-2.3v4.6l-2 1.5V20.5l3.5-1 3.5 1v-1.2l-2-1.5v-4.6z"/>',
  satellites: '<path d="m13.4 7.8 2.8 2.8-3 3-2.8-2.8zM4 4.6 6.6 2l4 4L8 8.6zm11.4 11.4 2.6-2.6 4 4-2.6 2.6zM5 13a6 6 0 0 0 6 6v-1.8A4.2 4.2 0 0 1 6.8 13zm-3 0a9 9 0 0 0 9 9v-1.8A7.2 7.2 0 0 1 3.8 13z"/>',
  ships: '<path d="M4 15.5 2.6 11 6 9.9V6h4V3.5h4V6h4v3.9l3.4 1.1-1.4 4.5c-.9 0-1.8.5-2.7 1.2-.9-.7-1.8-1.2-2.7-1.2s-1.8.5-2.6 1.2c-.9-.7-1.8-1.2-2.7-1.2s-1.8.5-2.6 1.2c-.9-.7-1.8-1.2-2.7-1.2zM8 8v1.3l4-1.3 4 1.3V8zM2 20c1.2 0 2.1-.5 3-1.2.9.7 1.8 1.2 3 1.2s2.100-.5 3-1.2c.9.7 1.800 1.2 3 1.2s2.100-.5 3-1.2c.9.7 1.800 1.2 3 1.2v-1.800c-1 0-1.800-.5-3-1.500-1.200 1-2 1.500-3 1.500s-1.800-.5-3-1.500c-1.200 1-2 1.500-3 1.500s-1.800-.5-3-1.500c-1.200 1-2 1.500-3 1.500z"/>',
  transit: '<path d="M6 3h12a2 2 0 0 1 2 2v11a2.500 2.500 0 0 1-1.500 2.300V20a1 1 0 0 1-2 0v-1.500h-9V20a1 1 0 0 1-2 0v-1.700A2.500 2.500 0 0 1 4 16V5a2 2 0 0 1 2-2zm0 3v5h12V6zm1.500 7.500a1.300 1.300 0 1 0 0 2.600 1.300 1.300 0 0 0 0-2.600zm9 0a1.300 1.300 0 1 0 0 2.600 1.300 1.300 0 0 0 0-2.600z"/>',
  traffic: '<path d="M6.200 5.500A2 2 0 0 1 8.100 4h7.800a2 2 0 0 1 1.900 1.500L19 10l1.300.900c.4.300.7.800.7 1.300V17a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H6v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4.800c0-.500.300-1 .700-1.300L5 10zM7.100 10h9.800l-.900-3.500a.5.5 0 0 0-.500-.400H8.500a.5.5 0 0 0-.500.400zM6.500 12a1.200 1.200 0 1 0 0 2.400 1.200 1.200 0 0 0 0-2.400zm11 0a1.200 1.200 0 1 0 0 2.400 1.200 1.200 0 0 0 0-2.400z"/>',
  people: '<path d="M12 2.500a2.200 2.200 0 1 1 0 4.400 2.200 2.200 0 0 1 0-4.400zM9.800 8h4.400a2 2 0 0 1 2 1.800l.5 5a1 1 0 0 1-2 .200L14.500 13v8a1 1 0 0 1-2 0v-5h-1v5a1 1 0 0 1-2 0v-8l-.200 2a1 1 0 0 1-2-.200l.500-5a2 2 0 0 1 2-1.800z"/>',
  water: '<path d="M12 2.500c3.200 3.900 6 7.400 6 11a6 6 0 0 1-12 0c0-3.600 2.800-7.100 6-11zm-3.500 11.800a3.500 3.500 0 0 0 3.500 3.200v-1.500a2 2 0 0 1-2-1.700z"/>',
  places: '<path d="M4 4h16l1 5a3 3 0 0 1-1.500 2.600V19a1 1 0 0 1-1 1H5.500a1 1 0 0 1-1-1v-7.400A3 3 0 0 1 3 9zm2.500 8v6H11v-4h3v4h3.500v-6a3 3 0 0 1-2-.800 3 3 0 0 1-3.500.300 3 3 0 0 1-3.500-.300 3 3 0 0 1-2 .800z"/>',
};

const LAYER_LABEL: Record<string, Key> = {
  aircraft: 'aircraft',
  satellites: 'satellites',
  ships: 'ships',
  transit: 'transit',
  traffic: 'traffic',
  people: 'people',
  places: 'places',
  water: 'water',
};

interface Spot {
  label: string;
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
  action?: 'iss';
}

const SPOTS: Spot[] = [
  { label: 'Copacabana', center: [-43.1786, -22.9671], zoom: 18.2, pitch: 48, bearing: 150 },
  { label: 'Cristo Redentor', center: [-43.2105, -22.9519], zoom: 17.6, pitch: 50, bearing: 150 },
  { label: 'Av. Paulista', center: [-46.6555, -23.5614], zoom: 17.6, pitch: 48, bearing: 40 },
  { label: 'GRU ✈', center: [-46.4731, -23.4322], zoom: 15.8, pitch: 48, bearing: 60 },
  { label: 'Manhattan', center: [-74.0092, 40.7095], zoom: 17.2, pitch: 48, bearing: 28 },
  { label: 'Paris', center: [2.2945, 48.8584], zoom: 17.4, pitch: 48, bearing: -40 },
  { label: 'Helsinki', center: [24.9458, 60.1652], zoom: 16.4, pitch: 48, bearing: 20 },
  { label: 'Boston', center: [-71.0603, 42.3554], zoom: 16.6, pitch: 48, bearing: -15 },
  { label: 'ISS 🛰', center: [0, 0], zoom: 2.6, pitch: 0, bearing: 0, action: 'iss' },
];

async function main(): Promise<void> {
  document.documentElement.lang = lang === 'pt' ? 'pt-BR' : 'en';
  const tier = detectTier();
  const savedQuality = store.get<Quality | null>('quality', null);
  if (savedQuality) Object.assign(tier, tierFor(savedQuality));
  let mode = store.get<Mode>('mode', 'mini');
  if (!MODES.includes(mode)) mode = 'mini';

  await loadMeshCache();
  const base = await World.create('map', tier, mode);
  const weather = new WeatherWatch(base);
  const map = base;
  // Camera position lives in the address, so a view can be shared and survives reloads.
  const fromHash = (): boolean => {
    const p = location.hash.slice(1).split('/').map(Number);
    if (p.length < 3 || p.some((n) => !Number.isFinite(n))) return false;
    map.jumpTo({ zoom: p[0], center: [p[2], p[1]], bearing: p[3] ?? 0, pitch: p[4] ?? 48 });
    return true;
  };
  if (!fromHash()) map.jumpTo({ center: SPOTS[0].center, zoom: SPOTS[0].zoom, pitch: SPOTS[0].pitch, bearing: SPOTS[0].bearing });
  map.on('moveend', () => {
    const c = map.getCenter();
    const heading = ((base.widget.scene.camera.heading * 180) / Math.PI + 360) % 360;
    history.replaceState(null, '', `#${map.getZoom().toFixed(2)}/${c.lat.toFixed(5)}/${c.lng.toFixed(5)}/${heading.toFixed(0)}/${map.getPitch().toFixed(0)}${''}`.replace(/^#/, `${location.pathname}${location.search}#`));
  });
  const minimapEl = $('minimap');
  const minimap = tier.quality === 'low' ? null : new Minimap(minimapEl, base);
  if (!minimap) minimapEl.hidden = true;

  const ctx: Ctx = {
    map,
    tier,
    lang,
    selection: null,
    caps: { ais: false, sptrans: false },
    elevAt: (lat, lon) => base.elevAt(lat, lon),
    surfaceAt: (lat, lon) => base.surfaceAt(lat, lon),
  };
  void getJson<{ ais: boolean; sptrans: boolean }>('/api/health').then((h) => {
    if (h) ctx.caps = { ais: Boolean(h.ais), sptrans: Boolean(h.sptrans) };
  });

  const net = new RoadNet(map);
  base.setProbeSource(() => net.probes());
  const aircraft = new AircraftLayer(ctx);
  const satellites = new SatelliteLayer(ctx);
  const ships = new ShipLayer(ctx);
  const transit = new TransitLayer(ctx);
  const traffic = new TrafficLayer(ctx, net);
  const people = new PeopleLayer(ctx, net);
  const places = new PlacesLayer(ctx);
  const water = new WaterLayer(ctx);
  const layers: Layer[] = [aircraft, satellites, ships, transit, traffic, people, places, water];
  const pickers = [aircraft, satellites, ships, transit];

  const enabled = store.get<Record<string, boolean>>('layers', {});
  for (const l of layers) if (enabled[l.id] === false) l.enabled = false;

  // ------------------------------------------------------------ selection
  let following = false;
  /** Until this time a programmatic camera move is in progress; do not re-centre over it. */
  let easing = 0;
  const card = $('card');
  const select = (sel: Selection | null): void => {
    ctx.selection = sel;
    following = false;
    for (const l of layers) l.onSelect?.(sel);
    card.hidden = !sel;
    document.body.classList.toggle('has-card', Boolean(sel));
    renderCard();
  };
  const setFollow = (on: boolean): void => {
    following = on && Boolean(ctx.selection);
    const btn = $('card-follow');
    btn.setAttribute('aria-pressed', String(following));
    btn.textContent = following ? t('following') : t('follow');
    if (following && ctx.selection) {
      const p = ctx.selection.position();
      const z = ctx.selection.zoom;
      easing = Date.now() + 950;
      if (p) map.easeTo({ center: [p.lon, p.lat], zoom: z !== undefined && Math.abs(map.getZoom() - z) > 3 ? z : map.getZoom(), duration: 900 });
    }
  };
  function renderCard(): void {
    const sel = ctx.selection;
    if (!sel) return;
    if (!sel.position()) {
      select(null);
      return;
    }
    $('card-title').textContent = sel.title();
    $('card-sub').textContent = sel.subtitle();
    $('card-badge').textContent = sel.badge ?? '';
    const rows = $('card-rows');
    rows.replaceChildren(
      ...sel.rows().flatMap((r) => {
        const dt = document.createElement('dt');
        dt.textContent = r.label;
        const dd = document.createElement('dd');
        dd.textContent = r.value;
        return [dt, dd];
      }),
    );
    const btn = $('card-follow');
    btn.setAttribute('aria-pressed', String(following));
    btn.textContent = following ? t('following') : t('follow');
  }
  $('card-close').addEventListener('click', () => select(null));
  $('card-follow').addEventListener('click', () => setFollow(!following));
  map.on('dragstart', () => {
    if (following) setFollow(false);
  });

  // ------------------------------------------------------------- 3D layer
  // The same night as the city: the real sun where you look, or always in Night mode.
  const nightAt = (): number => base.nightLevel;
  const layer3d = new InstancedLayer(
    buildMeshes(),
    (scene: Scene, frame: FrameInfo) => {
      for (const l of layers) {
        l.tick(frame);
        l.emit(scene, frame);
      }
      if (following && ctx.selection && frame.now > easing) {
        const p = ctx.selection.position();
        if (p) map.jumpTo({ center: [p.lon, p.lat] });
      }
    },
    nightAt,
    () => {
      const v = base.view();
      return { lat: v.lat, lon: v.lng, height: v.h, zoom: v.zoom, mpp: v.mpp, globe: v.globe };
    },
  );
  layer3d.maxFps = tier.maxFps;
  setMeshRegistrar((mesh) => layer3d.addMesh(mesh));
  layer3d.attach(base.widget.scene);
  base.exclude = [layer3d];

  const popup = new Popup(base);
  map.on('click', (e) => {
    const ref = layer3d.pick(e.point.x, e.point.y);
    if (ref) {
      for (const p of pickers) {
        const sel = p.selectionFor(ref);
        if (sel) {
          popup.remove();
          select(sel);
          return;
        }
      }
    }
    const wet = map.getLayer('tf-water') ? map.queryRenderedFeatures([[e.point.x - 8, e.point.y - 8], [e.point.x + 8, e.point.y + 8]], { layers: ['tf-water'] }) : [];
    if (wet.length) {
      const p = wet[0].properties as { name: string; detail: string; source: string; level: string };
      const el = document.createElement('div');
      const h = document.createElement('h3');
      h.textContent = p.name;
      const st = document.createElement('div');
      st.className = `st ${p.level === 'flood' ? 'closed' : p.level === 'high' ? 'unknown' : 'open'}`;
      st.textContent = p.detail;
      const src = document.createElement('div');
      src.className = 'kind';
      src.textContent = p.source;
      el.append(h, st, src);
      popup.setLngLat(e.lngLat).setDOMContent(el).addTo();
      return;
    }
    const hits = map.getLayer('tf-places') ? map.queryRenderedFeatures([[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]], { layers: ['tf-places'] }) : [];
    if (hits.length) {
      const p = hits[0].properties as { name: string; kind: string; state: 'open' | 'closed' | 'unknown'; next: string; hours: string };
      const el = document.createElement('div');
      const h = document.createElement('h3');
      h.textContent = p.name || p.kind || '—';
      const kind = document.createElement('div');
      kind.className = 'kind';
      kind.textContent = p.name ? p.kind : '';
      const st = document.createElement('div');
      st.className = `st ${p.state}`;
      st.textContent = `${t(p.state)}${p.next ? ` · ${p.next}` : ''}`;
      const hours = document.createElement('div');
      hours.className = 'hours';
      hours.textContent = p.hours;
      el.append(h, kind, st, hours);
      const g = hits[0].geometry;
      popup.setLngLat(g.type === 'Point' ? (g.coordinates as [number, number]) : e.lngLat).setDOMContent(el).addTo();
      return;
    }
    if (ctx.selection) select(null);
  });
  let hoverAt = 0;
  map.on('mousemove', (e) => {
    const now = performance.now();
    if (now - hoverAt < 90) return;
    hoverAt = now;
    map.getCanvas().style.cursor = layer3d.pick(e.point.x, e.point.y) ? 'pointer' : '';
  });

  // ---------------------------------------------------------------- modes
  const modes = $('modes');
  const modeLabel: Record<Mode, Key> = { mini: 'modeMini', photo: 'modeMap', night: 'modeNight' };
  const applyModeClass = (): void => {
    document.body.classList.toggle('mini', base.mode === 'mini');
    document.body.classList.toggle('lite', tier.quality === 'low');
    document.body.classList.remove('blur-1', 'blur-2', 'blur-3');
    document.body.classList.add(`blur-${tier.blurLayers}`);
    for (const b of modes.querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.mode === base.mode));
  };
  for (const m of MODES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.role = 'tab';
    b.dataset.mode = m;
    b.textContent = t(modeLabel[m]);
    b.addEventListener('click', () => {
      void base.setMode(m).then(() => {
        base.updateLight(Date.now());
        store.set('mode', m);
        applyModeClass();
        updateBlur();
        places.refresh();
      });
    });
    modes.append(b);
  }

  // Tilt-shift and the miniature colour are post-processing passes in the 3D world itself.
  const updateBlur = (): void => undefined;
  applyModeClass();
  updateBlur();

  // No interface by default. G shows or hides it, M steps through the view modes.
  if (store.get('gui', false) || new URLSearchParams(location.search).has('gui')) document.body.classList.add('gui');
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'g' || e.key === 'G') store.set('gui', document.body.classList.toggle('gui'));
    if (e.key === 'm' || e.key === 'M') {
      const next = MODES[(MODES.indexOf(base.mode) + 1) % MODES.length];
      modes.querySelector<HTMLButtonElement>(`button[data-mode="${next}"]`)?.click();
    }
  });

  // --------------------------------------------------------------- layers
  const panel = $('layers');
  const rows = new Map<string, { btn: HTMLButtonElement; count: HTMLElement; hint: HTMLElement }>();
  for (const l of layers) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'layer';
    btn.setAttribute('aria-pressed', String(l.enabled));
    const estimated = l.id === 'traffic' || l.id === 'people';
    btn.innerHTML = `<span class="ico"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[l.id]}</svg></span><span class="name"><span class="dot"></span><span class="label"></span>${estimated ? '<span class="tag est"></span>' : ''}</span><span class="count"></span><span class="hint"></span>`;
    btn.querySelector('.label')!.textContent = t(LAYER_LABEL[l.id]);
    const tag = btn.querySelector('.tag');
    if (tag) tag.textContent = t('estimate');
    btn.addEventListener('click', () => {
      l.enabled = !l.enabled;
      btn.setAttribute('aria-pressed', String(l.enabled));
      enabled[l.id] = l.enabled;
      store.set('layers', enabled);
      if (!l.enabled && ctx.selection?.layer === l.id) select(null);
      if (l === places) places.refresh();
      refreshPanel();
    });
    panel.append(btn);
    rows.set(l.id, { btn, count: btn.querySelector('.count')!, hint: btn.querySelector('.hint')! });
  }
  function refreshPanel(): void {
    for (const l of layers) {
      const r = rows.get(l.id)!;
      r.btn.dataset.state = l.enabled ? l.state : 'idle';
      r.count.textContent = l.enabled && l.count ? l.count.toLocaleString() : '';
      r.hint.textContent = l.enabled ? l.hint : '';
      r.btn.title = l.enabled ? l.hint : '';
    }
  }

  // ---------------------------------------------------------------- explore
  const explore = $('explore');
  for (const s of SPOTS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = s.label;
    b.addEventListener('click', () => {
      if (s.action === 'iss') {
        const iss = satellites.find('ISS (ZARYA)') ?? satellites.find('ISS');
        const sel = iss ? satellites.selectionFor(iss) : null;
        if (sel) {
          select(sel);
          setFollow(true);
          easing = Date.now() + 1250;
          map.easeTo({ zoom: 3.2, pitch: 0, duration: 1200 });
        }
        return;
      }
      select(null);
      map.flyTo({ center: s.center, zoom: s.zoom, pitch: s.pitch, bearing: s.bearing, speed: 1.4, curve: 1.5, essential: true });
    });
    explore.append(b);
  }

  // ----------------------------------------------------------------- search
  const q = $<HTMLInputElement>('q');
  const results = $<HTMLUListElement>('results');
  q.placeholder = t('search');
  q.setAttribute('aria-label', t('search'));
  let searchSeq = 0;
  let searchTimer = 0;
  type Hit = Awaited<ReturnType<World['search']>>[number];
  const go = (hit: Hit): void => {
    results.hidden = true;
    q.blur();
    const ext = hit.extent;
    if (ext && Math.abs(ext[2] - ext[0]) > 0.01) {
      map.fitBounds([[ext[0], ext[3]], [ext[2], ext[1]]], { pitch: 48, maxZoom: 18, duration: 2200 });
    } else {
      map.flyTo({ center: hit.center, zoom: 18, pitch: 48, duration: 2200 });
    }
  };
  const runSearch = async (): Promise<void> => {
    const text = q.value.trim();
    const seq = ++searchSeq;
    if (text.length < 3) {
      results.hidden = true;
      return;
    }
    let hits: Hit[] = [];
    try {
      hits = await base.search(text);
    } catch {
      hits = [];
    }
    if (seq !== searchSeq) return;
    results.replaceChildren(
      ...hits.map((hit) => {
        const li = document.createElement('li');
        li.role = 'option';
        li.textContent = hit.name;
        const small = document.createElement('small');
        small.textContent = hit.detail;
        li.append(small);
        li.addEventListener('click', () => go(hit));
        return li;
      }),
    );
    results.hidden = hits.length === 0;
    (results as unknown as { first?: Hit }).first = hits[0];
  };
  q.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void runSearch(), 320);
  });
  $('search').addEventListener('submit', (e) => {
    e.preventDefault();
    const first = (results as unknown as { first?: Hit }).first;
    if (first && !results.hidden) go(first);
    else void runSearch();
  });
  document.addEventListener('click', (e) => {
    if (!$('search').contains(e.target as Node)) results.hidden = true;
  });

  // ------------------------------------------------------------------ about
  const about = $<HTMLDialogElement>('about');
  $('about-title').textContent = t('about');
  $('about-text').textContent = t('aboutText');
  $('about-close').textContent = 'OK';
  $('quality-label').textContent = t('quality');
  const qualitySel = $<HTMLSelectElement>('quality');
  for (const [value, key] of [['low', 'qLow'], ['medium', 'qMedium'], ['high', 'qHigh']] as [Quality, Key][]) {
    qualitySel.add(new Option(t(key), value, false, tier.quality === value));
  }
  const setQuality = (quality: Quality, persist: boolean): void => {
    Object.assign(tier, tierFor(quality));
    layer3d.maxFps = tier.maxFps;
  setMeshRegistrar((mesh) => layer3d.addMesh(mesh));
    base.applyTier();
    applyModeClass();
    qualitySel.value = quality;
    if (persist) store.set('quality', quality);
  };
  qualitySel.addEventListener('change', () => setQuality(qualitySel.value as Quality, true));
  $('about-btn').setAttribute('aria-label', t('about'));
  $('about-btn').addEventListener('click', () => about.showModal());

  // ------------------------------------------------------------- heartbeat
  const clock = $('clock');
  let slowSince = 0;
  window.setInterval(() => {
    refreshPanel();
    renderCard();
    const now = Date.now();
    base.updateLight(now);
    weather.tick(now);
    minimap?.update();
    const c = map.getCenter();
    const hour = solarHour(c.lng, now);
    const hh = String(Math.floor(hour)).padStart(2, '0');
    const mm = String(Math.floor((hour % 1) * 60)).padStart(2, '0');
    const day = sunElevation(c.lat, c.lng, now) > -1;
    clock.innerHTML = `${day ? '☀' : '☾'} <b>≈ ${hh}:${mm}</b> ${t('localTime')}`;

    // If the device cannot keep up, step the quality down by itself (never back up, to avoid flapping).
    // Only while the window is focused: browsers throttle unfocused and covered windows, which is not the device being slow.
    const explicit = savedQuality !== null || new URLSearchParams(location.search).has('q');
    const slow = layer3d.frameMs > (tier.maxFps >= 60 ? 42 : 70) && layer3d.frameMs < 130;
    if (!explicit && !document.hidden && document.hasFocus() && slow) {
      slowSince ||= now;
      if (now - slowSince > 6000 && tier.quality !== 'low') {
        setQuality(tier.quality === 'high' ? 'medium' : 'low', false);
        slowSince = 0;
      }
    } else {
      slowSince = 0;
    }
  }, 500);
  refreshPanel();
  // Handy for poking around from the browser console.
  (window as unknown as { tinyfoot: unknown }).tinyfoot = { map, layers, layer3d, ctx, base, weather };
}

void main().catch((err) => {
  console.error(err);
  const el = document.createElement('p');
  el.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;margin:0;padding:24px;text-align:center;font:16px system-ui;color:#e8edf2';
  el.textContent = lang === 'pt' ? 'Não foi possível iniciar o mapa. Seu navegador precisa de WebGL 2.' : 'Could not start the map. Your browser needs WebGL 2.';
  document.body.append(el);
});
