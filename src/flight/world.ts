import {
  type AppBase,
  ADDRESS_CLAMP_TO_EDGE,
  CULLFACE_FRONT,
  Color,
  Entity,
  Mesh,
  MeshInstance,
  PIXELFORMAT_SRGBA8,
  StandardMaterial,
  Texture,
  calculateNormals,
} from 'playcanvas';
import { clamp01, fbm, rng, smoothstep } from './noise';

// ---------------------------------------------------------------------------
// Geografia: cidade plana no centro, mar ao sul, montanhas ao norte e oeste.
// Norte = -Z, leste = +X.
// ---------------------------------------------------------------------------
export const WORLD_SIZE = 6000;
const CITY = { x0: -900, x1: 900, z0: -700, z1: 480 };
const CITY_Y = 3;

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

  // Cidade: achata o terreno (com transição suave nas bordas)
  const dx = Math.max(CITY.x0 - x, 0, x - CITY.x1);
  const dz = Math.max(CITY.z0 - z, 0, z - CITY.z1);
  const flat = 1 - smoothstep(0, 260, Math.hypot(dx, dz));
  const flatTarget = z > CITY.z1 ? Math.min(CITY_Y, h) : CITY_Y;
  return h * (1 - flat) + flatTarget * flat;
}

// ---------------------------------------------------------------------------
// Utilitários de malha
// ---------------------------------------------------------------------------
function buildMesh(app: AppBase, pos: number[], idx: number[], col: number[], uv?: number[]) {
  const mesh = new Mesh(app.graphicsDevice);
  mesh.setPositions(pos);
  mesh.setNormals(calculateNormals(pos, idx));
  mesh.setColors32(col);
  if (uv) mesh.setUvs(0, uv);
  mesh.setIndices(pos.length / 3 > 65535 ? new Uint32Array(idx) : new Uint16Array(idx));
  mesh.update();
  return mesh;
}

