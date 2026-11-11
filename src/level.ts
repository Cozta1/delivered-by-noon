import {
  type AppBase,
  Color,
  Entity,
  PIXELFORMAT_SRGBA8,
  StandardMaterial,
  Texture,
  Vec2,
  Vec3,
} from 'playcanvas';
import { Target } from './scripts/target';

type V3 = [number, number, number];
type Pattern = 'grid' | 'ribs' | 'planks';
type Look = { bg: string; line: string; pattern: Pattern; tile: number; gloss?: number };

// Aparência de cada tipo de peça. "tile" = metros cobertos por uma repetição da textura.
const LOOKS = {
  floor: { bg: '#6f7378', line: '#5a5e63', pattern: 'grid', tile: 2 },
  wall: { bg: '#4a5058', line: '#3a3f46', pattern: 'ribs', tile: 2 },
  dock: { bg: '#8a8f96', line: '#6c7178', pattern: 'grid', tile: 2 },
  crate: { bg: '#a67c4e', line: '#7d5a35', pattern: 'planks', tile: 1.2 },
  ramp: { bg: '#9a7a52', line: '#735a3a', pattern: 'planks', tile: 1 },
  red: { bg: '#a8392f', line: '#7e2a23', pattern: 'ribs', tile: 2.4, gloss: 0.35 },
  blue: { bg: '#2f5f9e', line: '#234776', pattern: 'ribs', tile: 2.4, gloss: 0.35 },
  green: { bg: '#3f7a4a', line: '#2f5b37', pattern: 'ribs', tile: 2.4, gloss: 0.35 },
  orange: { bg: '#c9762c', line: '#9a5a21', pattern: 'ribs', tile: 2.4, gloss: 0.35 },
  white: { bg: '#c9ccd0', line: '#a3a7ac', pattern: 'ribs', tile: 2.4, gloss: 0.35 },
} satisfies Record<string, Look>;
type Kind = keyof typeof LOOKS;
type ContainerColor = 'red' | 'blue' | 'green' | 'orange' | 'white';

const textures = new Map<Kind, Texture>();
const materials = new Map<string, StandardMaterial>();

function makeTexture(app: AppBase, kind: Kind) {
  let tex = textures.get(kind);
  if (tex) return tex;
  const look: Look = LOOKS[kind];
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = look.bg;
  g.fillRect(0, 0, size, size);
  g.strokeStyle = look.line;

  if (look.pattern === 'grid') {
    g.lineWidth = 2;
    for (let i = 0; i <= 4; i++) {
      const p = (i * size) / 4;
      g.beginPath();
      g.moveTo(p, 0);
      g.lineTo(p, size);
      g.moveTo(0, p);
      g.lineTo(size, p);
      g.stroke();
    }
    g.lineWidth = 6;
    g.strokeRect(0, 0, size, size);
  } else if (look.pattern === 'ribs') {
    // Chapa corrugada: faixas verticais com luz/sombra
    const ribs = 8;
    for (let i = 0; i < ribs; i++) {
      const x = (i * size) / ribs;
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.fillRect(x, 0, size / ribs / 2, size);
      g.fillStyle = 'rgba(0,0,0,0.12)';
      g.fillRect(x + size / ribs / 2, 0, 3, size);
    }
    g.lineWidth = 8;
    g.strokeRect(0, 0, size, size);
  } else {
    // Tábuas
    g.lineWidth = 4;
    for (let i = 0; i <= 4; i++) {
      const y = (i * size) / 4;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(size, y);
      g.stroke();
    }
    g.lineWidth = 10;
    g.strokeRect(0, 0, size, size);
  }

  tex = new Texture(app.graphicsDevice, {
    width: size,
    height: size,
    format: PIXELFORMAT_SRGBA8,
    mipmaps: true,
    anisotropy: 8,
  });
  tex.setSource(c);
  textures.set(kind, tex);
  return tex;
}

function material(app: AppBase, kind: Kind, size: V3) {
  const look: Look = LOOKS[kind];
  const dims = [...size].sort((a, b) => b - a);
  const tx = Math.max(1, Math.round(dims[0] / look.tile));
  const ty = Math.max(1, Math.round(dims[1] / look.tile));
  const key = `${kind}:${tx}:${ty}`;
  let m = materials.get(key);
  if (m) return m;
  m = new StandardMaterial();
  m.diffuseMap = makeTexture(app, kind);
  m.diffuseMapTiling = new Vec2(tx, ty);
  m.gloss = look.gloss ?? 0.2;
  m.update();
  materials.set(key, m);
  return m;
}

function solid(app: AppBase, kind: Kind, pos: V3, size: V3, rot: V3 = [0, 0, 0]) {
  const e = new Entity(kind);
  e.addComponent('render', { type: 'box', material: material(app, kind, size) });
  e.setLocalScale(...size);
  app.root.addChild(e);
  e.setPosition(...pos);
  e.setEulerAngles(...rot);
  e.addComponent('collision', { type: 'box', halfExtents: new Vec3(size[0] / 2, size[1] / 2, size[2] / 2) });
  e.addComponent('rigidbody', { type: 'static', friction: 0.5, restitution: 0 });
  return e;
}

// Contêiner padrão de 20 pés (6.1 x 2.6 x 2.44 m)
const C_LEN = 6.1;
const C_H = 2.6;
const C_W = 2.44;

/** Contêiner com base no chão em (x, z); level 1 = empilhado em cima de outro. */
function container(app: AppBase, color: ContainerColor, x: number, z: number, yaw = 0, level = 0) {
  return solid(app, color, [x, C_H / 2 + level * C_H, z], [C_LEN, C_H, C_W], [0, yaw, 0]);
}

