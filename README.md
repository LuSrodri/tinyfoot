# tinyfoot

The planet in miniature, live.

A photorealistic 3D world seen through a tilt-shift lens, from orbit (macro) down to a street corner (micro), with the real world moving on it in real time.

**Live:** https://tinyfoot.lusrodri.workers.dev

## What you see

| Layer | Source | Real? |
| --- | --- | --- |
| Cities, landmarks, trees, terrain | [Google Photorealistic 3D Tiles](https://developers.google.com/maps/documentation/tile/3d-tiles) streamed through [Cesium ion](https://cesium.com/platform/cesium-ion/) in [CesiumJS](https://cesium.com/platform/cesiumjs/) | Photographed |
| The whole Earth from orbit, as it looked yesterday, and precipitation from space | [NASA GIBS](https://earthdata.nasa.gov/gibs) (VIIRS true colour, IMERG) | Daily / latest |
| Overview minimap and place search | Google 2D tiles and Google geocoding, through Cesium ion | — |
| Aircraft, in the air and on the ground, one generated model per ICAO type, airline liveries | [adsb.lol](https://adsb.lol), [adsb.fi](https://adsb.fi), [adsbdb](https://www.adsbdb.com) | Live, ~5 s |
| Satellites at true altitude | [CelesTrak](https://celestrak.org) elements, SGP4 in the browser | Live, computed |
| Ships | [Fintraffic](https://www.digitraffic.fi/en/marine-traffic/) (Baltic) · [aisstream.io](https://aisstream.io) (world, optional key) | Live, ~20 s |
| Trains, metros, trams, buses | 19 open operator feeds, see [`shared/feeds.ts`](shared/feeds.ts) | Live, 8–30 s |
| Weather where you look: rain, snow, fog, wind | [Open-Meteo](https://open-meteo.com) | Live, 15 min |
| Rivers and flooding | [Open-Meteo Flood](https://open-meteo.com/en/docs/flood-api) (global), [USGS Water Data](https://api.waterdata.usgs.gov), [ANA](https://www.snirh.gov.br/hidrotelemetria/) telemetry, [CGE São Paulo](https://www.cgesp.org) | Model daily; gauges minutes old |
| Shops and places, green when open, red when closed | OpenStreetMap `opening_hours` | Rule evaluated live |
| Road traffic and pedestrians on the real street network | Simulated on [OpenStreetMap](https://www.openstreetmap.org) streets | **Estimate** |

### What is real and what is not

- Traffic and pedestrians are **not** real vehicles or people. They are agents at real size on the real streets, with density and speed estimated from local time, weekday and street class. Cars are drawn from each region's best-selling models, each generated to that model's real length, width, height and body type.
- All moving models (aircraft, ships, trains, buses, cars, people) are generated in code from real dimensions and cached in the browser. They have the right proportions and layout for their type, not every detail of the real thing.
- The photorealistic city is Google's photogrammetry: real, but captured months or years ago. Cars baked into it are not live.
- River markers from Open-Meteo Flood are a hydrological model; USGS and ANA markers are measured levels. SAISP has no open API, so São Paulo flooding comes from CGE's public page (counts, no coordinates).

## Controls

No interface by default. Drag to move, scroll to zoom, right-drag or Ctrl-drag to tilt and turn. Click an aircraft, ship, vehicle, satellite or river gauge for details.

- **G** shows or hides the interface (layers, search, places, view modes).
- **M** steps through the view modes: Miniature (tilt-shift), Photo, Night.
- `?q=low|medium|high` forces a quality level.

## How it works

```
browser ── CesiumJS: Google 3D tiles (city) / NASA GIBS globe (orbit), tilt-shift post-processing
   │        └─ one instanced primitive draws everything that moves
   └─ /api/* ── Cloudflare Worker: caching pass-through to the open feeds
```

- The camera uses a narrow 22° field of view and stands far back, so the city reads almost isometric, like a model railway.
- Tilt-shift, the miniature colour, the night look, rain, snow and fog are GPU post-processing passes.
- Every moving thing is placed on the WGS84 ellipsoid in double precision on the CPU, relative to a point near the camera, and drawn with instancing, depth-tested against the 3D tiles.
- Ground heights come from Cesium World Terrain and are calibrated against the photographed surface on open road.
- The Worker (`worker/index.ts`) does no parsing: bytes in, bytes out, with an edge cache per feed so that all viewers share one upstream request.

## Run it

```sh
npm install
cp .env.example .env.local   # then put your Cesium ion token in it
npm run dev                  # Vite on :5173, Worker API on :8787
npm run deploy               # build + wrangler deploy
```

The Cesium ion token (free account at [ion.cesium.com/tokens](https://ion.cesium.com/tokens)) is read at build time from `VITE_CESIUM_ION_TOKEN` and is not committed. It ends up in the published page, as every browser token does: restrict it to your site's URLs in the ion dashboard.

Optional server keys widen coverage:

```sh
npx wrangler secret put AISSTREAM_KEY   # ships world-wide
npx wrangler secret put SPTRANS_TOKEN   # São Paulo buses
```

## License

Code: MIT. Each data source keeps its own terms; see the links above. Google 3D tiles must be shown with Google attribution and only with Google map content, which is why the minimap and search use Google through Cesium ion.
