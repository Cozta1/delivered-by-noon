import { calculateNormals } from 'playcanvas';
import { rng, smoothstep } from './noise';
import {
  CRISTO_IMPERADOR,
  HANGAR,
  UNIACADEMIA,
  WORKSHOP,
  cityLayout,
  deliveryRampData,
  terrainHeight,
  type MeshData,
} from './world-data';

// ---------------------------------------------------------------------------
// Bairros de Juiz de Fora: casas e prédios baixos (1-4 andares) procedurais,
// recuados e alinhados às vias, assentados no relevo, em malha única leve.
// ---------------------------------------------------------------------------

export type RoofKind = 'gable' | 'hip' | 'slab';

export interface BairroLot {
  cx: number;
  cz: number;
  w: number;
  d: number;
  angle: number;
  floors: number;
  roof: RoofKind;
  yBase: number;
  yGround: number;
  yTop: number;
}

interface Segment {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  half: number;
  cls: number;
}

interface Poly {
  pts: number[];
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

interface OBB {
  cx: number;
  cz: number;
  hw: number;
  hd: number;
  rx: number;
  rz: number;
  fx: number;
  fz: number;
  rad: number;
}

const HASH = 64;
const OBB_CELL = 40;
const RIVER_CLS = 9;
const MAX_VERTS = 48_000; // mantém índices Uint16 (<= 65535) e GLB ~0,95 MB (< 1,2 MB)
const MAX_SLOPE = 0.30;
const MAX_FOOTPRINT_DROP = 3.0;
const ROAD_MARGIN = 2.6; // folga além da calçada desenhada (asfalto / 0,72)
const FLOOR_H = 3.1;

const hex = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

const WALL_COLORS = [
  '#f4f1ea', '#efe8dc', '#ece4d3', '#f7f3eb',
  '#e4d4b7', '#d9c5a3', '#e2ccb0', '#d5be9c',
  '#ebd2b8', '#e6c8ba', '#d3dccb', '#cfdbe0',
  '#e3cfd2', '#dfd8cc', '#e9ddb8', '#cdd6d2',
].map(hex);

const TILE_COLORS = [
  '#b84a32', '#a9402b', '#c45838', '#9c3c29', '#bf5233', '#b0462e',
].map(hex);

const SLAB_COLORS = ['#989ca1', '#8b9096', '#a5a198', '#84898f'].map(hex);
const GLASS_DARK = ['#313e54', '#2a364a', '#3b4a61'].map(hex);
const GLASS_WARM = ['#d9bc7e', '#cfa968'].map(hex);

const hashKey = (gx: number, gz: number) => gx * 4096 + gz;

function toPoly(pts: number[]): Poly | null {
  if (pts.length < 6) return null;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < x0) x0 = pts[i];
    if (pts[i] > x1) x1 = pts[i];
    if (pts[i + 1] < z0) z0 = pts[i + 1];
    if (pts[i + 1] > z1) z1 = pts[i + 1];
  }
  return { pts, x0, x1, z0, z1 };
}

