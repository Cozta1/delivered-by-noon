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
import { AIRPORT, CITY, cityData } from './world-data';

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
  car: 'CARRO',
  tuned: 'TUNADO',
  a29: 'A-29',
  heli: 'HELI',
};

const NEARBY_LABEL: Record<Exclude<VehicleKind, 'foot'>, string> = {
  car: 'carro',
  tuned: 'carro tunado',
  a29: 'A-29',
  heli: 'helicóptero',
};

const STAGE_LABEL: Record<Stage, string> = {
  car: 'ESTÁGIO 1/4 · CARRO',
  tuned: 'ESTÁGIO 2/4 · CARRO TUNADO',
  heli: 'ESTÁGIO 3/4 · HELICÓPTERO',
  a29: 'ESTÁGIO 4/4 · AVIÃO A-29',
};

const STAGE_SHORT_CODE: Record<Stage, string> = {
  car: 'C',
  tuned: 'T',
  heli: 'H',
  a29: 'A',
};

const FOOTER_BY_VEHICLE: Record<VehicleKind, string> = {
  foot: 'W/A/S/D andar · Espaço pular · Mouse câmera · E entrar em veículo · C câmera · Esc/P pausa',
  car: 'W/S acelerar/ré · A/D virar · Espaço freio de mão · E sair · C câmera · R reiniciar · Esc/P pausa',
  tuned: 'W/S acelerar/ré · A/D virar · Shift NITRO · Espaço freio de mão · E sair · C câmera · Esc/P pausa',
  a29: 'Mouse mira · M mouse/teclado · Shift/Ctrl acel · Espaço soltar carga · F fumaça · E sair · C câmera · Esc/P pausa',
  heli: 'W/S inclinar · A/D lateral · Q/E girar · Shift/Ctrl coletivo · Mouse mira · E sair · C câmera · Esc/P pausa',
};

