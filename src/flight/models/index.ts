// CONTRATO (dono: maestro; implementação: Gemini). Ponto único para criar o modelo de qualquer veículo.
// O gerenciador de veículos (vehicles.ts, Codex) só chama buildVehicleModel; mantém assinatura intacta.
import { type AppBase, Entity, type StandardMaterial } from 'playcanvas';
import { type AirplaneModel, buildAirplane } from '../airplane';
import { buildHelicopter } from '../helicopter';
import type { VehicleKind } from '../types';
import { attachAsyncGlb, collectNodesByPrefix, makeMaterial } from './glb';

/** Mesmo formato do AirplaneModel: root, exterior, prop (hélice/rotor), wingTips, materials, hitbox, wheels?, tailRotor?. */
export type VehicleModel = AirplaneModel;

const CAR_VARIANTS: ReadonlyArray<{
  filename: string;
  label: string;
  body: [number, number, number];
  accent: [number, number, number];
  size: [number, number, number];
  wheelRadius: number;
  wheelX: number;
  wheelZ: number;
  hasBed?: boolean;
  hasWing?: boolean;
}> = [
  {
    filename: 'carro-compacto.glb',
    label: 'Compacto',
    body: [0.1, 0.56, 0.58],
    accent: [0.93, 0.94, 0.95],
    size: [1.78, 1.48, 3.88],
    wheelRadius: 0.32,
    wheelX: 0.84,
    wheelZ: 1.2,
  },
  {
    filename: 'carro-picape.glb',
    label: 'Picape',
    body: [0.84, 0.42, 0.1],
    accent: [0.16, 0.18, 0.2],
    size: [1.94, 1.72, 4.86],
    wheelRadius: 0.4,
    wheelX: 0.94,
    wheelZ: 1.5,
    hasBed: true,
  },
  {
    filename: 'carro-esportivo.glb',
    label: 'Esportivo',
    body: [0.86, 0.16, 0.14],
    accent: [0.96, 0.96, 0.98],
    size: [1.94, 1.24, 4.48],
    wheelRadius: 0.34,
    wheelX: 0.93,
    wheelZ: 1.37,
    hasWing: true,
  },
];

