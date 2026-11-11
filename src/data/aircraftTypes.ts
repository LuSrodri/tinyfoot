import { M, buildAirframe, type AirframeSpec, type MeshDef } from '../gl/meshes';
import { cachedMesh } from '../gl/meshcache';
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

type Fam = 'N' | 'W' | 'Q' | 'R' | 'T' | 'L' | 'H';

// Real wingspans in metres where they differ from the family's usual proportion.
const SPAN: Record<string, number> = {
  A318: 34.1, A319: 35.8, A19N: 35.8, A320: 35.8, A20N: 35.8, A321: 35.8, A21N: 35.8, BCS1: 35.1, BCS3: 35.1,
  A306: 44.8, A30B: 44.8, A310: 43.9, A332: 60.3, A333: 60.3, A338: 64, A339: 64, A359: 64.8, A35K: 64.8,
  A342: 60.3, A343: 60.3, A345: 63.5, A346: 63.5, A388: 79.8, A400: 42.4,
  B712: 28.4, B732: 28.3, B733: 28.9, B734: 28.9, B735: 28.9, B736: 34.3, B737: 35.8, B738: 35.8, B739: 35.8,
  B37M: 35.9, B38M: 35.9, B39M: 35.9, B3XM: 35.9, B752: 38, B753: 38, B762: 47.6, B763: 47.6, B764: 51.9,
  B772: 60.9, B77L: 64.8, B773: 60.9, B77W: 64.8, B778: 71.8, B779: 71.8, B788: 60.1, B789: 60.1, B78X: 60.1,
  B741: 59.6, B742: 59.6, B744: 64.4, B748: 68.4, BLCF: 64.4, MD11: 51.7, DC10: 50.4,
  MD82: 32.9, MD83: 32.9, MD88: 32.9, MD90: 32.9, E170: 26, E75L: 28.7, E75S: 26, E190: 28.7, E195: 28.7,
  E290: 33.7, E295: 35.1, E135: 20, E145: 20, E45X: 21, CRJ1: 21.2, CRJ2: 21.2, CRJ7: 23.2, CRJ9: 24.9, CRJX: 26.2,
  AT43: 24.6, AT45: 24.6, AT46: 24.6, AT72: 27.1, AT75: 27.1, AT76: 27.1, DH8A: 25.9, DH8B: 25.9, DH8C: 27.4, DH8D: 28.4,
  C130: 40.4, C30J: 40.4, C17: 51.8, C5M: 67.9, K35R: 39.9, E3TF: 44.4, IL76: 50.5, IL96: 60.1, A124: 73.3, KC39: 35.1,
  GLF4: 23.7, GLF5: 28.5, GLF6: 30.4, GLEX: 28.7, GL7T: 31.7, SU95: 27.8, C919: 35.8, P8: 37.6,
};

/** Fuselage radius by type-code prefix. */
const RADIUS: [RegExp, number][] = [
  [/^A38/, 3.57], [/^B74|^BLCF/, 3.25], [/^B77/, 3.1], [/^A35/, 2.98], [/^B78/, 2.89], [/^(A33|A34|A30|A31)/, 2.82],
  [/^(MD11|DC10)/, 3.0], [/^B76/, 2.52], [/^(C17|C5M|A124|IL76)/, 3.3], [/^(K35R|E3TF)/, 1.88], [/^IL96/, 3.04],
  [/^(A31[89]|A32|A19N|A2[01]N)/, 1.98], [/^(B73|B3|B75|P8)/, 1.88], [/^BCS/, 1.75], [/^(E17|E75|E19|E29)/, 1.5],
  [/^(C919)/, 1.98], [/^SU95/, 1.73], [/^(C130|C30J|A400|KC39)/, 2.1], [/^AT[47]/, 1.43], [/^DH8/, 1.35],
];

const LOW_WING_PROPS = /^(SF34|SB20|JS41|B190|BE20|B350|BE9L|E120|E110|E314|PC12|TBM|P28|PA|P32|SR2|S22T|DA4|DA6|BE36|BE58|M20P)/;
const FOUR_PROPS = /^(C130|C30J|A400|AN12|P3)$/;
const TWIN_PISTONS = /^(PA34|PA44|DA42|DA62|BE58)$/;
const HIGH_WING_JETS = /^(C17|C5M|IL76|A124|KC39)$/;