function meshEntity(app: AppBase, name: string, mesh: Mesh, material: StandardMaterial) {
  const e = new Entity(name);
  e.addComponent('render', { meshInstances: [new MeshInstance(mesh, material)] });
  app.root.addChild(e);
  return e;
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

function buildTerrain(app: AppBase) {
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

  const m = new StandardMaterial();
  m.diffuseVertexColor = true;
  m.gloss = 0.1;
  m.update();
  meshEntity(app, 'Terrain', buildMesh(app, pos, idx, col), m);
}

// ---------------------------------------------------------------------------
// Mar
// ---------------------------------------------------------------------------
function buildSea(app: AppBase) {
  const m = new StandardMaterial();
  m.diffuse = new Color(0.12, 0.52, 0.62);
  m.specular = new Color(0.9, 0.75, 0.6);
  m.gloss = 0.85;
  m.update();
  const e = new Entity('Sea');
  e.addComponent('render', { type: 'plane', material: m, castShadows: false });
  e.setLocalScale(WORLD_SIZE * 3, 1, WORLD_SIZE * 3);
  e.setPosition(0, 0, 0);
  app.root.addChild(e);
}

// ---------------------------------------------------------------------------
// Cidade: todos os prédios numa única malha (1 draw call), janelas emissivas
// ---------------------------------------------------------------------------
const WINDOW_M = 3.2; // metros por janela
const TEX_WINDOWS = 16; // janelas por lado da textura

function windowTextures(app: AppBase) {
  const px = 16;
  const size = px * TEX_WINDOWS;
  const r = rng(77);
  const diffuse = document.createElement('canvas');
  const emissive = document.createElement('canvas');
  diffuse.width = diffuse.height = emissive.width = emissive.height = size;
  const gd = diffuse.getContext('2d')!;
  const ge = emissive.getContext('2d')!;
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
  const make = (c: HTMLCanvasElement) => {
    const t = new Texture(app.graphicsDevice, {
      width: size,
      height: size,
      format: PIXELFORMAT_SRGBA8,
      mipmaps: true,
      anisotropy: 4,
    });
    t.setSource(c);
    return t;
  };
  return { diffuse: make(diffuse), emissive: make(emissive) };
}

const FACADES = ['#9aa3b5', '#7c86a3', '#c9b79a', '#b97a5f', '#6f9ea3', '#a99ab8', '#d8d2c4', '#5f6b8a'].map(hex);

export type Box = { x0: number; x1: number; z0: number; z1: number; top: number };

function buildCity(app: AppBase, boxes: Box[]) {
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

  const { diffuse, emissive } = windowTextures(app);
  const m = new StandardMaterial();
  m.diffuseMap = diffuse;
  m.diffuseVertexColor = true;
  m.emissiveMap = emissive;
  m.emissive = new Color(1, 1, 1);
  m.emissiveIntensity = 1.6;
  m.gloss = 0.3;
  m.update();
  meshEntity(app, 'City', buildMesh(app, pos, idx, col, uv), m);

  // Asfalto das ruas e parques
  const road = new StandardMaterial();
  road.diffuse = new Color(0.33, 0.33, 0.38);
  road.gloss = 0.15;
  road.update();
  const ground = new Entity('Streets');
  ground.addComponent('render', { type: 'plane', material: road, castShadows: false });
  ground.setLocalScale(CITY.x1 - CITY.x0 + 40, 1, CITY.z1 - CITY.z0 + 40);
  ground.setPosition((CITY.x0 + CITY.x1) / 2, CITY_Y + 0.05, (CITY.z0 + CITY.z1) / 2);
  app.root.addChild(ground);

  const park = new StandardMaterial();
  park.diffuse = new Color(0.36, 0.6, 0.3);
  park.update();
  for (const p of parks) {
    const e = new Entity('Park');
    e.addComponent('render', { type: 'plane', material: park, castShadows: false });
    e.setLocalScale(p.x1 - p.x0, 1, p.z1 - p.z0);
    e.setPosition((p.x0 + p.x1) / 2, CITY_Y + 0.1, (p.z0 + p.z1) / 2);
    app.root.addChild(e);
  }
}

// ---------------------------------------------------------------------------
// Céu (domo com degradê de fim de tarde) e nuvens
// ---------------------------------------------------------------------------
export const SKY_HORIZON = new Color(0.98, 0.72, 0.55);

function buildSky(app: AppBase) {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#3e3f86'); // topo
  grad.addColorStop(0.32, '#8a6fb8');
  grad.addColorStop(0.47, '#f2a27a');
  grad.addColorStop(0.5, '#fbb98c'); // horizonte
  grad.addColorStop(1, '#fbb98c');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const tex = new Texture(app.graphicsDevice, {
    width: 4,
    height: 256,
    format: PIXELFORMAT_SRGBA8,
    mipmaps: false,
    addressU: ADDRESS_CLAMP_TO_EDGE,
    addressV: ADDRESS_CLAMP_TO_EDGE,
  });
  tex.setSource(c);

  const m = new StandardMaterial();
  m.useLighting = false;
  m.useFog = false;
  m.diffuse = new Color(0, 0, 0);
  m.emissiveMap = tex;
  m.emissive = new Color(1, 1, 1);
  m.cull = CULLFACE_FRONT;
  m.depthWrite = false;
  m.update();
  const sky = new Entity('Sky');
  sky.addComponent('render', { type: 'sphere', material: m, castShadows: false });
  sky.setLocalScale(9000, 9000, 9000);
  app.root.addChild(sky);
  return sky;
}

function buildClouds(app: AppBase) {
  const r = rng(5);
  const m = new StandardMaterial();
  m.diffuse = new Color(0.95, 0.86, 0.92);
  m.emissive = new Color(0.45, 0.32, 0.42);
  m.gloss = 0;
  m.update();
  const shade = new StandardMaterial();
  shade.diffuse = new Color(0.62, 0.52, 0.78);
  shade.emissive = new Color(0.2, 0.16, 0.3);
  shade.update();

  for (let i = 0; i < 46; i++) {
    const cx = (r() - 0.5) * WORLD_SIZE * 1.1;
    const cz = (r() - 0.5) * WORLD_SIZE * 1.1;
    const cy = 650 + r() * 500;
    const parts = 3 + Math.floor(r() * 4);
    const g = new Entity('Cloud');
    app.root.addChild(g);
    g.setPosition(cx, cy, cz);
    for (let k = 0; k < parts; k++) {
      const e = new Entity('puff');
      e.addComponent('render', { type: 'sphere', material: k === 0 ? shade : m, castShadows: false });
      const s = 70 + r() * 110;
      e.setLocalScale(s * 1.7, s * 0.45, s);
      e.setLocalPosition((r() - 0.5) * 220, k === 0 ? -15 : r() * 25, (r() - 0.5) * 140);
      g.addChild(e);
    }
  }
}

// ---------------------------------------------------------------------------

export type World = {
  sky: Entity;
  /** Altura do obstáculo mais alto em (x, z): terreno, mar (0) ou prédio. */
  groundAt: (x: number, z: number) => number;
};

export function buildWorld(app: AppBase): World {
  const boxes: Box[] = [];
  buildTerrain(app);
  buildSea(app);
  buildCity(app, boxes);
  buildClouds(app);
  const sky = buildSky(app);

  // Grade espacial de 100 m para achar prédios próximos rápido
  const CELL = 100;
  const grid = new Map<string, Box[]>();
  for (const b of boxes) {
    for (let gx = Math.floor(b.x0 / CELL); gx <= Math.floor(b.x1 / CELL); gx++) {
      for (let gz = Math.floor(b.z0 / CELL); gz <= Math.floor(b.z1 / CELL); gz++) {
        const k = `${gx},${gz}`;
        let list = grid.get(k);
        if (!list) grid.set(k, (list = []));
        list.push(b);
      }
    }
  }

  const groundAt = (x: number, z: number) => {
    let h = Math.max(terrainHeight(x, z), 0);
    const list = grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`);
    if (list) {
      for (const b of list) {
        if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && b.top > h) h = b.top;
      }
    }
    return h;
  };

  return { sky, groundAt };
}