function buildCar(app: AppBase, variant: number, parent: Entity): VehicleModel {
  const idx = ((Math.floor(variant) % CAR_VARIANTS.length) + CAR_VARIANTS.length) % CAR_VARIANTS.length;
  const spec = CAR_VARIANTS[idx];

  const mBody = makeMaterial(...spec.body, 0.72);
  const mAccent = makeMaterial(...spec.accent, 0.65);
  const mGlass = makeMaterial(0.09, 0.15, 0.22, 0.9);
  const mDark = makeMaterial(0.11, 0.12, 0.14, 0.38);
  const mRim = makeMaterial(0.78, 0.8, 0.84, 0.8);
  const mHead = makeMaterial(1.0, 0.95, 0.72, 0.85);
  const mTail = makeMaterial(0.88, 0.1, 0.08, 0.8);
  const materials: StandardMaterial[] = [mBody, mAccent, mGlass, mDark, mRim, mHead, mTail];

  const root = new Entity(`Carro_${spec.label}`, app);
  parent.addChild(root);

  const procedural = new Entity(`Procedural_${spec.label}`, app);
  root.addChild(procedural);
  const exterior: Entity[] = [];

  const part = (
    name: string,
    m: StandardMaterial,
    p: [number, number, number],
    s: [number, number, number],
    rot: [number, number, number] = [0, 0, 0],
    target: Entity = procedural,
    type: 'box' | 'cylinder' = 'box',
  ) => {
    const e = new Entity(name, app);
    e.addComponent('render', { type, material: m });
    e.setLocalScale(...s);
    e.setLocalPosition(...p);
    e.setLocalEulerAngles(...rot);
    target.addChild(e);
    exterior.push(e);
    return e;
  };

  const [w, h, l] = spec.size;
  const r = spec.wheelRadius;
  const bodyH = spec.hasWing ? 0.44 : 0.56;
  const bodyY = r + bodyH * 0.48;

  part('chassis', mBody, [0, bodyY, 0], [w, bodyH, l]);
  part('bumperF', mDark, [0, r + 0.08, -l * 0.5], [w + 0.03, 0.22, 0.18]);
  part('bumperR', mDark, [0, r + 0.08, l * 0.5], [w + 0.03, 0.22, 0.18]);

  // Cabine conforme variante (compacto / picape / esportivo)
  if (spec.hasBed) {
    part('cabin', mGlass, [0, bodyY + 0.62, -0.22], [w * 0.9, 0.68, 1.55]);
    part('roof', mBody, [0, h - 0.05, -0.2], [w * 0.88, 0.1, 1.5]);
    part('bedFloor', mAccent, [0, bodyY + 0.26, 1.48], [w * 0.86, 0.08, 1.7]);
    part('rollbar', mAccent, [0, h - 0.06, 0.66], [w * 0.88, 0.09, 0.1]);
  } else if (spec.hasWing) {
    part('cabin', mGlass, [0, bodyY + 0.44, 0.24], [w * 0.78, 0.44, 1.75]);
    part('roof', mBody, [0, h - 0.03, 0.22], [w * 0.7, 0.07, 1.25]);
    part('stripe', mAccent, [0, bodyY + bodyH * 0.52, -0.05], [0.34, 0.03, l * 0.92]);
    part('spoiler', mDark, [0, 1.06, l * 0.45], [w * 0.96, 0.06, 0.32], [8, 0, 0]);
  } else {
    part('cabin', mGlass, [0, bodyY + 0.56, 0.22], [w * 0.84, 0.56, 2.15]);
    part('roof', mAccent, [0, h - 0.04, 0.25], [w * 0.8, 0.09, 1.95]);
  }

  for (const s of [-1, 1] as const) {
    part(`headlight_${s < 0 ? 'L' : 'R'}`, mHead, [s * (w * 0.34), bodyY + 0.08, -l * 0.5], [0.34, 0.14, 0.08]);
    part(`taillight_${s < 0 ? 'L' : 'R'}`, mTail, [s * (w * 0.35), bodyY + 0.1, l * 0.5], [0.32, 0.16, 0.08]);
  }

  // 4 rodas separadas ("Roda_*") para girar em X
  const wheelSpecs: ReadonlyArray<[string, number, number]> = [
    ['Roda_FL', -spec.wheelX, -spec.wheelZ],
    ['Roda_FR', spec.wheelX, -spec.wheelZ],
    ['Roda_RL', -spec.wheelX, spec.wheelZ],
    ['Roda_RR', spec.wheelX, spec.wheelZ],
  ];
  const wheels: Entity[] = [];
  for (const [wName, wx, wz] of wheelSpecs) {
    const wheel = new Entity(wName, app);
    wheel.setLocalPosition(wx, r, wz);
    procedural.addChild(wheel);
    part(`${wName}_tire`, mDark, [0, 0, 0], [r * 2, 0.24, r * 2], [0, 0, 90], wheel, 'cylinder');
    part(`${wName}_rim`, mRim, [0, 0, 0], [r * 1.15, 0.26, r * 1.15], [0, 0, 90], wheel, 'cylinder');
    wheels.push(wheel);
  }

  // Nó vazio `prop` (contrato VehicleModel)
  const prop = new Entity('prop', app);
  root.addChild(prop);

  const tipL = new Entity('wingTipL', app);
  const tipR = new Entity('wingTipR', app);
  tipL.setLocalPosition(-w * 0.5, h * 0.5, 0);
  tipR.setLocalPosition(w * 0.5, h * 0.5, 0);
  root.addChild(tipL);
  root.addChild(tipR);

  const hitbox: [number, number, number][] = [];
  for (const x of [-w * 0.5, w * 0.5]) {
    for (const y of [0, h]) {
      for (const z of [-l * 0.5, l * 0.5]) hitbox.push([x, y, z]);
    }
  }

  const model: VehicleModel = {
    root,
    exterior,
    prop,
    wingTips: [tipL, tipR],
    materials,
    hitbox,
    wheels,
  };

  attachAsyncGlb({
    app,
    root,
    procedural,
    model,
    filename: spec.filename,
    onMounted(glbRoot) {
      const glbWheels = collectNodesByPrefix(glbRoot, 'roda_');
      if (glbWheels.length > 0) {
        wheels.length = 0;
        for (let i = 0; i < glbWheels.length; i++) wheels.push(glbWheels[i]);
      }
    },
  });

  return model;
}

