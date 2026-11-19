import { type AppBase, Color, Entity, StandardMaterial } from 'playcanvas';

function mat(r: number, g: number, b: number, gloss = 0.5, opacity = 1) {
  const m = new StandardMaterial();
  m.diffuse = new Color(r, g, b);
  m.gloss = gloss;
  if (opacity < 1) {
    m.opacity = opacity;
    m.blendType = 2; // BLEND_NORMAL
    m.depthWrite = false;
  }
  m.update();
  return m;
}

export type AirplaneModel = {
  root: Entity;
  /** Partes externas (escondidas na câmera de cabine). */
  exterior: Entity[];
  prop: Entity;
  /** Pontas das asas, para os rastros. */
  wingTips: [Entity, Entity];
  materials: StandardMaterial[];
};

/**
 * Monomotor de asa baixa, montado com caixas. Frente = -Z local.
 * Envergadura ~10 m, comprimento ~8 m.
 */
export function buildAirplane(app: AppBase, parent: Entity = app.root): AirplaneModel {
  const white = mat(0.92, 0.92, 0.9, 0.6);
  const accent = mat(0.9, 0.36, 0.14, 0.6);
  const dark = mat(0.14, 0.15, 0.18, 0.4);
  const glass = mat(0.35, 0.55, 0.7, 0.9, 0.55);
  const materials = [white, accent, dark, glass];

  const root = new Entity('Airplane');
  parent.addChild(root);
  const exterior: Entity[] = [];

  const part = (
    name: string,
    m: StandardMaterial,
    p: [number, number, number],
    s: [number, number, number],
    rot: [number, number, number] = [0, 0, 0],
    parent: Entity = root,
  ) => {
    const e = new Entity(name);
    e.addComponent('render', { type: 'box', material: m });
    e.setLocalScale(...s);
    e.setLocalPosition(...p);
    e.setLocalEulerAngles(...rot);
    parent.addChild(e);
    exterior.push(e);
    return e;
  };

  // Fuselagem (afina para a cauda)
  part('fuselage', white, [0, 0, -0.4], [1.15, 1.25, 4.2]);
  part('tailboom', white, [0, 0.1, 2.9], [0.8, 0.85, 2.8]);
  part('stripe', accent, [0, -0.1, 0.2], [1.17, 0.25, 6.4]);
  part('cowling', dark, [0, -0.05, -2.75], [1.05, 1.05, 0.6]);
  part('spinner', accent, [0, -0.05, -3.15], [0.35, 0.35, 0.35], [0, 0, 45]);
  part('canopy', glass, [0, 0.75, -0.6], [0.95, 0.55, 1.7]);

  // Asas com pontas laranja
  part('wing', white, [0, -0.45, -0.6], [10, 0.16, 1.6]);
  part('tipL', accent, [-4.75, -0.45, -0.6], [0.5, 0.18, 1.62]);
  part('tipR', accent, [4.75, -0.45, -0.6], [0.5, 0.18, 1.62]);

  // Empenagem
  part('stab', white, [0, 0.2, 3.9], [3.6, 0.12, 0.9]);
  part('fin', accent, [0, 0.95, 3.95], [0.12, 1.5, 1.0]);

  // Trem de pouso fixo
  for (const x of [-1.2, 1.2]) {
    part('strut', dark, [x, -0.95, -0.7], [0.08, 0.9, 0.12]);
    part('wheel', dark, [x, -1.4, -0.7], [0.18, 0.5, 0.5]);
  }
  part('noseStrut', dark, [0, -0.95, -2.5], [0.08, 0.8, 0.1]);
  part('noseWheel', dark, [0, -1.35, -2.5], [0.16, 0.4, 0.4]);

  // Hélice (gira em torno de Z)
  const prop = new Entity('prop');
  prop.setLocalPosition(0, -0.05, -3.3);
  root.addChild(prop);
  part('bladeA', dark, [0, 0, 0], [0.14, 2.2, 0.05], [0, 0, 0], prop);
  part('bladeB', dark, [0, 0, 0], [0.14, 2.2, 0.05], [0, 0, 90], prop);

  const tipL = new Entity('wingTipL');
  tipL.setLocalPosition(-5, -0.45, -0.2);
  const tipR = new Entity('wingTipR');
  tipR.setLocalPosition(5, -0.45, -0.2);
  root.addChild(tipL);
  root.addChild(tipR);

  return { root, exterior, prop, wingTips: [tipL, tipR], materials };
}