function specFor(code: string, fam: Fam, len: number): AirframeSpec {
  const ratio = { N: 0.95, W: 0.95, Q: 1.0, R: 0.8, T: 1.0, L: 1.3, H: 1 }[fam];
  const span = SPAN[code] ?? len * ratio;
  const hit = RADIUS.find(([re]) => re.test(code));
  const prop = fam === 'T' || fam === 'L';
  const r = hit ? hit[1] : fam === 'W' ? 2.9 : fam === 'Q' ? 3.2 : fam === 'N' ? 1.9 : fam === 'R' ? Math.max(0.9, len * 0.046) : fam === 'T' ? Math.max(0.95, len * 0.05) : len * 0.075;
  const rootChord = Math.min(len * (prop ? 0.13 : 0.19), span * (prop ? 0.13 : 0.2));
  const highJet = HIGH_WING_JETS.test(code);
  return {
    len,
    span,
    r,
    wingAt: fam === 'R' ? 0.56 : fam === 'L' ? 0.32 : 0.45,
    sweep: prop ? span * 0.015 : span * (fam === 'R' ? 0.17 : 0.21),
    rootChord,
    tipChord: rootChord * (prop ? 0.6 : 0.27),
    highWing: highJet || (prop && !LOW_WING_PROPS.test(code)),
    tTail: fam === 'R' || highJet || /^(AT[47]|DH8D|B190|BE20|B350|PC12|A400)/.test(code),
    engines:
      fam === 'Q' ? 'under4'
      : fam === 'R' ? (/^(F900|FA7X|FA8X|FA50)$/.test(code) ? 'rear3' : 'rear2')
      : fam === 'T' ? (FOUR_PROPS.test(code) ? 'prop4' : /^(PC12|C208|TBM)/.test(code) ? 'prop1' : 'prop2')
      : fam === 'L' ? (TWIN_PISTONS.test(code) ? 'prop2' : 'prop1')
      : 'under2',
    hump: /^(B74|BLCF)/.test(code),
    doubleDeck: /^A38/.test(code),
    winglets: !prop && fam !== 'Q' && !/^(B73[2-5]|B75|B76|B772|B773|MD|DC10|E135|E145|CRJ[12])/.test(code),
  };
}

export interface TypeInfo {
  name: string;
  /** Real length in metres. */
  length: number;
  /** Index of this type's mesh in the 3D layer; built the first time the type is seen. */
  mesh(): number;
  /** Multiplier on the mesh (1 for generated airframes, which are built to real size). */
  scale: number;
}

let register: (mesh: MeshDef) => number = () => M.Heli;
/** The 3D layer hands us a way to add meshes at runtime. */
export function setMeshRegistrar(fn: (mesh: MeshDef) => number): void {
  register = fn;
}

function make(code: string, name: string, fam: Fam, length: number): TypeInfo {
  if (fam === 'H') return { name, length, scale: length / 12.5, mesh: () => M.Heli };
  let index = -1;
  return {
    name,
    length,
    scale: 1,
    mesh: () => {
      if (index < 0) index = register(cachedMesh(`air:${code}:${length}`, () => buildAirframe(specFor(code, fam, length))));
      return index;
    },
  };
}

const table = new Map<string, TypeInfo>();
for (const line of TYPES.trim().split('\n')) {
  const [code, name, fam, len] = line.split('|');
  table.set(code, make(code, name, fam as Fam, Number(len)));
}

/** Emitter category (ADS-B) fallbacks for types that are not in the table. */
const BY_CATEGORY: Record<string, TypeInfo> = {
  A1: make('?A1', '', 'L', 8.5),
  A2: make('?A2', '', 'R', 17),
  A3: make('?A3', '', 'N', 37),
  A4: make('?A4', '', 'N', 47),
  A5: make('?A5', '', 'W', 64),
  A6: make('?A6', '', 'R', 15),
  A7: make('?A7', '', 'H', 12.5),
  B1: make('?B1', '', 'L', 7),
  B4: make('?B4', '', 'L', 6),
  B6: make('?B6', '', 'L', 4),
};
const UNKNOWN = make('?', '', 'N', 24);

export function typeInfo(type: string | undefined, category: string | undefined): TypeInfo {
  if (type) {
    const hit = table.get(type);
    if (hit) return hit;
  }
  const base = (category && BY_CATEGORY[category]) || UNKNOWN;
  return type ? { ...base, name: type } : base;
}

