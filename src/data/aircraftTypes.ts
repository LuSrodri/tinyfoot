import { M } from '../gl/meshes';
import { hash, hsl } from '../util/geo';

// ICAO type designator | marketing name | airframe family | length in metres.
// Families: N narrow-body twin, W wide-body twin, Q four-engine heavy,
// R rear-engine jet, T turboprop, L light piston, H helicopter.
const TYPES = `
A318|Airbus A318|N|31.4
A319|Airbus A319|N|33.8
A19N|Airbus A319neo|N|33.8
A320|Airbus A320|N|37.6
A20N|Airbus A320neo|N|37.6
A321|Airbus A321|N|44.5
A21N|Airbus A321neo|N|44.5
BCS1|Airbus A220-100|N|35
BCS3|Airbus A220-300|N|38.7
A306|Airbus A300-600|W|54.1
A30B|Airbus A300|W|53.6
A310|Airbus A310|W|46.7
A332|Airbus A330-200|W|58.8
A333|Airbus A330-300|W|63.7
A338|Airbus A330-800neo|W|58.8
A339|Airbus A330-900neo|W|63.7
A359|Airbus A350-900|W|66.8
A35K|Airbus A350-1000|W|73.8
A342|Airbus A340-200|Q|59.4
A343|Airbus A340-300|Q|63.7
A345|Airbus A340-500|Q|67.9
A346|Airbus A340-600|Q|75.4
A388|Airbus A380-800|Q|72.7
A400|Airbus A400M Atlas|T|45.1
B712|Boeing 717-200|R|37.8
B732|Boeing 737-200|N|30.5
B733|Boeing 737-300|N|33.4
B734|Boeing 737-400|N|36.4
B735|Boeing 737-500|N|31
B736|Boeing 737-600|N|31.2
B737|Boeing 737-700|N|33.6
B738|Boeing 737-800|N|39.5
B739|Boeing 737-900|N|42.1
B37M|Boeing 737 MAX 7|N|35.6
B38M|Boeing 737 MAX 8|N|39.5
B39M|Boeing 737 MAX 9|N|42.2
B3XM|Boeing 737 MAX 10|N|43.8
B752|Boeing 757-200|N|47.3
B753|Boeing 757-300|N|54.4
B762|Boeing 767-200|W|48.5
B763|Boeing 767-300|W|54.9
B764|Boeing 767-400|W|61.4
B772|Boeing 777-200|W|63.7
B77L|Boeing 777-200LR|W|63.7
B773|Boeing 777-300|W|73.9
B77W|Boeing 777-300ER|W|73.9
B778|Boeing 777-8|W|70.9
B779|Boeing 777-9|W|76.7
B788|Boeing 787-8 Dreamliner|W|56.7
B789|Boeing 787-9 Dreamliner|W|62.8
B78X|Boeing 787-10 Dreamliner|W|68.3
B741|Boeing 747-100|Q|70.7
B742|Boeing 747-200|Q|70.7
B744|Boeing 747-400|Q|70.7
B748|Boeing 747-8|Q|76.3
BLCF|Boeing 747 Dreamlifter|Q|71.7
MD11|McDonnell Douglas MD-11|W|61.6
DC10|McDonnell Douglas DC-10|W|55.5
MD82|McDonnell Douglas MD-82|R|45.1
MD83|McDonnell Douglas MD-83|R|45.1
MD88|McDonnell Douglas MD-88|R|45.1
MD90|McDonnell Douglas MD-90|R|46.5
E170|Embraer E170|N|29.9
E75L|Embraer E175|N|31.7
E75S|Embraer E175|N|31.7
E190|Embraer E190|N|36.2
E195|Embraer E195|N|38.7
E290|Embraer E190-E2|N|36.2
E295|Embraer E195-E2|N|41.5
E135|Embraer ERJ-135|R|26.3
E145|Embraer ERJ-145|R|29.9
E45X|Embraer ERJ-145XR|R|29.9
E35L|Embraer Legacy 600|R|26.3
E50P|Embraer Phenom 100|R|12.8
E55P|Embraer Phenom 300|R|15.9
E545|Embraer Praetor 500|R|19.7
E550|Embraer Praetor 600|R|20.7
E120|Embraer EMB 120 Brasília|T|20
E110|Embraer EMB 110 Bandeirante|T|15.1
E314|Embraer Super Tucano|L|11.4
KC39|Embraer C-390 Millennium|W|35.2
C919|COMAC C919|N|38.9
AJ27|COMAC ARJ21|R|33.5
SU95|Sukhoi Superjet 100|N|29.9
CRJ1|Bombardier CRJ100|R|26.8
CRJ2|Bombardier CRJ200|R|26.8
CRJ7|Bombardier CRJ700|R|32.5
CRJ9|Bombardier CRJ900|R|36.2
CRJX|Bombardier CRJ1000|R|39.1
GLEX|Bombardier Global Express|R|30.3
GL5T|Bombardier Global 5000|R|29.5
GL7T|Bombardier Global 7500|R|33.9
CL30|Bombardier Challenger 300|R|20.9
CL35|Bombardier Challenger 350|R|20.9
CL60|Bombardier Challenger 600|R|20.9
GLF4|Gulfstream IV|R|26.9
GLF5|Gulfstream V|R|29.4
GLF6|Gulfstream G650|R|30.4
GA5C|Gulfstream G500|R|27.8
GA6C|Gulfstream G600|R|29.3
G280|Gulfstream G280|R|20.4
F2TH|Dassault Falcon 2000|R|20.2
F900|Dassault Falcon 900|R|20.2
FA7X|Dassault Falcon 7X|R|23.4
FA8X|Dassault Falcon 8X|R|24.5
FA50|Dassault Falcon 50|R|18.5
LJ35|Learjet 35|R|14.8
LJ45|Learjet 45|R|17.7
LJ60|Learjet 60|R|17.9
LJ75|Learjet 75|R|17.7
H25B|Hawker 800|R|15.6
PC24|Pilatus PC-24|R|16.8
C25A|Cessna Citation CJ2|R|14.5
C25B|Cessna Citation CJ3|R|15.6
C25C|Cessna Citation CJ4|R|16.3
C510|Cessna Citation Mustang|R|12.4
C525|Cessna CitationJet|R|13
C550|Cessna Citation II|R|14.4
C560|Cessna Citation V|R|14.9
C56X|Cessna Citation Excel|R|16
C680|Cessna Citation Sovereign|R|19.4
C68A|Cessna Citation Latitude|R|19
C700|Cessna Citation Longitude|R|22.3
C750|Cessna Citation X|R|22
AT43|ATR 42-300|T|22.7
AT45|ATR 42-500|T|22.7
AT46|ATR 42-600|T|22.7
AT72|ATR 72|T|27.2
AT75|ATR 72-500|T|27.2
AT76|ATR 72-600|T|27.2
DH8A|De Havilland Dash 8-100|T|22.3
DH8B|De Havilland Dash 8-200|T|22.3
DH8C|De Havilland Dash 8-300|T|25.7
DH8D|De Havilland Dash 8-400|T|32.8
SF34|Saab 340|T|19.7
SB20|Saab 2000|T|27.3
JS41|BAe Jetstream 41|T|19.3
B190|Beechcraft 1900|T|17.6
BE20|Beechcraft King Air 200|T|13.3
B350|Beechcraft King Air 350|T|14.2
BE9L|Beechcraft King Air 90|T|10.8
DHC6|De Havilland Twin Otter|T|15.8
AN12|Antonov An-12|T|33.1
AN24|Antonov An-24|T|23.5
AN26|Antonov An-26|T|23.8
C130|Lockheed C-130 Hercules|T|29.8
C30J|Lockheed C-130J Super Hercules|T|29.8
P3|Lockheed P-3 Orion|T|35.6
C17|Boeing C-17 Globemaster III|Q|53
C5M|Lockheed C-5M Super Galaxy|Q|75.3
K35R|Boeing KC-135 Stratotanker|Q|41.5
E3TF|Boeing E-3 Sentry|Q|46.6
IL76|Ilyushin Il-76|Q|46.6
IL96|Ilyushin Il-96|Q|55.3
A124|Antonov An-124 Ruslan|Q|69.1
P8|Boeing P-8 Poseidon|N|39.5
PC12|Pilatus PC-12|L|14.4
C208|Cessna 208 Caravan|L|11.5
TBM7|Socata TBM 700|L|10.6
TBM9|Daher TBM 900|L|10.7
C150|Cessna 150|L|7.3
C152|Cessna 152|L|7.3
C172|Cessna 172 Skyhawk|L|8.3
C182|Cessna 182 Skylane|L|8.8
C206|Cessna 206 Stationair|L|8.6
C210|Cessna 210 Centurion|L|8.6
P28A|Piper PA-28 Cherokee|L|7.3
PA28|Piper PA-28 Cherokee|L|7.3
P28R|Piper PA-28R Arrow|L|7.5
P32R|Piper PA-32R Saratoga|L|8.4
PA34|Piper PA-34 Seneca|L|8.7
PA44|Piper PA-44 Seminole|L|8.4
PA46|Piper PA-46 Malibu|L|8.8
SR20|Cirrus SR20|L|7.9
SR22|Cirrus SR22|L|7.9
S22T|Cirrus SR22T|L|7.9
DA40|Diamond DA40|L|8.1
DA42|Diamond DA42 Twin Star|L|8.6
DA62|Diamond DA62|L|9.2
BE36|Beechcraft Bonanza|L|8.4
BE58|Beechcraft Baron|L|9.1
M20P|Mooney M20|L|8.2
R22|Robinson R22|H|8.7
R44|Robinson R44|H|11.7
R66|Robinson R66|H|11.7
B06|Bell 206 JetRanger|H|12.1
B407|Bell 407|H|12.7
B412|Bell 412|H|17.1
B429|Bell 429|H|13.1
B505|Bell 505|H|12.9
A109|Leonardo AW109|H|13
A139|Leonardo AW139|H|16.7
A169|Leonardo AW169|H|14.6
A189|Leonardo AW189|H|17.6
AS50|Airbus H125 Esquilo|H|12.9
AS55|Airbus AS355 Esquilo|H|12.9
AS65|Airbus AS365 Dauphin|H|13.7
EC20|Airbus EC120 Colibri|H|11.5
EC30|Airbus H130|H|12.6
EC35|Airbus H135|H|12.2
EC45|Airbus H145|H|13
EC55|Airbus H155|H|14.3
EC75|Airbus H175|H|18.1
EC25|Airbus H225 Super Puma|H|19.5
H160|Airbus H160|H|15.7
S76|Sikorsky S-76|H|16
S92|Sikorsky S-92|H|20.9
H60|Sikorsky UH-60 Black Hawk|H|19.8
H47|Boeing CH-47 Chinook|H|30.1
MD52|MD 520N|H|9.8
F16|General Dynamics F-16|R|15
F18H|Boeing F/A-18 Hornet|R|17.1
F35|Lockheed Martin F-35|R|15.7
EUFI|Eurofighter Typhoon|R|16
`;

