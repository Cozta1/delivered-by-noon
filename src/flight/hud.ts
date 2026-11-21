import { type Entity, KEY_SHIFT, KEY_W, Quat, Vec3 } from 'playcanvas';
import { isSmokeActive } from './smoke';
import {
  CAMERA_LABEL,
  STAGE_ORDER,
  type CameraMode,
  type DeliveryPoint,
  type FlightContext,
  type FlightModule,
  type FlightState,
  type MissionState,
  type Stage,
  type VehicleKind,
} from './types';
import { getRuntime } from './ui/settings';
import { AIRPORT, CITY, WORLD_SIZE, cityLayout, terrainHeight } from './world-data';

type AlertState = 'none' | 'stall' | 'crashed';

interface MarkerCache {
  visible: boolean;
  x: number;
  y: number;
}

interface MinimapBlip {
  kind: Exclude<VehicleKind, 'foot'>;
  x: number;
  z: number;
}

const VEHICLE_BADGE: Record<VehicleKind, string> = {
  foot: 'A PÉ',
  car: 'HATCH',
  tuned: 'COUPÉ TUNADO',
  a29: 'A-29',
  heli: 'HELI',
};

const NEARBY_LABEL: Record<Exclude<VehicleKind, 'foot'>, string> = {
  car: 'Hatch',
  tuned: 'Coupé Tunado',
  a29: 'A-29',
  heli: 'helicóptero',
};

const STAGE_LABEL: Record<Stage, string> = {
  car: 'ESTÁGIO 1/4 · HATCH',
  tuned: 'ESTÁGIO 2/4 · COUPÉ TUNADO',
  heli: 'ESTÁGIO 3/4 · HELICÓPTERO',
  a29: 'ESTÁGIO 4/4 · AVIÃO A-29',
};

const STAGE_SHORT_CODE: Record<Stage, string> = {
  car: 'H',
  tuned: 'C',
  heli: 'H',
  a29: 'A',
};

const FOOTER_BY_VEHICLE: Record<VehicleKind, string> = {
  foot: 'W/A/S/D andar · Espaço pular · Mouse gira câmera · E entrar em veículo · C câmera · Esc/P pausa',
  car: 'W/S acelerar/ré · A/D virar · Espaço freio de mão · Mouse gira câmera · E sair · C câmera · R reiniciar · Esc/P pausa',
  tuned: 'W/S acelerar/ré · A/D virar · Shift NITRO · Espaço freio de mão · Mouse gira câmera · E sair · C câmera · Esc/P pausa',
  a29: 'Mouse mira · M mouse/teclado · Shift/Ctrl acel · Espaço soltar carga · F fumaça · E sair · C câmera · Esc/P pausa',
  heli: 'W/S inclinar · A/D lateral · Q/E girar · Shift/Ctrl coletivo · Mouse gira câmera · E sair · C câmera · R reiniciar · Esc/P pausa',
};

const PROJECTION_DIST = 500;

// Dimensões da planta pré-renderizada do minimapa (uma única vez por sessão)
const MAP_WORLD_MIN_X = -WORLD_SIZE * 0.5;
const MAP_WORLD_MIN_Z = -WORLD_SIZE * 0.5;
const MAP_WORLD_SPAN = WORLD_SIZE;
const MAP_CANVAS_PX = 1024;
const MAP_PX_PER_M = MAP_CANVAS_PX / MAP_WORLD_SPAN;

interface MinimapBlueprint {
  canvas: HTMLCanvasElement;
  helipad: { x: number; z: number };
  workshop: { x: number; z: number };
}

let cachedBlueprint: MinimapBlueprint | null = null;

