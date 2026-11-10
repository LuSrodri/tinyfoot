import { angleDiff, bearing, destination, haversine } from './geo';

/**
 * Turns sparse position reports into smooth continuous motion.
 * Between reports it dead-reckons along the last known course and speed, then
 * eases toward the next report instead of jumping.
 */
export class Mover {
  lat = 0;
  lon = 0;
  /** Degrees clockwise from north. */
  heading = 0;
  /** Metres per second, as reported or inferred. */
  speed = 0;
  lastFix = 0;

  private fLat = 0;
  private fLon = 0;
  private fT = 0;
  private fBrg = NaN;
  private has = false;

  /**
   * @param t      time of the report, epoch ms
   * @param speed  m/s if the feed reports it
   * @param brg    degrees if the feed reports it
   */
  fix(lat: number, lon: number, t: number, speed?: number, brg?: number): void {
    if (this.has && lat === this.fLat && lon === this.fLon && speed === undefined) {
      // Same position again: the vehicle is standing still (or the feed is stale).
      if (t - this.fT > 20000) this.speed = 0;
      this.lastFix = Date.now();
      return;
    }
    if (this.has) {
      const dist = haversine(this.fLat, this.fLon, lat, lon);
      const dt = Math.max(1, (t - this.fT) / 1000);
      if (speed === undefined) this.speed = Math.min(90, dist / dt);
      if (brg === undefined || Number.isNaN(brg)) {
        if (dist > 4) this.fBrg = bearing(this.fLat, this.fLon, lat, lon);
      }
    }
    if (speed !== undefined) this.speed = speed;
    if (brg !== undefined && !Number.isNaN(brg)) this.fBrg = brg;
    this.fLat = lat;
    this.fLon = lon;
    this.fT = t;
    this.lastFix = Date.now();
    if (!this.has) {
      this.has = true;
      this.lat = lat;
      this.lon = lon;
      if (!Number.isNaN(this.fBrg)) this.heading = this.fBrg;
    }
  }

  /**
   * @param maxAhead  how many seconds we are willing to extrapolate past a report
   * @param tau       smoothing time constant in seconds
   */
  step(now: number, dt: number, maxAhead: number, tau = 1): void {
    if (!this.has) return;
    let tLat = this.fLat;
    let tLon = this.fLon;
    const age = Math.min(maxAhead, Math.max(0, (now - this.fT) / 1000));
    if (this.speed > 0.3 && !Number.isNaN(this.fBrg) && age > 0) {
      [tLat, tLon] = destination(this.fLat, this.fLon, this.fBrg, this.speed * age);
    }
    const dLat = tLat - this.lat;
    let dLon = tLon - this.lon;
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;
    // Far away (first frame after a gap, teleport): snap rather than slide across the map.
    const jump = Math.abs(dLat) + Math.abs(dLon) > 0.5;
    const k = jump ? 1 : 1 - Math.exp(-dt / tau);
    this.lat += dLat * k;
    this.lon += dLon * k;
    if (!Number.isNaN(this.fBrg)) {
      this.heading = (this.heading + angleDiff(this.heading, this.fBrg) * (jump ? 1 : 1 - Math.exp(-dt / 0.6)) + 360) % 360;
    }
  }
}
