import { calculateNormals } from 'playcanvas';
import { clamp01, fbm, rng, smoothstep } from './noise';
import jf from './jf-mundo.json';

// ---------------------------------------------------------------------------
// Juiz de Fora (MG), versão leve: dados reais do OpenStreetMap + relevo AWS Terrain Tiles,
// projetados e escalados por scripts/importar-jf.mjs (ESCALA 0,5) em src/flight/jf-mundo.json.
// Dados: © colaboradores do OpenStreetMap (ODbL).
// ---------------------------------------------------------------------------

export type MeshData = { pos: number[]; normals: number[]; idx: number[]; col: number[]; uv?: number[] };
const geometry = (pos: number[], idx: number[], col: number[], uv?: number[]): MeshData =>
  ({ pos, idx, col, uv, normals: calculateNormals(pos, idx) });

export type ImageData = {
  width: number; height: number;
  rectangles: { color: string; x: number; y: number; width: number; height: number }[];
  gradient: [number, string][];
};
const image = (width: number, height: number): ImageData => ({ width, height, rectangles: [], gradient: [] });
function painter(data: ImageData) {
  return {
    fillStyle: '' as string | { addColorStop: (offset: number, color: string) => void },
    createLinearGradient: (..._coordinates: number[]) => ({
      addColorStop: (offset: number, color: string) => { data.gradient.push([offset, color]); },
    }),
    fillRect(x: number, y: number, width: number, height: number) {
      if (typeof this.fillStyle === 'string') data.rectangles.push({ color: this.fillStyle, x, y, width, height });
    },
  };
}

export const WORLD_SIZE = 6000;
/** Retângulo ocupado pela cidade (ruas, bairros); o resto do mundo é só relevo. */
export const CITY = { x0: -2600, x1: 2600, z0: -2950, z1: 1450 };
/** Altura do Centro (m): referência do relevo; já não existe um "chão da cidade" plano. */
export const CITY_Y = 8;

// ---------------------------------------------------------------------------
// Relevo: grade de 30 m (a mesma malha do terreno e da física)
// ---------------------------------------------------------------------------
const GRID_N = jf.relevo.n, GRID_STEP = jf.relevo.passo, GRID_HALF = jf.relevo.meio;

function decodeGrid(b64: string) {
  const s = atob(b64), view = new DataView(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) view.setUint8(i, s.charCodeAt(i));
  const out = new Float32Array(GRID_N * GRID_N);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 10;
  return out;
}

/** Interpola na mesma diagonal b-c da malha do terreno (idx a,c,b e b,c,d): física e visual coincidem. */
function sampleGrid(g: Float32Array, x: number, z: number) {
  const fx = (Math.max(-GRID_HALF, Math.min(GRID_HALF, x)) + GRID_HALF) / GRID_STEP;
  const fz = (Math.max(-GRID_HALF, Math.min(GRID_HALF, z)) + GRID_HALF) / GRID_STEP;
  const i = Math.min(GRID_N - 2, Math.floor(fx)), j = Math.min(GRID_N - 2, Math.floor(fz));
  const u = fx - i, v = fz - j, a = g[j * GRID_N + i], b = g[j * GRID_N + i + 1], c = g[(j + 1) * GRID_N + i], d = g[(j + 1) * GRID_N + i + 1];
  return u + v <= 1 ? a + u * (b - a) + v * (c - a) : d + (1 - u) * (c - d) + (1 - v) * (b - d);
}

const rawGrid = decodeGrid(jf.relevo.dm);
const rawHeight = (x: number, z: number) => sampleGrid(rawGrid, x, z);

// ---------------------------------------------------------------------------
// Índice espacial das vias e do rio (distância até o eixo)
// ---------------------------------------------------------------------------
export const ROAD_CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'] as const;
export type RoadClass = typeof ROAD_CLASSES[number];
/** Largura do asfalto por categoria (m). A faixa desenhada inclui as calçadas (14% de cada lado). */
const ASPHALT = [15, 13, 11, 9, 7.5];
const stripWidth = (cls: number) => ASPHALT[cls] / 0.72;
const LIFT = [.16, .15, .14, .13, .12];
const RIVER_WIDTH = 12;

interface Segment { x0: number; z0: number; x1: number; z1: number; half: number; cls: number }
const HASH = 64;
const hashKey = (gx: number, gz: number) => gx * 4096 + gz;
const segmentGrid = new Map<number, Segment[]>();
const segments: Segment[] = [];
function addSegment(s: Segment) {
  segments.push(s);
  const gx0 = Math.floor(Math.min(s.x0, s.x1) / HASH), gx1 = Math.floor(Math.max(s.x0, s.x1) / HASH);
  const gz0 = Math.floor(Math.min(s.z0, s.z1) / HASH), gz1 = Math.floor(Math.max(s.z0, s.z1) / HASH);
  for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
    const key = hashKey(gx, gz); let list = segmentGrid.get(key);
    if (!list) segmentGrid.set(key, list = []);
    list.push(s);
  }
}
for (let c = 0; c < ROAD_CLASSES.length; c++) for (const way of jf.vias[ROAD_CLASSES[c]] as number[][]) {
  for (let i = 0; i + 3 < way.length; i += 2) addSegment({ x0: way[i], z0: way[i + 1], x1: way[i + 2], z1: way[i + 3], half: stripWidth(c) / 2, cls: c });
}
const RIVER_CLS = 9;
for (const piece of jf.rio as number[][]) {
  for (let i = 0; i + 3 < piece.length; i += 2) addSegment({ x0: piece[i], z0: piece[i + 1], x1: piece[i + 2], z1: piece[i + 3], half: RIVER_WIDTH / 2, cls: RIVER_CLS });
}