function buildCharacter(app: AppBase, parent: Entity): VehicleModel {
  const mSuit = makeMaterial(0.08, 0.24, 0.58, 0.35);
  const mOrange = makeMaterial(0.94, 0.42, 0.06, 0.45);
  const mHelmet = makeMaterial(0.94, 0.95, 0.97, 0.78);
  const mVisor = makeMaterial(0.05, 0.07, 0.12, 0.92);
  const mDark = makeMaterial(0.1, 0.11, 0.14, 0.35);
  const materials: StandardMaterial[] = [mSuit, mOrange, mHelmet, mVisor, mDark];

  const root = new Entity('Personagem', app);
  parent.addChild(root);

  const procedural = new Entity('ProceduralPersonagem', app);
  root.addChild(procedural);
  const exterior: Entity[] = [];

  const part = (
    name: string,
    m: StandardMaterial,
    p: [number, number, number],
    s: [number, number, number],
    type: 'box' | 'sphere' | 'cylinder' = 'box',
  ) => {
    const e = new Entity(name, app);
    e.addComponent('render', { type, material: m });
    e.setLocalScale(...s);
    e.setLocalPosition(...p);
    procedural.addChild(e);
    exterior.push(e);
    return e;
  };

  // Personagem original: macacão azul + detalhes laranja + capacete branco fechado com viseira escura
  for (const s of [-1, 1] as const) {
    part(`boot_${s}`, mDark, [s * 0.13, 0.08, -0.03], [0.13, 0.16, 0.24]);
    part(`leg_${s}`, mSuit, [s * 0.13, 0.52, 0], [0.17, 0.64, 0.17], 'cylinder');
    part(`knee_${s}`, mOrange, [s * 0.13, 0.48, -0.08], [0.11, 0.1, 0.06]);
    part(`shoulder_${s}`, mOrange, [s * 0.28, 1.35, 0], [0.17, 0.16, 0.17], 'sphere');
    part(`arm_${s}`, mSuit, [s * 0.31, 1.1, -0.01], [0.13, 0.44, 0.13], 'cylinder');
    part(`glove_${s}`, mDark, [s * 0.33, 0.83, -0.03], [0.12, 0.14, 0.13], 'sphere');
  }
  part('belt', mOrange, [0, 0.94, 0], [0.44, 0.07, 0.27]);
  part('torso', mSuit, [0, 1.19, 0], [0.46, 0.45, 0.26]);
  part('chestBand', mOrange, [0, 1.24, -0.135], [0.36, 0.1, 0.03]);
  part('helmet', mHelmet, [0, 1.61, 0.01], [0.31, 0.34, 0.34], 'sphere');
  part('visor', mVisor, [0, 1.62, -0.07], [0.27, 0.17, 0.24], 'sphere');
  part('helmetCrest', mOrange, [0, 1.77, 0.02], [0.06, 0.04, 0.22]);

  const prop = new Entity('prop', app);
  root.addChild(prop);
  const tipL = new Entity('wingTipL', app);
  const tipR = new Entity('wingTipR', app);
  tipL.setLocalPosition(-0.38, 1.0, 0);
  tipR.setLocalPosition(0.38, 1.0, 0);
  root.addChild(tipL);
  root.addChild(tipR);

  const hitbox: [number, number, number][] = [];
  for (const x of [-0.36, 0.36]) {
    for (const y of [0, 1.78]) {
      for (const z of [-0.22, 0.22]) hitbox.push([x, y, z]);
    }
  }

  const model: VehicleModel = { root, exterior, prop, wingTips: [tipL, tipR], materials, hitbox };

  attachAsyncGlb({
    app,
    root,
    procedural,
    model,
    filename: 'personagem.glb',
  });

  return model;
}

export function buildVehicleModel(
  app: AppBase,
  kind: VehicleKind,
  variant = 0,
  parent: Entity = app.root,
): VehicleModel {
  if (kind === 'a29') return buildAirplane(app, parent);
  if (kind === 'heli') return buildHelicopter(app, parent);
  if (kind === 'car') return buildCar(app, variant, parent);
  return buildCharacter(app, parent);
}
