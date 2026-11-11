# tinyfoot

The planet in miniature, live.

A 3D world you can take in from orbit (macro) or walk down to a street corner (micro), always through a tilt-shift lens, with the real world moving on it in real time.

**Live:** https://tinyfoot.lusrodri.workers.dev

## What you see

| Layer | Source | Real? |
| --- | --- | --- |
| Base world: 3D buildings, detailed landmarks, trees, terrain, lighting | [Mapbox Standard](https://www.mapbox.com/maps/standard) | Map data |
| The Earth as it looked yesterday (real clouds, snow, smoke), at globe scale | [NASA GIBS](https://earthdata.nasa.gov/gibs) VIIRS true colour | Daily |
| Precipitation measured from space | NASA GIBS IMERG | Latest available |
| Aircraft, in the air and on the ground, one generated model per ICAO type, airline liveries | [adsb.lol](https://adsb.lol), [adsb.fi](https://adsb.fi), [adsbdb](https://www.adsbdb.com) | Live, ~5 s |
| Satellites at true altitude | [CelesTrak](https://celestrak.org) elements, SGP4 in the browser | Live, computed |
| Ships | [Fintraffic](https://www.digitraffic.fi/en/marine-traffic/) (Baltic) · [aisstream.io](https://aisstream.io) (world, optional key) | Live, ~20 s |
| Trains, metros, trams, buses | 19 open operator feeds, see [`shared/feeds.ts`](shared/feeds.ts) | Live, 8–30 s |
| Weather at the place you are looking at: rain, snow, fog, wind direction | [Open-Meteo](https://open-meteo.com) | Live, 15 min |
| Rivers and flooding | [Open-Meteo Flood](https://open-meteo.com/en/docs/flood-api) (GloFAS, global), [USGS Water Data](https://api.waterdata.usgs.gov) (US gauges), [ANA](https://www.snirh.gov.br/hidrotelemetria/) telemetry (Brazil), [CGE São Paulo](https://www.cgesp.org) (active street flooding) | Model daily; gauges minutes old |
| Shops and places, green when open, red when closed | OpenStreetMap `opening_hours` via Overpass | Rule evaluated live |
| Road traffic and pedestrians | Simulated | **Estimate** |

Lighting follows the real sun where you are looking (dawn, day, dusk, night), and the day/night line is drawn on the globe.

### What is real and what is not

- Traffic and pedestrians are **not** real vehicles or people. They are agents on the real street geometry, at real size, with density and speed estimated from local time, weekday and street class. Cars are drawn from each region's best-selling models (body type and real dimensions).
- Aircraft, ship, train, bus, car and person models are generated procedurally from real dimensions. They have the right proportions and layout for their type, not every detail of the real thing.
- River markers from Open-Meteo Flood are a hydrological model, compared with that river's own last 60 days: blue normal, amber high, red flood. USGS and ANA markers are measured levels.
- SAISP does not publish an open API (its data needs a login), so São Paulo flooding comes from CGE's public page, which gives counts but no coordinates. ANA's newer HidroWebService also needs credentials; the open telemetry service it replaced is used instead.

## Controls

There is no interface by default. Drag, scroll and tilt the map; click an aircraft, ship, vehicle, satellite or river gauge for details.

- **G** shows or hides the interface (layers, search, view modes).
- **M** steps through the view modes: Miniature (tilt-shift), Map, Satellite, Night.
- `?q=low|medium|high` forces a quality level.

## How it works

```
browser ── Mapbox GL JS (globe, terrain, 3D buildings, weather effects)
   │        └─ one instanced WebGL layer for everything that moves
   └─ /api/* ── Cloudflare Worker: caching pass-through to the open feeds
```

- Every model is a mesh generated in code (`src/gl/meshes.ts`), drawn with GPU instancing, and cached in IndexedDB after first use (`src/gl/meshcache.ts`).
- Position reports arrive every few seconds; between them each object is dead-reckoned and eased toward the next report (`src/util/mover.ts`).
- The Worker (`worker/index.ts`) does no parsing: bytes in, bytes out, with a short edge cache per feed so that all viewers share one upstream request.
- The device is classified on load and the amount of detail adapts; it steps down by itself if frames get slow.

## Run it

```sh
npm install
npm run dev      # Vite on :5173, Worker API on :8787
npm run deploy   # build + wrangler deploy
```

### Keys

- **Mapbox** (required): copy `.env.example` to `.env.local` and set `VITE_MAPBOX_TOKEN` to a public token from your Mapbox account. It is read at build time and is not committed. Restrict the token to your site URLs in the Mapbox dashboard, since it ends up in the published bundle.
- Optional, both free, both only widen coverage:

```sh
npx wrangler secret put AISSTREAM_KEY   # ships world-wide
npx wrangler secret put SPTRANS_TOKEN   # São Paulo buses
```

## License

Code: MIT. Each data source keeps its own terms; see the links above.
