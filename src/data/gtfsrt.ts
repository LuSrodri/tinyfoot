// Minimal GTFS-Realtime decoder: reads only vehicle positions out of a
// FeedMessage protobuf. ~100 lines instead of a protobuf runtime + generated code.

export interface RtVehicle {
  id: string;
  lat: number;
  lon: number;
  bearing?: number;
  /** m/s */
  speed?: number;
  route?: string;
  trip?: string;
  label?: string;
  /** Epoch seconds. */
  time?: number;
}

class Reader {
  pos = 0;
  private readonly view: DataView;
  constructor(readonly buf: Uint8Array, start = 0, readonly end = buf.length) {
    this.pos = start;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  varint(): number {
    let result = 0;
    let shift = 1;
    for (;;) {
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * shift;
      if (b < 0x80 || this.pos >= this.end) return result;
      shift *= 128;
    }
  }
  float(): number {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  /** Returns the [start, end) of a length-delimited field and skips past it. */
  bytes(): [number, number] {
    const len = this.varint();
    const start = this.pos;
    this.pos = Math.min(this.end, start + len);
    return [start, this.pos];
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.pos += 4;
    else this.pos = this.end;
  }
}

const utf8 = new TextDecoder();

/** Walks the fields of one message. */
function each(buf: Uint8Array, start: number, end: number, fn: (field: number, wire: number, r: Reader) => boolean): void {
  const r = new Reader(buf, start, end);
  while (r.pos < end) {
    const tag = r.varint();
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (!fn(field, wire, r)) r.skip(wire);
  }
}

const str = (buf: Uint8Array, r: Reader): string => {
  const [s, e] = r.bytes();
  return utf8.decode(buf.subarray(s, e));
};

export function decodeVehiclePositions(data: ArrayBuffer): RtVehicle[] {
  const buf = new Uint8Array(data);
  const out: RtVehicle[] = [];
  each(buf, 0, buf.length, (field, wire, r) => {
    if (field !== 2 || wire !== 2) return false; // FeedMessage.entity
    const [es, ee] = r.bytes();
    let entityId = '';
    let v: RtVehicle | null = null;
    each(buf, es, ee, (f, w, er) => {
      if (f === 1 && w === 2) {
        entityId = str(buf, er);
        return true;
      }
      if (f !== 4 || w !== 2) return false; // FeedEntity.vehicle
      const [vs, ve] = er.bytes();
      const veh: RtVehicle = { id: '', lat: NaN, lon: NaN };
      each(buf, vs, ve, (vf, vw, vr) => {
        if (vf === 1 && vw === 2) {
          const [s, e] = vr.bytes(); // TripDescriptor
          each(buf, s, e, (tf, tw, tr) => {
            if (tf === 1 && tw === 2) veh.trip = str(buf, tr);
            else if (tf === 5 && tw === 2) veh.route = str(buf, tr);
            else return false;
            return true;
          });
          return true;
        }
        if (vf === 2 && vw === 2) {
          const [s, e] = vr.bytes(); // Position
          each(buf, s, e, (pf, pw, pr) => {
            if (pw !== 5) return false;
            const val = pr.float();
            if (pf === 1) veh.lat = val;
            else if (pf === 2) veh.lon = val;
            else if (pf === 3) veh.bearing = val;
            else if (pf === 5) veh.speed = val;
            return true;
          });
          return true;
        }
        if (vf === 5 && vw === 0) {
          veh.time = vr.varint();
          return true;
        }
        if (vf === 8 && vw === 2) {
          const [s, e] = vr.bytes(); // VehicleDescriptor
          each(buf, s, e, (df, dw, dr) => {
            if (df === 1 && dw === 2) veh.id = str(buf, dr);
            else if (df === 2 && dw === 2) veh.label = str(buf, dr);
            else return false;
            return true;
          });
          return true;
        }
        return false;
      });
      v = veh;
      return true;
    });
    const veh = v as RtVehicle | null;
    if (veh && Number.isFinite(veh.lat) && Number.isFinite(veh.lon) && (veh.lat !== 0 || veh.lon !== 0)) {
      if (!veh.id) veh.id = entityId;
      out.push(veh);
    }
    return true;
  });
  return out;
}