function pointInPoly(p: Poly, x: number, z: number): boolean {
  if (x < p.x0 || x > p.x1 || z < p.z0 || z > p.z1) return false;
  let c = false;
  const pts = p.pts;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const xi = pts[i], zi = pts[i + 1], xj = pts[j], zj = pts[j + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

function distToSegment(s: Segment, x: number, z: number): number {
  const dx = s.x1 - s.x0, dz = s.z1 - s.z0, len2 = dx * dx + dz * dz;
  const t = len2 ? Math.max(0, Math.min(1, ((x - s.x0) * dx + (z - s.z0) * dz) / len2)) : 0;
  return Math.hypot(x - s.x0 - dx * t, z - s.z0 - dz * t);
}

function obbOverlap(a: OBB, b: OBB, pad: number): boolean {
  const dx = b.cx - a.cx, dz = b.cz - a.cz;
  const rSum = a.rad + b.rad + pad;
  if (dx * dx + dz * dz > rSum * rSum) return false;
  const axes: [number, number][] = [
    [a.rx, a.rz],
    [a.fx, a.fz],
    [b.rx, b.rz],
    [b.fx, b.fz],
  ];
  for (const [ax, az] of axes) {
    const dist = Math.abs(dx * ax + dz * az);
    const pa = a.hw * Math.abs(a.rx * ax + a.rz * az) + a.hd * Math.abs(a.fx * ax + a.fz * az);
    const pb = b.hw * Math.abs(b.rx * ax + b.rz * az) + b.hd * Math.abs(b.fx * ax + b.fz * az);
    if (dist > pa + pb + pad) return false;
  }
  return true;
}

function terrainSlope(x: number, z: number): number {
  const d = 8;
  const gx = (terrainHeight(x + d, z) - terrainHeight(x - d, z)) / (2 * d);
  const gz = (terrainHeight(x, z + d) - terrainHeight(x, z - d)) / (2 * d);
  return Math.hypot(gx, gz);
}

function buildBairros(): { mesh: MeshData; lots: BairroLot[] } {
  const layout = cityLayout();
  const r = rng(202607);

  // 1. Índice espacial de vias (largura inclui calçadas: asfalto / 0,72) e rio
  const segGrid = new Map<number, Segment[]>();
  const addSeg = (s: Segment) => {
    const gx0 = Math.floor(Math.min(s.x0, s.x1) / HASH);
    const gx1 = Math.floor(Math.max(s.x0, s.x1) / HASH);
    const gz0 = Math.floor(Math.min(s.z0, s.z1) / HASH);
    const gz1 = Math.floor(Math.max(s.z0, s.z1) / HASH);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const k = hashKey(gx, gz);
        let list = segGrid.get(k);
        if (!list) segGrid.set(k, (list = []));
        list.push(s);
      }
    }
  };

  layout.roadLines.forEach((group, cls) => {
    const half = group.width / 0.72 / 2;
    for (const line of group.lines) {
      for (let i = 0; i + 3 < line.length; i += 2) {
        addSeg({ x0: line[i], z0: line[i + 1], x1: line[i + 2], z1: line[i + 3], half, cls });
      }
    }
  });
  for (const piece of layout.river.lines) {
    for (let i = 0; i + 3 < piece.length; i += 2) {
      addSeg({
        x0: piece[i], z0: piece[i + 1], x1: piece[i + 2], z1: piece[i + 3],
        half: layout.river.width / 2 + 2.5, cls: RIVER_CLS,
      });
    }
  }

  const gapToCorridors = (x: number, z: number): number => {
    const gx = Math.floor(x / HASH), gz = Math.floor(z / HASH);
    let best = Infinity;
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        const list = segGrid.get(hashKey(gx + a, gz + b));
        if (!list) continue;
        for (const s of list) {
          const g = distToSegment(s, x, z) - s.half;
          if (g < best) best = g;
        }
      }
    }
    return best;
  };

  const nearestRoadAngle = (x: number, z: number): { gap: number; angle: number } => {
    const gx = Math.floor(x / HASH), gz = Math.floor(z / HASH);
    let bestGap = Infinity;
    let bestAngle = 0;
    for (let a = -2; a <= 2; a++) {
      for (let b = -2; b <= 2; b++) {
        const list = segGrid.get(hashKey(gx + a, gz + b));
        if (!list) continue;
        for (const s of list) {
          if (s.cls === RIVER_CLS) continue;
          const g = distToSegment(s, x, z) - s.half;
          if (g < bestGap) {
            bestGap = g;
            bestAngle = Math.atan2(s.z1 - s.z0, s.x1 - s.x0);
          }
        }
      }
    }
    return { gap: bestGap, angle: bestAngle };
  };

  // 2. Zonas de exclusão: praças, estádios, universidades, aeroporto, pista, hangar, marcos e rampas
  const exclPolys: Poly[] = [
    ...layout.parkPolygons.map((p) => toPoly(p.pts)),
    ...layout.stadiumPolygons.map((p) => toPoly(p.pts)),
    ...layout.universityPolygons.map((p) => toPoly(p.pts)),
    toPoly(layout.airportPolygon),
  ].filter((p): p is Poly => p !== null);

  const inExcludedPoly = (x: number, z: number) => exclPolys.some((p) => pointInPoly(p, x, z));

  const rwyA = layout.runwayLine.a;
  const rwyB = layout.runwayLine.b;
  const rwyLen = Math.hypot(rwyB.x - rwyA.x, rwyB.z - rwyA.z) || 1;
  const rwyUx = (rwyB.x - rwyA.x) / rwyLen;
  const rwyUz = (rwyB.z - rwyA.z) / rwyLen;
  const inRunwayOrHangar = (x: number, z: number) => {
    const dx = x - rwyA.x, dz = z - rwyA.z;
    const s = dx * rwyUx + dz * rwyUz;
    const l = dx * -rwyUz + dz * rwyUx;
    if (s > -130 && s < rwyLen + 130 && Math.abs(l) < 145) return true;
    return x > HANGAR.x0 - 14 && x < HANGAR.x1 + 14 && z > HANGAR.z0 - 14 && z < HANGAR.z1 + 14;
  };

  const reservedCircles = [
    { x: UNIACADEMIA.x, z: UNIACADEMIA.z, r: Math.max(64, UNIACADEMIA.radius + 24) },
    { x: WORKSHOP.x, z: WORKSHOP.z, r: 28 },
    { x: CRISTO_IMPERADOR.x, z: CRISTO_IMPERADOR.z, r: 38 },
    { x: layout.helipad.x, z: layout.helipad.z, r: 28 },
  ];

  const rampBoxes = deliveryRampData().ramps.map((q) => ({
    x0: Math.min(q.x0, q.x1) - 12,
    x1: Math.max(q.x0, q.x1) + 12,
    z0: Math.min(q.z0, q.z1) - 12,
    z1: Math.max(q.z0, q.z1) + 12,
  }));

  // 3. Índice espacial de OBBs (inicia com as torres já geradas por world-data.ts)
  const obbGrid = new Map<number, OBB[]>();
  const registerObb = (o: OBB) => {
    const gx0 = Math.floor((o.cx - o.rad) / OBB_CELL);
    const gx1 = Math.floor((o.cx + o.rad) / OBB_CELL);
    const gz0 = Math.floor((o.cz - o.rad) / OBB_CELL);
    const gz1 = Math.floor((o.cz + o.rad) / OBB_CELL);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const k = hashKey(gx, gz);
        let list = obbGrid.get(k);
        if (!list) obbGrid.set(k, (list = []));
        list.push(o);
      }
    }
  };
  const hasOverlap = (o: OBB, pad: number): boolean => {
    const r = o.rad + pad;
    const gx0 = Math.floor((o.cx - r) / OBB_CELL);
    const gx1 = Math.floor((o.cx + r) / OBB_CELL);
    const gz0 = Math.floor((o.cz - r) / OBB_CELL);
    const gz1 = Math.floor((o.cz + r) / OBB_CELL);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const list = obbGrid.get(hashKey(gx, gz));
        if (!list) continue;
        for (const other of list) {
          if (obbOverlap(o, other, pad)) return true;
        }
      }
    }
    return false;
  };

  for (const b of layout.buildings) {
    const hw = (b.x1 - b.x0) / 2, hd = (b.z1 - b.z0) / 2;
    registerObb({
      cx: (b.x0 + b.x1) / 2, cz: (b.z0 + b.z1) / 2,
      hw, hd, rx: 1, rz: 0, fx: 0, fz: 1, rad: Math.hypot(hw, hd),
    });
  }

  // 4. Densidade baseada em distância ao Centro, núcleos de bairros, altitude e inclinação
  const centro = layout.landmarks.centro;
  const neighborhoods = layout.neighborhoods;
  const bounds = layout.bounds;
  const minX = bounds.x0 + 60, maxX = bounds.x1 - 60;
  const minZ = bounds.z0 + 60, maxZ = bounds.z1 - 60;

  const nearestNeighborhoodDist = (x: number, z: number): number => {
    let best2 = Infinity;
    for (let i = 0; i < neighborhoods.length; i++) {
      const dx = x - neighborhoods[i].x, dz = z - neighborhoods[i].z;
      const d2 = dx * dx + dz * dz;
      if (d2 < best2) best2 = d2;
    }
    return Math.sqrt(best2);
  };

  const densityAt = (x: number, z: number, elev: number, slope: number): { prob: number; dc: number } => {
    const dc = Math.hypot(x - centro.x, z - centro.z);
    const centerFactor = Math.exp(-((dc / 1450) ** 2));
    const dNeigh = nearestNeighborhoodDist(x, z);
    const neighBoost = 0.42 * Math.exp(-((dNeigh / 360) ** 2));
    const elevFactor = 1 - 0.72 * smoothstep(85, 210, elev);
    const slopeFactor = 1 - smoothstep(0.14, MAX_SLOPE, slope);
    const periphFactor = 1 - 0.75 * smoothstep(2350, 3100, dc);
    const prob = Math.min(0.95, (0.08 + 0.85 * centerFactor + neighBoost) * elevFactor * slopeFactor * periphFactor);
    return { prob, dc };
  };

  // 5. Buffers da malha única
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const lots: BairroLot[] = [];

  const pushVert = (x: number, y: number, z: number, c: [number, number, number]): number => {
    const id = pos.length / 3;
    pos.push(x, y, z);
    col.push(c[0], c[1], c[2], 255);
    return id;
  };

  const scaleRgb = (c: [number, number, number], s: number): [number, number, number] => [
    Math.min(255, Math.round(c[0] * s)),
    Math.min(255, Math.round(c[1] * s)),
    Math.min(255, Math.round(c[2] * s)),
  ];

  const tryPlace = (cx: number, cz: number, angle: number, densityMul: number): boolean => {
    if (pos.length / 3 >= MAX_VERTS - 40) return false;
    if (cx < minX || cx > maxX || cz < minZ || cz > maxZ) return false;

    const roll = r();
    const sizeR1 = r(), sizeR2 = r(), floorR = r(), roofR = r();
    const wallR = r(), tileR = r(), shadeR = r(), winR = r();

    const elev = terrainHeight(cx, cz);
    const slope = terrainSlope(cx, cz);
    if (slope > MAX_SLOPE) return false;

    const { prob, dc } = densityAt(cx, cz, elev, slope);
    if (roll > prob * densityMul) return false;

    // Exclusões rápidas no centro
    if (inRunwayOrHangar(cx, cz) || inExcludedPoly(cx, cz)) return false;
    if (reservedCircles.some((q) => Math.hypot(cx - q.x, cz - q.z) < q.r)) return false;
    if (rampBoxes.some((q) => cx > q.x0 && cx < q.x1 && cz > q.z0 && cz < q.z1)) return false;
    if (gapToCorridors(cx, cz) < ROAD_MARGIN + 3.5) return false;

    // Número de andares (1 a 4): mais predinhos perto do Centro, casas nos bairros
    let floors: number;
    if (dc < 850) {
      floors = floorR < 0.20 ? 1 : floorR < 0.50 ? 2 : floorR < 0.80 ? 3 : 4;
    } else if (dc < 1700) {
      floors = floorR < 0.42 ? 1 : floorR < 0.78 ? 2 : floorR < 0.94 ? 3 : 4;
    } else {
      floors = floorR < 0.62 ? 1 : floorR < 0.90 ? 2 : 3;
    }

    const w = floors >= 3 ? 11.5 + sizeR1 * 7.5 : 8.5 + sizeR1 * 6.5;
    const d = floors >= 3 ? 10.0 + sizeR2 * 6.5 : 7.5 + sizeR2 * 5.5;
    const hw = w / 2, hd = d / 2;
    const rx = Math.cos(angle), rz = Math.sin(angle);
    const fx = -rz, fz = rx;
    const obb: OBB = { cx, cz, hw, hd, rx, rz, fx, fz, rad: Math.hypot(hw, hd) };

    if (hasOverlap(obb, 1.8)) return false;

    // Verifica os 4 cantos (mais pequena folga de beiral) contra vias, rio, polígonos e relevo
    const cOff = [
      [-hw, +hd], [+hw, +hd], [+hw, -hd], [-hw, -hd],
    ] as const;
    let hMin = elev, hMax = elev;
    for (const [lu, lv] of cOff) {
      const px = cx + lu * rx + lv * fx;
      const pz = cz + lu * rz + lv * fz;
      if (gapToCorridors(px, pz) < ROAD_MARGIN) return false;
      if (inExcludedPoly(px, pz) || inRunwayOrHangar(px, pz)) return false;
      if (reservedCircles.some((q) => Math.hypot(px - q.x, pz - q.z) < q.r - 2)) return false;
      if (rampBoxes.some((q) => px > q.x0 && px < q.x1 && pz > q.z0 && pz < q.z1)) return false;
      const ch = terrainHeight(px, pz);
      if (ch < hMin) hMin = ch;
      if (ch > hMax) hMax = ch;
    }
    if (hMax - hMin > MAX_FOOTPRINT_DROP) return false;

    // Escolha do telhado: duas águas, quatro águas ou laje
    const roof: RoofKind =
      floors >= 3
        ? (roofR < 0.62 ? 'slab' : 'hip')
        : (roofR < 0.44 ? 'gable' : roofR < 0.82 ? 'hip' : 'slab');

    // Alturas assentadas no relevo (base abaixo do menor canto; piso acima do maior)
    const yBase = hMin - 0.7;
    const yGround = hMax;
    const yEave = yGround + floors * FLOOR_H;
    const ridgeH = roof === 'slab' ? 0.14 : Math.min(w, d) * 0.24 + 0.45;
    const yTop = yEave + ridgeH;

    // Cores
    const shade = 0.90 + shadeR * 0.14;
    const wallTop = scaleRgb(WALL_COLORS[Math.floor(wallR * WALL_COLORS.length)], shade);
    const wallBot = scaleRgb(wallTop, 0.86);
    const roofBase = roof === 'slab'
      ? scaleRgb(SLAB_COLORS[Math.floor(tileR * SLAB_COLORS.length)], shade)
      : scaleRgb(TILE_COLORS[Math.floor(tileR * TILE_COLORS.length)], 0.92 + shadeR * 0.12);
    const roofPeak = scaleRgb(roofBase, 1.07);
    const winColor = winR < 0.18
      ? GLASS_WARM[Math.floor(winR * 100) % GLASS_WARM.length]
      : GLASS_DARK[Math.floor(winR * 100) % GLASS_DARK.length];

    const toW = (u: number, y: number, v: number): [number, number, number] => [
      cx + u * rx + v * fx,
      y,
      cz + u * rz + v * fz,
    ];

    // Paredes (8 vértices, 8 triângulos)
    const wb0 = pushVert(...toW(-hw, yBase, +hd), wallBot);
    const wb1 = pushVert(...toW(+hw, yBase, +hd), wallBot);
    const wb2 = pushVert(...toW(+hw, yBase, -hd), wallBot);
    const wb3 = pushVert(...toW(-hw, yBase, -hd), wallBot);
    const wt0 = pushVert(...toW(-hw, yEave, +hd), wallTop);
    const wt1 = pushVert(...toW(+hw, yEave, +hd), wallTop);
    const wt2 = pushVert(...toW(+hw, yEave, -hd), wallTop);
    const wt3 = pushVert(...toW(-hw, yEave, -hd), wallTop);
    const wb = [wb0, wb1, wb2, wb3];
    const wt = [wt0, wt1, wt2, wt3];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      idx.push(wb[i], wb[j], wt[j], wb[i], wt[j], wt[i]);
    }

    // Telhado
    const ov = 0.35;
    const ohw = hw + ov, ohd = hd + ov;
    const yOver = yEave - 0.12;
    if (roof === 'slab') {
      const s0 = pushVert(...toW(-hw, yTop, +hd), roofBase);
      const s1 = pushVert(...toW(+hw, yTop, +hd), roofBase);
      const s2 = pushVert(...toW(+hw, yTop, -hd), roofBase);
      const s3 = pushVert(...toW(-hw, yTop, -hd), roofBase);
      idx.push(s0, s1, s2, s0, s2, s3);
    } else if (roof === 'gable') {
      if (w >= d) {
        // Cumeeira ao longo de U; oitões nas laterais ±U
        const gL = pushVert(...toW(-hw, yTop, 0), wallTop);
        const gR = pushVert(...toW(+hw, yTop, 0), wallTop);
        idx.push(wt1, wt2, gR, wt3, wt0, gL);
        const r0 = pushVert(...toW(-ohw, yOver, +ohd), roofBase);
        const r1 = pushVert(...toW(+ohw, yOver, +ohd), roofBase);
        const r2 = pushVert(...toW(+ohw, yOver, -ohd), roofBase);
        const r3 = pushVert(...toW(-ohw, yOver, -ohd), roofBase);
        const rL = pushVert(...toW(-ohw, yTop, 0), roofPeak);
        const rR = pushVert(...toW(+ohw, yTop, 0), roofPeak);
        idx.push(r0, r1, rR, r0, rR, rL, r2, r3, rL, r2, rL, rR);
      } else {
        // Cumeeira ao longo de V; oitões na frente/fundos ±V
        const gF = pushVert(...toW(0, yTop, +hd), wallTop);
        const gB = pushVert(...toW(0, yTop, -hd), wallTop);
        idx.push(wt0, wt1, gF, wt2, wt3, gB);
        const r0 = pushVert(...toW(-ohw, yOver, +ohd), roofBase);
        const r1 = pushVert(...toW(+ohw, yOver, +ohd), roofBase);
        const r2 = pushVert(...toW(+ohw, yOver, -ohd), roofBase);
        const r3 = pushVert(...toW(-ohw, yOver, -ohd), roofBase);
        const rF = pushVert(...toW(0, yTop, +ohd), roofPeak);
        const rB = pushVert(...toW(0, yTop, -ohd), roofPeak);
        idx.push(r1, r2, rB, r1, rB, rF, r3, r0, rF, r3, rF, rB);
      }
    } else {
      // Quatro águas (hipped)
      const r0 = pushVert(...toW(-ohw, yOver, +ohd), roofBase);
      const r1 = pushVert(...toW(+ohw, yOver, +ohd), roofBase);
      const r2 = pushVert(...toW(+ohw, yOver, -ohd), roofBase);
      const r3 = pushVert(...toW(-ohw, yOver, -ohd), roofBase);
      if (Math.abs(w - d) < 1.8) {
        const apex = pushVert(...toW(0, yTop, 0), roofPeak);
        idx.push(r0, r1, apex, r1, r2, apex, r2, r3, apex, r3, r0, apex);
      } else if (w >= d) {
        const rl = Math.min(ohw * 0.6, (w - d) * 0.45);
        const rL = pushVert(...toW(-rl, yTop, 0), roofPeak);
        const rR = pushVert(...toW(+rl, yTop, 0), roofPeak);
        idx.push(r0, r1, rR, r0, rR, rL, r1, r2, rR, r2, r3, rL, r2, rL, rR, r3, r0, rL);
      } else {
        const rl = Math.min(ohd * 0.6, (d - w) * 0.45);
        const rF = pushVert(...toW(0, yTop, +rl), roofPeak);
        const rB = pushVert(...toW(0, yTop, -rl), roofPeak);
        idx.push(r0, r1, rF, r1, r2, rB, r1, rB, rF, r2, r3, rB, r3, r0, rF, r3, rF, rB);
      }
    }

    // Janelas simples por cor de vértice (faixas limpas na fachada frontal e posterior)
    const eps = 0.06;
    const addFrontWin = (u0: number, u1: number, y0: number, y1: number) => {
      const a = pushVert(...toW(u0, y0, +hd + eps), winColor);
      const b = pushVert(...toW(u1, y0, +hd + eps), winColor);
      const c = pushVert(...toW(u1, y1, +hd + eps), winColor);
      const e = pushVert(...toW(u0, y1, +hd + eps), winColor);
      idx.push(a, b, c, a, c, e);
    };
    const addBackWin = (u0: number, u1: number, y0: number, y1: number) => {
      const a = pushVert(...toW(u1, y0, -hd - eps), winColor);
      const b = pushVert(...toW(u0, y0, -hd - eps), winColor);
      const c = pushVert(...toW(u0, y1, -hd - eps), winColor);
      const e = pushVert(...toW(u1, y1, -hd - eps), winColor);
      idx.push(a, b, c, a, c, e);
    };

    if (floors === 1) {
      const y0 = yGround + 1.0, y1 = yGround + 2.25;
      addFrontWin(-hw * 0.66, +hw * 0.66, y0, y1);
      addBackWin(-hw * 0.52, +hw * 0.52, y0, y1);
    } else {
      for (let f = 0; f < floors; f++) {
        const y0 = yGround + f * FLOOR_H + 1.0;
        const y1 = y0 + 1.25;
        addFrontWin(-hw * 0.72, +hw * 0.72, y0, y1);
      }
    }

    registerObb(obb);
    lots.push({ cx, cz, w, d, angle, floors, roof, yBase, yGround, yTop });
    return true;
  };

  const shuffle = <T>(arr: T[]) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  };

  // 6. Passo 1: lotes alinhados e recuados ao longo das vias (ordem embaralhada para cobertura uniforme)
  const roadCandidates: { line: number[]; cls: number; roadHalf: number }[] = [];
  layout.roadLines.forEach((group, cls) => {
    if (cls === 0) return; // motorway (BR-040): sem fachadas coladas à rodovia
    const roadHalf = group.width / 0.72 / 2;
    for (const line of group.lines) roadCandidates.push({ line, cls, roadHalf });
  });
  shuffle(roadCandidates);

  for (const { line, cls, roadHalf } of roadCandidates) {
    if (pos.length / 3 >= MAX_VERTS - 40) break;
    const step = cls <= 2 ? 28 : 26;
    let acc = 0;
    let next = 10 + r() * 10;
    for (let i = 0; i + 3 < line.length; i += 2) {
      const ax = line[i], az = line[i + 1], bx = line[i + 2], bz = line[i + 3];
      const segLen = Math.hypot(bx - ax, bz - az);
      if (segLen < 1) continue;
      const tx = (bx - ax) / segLen, tz = (bz - az) / segLen;
      const nx = -tz, nz = tx; // normal à esquerda do sentido da via
      while (next <= acc + segLen) {
        const t = (next - acc) / segLen;
        const px = ax + (bx - ax) * t;
        const pz = az + (bz - az) * t;
        const baseAngle = Math.atan2(tz, tx);
        for (const side of [-1, 1] as const) {
          // Frente (+v) voltada para a rua
          const faceAngle = side === 1 ? baseAngle + Math.PI : baseAngle;
          const off1 = roadHalf + ROAD_MARGIN + 7.5 + r() * 4.5;
          tryPlace(px + nx * side * off1, pz + nz * side * off1, faceAngle, 0.92);
          // Segunda fileira recuada nos quarteirões urbanos
          if (r() < 0.50) {
            const off2 = off1 + 18 + r() * 8;
            tryPlace(px + nx * side * off2, pz + nz * side * off2, faceAngle, 0.75);
          }
        }
        next += step + r() * 8;
      }
      acc += segLen;
    }
  }

  // 7. Passo 2: preenchimento uniforme do miolo dos bairros e quarteirões
  const PITCH = 32;
  const gridCells: [number, number][] = [];
  for (let gz = minZ; gz <= maxZ; gz += PITCH) {
    for (let gx = minX; gx <= maxX; gx += PITCH) gridCells.push([gx, gz]);
  }
  shuffle(gridCells);

  for (const [gx, gz] of gridCells) {
    if (pos.length / 3 >= MAX_VERTS - 40) break;
    const cx = gx + (r() - 0.5) * 12;
    const cz = gz + (r() - 0.5) * 12;
    const near = nearestRoadAngle(cx, cz);
    const dNeigh = nearestNeighborhoodDist(cx, cz);
    if (near.gap > 150 && dNeigh > 260) continue;
    const angle = near.gap < 150 ? near.angle : (Math.floor(r() * 4) * Math.PI) / 2;
    tryPlace(cx, cz, angle, 0.72);
  }

  return {
    mesh: { pos, idx, col, normals: calculateNormals(pos, idx) },
    lots,
  };
}

let cache: { mesh: MeshData; lots: BairroLot[] } | undefined;
const cached = () => (cache ??= buildBairros());

/** Malha única dos bairros de Juiz de Fora (cor por vértice, determinística). */
export function bairrosData(): MeshData {
  return cached().mesh;
}

/** Metadados dos lotes gerados (posições, andares, telhados e cotas) para inspeção e testes. */
export function bairrosLots(): readonly BairroLot[] {
  return cached().lots;
}

/** Reconstrói sem cache (útil para validar determinismo em testes). */
export function buildBairrosMesh(): MeshData {
  return buildBairros().mesh;
}
