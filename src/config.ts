// Access tokens, read at build time (see .env.example). Both end up in the published page, as
// browser tokens always do: restrict them to your site's URLs in the providers' dashboards.

/** Cesium ion: Google Photorealistic 3D Tiles, Google 2D imagery, terrain heights, geocoding. */
export const CESIUM_ION_TOKEN: string = import.meta.env.VITE_CESIUM_ION_TOKEN ?? '';
if (!CESIUM_ION_TOKEN) console.error('[tinyfoot] VITE_CESIUM_ION_TOKEN is not set: the 3D world cannot load. See .env.example.');
