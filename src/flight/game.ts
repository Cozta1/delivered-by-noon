import {
  ADDRESS_CLAMP_TO_EDGE,
  type AppBase,
  CULLFACE_FRONT,
  Color,
  Entity,
  FOG_LINEAR,
  PIXELFORMAT_SRGBA8,
  StandardMaterial,
  TONEMAP_ACES,
  Texture,
  Vec3,
} from 'playcanvas';
import { bindSceneAirplane, buildAirplane, type AirplaneModel } from './airplane';
import { createFlightAudio } from './audio/sound';
import { createCameraRig } from './cameras';
import { createCockpit } from './cockpit';
import { createDayNight } from './daynight';
import { createHud, isTunedNitroActive } from './hud';
import { createMarkers } from './markers';
import { createMissionSystem, startMission } from './mission';
import { clearSmoke, createSmoke } from './smoke';
import {
  STAGE_ORDER,
  createFlightState,
  createMissionState,
  type FlightContext,
  type FlightModule,
  type MissionState,
  type Stage,
} from './types';
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
import { createVehicleSystem } from './vehicles';
import { SKY_HORIZON, buildWorld, type World } from './world';
import { createWorldPhysics } from './world-data';

const QUALITY_CONFIG: Record<QualityLevel, { pixelRatio: number; fogStart: number; fogEnd: number; clouds: number }> = {
  low: { pixelRatio: 0.75, fogStart: 600, fogEnd: 2300, clouds: 0 },
  medium: { pixelRatio: 1.25, fogStart: 800, fogEnd: 3300, clouds: 0.5 },
  high: { pixelRatio: 2, fogStart: 900, fogEnd: 4200, clouds: 1 },
};

const SCENE_ENTITY_NAMES = {
  world: 'Mundo',
  plane: 'A29',
  camera: 'CameraJogo',
  sun: 'Sol',
} as const;

function findSceneEntity(root: Entity, name: string, exclude?: Entity): Entity | null {
  const stack: Entity[] = [];
  for (let i = root.children.length - 1; i >= 0; i--) {
    stack.push(root.children[i] as Entity);
  }
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === exclude) continue;
    if (cur.name === name) return cur;
    for (let i = cur.children.length - 1; i >= 0; i--) {
      stack.push(cur.children[i] as Entity);
    }
  }
  return null;
}

function collectByNamePattern(root: Entity, pattern: RegExp, out: Entity[] = []): Entity[] {
  for (let i = 0; i < root.children.length; i++) {
    const child = root.children[i] as Entity;
    if (pattern.test(child.name)) out.push(child);
    collectByNamePattern(child, pattern, out);
  }
  return out;
}

function hasAnyVisual(node: Entity): boolean {
  if (node.render || node.model) return true;
  for (let i = 0; i < node.children.length; i++) {
    if (hasAnyVisual(node.children[i] as Entity)) return true;
  }
  return false;
}

/**
 * Colisão lógica oficial de `world-data.ts` (terreno, cidade, aeroporto/pista, heliponto),
 * sem criar malhas, texturas nem materiais — usada quando "Mundo" já está na cena.
 */
function createLogicalGroundAt(): (x: number, z: number) => number {
  const physics = createWorldPhysics();
  return (x: number, z: number) => physics.groundAt(x, z);
}

