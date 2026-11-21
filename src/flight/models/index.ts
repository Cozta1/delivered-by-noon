// CONTRATO (dono: maestro; implementação: Gemini). Ponto único para criar o modelo de qualquer veículo.
// O gerenciador de veículos (vehicles.ts, Codex) só chama buildVehicleModel; mantém assinatura intacta.
import { type AppBase, BLEND_ADDITIVE, Color, Entity, StandardMaterial } from 'playcanvas';
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

function makeGlowMaterial(
  r: number,
  g: number,
  b: number,
  opacity: number,
  intensity = 1.6,
): StandardMaterial {
  const m = new StandardMaterial();
  m.useLighting = false;
  m.diffuse = new Color(0, 0, 0);
  m.emissive = new Color(r, g, b);
  m.emissiveIntensity = intensity;
  m.opacity = opacity;
  m.blendType = BLEND_ADDITIVE;
  m.depthWrite = false;
  m.update();
  return m;
}

/**
 * Faróis leves (lentes emissivas + cones aditivos no asfalto, sem luzes dinâmicas)
 * anexados direto ao `root` para sobreviver à troca assíncrona de GLB e acender à noite via daynight.ts.
 */
function attachCarHeadlights(
  app: AppBase,
  root: Entity,
  materials: StandardMaterial[],
  width: number,
  lensY: number,
  frontZ: number,
  tint: [number, number, number] = [1.0, 0.95, 0.78],
): void {
  const group = new Entity('CarHeadlights', app);
  group.enabled = false;
  root.addChild(group);

  const mLens = makeGlowMaterial(tint[0], tint[1], tint[2], 0.92, 2.4);
  const mBeam = makeGlowMaterial(tint[0], tint[1], tint[2], 0.22, 1.4);
  materials.push(mLens, mBeam);

  for (const s of [-1, 1] as const) {
    const lx = s * (width * 0.34);

    const lens = new Entity(`HeadlightGlow_${s < 0 ? 'L' : 'R'}`, app);
    lens.addComponent('render', { type: 'box', material: mLens, castShadows: false, receiveShadows: false });
    lens.setLocalScale(0.36, 0.16, 0.08);
    lens.setLocalPosition(lx, lensY, frontZ - 0.05);
    group.addChild(lens);

    // Feixe projetado no asfalto à frente (-Z local)
    const beam = new Entity(`HeadlightBeam_${s < 0 ? 'L' : 'R'}`, app);
    beam.addComponent('render', { type: 'plane', material: mBeam, castShadows: false, receiveShadows: false });
    beam.setLocalScale(2.1, 1, 11.5);
    beam.setLocalPosition(lx * 1.18, 0.09, frontZ - 6.0);
    beam.setLocalEulerAngles(0, s * -5, 0);
    group.addChild(beam);
  }
}

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
    e.addComponent('render', { type, material: m, castShadows: false, receiveShadows: false });
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

  attachCarHeadlights(app, root, materials, w, bodyY + 0.08, -l * 0.5);

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

/**
 * Carro tunado original ("Delivered by Midnight"): variação esportiva larga com aerofólio GT,
 * saias laterais, entrada de ar no capô, rodas grandes com aro dourado, neon azul/ciano embaixo
 * e chamas de nitro nos escapes.
 */