function buildMinimapBlueprint(): MinimapBlueprint | null {
  if (cachedBlueprint) return cachedBlueprint;
  if (typeof document === 'undefined') return null;

  const canvas = document.createElement('canvas');
  canvas.width = MAP_CANVAS_PX;
  canvas.height = MAP_CANVAS_PX;
  const g = canvas.getContext('2d');
  if (!g) return null;

  const layout = cityLayout();
  const wx = (x: number) => (x - MAP_WORLD_MIN_X) * MAP_PX_PER_M;
  const wz = (z: number) => (z - MAP_WORLD_MIN_Z) * MAP_PX_PER_M;
  const ws = (m: number) => m * MAP_PX_PER_M;

  // 1) Mar de fundo
  g.fillStyle = '#0c2336';
  g.fillRect(0, 0, MAP_CANVAS_PX, MAP_CANVAS_PX);

  // 2) Continente recortado pela linha costeira real (`layout.coastline`)
  if (layout.coastline.length > 1) {
    g.beginPath();
    g.moveTo(wx(layout.coastline[0].x), 0);
    for (let i = 0; i < layout.coastline.length; i++) {
      g.lineTo(wx(layout.coastline[i].x), wz(layout.coastline[i].z));
    }
    g.lineTo(wx(layout.coastline[layout.coastline.length - 1].x), 0);
    g.closePath();
    g.fillStyle = '#142622';
    g.fill();

    // Faixa sutil de praia ao longo da costa
    g.strokeStyle = 'rgba(214, 190, 140, 0.45)';
    g.lineWidth = 3.2;
    g.beginPath();
    for (let i = 0; i < layout.coastline.length; i++) {
      const px = wx(layout.coastline[i].x);
      const pz = wz(layout.coastline[i].z);
      if (i === 0) g.moveTo(px, pz);
      else g.lineTo(px, pz);
    }
    g.stroke();
  } else {
    g.fillStyle = '#142622';
    g.fillRect(0, 0, MAP_CANVAS_PX, wz(540));
  }

  // Relevo suave de montanhas ao norte/oeste (amostragem grossa, executada 1 única vez)
  const step = 120;
  for (let z = MAP_WORLD_MIN_Z; z < 500; z += step) {
    for (let x = MAP_WORLD_MIN_X; x < MAP_WORLD_MIN_X + MAP_WORLD_SPAN; x += step) {
      if (x > CITY.x0 - 40 && x < CITY.x1 + 40 && z > CITY.z0 - 40 && z < CITY.z1 + 40) continue;
      const h = terrainHeight(x, z);
      if (h > 26) {
        const a = Math.min(0.24, (h - 26) / 380);
        g.fillStyle = `rgba(116, 152, 134, ${a.toFixed(3)})`;
        g.fillRect(wx(x), wz(z), ws(step) + 1, ws(step) + 1);
      }
    }
  }

  // 3) Base de asfalto e grade real de ruas (`layout.asphalt` e `layout.roads`)
  g.fillStyle = '#202630';
  g.fillRect(
    wx(layout.asphalt.x0),
    wz(layout.asphalt.z0),
    ws(layout.asphalt.x1 - layout.asphalt.x0),
    ws(layout.asphalt.z1 - layout.asphalt.z0),
  );

  // Quarteirões (calçadas)
  g.fillStyle = '#2c3542';
  for (let i = 0; i < layout.blocks.length; i++) {
    const b = layout.blocks[i];
    g.fillRect(wx(b.x0), wz(b.z0), ws(b.x1 - b.x0), ws(b.z1 - b.z0));
  }

  // Ruas principais e faixa tracejada central
  g.fillStyle = '#181e27';
  for (let i = 0; i < layout.roads.length; i++) {
    const r = layout.roads[i];
    g.fillRect(wx(r.x0), wz(r.z0), ws(r.x1 - r.x0), ws(r.z1 - r.z0));
  }
  g.strokeStyle = 'rgba(225, 198, 120, 0.22)';
  g.lineWidth = 0.7;
  g.beginPath();
  for (let i = 0; i < layout.roads.length; i++) {
    const r = layout.roads[i];
    if (r.axis === 'z') {
      const mx = wx((r.x0 + r.x1) * 0.5);
      g.moveTo(mx, wz(r.z0));
      g.lineTo(mx, wz(r.z1));
    } else {
      const mz = wz((r.z0 + r.z1) * 0.5);
      g.moveTo(wx(r.x0), mz);
      g.lineTo(wx(r.x1), mz);
    }
  }
  g.stroke();

  // 4) Parques
  g.fillStyle = '#1e5038';
  g.strokeStyle = 'rgba(96, 206, 146, 0.35)';
  g.lineWidth = 0.9;
  for (let i = 0; i < layout.parks.length; i++) {
    const p = layout.parks[i];
    const px = wx(p.x0);
    const pz = wz(p.z0);
    const pw = ws(p.x1 - p.x0);
    const ph = ws(p.z1 - p.z0);
    g.fillRect(px, pz, pw, ph);
    g.strokeRect(px, pz, pw, ph);
  }

  // 5) Planta real de cada prédio (`layout.buildings`), sombreada por altura
  for (let i = 0; i < layout.buildings.length; i++) {
    const b = layout.buildings[i];
    const hNorm = Math.max(0, Math.min(1, (b.top - 10) / 180));
    const lum = Math.round(74 + hNorm * 64);
    g.fillStyle = `rgb(${lum - 8}, ${lum}, ${lum + 14})`;
    g.fillRect(wx(b.x0), wz(b.z0), Math.max(1.2, ws(b.x1 - b.x0)), Math.max(1.2, ws(b.z1 - b.z0)));
  }

  // 6) Pista do aeroporto (`layout.runway`)
  const rwX = wx(layout.runway.x0);
  const rwZ = wz(layout.runway.z0);
  const rwW = Math.max(4, ws(layout.runway.x1 - layout.runway.x0));
  const rwH = Math.max(14, ws(layout.runway.z1 - layout.runway.z0));
  g.fillStyle = '#475160';
  g.fillRect(rwX, rwZ, rwW, rwH);
  g.strokeStyle = '#ffd58a';
  g.lineWidth = 1.2;
  g.setLineDash([4, 3]);
  g.beginPath();
  g.moveTo(rwX + rwW * 0.5, rwZ + 4);
  g.lineTo(rwX + rwW * 0.5, rwZ + rwH - 4);
  g.stroke();
  g.setLineDash([]);

  // 7) Oficina do Coupé Tunado (`layout.workshop`)
  const wkX = wx(layout.workshop.x);
  const wkZ = wz(layout.workshop.z);
  g.fillStyle = 'rgba(42, 26, 12, 0.9)';
  g.strokeStyle = '#ff9e4a';
  g.lineWidth = 1.5;
  g.fillRect(wkX - 5, wkZ - 5, 10, 10);
  g.strokeRect(wkX - 5, wkZ - 5, 10, 10);

  // 8) Heliponto (`layout.helipad`)
  const hpX = wx(layout.helipad.x);
  const hpZ = wz(layout.helipad.z);
  g.beginPath();
  g.arc(hpX, hpZ, 5.5, 0, Math.PI * 2);
  g.fillStyle = 'rgba(14, 38, 46, 0.92)';
  g.fill();
  g.strokeStyle = '#5cf0d8';
  g.lineWidth = 1.4;
  g.stroke();

  cachedBlueprint = {
    canvas,
    helipad: { x: layout.helipad.x, z: layout.helipad.z },
    workshop: { x: layout.workshop.x, z: layout.workshop.z },
  };
  return cachedBlueprint;
}

// Estado de nitro do carro tunado compartilhado com áudio e chamas de escape
const nitroActiveByState = new WeakMap<FlightState, boolean>();

