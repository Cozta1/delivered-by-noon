import { type AppBase, Entity, type StandardMaterial } from 'playcanvas';
import type { AirplaneModel } from './airplane';
import { attachAsyncGlb, makeMaterial } from './models/glb';

/**
 * Helicóptero original low-poly (esquis tocando y=0, frente = -Z local).
 * Carrega `models/helicoptero.glb` (ou asset container `helicoptero.glb` no Editor)
 * de forma assíncrona com fallback procedural imediato.
 * `prop` aponta para o rotor principal ("Rotor"); `tailRotor` aponta para "TailRotor".
 */
export function buildHelicopter(app: AppBase, parent: Entity = app.root): AirplaneModel {
  const white = makeMaterial(0.94, 0.95, 0.96, 0.65);
  const teal = makeMaterial(0.08, 0.34, 0.42, 0.65);
  const orange = makeMaterial(0.95, 0.46, 0.1, 0.6);
  const dark = makeMaterial(0.12, 0.14, 0.17, 0.45);
  const glass = makeMaterial(0.22, 0.46, 0.64, 0.92, 0.48);
  const materials: StandardMaterial[] = [white, teal, orange, dark, glass];

  const root = new Entity('Helicopter', app);
  parent.addChild(root);

  const procedural = new Entity('ProceduralHeli', app);
  root.addChild(procedural);
  const exterior: Entity[] = [];

  const part = (
    name: string,
    m: StandardMaterial,
    p: [number, number, number],
    s: [number, number, number],
    rot: [number, number, number] = [0, 0, 0],
    targetParent: Entity = procedural,
    type: 'box' | 'cylinder' | 'sphere' = 'box',
  ) => {
    const e = new Entity(name, app);
    e.addComponent('render', { type, material: m });
    e.setLocalScale(...s);
    e.setLocalPosition(...p);
    e.setLocalEulerAngles(...rot);
    targetParent.addChild(e);
    exterior.push(e);
    return e;
  };

  // Fuselagem principal e cabine panorâmica (frente = -Z)
  part('heliBodyLower', teal, [0, 0.92, -0.45], [1.92, 0.64, 4.1]);
  part('heliStripe', orange, [0, 1.18, -0.55], [1.96, 0.22, 4.2]);
  part('heliBodyUpper', white, [0, 1.66, 0.15], [1.84, 0.92, 2.7]);
  part('heliNose', white, [0, 1.12, -2.95], [1.42, 0.68, 1.05]);
  part('heliCanopy', glass, [0, 1.62, -1.85], [1.76, 0.86, 1.75]);
  part('heliEnginePod', teal, [0, 2.34, 0.05], [0.84, 0.42, 2.1]);
  part('heliMast', dark, [0, 2.72, -0.2], [0.18, 0.48, 0.18], [0, 0, 0], procedural, 'cylinder');

  // Cauda e empenagem (+Z)
  part('heliTailBoom', white, [0, 1.58, 3.85], [0.42, 0.44, 4.4]);
  part('heliTailStripe', orange, [0, 1.62, 5.1], [0.45, 0.46, 0.75]);
  part('heliHStab', teal, [0, 1.64, 4.75], [1.85, 0.08, 0.42]);
  part('heliFin', teal, [0, 1.98, 5.95], [0.12, 1.35, 0.76], [16, 0, 0]);
  part('heliFinTip', orange, [0, 2.52, 6.1], [0.13, 0.24, 0.56], [16, 0, 0]);

  // Esquis de pouso (base em y = 0)
  for (const s of [-1, 1] as const) {
    part(`skid_${s < 0 ? 'L' : 'R'}`, dark, [s * 1.05, 0.05, -0.55], [0.1, 0.1, 3.45]);
    part(`strutF_${s < 0 ? 'L' : 'R'}`, dark, [s * 0.88, 0.44, -1.45], [0.08, 0.82, 0.08], [0, 0, s * -22]);
    part(`strutR_${s < 0 ? 'L' : 'R'}`, dark, [s * 0.88, 0.44, 0.55], [0.08, 0.82, 0.08], [0, 0, s * -22]);
  }

  // Rotor principal ("Rotor") — gira em torno de Y
  const rotor = new Entity('Rotor', app);
  rotor.setLocalPosition(0, 2.96, -0.2);
  procedural.addChild(rotor);
  part('rotorHub', dark, [0, 0, 0], [0.38, 0.14, 0.38], [0, 0, 0], rotor, 'cylinder');
  for (let i = 0; i < 4; i++) {
    const deg = i * 90;
    const rad = (deg * Math.PI) / 180;
    const sx = Math.sin(rad);
    const cz = -Math.cos(rad);
    part(`rotorBlade${i}`, dark, [sx * 2.3, 0.02, cz * 2.3], [0.22, 0.035, 4.3], [0, -deg, 0], rotor);
    part(`rotorTip${i}`, orange, [sx * 4.38, 0.02, cz * 4.38], [0.225, 0.038, 0.34], [0, -deg, 0], rotor);
  }

  // Rotor de cauda ("TailRotor") — gira em torno de X
  const tailRotor = new Entity('TailRotor', app);
  tailRotor.setLocalPosition(-0.22, 1.88, 5.95);
  procedural.addChild(tailRotor);
  part('tailRotorHub', dark, [0, 0, 0], [0.16, 0.14, 0.14], [0, 0, 90], tailRotor, 'cylinder');
  part('tailBladeA', dark, [-0.04, 0, 0], [0.03, 1.64, 0.11], [0, 0, 0], tailRotor);
  part('tailBladeTipA', orange, [-0.04, 0.78, 0], [0.033, 0.14, 0.115], [0, 0, 0], tailRotor);
  part('tailBladeTipB', orange, [-0.04, -0.78, 0], [0.033, 0.14, 0.115], [0, 0, 0], tailRotor);

  const tipL = new Entity('wingTipL', app);
  tipL.setLocalPosition(-1.1, 1.2, -0.5);
  const tipR = new Entity('wingTipR', app);
  tipR.setLocalPosition(1.1, 1.2, -0.5);
  root.addChild(tipL);
  root.addChild(tipR);

  const hitbox: [number, number, number][] = [
    [-1.1, 0, -2.35],
    [1.1, 0, -2.35],
    [-1.1, 0, 1.25],
    [1.1, 0, 1.25],
    [-1.05, 2.25, -2.5],
    [1.05, 2.25, -2.5],
    [-1.05, 2.25, 1.6],
    [1.05, 2.25, 1.6],
    [0, 1.1, -3.45],
    [0, 1.72, 6.25],
    [0, 2.98, -0.2],
    [0, 2.65, 6.1],
  ];

  const model: AirplaneModel = {
    root,
    exterior,
    prop: rotor,
    tailRotor,
    wingTips: [tipL, tipR],
    materials,
    hitbox,
  };

  attachAsyncGlb({
    app,
    root,
    procedural,
    model,
    filename: 'helicoptero.glb',
    onMounted(glbRoot) {
      const glbRotor =
        (glbRoot.findByName('Rotor') as Entity | null) ??
        (glbRoot.findByName('rotor') as Entity | null);
      if (glbRotor) {
        glbRotor.setLocalEulerAngles(model.prop.getLocalEulerAngles());
        model.prop = glbRotor;
      } else {
        const empty = new Entity('Rotor', app);
        empty.setLocalPosition(0, 2.96, -0.2);
        glbRoot.addChild(empty);
        model.prop = empty;
      }

      const glbTail =
        (glbRoot.findByName('TailRotor') as Entity | null) ??
        (glbRoot.findByName('tailRotor') as Entity | null);
      if (glbTail) {
        model.tailRotor = glbTail;
      }
    },
  });

  return model;
}
