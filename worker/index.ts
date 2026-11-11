// tinyfoot edge API.
// A thin, caching pass-through in front of open real-time feeds. It does no
// parsing on purpose (bytes in, bytes out) so that it stays within the free
// Workers CPU budget; the browser decodes everything.

import { TRANSIT_FEEDS, TLE_GROUPS } from '../shared/feeds';

interface Env {
  ASSETS: Fetcher;
  /** Optional: free key from aisstream.io, enables world-wide ships. */
  AISSTREAM_KEY?: string;
  /** Optional: free token from sptrans.com.br/desenvolvedores, enables São Paulo buses. */
  SPTRANS_TOKEN?: string;
}

const UA = 'tinyfoot/0.1 (+https://github.com/LuSrodri/tinyfoot)';
const CACHE_ORIGIN = 'https://cache.tinyfoot.internal';

interface Upstream {
  /** One or more URLs tried in order. */
  urls: string[];
  ttl: number;
  init?: RequestInit;
  /** Content type to force on the response. */
  type?: string;
  /** Upstream timeout in ms (default 9000). */
  timeout?: number;
  /** Also cache "not found" style answers (4xx) as an empty body. */
  cacheMiss?: boolean;
}

function json(data: unknown, status = 200, maxAge = 0): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
    },
  });
}