export function isTunedNitroActive(state: FlightState): boolean {
  return state.vehicle === 'tuned' && (nitroActiveByState.get(state) ?? false);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatClock(minutes: number): string {
  const clamped = Math.max(0, Math.min(1440, Math.floor(minutes)));
  if (clamped >= 1440) return '24:00';
  const hh = Math.floor(clamped / 60);
  const mm = clamped % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function formatDistance(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters)} m`;
}

function estimateCarGear(speedMs: number, throttle: number, isTuned: boolean): { label: string; rpmRatio: number } {
  const kmh = Math.abs(speedMs) * 3.6;
  if (speedMs < -0.6) return { label: 'R', rpmRatio: Math.min(1, 0.25 + kmh / 45) };
  if (kmh < 2 && throttle < 0.05) return { label: 'N', rpmRatio: 0.14 };
  const bands = isTuned ? [38, 76, 118, 165, 220, 275] : [26, 54, 86, 122, 168];
  let gear = 1;
  let low = 0;
  let high = bands[0];
  for (let i = 0; i < bands.length; i++) {
    if (kmh <= bands[i] || i === bands.length - 1) {
      gear = i + 1;
      low = i === 0 ? 0 : bands[i - 1] * 0.72;
      high = bands[i];
      break;
    }
  }
  const ratio = Math.max(0.18, Math.min(1, ((kmh - low) / Math.max(12, high - low)) * 0.78 + throttle * 0.22));
  return { label: String(gear), rpmRatio: ratio };
}

function scanSceneVehicles(root: Entity, out: MinimapBlip[]): void {
  out.length = 0;
  const stack: Entity[] = [];
  for (let i = root.children.length - 1; i >= 0; i--) {
    stack.push(root.children[i] as Entity);
  }
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (!cur.enabled) continue;
    const lower = cur.name.toLowerCase();
    let kind: Exclude<VehicleKind, 'foot'> | null = null;
    if (lower === 'a29' || lower === 'airplane' || lower.startsWith('veiculo-a29')) kind = 'a29';
    else if (lower === 'heli' || lower === 'helicopter' || lower.startsWith('veiculo-heli')) kind = 'heli';
    else if (lower === 'carro_tunado' || lower.includes('tunado') || lower.startsWith('veiculo-tuned')) kind = 'tuned';
    else if (lower.startsWith('carro_') || lower.startsWith('veiculo-car')) kind = 'car';

    if (kind) {
      const p = cur.getPosition();
      out.push({ kind, x: p.x, z: p.z });
      continue;
    }
    for (let i = cur.children.length - 1; i >= 0; i--) {
      stack.push(cur.children[i] as Entity);
    }
  }
}

function isStageLocked(kind: Exclude<VehicleKind, 'foot'>, mission?: MissionState): boolean {
  if (!mission || mission.status !== 'playing') return false;
  const unlockedIdx = STAGE_ORDER.indexOf(mission.stage);
  const targetIdx = STAGE_ORDER.indexOf(kind);
  return unlockedIdx >= 0 && targetIdx > unlockedIdx;
}

function readExternalNitro(state: FlightState): number | null {
  const raw = (state as { nitro?: unknown }).nitro;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  if (raw > 1.01) return Math.max(0, Math.min(1, raw / 100));
  return Math.max(0, Math.min(1, raw));
}

export function createHud(ctx: FlightContext, uiRoot?: HTMLElement | null): FlightModule {
  const { app, plane, camera, state } = ctx;
  const ui = uiRoot ?? (typeof document !== 'undefined' ? document.getElementById('ui') : null);
  if (!ui) return { update() {} };

  const blueprint = buildMinimapBlueprint();

  const root = el('div', 'hud-root');

  // Camada de mira e cruz do nariz (somente aeronaves no modo mouse)
  const reticlesLayer = el('div', 'hud-reticles');
  const aimRing = el('div', 'hud-aim-ring');
  aimRing.hidden = true;
  const noseCross = el('div', 'hud-nose-cross');
  noseCross.hidden = true;
  reticlesLayer.append(aimRing, noseCross);

  // Topo central: relógio grande (HH:MM) + pontos + progresso total
  const clockWrap = el('div', 'hud-clock-wrap');
  const clockTag = el('div', 'hud-clock-tag', 'ATÉ MEIA-NOITE');
  const clockDigits = el('div', 'hud-clock', '00:00');
  const clockMeta = el('div', 'hud-clock-meta');
  const scoreBadge = el('span', 'hud-score', '0 PTS');
  const totalBadge = el('span', 'hud-total', '0/0 ENTREGAS');
  clockMeta.append(scoreBadge, totalBadge);
  clockWrap.append(clockTag, clockDigits, clockMeta);

  // Mensagem da missão (toast central abaixo do relógio)
  const missionMsg = el('div', 'hud-mission-msg');
  missionMsg.hidden = true;

  // Canto superior esquerdo: telemetria + painel de objetivo empilhados
  const leftCol = el('div', 'hud-left-col');

  const panel = el('div', 'hud-telemetry');
  const badgesRow = el('div', 'hud-badges');
  const vehicleBadge = el('div', 'hud-vehicle');
  const cameraBadge = el('div', 'hud-camera');
  const controlBadge = el('div', 'hud-control');
  const smokeBadge = el('div', 'hud-smoke');
  badgesRow.append(vehicleBadge, cameraBadge, controlBadge, smokeBadge);

  const lockHint = el('div', 'hud-lock-hint', 'Clique no canvas para mirar');

  // Grupo aéreo (A-29 / helicóptero)
  const metricsGroup = el('div', 'hud-metrics');
  const speedRow = el('div', 'hud-metric');
  const speedLabel = el('span', 'hud-label', 'VEL');
  const speedVal = el('span', 'hud-value');
  speedRow.append(speedLabel, speedVal);

  const altRow = el('div', 'hud-metric');
  const altLabel = el('span', 'hud-label', 'ALT');
  const altVal = el('span', 'hud-value');
  altRow.append(altLabel, altVal);

  const throttleRow = el('div', 'hud-throttle-row');
  const throttleHead = el('div', 'hud-throttle-head');
  const throttleLabel = el('span', 'hud-label', 'ACEL');
  const throttleVal = el('span', 'hud-value-sm');
  throttleHead.append(throttleLabel, throttleVal);

  const throttleTrack = el('div', 'hud-throttle-track');
  const throttleFill = el('div', 'hud-throttle-fill');
  throttleTrack.append(throttleFill);
  throttleRow.append(throttleHead, throttleTrack);
  metricsGroup.append(speedRow, altRow, throttleRow);

  // Velocímetro automotivo (Hatch e Coupé Tunado)
  const carDash = el('div', 'hud-car-dash');
  carDash.hidden = true;
  const carSpeedLine = el('div', 'hud-car-speed-line');
  const carSpeedVal = el('span', 'hud-car-speed', '0');
  const carSpeedUnit = el('span', 'hud-car-unit', 'km/h');
  const carGear = el('span', 'hud-car-gear', 'N');
  carSpeedLine.append(carSpeedVal, carSpeedUnit, carGear);
  const carRpmTrack = el('div', 'hud-throttle-track');
  const carRpmFill = el('div', 'hud-car-rpm-fill');
  carRpmTrack.append(carRpmFill);

  // Barra de nitro (exclusiva do Coupé Tunado)
  const nitroRow = el('div', 'hud-nitro-row');
  nitroRow.hidden = true;
  const nitroHead = el('div', 'hud-throttle-head');
  const nitroLabel = el('span', 'hud-nitro-label', 'NITRO [SHIFT]');
  const nitroVal = el('span', 'hud-value-sm', '100%');
  nitroHead.append(nitroLabel, nitroVal);
  const nitroTrack = el('div', 'hud-throttle-track hud-nitro-track');
  const nitroFill = el('div', 'hud-nitro-fill');
  nitroTrack.append(nitroFill);
  nitroRow.append(nitroHead, nitroTrack);

  carDash.append(carSpeedLine, carRpmTrack, nitroRow);

  panel.append(badgesRow, lockHint, metricsGroup, carDash);

  // Painel do objetivo da missão (estágio, entrega atual, distância)
  const objPanel = el('div', 'hud-objective');
  objPanel.hidden = true;
  const objStage = el('div', 'hud-obj-stage', 'ESTÁGIO 1/4 · HATCH');
  const objTarget = el('div', 'hud-obj-target', 'Aguardando entregas...');
  const objFoot = el('div', 'hud-obj-foot');
  const objDist = el('span', 'hud-obj-dist', '');
  const objHint = el('span', 'hud-obj-hint', '');
  objFoot.append(objDist, objHint);
  objPanel.append(objStage, objTarget, objFoot);

  leftCol.append(panel, objPanel);

  // Canto superior direito: Minimapa 2D com planta real da cidade (gira e centraliza no jogador)
  const minimapWrap = el('div', 'hud-minimap');
  const minimapCanvas = document.createElement('canvas');
  minimapCanvas.className = 'hud-minimap-canvas';
  minimapCanvas.width = 176;
  minimapCanvas.height = 176;
  const minimapTag = el('div', 'hud-minimap-tag', 'MAPA');
  minimapWrap.append(minimapCanvas, minimapTag);
  const mapCtx = minimapCanvas.getContext('2d');

  // Aviso de proximidade para entrar em veículo / veículo bloqueado
  const nearbyPrompt = el('div', 'hud-nearby');
  nearbyPrompt.hidden = true;

  // Aviso central (estol / impacto)
  const alertBox = el('div', 'hud-alert');
  alertBox.hidden = true;

  // Rodapé de atalhos
  const footer = el('div', 'hud-footer', FOOTER_BY_VEHICLE.car);

  root.append(reticlesLayer, clockWrap, missionMsg, leftCol, minimapWrap, nearbyPrompt, alertBox, footer);
  ui.append(root);

  const canvas = (app.graphicsDevice as { canvas?: HTMLCanvasElement } | undefined)?.canvas ?? null;
  const camPos = new Vec3();
  const camRot = new Quat();
  const camFwd = new Vec3();
  const planeRot = new Quat();
  const noseDir = new Vec3();
  const worldPt = new Vec3();
  const delta = new Vec3();
  const screenPt = new Vec3();
  const blips: MinimapBlip[] = [];

  const aimCache: MarkerCache = { visible: false, x: Number.NaN, y: Number.NaN };
  const noseCache: MarkerCache = { visible: false, x: Number.NaN, y: Number.NaN };

  let lastSpeedKmh = Number.NaN;
  let lastAltM = Number.NaN;
  let lastThrottlePct = Number.NaN;
  let lastCarSpeed = Number.NaN;
  let lastCarGear = '';
  let lastNitroPct = Number.NaN;
  let lastNitroHot: boolean | null = null;
  let lastCamera: CameraMode | null = null;
  let lastVehicle: VehicleKind | null = null;
  let lastControl: FlightState['controlMode'] | null = null;
  let lastLocked: boolean | null = null;
  let lastSmoke: boolean | null = null;
  let lastCockpit: boolean | null = null;
  let lastHudVisible: boolean | null = null;
  let lastNearbyKey = '';
  let lastAlert: AlertState = 'none';
  let lastClockText = '';
  let lastClockUrgent: boolean | null = null;
  let lastScore = Number.NaN;
  let lastTotalKey = '';
  let lastObjKey = '';
  let lastMsgKey = '';
  let minimapFrame = 0;
  let animPhase = 0;
  let localNitro = 1;
  let nitroExhausted = false;

  function findNextDelivery(mission: MissionState): {
    activeStage: Stage;
    stageDeliveries: DeliveryPoint[];
    pendingStage: DeliveryPoint[];
    doneInStage: number;
    next: DeliveryPoint | null;
  } {
    const activeStage: Stage = mission.carrying ?? mission.stage;
    const stageDeliveries: DeliveryPoint[] = [];
    const allPending: DeliveryPoint[] = [];
    let next: DeliveryPoint | null = null;

    for (let i = 0; i < mission.deliveries.length; i++) {
      const d = mission.deliveries[i];
      if (d.stage === activeStage) {
        stageDeliveries.push(d);
        if (!d.delivered) allPending.push(d);
      }
      if (mission.nextDeliveryId && d.id === mission.nextDeliveryId && !d.delivered) {
        next = d;
      }
    }

    const pendingStage =
      allPending.length > 1 ? allPending.filter((p) => !p.leadsToNext && p.id !== 'a29-4') : allPending;

    if (!next && pendingStage.length > 0) {
      let bestSq = Infinity;
      for (let i = 0; i < pendingStage.length; i++) {
        const d = pendingStage[i];
        const dSq = (d.x - state.x) ** 2 + (d.z - state.z) ** 2;
        if (dSq < bestSq) {
          bestSq = dSq;
          next = d;
        }
      }
    }

    return { activeStage, stageDeliveries, pendingStage, doneInStage: stageDeliveries.length - allPending.length, next };
  }

  function findNextVehicleCoords(mission: MissionState): { stage: Stage; x: number; z: number } | null {
    const idx = STAGE_ORDER.indexOf(mission.stage);
    if (idx < 0 || idx >= STAGE_ORDER.length - 1) return null;
    const nextStage = STAGE_ORDER[idx + 1];

    for (let i = 0; i < blips.length; i++) {
      if (blips[i].kind === nextStage) {
        return { stage: nextStage, x: blips[i].x, z: blips[i].z };
      }
    }
    for (let i = 0; i < mission.deliveries.length; i++) {
      const d = mission.deliveries[i];
      if (d.stage === mission.stage && d.leadsToNext) {
        return { stage: nextStage, x: d.x, z: d.z };
      }
    }
    if (nextStage === 'tuned' && blueprint) return { stage: nextStage, x: blueprint.workshop.x, z: blueprint.workshop.z };
    if (nextStage === 'heli' && blueprint) return { stage: nextStage, x: blueprint.helipad.x, z: blueprint.helipad.z };
    if (nextStage === 'a29') return { stage: nextStage, x: AIRPORT.x, z: 410 };
    return null;
  }

  function worldToRotatedMap(
    wx: number,
    wz: number,
    scale: number,
    cosH: number,
    sinH: number,
    half: number,
  ): { x: number; y: number } {
    const dx = (wx - state.x) * scale;
    const dz = (wz - state.z) * scale;
    // Rotaciona por -heading para que a frente do jogador aponte sempre para cima
    const rx = dx * cosH + dz * sinH;
    const ry = -dx * sinH + dz * cosH;
    return { x: half + rx, y: half + ry };
  }

  function clampToMap(x: number, y: number, size: number, pad: number): { x: number; y: number; clamped: boolean } {
    const half = size * 0.5;
    const dx = x - half;
    const dy = y - half;
    const maxR = half - pad;
    if (Math.abs(dx) <= maxR && Math.abs(dy) <= maxR) {
      return { x, y, clamped: false };
    }
    const s = Math.max(Math.abs(dx) / maxR, Math.abs(dy) / maxR, 1e-4);
    return { x: half + dx / s, y: half + dy / s, clamped: true };
  }

  function drawMinimap() {
    if (!mapCtx) return;
    const size = 176;
    const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
    const targetPx = Math.round(size * dpr);
    if (minimapCanvas.width !== targetPx || minimapCanvas.height !== targetPx) {
      minimapCanvas.width = targetPx;
      minimapCanvas.height = targetPx;
    }

    mapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const half = size * 0.5;
    const range =
      state.vehicle === 'foot'
        ? 360
        : state.vehicle === 'car'
          ? 480
          : state.vehicle === 'tuned'
            ? 620
            : 1220;
    const scale = half / range;
    const hRad = (state.heading * Math.PI) / 180;
    const cosH = Math.cos(hRad);
    const sinH = Math.sin(hRad);

    // Fundo marinho caso o recorte gire além das bordas
    mapCtx.fillStyle = '#0c2336';
    mapCtx.fillRect(0, 0, size, size);

    // 1) Planta pré-renderizada da cidade girando e centralizando no jogador
    if (blueprint) {
      mapCtx.save();
      mapCtx.translate(half, half);
      mapCtx.rotate(-hRad);
      const drawScale = scale / MAP_PX_PER_M;
      const ox = -((state.x - MAP_WORLD_MIN_X) * MAP_PX_PER_M) * drawScale;
      const oz = -((state.z - MAP_WORLD_MIN_Z) * MAP_PX_PER_M) * drawScale;
      const drawSize = MAP_CANVAS_PX * drawScale;
      mapCtx.drawImage(blueprint.canvas, ox, oz, drawSize, drawSize);
      mapCtx.restore();
    }

    // 2) Veículos estacionados / na cena (escaneados a cada ~10 quadros)
    if (minimapFrame % 10 === 0) {
      scanSceneVehicles(app.root, blips);
    }
    minimapFrame++;

    for (let i = 0; i < blips.length; i++) {
      const b = blips[i];
      if (Math.hypot(b.x - state.x, b.z - state.z) < 4) continue;
      const p = worldToRotatedMap(b.x, b.z, scale, cosH, sinH, half);
      if (p.x < 4 || p.x > size - 4 || p.y < 4 || p.y > size - 4) continue;
      mapCtx.fillStyle =
        b.kind === 'a29'
          ? '#60a5fa'
          : b.kind === 'heli'
            ? '#3dd6bd'
            : b.kind === 'tuned'
              ? '#ff4dc4'
              : '#ff9e4a';
      mapCtx.beginPath();
      mapCtx.arc(p.x, p.y, b.kind === 'car' ? 2.6 : 3.4, 0, Math.PI * 2);
      mapCtx.fill();
      mapCtx.strokeStyle = '#09111a';
      mapCtx.lineWidth = 0.8;
      mapCtx.stroke();
    }

    // 3) Entregas pendentes, próxima entrega destacada e próximo veículo a desbloquear
    const mission = ctx.mission;
    if (mission && mission.status === 'playing') {
      const { pendingStage, next } = findNextDelivery(mission);
      const pulse = 0.5 + 0.5 * Math.sin(animPhase * 5.2);

      // Próximo veículo a desbloquear
      const nextVeh = findNextVehicleCoords(mission);
      if (nextVeh) {
        const raw = worldToRotatedMap(nextVeh.x, nextVeh.z, scale, cosH, sinH, half);
        const pt = clampToMap(raw.x, raw.y, size, 12);
        mapCtx.save();
        mapCtx.fillStyle = 'rgba(20, 12, 34, 0.92)';
        mapCtx.strokeStyle = '#ff5cd6';
        mapCtx.lineWidth = 1.6;
        mapCtx.fillRect(pt.x - 6, pt.y - 6, 12, 12);
        mapCtx.strokeRect(pt.x - 6, pt.y - 6, 12, 12);
        mapCtx.fillStyle = '#ff9be8';
        mapCtx.font = '800 8px system-ui, sans-serif';
        mapCtx.textAlign = 'center';
        mapCtx.textBaseline = 'middle';
        mapCtx.fillText(STAGE_SHORT_CODE[nextVeh.stage], pt.x, pt.y + 0.5);
        mapCtx.restore();
      }

      // Entregas pendentes (diamantes ciano)
      for (let i = 0; i < pendingStage.length; i++) {
        const d = pendingStage[i];
        if (next && d.id === next.id) continue;
        const raw = worldToRotatedMap(d.x, d.z, scale, cosH, sinH, half);
        const pt = clampToMap(raw.x, raw.y, size, 8);
        mapCtx.save();
        mapCtx.translate(pt.x, pt.y);
        mapCtx.rotate(Math.PI / 4);
        mapCtx.fillStyle = d.leadsToNext ? '#ff6ee0' : '#38e8c8';
        mapCtx.fillRect(-3.2, -3.2, 6.4, 6.4);
        mapCtx.strokeStyle = '#08131a';
        mapCtx.lineWidth = 1;
        mapCtx.strokeRect(-3.2, -3.2, 6.4, 6.4);
        mapCtx.restore();
      }

      // Próxima entrega destacada (halo dourado pulsante)
      if (next) {
        const raw = worldToRotatedMap(next.x, next.z, scale, cosH, sinH, half);
        const pt = clampToMap(raw.x, raw.y, size, 10);
        const haloR = 6 + pulse * 3.5;
        mapCtx.beginPath();
        mapCtx.arc(pt.x, pt.y, haloR, 0, Math.PI * 2);
        mapCtx.strokeStyle = next.airDrop ? 'rgba(92, 225, 255, 0.88)' : 'rgba(255, 214, 72, 0.92)';
        mapCtx.lineWidth = 1.9;
        mapCtx.stroke();

        mapCtx.beginPath();
        mapCtx.arc(pt.x, pt.y, pt.clamped ? 4.4 : 4.8, 0, Math.PI * 2);
        mapCtx.fillStyle = next.airDrop ? '#5ce1ff' : '#ffd648';
        mapCtx.fill();
        mapCtx.strokeStyle = '#12121a';
        mapCtx.lineWidth = 1.2;
        mapCtx.stroke();
      }
    }

    // 4) Seta do jogador centralizada apontando sempre para cima (frente do veículo)
    mapCtx.save();
    mapCtx.translate(half, half);
    mapCtx.beginPath();
    mapCtx.moveTo(0, -7);
    mapCtx.lineTo(4.8, 5.2);
    mapCtx.lineTo(0, 2.5);
    mapCtx.lineTo(-4.8, 5.2);
    mapCtx.closePath();
    mapCtx.fillStyle = '#fff5e6';
    mapCtx.fill();
    mapCtx.strokeStyle = '#0c131d';
    mapCtx.lineWidth = 1.1;
    mapCtx.stroke();
    mapCtx.restore();

    // 5) Indicador Norte girando na borda conforme a bússola do jogador
    const northRawX = half - sinH * (half - 11);
    const northRawY = half - cosH * (half - 11);
    const northPt = clampToMap(northRawX, northRawY, size, 10);
    mapCtx.beginPath();
    mapCtx.arc(northPt.x, northPt.y, 7.5, 0, Math.PI * 2);
    mapCtx.fillStyle = 'rgba(10, 14, 24, 0.86)';
    mapCtx.fill();
    mapCtx.strokeStyle = 'rgba(255, 189, 125, 0.65)';
    mapCtx.lineWidth = 1;
    mapCtx.stroke();
    mapCtx.fillStyle = '#ffbd7d';
    mapCtx.font = '800 9px system-ui, sans-serif';
    mapCtx.textAlign = 'center';
    mapCtx.textBaseline = 'middle';
    mapCtx.fillText('N', northPt.x, northPt.y + 0.5);
  }

  function updateMarker(
    active: boolean,
    wx: number,
    wy: number,
    wz: number,
    cw: number,
    ch: number,
    node: HTMLElement,
    cache: MarkerCache,
  ) {
    const cam = camera.camera;
    let visible = false;
    let sx = 0;
    let sy = 0;

    if (active && cam && cw > 0 && ch > 0) {
      worldPt.set(wx, wy, wz);
      delta.sub2(worldPt, camPos);
      if (delta.dot(camFwd) > 0) {
        cam.worldToScreen(worldPt, screenPt, cw, ch);
        if (
          Number.isFinite(screenPt.x) &&
          Number.isFinite(screenPt.y) &&
          screenPt.x >= 0 &&
          screenPt.x <= cw &&
          screenPt.y >= 0 &&
          screenPt.y <= ch
        ) {
          visible = true;
          sx = Math.round(screenPt.x * 2) / 2;
          sy = Math.round(screenPt.y * 2) / 2;
        }
      }
    }

    if (visible !== cache.visible) {
      cache.visible = visible;
      node.hidden = !visible;
    }
    if (visible && (sx !== cache.x || sy !== cache.y)) {
      cache.x = sx;
      cache.y = sy;
      node.style.transform = `translate3d(${sx}px, ${sy}px, 0) translate(-50%, -50%)`;
    }
  }

  function updateNitro(dt: number, playing: boolean): { ratio: number; active: boolean } {
    if (state.vehicle !== 'tuned') {
      nitroActiveByState.set(state, false);
      return { ratio: localNitro, active: false };
    }

    const external = readExternalNitro(state);
    const shiftHeld = playing && Boolean(app.keyboard?.isPressed(KEY_SHIFT));
    const forwardHeld = playing && (Boolean(app.keyboard?.isPressed(KEY_W)) || state.throttle > 0.1 || Math.abs(state.speed) > 4);

    if (external !== null) {
      const active = shiftHeld && external > 0.02 && forwardHeld;
      nitroActiveByState.set(state, active);
      return { ratio: external, active };
    }

    if (playing && dt > 0) {
      if (shiftHeld && forwardHeld && !nitroExhausted && localNitro > 0.01) {
        localNitro = Math.max(0, localNitro - dt * 0.34);
        if (localNitro <= 0.01) nitroExhausted = true;
      } else {
        localNitro = Math.min(1, localNitro + dt * 0.16);
        if (localNitro >= 0.25) nitroExhausted = false;
      }
    }
    const active = shiftHeld && forwardHeld && !nitroExhausted && localNitro > 0.01;
    nitroActiveByState.set(state, active);
    return { ratio: localNitro, active };
  }

  function sync(dt: number) {
    const rt = getRuntime(state);
    const hudVisible = rt.mode !== 'title' && rt.mode !== 'ended' && rt.settings.showHud;
    if (hudVisible !== lastHudVisible) {
      lastHudVisible = hudVisible;
      root.hidden = !hudVisible;
    }
    if (!hudVisible) {
      nitroActiveByState.set(state, false);
      return;
    }

    if (rt.mode === 'playing' && Number.isFinite(dt) && dt > 0) {
      animPhase = (animPhase + dt) % (Math.PI * 200);
    }

    const vehicle = state.vehicle;
    const isCar = vehicle === 'car' || vehicle === 'tuned';
    const isAircraft = vehicle === 'a29' || vehicle === 'heli';
    const isCockpit = isAircraft && state.camera === 'cockpit';

    if (vehicle !== lastVehicle || isCockpit !== lastCockpit) {
      lastVehicle = vehicle;
      lastCockpit = isCockpit;
      vehicleBadge.textContent = VEHICLE_BADGE[vehicle];
      vehicleBadge.className = `hud-vehicle hud-vehicle--${vehicle}`;
      footer.textContent = FOOTER_BY_VEHICLE[vehicle];

      metricsGroup.hidden = !isAircraft || isCockpit;
      carDash.hidden = !isCar;
      nitroRow.hidden = vehicle !== 'tuned';
      controlBadge.hidden = vehicle !== 'a29';
      smokeBadge.hidden = vehicle !== 'a29';

      const compact = vehicle === 'foot' || isCockpit;
      panel.classList.toggle('hud-telemetry--compact', compact);
      reticlesLayer.classList.toggle('hud-reticles--cockpit', isCockpit);
    }

    if (state.camera !== lastCamera) {
      lastCamera = state.camera;
      cameraBadge.textContent = CAMERA_LABEL[state.camera];
    }

    const locked = typeof document !== 'undefined' && canvas !== null && document.pointerLockElement === canvas;
    if (state.controlMode !== lastControl || locked !== lastLocked || vehicle !== lastVehicle) {
      lastControl = state.controlMode;
      lastLocked = locked;
      const isMouse = state.controlMode === 'mouse';
      controlBadge.textContent = isMouse ? 'MOUSE' : 'TECLADO';
      controlBadge.className = `hud-control ${isMouse ? 'hud-control--mouse' : 'hud-control--keyboard'}`;
      if (vehicle === 'foot' || vehicle === 'heli') {
        lockHint.textContent = 'Clique para girar a câmera';
        lockHint.hidden = locked || rt.mode !== 'playing';
      } else if (vehicle === 'a29') {
        lockHint.textContent = 'Clique no canvas para mirar';
        lockHint.hidden = !isMouse || locked || rt.mode !== 'playing';
      } else {
        lockHint.hidden = true;
      }
      aimRing.classList.toggle('hud-aim-ring--unlocked', isMouse && !locked);
    }

    if (vehicle === 'a29') {
      const smokeOn = isSmokeActive(state);
      if (smokeOn !== lastSmoke) {
        lastSmoke = smokeOn;
        smokeBadge.textContent = smokeOn ? 'FUMAÇA ON' : 'FUMAÇA OFF';
        smokeBadge.className = `hud-smoke ${smokeOn ? 'hud-smoke--on' : 'hud-smoke--off'}`;
      }
    }

    // Relógio grande no topo, pontos e progresso da missão
    const mission = ctx.mission;
    if (mission) {
      const clockText = formatClock(mission.clockMinutes);
      if (clockText !== lastClockText) {
        lastClockText = clockText;
        clockDigits.textContent = clockText;
      }
      const urgent = mission.status === 'playing' && mission.clockMinutes >= 22 * 60;
      if (urgent !== lastClockUrgent) {
        lastClockUrgent = urgent;
        clockWrap.classList.toggle('hud-clock--urgent', urgent);
        clockTag.textContent = urgent ? 'CORRE! QUASE MEIA-NOITE' : 'ATÉ MEIA-NOITE';
      }

      if (mission.score !== lastScore) {
        lastScore = mission.score;
        scoreBadge.textContent = `${mission.score.toLocaleString('pt-BR')} PTS`;
      }

      const totalKey = `${mission.delivered}/${mission.total}`;
      if (totalKey !== lastTotalKey) {
        lastTotalKey = totalKey;
        totalBadge.textContent = mission.total > 0 ? `${totalKey} ENTREGAS` : 'TURNO ATIVO';
      }

      // Painel do objetivo
      const { activeStage, stageDeliveries, doneInStage, next } = findNextDelivery(mission);
      let targetText = 'Explore a cidade ou inicie as entregas';
      let distText = '';
      let hintText = '';

      if (mission.deliveries.length > 0) {
        const idxInStage = Math.min(stageDeliveries.length, doneInStage + 1);
        if (next) {
          targetText = `Entrega ${idxInStage}/${Math.max(1, stageDeliveries.length)}: ${next.name}`;
          const dist = Math.hypot(next.x - state.x, next.z - state.z);
          distText = formatDistance(dist);
          if (next.airDrop) hintText = 'ESPAÇO · LANÇAR';
          else if (next.leadsToNext) hintText = 'PRÓXIMO VEÍCULO';
        } else if (mission.carrying === null) {
          targetText = `Entre no ${NEARBY_LABEL[mission.stage]} para pegar as encomendas`;
          const vehCoords = findNextVehicleCoords(mission);
          if (vehCoords) distText = formatDistance(Math.hypot(vehCoords.x - state.x, vehCoords.z - state.z));
        }
      }

      const objKey = `${mission.status}|${activeStage}|${targetText}|${distText}|${hintText}`;
      if (objKey !== lastObjKey) {
        lastObjKey = objKey;
        objPanel.hidden = mission.status !== 'playing';
        objStage.textContent = STAGE_LABEL[activeStage];
        objTarget.textContent = targetText;
        objDist.textContent = distText;
        objHint.textContent = hintText;
        objHint.hidden = !hintText;
      }

      // Mensagens da missão
      const showMsg = Boolean(mission.message && mission.messageTimer > 0);
      const msgKey = showMsg ? `${mission.message}` : '';
      if (msgKey !== lastMsgKey) {
        lastMsgKey = msgKey;
        missionMsg.hidden = !showMsg;
        if (showMsg && mission.message) {
          missionMsg.textContent = mission.message;
          const isWarn = /bloquead|trancad|termine as entregas|cuidado|falta|meia-noite|errado/i.test(mission.message);
          missionMsg.className = `hud-mission-msg ${isWarn ? 'hud-mission-msg--warn' : 'hud-mission-msg--ok'}`;
        }
      }
    }

    // Telemetria aérea
    if (isAircraft && !isCockpit) {
      const speedKmh = Math.round(state.speed * 3.6);
      if (speedKmh !== lastSpeedKmh) {
        lastSpeedKmh = speedKmh;
        speedVal.textContent = `${speedKmh} km/h`;
      }

      const altM = Math.round(state.altitude);
      if (altM !== lastAltM) {
        lastAltM = altM;
        altVal.textContent = `${altM} m`;
      }

      const throttlePct = Math.round(Math.max(0, Math.min(1, state.throttle)) * 100);
      if (throttlePct !== lastThrottlePct) {
        lastThrottlePct = throttlePct;
        throttleVal.textContent = `${throttlePct}%`;
        throttleFill.style.transform = `scaleX(${throttlePct / 100})`;
      }
    }

    // Velocímetro automotivo + barra de nitro do Coupé Tunado
    const nitroInfo = updateNitro(dt, rt.mode === 'playing');
    if (isCar) {
      const kmh = Math.round(Math.abs(state.speed) * 3.6);
      if (kmh !== lastCarSpeed) {
        lastCarSpeed = kmh;
        carSpeedVal.textContent = String(kmh);
      }
      const { label, rpmRatio } = estimateCarGear(state.speed, state.throttle, vehicle === 'tuned');
      if (label !== lastCarGear) {
        lastCarGear = label;
        carGear.textContent = label;
      }
      carRpmFill.style.transform = `scaleX(${rpmRatio.toFixed(3)})`;

      if (vehicle === 'tuned') {
        const nitroPct = Math.round(nitroInfo.ratio * 100);
        if (nitroPct !== lastNitroPct) {
          lastNitroPct = nitroPct;
          nitroVal.textContent = `${nitroPct}%`;
          nitroFill.style.transform = `scaleX(${(nitroPct / 100).toFixed(3)})`;
        }
        if (nitroInfo.active !== lastNitroHot) {
          lastNitroHot = nitroInfo.active;
          nitroRow.classList.toggle('hud-nitro-row--active', nitroInfo.active);
        }
      }
    }

    // Aviso de veículo próximo ("E — entrar no <veículo>" ou aviso de veículo bloqueado)
    const nearbyKind = state.nearbyVehicleKind;
    const nearbyLocked = nearbyKind ? isStageLocked(nearbyKind, mission) : false;
    const nearbyKey =
      rt.mode === 'playing' && state.nearbyVehicleId && nearbyKind
        ? `${state.nearbyVehicleId}:${nearbyKind}:${nearbyLocked ? 'lock' : 'ok'}`
        : '';
    if (nearbyKey !== lastNearbyKey) {
      lastNearbyKey = nearbyKey;
      if (!nearbyKey || !nearbyKind) {
        nearbyPrompt.hidden = true;
      } else if (nearbyLocked) {
        nearbyPrompt.textContent = `BLOQUEADO — termine o estágio atual para liberar o ${NEARBY_LABEL[nearbyKind]}`;
        nearbyPrompt.className = 'hud-nearby hud-nearby--locked';
        nearbyPrompt.hidden = false;
      } else {
        nearbyPrompt.textContent = `E — entrar no ${NEARBY_LABEL[nearbyKind]}`;
        nearbyPrompt.className = 'hud-nearby';
        nearbyPrompt.hidden = false;
      }
    }

    // Miras de voo (apenas A-29 no modo mouse; nos demais veículos o mouse só gira a câmera)
    const showReticles = rt.mode === 'playing' && vehicle === 'a29' && state.controlMode === 'mouse' && !state.crashed;
    const cw = canvas?.clientWidth || root.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 0);
    const ch = canvas?.clientHeight || root.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 0);
    if (showReticles) {
      camera.camera?.onAppPrerender?.();
      camPos.copy(camera.getPosition());
      camRot.copy(camera.getRotation());
      camRot.transformVector(Vec3.FORWARD, camFwd);
      planeRot.copy(plane.root.getRotation());
      planeRot.transformVector(Vec3.FORWARD, noseDir);
    }

    updateMarker(
      showReticles,
      state.x + state.aimX * PROJECTION_DIST,
      state.y + state.aimY * PROJECTION_DIST,
      state.z + state.aimZ * PROJECTION_DIST,
      cw,
      ch,
      aimRing,
      aimCache,
    );
    updateMarker(
      showReticles,
      state.x + noseDir.x * PROJECTION_DIST,
      state.y + noseDir.y * PROJECTION_DIST,
      state.z + noseDir.z * PROJECTION_DIST,
      cw,
      ch,
      noseCross,
      noseCache,
    );

    const alert: AlertState = state.crashed ? 'crashed' : isAircraft && state.stall ? 'stall' : 'none';
    if (alert !== lastAlert) {
      lastAlert = alert;
      if (alert === 'none') {
        alertBox.hidden = true;
        alertBox.className = 'hud-alert';
        alertBox.textContent = '';
      } else if (alert === 'crashed') {
        alertBox.hidden = false;
        alertBox.className = 'hud-alert hud-alert--crashed';
        alertBox.textContent = 'BATEU — reiniciando';
      } else {
        alertBox.hidden = false;
        alertBox.className = 'hud-alert hud-alert--stall';
        alertBox.textContent = 'ESTOL';
      }
    }

    drawMinimap();
  }

  sync(0);

  return {
    update(dt: number) {
      sync(dt);
    },
    destroy() {
      nitroActiveByState.delete(state);
      root.remove();
    },
  };
}
