// Registry of open real-time public transport feeds.
// Shared by the Worker (which proxies + caches them) and the client (which decodes them).
// Adding a city = adding one entry here.

export type TransitMode = 'bus' | 'tram' | 'metro' | 'train' | 'ferry';

export type FeedFormat =
  | 'gtfsrt' // GTFS-Realtime VehiclePositions, protobuf
  | 'gtfsrt-json' // GTFS-Realtime VehiclePositions, JSON encoding
  | 'amtraker'
  | 'fintraffic-trains'
  | 'septa-bus'
  | 'septa-rail'
  | 'rio-brt'
  | 'tallinn'
  | 'sptrans';

export interface TransitFeed {
  id: string;
  name: string;
  /** [west, south, east, north] */
  bbox: [number, number, number, number];
  format: FeedFormat;
  mode: TransitMode;
  url: string;
  /** Seconds between refreshes. */
  ttl: number;
  /** Needs a Worker secret to be enabled. */
  secret?: 'SPTRANS_TOKEN';
}

export const TRANSIT_FEEDS: TransitFeed[] = [
  { id: 'mbta', name: 'MBTA · Boston', bbox: [-71.9, 41.5, -70.5, 42.9], format: 'gtfsrt', mode: 'bus', ttl: 8, url: 'https://cdn.mbta.com/realtime/VehiclePositions.pb' },
  { id: 'hsl', name: 'HSL · Helsinki', bbox: [24.3, 59.9, 25.6, 60.6], format: 'gtfsrt', mode: 'bus', ttl: 8, url: 'https://realtime.hsl.fi/realtime/vehicle-positions/v2/hsl' },
  { id: 'entur', name: 'Entur · Norge', bbox: [4, 57.8, 31.5, 71.3], format: 'gtfsrt', mode: 'bus', ttl: 15, url: 'https://api.entur.io/realtime/v1/gtfs-rt/vehicle-positions' },
  { id: 'ovapi', name: 'OVapi · Nederland', bbox: [3.2, 50.7, 7.3, 53.6], format: 'gtfsrt', mode: 'bus', ttl: 15, url: 'https://gtfs.ovapi.nl/nl/vehiclePositions.pb' },
  { id: 'kcm', name: 'King County Metro · Seattle', bbox: [-122.6, 47.1, -121.7, 47.8], format: 'gtfsrt', mode: 'bus', ttl: 12, url: 'https://s3.amazonaws.com/kcm-alerts-realtime-prod/vehiclepositions.pb' },
  { id: 'zet', name: 'ZET · Zagreb', bbox: [15.7, 45.65, 16.25, 45.95], format: 'gtfsrt', mode: 'tram', ttl: 12, url: 'https://www.zet.hr/gtfs-rt-protobuf' },
  { id: 'translink-seq', name: 'TransLink · Brisbane', bbox: [152.4, -28.3, 153.6, -26.2], format: 'gtfsrt', mode: 'bus', ttl: 15, url: 'https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions' },
  { id: 'edmonton', name: 'ETS · Edmonton', bbox: [-113.8, 53.3, -113.2, 53.75], format: 'gtfsrt', mode: 'bus', ttl: 15, url: 'https://gtfs.edmonton.ca/TMGTFSRealTimeWebService/Vehicle/VehiclePositions.pb' },
  { id: 'metrotransit', name: 'Metro Transit · Minneapolis', bbox: [-93.9, 44.6, -92.7, 45.4], format: 'gtfsrt', mode: 'bus', ttl: 15, url: 'https://svc.metrotransit.org/mtgtfs/vehiclepositions.pb' },
  { id: 'halifax', name: 'Halifax Transit', bbox: [-63.95, 44.45, -63.3, 44.95], format: 'gtfsrt', mode: 'bus', ttl: 15, url: 'https://gtfs.halifax.ca/realtime/Vehicle/VehiclePositions.pb' },
  { id: 'calgary', name: 'Calgary Transit', bbox: [-114.4, 50.8, -113.8, 51.25], format: 'gtfsrt', mode: 'bus', ttl: 20, url: 'https://data.calgary.ca/download/am7c-qe3u/application%2Foctet-stream' },
  { id: 'capmetro', name: 'CapMetro · Austin', bbox: [-98.05, 30.05, -97.45, 30.65], format: 'gtfsrt', mode: 'bus', ttl: 15, url: 'https://data.texas.gov/download/eiei-9rpf/application%2Foctet-stream' },
  { id: 'renfe', name: 'Renfe · España', bbox: [-9.6, 35.8, 3.5, 43.9], format: 'gtfsrt-json', mode: 'train', ttl: 20, url: 'https://gtfsrt.renfe.com/vehicle_positions.json' },
  { id: 'amtrak', name: 'Amtrak · USA', bbox: [-125, 24, -66, 50], format: 'amtraker', mode: 'train', ttl: 30, url: 'https://api-v3.amtraker.com/v3/trains' },
  { id: 'fintraffic', name: 'Fintraffic · Suomi', bbox: [19, 59.5, 31.6, 70.1], format: 'fintraffic-trains', mode: 'train', ttl: 10, url: 'https://rata.digitraffic.fi/api/v1/train-locations/latest' },
  { id: 'septa-bus', name: 'SEPTA · Philadelphia', bbox: [-75.7, 39.75, -74.7, 40.35], format: 'septa-bus', mode: 'bus', ttl: 15, url: 'https://www3.septa.org/api/TransitViewAll/' },
  { id: 'septa-rail', name: 'SEPTA Regional Rail', bbox: [-75.9, 39.6, -74.6, 40.4], format: 'septa-rail', mode: 'train', ttl: 20, url: 'https://www3.septa.org/api/TrainView/index.php' },
  { id: 'rio-brt', name: 'BRT · Rio de Janeiro', bbox: [-43.85, -23.1, -43.1, -22.7], format: 'rio-brt', mode: 'bus', ttl: 15, url: 'https://dados.mobilidade.rio/gps/brt' },
  { id: 'tallinn', name: 'TLT · Tallinn', bbox: [24.5, 59.3, 25.0, 59.52], format: 'tallinn', mode: 'bus', ttl: 8, url: 'https://transport.tallinn.ee/gps.txt' },
  { id: 'sptrans', name: 'SPTrans · São Paulo', bbox: [-46.85, -23.8, -46.35, -23.35], format: 'sptrans', mode: 'bus', ttl: 20, url: 'https://api.olhovivo.sptrans.com.br/v2.1', secret: 'SPTRANS_TOKEN' },
];

export const TLE_GROUPS = ['stations', 'visual', 'gps-ops', 'weather', 'science', 'starlink'] as const;
export type TleGroup = (typeof TLE_GROUPS)[number];