interface Family {
  mesh: M;
  /** Length of the family's reference mesh. */
  base: number;
}

const FAMILIES: Record<string, Family> = {
  N: { mesh: M.Narrow, base: 37.6 },
  W: { mesh: M.Wide2, base: 66 },
  Q: { mesh: M.Wide4, base: 72 },
  R: { mesh: M.Regional, base: 30 },
  T: { mesh: M.Turboprop, base: 27 },
  L: { mesh: M.Light, base: 8.3 },
  H: { mesh: M.Heli, base: 12.5 },
};

export interface TypeInfo {
  name: string;
  mesh: M;
  /** Real length in metres. */
  length: number;
  /** Multiplier applied to the family mesh to reach the real size. */
  scale: number;
}

const table = new Map<string, TypeInfo>();
for (const line of TYPES.trim().split('\n')) {
  const [code, name, fam, len] = line.split('|');
  const f = FAMILIES[fam];
  table.set(code, { name, mesh: f.mesh, length: Number(len), scale: Number(len) / f.base });
}

const generic = (name: string, fam: string, length: number): TypeInfo => {
  const f = FAMILIES[fam];
  return { name, mesh: f.mesh, length, scale: length / f.base };
};

/** Emitter category (ADS-B) fallbacks for types we do not have in the table. */
const BY_CATEGORY: Record<string, TypeInfo> = {
  A1: generic('', 'L', 8.5),
  A2: generic('', 'R', 17),
  A3: generic('', 'N', 37),
  A4: generic('', 'N', 47),
  A5: generic('', 'W', 64),
  A6: generic('', 'R', 15),
  A7: generic('', 'H', 12.5),
  B1: generic('', 'L', 7),
  B4: generic('', 'L', 6),
  B6: generic('', 'L', 4),
};
const UNKNOWN = generic('', 'N', 24);

