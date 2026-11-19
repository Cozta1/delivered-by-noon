import { type AppBase, Color, Entity, FOG_LINEAR, TONEMAP_ACES, Vec3 } from 'playcanvas';
import { buildAirplane } from './airplane';
import { createFlightAudio } from './audio/sound';
import { createCameraRig } from './cameras';
import { createCockpit } from './cockpit';
import { createFlightController } from './flight';
import { createHud } from './hud';
import { clearSmoke, createSmoke } from './smoke';
import { createFlightState, type FlightContext, type FlightModule } from './types';
import { createGameMenus } from './ui/menus';
import {
  clearRuntime,
  initRuntime,
  loadSettings,
  requestCameraSnap,
  saveSettings,
  setRuntimeMode,
  setRuntimeSettings,
  type GameMode,
  type GameSettings,
  type QualityLevel,
} from './ui/settings';
import { SKY_HORIZON, buildWorld } from './world';

const QUALITY_CONFIG: Record<QualityLevel, { pixelRatio: number; fogStart: number; fogEnd: number; clouds: number }> = {
  low: { pixelRatio: 0.75, fogStart: 600, fogEnd: 2300, clouds: 0 },
  medium: { pixelRatio: 1.25, fogStart: 800, fogEnd: 3300, clouds: 0.5 },
  high: { pixelRatio: 2, fogStart: 900, fogEnd: 4200, clouds: 1 },
};

