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
} from 'playcanvas';
import { CITY, CITY_Y, WORLD_SIZE, terrainHeight, terrainData, cityData, cloudData, windowImages, skyImage, type Box, type MeshData, type ImageData } from './world-data';
export { WORLD_SIZE, terrainHeight, type Box } from './world-data';

// ---------------------------------------------------------------------------
// Utilitários de malha
// ---------------------------------------------------------------------------
function buildMesh(app: AppBase, { pos, normals, idx, col, uv }: MeshData) {
  const mesh = new Mesh(app.graphicsDevice);
  mesh.setPositions(pos);
  mesh.setNormals(normals);
  mesh.setColors32(col);
  if (uv) mesh.setUvs(0, uv);
  mesh.setIndices(pos.length / 3 > 65535 ? new Uint32Array(idx) : new Uint16Array(idx));
  mesh.update();
  return mesh;
}

function imageCanvas(data: ImageData) {
  const c = document.createElement('canvas');
  c.width = data.width;
  c.height = data.height;
  const g = c.getContext('2d')!;
  if (data.gradient.length) {
    const grad = g.createLinearGradient(0, 0, 0, data.height);
    for (const [offset, color] of data.gradient) grad.addColorStop(offset, color);
    g.fillStyle = grad;
    g.fillRect(0, 0, data.width, data.height);
  }
  for (const rect of data.rectangles) {
    g.fillStyle = rect.color;
    g.fillRect(rect.x, rect.y, rect.width, rect.height);
  }
  return c;
}

function meshEntity(parent: Entity, name: string, mesh: Mesh, material: StandardMaterial) {
  const e = new Entity(name);
  e.addComponent('render', { meshInstances: [new MeshInstance(mesh, material)] });
  parent.addChild(e);
  return e;
}

function buildTerrain(app: AppBase, parent: Entity, materials: StandardMaterial[]) {
  const m = new StandardMaterial();
  m.diffuseVertexColor = true;
  m.gloss = 0.1;
  m.update();
  materials.push(m);
  meshEntity(parent, 'Terrain', buildMesh(app, terrainData()), m);
}

// ---------------------------------------------------------------------------
// Mar
// ---------------------------------------------------------------------------
function buildSea(parent: Entity, materials: StandardMaterial[]) {
  const m = new StandardMaterial();
  m.diffuse = new Color(0.12, 0.52, 0.62);
  m.specular = new Color(0.9, 0.75, 0.6);
  m.gloss = 0.85;
  m.update();
  materials.push(m);
  const e = new Entity('Sea');
  e.addComponent('render', { type: 'plane', material: m, castShadows: false });
  e.setLocalScale(WORLD_SIZE * 3, 1, WORLD_SIZE * 3);
  e.setPosition(0, 0, 0);
  parent.addChild(e);
}

// ---------------------------------------------------------------------------
// Cidade: todos os prédios numa única malha (1 draw call), janelas emissivas
// ---------------------------------------------------------------------------
function windowTextures(app: AppBase) {
  const { diffuse, emissive } = windowImages();
  const size = diffuse.width;
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
  return { diffuse: make(imageCanvas(diffuse)), emissive: make(imageCanvas(emissive)) };
}

function buildCity(
  app: AppBase,
  parent: Entity,
  boxes: Box[],
  materials: StandardMaterial[],
  textures: Texture[],
) {
  const { mesh, boxes: buildings, parks } = cityData();
  boxes.push(...buildings);
  const { diffuse, emissive } = windowTextures(app);
  textures.push(diffuse, emissive);
  const m = new StandardMaterial();
  m.diffuseMap = diffuse;
  m.diffuseVertexColor = true;
  m.emissiveMap = emissive;
  m.emissive = new Color(1, 1, 1);
  m.emissiveIntensity = 1.6;
  m.gloss = 0.3;
  m.update();
  materials.push(m);
  meshEntity(parent, 'City', buildMesh(app, mesh), m);

  // Asfalto das ruas e parques
  const road = new StandardMaterial();
  road.diffuse = new Color(0.33, 0.33, 0.38);
  road.gloss = 0.15;
  road.update();
  materials.push(road);
  const ground = new Entity('Streets');
  ground.addComponent('render', { type: 'plane', material: road, castShadows: false });
  ground.setLocalScale(CITY.x1 - CITY.x0 + 40, 1, CITY.z1 - CITY.z0 + 40);
  ground.setPosition((CITY.x0 + CITY.x1) / 2, CITY_Y, (CITY.z0 + CITY.z1) / 2);
  parent.addChild(ground);

  const park = new StandardMaterial();
  park.diffuse = new Color(0.36, 0.6, 0.3);
  park.update();
  materials.push(park);
  for (const p of parks) {
    const e = new Entity('Park');
    e.addComponent('render', { type: 'plane', material: park, castShadows: false });
    e.setLocalScale(p.x1 - p.x0, 1, p.z1 - p.z0);
    e.setPosition((p.x0 + p.x1) / 2, CITY_Y + 0.15, (p.z0 + p.z1) / 2);
    parent.addChild(e);
  }
}

