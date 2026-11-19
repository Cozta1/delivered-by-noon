import { type AppBase, Color, Entity, FOG_LINEAR, TONEMAP_ACES } from 'playcanvas';
import { buildAirplane } from './airplane';
import { createCameraRig } from './cameras';
import { createCockpit } from './cockpit';
import { createFlightController } from './flight';
import { createHud } from './hud';
import { createSmoke } from './smoke';
import { createFlightState, type FlightContext, type FlightModule } from './types';
import { SKY_HORIZON, buildWorld } from './world';

export function startFlightSim(app: AppBase, uiRoot: HTMLElement): { destroy(): void } {
  // Preserva luz ambiente e névoa originais para restaurar no destroy()
  const prevAmbient = app.scene.ambientLight.clone();
  const prevFog = {
    type: app.scene.fog.type,
    color: app.scene.fog.color.clone(),
    density: app.scene.fog.density,
    start: app.scene.fog.start,
    end: app.scene.fog.end,
  };

  // Luz de fim de tarde + névoa na cor do horizonte (esconde a borda do mundo)
  app.scene.ambientLight = new Color(0.55, 0.48, 0.55);
  app.scene.fog.type = FOG_LINEAR;
  app.scene.fog.color = SKY_HORIZON.clone();
  app.scene.fog.start = 900;
  app.scene.fog.end = 4200;

  const simRoot = new Entity('FlightSimRoot');
  app.root.addChild(simRoot);

  const sun = new Entity('Sun');
  sun.addComponent('light', {
    type: 'directional',
    color: new Color(1, 0.8, 0.6),
    intensity: 1.7,
    castShadows: false,
  });
  sun.setEulerAngles(58, 125, 0);
  simRoot.addChild(sun);

  const world = buildWorld(app, simRoot);
  const plane = buildAirplane(app, simRoot);

  const camera = new Entity('Camera');
  camera.addComponent('camera', {
    clearColor: SKY_HORIZON.clone(),
    fov: 65,
    nearClip: 1.0,
    farClip: 6000,
    toneMapping: TONEMAP_ACES,
  });
  simRoot.addChild(camera);

  // Desliga câmeras e luzes pré-existentes da cena (ex.: cena padrão do Editor)
  const disabledEntities: Entity[] = [];
  for (const type of ['camera', 'light'] as const) {
    for (const comp of app.root.findComponents(type)) {
      const entity = comp.entity;
      if (entity !== camera && entity !== sun && entity !== simRoot && entity !== app.root && entity.enabled) {
        entity.enabled = false;
        disabledEntities.push(entity);
      }
    }
  }

  const materials = new Set([...world.materials, ...plane.materials]);
  const textures = new Set(world.textures);

  const ctx: FlightContext = { app, world, plane, camera, state: createFlightState() };

  // Ordem fixa (contrato em types.ts): voo → câmeras → cabine → HUD → fumaça
  const modules: FlightModule[] = [
    createFlightController(ctx),
    createCameraRig(ctx),
    createCockpit(ctx, uiRoot),
    createHud(ctx, uiRoot),
    createSmoke(ctx),
  ];

  world.sky.setPosition(camera.getPosition());

  const onUpdate = (dt: number) => {
    dt = Math.min(dt, 0.05);
    for (const m of modules) m.update(dt);
    // O céu acompanha a câmera (parece infinito)
    world.sky.setPosition(camera.getPosition());
  };
  app.on('update', onUpdate);

  // Depuração pelo console do navegador
  Object.assign(window, { app, flight: ctx.state });

  let destroyed = false;
  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;

      app.off('update', onUpdate);
      for (const m of modules) m.destroy?.();

      simRoot.destroy();
      for (const mat of materials) mat.destroy();
      for (const tex of textures) tex.destroy();
      materials.clear();
      textures.clear();

      app.scene.ambientLight = prevAmbient.clone();
      app.scene.fog.type = prevFog.type;
      app.scene.fog.color = prevFog.color.clone();
      app.scene.fog.density = prevFog.density;
      app.scene.fog.start = prevFog.start;
      app.scene.fog.end = prevFog.end;

      for (const entity of disabledEntities) {
        if (entity.parent) entity.enabled = true;
      }
    },
  };
}
