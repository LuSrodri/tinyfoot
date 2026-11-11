// Mapbox access token, read at build time from VITE_MAPBOX_TOKEN.
// Put it in `.env.local` (not committed); see `.env.example`.
export const MAPBOX_TOKEN: string = import.meta.env.VITE_MAPBOX_TOKEN ?? '';
if (!MAPBOX_TOKEN) console.error('[tinyfoot] VITE_MAPBOX_TOKEN is not set: the map cannot load. See .env.example.');
