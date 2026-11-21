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
const LIFT = [.40, .37, .34, .31, .28];
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

/** Aplainamento suave do terreno sob as vias (rua + calçada + transição suave de ~5 m até o talude). */
function roadBedBlend(x: number, z: number) {
  const gx = Math.floor(x / HASH), gz = Math.floor(z / HASH);
  let sumW = 0, sumH = 0, maxW = 0;
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
    for (const sg of segmentGrid.get(hashKey(gx + a, gz + b)) ?? []) {
      if (sg.cls === RIVER_CLS) continue;
      const { d, t } = distToSegment(sg, x, z);
      const inner = sg.half + 5;
      const outer = sg.half + 24;
      if (d >= outer) continue;
      const w = 1 - smoothstep(inner, outer, d);
      if (w <= 0) continue;
      const px = sg.x0 + (sg.x1 - sg.x0) * t, pz = sg.z0 + (sg.z1 - sg.z0) * t;
      const w2 = w * w;
      sumW += w2;
      sumH += rawHeight(px, pz) * w2;
      if (w > maxW) maxW = w;
    }
  }
  return sumW > 0 ? { h: sumH / sumW, w: maxW } : undefined;
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
  // Include the landing site and its 30 m grid-cell corners, so the loaded heli rests level.
  { x: CRISTO.x, z: CRISTO.z, inner: 60, outer: 90 },
  { x: TOWER_SPOT.x, z: TOWER_SPOT.z, inner: 22, outer: 50 },
];