// Liveries of well-known operators: [upper fuselage, fin and winglets, belly and engines].
const W = 0xf3f4f6;
const G = 0xc9ced4;
type Livery = [number, number, number];
const LIVERY: Record<string, Livery> = {
  AZU: [W, 0x1b4fa8, 0x1b4fa8], GLO: [W, 0xff6a13, 0xff6a13], TAM: [W, 0x2a0088, G], LAN: [W, 0x2a0088, G], LPE: [W, 0x2a0088, G],
  ARG: [W, 0x67b2e8, 0x67b2e8], AVA: [W, 0xe2231a, 0xe2231a], CMP: [W, 0x005aa3, 0x0b2a5b], AMX: [W, 0x0b2343, 0x0b2343],
  VOI: [W, 0xa3238e, 0x8dc63f], PTB: [W, 0xf7c600, 0x1d6fb7], SKU: [W, 0xd6007f, 0xd6007f], JAT: [W, 0xff4d00, 0xff4d00],
  AAL: [0xd9dde2, 0x0078d2, 0xb9bfc7], DAL: [W, 0xc8102e, 0x0b2a5b], UAL: [W, 0x0033a0, 0x8a9bb5], SWA: [0x304cb2, 0xffbf27, 0xc8102e],
  JBU: [W, 0x003876, 0x003876], ASA: [W, 0x01426a, 0x01426a], FFT: [W, 0x006643, G], NKS: [0xffec00, 0x111111, 0xffec00],
  ACA: [W, 0xd22630, 0x111111], WJA: [W, 0x00a4b4, 0x0b2a5b], FDX: [W, 0x4d148c, G], UPS: [W, 0x4b2e1e, 0x4b2e1e],
  DHK: [0xffcc00, 0xd40511, 0xffcc00], BCS: [0xffcc00, 0xd40511, 0xffcc00], GTI: [W, 0x003a70, 0x003a70],
  BAW: [W, 0x075aaa, 0x0b2a5b], VIR: [W, 0xe10a0a, 0xe10a0a], EZY: [W, 0xff6600, W], EJU: [W, 0xff6600, W], RYR: [W, 0x073590, 0x073590],
  WZZ: [W, 0xc6007e, 0xc6007e], DLH: [W, 0x05164d, G], EWG: [W, 0xa5027d, G], AFR: [W, 0x002157, W], TVF: [W, 0x00d66c, W],
  KLM: [0x00a1de, 0x00a1de, W], IBE: [W, 0xd7192d, G], VLG: [W, 0xffcc00, 0x5c6670], TAP: [W, 0x00a651, W], SWR: [W, 0xe2001a, W],
  AUA: [W, 0xe2001a, W], SAS: [0xe6e2d8, 0x2b3087, 0x2b3087], FIN: [W, 0x0b1560, W], NAX: [W, 0xd81939, W], LOT: [W, 0x11397e, W],
  AEE: [W, 0x0d2c6b, 0x0d2c6b], ITY: [0x0b3d91, 0xc8a45d, 0x0b3d91], THY: [W, 0xc70a0c, G], PGT: [W, 0xfdc100, W],
  UAE: [W, 0xd71921, W], QTR: [0xdfe0e2, 0x5c0632, 0xdfe0e2], ETD: [0xe9dfc8, 0xbd8b13, 0xe9dfc8], SVA: [0xf0ead6, 0x0a6b3b, 0xf0ead6],
  ELY: [W, 0x0038a8, W], MSR: [W, 0x00234b, W], ETH: [W, 0x078930, W], SAA: [W, 0xe03c31, W], RAM: [W, 0xc1272d, W],
  SIA: [W, 0x1d4886, W], CPA: [W, 0x006564, G], QFA: [W, 0xe0001b, W], ANZ: [W, 0x111111, W], JAL: [W, 0xcc0000, W], ANA: [W, 0x13448f, G],
  KAL: [0x9bd3e8, 0x9bd3e8, W], AAR: [W, 0x8a8d8f, W], CCA: [W, 0xd0021b, 0x1e3c8c], CES: [W, 0x1e3c8c, W], CSN: [W, 0x008bcb, W],
  CHH: [W, 0xe60012, G], AIC: [W, 0xd9232d, W], IGO: [W, 0x1a1f71, 0x1a1f71], THA: [W, 0x5b2c83, W], MAS: [W, 0x003a70, W],
  GIA: [W, 0x00629b, W], PAL: [W, 0x0033a0, W],
};

/** Colours for an aircraft: a known airline livery, or a stable colour derived from its operator code. */
export function liveryFor(callsign: string, hex: string): Livery {
  const prefix = callsign.slice(0, 3).toUpperCase();
  const known = LIVERY[prefix];
  if (known) return known;
  const h = hash(/^[A-Z]{3}/.test(prefix) ? prefix : hex);
  return [W, hsl(h % 360, 0.62, 0.42), G];
}