function crate(app: AppBase, x: number, z: number, size = 1.2, y = 0) {
  return solid(app, 'crate', [x, y + size / 2, z], [size, size, size]);
}

/** Rampa reta subindo no eixo X de (x0, base) até (x1, base + height). */
function rampX(app: AppBase, x0: number, x1: number, z: number, height: number, width: number) {
  const run = x1 - x0;
  const angle = (Math.atan2(height, Math.abs(run)) * 180) / Math.PI;
  const len = Math.hypot(run, height) + 0.3;
  const thick = 0.3;
  const y = height / 2 - thick / 2 / Math.cos((angle * Math.PI) / 180);
  const sign = run > 0 ? 1 : -1; // + em Z levanta o lado +x
  return solid(app, 'ramp', [(x0 + x1) / 2, y, z], [len, thick, width], [0, 0, sign * angle]);
}

function target(app: AppBase, pos: V3, yaw = 0, moveAmplitude = 0) {
  const bodyMat = new StandardMaterial();
  bodyMat.diffuse = new Color(0.85, 0.22, 0.2);
  bodyMat.gloss = 0.4;
  bodyMat.update();
  const headMat = new StandardMaterial();
  headMat.diffuse = new Color(0.95, 0.82, 0.25);
  headMat.gloss = 0.4;
  headMat.update();

  const root = new Entity('Target');
  root.addComponent('render', { type: 'capsule', material: bodyMat });
  root.setLocalScale(0.7, 0.9, 0.7); // cápsula padrão (1x2) -> 0.7 x 1.8
  app.root.addChild(root);
  root.setPosition(pos[0], pos[1] + 0.9, pos[2]);
  root.setEulerAngles(0, yaw, 0);
  root.addComponent('collision', { type: 'capsule', radius: 0.35, height: 1.8, axis: 1 });
  root.addComponent('rigidbody', { type: 'kinematic' });

  const head = new Entity('Head');
  head.tags.add('head');
  head.addComponent('render', { type: 'sphere', material: headMat });
  root.addChild(head);
  head.setLocalPosition(0, 1.17, 0); // compensa a escala do pai
  head.setLocalScale(0.6 / 0.7, 0.6 / 0.9, 0.6 / 0.7);
  head.addComponent('collision', { type: 'sphere', radius: 0.3 });
  head.addComponent('rigidbody', { type: 'kinematic' });

  root.addComponent('script');
  const t = root.script!.create(Target, { properties: { moveAmplitude } }) as unknown as Target;
  t.materials = [bodyMat, headMat];
  return root;
}

/**
 * "Pátio de Carga": mapa pequeno e fechado (40 x 32 m) de combate rápido.
 * Layout original e propositalmente assimétrico:
 * - plataforma de carga elevada a oeste, com rampa
 * - contêineres soltos e empilhados formando corredores curtos
 * - caixas servindo de degraus para subir nas pilhas
 */
export function buildLevel(app: AppBase) {
  const W = 40;
  const D = 32;

  // Chão e muros do pátio
  solid(app, 'floor', [0, -0.5, 0], [W + 2, 1, D + 2]);
  solid(app, 'wall', [0, 3, -D / 2 - 0.5], [W + 2, 6, 1]);
  solid(app, 'wall', [0, 3, D / 2 + 0.5], [W + 2, 6, 1]);
  solid(app, 'wall', [-W / 2 - 0.5, 3, 0], [1, 6, D]);
  solid(app, 'wall', [W / 2 + 0.5, 3, 0], [1, 6, D]);

  // Plataforma de carga (oeste), topo a 1.2 m, com rampa vindo do centro
  solid(app, 'dock', [-16, 0.6, -2], [7, 1.2, 14]);
  rampX(app, -6.5, -12.5, 2.5, 1.2, 3);

  // Contêineres: corredor central quebrado
  container(app, 'red', -4, -3, 90);
  container(app, 'blue', 3, 2.5, 0);
  container(app, 'green', 9, -4, 90);
  container(app, 'white', -1, 9, 15);

  // Pilha nordeste (dois andares) com caixas de degrau
  container(app, 'orange', 13, 10, 0);
  container(app, 'blue', 13, 10, 0, 1);
  container(app, 'green', 13, 12.5, 0);
  crate(app, 9.2, 10, 1.2);
  crate(app, 9.2, 8.6, 1.2);
  crate(app, 9.2, 8.6, 1.2, 1.2);

  // Pilha sudeste
  container(app, 'white', 15, -11, 90);
  container(app, 'red', 15, -11, 90, 1);
  crate(app, 12.6, -13.5, 1.2);
  crate(app, 12.6, -12.2, 1.2);
  crate(app, 12.6, -12.2, 1.2, 1.2);

  // Contêiner em cima da plataforma de carga
  solid(app, 'orange', [-17.5, 1.2 + C_H / 2, -6], [C_LEN, C_H, C_W], [0, 90, 0]);

  // Caixas soltas para cobertura
  crate(app, -9, 6);
  crate(app, -10.2, 6.4, 1);
  crate(app, 5, -9);
  crate(app, -2, -12);
  crate(app, 6, 12, 1);
  crate(app, -14, 12);
  crate(app, 0.5, -6.8, 1);

  // Alvos (alguns se movem)
  target(app, [-17, 1.2, 3]);
  target(app, [13, C_H * 2, 10]); // em cima da pilha
  target(app, [15, C_H * 2, -11]);
  target(app, [0, 0, -1], 0, 2.5);
  target(app, [-8, 0, -10], 90, 3);
  target(app, [6, 0, 7], 0, 2);
  target(app, [-12, 0, 13]);
  target(app, [18, 0, 0], 90, 3);
}

export const SPAWN: V3 = [-6, 0, 13];