const heightGrid = (() => {
  const g = Float32Array.from(rawGrid);
  for (let j = 0; j < GRID_N; j++) for (let i = 0; i < GRID_N; i++) {
    const x = -GRID_HALF + i * GRID_STEP, z = -GRID_HALF + j * GRID_STEP;
    let h = g[j * GRID_N + i];
    // ruas: o terreno sob a via + calçada + transição suave assume a altura do eixo (sem recortes bruscos)
    const rb = roadBedBlend(x, z);
    if (rb) h = h * (1 - rb.w) + rb.h * rb.w;
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
const URBAN_GROUND = hex('#afa798');

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
      // Solo urbano (pátios/calçadas/lotes) nas regiões com malha viária densa, preservando parques e morros verdes
      const gap = gapToRoads(x, z);
      if (gap < 48 && slope < 0.34 && !inAnyArea(x, z)) {
        const dc = dcCentro(x, z);
        const urban = (1 - smoothstep(0, 48, Math.max(0, gap))) * (0.28 + 0.52 * Math.exp(-((dc / 1600) ** 2))) * (1 - smoothstep(0.18, 0.34, slope));
        c = mix(c, URBAN_GROUND, urban);
      }
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
// ---------------------------------------------------------------------------
// Ruas encostadas no relevo: segmentos <= 8 m, cotas em centro + bordas e garantia no interior de cada quad
// ---------------------------------------------------------------------------
const MAX_STEP = 8, BEVEL = 2.5, MAX_BEVEL = 10;
interface Station { x: number; z: number; s: number; lx: number; lz: number; rx: number; rz: number; hl: number; hr: number }
interface RoadWay { cls: number; half: number; st: Station[] }
interface RoadSegH { x0: number; z0: number; hl0: number; hr0: number; x1: number; z1: number; hl1: number; hr1: number; half: number }
let netCache: { ways: RoadWay[]; grid: Map<number, RoadSegH[]> } | undefined;
function liftRibbonOverTerrain(st: Station[], minLift: number) {
  // Verifica 15 amostras baricêntricas por triângulo de cada quad para garantir que a malha do terreno nunca ultrapasse o asfalto
  const checkTri = (
    ax: number, az: number, bx: number, bz: number, cx: number, cz: number,
    getY: () => [number, number, number], raise: (d: number) => void,
  ) => {
    const [ya, yb, yc] = getY();
    let maxNeed = 0;
    for (let u = 0; u <= 4; u++) for (let v = 0; v <= 4 - u; v++) {
      const a = u / 4, b = v / 4, c = 1 - a - b;
      const x = ax * a + bx * b + cx * c, z = az * a + bz * b + cz * c;
      const y = ya * a + yb * b + yc * c;
      const need = terrainHeight(x, z) + minLift - y;
      if (need > maxNeed) maxNeed = need;
    }
    const mx = (ax + bx + cx) / 3, mz = (az + bz + cz) / 3, my = (ya + yb + yc) / 3;
    const midNeed = terrainHeight(mx, mz) + minLift - my;
    if (midNeed > maxNeed) maxNeed = midNeed;
    if (maxNeed > 0) raise(maxNeed);
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i + 1 < st.length; i++) {
      const a = st[i], b = st[i + 1];
      checkTri(a.lx, a.lz, b.lx, b.lz, a.rx, a.rz, () => [a.hl, b.hl, a.hr], (d) => { a.hl += d; b.hl += d; a.hr += d; });
      checkTri(a.rx, a.rz, b.lx, b.lz, b.rx, b.rz, () => [a.hr, b.hl, b.hr], (d) => { a.hr += d; b.hl += d; b.hr += d; });
    }
  }
}
function buildRibbonStations(way: number[], half: number, lift: number): Station[][] {
  // Divide apenas em retornos muito fechados (> 100°); curvas normais usam chanfro/miter sem frestas
  const rawPts: { x: number; z: number }[] = [];
  for (let i = 0; i + 1 < way.length; i += 2) {
    const x = way[i], z = way[i + 1], prev = rawPts[rawPts.length - 1];
    if (!prev || Math.hypot(x - prev.x, z - prev.z) > 0.25) rawPts.push({ x, z });
  }
  if (rawPts.length < 2) return [];
  const pieces: { x: number; z: number }[][] = [[rawPts[0]]];
  for (let i = 1; i < rawPts.length - 1; i++) {
    const p0 = rawPts[i - 1], p1 = rawPts[i], p2 = rawPts[i + 1];
    const d0x = p1.x - p0.x, d0z = p1.z - p0.z, l0 = Math.hypot(d0x, d0z) || 1;
    const d1x = p2.x - p1.x, d1z = p2.z - p1.z, l1 = Math.hypot(d1x, d1z) || 1;
    const dot = (d0x * d1x + d0z * d1z) / (l0 * l1);
    pieces[pieces.length - 1].push(p1);
    if (dot < -0.15) pieces.push([p1]);
  }
  pieces[pieces.length - 1].push(rawPts[rawPts.length - 1]);

  const out: Station[][] = [];
  let accGlobal = 0;
  for (const piece of pieces) {
    if (piece.length < 2) continue;
    const pts: { x: number; z: number; s: number }[] = [];
    for (let i = 0; i + 1 < piece.length; i++) {
      const ax = piece[i].x, az = piece[i].z, bx = piece[i + 1].x, bz = piece[i + 1].z;
      const len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(len / MAX_STEP));
      for (let k = i ? 1 : 0; k <= n; k++) pts.push({ x: ax + (bx - ax) * k / n, z: az + (bz - az) * k / n, s: accGlobal + len * k / n });
      accGlobal += len;
    }
    if (pts.length < 2) continue;
    const makeStation = (p: { x: number; z: number; s: number }, nx: number, nz: number): Station => {
      const lx = p.x + nx, lz = p.z + nz, rx = p.x - nx, rz = p.z - nz;
      let hl = terrainHeight(lx, lz), hr = terrainHeight(rx, rz);
      const hc = terrainHeight(p.x, p.z);
      const mid = 0.5 * (hl + hr);
      if (mid < hc) { const bump = hc - mid; hl += bump; hr += bump; }
      return { x: p.x, z: p.z, s: p.s, lx, lz, rx, rz, hl: hl + lift, hr: hr + lift };
    };
    const st: Station[] = pts.map((p, i) => {
      let nx: number, nz: number;
      if (i === 0 || i === pts.length - 1) {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
        const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        nx = -(b.z - a.z) / len * half; nz = (b.x - a.x) / len * half;
      } else {
        const p0 = pts[i - 1], p2 = pts[i + 1];
        const l0 = Math.hypot(p.x - p0.x, p.z - p0.z) || 1, l1 = Math.hypot(p2.x - p.x, p2.z - p.z) || 1;
        const u0x = (p.x - p0.x) / l0, u0z = (p.z - p0.z) / l0;
        const u1x = (p2.x - p.x) / l1, u1z = (p2.z - p.z) / l1;
        const tx = u0x + u1x, tz = u0z + u1z, tl = Math.hypot(tx, tz) || 1;
        const dot = Math.max(-0.5, Math.min(1, u0x * u1x + u0z * u1z));
        const miter = Math.min(1.45, 1 / Math.max(0.68, Math.sqrt((1 + dot) * 0.5)));
        nx = -(tz / tl) * half * miter; nz = (tx / tl) * half * miter;
      }
      return makeStation(p, nx, nz);
    });
    // Verifica se algum quad inverte a normal Y (curva muito fechada); se sim, usa quad limpo estendido sobre a emenda
    const clean: Station[][] = [[st[0]]];
    for (let i = 0; i + 1 < st.length; i++) {
      const a = st[i], b = st[i + 1];
      const ny1 = (b.lz - a.lz) * (a.rx - a.lx) - (b.lx - a.lx) * (a.rz - a.lz);
      const ny2 = (b.lz - a.rz) * (b.rx - a.rx) - (b.lx - a.rx) * (b.rz - a.rz);
      if (ny1 > 0.05 && ny2 > 0.05) {
        clean[clean.length - 1].push(b);
      } else {
        const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
        const ux = dx / len, uz = dz / len, nx = -uz * half, nz = ux * half;
        const ext = Math.min(half * 0.5, len * 0.45);
        const pa = { x: pts[i].x - ux * ext, z: pts[i].z - uz * ext, s: pts[i].s };
        const pb = { x: pts[i + 1].x + ux * ext, z: pts[i + 1].z + uz * ext, s: pts[i + 1].s };
        clean.push([makeStation(pa, nx, nz), makeStation(pb, nx, nz)]);
        clean.push([b]);
      }
    }
    for (const seg of clean) {
      if (seg.length < 2) continue;
      liftRibbonOverTerrain(seg, lift);
      out.push(seg);
    }
  }
  return out;
}
function roadNet() {
  if (netCache) return netCache;
  const ways: RoadWay[] = [], grid = new Map<number, RoadSegH[]>();
  for (let c = 0; c < ROAD_CLASSES.length; c++) (jf.vias[ROAD_CLASSES[c]] as number[][]).forEach((way, wi) => {
    const half = stripWidth(c) / 2, lift = LIFT[c] + (wi % 4) * .006;
    for (const st of buildRibbonStations(way, half, lift)) {
      ways.push({ cls: c, half, st });
      const reach = half + MAX_BEVEL;
      for (let i = 0; i + 1 < st.length; i++) {
        const sg: RoadSegH = { x0: st[i].x, z0: st[i].z, hl0: st[i].hl, hr0: st[i].hr, x1: st[i + 1].x, z1: st[i + 1].z, hl1: st[i + 1].hl, hr1: st[i + 1].hr, half };
        for (let gx = Math.floor((Math.min(sg.x0, sg.x1) - reach) / HASH); gx <= Math.floor((Math.max(sg.x0, sg.x1) + reach) / HASH); gx++) {
          for (let gz = Math.floor((Math.min(sg.z0, sg.z1) - reach) / HASH); gz <= Math.floor((Math.max(sg.z0, sg.z1) + reach) / HASH); gz++) {
            const k = hashKey(gx, gz); let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(sg);
          }
        }
      }
    }
  });
  return netCache = { ways, grid };
}
/** Altura do asfalto em (x, z) para a física (mesma superfície da malha, com transição suave nas bordas e emendas); -Infinity fora das ruas. */
export function roadHeightAt(x: number, z: number) {
  let best = -Infinity;
  const list = roadNet().grid.get(hashKey(Math.floor(x / HASH), Math.floor(z / HASH)));
  if (!list) return best;
  const terrain = terrainHeight(x, z);
  for (const sg of list) {
    const dx = sg.x1 - sg.x0, dz = sg.z1 - sg.z0, len2 = dx * dx + dz * dz;
    const len = Math.sqrt(len2) || 1;
    const rawT = len2 ? ((x - sg.x0) * dx + (z - sg.z0) * dz) / len2 : 0;
    const t = Math.max(0, Math.min(1, rawT));
    const px = sg.x0 + dx * t, pz = sg.z0 + dz * t;
    const alongOut = rawT < 0 ? -rawT * len : rawT > 1 ? (rawT - 1) * len : 0;
    if (alongOut > MAX_BEVEL) continue;
    const nx = -dz / len, nz = dx / len;
    const lat = (x - px) * nx + (z - pz) * nz;
    const absLat = Math.abs(lat);
    const latOut = Math.max(0, absLat - sg.half);
    if (latOut > MAX_BEVEL) continue;
    const outDist = alongOut > 0 && latOut > 0 ? Math.hypot(alongOut, latOut) : alongOut + latOut;
    if (outDist > MAX_BEVEL) continue;
    const clampedLat = Math.max(-sg.half, Math.min(sg.half, lat));
    const u = clampedLat / sg.half;
    const hl = sg.hl0 + (sg.hl1 - sg.hl0) * t, hr = sg.hr0 + (sg.hr1 - sg.hr0) * t;
    const h = 0.5 * (hl + hr) + 0.5 * (hl - hr) * u;
    if (outDist === 0) {
      if (h > terrain && h > best) best = h;
      continue;
    }
    const qx = px + nx * clampedLat, qz = pz + nz * clampedLat;
    const liftAtEdge = h - terrainHeight(qx, qz);
    if (liftAtEdge <= 0) continue;
    const bevelW = Math.max(BEVEL, Math.min(MAX_BEVEL, liftAtEdge / 0.16));
    if (outDist >= bevelW) continue;
    const cand = terrain + liftAtEdge * (1 - outDist / bevelW);
    if (cand > best) best = cand;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Rampas do carro tunado: perto das entregas do estágio "tuned", alinhadas aos eixos e ao relevo
// ---------------------------------------------------------------------------
export interface RampDef { name: string; x0: number; z0: number; x1: number; z1: number; y0: number; y1: number }
let rampCache: RampDef[] | undefined;
function rampSites(): RampDef[] {
  return rampCache ??= ([['salvaterra', 'Rampa do Salvaterra'], ['cristo', 'Rampa do Mirante'], ['estadio', 'Rampa do Estádio']] as const).map(([place, name]) => {
    const stop = nearestRoad(jf.marcos[place][0], jf.marcos[place][1], 3)!;
    let best: RoadPoint | undefined, bestD = Infinity;
    for (let r = 0; r <= 260; r += 12) {
      for (let k = 0, n = Math.max(1, Math.round(r / 12) * 6); k < n; k++) {
        const a = k / n * Math.PI * 2, rp = nearestRoad(stop.x + Math.cos(a) * r, stop.z + Math.sin(a) * r, 3);
        if (!rp || rp.distance > 3) continue;
        const m = rp.heading % 90, off = Math.min(m, 90 - m);
        if (off > 9 || gapToRoads(rp.x, rp.z) > -1) continue;
        const d = Math.hypot(rp.x - stop.x, rp.z - stop.z);
        if (d < bestD && Math.abs(terrainHeight(rp.x, rp.z) - terrainHeight(rp.x + 22, rp.z)) < 3 && Math.abs(terrainHeight(rp.x, rp.z) - terrainHeight(rp.x, rp.z + 22)) < 3) { best = rp; bestD = d; }
      }
    }
    const p = best ?? stop;
    const axis = Math.round(p.heading / 90) % 4, dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    let [dx, dz] = dirs[axis];
    if (terrainHeight(p.x + dx * 40, p.z + dz * 40) > terrainHeight(p.x - dx * 40, p.z - dz * 40)) { dx = -dx; dz = -dz; }
    const x1 = p.x + dx * 22, z1 = p.z + dz * 22, y0 = Math.max(terrainHeight(p.x, p.z), roadHeightAt(p.x, p.z));
    return { name, x0: p.x, z0: p.z, x1, z1, y0, y1: Math.max(y0 + 4, terrainHeight(x1, z1) + 2) };
  });
}

// ---------------------------------------------------------------------------
// Prédios e casas: lotes procedurais ao longo das vias, mais densos e altos perto do Centro
// ---------------------------------------------------------------------------
export type CityData = ReturnType<typeof buildCity>;
let cityCache: CityData | undefined;
/** Resultado memorizado (determinístico): quem recebe não deve alterá-lo. */
export function cityData(): CityData { return cityCache ??= buildCity(); }

const WALLS = ['#f1e7d3', '#e6d3b3', '#d9c8a9', '#f4f0e6', '#c9b79a', '#e8c9a0', '#b9c4b0', '#cfd8dc', '#e5d0d0', '#d6b98c'].map(hex);
const ROOFS = ['#b4452f', '#a63d2a', '#c25a3a', '#933a2b', '#b8502f'].map(hex);
const SLAB = hex('#8e9399');
/** Se `src/flight/bairros.ts` (bairrosData(): MeshData) existir, ele desenha as casas dos bairros e as casas procedurais daqui ficam desligadas. */
export const HAS_BAIRROS = Object.keys(import.meta.glob('./bairros.ts')).length > 0;
/** Fator de ocupação dos lotes: mantém o GLB da cidade perto de 2,5 MB. */
const HOUSE_DENSITY = 2.2;

function buildCity() {
  const boxes: Box[] = [];
  const r = rng(2024);
  const pos: number[] = [], col: number[] = [], uv: number[] = [], idx: number[] = [];
  const hp: number[] = [], hc: number[] = [], hi: number[] = [];
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
  const corners = (x0: number, x1: number, z0: number, z1: number) => [terrainHeight(x0, z0), terrainHeight(x1, z0), terrainHeight(x0, z1), terrainHeight(x1, z1)];
  const addBuilding = (x: number, z: number, w: number, d: number, h: number, c: number[]) => {
    const x0 = x - w / 2, x1 = x + w / 2, z0 = z - d / 2, z1 = z + d / 2;
    const heights = corners(x0, x1, z0, z1);
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
  /** Casa leve: 13 vértices (base, beiral de parede, beiral de telhado, cumeeira); laje plana quando `flat`. */
  const addHouse = (x: number, z: number, w: number, d: number, floors: number, wall: number[], roof: number[], flat: boolean) => {
    const x0 = x - w / 2, x1 = x + w / 2, z0 = z - d / 2, z1 = z + d / 2;
    const heights = corners(x0, x1, z0, z1);
    const y0 = Math.min(...heights) - .8, eave = Math.max(...heights) + floors * 3.2, apex = flat ? eave + .3 : eave + Math.min(w, d) * .28;
    const ring = [[x0, z1], [x1, z1], [x1, z0], [x0, z0]], base = hp.length / 3;
    for (const [px, pz] of ring) { hp.push(px, y0, pz); hc.push(wall[0], wall[1], wall[2], 255); }
    for (const [px, pz] of ring) { hp.push(px, eave, pz); hc.push(wall[0], wall[1], wall[2], 255); }
    for (const [px, pz] of ring) { hp.push(px, eave, pz); hc.push(roof[0], roof[1], roof[2], 255); }
    hp.push(x, apex, z); hc.push(roof[0], roof[1], roof[2], 255);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      hi.push(base + i, base + j, base + 4 + j, base + i, base + 4 + j, base + 4 + i, base + 8 + i, base + 8 + j, base + 12);
    }
    put({ x0, x1, z0, z1, top: apex, bottom: y0 });
  };

  // Torre do heliponto: prédio alto do Centro, com rampa externa até a laje
  const tower = addBuilding(TOWER_SPOT.x, TOWER_SPOT.z, 26, 26, 46, hex('#9aa3b5'));
  const helipad = { x: (tower.x0 + tower.x1) / 2, z: (tower.z0 + tower.z1) / 2, y: tower.top };

  const RESERVED = [
    { x: UNI_LOT.x, z: UNI_LOT.z, r: 62 }, { x: WORKSHOP_SPOT.x, z: WORKSHOP_SPOT.z, r: 26 }, { x: CRISTO.x, z: CRISTO.z, r: 34 },
  ];
  const ramps = rampSites().map((q) => ({ x0: Math.min(q.x0, q.x1) - 10, x1: Math.max(q.x0, q.x1) + 10, z0: Math.min(q.z0, q.z1) - 10, z1: Math.max(q.z0, q.z1) + 10 }));
  let houses = 0;
  const PITCH = 20;
  for (let gz = -2900; gz <= 2900; gz += PITCH) {
    for (let gx = -2900; gx <= 2900; gx += PITCH) {
      const cx = gx + (r() - 0.5) * 8, cz = gz + (r() - 0.5) * 8;
      const roll = r(), kindRoll = r(), sizeRoll = r(), sizeRoll2 = r(), heightRoll = r(), colorRoll = r(), roofRoll = r(), flatRoll = r();
      const gap = gapToRoads(cx, cz);
      if (gap < 5.5 || (gap > 58 && !(gap === Infinity && dcCentro(cx, cz) < 1100))) continue; // miolo dos quarteirões do Centro
      const dc = dcCentro(cx, cz), elev = terrainHeight(cx, cz);
      const density = (0.14 + 0.95 * Math.exp(-((dc / 1500) ** 2))) * (1 - 0.85 * smoothstep(70, 200, elev)) * HOUSE_DENSITY;
      if (roll > density) continue;
      if (inAnyArea(cx, cz) || RESERVED.some((q) => Math.hypot(cx - q.x, cz - q.z) < q.r) || ramps.some((q) => cx > q.x0 && cx < q.x1 && cz > q.z0 && cz < q.z1)) continue;
      const { s, l } = runwayFrame(cx, cz);
      if (s > -120 && s < RWY_LEN + 120 && Math.abs(l) < 140) continue;
      const isTower = dc < 1250 && kindRoll < (dc < 650 ? 0.55 : 0.2);
      if (HAS_BAIRROS && !isTower) continue;
      const w = isTower ? (dc < 650 ? 16 + sizeRoll * 12 : 14 + sizeRoll * 8) : 11 + sizeRoll * 8;
      const d = isTower ? (dc < 650 ? 16 + sizeRoll2 * 12 : 14 + sizeRoll2 * 8) : 11 + sizeRoll2 * 8;
      const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
      if (overlaps(x0, x1, z0, z1)) continue;
      if ([[x0, z0], [x1, z0], [x0, z1], [x1, z1]].some(([px, pz]) => gapToRoads(px, pz) < 2.5)) continue;
      const hs = corners(x0, x1, z0, z1);
      if (Math.max(...hs) - Math.min(...hs) > 3.2) continue;
      if (isTower) {
        const tall = Math.exp(-((dc / 380) ** 2));
        addBuilding(cx, cz, w, d, dc < 650 ? 14 + heightRoll * 20 + tall * (20 + heightRoll * 40) : 9 + heightRoll * 11, FACADES[Math.floor(colorRoll * FACADES.length)]);
      } else {
        addHouse(cx, cz, w, d, 1 + Math.floor(heightRoll * (dc < 900 ? 3.99 : 2.99)), WALLS[Math.floor(colorRoll * WALLS.length)], flatRoll < 0.28 ? SLAB : ROOFS[Math.floor(roofRoll * ROOFS.length)], flatRoll < 0.28);
        houses++;
      }
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
  return { mesh: geometry(pos, idx, col, uv), houses: geometry(hp, hi, hc), houseCount: houses, boxes, parks, blocks: [...cells.values()], helipad, tower };
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
    boxes = [...city.boxes, ...details.boxes, ...airportData(city.helipad).boxes, ...deliveryRampData().boxes, ...landmarkBoxes()];
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
    if (flatGround === undefined) h = Math.max(h, roadHeightAt(x, z));
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

/** Pad da oficina e as rampas de salto do carro tunado (perto das entregas "tuned", alinhadas ao relevo). */
export function deliveryRampData() {
  const { x, y, z } = WORKSHOP;
  const parts: WorldPart[] = [{ name: 'Oficina do Parafuso Perdido', mesh: geometry([x-7,y+.04,z+7,x+7,y+.04,z+7,x+7,y+.04,z-7,x-7,y+.04,z-7],
    [0,1,2,0,2,3], Array.from({ length: 4 }, () => [235,165,65,255]).flat()) }];
  const ramps = rampSites(), boxes: Box[] = [];
  for (const q of ramps) {
    const dx = q.x1 - q.x0, dz = q.z1 - q.z0, len = Math.hypot(dx, dz), px = dz / len * 6, pz = -dx / len * 6;
    parts.push({ name: q.name, mesh: geometry([q.x0+px,q.y0,q.z0+pz,q.x0-px,q.y0,q.z0-pz,q.x1-px,q.y1,q.z1-pz,q.x1+px,q.y1,q.z1+pz],
      [0,1,2,0,2,3], Array.from({ length: 4 }, () => [230,145,45,255]).flat()) });
    boxes.push({ x0: Math.min(q.x0, q.x1) - Math.abs(px), x1: Math.max(q.x0, q.x1) + Math.abs(px), z0: Math.min(q.z0, q.z1) - Math.abs(pz), z1: Math.max(q.z0, q.z1) + Math.abs(pz),
      top: q.y1, bottom: q.y0 - .12, ramp: q });
  }
  return { ramps, boxes, parts };
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

  // Ruas (categorias menores primeiro) e rio usando a mesma faixa contínua acima do relevo
  const net = roadNet();
  const emitRibbon = (batchName: 'roads' | 'ground', st: Station[], color: number[], textured: boolean) => {
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let i = 0; i < st.length; i++) {
      const p = st[i];
      pos.push(p.lx, p.hl, p.lz, p.rx, p.hr, p.rz);
      if (textured) uv.push(0, p.s / 32, 1, p.s / 32);
    }
    for (let i = 0; i + 1 < st.length; i++) { const l0 = i * 2; idx.push(l0, l0 + 2, l0 + 1, l0 + 1, l0 + 2, l0 + 3); }
    shape(batchName, pos, idx, color, textured ? uv : undefined);
  };
  for (let c = ROAD_CLASSES.length - 1; c >= 0; c--) for (const w of net.ways) {
    if (w.cls !== c) continue;
    emitRibbon('roads', w.st, [255, 255, 255], true);
  }
  for (const piece of jf.rio as number[][]) {
    for (const st of buildRibbonStations(piece, RIVER_WIDTH / 2, .16)) emitRibbon('ground', st, [58, 150, 170], false);
  }

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
  net.ways.filter((w) => w.cls <= 3).forEach((w, wi) => {
    let side = wi % 2 ? 1 : -1, next = 20;
    for (let k = 0; k < w.st.length; k++) {
      const p = w.st[k];
      if (p.s < next) continue;
      next = p.s + 55; side *= -1;
      const a = w.st[Math.max(0, k - 1)], b = w.st[Math.min(w.st.length - 1, k + 1)];
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1, off = w.half + .9;
      const px = p.x - (b.z - a.z) / len * off * side, pz = p.z + (b.x - a.x) / len * off * side;
      if (dcCentro(px, pz) > 2300 || gapToRoads(px, pz) < .2) continue;
      const y = Math.max(terrainHeight(px, pz), roadHeightAt(px, pz));
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