const num = (v: string | null, min: number, max: number): number | null => {
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

async function fetchUpstream(up: Upstream): Promise<Response | null> {
  for (const url of up.urls) {
    try {
      const headers = new Headers(up.init?.headers);
      if (!headers.has('user-agent')) headers.set('user-agent', UA);
      const res = await fetch(url, { ...up.init, headers, signal: AbortSignal.timeout(up.timeout ?? 9000) });
      if (res.ok) return res;
      if (up.cacheMiss && res.status >= 400 && res.status < 500 && res.status !== 429) {
        return new Response('', { status: 200 });
      }
    } catch {
      // try the next mirror
    }
  }
  return null;
}

/** Serve from the edge cache while fresh; refresh from upstream; fall back to stale on failure. */
async function cached(key: string, up: Upstream, ctx: ExecutionContext): Promise<Response> {
  const cache = caches.default;
  const cacheKey = new Request(`${CACHE_ORIGIN}/${key}`);
  const hit = await cache.match(cacheKey);
  const now = Date.now();
  if (hit) {
    const ts = Number(hit.headers.get('x-ts') ?? 0);
    if (now - ts < up.ttl * 1000) return withClientHeaders(hit, up.ttl, 'hit');
  }
  const fresh = await fetchUpstream(up);
  if (!fresh) {
    if (hit) return withClientHeaders(hit, Math.min(up.ttl, 10), 'stale');
    return json({ error: 'upstream_unavailable' }, 502);
  }
  const body = await fresh.arrayBuffer();
  const type = up.type ?? fresh.headers.get('content-type') ?? 'application/octet-stream';
  const store = new Response(body, {
    headers: {
      'content-type': type,
      'x-ts': String(now),
      // Keep the entry around well past its freshness window so it can be served stale.
      'cache-control': `public, max-age=${Math.max(up.ttl * 20, 300)}`,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, store.clone()));
  return withClientHeaders(store, up.ttl, 'miss');
}

function withClientHeaders(res: Response, ttl: number, state: string): Response {
  const headers = new Headers(res.headers);
  headers.set('cache-control', `public, max-age=${Math.max(1, Math.floor(ttl / 2))}`);
  headers.set('x-cache', state);
  headers.delete('x-ts');
  return new Response(res.body, { status: 200, headers });
}

// ---------------------------------------------------------------- routes

function aircraft(q: URLSearchParams): [string, Upstream] | null {
  const lat = num(q.get('lat'), -90, 90);
  const lon = num(q.get('lon'), -180, 180);
  if (lat === null || lon === null) return null;
  // Snap so that nearby viewers share one cached upstream call.
  const la = (Math.round(lat * 2) / 2).toFixed(1);
  const lo = (Math.round(lon * 2) / 2).toFixed(1);
  return [
    `aircraft/${la}/${lo}`,
    {
      // Whole-planet views poll many regions at once and can live with slightly older data.
      ttl: q.get('far') ? 12 : 4,
      type: 'application/json',
      urls: [
        `https://api.adsb.lol/v2/point/${la}/${lo}/250`,
        `https://opendata.adsb.fi/api/v2/lat/${la}/lon/${lo}/dist/250`,
      ],
    },
  ];
}

function places(q: URLSearchParams): [string, Upstream] | null {
  // One request per z14 tile, so results are shared and cacheable for a day.
  const x = num(q.get('x'), 0, 16383);
  const y = num(q.get('y'), 0, 16383);
  if (x === null || y === null || !Number.isInteger(x) || !Number.isInteger(y)) return null;
  const n = 2 ** 14;
  const lon = (v: number) => (v / n) * 360 - 180;
  const lat = (v: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * v) / n))) * 180) / Math.PI;
  const bbox = `${lat(y + 1).toFixed(6)},${lon(x).toFixed(6)},${lat(y).toFixed(6)},${lon(x + 1).toFixed(6)}`;
  const query =
    `[out:csv(::type,::id,::lat,::lon,name,opening_hours,amenity,shop,tourism,leisure,office,craft,healthcare;false;"\\t")][timeout:20];` +
    `nw[opening_hours](${bbox});out center qt 4000;`;
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(query)}`,
  };
  return [
    `places/${x}/${y}`,
    {
      ttl: 86400,
      // The public Overpass servers can be slow under load, so try several; the result is cached for a day.
      timeout: 14000,
      type: 'text/tab-separated-values; charset=utf-8',
      init,
      urls: [
        'https://overpass.openstreetmap.fr/api/interpreter',
        'https://overpass-api.de/api/interpreter',
        'https://overpass.private.coffee/api/interpreter',
      ],
    },
  ];
}

/** São Paulo buses: Olho Vivo needs a login round-trip before the positions call. */
async function sptrans(env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.SPTRANS_TOKEN) return json({ error: 'not_configured' }, 404);
  const cache = caches.default;
  const cacheKey = new Request(`${CACHE_ORIGIN}/transit/sptrans`);
  const hit = await cache.match(cacheKey);
  if (hit && Date.now() - Number(hit.headers.get('x-ts') ?? 0) < 20000) return withClientHeaders(hit, 20, 'hit');
  try {
    const base = 'https://api.olhovivo.sptrans.com.br/v2.1';
    const login = await fetch(`${base}/Login/Autenticar?token=${encodeURIComponent(env.SPTRANS_TOKEN)}`, {
      method: 'POST',
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(8000),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    if (!login.ok || !cookie) throw new Error('login');
    const res = await fetch(`${base}/Posicao`, { headers: { cookie, 'user-agent': UA }, signal: AbortSignal.timeout(9000) });
    if (!res.ok) throw new Error('positions');
    const store = new Response(await res.arrayBuffer(), {
      headers: { 'content-type': 'application/json', 'x-ts': String(Date.now()), 'cache-control': 'public, max-age=300' },
    });
    ctx.waitUntil(cache.put(cacheKey, store.clone()));
    return withClientHeaders(store, 20, 'miss');
  } catch {
    if (hit) return withClientHeaders(hit, 10, 'stale');
    return json({ error: 'upstream_unavailable' }, 502);
  }
}

/**
 * World-wide ships through aisstream.io. Their API is a WebSocket stream, so we
 * listen to a bounding box for a few seconds and return what was heard.
 */
async function aisWindow(env: Env, q: URLSearchParams, ctx: ExecutionContext): Promise<Response> {
  if (!env.AISSTREAM_KEY) return json({ error: 'not_configured' }, 404);
  const lat = num(q.get('lat'), -85, 85);
  const lon = num(q.get('lon'), -180, 180);
  if (lat === null || lon === null) return json({ error: 'bad_request' }, 400);
  // 2° cells.
  const la = Math.floor(lat / 2) * 2;
  const lo = Math.floor(lon / 2) * 2;
  const cache = caches.default;
  const cacheKey = new Request(`${CACHE_ORIGIN}/ais/${la}/${lo}`);
  const hit = await cache.match(cacheKey);
  if (hit && Date.now() - Number(hit.headers.get('x-ts') ?? 0) < 45000) return withClientHeaders(hit, 30, 'hit');

  const ships = new Map<number, unknown>();
  try {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
      const done = () => {
        try {
          ws.close();
        } catch {
          /* already closed */
        }
        resolve();
      };
      const timer = setTimeout(done, 5000);
      ws.addEventListener('open', () => {
        ws.send(
          JSON.stringify({
            APIKey: env.AISSTREAM_KEY,
            BoundingBoxes: [[[la, lo], [la + 2, lo + 2]]],
            FilterMessageTypes: ['PositionReport'],
          }),
        );
      });
      ws.addEventListener('message', (ev) => {
        try {
          const text = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
          const m = JSON.parse(text) as {
            MetaData?: { MMSI: number; ShipName?: string; latitude: number; longitude: number };
            Message?: { PositionReport?: { Cog: number; Sog: number; TrueHeading: number } };
          };
          const p = m.Message?.PositionReport;
          if (!m.MetaData || !p) return;
          ships.set(m.MetaData.MMSI, {
            mmsi: m.MetaData.MMSI,
            name: (m.MetaData.ShipName ?? '').trim(),
            lat: m.MetaData.latitude,
            lon: m.MetaData.longitude,
            cog: p.Cog,
            sog: p.Sog,
            hdg: p.TrueHeading,
          });
        } catch {
          /* ignore malformed frames */
        }
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('ws'));
      });
      ws.addEventListener('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  } catch {
    if (hit) return withClientHeaders(hit, 10, 'stale');
    return json({ error: 'upstream_unavailable' }, 502);
  }
  const store = new Response(JSON.stringify({ ships: [...ships.values()] }), {
    headers: { 'content-type': 'application/json', 'x-ts': String(Date.now()), 'cache-control': 'public, max-age=600' },
  });
  ctx.waitUntil(cache.put(cacheKey, store.clone()));
  return withClientHeaders(store, 30, 'miss');
}

async function api(path: string, q: URLSearchParams, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (path === 'health') {
    return json({ ok: true, ais: Boolean(env.AISSTREAM_KEY), sptrans: Boolean(env.SPTRANS_TOKEN) }, 200, 60);
  }

  if (path === 'aircraft') {
    const r = aircraft(q);
    return r ? cached(r[0], r[1], ctx) : json({ error: 'bad_request' }, 400);
  }

  if (path === 'flight/route') {
    const cs = (q.get('cs') ?? '').toUpperCase();
    if (!/^[A-Z0-9]{3,8}$/.test(cs)) return json({ error: 'bad_request' }, 400);
    return cached(`route/${cs}`, { ttl: 21600, type: 'application/json', cacheMiss: true, urls: [`https://api.adsbdb.com/v0/callsign/${cs}`] }, ctx);
  }

  if (path === 'flight/aircraft') {
    const hex = (q.get('hex') ?? '').toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex)) return json({ error: 'bad_request' }, 400);
    return cached(`airframe/${hex}`, { ttl: 86400, type: 'application/json', cacheMiss: true, urls: [`https://api.adsbdb.com/v0/aircraft/${hex}`] }, ctx);
  }

  if (path === 'flight/track') {
    const hex = (q.get('hex') ?? '').toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex)) return json({ error: 'bad_request' }, 400);
    return cached(`track/${hex}`, { ttl: 30, type: 'application/json', cacheMiss: true, urls: [`https://opensky-network.org/api/tracks/all?icao24=${hex}&time=0`] }, ctx);
  }

  if (path === 'tle') {
    const group = q.get('group') ?? 'visual';
    if (!(TLE_GROUPS as readonly string[]).includes(group)) return json({ error: 'bad_request' }, 400);
    // CelesTrak asks clients not to poll more than once every two hours.
    return cached(`tle/${group}`, { ttl: 7200, timeout: 20000, type: 'text/plain; charset=utf-8', urls: [`https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`] }, ctx);
  }

  if (path === 'ships' || path === 'ships/meta') {
    const meta = path === 'ships/meta';
    return cached(
      meta ? 'ships-meta' : 'ships',
      {
        ttl: meta ? 3600 : 15,
        type: 'application/json',
        init: { headers: { 'Digitraffic-User': 'tinyfoot', 'accept-encoding': 'gzip' } },
        urls: [`https://meri.digitraffic.fi/api/ais/v1/${meta ? 'vessels' : 'locations'}`],
      },
      ctx,
    );
  }

  if (path === 'ships/ais') return aisWindow(env, q, ctx);

  if (path.startsWith('transit/')) {
    const id = path.slice('transit/'.length);
    if (id === 'sptrans') return sptrans(env, ctx);
    const feed = TRANSIT_FEEDS.find((f) => f.id === id);
    if (!feed) return json({ error: 'unknown_feed' }, 404);
    return cached(
      `transit/${id}`,
      { ttl: feed.ttl, urls: [feed.url], init: { headers: { 'Digitraffic-User': 'tinyfoot', 'accept-encoding': 'gzip' } } },
      ctx,
    );
  }

  if (path === 'water/usgs') {
    const b = (q.get('bbox') ?? '').split(',').map(Number);
    if (b.length !== 4 || b.some((v) => !Number.isFinite(v)) || b[2] - b[0] > 12 || b[3] - b[1] > 12) return json({ error: 'bad_request' }, 400);
    const bbox = b.map((v) => v.toFixed(1)).join(',');
    return cached(
      `usgs/${bbox}`,
      { ttl: 300, timeout: 20000, type: 'application/json', urls: [`https://api.waterdata.usgs.gov/ogcapi/v0/collections/latest-continuous/items?f=json&parameter_code=00065&bbox=${bbox}&limit=300`] },
      ctx,
    );
  }

  if (path === 'water/ana/stations') {
    return cached('ana-stations', { ttl: 86400, timeout: 28000, type: 'text/xml; charset=utf-8', urls: ['https://telemetriaws1.ana.gov.br/ServiceANA.asmx/ListaEstacoesTelemetricas?statusEstacoes=0&origem='] }, ctx);
  }

  if (path === 'water/ana/data') {
    const cod = q.get('cod') ?? '';
    if (!/^\d{6,9}$/.test(cod)) return json({ error: 'bad_request' }, 400);
    // The service wants Brazilian dates; ask for yesterday and today (Brasília time).
    const day = (offset: number): string => {
      const d = new Date(Date.now() - 3 * 3600000 + offset * 86400000);
      return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
    };
    return cached(
      `ana-data/${cod}`,
      { ttl: 900, timeout: 20000, type: 'text/xml; charset=utf-8', urls: [`https://telemetriaws1.ana.gov.br/ServiceANA.asmx/DadosHidrometeorologicos?codEstacao=${cod}&dataInicio=${day(-1)}&dataFim=${day(0)}`] },
      ctx,
    );
  }

  if (path === 'water/cge') {
    return cached('cge-sp', { ttl: 300, type: 'text/html; charset=iso-8859-1', urls: ['https://www.cgesp.org/v3/alagamentos.jsp'] }, ctx);
  }

  if (path === 'roads') {
    // Street geometry for the traffic simulation: one z15 tile (~1.2 km) of OpenStreetMap ways.
    const x = num(q.get('x'), 0, 32767);
    const y = num(q.get('y'), 0, 32767);
    if (x === null || y === null || !Number.isInteger(x) || !Number.isInteger(y)) return json({ error: 'bad_request' }, 400);
    const n = 2 ** 15;
    const lon = (v: number) => (v / n) * 360 - 180;
    const lat = (v: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * v) / n))) * 180) / Math.PI;
    const bbox = [lat(y + 1), lon(x), lat(y), lon(x + 1)].map((v) => v.toFixed(6)).join(',');
    const kinds = 'motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|pedestrian|footway|path|steps';
    const query = '[out:json][timeout:25];way[highway~"^(' + kinds + ')$"](' + bbox + ');out geom qt;';
    return cached(
      'roads/' + x + '/' + y,
      {
        ttl: 86400,
        timeout: 20000,
        type: 'application/json',
        init: { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(query) },
        urls: ['https://overpass.openstreetmap.fr/api/interpreter', 'https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'],
      },
      ctx,
    );
  }

  if (path === 'places') {
    const r = places(q);
    return r ? cached(r[0], r[1], ctx) : json({ error: 'bad_request' }, 400);
  }

  return json({ error: 'not_found' }, 404);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      try {
        return await api(url.pathname.slice(5).replace(/\/$/, ''), url.searchParams, env, ctx);
      } catch {
        return json({ error: 'internal' }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