const PROJECTION_DIST = 500;
const HELIPAD_POS = cityData().helipad;

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

  // Velocímetro automotivo (carro e carro tunado)
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

  // Barra de nitro (exclusiva do carro tunado)
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
  const objStage = el('div', 'hud-obj-stage', 'ESTÁGIO 1/4 · CARRO');
  const objTarget = el('div', 'hud-obj-target', 'Aguardando entregas...');
  const objFoot = el('div', 'hud-obj-foot');
  const objDist = el('span', 'hud-obj-dist', '');
  const objHint = el('span', 'hud-obj-hint', '');
  objFoot.append(objDist, objHint);
  objPanel.append(objStage, objTarget, objFoot);

  leftCol.append(panel, objPanel);

  // Canto superior direito: Minimapa 2D
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

    // 1) Procura o veículo já existente na cena pelo tipo
    for (let i = 0; i < blips.length; i++) {
      if (blips[i].kind === nextStage) {
        return { stage: nextStage, x: blips[i].x, z: blips[i].z };
      }
    }

    // 2) Fallback: entrega `leadsToNext` do estágio atual
    for (let i = 0; i < mission.deliveries.length; i++) {
      const d = mission.deliveries[i];
      if (d.stage === mission.stage && d.leadsToNext) {
        return { stage: nextStage, x: d.x, z: d.z };
      }
    }

    // 3) Fallback geográfico conhecido (heliponto / aeroporto)
    if (nextStage === 'heli') return { stage: nextStage, x: HELIPAD_POS.x, z: HELIPAD_POS.z };
    if (nextStage === 'a29') return { stage: nextStage, x: AIRPORT.x, z: 410 };
    return null;
  }

  function clampToMap(x: number, y: number, size: number, pad: number): { x: number; y: number; clamped: boolean } {
    const half = size * 0.5;
    const dx = x - half;
    const dy = y - half;
    const maxR = half - pad;
    if (Math.abs(dx) <= maxR && Math.abs(dy) <= maxR) {
      return { x, y, clamped: false };
    }
    const scale = Math.max(Math.abs(dx) / maxR, Math.abs(dy) / maxR, 1e-4);
    return { x: half + dx / scale, y: half + dy / scale, clamped: true };
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
    const range = state.vehicle === 'foot' || state.vehicle === 'car' ? 580 : state.vehicle === 'tuned' ? 720 : 1280;
    const scale = half / range;
    const toX = (wx: number) => half + (wx - state.x) * scale;
    const toY = (wz: number) => half + (wz - state.z) * scale;

    // Fundo terreno
    mapCtx.fillStyle = '#101d22';
    mapCtx.fillRect(0, 0, size, size);

    // Mar ao sul (z > 540)
    const seaY = toY(540);
    if (seaY < size) {
      mapCtx.fillStyle = '#0f2c40';
      mapCtx.fillRect(0, Math.max(0, seaY), size, size - Math.max(0, seaY));
    }

    // Cidade
    const cx0 = toX(CITY.x0);
    const cx1 = toX(CITY.x1);
    const cz0 = toY(CITY.z0);
    const cz1 = toY(CITY.z1);
    mapCtx.fillStyle = 'rgba(126, 152, 174, 0.22)';
    mapCtx.fillRect(cx0, cz0, cx1 - cx0, cz1 - cz0);
    mapCtx.strokeStyle = 'rgba(180, 204, 218, 0.25)';
    mapCtx.lineWidth = 1;
    mapCtx.strokeRect(cx0, cz0, cx1 - cx0, cz1 - cz0);

    // Pista de pouso
    const rwX = toX(AIRPORT.x);
    const rwY = toY(AIRPORT.z);
    const rwW = Math.max(4, AIRPORT.width * scale);
    const rwH = Math.max(16, AIRPORT.length * scale);
    mapCtx.fillStyle = '#4b5563';
    mapCtx.fillRect(rwX - rwW * 0.5, rwY - rwH * 0.5, rwW, rwH);
    mapCtx.strokeStyle = '#ffd58a';
    mapCtx.lineWidth = 1;
    mapCtx.beginPath();
    mapCtx.moveTo(rwX, rwY - rwH * 0.44);
    mapCtx.lineTo(rwX, rwY + rwH * 0.44);
    mapCtx.stroke();

    // Heliponto no centro da cidade
    const hpX = toX(HELIPAD_POS.x);
    const hpY = toY(HELIPAD_POS.z);
    mapCtx.beginPath();
    mapCtx.arc(hpX, hpY, 6, 0, Math.PI * 2);
    mapCtx.fillStyle = 'rgba(20, 44, 52, 0.85)';
    mapCtx.fill();
    mapCtx.strokeStyle = '#5cf0d8';
    mapCtx.lineWidth = 1.2;
    mapCtx.stroke();
    mapCtx.fillStyle = '#5cf0d8';
    mapCtx.font = '700 8px system-ui, sans-serif';
    mapCtx.textAlign = 'center';
    mapCtx.textBaseline = 'middle';
    mapCtx.fillText('H', hpX, hpY + 0.5);

    // Veículos estacionados / na cena (escaneados a cada ~10 quadros)
    if (minimapFrame % 10 === 0) {
      scanSceneVehicles(app.root, blips);
    }
    minimapFrame++;

    for (let i = 0; i < blips.length; i++) {
      const b = blips[i];
      if (Math.hypot(b.x - state.x, b.z - state.z) < 4) continue;
      const bx = toX(b.x);
      const by = toY(b.z);
      if (bx < 4 || bx > size - 4 || by < 4 || by > size - 4) continue;
      mapCtx.fillStyle =
        b.kind === 'a29'
          ? '#60a5fa'
          : b.kind === 'heli'
            ? '#3dd6bd'
            : b.kind === 'tuned'
              ? '#ff4dc4'
              : '#ff9e4a';
      mapCtx.beginPath();
      mapCtx.arc(bx, by, b.kind === 'car' ? 2.6 : 3.4, 0, Math.PI * 2);
      mapCtx.fill();
    }

    // Entregas e próximo veículo a desbloquear
    const mission = ctx.mission;
    if (mission && mission.status === 'playing') {
      const { pendingStage, next } = findNextDelivery(mission);
      const pulse = 0.5 + 0.5 * Math.sin(animPhase * 5.2);

      // Próximo veículo a desbloquear (badge quadrado com letra T/H/A)
      const nextVeh = findNextVehicleCoords(mission);
      if (nextVeh) {
        const pt = clampToMap(toX(nextVeh.x), toY(nextVeh.z), size, 12);
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

      // Entregas pendentes do estágio atual (diamantes ciano)
      for (let i = 0; i < pendingStage.length; i++) {
        const d = pendingStage[i];
        if (next && d.id === next.id) continue;
        const pt = clampToMap(toX(d.x), toY(d.z), size, 8);
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

      // Próxima entrega destacada (halo pulsante dourado + centro brilhante)
      if (next) {
        const pt = clampToMap(toX(next.x), toY(next.z), size, 10);
        const haloR = 6 + pulse * 3.5;
        mapCtx.beginPath();
        mapCtx.arc(pt.x, pt.y, haloR, 0, Math.PI * 2);
        mapCtx.strokeStyle = next.airDrop ? 'rgba(92, 225, 255, 0.85)' : 'rgba(255, 214, 72, 0.9)';
        mapCtx.lineWidth = 1.8;
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

    // Seta do jogador no centro
    mapCtx.save();
    mapCtx.translate(half, half);
    mapCtx.rotate((state.heading * Math.PI) / 180);
    mapCtx.beginPath();
    mapCtx.moveTo(0, -6.5);
    mapCtx.lineTo(4.5, 5);
    mapCtx.lineTo(0, 2.5);
    mapCtx.lineTo(-4.5, 5);
    mapCtx.closePath();
    mapCtx.fillStyle = '#fff5e6';
    mapCtx.fill();
    mapCtx.strokeStyle = '#0c131d';
    mapCtx.lineWidth = 1;
    mapCtx.stroke();
    mapCtx.restore();

    // Indicador Norte
    mapCtx.fillStyle = '#ffbd7d';
    mapCtx.font = '800 10px system-ui, sans-serif';
    mapCtx.textAlign = 'center';
    mapCtx.textBaseline = 'top';
    mapCtx.fillText('N', half, 5);
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

    // Fallback local suave quando car.ts não escreve `nitro` em FlightState
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
      controlBadge.hidden = !isAircraft;
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
      if (vehicle === 'foot') {
        lockHint.textContent = 'Clique para girar a câmera';
        lockHint.hidden = locked || rt.mode !== 'playing';
      } else if (isAircraft) {
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

      // Mensagens da missão (ex.: "Entregue! +150", "Carro tunado liberado!", aviso bloqueado)
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

    // Velocímetro automotivo + barra de nitro do tunado
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

    // Miras de voo (apenas aeronaves no modo mouse)
    const showReticles = rt.mode === 'playing' && isAircraft && state.controlMode === 'mouse' && !state.crashed;
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