export function startFlightSim(app: AppBase, uiRoot: HTMLElement): { destroy(): void } {
  // Preserva luz ambiente, névoa e pixel ratio originais para restaurar no destroy()
  const prevAmbient = app.scene.ambientLight.clone();
  const prevFog = {
    type: app.scene.fog.type,
    color: app.scene.fog.color.clone(),
    density: app.scene.fog.density,
    start: app.scene.fog.start,
    end: app.scene.fog.end,
  };
  const graphicsDevice = app.graphicsDevice as
    | (AppBase['graphicsDevice'] & { canvas?: HTMLCanvasElement; maxPixelRatio?: number })
    | undefined;
  const prevMaxPixelRatio = graphicsDevice?.maxPixelRatio;
  const canvas = graphicsDevice?.canvas ?? null;

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
  const cloudEntities = simRoot.children.filter((c) => c.name === 'Cloud') as Entity[];
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

  let settings: GameSettings = loadSettings();
  const state = createFlightState();
  state.controlMode = settings.defaultControlMode;
  initRuntime(state, settings, 'title');

  const ctx: FlightContext = { app, world, plane, camera, state };

  // Ordem fixa (contrato em types.ts): voo → câmeras → cabine → HUD → fumaça
  let flightModule: FlightModule = createFlightController(ctx);
  const cameraRig = createCameraRig(ctx);
  const cockpitModule = createCockpit(ctx, uiRoot);
  const hudModule = createHud(ctx, uiRoot);
  const smokeModule = createSmoke(ctx);

  const audio = createFlightAudio(settings);

  let mode: GameMode = 'title';
  let hadPointerLockInFlight = false;
  let lastPauseAt = 0;
  let titleAngle = 0.65;
  const titleFocus = new Vec3();
  const titleCamPos = new Vec3();

  function applyQuality(quality: QualityLevel) {
    const cfg = QUALITY_CONFIG[quality];
    app.scene.fog.start = cfg.fogStart;
    app.scene.fog.end = cfg.fogEnd;

    if (graphicsDevice && typeof graphicsDevice.maxPixelRatio === 'number') {
      const nativeDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      graphicsDevice.maxPixelRatio = quality === 'high' ? Math.min(nativeDpr, cfg.pixelRatio) : cfg.pixelRatio;
      (app as { resizeCanvas?: () => void }).resizeCanvas?.();
    }

    for (let i = 0; i < cloudEntities.length; i++) {
      if (cfg.clouds <= 0) cloudEntities[i].enabled = false;
      else if (cfg.clouds >= 1) cloudEntities[i].enabled = true;
      else cloudEntities[i].enabled = i % 2 === 0;
    }
  }

  function showPlaneExterior() {
    for (let i = 0; i < plane.exterior.length; i++) {
      const render = plane.exterior[i].render;
      if (render) render.enabled = true;
    }
  }

  function releasePointerLock() {
    if (typeof document !== 'undefined' && canvas && document.pointerLockElement === canvas) {
      document.exitPointerLock?.();
    }
  }

  function requestPointerLockForFlight() {
    if (!canvas || state.controlMode !== 'mouse') return;
    const req = (canvas as { requestPointerLock?: () => Promise<void> | void }).requestPointerLock;
    if (typeof req !== 'function') return;
    try {
      const res = req.call(canvas);
      if (res && typeof res.then === 'function') {
        res.then(
          () => {
            if (destroyed || mode !== 'playing' || state.controlMode !== 'mouse') {
              releasePointerLock();
            }
          },
          () => {},
        );
      }
    } catch {
      // Ignora em ambientes sem suporte a pointer lock
    }
  }

  function updateTitleCamera(dt: number) {
    titleAngle = (titleAngle + dt * 0.14) % (Math.PI * 2);
    if (camera.camera) camera.camera.fov = 58;
    const radius = 34;
    const height = 10.5 + Math.sin(titleAngle * 2) * 2.2;
    titleFocus.set(state.x, state.y + 0.5, state.z);
    titleCamPos.set(
      titleFocus.x + Math.sin(titleAngle) * radius,
      titleFocus.y + height,
      titleFocus.z + Math.cos(titleAngle) * radius,
    );
    camera.setPosition(titleCamPos);
    camera.lookAt(titleFocus, Vec3.UP);
  }

  function resetFlightState() {
    flightModule.destroy?.();
    flightModule = createFlightController(ctx);
    clearSmoke(state);
    state.controlMode = settings.defaultControlMode;
    state.camera = 'chase';
  }

  function startFlight() {
    audio.unlock();
    resetFlightState();
    mode = 'playing';
    hadPointerLockInFlight = false;
    setRuntimeMode(state, 'playing');
    requestCameraSnap(state);
    menus.setMode('playing');
    cameraRig.update(0);
    cockpitModule.update(0);
    hudModule.update(0);
    requestPointerLockForFlight();
  }

  function pauseFlight() {
    if (mode !== 'playing') return;
    mode = 'paused';
    lastPauseAt = Date.now();
    hadPointerLockInFlight = false;
    setRuntimeMode(state, 'paused');
    releasePointerLock();
    menus.setMode('paused');
    hudModule.update(0);
  }

  function resumeFlight() {
    if (mode !== 'paused') return;
    audio.unlock();
    mode = 'playing';
    hadPointerLockInFlight = false;
    setRuntimeMode(state, 'playing');
    menus.setMode('playing');
    hudModule.update(0);
    requestPointerLockForFlight();
  }

  function restartFlight() {
    audio.unlock();
    resetFlightState();
    mode = 'playing';
    hadPointerLockInFlight = false;
    setRuntimeMode(state, 'playing');
    requestCameraSnap(state);
    menus.setMode('playing');
    cameraRig.update(0);
    cockpitModule.update(0);
    hudModule.update(0);
    requestPointerLockForFlight();
  }

  function returnToTitle() {
    resetFlightState();
    mode = 'title';
    hadPointerLockInFlight = false;
    setRuntimeMode(state, 'title');
    releasePointerLock();
    showPlaneExterior();
    menus.setMode('title');
    cockpitModule.update(0);
    hudModule.update(0);
    updateTitleCamera(0);
  }

  function applyUpdatedSettings(next: GameSettings) {
    const controlChanged = next.defaultControlMode !== settings.defaultControlMode;
    settings = { ...next };
    saveSettings(settings);
    setRuntimeSettings(state, settings);
    audio.applySettings(settings);
    applyQuality(settings.quality);
    if (controlChanged) {
      state.controlMode = settings.defaultControlMode;
      if (state.controlMode === 'keyboard') releasePointerLock();
    }
    hudModule.update(0);
    cockpitModule.update(0);
  }

  const menus = createGameMenus(uiRoot, settings, {
    onStartFlight: startFlight,
    onResume: resumeFlight,
    onRestart: restartFlight,
    onReturnTitle: returnToTitle,
    onSettingsChange: applyUpdatedSettings,
    onButtonClick: (confirm) => {
      audio.unlock();
      if (confirm) audio.playConfirm();
      else audio.playClick();
    },
  });

  function onPointerDown() {
    audio.unlock();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (destroyed) return;
    audio.unlock();
    if (e.repeat) return;

    const isEsc = e.code === 'Escape' || e.key === 'Escape';
    const isP = e.code === 'KeyP' || e.key === 'p' || e.key === 'P';
    if (!isEsc && !isP) return;

    if (mode === 'playing') {
      e.preventDefault();
      pauseFlight();
    } else if (mode === 'paused') {
      // Evita que o mesmo Esc que soltou o pointer lock (e pausou) despausar no mesmo instante
      if (Date.now() - lastPauseAt < 180) return;
      e.preventDefault();
      if (isEsc && menus.back()) {
        audio.playClick();
      } else {
        audio.playConfirm();
        resumeFlight();
      }
    } else if (mode === 'title' && isEsc) {
      if (menus.back()) {
        e.preventDefault();
        audio.playClick();
      }
    }
  }

  function onPointerLockChange() {
    if (destroyed || typeof document === 'undefined' || !canvas) return;
    const locked = document.pointerLockElement === canvas;
    if (mode !== 'playing') {
      hadPointerLockInFlight = false;
      return;
    }
    if (locked) {
      hadPointerLockInFlight = true;
    } else if (hadPointerLockInFlight && state.controlMode === 'mouse') {
      hadPointerLockInFlight = false;
      pauseFlight();
    } else {
      hadPointerLockInFlight = false;
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('pointerlockchange', onPointerLockChange);
  }

  applyQuality(settings.quality);
  showPlaneExterior();
  updateTitleCamera(0);
  world.sky.setPosition(camera.getPosition());
  cockpitModule.update(0);
  hudModule.update(0);

  const onUpdate = (dt: number) => {
    dt = Math.min(dt, 0.05);

    if (mode === 'title') {
      updateTitleCamera(dt);
    } else if (mode === 'playing') {
      flightModule.update(dt);
      cameraRig.update(dt);
      cockpitModule.update(dt);
      hudModule.update(dt);
      smokeModule.update(dt);
    }
    // Na pausa: nenhum módulo de voo/câmera/fumaça atualiza (mundo congelado; render continua)

    world.sky.setPosition(camera.getPosition());
    audio.update(dt, mode, state);
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
      if (typeof window !== 'undefined') {
        window.removeEventListener('pointerdown', onPointerDown);
        window.removeEventListener('keydown', onKeyDown);
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('pointerlockchange', onPointerLockChange);
      }

      releasePointerLock();
      audio.destroy();
      menus.destroy();
      flightModule.destroy?.();
      cameraRig.destroy?.();
      cockpitModule.destroy?.();
      hudModule.destroy?.();
      smokeModule.destroy?.();
      clearRuntime(state);

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

      if (graphicsDevice && typeof prevMaxPixelRatio === 'number') {
        graphicsDevice.maxPixelRatio = prevMaxPixelRatio;
        (app as { resizeCanvas?: () => void }).resizeCanvas?.();
      }

      for (const entity of disabledEntities) {
        if (entity.parent) entity.enabled = true;
      }
    },
  };
}
