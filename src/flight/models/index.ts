// CONTRATO (dono: maestro; implementação: Gemini). Ponto único para criar o modelo de qualquer veículo.
// O gerenciador de veículos (vehicles.ts, Codex) só chama buildVehicleModel; o Gemini troca o conteúdo
// pelos modelos do Blender sem mudar a assinatura.
import { type AppBase, Color, Entity, StandardMaterial } from 'playcanvas';
import { type AirplaneModel, buildAirplane } from '../airplane';
import type { VehicleKind } from '../types';

/** Mesmo formato do AirplaneModel: root, exterior, prop (hélice/rotor/rodas), wingTips, materials, hitbox. */
export type VehicleModel = AirplaneModel;

export function buildVehicleModel(app: AppBase, kind: VehicleKind, variant = 0, parent: Entity = app.root): VehicleModel {
  if (kind === 'a29') return buildAirplane(app, parent);
  // STUB provisório (caixas) até o Gemini entregar os modelos de carro, helicóptero e personagem.
  const size: Record<Exclude<VehicleKind, 'a29'>, [number, number, number]> = {
    car: [1.9, 1.4, 4.3],
    heli: [2.4, 2.8, 10],
    foot: [0.6, 1.8, 0.4],
  };
  const [w, h, l] = size[kind];
  const m = new StandardMaterial();
  m.diffuse = new Color(kind === 'car' ? 0.8 : 0.5, 0.3 + 0.2 * (variant % 3), 0.2);
  m.update();
  const root = new Entity(`veiculo-${kind}`);
  parent.addChild(root);
  const body = new Entity('corpo');
  body.addComponent('render', { type: 'box', material: m });
  body.setLocalScale(w, h, l);
  body.setLocalPosition(0, h / 2, 0);
  root.addChild(body);
  const prop = new Entity('prop');
  root.addChild(prop);
  const tipL = new Entity('tipL');
  const tipR = new Entity('tipR');
  tipL.setLocalPosition(-w / 2, h / 2, 0);
  tipR.setLocalPosition(w / 2, h / 2, 0);
  root.addChild(tipL);
  root.addChild(tipR);
  const hitbox: [number, number, number][] = [];
  for (const x of [-w / 2, w / 2]) for (const y of [0, h]) for (const z of [-l / 2, l / 2]) hitbox.push([x, y, z]);
  return { root, exterior: [body], prop, wingTips: [tipL, tipR], materials: [m], hitbox } as VehicleModel;
}