function buildSkyDome(
  app: AppBase,
  parent: Entity,
  materials: StandardMaterial[],
  textures: Texture[],
): Entity {
  const sky = new Entity('Sky', app);
  if (typeof document === 'undefined' || !app.graphicsDevice) {
    parent.addChild(sky);
    return sky;
  }

  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.0, '#1e2046');
  grad.addColorStop(0.26, '#4f3a6e');
  grad.addColorStop(0.42, '#c86868');
  grad.addColorStop(0.5, '#fab88c');
  grad.addColorStop(0.58, '#c69888');
  grad.addColorStop(1.0, '#3a4668');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);

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

  sky.addComponent('render', { type: 'sphere', material: m, castShadows: false });
  sky.setLocalScale(9000, 9000, 9000);
  parent.addChild(sky);
  return sky;
}

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

  app.scene.ambientLight = new Color(0.55, 0.48, 0.55);
  app.scene.fog.type = FOG_LINEAR;
  app.scene.fog.color = SKY_HORIZON.clone();
  app.scene.fog.start = 900;
  app.scene.fog.end = 4200;

  const simRoot = new Entity('FlightSimRoot');
  app.root.addChild(simRoot);

  const restorers: Array<() => void> = [];

  // 1) Sol: usa entidade "Sol" da cena se existir; senão cria como antes
  const sceneSun = findSceneEntity(app.root, SCENE_ENTITY_NAMES.sun, simRoot);
  let sun: Entity;
  if (sceneSun) {
    const prevEnabled = sceneSun.enabled;
    sceneSun.enabled = true;
    if (!sceneSun.light) {
      sceneSun.addComponent('light', {
        type: 'directional',
        color: new Color(1, 0.8, 0.6),
        intensity: 1.7,
        castShadows: false,
      });
    }
    sun = sceneSun;
    restorers.push(() => {
      if (sceneSun.parent) sceneSun.enabled = prevEnabled;
    });
  } else {
    sun = new Entity('Sun');
    sun.addComponent('light', {
      type: 'directional',
      color: new Color(1, 0.8, 0.6),
      intensity: 1.7,
      castShadows: false,
    });
    sun.setEulerAngles(58, 125, 0);
    simRoot.addChild(sun);
  }

  // 2) Mundo: se "Mundo" existir na cena com malhas visuais (render ou model), usa ela + colisão lógica sem render
  const sceneWorld = findSceneEntity(app.root, SCENE_ENTITY_NAMES.world, simRoot);
  let world: World;
  let cloudEntities: Entity[];
  if (sceneWorld && hasAnyVisual(sceneWorld)) {
    const prevWorldEnabled = sceneWorld.enabled;
    sceneWorld.enabled = true;
    const skyMats: StandardMaterial[] = [];
    const skyTexs: Texture[] = [];
    const sceneSkies = collectByNamePattern(sceneWorld, /(?:^|[-_\s])(sky|ceu|céu)(?:$|[-_\s.])/i);
    let sky: Entity;
    if (sceneSkies.length > 0) {
      sky = sceneSkies[0];
      const prevSkyPos = sky.getPosition().clone();
      restorers.push(() => {
        if (sky.parent) sky.setPosition(prevSkyPos);
      });
    } else {
      sky = buildSkyDome(app, simRoot, skyMats, skyTexs);
    }
    cloudEntities = collectByNamePattern(sceneWorld, /(cloud|nuve)/i);
    const prevCloudEnabled = cloudEntities.map((c) => c.enabled);
    restorers.push(() => {
      if (sceneWorld.parent) sceneWorld.enabled = prevWorldEnabled;
      for (let i = 0; i < cloudEntities.length; i++) {
        if (cloudEntities[i].parent) cloudEntities[i].enabled = prevCloudEnabled[i];
      }
    });
    world = {
      sky,
      groundAt: createLogicalGroundAt(),
      materials: skyMats,
      textures: skyTexs,
    };
  } else {
    world = buildWorld(app, simRoot);
    cloudEntities = simRoot.children.filter((c) => c.name === 'Cloud') as Entity[];
  }

  // 3) Avião: se "A29" existir na cena, vincula a ela; senão cria como antes
  const scenePlane = findSceneEntity(app.root, SCENE_ENTITY_NAMES.plane, simRoot);
  let plane: AirplaneModel;
  if (scenePlane) {
    const prevEnabled = scenePlane.enabled;
    const prevPos = scenePlane.getLocalPosition().clone();
    const prevRot = scenePlane.getLocalRotation().clone();
    const bound = bindSceneAirplane(app, scenePlane);
    plane = bound.model;
    restorers.push(() => {
      bound.cleanup();
      if (scenePlane.parent) {
        scenePlane.setLocalPosition(prevPos);
        scenePlane.setLocalRotation(prevRot);
        scenePlane.enabled = prevEnabled;
      }
    });
  } else {
    plane = buildAirplane(app, simRoot);
  }

  // 4) Câmera: se "CameraJogo" existir na cena, usa ela; senão cria como antes
  const sceneCamera = findSceneEntity(app.root, SCENE_ENTITY_NAMES.camera, simRoot);
  let camera: Entity;
  if (sceneCamera) {
    const prevEnabled = sceneCamera.enabled;
    const prevPos = sceneCamera.getLocalPosition().clone();
    const prevRot = sceneCamera.getLocalRotation().clone();
    const prevFov = sceneCamera.camera?.fov;
    sceneCamera.enabled = true;
    if (!sceneCamera.camera) {
      sceneCamera.addComponent('camera', {
        clearColor: SKY_HORIZON.clone(),
        fov: 65,
        nearClip: 1.0,
        farClip: 6000,
        toneMapping: TONEMAP_ACES,
      });
    } else {
      sceneCamera.camera.clearColor = SKY_HORIZON.clone();
      if (sceneCamera.camera.farClip < 6000) sceneCamera.camera.farClip = 6000;
      sceneCamera.camera.toneMapping = TONEMAP_ACES;
    }
    camera = sceneCamera;
    restorers.push(() => {
      if (sceneCamera.parent) {
        sceneCamera.setLocalPosition(prevPos);
        sceneCamera.setLocalRotation(prevRot);
        if (sceneCamera.camera && typeof prevFov === 'number') sceneCamera.camera.fov = prevFov;
        sceneCamera.enabled = prevEnabled;
      }
    });
  } else {
    camera = new Entity('Camera');
    camera.addComponent('camera', {
      clearColor: SKY_HORIZON.clone(),
      fov: 65,
      nearClip: 1.0,
      farClip: 6000,
      toneMapping: TONEMAP_ACES,
    });
    simRoot.addChild(camera);
  }

  // Desliga câmeras, luzes e placeholders estáticos de veículos montados na cena do Editor
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
  for (const child of app.root.children as Entity[]) {
    if (child === simRoot || child === camera || child === sun || child === scenePlane || !child.enabled) continue;
    if (/^(Heli|Carro_|Personagem)/i.test(child.name)) {
      child.enabled = false;
      disabledEntities.push(child);
    }
  }

  const materials = new Set([...world.materials, ...plane.materials]);
  const textures = new Set(world.textures);

  let settings: GameSettings = loadSettings();
  const state = createFlightState();
  state.controlMode = settings.defaultControlMode;
  initRuntime(state, settings, 'title');

  const mission: MissionState = createMissionState();
  const ctx: FlightContext = { app, world, plane, camera, state, mission };

  // Ordem fixa: veículos/voo → missão → dia/noite → câmeras → marcadores → cabine → HUD → fumaça
  const flightModule: FlightModule = createVehicleSystem(ctx);
  const missionModule: FlightModule = createMissionSystem(ctx);
  const dayNightModule = createDayNight(ctx, sun);
  const cameraRig = createCameraRig(ctx);
  const markersModule = createMarkers(ctx, uiRoot);
  const cockpitModule = createCockpit(ctx, uiRoot);
  const hudModule = createHud(ctx, uiRoot);
  const smokeModule = createSmoke(ctx);

  const audio = createFlightAudio(settings);

  let mode: GameMode = 'title';
  let hadPointerLockInFlight = false;
  let lastPauseAt = 0;
  let titleAngle = 0.65;
  let heliRotorAngle = 0;
  let nitroFlamePhase = 0;
  let prevDelivered = mission.delivered;
  let prevStage: Stage = mission.stage;
  let prevStatus: MissionState['status'] = mission.status;
  let prevWarnMsg = '';
  const titleFocus = new Vec3();
  const titleCamPos = new Vec3();

  function syncMissionTracking() {
    prevDelivered = mission.delivered;
    prevStage = mission.stage;
    prevStatus = mission.status;
    prevWarnMsg = mission.message ?? '';
  }

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
      else cloudEntities[i].enabled = cloudEntities.length === 1 ? true : i % 2 === 0;
    }
  }

  function setPlaneExteriorVisible(visible: boolean) {
    for (let i = 0; i < plane.exterior.length; i++) {
      const render = plane.exterior[i].render;
      if (render) render.enabled = visible;
      const modelComp = plane.exterior[i].model;
      if (modelComp) modelComp.enabled = visible;
    }
  }

  function showPlaneExterior() {
    setPlaneExteriorVisible(true);
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
    const isGround = state.vehicle === 'car' || state.vehicle === 'tuned' || state.vehicle === 'foot';
    const radius = isGround ? 14.5 : 34;
    const height = (isGround ? 5.2 : 10.5) + Math.sin(titleAngle * 2) * (isGround ? 1.0 : 2.2);
    titleFocus.set(state.x, state.y + (isGround ? 1.1 : 0.5), state.z);
    titleCamPos.set(
      titleFocus.x + Math.sin(titleAngle) * radius,
      titleFocus.y + height,
      titleFocus.z + Math.cos(titleAngle) * radius,
    );
    camera.setPosition(titleCamPos);
    camera.lookAt(titleFocus, Vec3.UP);
  }

  function beginMissionPlay() {
    audio.unlock();
    startMission(ctx);
    clearSmoke(state);
    state.controlMode = settings.defaultControlMode;
    state.camera = 'chase';
    menus.clearStageBanner();
    syncMissionTracking();
    mode = 'playing';
    hadPointerLockInFlight = false;
    setRuntimeMode(state, 'playing');
    requestCameraSnap(state);
    menus.setMode('playing');
    dayNightModule.update(0);
    cameraRig.update(0);
    markersModule.update(0);
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

  function returnToTitle() {
    startMission(ctx);
    mission.status = 'intro';
    clearSmoke(state);
    state.controlMode = settings.defaultControlMode;
    state.camera = 'chase';
    menus.clearStageBanner();
    syncMissionTracking();
    mode = 'title';
    hadPointerLockInFlight = false;
    setRuntimeMode(state, 'title');
    releasePointerLock();
    showPlaneExterior();
    menus.setMode('title');
    dayNightModule.update(0);
    markersModule.update(0);
    cockpitModule.update(0);
    hudModule.update(0);
    updateTitleCamera(0);
  }

  function enterEndScreen(outcome: 'won' | 'lost') {
    mode = 'ended';
    hadPointerLockInFlight = false;
    setRuntimeMode(state, 'ended');
    releasePointerLock();
    if (outcome === 'won') audio.playVictory();
    else audio.playDefeat();
    menus.showEndScreen(outcome, mission);
    markersModule.update(0);
    cockpitModule.update(0);
    hudModule.update(0);
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
    onStartFlight: beginMissionPlay,
    onResume: resumeFlight,
    onRestart: beginMissionPlay,
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

    if (mode === 'title' && menus.getScreen() === 'story' && (e.code === 'Enter' || e.code === 'Space')) {
      e.preventDefault();
      audio.playConfirm();
      beginMissionPlay();
      return;
    }

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
  dayNightModule.update(0);
  updateTitleCamera(0);
  world.sky.setPosition(camera.getPosition());
  markersModule.update(0);
  cockpitModule.update(0);
  hudModule.update(0);

  const onUpdate = (dt: number) => {
    dt = Math.min(dt, 0.05);

    if (mode === 'title') {
      updateTitleCamera(dt);
    } else if (mode === 'playing') {
      flightModule.update(dt);
      missionModule?.update(dt);

      // Reage a eventos escritos em ctx.mission pelo mission.ts
      if (mission.delivered > prevDelivered) {
        audio.playDelivery();
      }
      prevDelivered = mission.delivered;

      if (mission.stage !== prevStage) {
        const prevIdx = STAGE_ORDER.indexOf(prevStage);
        const nextIdx = STAGE_ORDER.indexOf(mission.stage);
        prevStage = mission.stage;
        if (nextIdx > prevIdx) {
          audio.playStageFanfare();
          menus.showStageUnlocked(mission.stage);
        }
      }

      if (mission.message && mission.message !== prevWarnMsg) {
        prevWarnMsg = mission.message;
        if (/bloquead|trancad|termine as entregas/i.test(mission.message)) {
          audio.playLocked();
        }
      } else if (!mission.message) {
        prevWarnMsg = '';
      }

      if (mission.status !== prevStatus) {
        prevStatus = mission.status;
        if (mission.status === 'won' || mission.status === 'lost') {
          dayNightModule.update(0);
          enterEndScreen(mission.status);
          world.sky.setPosition(camera.getPosition());
          audio.update(dt, mode, state, mission, false);
          return;
        }
      }

      // Anima rotores do helicóptero e chamas de nitro do carro tunado (rodas já giram em car.ts)
      if (state.vehicle === 'heli') {
        heliRotorAngle = (heliRotorAngle + (420 + state.throttle * 1100) * dt) % 360;
        ctx.plane.prop.setLocalEulerAngles(0, heliRotorAngle, 0);
        ctx.plane.tailRotor?.setLocalEulerAngles((heliRotorAngle * 2.4) % 360, 0, 0);
      }

      const nitroActive = isTunedNitroActive(state);
      if (state.vehicle === 'tuned') {
        const flames = ctx.plane.root.findByName('NitroFlames') as Entity | null;
        if (flames) {
          flames.enabled = nitroActive;
          if (nitroActive) {
            nitroFlamePhase = (nitroFlamePhase + dt * 36) % (Math.PI * 2);
            const flicker = 0.85 + 0.35 * Math.sin(nitroFlamePhase);
            flames.setLocalScale(1, 1, flicker);
          }
        }
      }

      dayNightModule.update(dt);
      cameraRig.update(dt);
      // Sincroniza visibilidade de componentes `model` legados na troca de câmera (cabine)
      const isAircraft = state.vehicle === 'a29' || state.vehicle === 'heli';
      const showExt = !isAircraft || state.camera !== 'cockpit';
      for (let i = 0; i < plane.exterior.length; i++) {
        const modelComp = plane.exterior[i].model;
        if (modelComp && modelComp.enabled !== showExt) modelComp.enabled = showExt;
      }
      markersModule.update(dt);
      cockpitModule.update(dt);
      hudModule.update(dt);
      smokeModule.update(dt);
    }
    // Na pausa e no fim de jogo: nenhum módulo de simulação/missão/dia-noite/marcadores atualiza (tudo congelado)

    world.sky.setPosition(camera.getPosition());
    audio.update(dt, mode, state, mission, mode === 'playing' && isTunedNitroActive(state));
  };
  app.on('update', onUpdate);

  // Depuração pelo console do navegador
  Object.assign(window, { app, flight: ctx.state, mission: ctx.mission });

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
      missionModule?.destroy?.();
      flightModule.destroy?.();
      dayNightModule.destroy?.();
      cameraRig.destroy?.();
      markersModule.destroy?.();
      cockpitModule.destroy?.();
      hudModule.destroy?.();
      smokeModule.destroy?.();
      clearRuntime(state);

      simRoot.destroy();
      for (const mat of materials) mat.destroy();
      for (const tex of textures) tex.destroy();
      materials.clear();
      textures.clear();

      for (let i = restorers.length - 1; i >= 0; i--) restorers[i]();

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