// ---------------------------------------------------------------------------
// Céu (domo com degradê de fim de tarde) e nuvens
// ---------------------------------------------------------------------------
export const SKY_HORIZON = new Color(0.98, 0.72, 0.55);

function buildSky(
  app: AppBase,
  parent: Entity,
  materials: StandardMaterial[],
  textures: Texture[],
) {
  const c = imageCanvas(skyImage());
  const tex = new Texture(app.graphicsDevice, {
    width: 4,
    height: 256,
    format: PIXELFORMAT_SRGBA8,
    mipmaps: false,
    addressU: ADDRESS_CLAMP_TO_EDGE,
    addressV: ADDRESS_CLAMP_TO_EDGE,
  });
  tex.setSource(c);
  textures.push(tex);

  const m = new StandardMaterial();
  m.useLighting = false;
  m.useFog = false;
  m.diffuse = new Color(0, 0, 0);
  m.emissiveMap = tex;
  m.emissive = new Color(1, 1, 1);
  m.cull = CULLFACE_FRONT;
  m.depthWrite = false;
  m.update();
  materials.push(m);
  const sky = new Entity('Sky');
  sky.addComponent('render', { type: 'sphere', material: m, castShadows: false });
  sky.setLocalScale(9000, 9000, 9000);
  parent.addChild(sky);
  return sky;
}

function buildClouds(parent: Entity, materials: StandardMaterial[]) {
  const m = new StandardMaterial();
  m.diffuse = new Color(0.95, 0.86, 0.92);
  m.emissive = new Color(0.45, 0.32, 0.42);
  m.gloss = 0;
  m.update();
  const shade = new StandardMaterial();
  shade.diffuse = new Color(0.62, 0.52, 0.78);
  shade.emissive = new Color(0.2, 0.16, 0.3);
  shade.update();
  materials.push(m, shade);

  for (const cloud of cloudData()) {
    const g = new Entity('Cloud');
    parent.addChild(g);
    g.setPosition(...cloud.position);
    for (const puff of cloud.puffs) {
      const e = new Entity('puff');
      e.addComponent('render', { type: 'sphere', material: puff.shade ? shade : m, castShadows: false });
      e.setLocalScale(...puff.scale);
      e.setLocalPosition(...puff.position);
      g.addChild(e);
    }
  }
}

// ---------------------------------------------------------------------------

export type World = {
  sky: Entity;
  /** Altura do obstáculo mais alto em (x, z): terreno, mar (0) ou prédio. */
  groundAt: (x: number, z: number) => number;
  materials: StandardMaterial[];
  textures: Texture[];
};

export function buildWorld(app: AppBase, parent: Entity = app.root): World {
  const boxes: Box[] = [];
  const materials: StandardMaterial[] = [];
  const textures: Texture[] = [];
  buildTerrain(app, parent, materials);
  buildSea(parent, materials);
  buildCity(app, parent, boxes, materials, textures);
  buildClouds(parent, materials);
  const sky = buildSky(app, parent, materials, textures);

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
    if (x >= CITY.x0 - 20 && x <= CITY.x1 + 20 && z >= CITY.z0 - 20 && z <= CITY.z1 + 20 && CITY_Y > h) {
      h = CITY_Y;
    }
    const list = grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`);
    if (list) {
      for (const b of list) {
        if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && b.top > h) h = b.top;
      }
    }
    return h;
  };

  return { sky, groundAt, materials, textures };
}
