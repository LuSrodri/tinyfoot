// Real-time weather where you are looking, from Open-Meteo (no key). It drives what you see:
// rain and snow falling, fog closing in, and the wind direction they come from.

import { getJson } from '../core';
import type { Basemap, Weather } from '../map/basemap';
import { haversine } from '../util/geo';

interface Current {
  temperature_2m: number;
  weather_code: number;
  cloud_cover: number;
  precipitation: number;
  rain: number;
  showers: number;
  snowfall: number;
  wind_speed_10m: number;
  wind_direction_10m: number;
  visibility: number;
  is_day: number;
}

export class WeatherWatch {
  /** Latest observation, for display. */
  current: (Weather & { temperature: number; code: number }) | null = null;
  private lat = 999;
  private lon = 999;
  private at = 0;
  private busy = false;

  constructor(private readonly base: Basemap) {
    // Precipitation is only drawn up close, so re-evaluate whenever the camera settles.
    base.map.on('moveend', () => base.setWeather(this.current));
  }

  /** Call often; it only fetches when the view moved 15 km or ten minutes passed. */
  tick(now: number): void {
    const c = this.base.map.getCenter();
    if (this.busy || this.base.map.getZoom() < 6) return;
    const moved = this.lat > 90 || haversine(this.lat, this.lon, c.lat, c.lng) > 15000;
    if (!moved && now - this.at < 600000) return;
    this.busy = true;
    this.lat = c.lat;
    this.lon = c.lng;
    this.at = now;
    const vars = 'temperature_2m,weather_code,cloud_cover,precipitation,rain,showers,snowfall,wind_speed_10m,wind_direction_10m,visibility,is_day';
    void getJson<{ current?: Current }>(`https://api.open-meteo.com/v1/forecast?latitude=${c.lat.toFixed(3)}&longitude=${c.lng.toFixed(3)}&current=${vars}`)
      .then((res) => {
        const w = res?.current;
        if (!w) {
          this.at = now - 540000; // try again in a minute
          return;
        }
        this.current = {
          rain: (w.rain ?? 0) + (w.showers ?? 0),
          snow: w.snowfall ?? 0,
          visibility: w.visibility ?? 24000,
          cloud: (w.cloud_cover ?? 0) / 100,
          windDir: w.wind_direction_10m ?? 0,
          windSpeed: w.wind_speed_10m ?? 0,
          temperature: w.temperature_2m,
          code: w.weather_code,
        };
        this.base.setWeather(this.current);
      })
      .finally(() => (this.busy = false));
  }
}