function distToSegment(s: Segment, x: number, z: number) {
  const dx = s.x1 - s.x0, dz = s.z1 - s.z0, len2 = dx * dx + dz * dz;
  const t = len2 ? Math.max(0, Math.min(1, ((x - s.x0) * dx + (z - s.z0) * dz) / len2)) : 0;
  return { d: Math.hypot(x - s.x0 - dx * t, z - s.z0 - dz * t), t };
}
/** Menor folga (m) até a borda de uma via ou do rio; negativa dentro da faixa. Infinity além de ~64 m. */
function gapToRoads(x: number, z: number) {
  const gx = Math.floor(x / HASH), gz = Math.floor(z / HASH);
  let best = Infinity;
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
    for (const s of segmentGrid.get(hashKey(gx + a, gz + b)) ?? []) {
      const g = distToSegment(s, x, z).d - s.half;
      if (g < best) best = g;
    }
  }
  return best;
}
export interface RoadPoint { x: number; z: number; heading: number; cls: number; distance: number }
/** Ponto do eixo de via mais próximo (apenas categorias até `maxClass`); heading em graus, 0 = norte. */
export function nearestRoad(x: number, z: number, maxClass = 3, minDistance = 0): RoadPoint | undefined {
  for (const r of [64, 128, 256, 512, 1024, 2048]) {
    let best: RoadPoint | undefined;
    for (let gx = Math.floor((x - r) / HASH); gx <= Math.floor((x + r) / HASH); gx++) for (let gz = Math.floor((z - r) / HASH); gz <= Math.floor((z + r) / HASH); gz++) {
      for (const s of segmentGrid.get(hashKey(gx, gz)) ?? []) {
        if (s.cls > maxClass) continue;
        const { d, t } = distToSegment(s, x, z);
        if (d < minDistance || (best && d >= best.distance)) continue;
        best = { x: s.x0 + (s.x1 - s.x0) * t, z: s.z0 + (s.z1 - s.z0) * t, heading: (Math.atan2(s.x1 - s.x0, -(s.z1 - s.z0)) * 180 / Math.PI + 360) % 360, cls: s.cls, distance: d };
      }
    }
    if (best && best.distance <= r) return best;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Pista, marcos e lotes planos
// ---------------------------------------------------------------------------
const RWY_A = { x: jf.pista.a[0], z: jf.pista.a[1] };
const RWY_B = { x: jf.pista.b[0], z: jf.pista.b[1] };
const RWY_LEN = Math.hypot(RWY_B.x - RWY_A.x, RWY_B.z - RWY_A.z);
const RWY_U = { x: (RWY_B.x - RWY_A.x) / RWY_LEN, z: (RWY_B.z - RWY_A.z) / RWY_LEN };
/** s: distância ao longo da pista a partir da cabeceira sul; l: deslocamento lateral (+ = direita da pista). */
const runwayFrame = (x: number, z: number) => {
  const dx = x - RWY_A.x, dz = z - RWY_A.z;
  return { s: dx * RWY_U.x + dz * RWY_U.z, l: dx * -RWY_U.z + dz * RWY_U.x };
};
const runwayPoint = (s: number, l: number) => ({ x: RWY_A.x + RWY_U.x * s - RWY_U.z * l, z: RWY_A.z + RWY_U.z * s + RWY_U.x * l });
const sortedMedian = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
const RUNWAY_FLAT = Math.fround(sortedMedian(Array.from({ length: 40 }, (_, i) => { const p = runwayPoint(RWY_LEN * i / 39, 0); return rawHeight(p.x, p.z); })));
const RUNWAY_HEIGHT = RUNWAY_FLAT + .05;
const RUNWAY_AT_410 = runwayPoint((410 - RWY_A.z) / RWY_U.z, 0);

// O vento predominante e o fdm usam o rumo da pista real (03/21 do SBJF, quase norte-sul).
export const AIRPORT = {
  x: RUNWAY_AT_410.x, z: 410, y: RUNWAY_HEIGHT, length: RWY_LEN, width: jf.pista.largura,
  /** Cabeceira sul (início da pista, s = 0). */
  southX: RWY_A.x, southZ: RWY_A.z,
  heading: (Math.atan2(RWY_U.x, -RWY_U.z) * 180 / Math.PI + 360) % 360,
};
export const isRunway = (x: number, z: number) => {
  const { s, l } = runwayFrame(x, z);
  return s >= 0 && s <= RWY_LEN && Math.abs(l) <= AIRPORT.width / 2;
};
/** Hangar aberto ao lado da pista (caixa alinhada aos eixos, 40 x 35 m). */
const hangarCenter = runwayPoint((267 - RWY_A.z) / RWY_U.z, 0);
export const HANGAR = { x0: hangarCenter.x + 30, x1: hangarCenter.x + 70, z0: 250, z1: 285 };

const dcCentro = (x: number, z: number) => Math.hypot(x - jf.marcos.centro[0], z - jf.marcos.centro[1]);

/** Procura, em espiral, um ponto com folga mínima das vias e sem inclinação forte. */
function freeSpot(x: number, z: number, clearance: number, maxSlope: number, start = 0) {
  for (let r = start; r < 600; r += 12) {
    for (let k = 0, n = Math.max(1, Math.round(r / 12) * 6); k < n; k++) {
      const a = k / n * Math.PI * 2, px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      if (gapToRoads(px, pz) < clearance) continue;
      let slope = 0;
      for (const [dx, dz] of [[clearance, 0], [-clearance, 0], [0, clearance], [0, -clearance]]) slope = Math.max(slope, Math.abs(rawHeight(px + dx, pz + dz) - rawHeight(px, pz)) / clearance);
      if (slope <= maxSlope) return { x: px, z: pz };
    }
  }
  return { x, z };
}

const UNI_LOT = freeSpot(jf.marcos.uniacademia[0], jf.marcos.uniacademia[1], 44, .22);
const UNI_ROAD = nearestRoad(UNI_LOT.x, UNI_LOT.z, 4)!;
const WORKSHOP_SPOT = freeSpot(jf.marcos.pocoRico[0], jf.marcos.pocoRico[1], 22, .2, 20);
const CRISTO = { x: jf.marcos.cristo[0], z: jf.marcos.cristo[1] };
const TOWER_SPOT = freeSpot(jf.marcos.centro[0] + 40, jf.marcos.centro[1] + 40, 26, .12);

interface Flat { x: number; z: number; inner: number; outer: number; y?: number }
const flats: Flat[] = [
  { x: UNI_LOT.x, z: UNI_LOT.z, inner: 38, outer: 80 },
  { x: WORKSHOP_SPOT.x, z: WORKSHOP_SPOT.z, inner: 14, outer: 40 },
  { x: CRISTO.x, z: CRISTO.z, inner: 12, outer: 36 },
  { x: TOWER_SPOT.x, z: TOWER_SPOT.z, inner: 22, outer: 50 },
];

const heightGrid = (() => {
  const g = Float32Array.from(rawGrid);
  for (let j = 0; j < GRID_N; j++) for (let i = 0; i < GRID_N; i++) {
    const x = -GRID_HALF + i * GRID_STEP, z = -GRID_HALF + j * GRID_STEP;
    let h = g[j * GRID_N + i];
    // pista: faixa plana de 150 m de largura, com transição suave nas bordas
    const { s, l } = runwayFrame(x, z);
    const ds = Math.max(-50 - s, 0, s - RWY_LEN - 50), dl = Math.max(Math.abs(l) - 75, 0), d = Math.hypot(ds, dl);
    const w = 1 - smoothstep(0, 90, d);
    h = h * (1 - w) + RUNWAY_FLAT * w;
    for (const f of flats) {
      const fw = 1 - smoothstep(0, f.outer - f.inner, Math.max(0, Math.hypot(x - f.x, z - f.z) - f.inner));
      if (fw > 0) h = h * (1 - fw) + (f.y ?? rawHeight(f.x, f.z)) * fw;
    }
    g[j * GRID_N + i] = h;
  }
  return g;
})();

/** Altura do terreno (m). Mínimo de 2 m: Juiz de Fora não tem mar. */
export function terrainHeight(x: number, z: number) {
  return sampleGrid(heightGrid, x, z);
}

const hex = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);

// ---------------------------------------------------------------------------
// Terreno
// ---------------------------------------------------------------------------
const GRASS = hex('#74a755');
const LUSH = hex('#4d8a4b');
const DRY = hex('#b4a35a');
const SOIL = hex('#a9835a');
const ROCK = hex('#8d8896');

export function terrainData() {
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  for (let j = 0; j < GRID_N; j++) {
    for (let i = 0; i < GRID_N; i++) {
      const x = -GRID_HALF + i * GRID_STEP, z = -GRID_HALF + j * GRID_STEP, h = heightGrid[j * GRID_N + i];
      pos.push(x, h, z);
      const hx = heightGrid[j * GRID_N + Math.min(GRID_N - 1, i + 1)] - heightGrid[j * GRID_N + Math.max(0, i - 1)];
      const hz = heightGrid[Math.min(GRID_N - 1, j + 1) * GRID_N + i] - heightGrid[Math.max(0, j - 1) * GRID_N + i];
      const slope = Math.hypot(hx, hz) / (2 * GRID_STEP);
      const patch = fbm(x / 140, z / 140, 3, 21);
      let c = mix(GRASS, patch > 0.55 ? DRY : LUSH, smoothstep(0.38, 0.62, patch));
      c = mix(c, SOIL, smoothstep(0.35, 0.6, slope) * 0.8);
      c = mix(c, ROCK, smoothstep(0.55, 0.95, slope) + smoothstep(170, 230, h) * 0.35);
      col.push(c[0], c[1], c[2], 255);
    }
  }
  for (let j = 0; j < GRID_N - 1; j++) {
    for (let i = 0; i < GRID_N - 1; i++) {
      const a = j * GRID_N + i, b = a + 1, c = a + GRID_N, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  return geometry(pos, idx, col);
}

const WINDOW_M = 3.2;
const TEX_WINDOWS = 16;
const FACADES = ['#9aa3b5', '#7c86a3', '#c9b79a', '#b97a5f', '#6f9ea3', '#a99ab8', '#d8d2c4', '#5f6b8a'].map(hex);

export type Box = { x0: number; x1: number; z0: number; z1: number; top: number; bottom?: number; curb?: boolean; radius?: number; x?: number; z?: number; ramp?: { x0:number; z0:number; x1:number; z1:number; y0:number; y1:number } };

// ---------------------------------------------------------------------------
// Polígonos (praças, estádios, universidades, aeroporto)
// ---------------------------------------------------------------------------
interface Polygon { pts: number[]; nome: string; x0: number; x1: number; z0: number; z1: number }
const polygons = (list: { pts: number[]; nome: string }[]): Polygon[] => list.map((p) => {
  const xs = p.pts.filter((_, i) => i % 2 === 0), zs = p.pts.filter((_, i) => i % 2 === 1);
  return { ...p, x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
});
const parkPolys = polygons(jf.parques), stadiumPolys = polygons(jf.estadios), universityPolys = polygons(jf.universidades);
const airportPolys = polygons(jf.aeroporto ? [jf.aeroporto] : []);
function inside(p: Polygon, x: number, z: number) {
  if (x < p.x0 || x > p.x1 || z < p.z0 || z > p.z1) return false;
  let c = false;
  for (let i = 0, j = p.pts.length - 2; i < p.pts.length; j = i, i += 2) {
    const xi = p.pts[i], zi = p.pts[i + 1], xj = p.pts[j], zj = p.pts[j + 1];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c;
  }
  return c;
}
const allAreas = [...parkPolys, ...stadiumPolys, ...universityPolys, ...airportPolys];
const inAnyArea = (x: number, z: number) => allAreas.some((p) => inside(p, x, z));

// ---------------------------------------------------------------------------
// Prédios: lotes procedurais ao longo das vias, mais altos no Centro
// ---------------------------------------------------------------------------
export type CityData = ReturnType<typeof buildCity>;
let cityCache: CityData | undefined;
/** Resultado memorizado (determinístico): quem recebe não deve alterá-lo. */
export function cityData(): CityData { return cityCache ??= buildCity(); }

function buildCity() {
  const boxes: Box[] = [];
  const r = rng(2024);
  const pos: number[] = [], col: number[] = [], uv: number[] = [], idx: number[] = [];
  const ROOF_UV = 0.5 / TEX_WINDOWS;
  const hash = new Map<number, Box[]>();
  const put = (b: Box) => {
    boxes.push(b);
    for (let gx = Math.floor(b.x0 / 100); gx <= Math.floor(b.x1 / 100); gx++) for (let gz = Math.floor(b.z0 / 100); gz <= Math.floor(b.z1 / 100); gz++) {
      const k = hashKey(gx, gz); let l = hash.get(k); if (!l) hash.set(k, l = []); l.push(b);
    }
  };
  const overlaps = (x0: number, x1: number, z0: number, z1: number) => {
    for (let gx = Math.floor(x0 / 100); gx <= Math.floor(x1 / 100); gx++) for (let gz = Math.floor(z0 / 100); gz <= Math.floor(z1 / 100); gz++) {
      for (const b of hash.get(hashKey(gx, gz)) ?? []) if (x0 < b.x1 + 2 && x1 > b.x0 - 2 && z0 < b.z1 + 2 && z1 > b.z0 - 2) return true;
    }
    return false;
  };
  const addBuilding = (x: number, z: number, w: number, d: number, h: number, c: number[]) => {
    const x0 = x - w / 2, x1 = x + w / 2, z0 = z - d / 2, z1 = z + d / 2;
    const heights = [terrainHeight(x0, z0), terrainHeight(x1, z0), terrainHeight(x0, z1), terrainHeight(x1, z1)];
    const y0 = Math.min(...heights) - 1, y1 = Math.max(...heights) + h;
    const shade = 0.85 + r() * 0.3;
    const [cr, cg, cb] = c.map((v) => Math.min(255, v * shade));
    const roof = [cr * 0.75, cg * 0.75, cb * 0.75];
    const vScale = (y1 - y0) / WINDOW_M / TEX_WINDOWS;
    const u0 = Math.floor(r() * TEX_WINDOWS) / TEX_WINDOWS;
    const faces: [number, number, number, number][] = [[x0, z1, x1, z1], [x1, z1, x1, z0], [x1, z0, x0, z0], [x0, z0, x0, z1]];
    for (const [ax, az, bx, bz] of faces) {
      const base = pos.length / 3, len = Math.hypot(bx - ax, bz - az), uMax = u0 + len / WINDOW_M / TEX_WINDOWS;
      pos.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az);
      uv.push(u0, 0, uMax, 0, uMax, vScale, u0, vScale);
      for (let k = 0; k < 4; k++) col.push(cr, cg, cb, 255);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const base = pos.length / 3;
    pos.push(x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0);
    for (let k = 0; k < 4; k++) { uv.push(ROOF_UV, ROOF_UV); col.push(roof[0], roof[1], roof[2], 255); }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    const box: Box = { x0, x1, z0, z1, top: y1, bottom: y0 };
    put(box);
    return box;
  };

  // Torre do heliponto: prédio alto do Centro, com rampa externa até a laje
  const tower = addBuilding(TOWER_SPOT.x, TOWER_SPOT.z, 26, 26, 46, hex('#9aa3b5'));
  const helipad = { x: (tower.x0 + tower.x1) / 2, z: (tower.z0 + tower.z1) / 2, y: tower.top };

  const RESERVED = [
    { x: UNI_LOT.x, z: UNI_LOT.z, r: 62 }, { x: WORKSHOP_SPOT.x, z: WORKSHOP_SPOT.z, r: 26 }, { x: CRISTO.x, z: CRISTO.z, r: 34 },
  ];
  const PITCH = 34;
  for (let gz = -2900; gz <= 2900; gz += PITCH) {
    for (let gx = -2900; gx <= 2900; gx += PITCH) {
      const cx = gx + (r() - 0.5) * 14, cz = gz + (r() - 0.5) * 14;
      const roll = r(), sizeRoll = r(), heightRoll = r(), facade = Math.floor(r() * FACADES.length);
      const gap = gapToRoads(cx, cz);
      if (gap < 7 || gap > 44) continue;
      const dc = dcCentro(cx, cz);
      if (roll > 0.14 + 0.78 * Math.exp(-((dc / 1500) ** 2))) continue;
      if (inAnyArea(cx, cz) || RESERVED.some((q) => Math.hypot(cx - q.x, cz - q.z) < q.r)) continue;
      const { s, l } = runwayFrame(cx, cz);
      if (s > -120 && s < RWY_LEN + 120 && Math.abs(l) < 140) continue;
      const downtown = dc < 650, mid = dc < 1400, tall = Math.exp(-((dc / 380) ** 2));
      const w = downtown ? 18 + sizeRoll * 10 : mid ? 12 + sizeRoll * 8 : 9 + sizeRoll * 5;
      const d = downtown ? 18 + ((sizeRoll * 7) % 1) * 10 : mid ? 12 + ((sizeRoll * 7) % 1) * 8 : 9 + ((sizeRoll * 7) % 1) * 5;
      const h = downtown ? 14 + heightRoll * 20 + tall * (20 + heightRoll * 40) : mid ? 8 + heightRoll * 10 : 4.5 + heightRoll * 3.5;
      const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
      if (overlaps(x0, x1, z0, z1)) continue;
      if ([[x0, z0], [x1, z0], [x0, z1], [x1, z1]].some(([px, pz]) => gapToRoads(px, pz) < 2.5)) continue;
      const hs = [terrainHeight(x0, z0), terrainHeight(x1, z0), terrainHeight(x0, z1), terrainHeight(x1, z1)];
      if (Math.max(...hs) - Math.min(...hs) > 3.6) continue;
      addBuilding(cx, cz, w, d, h, FACADES[facade]);
    }
  }

  // Parques/praças (compatível com o minimapa): caixas dos polígonos reais
  const parks: Box[] = parkPolys.map((p) => ({ x0: p.x0, x1: p.x1, z0: p.z0, z1: p.z1, top: terrainHeight((p.x0 + p.x1) / 2, (p.z0 + p.z1) / 2) }));
  // Quarteirões: agrupamento dos prédios em células de 160 m
  const cells = new Map<number, Box>();
  for (const b of boxes) {
    const k = hashKey(Math.floor((b.x0 + b.x1) / 2 / 160), Math.floor((b.z0 + b.z1) / 2 / 160)), c = cells.get(k);
    if (!c) cells.set(k, { x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1, top: b.top });
    else { c.x0 = Math.min(c.x0, b.x0); c.x1 = Math.max(c.x1, b.x1); c.z0 = Math.min(c.z0, b.z0); c.z1 = Math.max(c.z1, b.z1); c.top = Math.max(c.top, b.top); }
  }
  return { mesh: geometry(pos, idx, col, uv), boxes, parks, blocks: [...cells.values()], helipad, tower };
}

export function windowImages() {
  const px = 16;
  const size = px * TEX_WINDOWS;
  const r = rng(77);
  const diffuse = image(size, size);
  const emissive = image(size, size);
  const gd = painter(diffuse);
  const ge = painter(emissive);
  gd.fillStyle = '#ffffff'; // fachada (tingida pela cor do vértice)
  gd.fillRect(0, 0, size, size);
  ge.fillStyle = '#000000';
  ge.fillRect(0, 0, size, size);
  for (let y = 0; y < TEX_WINDOWS; y++) {
    for (let x = 0; x < TEX_WINDOWS; x++) {
      // Célula (0,0) fica sem janela: usada pelos telhados
      if (x === 0 && y === 0) continue;
      const wx = x * px + 4;
      const wy = y * px + 3;
      gd.fillStyle = '#2b3550';
      gd.fillRect(wx, wy, 8, 10);
      const v = r();
      if (v < 0.42) {
        ge.fillStyle = v < 0.08 ? '#bfe3ff' : v < 0.3 ? '#ffd27a' : '#ff9f4a';
        ge.fillRect(wx, wy, 8, 10);
      }
    }
  }
  return { diffuse, emissive };
}

export function skyImage() {
  const c = image(4, 256);
  const g = painter(c);
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#3e3f86'); // topo
  grad.addColorStop(0.32, '#8a6fb8');
  grad.addColorStop(0.47, '#f2a27a');
  grad.addColorStop(0.5, '#fbb98c'); // horizonte
  grad.addColorStop(1, '#fbb98c');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  return c;
}

export type CloudData = { position: [number, number, number]; puffs: { shade: boolean; scale: [number, number, number]; position: [number, number, number] }[] };
export function cloudData() {
  const r = rng(5);
  const clouds: CloudData[] = [];
  for (let i = 0; i < 46; i++) {
    const cx = (r() - 0.5) * WORLD_SIZE * 1.1;
    const cz = (r() - 0.5) * WORLD_SIZE * 1.1;
    const cy = 650 + r() * 500;
    const parts = 3 + Math.floor(r() * 4);
    const g: CloudData = { position: [cx, cy, cz], puffs: [] };
    clouds.push(g);
    for (let k = 0; k < parts; k++) {
      const s = 70 + r() * 110;
      g.puffs.push({
        shade: k === 0, scale: [s * 1.7, s * 0.45, s],
        position: [(r() - 0.5) * 220, k === 0 ? -15 : r() * 25, (r() - 0.5) * 140],
      });
    }
  }
  return clouds;
}

export type WorldPart = { name: string; mesh: MeshData };

// ---------------------------------------------------------------------------
// Aeroporto da Serrinha (pista real, plana), hangar, heliponto e rampa de acesso
// ---------------------------------------------------------------------------
/** Pista, hangar e heliponto compartilhados entre o jogo e a exportação para GLB. */
export function airportData(helipad = cityData().helipad, roof: Box = cityData().tower) {
  const parts: WorldPart[] = [];
  const rectangle = (name: string, x: number, y: number, z: number, w: number, d: number, color: number[]) => {
    parts.push({ name, mesh: geometry([x-w/2,y,z+d/2, x+w/2,y,z+d/2, x+w/2,y,z-d/2, x-w/2,y,z-d/2], [0,1,2,0,2,3], Array.from({ length: 4 }, () => [...color,255]).flat()) });
  };
  /** Retângulo no sistema da pista: s ao longo (sul→norte), l lateral. */
  const strip = (name: string, s0: number, s1: number, l0: number, l1: number, lift: number, color: number[]) => {
    const p = [runwayPoint(s0, l0), runwayPoint(s1, l0), runwayPoint(s1, l1), runwayPoint(s0, l1)];
    // ordem sul-esquerda, norte-esquerda, norte-direita, sul-direita: normal para cima
    parts.push({ name, mesh: geometry(p.flatMap((q) => [q.x, AIRPORT.y + lift, q.z]), [0,2,1,0,3,2], Array.from({ length: 4 }, () => [...color,255]).flat()) });
  };
  const white = [245,240,215];
  strip('Pista 03/21', 0, RWY_LEN, -15, 15, 0, [55,58,65]);
  for (let s = 40; s <= RWY_LEN - 40; s += 40) strip('Faixa central', s - 10, s + 10, -.5, .5, .02, white);
  for (const s of [5, RWY_LEN - 25]) for (const l of [-10,-6,6,10]) strip('Cabeceira', s, s + 20, l - 1, l + 1, .02, white);
  for (const l of [-14, 14]) strip('Borda', 0, RWY_LEN, l - .15, l + .15, .02, white);
  // Hangar aberto: três paredes e telhado; a porta continua transitável.
  const top = AIRPORT.y + 12;
  const boxes: Box[] = [
    { x0: HANGAR.x0, x1: HANGAR.x0 + 1, z0: HANGAR.z0, z1: HANGAR.z1, top, bottom: AIRPORT.y - 1 },
    { x0: HANGAR.x1 - 1, x1: HANGAR.x1, z0: HANGAR.z0, z1: HANGAR.z1, top, bottom: AIRPORT.y - 1 },
    { x0: HANGAR.x0, x1: HANGAR.x1, z0: HANGAR.z0, z1: HANGAR.z0 + 1, top, bottom: AIRPORT.y - 1 },
  ];
  const wall = (b: Box) => {
    const { x0, x1, z0, z1 } = b, y = AIRPORT.y;
    const p = [x0,y,z1,x1,y,z1,x1,top,z1,x0,top,z1, x1,y,z0,x0,y,z0,x0,top,z0,x1,top,z0, x0,y,z0,x0,y,z1,x0,top,z1,x0,top,z0, x1,y,z1,x1,y,z0,x1,top,z0,x1,top,z1];
    parts.push({ name: 'Parede do hangar', mesh: geometry(p, Array.from({ length: 4 }, (_, i) => [i*4,i*4+1,i*4+2,i*4,i*4+2,i*4+3]).flat(), Array.from({ length: 16 }, () => [150,165,180,255]).flat()) });
  };
  boxes.forEach(wall);
  const hx = (HANGAR.x0 + HANGAR.x1) / 2, hz = (HANGAR.z0 + HANGAR.z1) / 2, hw = HANGAR.x1 - HANGAR.x0, hd = HANGAR.z1 - HANGAR.z0;
  rectangle('Cobertura do hangar', hx, top, hz, hw, hd, [115,130,145]);
  rectangle('Piso do hangar', hx, AIRPORT.y, hz, hw, hd, [100,105,110]);
  boxes.push({ x0: HANGAR.x0, x1: HANGAR.x1, z0: HANGAR.z0, z1: HANGAR.z1, top, bottom: top - .2 });
  // Heliponto no alto da torre do Centro
  const { x, y, z } = helipad;
  rectangle('Heliponto', x, y + .01, z, 24, 24, [60,70,75]);
  for (const dx of [-5, 5]) rectangle('H', x + dx, y + .03, z, 1.5, 14, [245,230,110]);
  rectangle('H', x, y + .03, z, 10, 1.5, [245,230,110]);
  // Rampa externa em zigue-zague: rota contínua a pé da rua até a laje.
  const ground0 = terrainHeight(roof.x1 + 2, roof.z1 + 2);
  const access = [{ x: roof.x1 + 2, y: ground0, z: roof.z1 + 2 }];
  const corners = [[roof.x1 + 2, roof.z0 - 2], [roof.x0 - 2, roof.z0 - 2], [roof.x0 - 2, roof.z1 + 2], [roof.x1 + 2, roof.z1 + 2]];
  function rampTo(x: number, z: number, y: number) {
    const a = access[access.length - 1], dx = x - a.x, dz = z - a.z, length = Math.hypot(dx, dz);
    const px = dz / length * 1.2, pz = -dx / length * 1.2;
    parts.push({ name: 'Acesso ao heliponto', mesh: geometry([a.x+px,a.y,a.z+pz,a.x-px,a.y,a.z-pz,x-px,y,z-pz,x+px,y,z+pz],
      [0,1,2,0,2,3], Array.from({ length: 4 }, () => [155,160,165,255]).flat()) });
    boxes.push({ x0: Math.min(a.x,x) - Math.abs(px), x1: Math.max(a.x,x) + Math.abs(px),
      z0: Math.min(a.z,z) - Math.abs(pz), z1: Math.max(a.z,z) + Math.abs(pz), top: y, bottom: a.y - .12,
      ramp: { x0: a.x, z0: a.z, x1: x, z1: z, y0: a.y, y1: y } });
    access.push({ x, y, z });
  }
  for (let i = 0; access[access.length - 1].y < helipad.y - .001; i++) {
    const a = access[access.length - 1], [cx, cz] = corners[i % 4], length = Math.hypot(cx - a.x, cz - a.z);
    const ratio = Math.min(1, (helipad.y - a.y) / (.25 * length));
    rampTo(a.x + (cx - a.x) * ratio, a.z + (cz - a.z) * ratio, a.y + length * ratio * .25);
  }
  const end = access[access.length - 1];
  rampTo(Math.max(roof.x0 + 1, Math.min(roof.x1 - 1, end.x)), Math.max(roof.z0 + 1, Math.min(roof.z1 - 1, end.z)), helipad.y);
  return { parts, boxes, helipad, access };
}

function insideBox(b: Box, x: number, z: number) {
  return b.radius !== undefined ? Math.hypot(x - b.x!, z - b.z!) <= b.radius : x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1;
}

function boxTop(b: Box, x: number, z: number) {
  if (!b.ramp) return b.top;
  const r = b.ramp, dx = r.x1 - r.x0, dz = r.z1 - r.z0;
  const t = Math.max(0, Math.min(1, ((x - r.x0) * dx + (z - r.z0) * dz) / (dx * dx + dz * dz)));
  return r.y0 + (r.y1 - r.y0) * t;
}

export interface CapsulePosition { x: number; y: number; z: number }
/** Box broad phase and small swept steps prevent tunnelling; y is the capsule's feet. */
/** `flatGround` (testes): terreno plano nessa altura em vez do relevo real. */
export function createWorldPhysics(boxes?: Box[], flatGround?: number) {
  if (!boxes) {
    const city = cityData(), details = cityDetails(city);
    boxes = [...city.boxes, ...details.boxes, ...airportData(city.helipad).boxes, ...landmarkBoxes()];
  }
  const grid = new Map<string, Box[]>();
  for (const b of boxes) for (let gx = Math.floor(b.x0 / 100); gx <= Math.floor(b.x1 / 100); gx++) {
    for (let gz = Math.floor(b.z0 / 100); gz <= Math.floor(b.z1 / 100); gz++) {
      const key = `${gx},${gz}`; if (!grid.has(key)) grid.set(key, []); grid.get(key)!.push(b);
    }
  }
  function nearby(x: number, z: number, r = 0) {
    const found = new Set<Box>();
    for (let gx = Math.floor((x - r) / 100); gx <= Math.floor((x + r) / 100); gx++) for (let gz = Math.floor((z - r) / 100); gz <= Math.floor((z + r) / 100); gz++) {
      for (const b of grid.get(`${gx},${gz}`) ?? []) found.add(b);
    }
    return found;
  }
  function surfaceAt(x: number, z: number, ceiling = Infinity) {
    let h = Math.max(flatGround ?? terrainHeight(x, z), 0);
    if (isRunway(x, z) || (x >= HANGAR.x0 && x <= HANGAR.x1 && z >= HANGAR.z0 && z <= HANGAR.z1)) h = Math.max(h, AIRPORT.y);
    for (const b of nearby(x, z)) if (insideBox(b, x, z) && boxTop(b, x, z) <= ceiling) h = Math.max(h, boxTop(b, x, z));
    return h;
  }
  function obstacleAt(x: number, z: number, y: number, radius = 0, height = 1.8) {
    for (const b of nearby(x, z, radius)) {
      const dx = x - Math.max(b.x0, Math.min(b.x1, x)), dz = z - Math.max(b.z0, Math.min(b.z1, z));
      if (b.curb && y >= terrainHeight(x, z) - .02) continue;
      const top = boxTop(b, x, z), bottom = b.ramp ? top - .12 : (b.bottom ?? -1);
      // A small foot-step allowance keeps capsule edges from snagging on ramp corners.
      if (b.ramp && radius > 0 && y >= top - .4) continue;
      if ((b.radius !== undefined ? Math.hypot(x - b.x!, z - b.z!) <= radius + b.radius : dx * dx + dz * dz <= radius * radius) && y < top - .01 && y + height > bottom + .01) return b;
    }
    return undefined;
  }
  function moveCapsule(p: CapsulePosition, dx: number, dz: number, radius: number, height: number, maxSlope = .65) {
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / Math.min(.2, radius / 2)));
    const result = { ...p };
    const tryAxis = (axis: 'x' | 'z', delta: number) => {
      const x = Math.max(-2980, Math.min(2980, result.x + (axis === 'x' ? delta : 0))), z = Math.max(-2980, Math.min(2980, result.z + (axis === 'z' ? delta : 0)));
      const floor = surfaceAt(x, z, result.y + .35), old = surfaceAt(result.x, result.z, result.y + .35);
      const onRamp = [...nearby(x, z)].some((b) => b.ramp && x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && Math.abs(boxTop(b, x, z) - floor) < .01);
      const slopeLimit = onRamp ? Math.max(.35, Math.abs(delta) * maxSlope) : Math.abs(delta) * maxSlope + .001;
      if (!obstacleAt(x, z, Math.max(result.y, floor), radius, height) && floor - old <= slopeLimit) {
        result[axis] = axis === 'x' ? x : z;
        if (result.y <= old + .1) result.y = Math.max(result.y, floor);
      }
    };
    for (let i = 0; i < n; i++) { tryAxis('x', dx / n); tryAxis('z', dz / n); }
    return result;
  }
  return { groundAt: (x: number, z: number) => surfaceAt(x, z), surfaceAt, obstacleAt, moveCapsule, isRunway };
}

// ---------------------------------------------------------------------------
// Lugares do jogo (posições reais da cidade, ajustadas ao relevo e às ruas)
// ---------------------------------------------------------------------------
const WORKSHOP_Y = terrainHeight(WORKSHOP_SPOT.x, WORKSHOP_SPOT.z);
/** Oficina do Parafuso Perdido, no Poço Rico (lote plano ao lado da via). */
export const WORKSHOP = { x: WORKSHOP_SPOT.x, y: WORKSHOP_Y, z: WORKSHOP_SPOT.z };

/** Lote livre e plano da UniAcademia (Academia de Comércio, Centro): o modelo do Gemini fica aqui, frente para -Z local. */
export const UNIACADEMIA = (() => {
  const toward = Math.atan2(UNI_ROAD.x - UNI_LOT.x, -(UNI_ROAD.z - UNI_LOT.z)) * 180 / Math.PI;
  const heading = (Math.round(toward / 90) * 90 + 360) % 360;
  return { x: UNI_LOT.x, y: terrainHeight(UNI_LOT.x, UNI_LOT.z), z: UNI_LOT.z, heading, width: 48, depth: 35, radius: 38 };
})();

/** Cristo do Imperador, no topo do Morro do Imperador. */
export const CRISTO_IMPERADOR = { x: CRISTO.x, y: terrainHeight(CRISTO.x, CRISTO.z), z: CRISTO.z };

export function landmarkBoxes(): Box[] {
  const c = CRISTO_IMPERADOR, u = UNIACADEMIA;
  const turned = u.heading % 180 === 90;
  const hw = (turned ? u.depth : u.width) / 2, hd = (turned ? u.width : u.depth) / 2;
  return [
    { x0: c.x - 3.5, x1: c.x + 3.5, z0: c.z - 3.5, z1: c.z + 3.5, top: c.y + 6, bottom: c.y - 1 },
    { x0: c.x - 1.4, x1: c.x + 1.4, z0: c.z - 1.4, z1: c.z + 1.4, top: c.y + 15, bottom: c.y + 5 },
    { x0: u.x - hw, x1: u.x + hw, z0: u.z - hd, z1: u.z + hd, top: u.y + 17, bottom: u.y - 1 },
  ];
}

/** Estacionamento inicial e carros espalhados pelo Centro, sobre vias reais. */
export function carSpots() {
  const start = nearestRoad(jf.marcos.centro[0], jf.marcos.centro[1], 3)!;
  const spots: { x: number; z: number; heading: number }[] = [{ x: start.x, z: start.z, heading: start.heading }];
  for (const [dx, dz] of [[-260, 90], [200, -180], [300, 260], [-120, -330], [520, -60]]) {
    const p = nearestRoad(start.x + dx, start.z + dz, 3);
    if (p && spots.every((s) => Math.hypot(s.x - p.x, s.z - p.z) > 40)) spots.push({ x: p.x, z: p.z, heading: p.heading });
  }
  return spots;
}

/** Entregas por via: o ponto da rua mais perto do marco real. */
export function roadStop(name: keyof typeof jf.marcos, maxClass = 3) {
  const [x, z] = jf.marcos[name];
  return nearestRoad(x, z, maxClass)!;
}
export const MARCOS = jf.marcos;
export const CITY_CREDITS = jf.creditos;

/** Pad da oficina (decoração e área livre); sem rampas na versão Juiz de Fora. */
export function deliveryRampData() {
  const { x, y, z } = WORKSHOP;
  const parts: WorldPart[] = [{ name: 'Oficina do Parafuso Perdido', mesh: geometry([x-7,y+.04,z+7,x+7,y+.04,z+7,x+7,y+.04,z-7,x-7,y+.04,z-7],
    [0,1,2,0,2,3], Array.from({ length: 4 }, () => [235,165,65,255]).flat()) }];
  return { ramps: [] as { name: string; x0: number; z0: number; x1: number; z1: number; y0: number; y1: number }[], boxes: [] as Box[], parts };
}

export type StreetRect = Box & { axis: 'x' | 'z' };

/** Fonte única do minimapa: vias por categoria, rio, praças, quarteirões, marcos, pista e UniAcademia. */
export function cityLayout() {
  const city = cityData();
  const { x, y, z } = city.helipad;
  const [rax, raz] = [RWY_A.x, RWY_A.z], [rbx, rbz] = [RWY_B.x, RWY_B.z];
  const line = (way: number[]) => way;
  return {
    bounds: { x0: -GRID_HALF, x1: GRID_HALF, z0: -GRID_HALF, z1: GRID_HALF },
    roadLines: ROAD_CLASSES.map((name, c) => ({ category: name, width: ASPHALT[c], lines: (jf.vias[name] as number[][]).map(line) })),
    river: { width: RIVER_WIDTH, lines: jf.rio as number[][] },
    parkPolygons: parkPolys.map((p) => ({ name: p.nome, pts: p.pts })),
    stadiumPolygons: stadiumPolys.map((p) => ({ name: p.nome, pts: p.pts })),
    universityPolygons: universityPolys.map((p) => ({ name: p.nome, pts: p.pts })),
    airportPolygon: airportPolys[0]?.pts ?? [],
    neighborhoods: jf.bairros,
    landmarks: {
      centro: { x: MARCOS.centro[0], z: MARCOS.centro[1] },
      uniacademia: { x: UNIACADEMIA.x, z: UNIACADEMIA.z, heading: UNIACADEMIA.heading, width: UNIACADEMIA.width, depth: UNIACADEMIA.depth },
      ufjf: { x: MARCOS.ufjf[0], z: MARCOS.ufjf[1] },
      cristo: { x: CRISTO_IMPERADOR.x, z: CRISTO_IMPERADOR.z },
      estadio: { x: MARCOS.estadio[0], z: MARCOS.estadio[1] },
    },
    runwayLine: { a: { x: rax, z: raz }, b: { x: rbx, z: rbz }, width: AIRPORT.width, heading: AIRPORT.heading },
    // Campos antigos, mantidos para o minimapa atual
    roads: [] as StreetRect[], blocks: city.blocks, parks: city.parks, buildings: city.boxes,
    asphalt: { x0: CITY.x0, x1: CITY.x1, z0: CITY.z0, z1: CITY.z1, top: CITY_Y },
    runway: { x0: Math.min(rax, rbx) - 15, x1: Math.max(rax, rbx) + 15, z0: Math.min(raz, rbz), z1: Math.max(raz, rbz), top: AIRPORT.y },
    helipad: { x, y, z, x0: x - 12, x1: x + 12, z0: z - 12, z1: z + 12, top: y },
    workshop: { ...WORKSHOP, x0: WORKSHOP.x - 7, x1: WORKSHOP.x + 7, z0: WORKSHOP.z - 7, z1: WORKSHOP.z + 7 },
    coastline: [] as { x: number; z: number }[], sea: { x0: -WORLD_SIZE * 1.5, x1: WORLD_SIZE * 1.5, z0: -WORLD_SIZE * 1.5, z1: WORLD_SIZE * 1.5, top: 0 },
  };
}

/** Textura da faixa da via: calçadas nas bordas (14%), faixas laterais e eixo tracejado. */
export function cityStreetImages() {
  const road = image(64, 64);
  road.rectangles.push({ color: '#a3a6aa', x: 0, y: 0, width: 64, height: 64 });
  road.rectangles.push({ color: '#555560', x: 9, y: 0, width: 46, height: 64 });
  road.rectangles.push({ color: '#d6d3c4', x: 8, y: 0, width: 1, height: 64 }, { color: '#d6d3c4', x: 55, y: 0, width: 1, height: 64 });
  for (const x of [12, 51]) road.rectangles.push({ color: '#eee9d5', x, y: 0, width: 1, height: 64 });
  for (const y of [0, 32]) road.rectangles.push({ color: '#e9bd43', x: 31, y, width: 2, height: 16 });
  return { road };
}

// ---------------------------------------------------------------------------
// Detalhes: ruas encostadas no relevo, rio, praças, postes e árvores
// ---------------------------------------------------------------------------
/** All detail geometry is batched by material; lamps are emissive geometry, never dynamic lights. */
export function cityDetails(city = cityData()) {
  const batch = () => ({ pos: [] as number[], idx: [] as number[], col: [] as number[], uv: [] as number[] });
  const batches = { roads: batch(), ground: batch(), props: batch(), lamps: batch() };
  const boxes: Box[] = [];
  function shape(name: keyof typeof batches, pos: number[], idx: number[], color: number[], uv?: number[]) {
    const b = batches[name], base = b.pos.length / 3; b.pos.push(...pos); b.idx.push(...idx.map((i) => i + base));
    for (let i = 0; i < pos.length / 3; i++) b.col.push(...color, 255);
    if (uv) b.uv.push(...uv);
  }
  function cube(x: number, y: number, z: number, w: number, h: number, d: number, color: number[]) {
    const a = x - w / 2, b = x + w / 2, c = z - d / 2, e = z + d / 2;
    shape('props', [a,y,e,b,y,e,b,y,c,a,y,c,a,y+h,e,b,y+h,e,b,y+h,c,a,y+h,c],
      [0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7,4,5,6,4,6,7], color);
  }
  function cone(x: number, y: number, z: number, r: number, h: number, color: number[], sides = 3) {
    const pos = [x, y + h, z]; for (let i = 0; i < sides; i++) { const a = i / sides * Math.PI * 2; pos.push(x + Math.cos(a) * r, y, z + Math.sin(a) * r); }
    const idx: number[] = []; for (let i = 0; i < sides; i++) idx.push(0, (i + 1) % sides + 1, i + 1);
    shape('props', pos, idx, color);
  }
  function cylinder(x: number, z: number, r: number, bottom: number, top: number) {
    boxes.push({ x0: x - r, x1: x + r, z0: z - r, z1: z + r, top, bottom, radius: r, x, z });
  }

  // Faixa de via (asfalto + calçadas) colada ao relevo, com estações a cada <= 8 m
  const MAX_STEP = 8;
  interface Station { x: number; z: number; s: number }
  function stations(way: number[]) {
    const out: Station[] = []; let s = 0;
    for (let i = 0; i + 3 < way.length; i += 2) {
      const ax = way[i], az = way[i + 1], bx = way[i + 2], bz = way[i + 3], len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(len / MAX_STEP));
      for (let k = i ? 1 : 0; k <= n; k++) out.push({ x: ax + (bx - ax) * k / n, z: az + (bz - az) * k / n, s: s + len * k / n });
      s += len;
    }
    return out;
  }
  function ribbon(batchName: 'roads' | 'ground', way: number[], width: number, lift: number, color: number[], textured: boolean) {
    const st = stations(way); if (st.length < 2) return;
    const half = width / 2, pos: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let i = 0; i < st.length; i++) {
      const a = st[Math.max(0, i - 1)], b = st[Math.min(st.length - 1, i + 1)];
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1, nx = -(b.z - a.z) / len, nz = (b.x - a.x) / len;
      const lx = st[i].x + nx * half, lz = st[i].z + nz * half, rx = st[i].x - nx * half, rz = st[i].z - nz * half;
      pos.push(lx, terrainHeight(lx, lz) + lift, lz, rx, terrainHeight(rx, rz) + lift, rz);
      uv.push(0, st[i].s / 32, 1, st[i].s / 32);
    }
    for (let i = 0; i + 1 < st.length; i++) { const l0 = i * 2, r0 = l0 + 1, l1 = l0 + 2, r1 = l0 + 3; idx.push(l0, l1, r0, r0, l1, r1); }
    shape(batchName, pos, idx, color, textured ? uv : undefined);
  }
  // categorias menores primeiro; as maiores ficam por cima (altura levemente maior)
  for (let c = ROAD_CLASSES.length - 1; c >= 0; c--) {
    (jf.vias[ROAD_CLASSES[c]] as number[][]).forEach((way, i) => ribbon('roads', way, stripWidth(c), LIFT[c] + (i % 4) * .006, [255, 255, 255], true));
  }
  for (const piece of jf.rio as number[][]) ribbon('ground', piece, RIVER_WIDTH, .06, [58, 150, 170], false);

  // Praças, estádios e universidades: células de 10 m dentro do polígono, coladas ao relevo
  const CELL = 10;
  function fill(p: Polygon, color: (x: number, z: number) => number[] | null, lift: number) {
    for (let x = Math.floor(p.x0 / CELL) * CELL; x < p.x1; x += CELL) for (let z = Math.floor(p.z0 / CELL) * CELL; z < p.z1; z += CELL) {
      if (!inside(p, x + CELL / 2, z + CELL / 2)) continue;
      const c = color(x + CELL / 2, z + CELL / 2); if (!c) continue;
      shape('ground', [x,terrainHeight(x,z+CELL)+lift,z+CELL, x+CELL,terrainHeight(x+CELL,z+CELL)+lift,z+CELL, x+CELL,terrainHeight(x+CELL,z)+lift,z, x,terrainHeight(x,z)+lift,z],
        [0,1,2,0,2,3], c);
    }
  }
  const r = rng(913);
  for (const p of parkPolys) {
    fill(p, () => [83, 139, 65], .1);
    const step = 26;
    for (let x = p.x0 + step / 2; x < p.x1; x += step) for (let z = p.z0 + step / 2; z < p.z1; z += step) {
      const tx = x + (r() - .5) * 8, tz = z + (r() - .5) * 8; if (!inside(p, tx, tz) || r() > .7) continue;
      const y = terrainHeight(tx, tz);
      cone(tx, y, tz, .45, 3, [109, 76, 48]); cone(tx, y + 2, tz, 3, 6, [62, 117, 65], 5); cylinder(tx, tz, .4, y, y + 3);
    }
  }
  for (const p of stadiumPolys) {
    const cx = (p.x0 + p.x1) / 2, cz = (p.z0 + p.z1) / 2;
    fill(p, (x, z) => Math.abs(x - cx) < (p.x1 - p.x0) * .3 && Math.abs(z - cz) < (p.z1 - p.z0) * .3 ? [96, 160, 78] : [168, 170, 176], .14);
  }
  for (const p of universityPolys) fill(p, (x, z) => ((Math.floor(x / CELL) + Math.floor(z / CELL)) % 7 === 0 ? [176, 168, 150] : [112, 162, 92]), .1);

  // Postes: nas vias de categoria secundária ou maior, alternando os lados a cada ~55 m
  for (let c = 0; c <= 3; c++) (jf.vias[ROAD_CLASSES[c]] as number[][]).forEach((way, wi) => {
    let side = wi % 2 ? 1 : -1, next = 20;
    const st = stations(way);
    for (let k = 0; k < st.length; k++) {
      const s = st[k];
      if (s.s < next) continue;
      next = s.s + 55; side *= -1;
      const a = st[Math.max(0, k - 1)], b = st[Math.min(st.length - 1, k + 1)];
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1, off = stripWidth(c) / 2 + .9;
      const px = s.x - (b.z - a.z) / len * off * side, pz = s.z + (b.x - a.x) / len * off * side;
      if (dcCentro(px, pz) > 2300 || gapToRoads(px, pz) < -stripWidth(c) / 2 + .2) continue;
      const y = terrainHeight(px, pz);
      cone(px, y, pz, .18, 7, [65, 72, 79]); cylinder(px, pz, .18, y, y + 7.15);
      shape('lamps', [px, y + 7.15, pz, px + 1.3, y + 7.15, pz + .32, px + 1.3, y + 7.15, pz - .32], [0, 1, 2], [255, 255, 255]);
    }
  });

  // Cristo do Imperador: pedestal, corpo e braços abertos
  const cr = CRISTO_IMPERADOR;
  cube(cr.x, cr.y - 1, cr.z, 7, 7, 7, [200, 196, 188]);
  cube(cr.x, cr.y + 5, cr.z, 2.8, 10, 2.8, [238, 236, 230]);
  cube(cr.x, cr.y + 12.5, cr.z, 12, 1.3, 1.3, [238, 236, 230]);
  cube(cr.x, cr.y + 14.8, cr.z, 1.6, 1.8, 1.6, [238, 236, 230]);

  const meshes = Object.fromEntries(Object.entries(batches).map(([name, b]) => [name, geometry(b.pos, b.idx, b.col, b.uv.length ? b.uv : undefined)])) as Record<keyof typeof batches, MeshData>;
  void city;
  return { meshes, boxes };
}