function buildTunedCar(app: AppBase, parent: Entity): VehicleModel {
  const mBody = makeMaterial(0.95, 0.12, 0.54, 0.88);
  mBody.emissive = new Color(0.14, 0.01, 0.08);
  mBody.update();

  const mAccent = makeMaterial(0.08, 0.94, 0.98, 0.9);
  mAccent.emissive = new Color(0.06, 0.55, 0.62);
  mAccent.update();

  const mCarbon = makeMaterial(0.08, 0.09, 0.12, 0.55);
  const mGlass = makeMaterial(0.05, 0.1, 0.18, 0.94);
  const mRim = makeMaterial(0.98, 0.78, 0.2, 0.9);
  const mCaliper = makeMaterial(0.98, 0.22, 0.18, 0.75);
  const mHead = makeMaterial(0.88, 0.97, 1.0, 0.95);
  mHead.emissive = new Color(0.75, 0.92, 1.0);
  mHead.update();

  const mTail = makeMaterial(1.0, 0.12, 0.24, 0.9);
  mTail.emissive = new Color(0.9, 0.08, 0.2);
  mTail.update();

  const mNeonTube = makeGlowMaterial(0.1, 0.96, 1.0, 0.95, 2.6);
  const mNeonPool = makeGlowMaterial(0.08, 0.92, 1.0, 0.42, 2.0);
  const mNitroFlame = makeGlowMaterial(0.24, 0.86, 1.0, 0.9, 3.0);

  const materials: StandardMaterial[] = [
    mBody,
    mAccent,
    mCarbon,
    mGlass,
    mRim,
    mCaliper,
    mHead,
    mTail,
    mNeonTube,
    mNeonPool,
    mNitroFlame,
  ];

  const root = new Entity('Carro_Tunado', app);
  parent.addChild(root);

  const procedural = new Entity('Procedural_Tunado', app);
  root.addChild(procedural);

  const exterior: Entity[] = [];
  const part = (
    name: string,
    m: StandardMaterial,
    p: [number, number, number],
    s: [number, number, number],
    rot: [number, number, number] = [0, 0, 0],
    target: Entity = procedural,
    type: 'box' | 'cylinder' | 'plane' | 'cone' = 'box',
  ) => {
    const e = new Entity(name, app);
    e.addComponent('render', { type, material: m, castShadows: false, receiveShadows: false });
    e.setLocalScale(...s);
    e.setLocalPosition(...p);
    e.setLocalEulerAngles(...rot);
    target.addChild(e);
    exterior.push(e);
    return e;
  };

  const w = 2.12;
  const h = 1.24;
  const l = 4.68;
  const r = 0.42; // Rodas grandes
  const bodyH = 0.45;
  const bodyY = r + bodyH * 0.42;

  // Carroceria esportiva rebaixada + capô aerodinâmico
  part('chassis', mBody, [0, bodyY, 0], [w, bodyH, l]);
  part('hoodSlope', mBody, [0, bodyY + 0.14, -1.22], [w * 0.86, 0.18, 1.85], [6, 0, 0]);
  part('hoodScoop', mCarbon, [0, bodyY + 0.27, -1.08], [0.64, 0.13, 0.92], [5, 0, 0]);
  part('hoodVentGlow', mAccent, [0, bodyY + 0.28, -1.52], [0.56, 0.05, 0.08]);

  // Faixas duplas de corrida ciano neon
  for (const s of [-1, 1] as const) {
    part(`stripe_${s < 0 ? 'L' : 'R'}`, mAccent, [s * 0.24, bodyY + bodyH * 0.51, -0.02], [0.16, 0.03, l * 0.94]);
  }

  // Cabine baixa e teto estilo cupê
  part('cabin', mGlass, [0, bodyY + 0.42, 0.24], [w * 0.76, 0.44, 1.82]);
  part('roof', mCarbon, [0, h - 0.04, 0.28], [w * 0.68, 0.08, 1.28]);

  // Alargadores de para-lama (widebody)
  const wheelX = 1.04;
  const wheelZ = 1.44;
  for (const [fName, fx, fz] of [
    ['fender_FL', -w * 0.51, -wheelZ],
    ['fender_FR', w * 0.51, -wheelZ],
    ['fender_RL', -w * 0.52, wheelZ],
    ['fender_RR', w * 0.52, wheelZ],
  ] as const) {
    part(fName, mBody, [fx, r + 0.22, fz], [0.22, 0.38, 1.12]);
  }

  // Splitter dianteiro agressivo + para-choque + difusor traseiro
  part('frontSplitter', mCarbon, [0, 0.2, -l * 0.52], [w + 0.18, 0.09, 0.48]);
  part('frontLipNeon', mAccent, [0, 0.22, -l * 0.57], [w + 0.16, 0.04, 0.06]);
  part('rearDiffuser', mCarbon, [0, 0.28, l * 0.5], [w + 0.04, 0.26, 0.26]);

  // Saias laterais pronunciadas com friso luminoso
  for (const s of [-1, 1] as const) {
    part(`sideSkirt_${s < 0 ? 'L' : 'R'}`, mCarbon, [s * (w * 0.52), 0.22, 0], [0.18, 0.16, 2.2]);
    part(`sideSkirtTrim_${s < 0 ? 'L' : 'R'}`, mAccent, [s * (w * 0.56), 0.24, 0], [0.05, 0.05, 2.1]);
  }

  // Aerofólio GT alto com suportes duplos e endplates
  const wingY = 1.38;
  const wingZ = l * 0.45;
  part('spoilerBlade', mCarbon, [0, wingY, wingZ], [w + 0.24, 0.07, 0.4], [11, 0, 0]);
  part('spoilerTrim', mAccent, [0, wingY + 0.02, wingZ + 0.18], [w + 0.22, 0.03, 0.05], [11, 0, 0]);
  for (const s of [-1, 1] as const) {
    part(`spoilerPillar_${s < 0 ? 'L' : 'R'}`, mCarbon, [s * 0.54, wingY - 0.28, wingZ - 0.02], [0.08, 0.52, 0.24], [-10, 0, 0]);
    part(`spoilerEnd_${s < 0 ? 'L' : 'R'}`, mBody, [s * (w * 0.5 + 0.12), wingY - 0.02, wingZ], [0.05, 0.34, 0.48]);
  }

  // Faróis xenon + lanternas traseiras LED
  for (const s of [-1, 1] as const) {
    part(`headlight_${s < 0 ? 'L' : 'R'}`, mHead, [s * (w * 0.34), bodyY + 0.08, -l * 0.5], [0.42, 0.13, 0.08]);
    part(`taillight_${s < 0 ? 'L' : 'R'}`, mTail, [s * (w * 0.34), bodyY + 0.1, l * 0.5], [0.44, 0.14, 0.08]);
  }
  part('taillightBar', mTail, [0, bodyY + 0.1, l * 0.505], [w * 0.72, 0.05, 0.04]);

  // Escapes duplos + chamas de nitro (ativadas por game.ts quando Shift está pressionado)
  const nitroGroup = new Entity('NitroFlames', app);
  nitroGroup.enabled = false;
  root.addChild(nitroGroup);
  for (const s of [-1, 1] as const) {
    part(`exhaust_${s < 0 ? 'L' : 'R'}`, mRim, [s * 0.48, 0.26, l * 0.51], [0.16, 0.16, 0.24], [90, 0, 0], procedural, 'cylinder');
    const flame = new Entity(`NitroFlame_${s < 0 ? 'L' : 'R'}`, app);
    flame.addComponent('render', { type: 'cone', material: mNitroFlame, castShadows: false, receiveShadows: false });
    flame.setLocalScale(0.24, 1.35, 0.24);
    flame.setLocalPosition(s * 0.48, 0.26, l * 0.52 + 0.72);
    flame.setLocalEulerAngles(90, 0, 0);
    nitroGroup.addChild(flame);
  }

  // Halo neon projetado no chão (preso ao root para brilhar no asfalto mesmo após carregar o GLB)
  const neonPool = new Entity('NeonGlowPool', app);
  neonPool.addComponent('render', { type: 'plane', material: mNeonPool, castShadows: false, receiveShadows: false });
  neonPool.setLocalScale(w + 1.35, 1, l + 1.15);
  neonPool.setLocalPosition(0, 0.06, 0);
  root.addChild(neonPool);

  // Tubos de neon do fallback procedural
  part('neonTube_L', mNeonTube, [-w * 0.48, 0.14, 0], [0.06, 0.05, 2.3]);
  part('neonTube_R', mNeonTube, [w * 0.48, 0.14, 0], [0.06, 0.05, 2.3]);
  part('neonTube_F', mNeonTube, [0, 0.14, -l * 0.46], [w * 0.82, 0.05, 0.06]);
  part('neonTube_B', mNeonTube, [0, 0.14, l * 0.46], [w * 0.82, 0.05, 0.06]);

  // 4 rodas grandes ("Roda_*") com aro dourado e pinça esportiva
  const wheelSpecs: ReadonlyArray<[string, number, number]> = [
    ['Roda_FL', -wheelX, -wheelZ],
    ['Roda_FR', wheelX, -wheelZ],
    ['Roda_RL', -wheelX, wheelZ],
    ['Roda_RR', wheelX, wheelZ],
  ];
  const wheels: Entity[] = [];
  for (const [wName, wx, wz] of wheelSpecs) {
    const wheel = new Entity(wName, app);
    wheel.setLocalPosition(wx, r, wz);
    procedural.addChild(wheel);
    part(`${wName}_tire`, mCarbon, [0, 0, 0], [r * 2, 0.32, r * 2], [0, 0, 90], wheel, 'cylinder');
    part(`${wName}_rim`, mRim, [0, 0, 0], [r * 1.36, 0.34, r * 1.36], [0, 0, 90], wheel, 'cylinder');
    part(`${wName}_hub`, mCaliper, [0, 0, 0], [r * 0.52, 0.36, r * 0.52], [0, 0, 90], wheel, 'cylinder');
    wheels.push(wheel);
  }

  attachCarHeadlights(app, root, materials, w, bodyY + 0.08, -l * 0.5, [0.78, 0.95, 1.0]);

  const prop = new Entity('prop', app);
  root.addChild(prop);

  const tipL = new Entity('wingTipL', app);
  const tipR = new Entity('wingTipR', app);
  tipL.setLocalPosition(-w * 0.55, h * 0.5, 0);
  tipR.setLocalPosition(w * 0.55, h * 0.5, 0);
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
    filename: 'carro-tunado.glb',
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
  if (kind === 'tuned') return buildTunedCar(app, parent);
  if (kind === 'car') return buildCar(app, variant, parent);
  return buildCharacter(app, parent);
}
