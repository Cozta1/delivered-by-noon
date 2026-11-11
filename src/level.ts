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
type Pattern = 'grid' | 'ribs' | 'planks' | 'hazard';
type Look = { bg: string; line: string; pattern: Pattern; tile: number; gloss?: number };

// Aparência de cada tipo de peça. "tile" = metros cobertos por uma repetição da textura.
const LOOKS = {
  floor: { bg: '#6f7378', line: '#5a5e63', pattern: 'grid', tile: 2 },
  wall: { bg: '#4a5058', line: '#3a3f46', pattern: 'ribs', tile: 2 },
  barrier: { bg: '#a9acb0', line: '#8a8d91', pattern: 'grid', tile: 1 },
  crate: { bg: '#a67c4e', line: '#7d5a35', pattern: 'planks', tile: 1.2 },
  plank: { bg: '#9a7a52', line: '#735a3a', pattern: 'planks', tile: 1 },
  crane: { bg: '#d9a520', line: '#2a2a2a', pattern: 'hazard', tile: 2 },
  door: { bg: '#2a2d31', line: '#1d1f22', pattern: 'grid', tile: 2.4 },
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
  } else if (look.pattern === 'hazard') {
    // Listras diagonais de advertência
    g.fillStyle = look.line;
    for (let i = -size; i < size * 2; i += 64) {
      g.beginPath();
      g.moveTo(i, 0);
      g.lineTo(i + 32, 0);
      g.lineTo(i + 32 - size, size);
      g.lineTo(i - size, size);
      g.closePath();
      g.fill();
    }
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

/** Bloco visual (sem física), opcionalmente filho de outra entidade. */
function visual(app: AppBase, kind: Kind, pos: V3, size: V3, rot: V3 = [0, 0, 0], parent?: Entity) {
  const e = new Entity(kind);
  e.addComponent('render', { type: 'box', material: material(app, kind, size) });
  e.setLocalScale(...size);
  (parent ?? app.root).addChild(e);
  e.setLocalPosition(...pos);
  e.setLocalEulerAngles(...rot);
  return e;
}

/** Bloco sólido (render + colisão estática). */
function solid(app: AppBase, kind: Kind, pos: V3, size: V3, rot: V3 = [0, 0, 0]) {
  const e = visual(app, kind, pos, size, rot);
  e.addComponent('collision', { type: 'box', halfExtents: new Vec3(size[0] / 2, size[1] / 2, size[2] / 2) });
  e.addComponent('rigidbody', { type: 'static', friction: 0.5, restitution: 0 });
  return e;
}

// Contêiner padrão de 20 pés
const C_LEN = 6.1;
const C_H = 2.6;
const C_W = 2.44;

/**
 * Contêiner com base no chão em (x, z); level 1 = empilhado em cima de outro.
 * Grupo sem escala: a colisão fica no pai e o visual (corpo, porta, travas) nos filhos.
 */
function container(app: AppBase, color: ContainerColor, x: number, z: number, yaw = 0, level = 0) {
  const g = new Entity(`container-${color}`);
  app.root.addChild(g);
  g.setPosition(x, C_H / 2 + level * C_H, z);
  g.setEulerAngles(0, yaw, 0);
  g.addComponent('collision', { type: 'box', halfExtents: new Vec3(C_LEN / 2, C_H / 2, C_W / 2) });
  g.addComponent('rigidbody', { type: 'static', friction: 0.5, restitution: 0 });

  visual(app, color, [0, 0, 0], [C_LEN, C_H, C_W], [0, 0, 0], g);
  // Porta na ponta +x: painel escuro + 4 travas verticais
  const end = C_LEN / 2 + 0.02;
  visual(app, 'door', [end, 0, 0], [0.04, C_H - 0.2, C_W - 0.16], [0, 0, 0], g);
  for (const zz of [-0.85, -0.35, 0.35, 0.85]) {
    visual(app, 'barrier', [end + 0.04, 0, zz], [0.05, C_H - 0.3, 0.05], [0, 0, 0], g);
  }
  return g;
}

function crate(app: AppBase, x: number, z: number, size = 1.2, y = 0) {
  return solid(app, 'crate', [x, y + size / 2, z], [size, size, size]);
}

/** Passarela de tábua com o topo na altura h. */
function plank(app: AppBase, pos: [number, number], h: number, size: [number, number], yaw = 0) {
  return solid(app, 'plank', [pos[0], h - 0.1, pos[1]], [size[0], 0.2, size[1]], [0, yaw, 0]);
}

/** Guindaste de pórtico decorativo (sem física), atrás do muro. */
function crane(app: AppBase, x: number, z: number, yaw: number) {
  const g = new Entity('crane');
  app.root.addChild(g);
  g.setPosition(x, 0, z);
  g.setEulerAngles(0, yaw, 0);
  const H = 17;
  for (const sx of [-6, 6]) {
    for (const sz of [-2, 2]) visual(app, 'crane', [sx, H / 2, sz], [0.8, H, 0.8], [0, 0, 0], g);
    visual(app, 'crane', [sx, 1.5, 0], [0.6, 0.6, 4.8], [0, 0, 0], g);
  }
  visual(app, 'crane', [0, H, -2], [13, 1.2, 1], [0, 0, 0], g);
  visual(app, 'crane', [0, H, 2], [13, 1.2, 1], [0, 0, 0], g);
  // Lança avançando sobre o pátio
  visual(app, 'crane', [0, H + 0.9, 9], [2.4, 0.8, 26], [0, 0, 0], g);
  visual(app, 'door', [0, H + 2.3, -1], [3, 2, 3], [0, 0, 0], g); // cabine
  visual(app, 'door', [0, H - 2, 14], [0.08, 4, 0.08], [0, 0, 0], g); // cabo
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
 * "Pátio de Carga" — 30 x 30 m, layout original com simetria de rotação (180°):
 * tudo que existe em (x, z) existe também em (-x, -z), então os dois lados são equivalentes.
 *
 * - Rota alta pelo meio: torre A → passarela → teto do contêiner central → passarela → torre B
 * - Torres acessadas por escadas de caixas no lado de fora
 * - Contêineres em ângulo nos cantos opostos e pilhas duplas nos outros dois
 * - Barreiras de concreto e grupos de caixas para cobertura baixa
 */
export function buildLevel(app: AppBase) {
  const S = 15; // meia largura

  // Chão e muros
  solid(app, 'floor', [0, -0.5, 0], [S * 2 + 2, 1, S * 2 + 2]);
  solid(app, 'wall', [0, 2.5, -S - 0.5], [S * 2 + 2, 5, 1]);
  solid(app, 'wall', [0, 2.5, S + 0.5], [S * 2 + 2, 5, 1]);
  solid(app, 'wall', [-S - 0.5, 2.5, 0], [1, 5, S * 2]);
  solid(app, 'wall', [S + 0.5, 2.5, 0], [1, 5, S * 2]);

  // Peça central (topo a 2.6 m, faz parte da rota alta)
  container(app, 'white', 0, 0, 0);

  // Tudo abaixo é colocado em pares espelhados (x, z) e (-x, -z)
  const mirrored = (place: (sx: number) => void) => {
    place(1);
    place(-1);
  };

  mirrored((s) => {
    // Torre ligada ao centro por passarela
    container(app, s > 0 ? 'blue' : 'red', 6.5 * s, 2.5 * s, 90);
    plank(app, [4.15 * s, 0.2 * s], C_H, [2.5, 1.4]);
    // Escada de caixas por fora da torre: 1.2 -> 2.4 -> topo 2.6
    crate(app, 8.4 * s, 4 * s);
    crate(app, 8.4 * s, 2.6 * s);
    crate(app, 8.4 * s, 2.6 * s, 1.2, 1.2);

    // Contêiner de corredor lateral
    container(app, s > 0 ? 'green' : 'orange', -3 * s, 9 * s, 0);
    // Contêiner em ângulo no canto
    container(app, s > 0 ? 'orange' : 'green', 9.5 * s, 9 * s, 30);
    // Pilha dupla no canto oposto
    container(app, s > 0 ? 'red' : 'blue', -11.5 * s, 12 * s, 0);
    container(app, 'white', -11.5 * s, 12 * s, 0, 1);

    // Cobertura baixa
    solid(app, 'barrier', [0, 0.45, 5 * s], [2.4, 0.9, 0.5]);
    crate(app, 3.5 * s, 6 * s);
    crate(app, 2.4 * s, 6.3 * s, 1);
    crate(app, 11 * s, -3 * s);
    crate(app, 11.2 * s, -4.3 * s, 1);
    solid(app, 'barrier', [-10 * s, 0.45, -1 * s], [0.5, 0.9, 2.4]);
  });

  // Guindaste decorativo atrás do muro norte, lança sobre o pátio
  crane(app, 2, -S - 6, 0);

  // Alvos (alguns se movem)
  target(app, [6.5, C_H, 3.5]); // em cima da torre B
  target(app, [-6.5, C_H, -3.5]); // em cima da torre A
  target(app, [5, 0, -4], 0, 1.5);
  target(app, [-5, 0, 4], 0, 1.5);
  target(app, [0, 0, 12], 0, 4);
  target(app, [0, 0, -12], 0, 4);
  target(app, [-11.5, C_H * 2, 12]); // no topo da pilha
  target(app, [12.5, 0, 3]);
  target(app, [-12.5, 0, -3]);
}

/** Canto livre, olhando para o centro. */
export const SPAWN: V3 = [-13, 0, -13];
export const SPAWN_YAW = -135;