export function typeInfo(type: string | undefined, category: string | undefined): TypeInfo {
  if (type) {
    const hit = table.get(type);
    if (hit) return hit;
  }
  const byCat = category ? BY_CATEGORY[category] : undefined;
  if (byCat) return type ? { ...byCat, name: type } : byCat;
  return type ? { ...UNKNOWN, name: type } : UNKNOWN;
}

// Tail colours for well-known operators (ICAO airline designator -> [body, accent]).
const W = 0xf3f4f6;
const LIVERY: Record<string, [number, number]> = {
  AZU: [W, 0x1b4fa8], GLO: [W, 0xff6a13], TAM: [W, 0x2a0088], LAN: [W, 0x2a0088], LPE: [W, 0x2a0088], ARG: [W, 0x67b2e8],
  AVA: [W, 0xe2231a], CMP: [W, 0x005aa3], AMX: [W, 0x0b2343], VOI: [W, 0xa3238e], PTB: [W, 0xf7c600],
  AAL: [0xd9dde2, 0x0078d2], DAL: [W, 0xc8102e], UAL: [W, 0x0033a0], SWA: [0x304cb2, 0xffbf27], JBU: [W, 0x003876],
  ASA: [W, 0x01426a], FFT: [W, 0x006643], NKS: [0xffec00, 0x111111], ACA: [W, 0xd22630], WJA: [W, 0x00a4b4],
  FDX: [W, 0x4d148c], UPS: [W, 0x4b2e1e], DHK: [0xffcc00, 0xd40511], BCS: [0xffcc00, 0xd40511], GTI: [W, 0x003a70],
  BAW: [W, 0x075aaa], VIR: [W, 0xe10a0a], EZY: [W, 0xff6600], EJU: [W, 0xff6600], RYR: [W, 0x073590], WZZ: [W, 0xc6007e],
  DLH: [W, 0x05164d], EWG: [W, 0xa5027d], AFR: [W, 0x002157], TVF: [W, 0x00d66c], KLM: [0x00a1de, 0x003f72],
  IBE: [W, 0xd7192d], VLG: [W, 0xffcc00], TAP: [W, 0x00a651], SWR: [W, 0xe2001a], AUA: [W, 0xe2001a], SAS: [W, 0x2b3087],
  FIN: [W, 0x0b1560], NAX: [W, 0xd81939], LOT: [W, 0x11397e], AEE: [W, 0x0d2c6b], ITY: [0x0b3d91, 0xc8a45d],
  THY: [W, 0xc70a0c], PGT: [W, 0xfdc100], UAE: [W, 0xd71921], QTR: [0xdfe0e2, 0x5c0632], ETD: [0xe9dfc8, 0xbd8b13],
  SVA: [0xf0ead6, 0x0a6b3b], ELY: [W, 0x0038a8], MSR: [W, 0x00234b], ETH: [W, 0x078930], SAA: [W, 0xe03c31], RAM: [W, 0xc1272d],
  SIA: [W, 0x1d4886], CPA: [W, 0x006564], QFA: [W, 0xe0001b], ANZ: [W, 0x111111], JAL: [W, 0xcc0000], ANA: [W, 0x13448f],
  KAL: [0x9bd3e8, 0x154d9e], AAR: [W, 0x8a8d8f], CCA: [W, 0xd0021b], CES: [W, 0x1e3c8c], CSN: [W, 0x008bcb], CHH: [W, 0xe60012],
  AIC: [W, 0xd9232d], IGO: [W, 0x1a1f71], THA: [W, 0x5b2c83], MAS: [W, 0x003a70], GIA: [W, 0x00629b], PAL: [W, 0x0033a0],
};

export function liveryFor(callsign: string, hex: string): [number, number] {
  const prefix = callsign.slice(0, 3).toUpperCase();
  const known = LIVERY[prefix];
  if (known) return known;
  const h = hash(/^[A-Z]{3}/.test(prefix) ? prefix : hex);
  return [W, hsl(h % 360, 0.62, 0.42)];
}
