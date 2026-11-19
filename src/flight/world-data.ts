import { calculateNormals } from 'playcanvas';
import { clamp01, fbm, rng, smoothstep } from './noise';

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
export const CITY = { x0: -900, x1: 900, z0: -700, z1: 480 };
export const CITY_Y = 3;

/** Altura do terreno (m). Abaixo de 0 é mar. */
export function terrainHeight(x: number, z: number) {
  // Relevo base ondulado
  let h = 8 + (fbm(x / 700, z / 700, 4, 3) - 0.5) * 70;

  // Montanhas: mais fortes ao norte e oeste, longe da cidade
  const north = smoothstep(-600, -1600, z);
  const west = smoothstep(-700, -1700, x);
  const ridge = 1 - Math.abs(fbm(x / 1300, z / 1300, 5, 9) * 2 - 1); // cristas
  const mountainMask = Math.max(north, west * 0.8, smoothstep(1100, 2000, x) * 0.6);
  h += Math.pow(ridge, 2.2) * 620 * mountainMask;

  // Litoral: o terreno mergulha no mar ao sul, com borda irregular
  const coastZ = 560 + (fbm(x / 400, 7, 3, 5) - 0.5) * 260;
  const sea = smoothstep(coastZ - 60, coastZ + 260, z);
  h = h * (1 - sea) - sea * 60;

  // Cidade: achata o terreno abaixo das ruas (com transição suave nas bordas)
  const dx = Math.max(CITY.x0 - x, 0, x - CITY.x1);
  const dz = Math.max(CITY.z0 - z, 0, z - CITY.z1);
  const flat = 1 - smoothstep(25, 280, Math.hypot(dx, dz));
  const groundCityY = CITY_Y - 0.5;
  const flatTarget = z > CITY.z1 ? Math.min(groundCityY, h) : groundCityY;
  return h * (1 - flat) + flatTarget * flat;
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
const SAND = hex('#e8cf92');
const GRASS = hex('#6fa152');
const AUTUMN = hex('#d9772f');
const RED = hex('#c4472f');
const ROCK = hex('#8d7b9c');
const SNOW = hex('#efe4ef');
const SEABED = hex('#3d8f9a');

export function terrainData() {
  const N = 220;
  const size = WORLD_SIZE;
  const step = size / N;
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];

  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const x = -size / 2 + i * step;
      const z = -size / 2 + j * step;
      const h = terrainHeight(x, z);
      pos.push(x, h, z);

      // Cor por altura + manchas de vegetação de outono
      let c: number[];
      if (h < 0) c = mix(SAND, SEABED, clamp01(-h / 20));
      else if (h < 6 && z > 300) c = SAND;
      else {
        const patch = fbm(x / 160, z / 160, 3, 21);
        c = mix(GRASS, patch > 0.55 ? RED : AUTUMN, smoothstep(0.38, 0.62, patch));
        c = mix(c, ROCK, smoothstep(70, 220, h));
        c = mix(c, SNOW, smoothstep(380, 520, h));
      }
      col.push(c[0], c[1], c[2], 255);
    }
  }
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i;
      const b = a + 1;
      const c = a + N + 1;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }

  return geometry(pos, idx, col);
}

const WINDOW_M = 3.2;
const TEX_WINDOWS = 16;

const FACADES = ['#9aa3b5', '#7c86a3', '#c9b79a', '#b97a5f', '#6f9ea3', '#a99ab8', '#d8d2c4', '#5f6b8a'].map(hex);

export type Box = { x0: number; x1: number; z0: number; z1: number; top: number };

export function cityData() {
  const boxes: Box[] = [];
  const r = rng(2024);
  const pos: number[] = [];
  const col: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const parks: Box[] = [];

  const ROOF_UV = 0.5 / TEX_WINDOWS; // centro da célula sem janela

  const addBuilding = (x: number, z: number, w: number, d: number, h: number, c: number[]) => {
    const x0 = x - w / 2;
    const x1 = x + w / 2;
    const z0 = z - d / 2;
    const z1 = z + d / 2;
    const y0 = CITY_Y - 1;
    const y1 = CITY_Y + h;
    const shade = 0.85 + r() * 0.3;
    const [cr, cg, cb] = c.map((v) => Math.min(255, v * shade));
    const roof = [cr * 0.75, cg * 0.75, cb * 0.75];
    const vScale = h / WINDOW_M / TEX_WINDOWS;
    const u0 = Math.floor(r() * TEX_WINDOWS) / TEX_WINDOWS; // varia o padrão aceso

    // 4 fachadas: [ax, az, bx, bz] no sentido anti-horário visto de fora
    const faces: [number, number, number, number][] = [
      [x0, z1, x1, z1], // sul
      [x1, z1, x1, z0], // leste
      [x1, z0, x0, z0], // norte
      [x0, z0, x0, z1], // oeste
    ];
    for (const [ax, az, bx, bz] of faces) {
      const base = pos.length / 3;
      const len = Math.hypot(bx - ax, bz - az);
      const uMax = u0 + len / WINDOW_M / TEX_WINDOWS;
      pos.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az);
      uv.push(u0, 0, uMax, 0, uMax, vScale, u0, vScale);
      for (let k = 0; k < 4; k++) col.push(cr, cg, cb, 255);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    // Telhado
    const base = pos.length / 3;
    pos.push(x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0);
    for (let k = 0; k < 4; k++) {
      uv.push(ROOF_UV, ROOF_UV);
      col.push(roof[0], roof[1], roof[2], 255);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    boxes.push({ x0, x1, z0, z1, top: y1 });
  };

  // Quarteirões de 70 m com ruas de 16 m
  const BLOCK = 70;
  const STREET = 16;
  const cell = BLOCK + STREET;
  for (let bz = CITY.z0; bz + BLOCK <= CITY.z1; bz += cell) {
    for (let bx = CITY.x0; bx + BLOCK <= CITY.x1; bx += cell) {
      const cx = bx + BLOCK / 2;
      const cz = bz + BLOCK / 2;
      if (r() < 0.07) {
        parks.push({ x0: bx, x1: bx + BLOCK, z0: bz, z1: bz + BLOCK, top: CITY_Y });
        continue;
      }
      // Mais alto no centro (downtown um pouco ao norte do centro)
      const dist = Math.hypot(cx / 650, (cz + 150) / 500);
      const tall = Math.exp(-dist * dist * 1.6);
      const split = r() < 0.55 ? 2 : 1;
      const sub = BLOCK / split;
      for (let sx = 0; sx < split; sx++) {
        for (let sz = 0; sz < split; sz++) {
          const w = sub * (0.72 + r() * 0.2);
          const d = sub * (0.72 + r() * 0.2);
          const h = 14 + r() * 30 + tall * (60 + r() * 160);
          const x = bx + sub * (sx + 0.5);
          const z = bz + sub * (sz + 0.5);
          addBuilding(x, z, w, d, h, FACADES[Math.floor(r() * FACADES.length)]);
        }
      }
    }
  }

  return { mesh: geometry(pos, idx, col, uv), boxes, parks };
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
