import { type Entity, KEY_SHIFT, KEY_W, Quat, Vec3 } from 'playcanvas';
import { getActiveRoute } from './rota';
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
import { AIRPORT, cityLayout, terrainHeight } from './world-data';

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

// Dimensões da planta pré-renderizada do minimapa de Juiz de Fora (uma única vez por sessão)
const MAP_CANVAS_PX = 1024;

interface MinimapLandmark {
  name: string;
  x: number;
  z: number;
  highlight?: boolean;
}

interface MinimapBlueprint {
  canvas: HTMLCanvasElement;
  minX: number;
  minZ: number;
  spanX: number;
  spanZ: number;
  pxPerMX: number;
  pxPerMZ: number;
  helipad: { x: number; z: number };
  workshop: { x: number; z: number };
  runwayCenter: { x: number; z: number };
  landmarks: MinimapLandmark[];
}

let cachedBlueprint: MinimapBlueprint | null = null;

function traceFlatPolygon(
  g: CanvasRenderingContext2D,
  pts: ReadonlyArray<number>,
  wx: (x: number) => number,
  wz: (z: number) => number,
): boolean {
  if (pts.length < 6) return false;
  g.beginPath();
  g.moveTo(wx(pts[0]), wz(pts[1]));
  for (let i = 2; i + 1 < pts.length; i += 2) {
    g.lineTo(wx(pts[i]), wz(pts[i + 1]));
  }
  g.closePath();
  return true;
}

function strokeFlatLines(
  g: CanvasRenderingContext2D,
  lines: ReadonlyArray<ReadonlyArray<number>>,
  wx: (x: number) => number,
  wz: (z: number) => number,
): void {
  g.beginPath();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length < 4) continue;
    g.moveTo(wx(line[0]), wz(line[1]));
    for (let j = 2; j + 1 < line.length; j += 2) {
      g.lineTo(wx(line[j]), wz(line[j + 1]));
    }
  }
  g.stroke();
}

const ROAD_STYLE: Record<string, { color: string; casing?: string; minPx: number; scale: number }> = {
  tertiary: { color: '#455466', minPx: 1.0, scale: 0.72 },
  secondary: { color: '#697a8e', minPx: 1.5, scale: 0.8 },
  primary: { color: '#99aab9', casing: 'rgba(12, 18, 26, 0.75)', minPx: 2.1, scale: 0.86 },
  trunk: { color: '#cfa96b', casing: 'rgba(14, 18, 24, 0.85)', minPx: 2.7, scale: 0.92 },
  motorway: { color: '#ebb054', casing: 'rgba(16, 18, 24, 0.92)', minPx: 3.3, scale: 0.98 },
};

function buildMinimapBlueprint(): MinimapBlueprint | null {
  if (cachedBlueprint) return cachedBlueprint;
  if (typeof document === 'undefined') return null;

  const canvas = document.createElement('canvas');
  canvas.width = MAP_CANVAS_PX;
  canvas.height = MAP_CANVAS_PX;
  const g = canvas.getContext('2d');
  if (!g) return null;

  const layout = cityLayout();
  const minX = layout.bounds.x0;
  const minZ = layout.bounds.z0;
  const spanX = Math.max(1, layout.bounds.x1 - layout.bounds.x0);
  const spanZ = Math.max(1, layout.bounds.z1 - layout.bounds.z0);
  const pxPerMX = MAP_CANVAS_PX / spanX;
  const pxPerMZ = MAP_CANVAS_PX / spanZ;
  const pxPerM = (pxPerMX + pxPerMZ) * 0.5;
  const wx = (x: number) => (x - minX) * pxPerMX;
  const wz = (z: number) => (z - minZ) * pxPerMZ;
  const ws = (m: number) => m * pxPerM;

  // 1) Fundo de terreno de Juiz de Fora (sem mar) com sombreamento topográfico suave
  g.fillStyle = '#14201b';
  g.fillRect(0, 0, MAP_CANVAS_PX, MAP_CANVAS_PX);

  const reliefStep = 90;
  const cellW = reliefStep * pxPerMX + 1;
  const cellH = reliefStep * pxPerMZ + 1;
  for (let z = minZ; z < layout.bounds.z1; z += reliefStep) {
    for (let x = minX; x < layout.bounds.x1; x += reliefStep) {
      const h = terrainHeight(x + reliefStep * 0.5, z + reliefStep * 0.5);
      if (h > 35) {
        const a = Math.min(0.28, (h - 35) / 360);
        g.fillStyle = h > 135 ? `rgba(148, 160, 146, ${a.toFixed(3)})` : `rgba(88, 128, 102, ${a.toFixed(3)})`;
        g.fillRect(wx(x), wz(z), cellW, cellH);
      }
    }
  }

  // 2) Polígonos reais: aeroporto, universidades (UFJF), praças/parques e estádios
  if (traceFlatPolygon(g, layout.airportPolygon, wx, wz)) {
    g.fillStyle = '#252f38';
    g.fill();
    g.strokeStyle = 'rgba(162, 188, 212, 0.35)';
    g.lineWidth = 1.2;
    g.stroke();
  }

  g.fillStyle = '#1b473e';
  g.strokeStyle = 'rgba(110, 214, 186, 0.45)';
  g.lineWidth = 1.1;
  for (let i = 0; i < layout.universityPolygons.length; i++) {
    if (traceFlatPolygon(g, layout.universityPolygons[i].pts, wx, wz)) {
      g.fill();
      g.stroke();
    }
  }

  g.fillStyle = '#1c5636';
  g.strokeStyle = 'rgba(98, 212, 142, 0.48)';
  g.lineWidth = 1.0;
  for (let i = 0; i < layout.parkPolygons.length; i++) {
    if (traceFlatPolygon(g, layout.parkPolygons[i].pts, wx, wz)) {
      g.fill();
      g.stroke();
    }
  }

  g.fillStyle = '#245e3b';
  g.strokeStyle = 'rgba(222, 232, 238, 0.72)';
  g.lineWidth = 1.5;
  for (let i = 0; i < layout.stadiumPolygons.length; i++) {
    if (traceFlatPolygon(g, layout.stadiumPolygons[i].pts, wx, wz)) {
      g.fill();
      g.stroke();
    }
  }

  // 3) Planta dos prédios (desenhada abaixo das vias para manter a malha viária nítida)
  for (let i = 0; i < layout.buildings.length; i++) {
    const b = layout.buildings[i];
    const hNorm = Math.max(0, Math.min(1, (b.top - 10) / 140));
    const lum = Math.round(62 + hNorm * 58);
    g.fillStyle = `rgba(${lum - 6}, ${lum + 2}, ${lum + 14}, 0.72)`;
    g.fillRect(wx(b.x0), wz(b.z0), Math.max(1.1, (b.x1 - b.x0) * pxPerMX), Math.max(1.1, (b.z1 - b.z0) * pxPerMZ));
  }

  // 4) Rio Paraibuna (`layout.river`)
  if (layout.river.lines.length > 0) {
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const riverW = Math.max(2.8, ws(layout.river.width));
    g.strokeStyle = 'rgba(42, 138, 184, 0.34)';
    g.lineWidth = riverW + 2.4;
    strokeFlatLines(g, layout.river.lines, wx, wz);
    g.strokeStyle = '#32a8d2';
    g.lineWidth = riverW;
    strokeFlatLines(g, layout.river.lines, wx, wz);
  }

  // 5) Malha viária real por categoria (`layout.roadLines`, da menor à maior)
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (let i = layout.roadLines.length - 1; i >= 0; i--) {
    const group = layout.roadLines[i];
    if (group.lines.length === 0) continue;
    const style = ROAD_STYLE[group.category] ?? ROAD_STYLE.tertiary;
    const widthPx = Math.max(style.minPx, ws(group.width * style.scale));
    if (style.casing) {
      g.strokeStyle = style.casing;
      g.lineWidth = widthPx + 1.5;
      strokeFlatLines(g, group.lines, wx, wz);
    }
    g.strokeStyle = style.color;
    g.lineWidth = widthPx;
    strokeFlatLines(g, group.lines, wx, wz);
  }

  // 6) Pista real do Aeroporto da Serrinha (`layout.runwayLine`, orientada pelo rumo real)
  const { a: rA, b: rB, width: rwWidthM } = layout.runwayLine;
  const rAx = wx(rA.x);
  const rAz = wz(rA.z);
  const rBx = wx(rB.x);
  const rBz = wz(rB.z);
  const rwPx = Math.max(4.6, ws(rwWidthM));
  g.lineCap = 'butt';
  g.strokeStyle = '#111822';
  g.lineWidth = rwPx + 2;
  g.beginPath();
  g.moveTo(rAx, rAz);
  g.lineTo(rBx, rBz);
  g.stroke();
  g.strokeStyle = '#5c697b';
  g.lineWidth = rwPx;
  g.beginPath();
  g.moveTo(rAx, rAz);
  g.lineTo(rBx, rBz);
  g.stroke();
  g.strokeStyle = '#ffd58a';
  g.lineWidth = 1.2;
  g.setLineDash([4, 3]);
  g.beginPath();
  g.moveTo(rAx, rAz);
  g.lineTo(rBx, rBz);
  g.stroke();
  g.setLineDash([]);

  // 7) Lote da UniAcademia em destaque dourado na planta (`layout.landmarks.uniacademia`)
  const uni = layout.landmarks.uniacademia;
  g.save();
  g.translate(wx(uni.x), wz(uni.z));
  g.rotate((uni.heading * Math.PI) / 180);
  const uniW = Math.max(7, uni.width * pxPerMX);
  const uniD = Math.max(5.5, uni.depth * pxPerMZ);
  g.fillStyle = 'rgba(255, 210, 74, 0.32)';
  g.fillRect(-uniW * 0.5 - 3, -uniD * 0.5 - 3, uniW + 6, uniD + 6);
  g.fillStyle = '#f5c542';
  g.strokeStyle = '#fff6c2';
  g.lineWidth = 1.5;
  g.fillRect(-uniW * 0.5, -uniD * 0.5, uniW, uniD);
  g.strokeRect(-uniW * 0.5, -uniD * 0.5, uniW, uniD);
  g.restore();

  // 8) Oficina do Coupé Tunado (`layout.workshop`)
  const wkX = wx(layout.workshop.x);
  const wkZ = wz(layout.workshop.z);
  g.fillStyle = 'rgba(42, 26, 12, 0.9)';
  g.strokeStyle = '#ff9e4a';
  g.lineWidth = 1.5;
  g.fillRect(wkX - 5, wkZ - 5, 10, 10);
  g.strokeRect(wkX - 5, wkZ - 5, 10, 10);

  // 9) Heliponto (`layout.helipad`)
  const hpX = wx(layout.helipad.x);
  const hpZ = wz(layout.helipad.z);
  g.beginPath();
  g.arc(hpX, hpZ, 5.5, 0, Math.PI * 2);
  g.fillStyle = 'rgba(14, 38, 46, 0.92)';
  g.fill();
  g.strokeStyle = '#5cf0d8';
  g.lineWidth = 1.4;
  g.stroke();

  const runwayCenter = { x: (rA.x + rB.x) * 0.5, z: (rA.z + rB.z) * 0.5 };
  const landmarks: MinimapLandmark[] = [
    { name: 'Centro', x: layout.landmarks.centro.x, z: layout.landmarks.centro.z },
    { name: 'UFJF', x: layout.landmarks.ufjf.x, z: layout.landmarks.ufjf.z },
    { name: 'Cristo', x: layout.landmarks.cristo.x, z: layout.landmarks.cristo.z },
    { name: 'Estádio', x: layout.landmarks.estadio.x, z: layout.landmarks.estadio.z },
    { name: 'Aeroporto', x: runwayCenter.x, z: runwayCenter.z },
    { name: 'UniAcademia', x: uni.x, z: uni.z, highlight: true },
  ];

  cachedBlueprint = {
    canvas,
    minX,
    minZ,
    spanX,
    spanZ,
    pxPerMX,
    pxPerMZ,
    helipad: { x: layout.helipad.x, z: layout.helipad.z },
    workshop: { x: layout.workshop.x, z: layout.workshop.z },
    runwayCenter,
    landmarks,
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
  if (meters >= 1000) return `${(meters / 1000).toFixed(1).replace('.', ',')} km`;
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
  const minimapTag = el('div', 'hud-minimap-tag', 'JUIZ DE FORA');
  minimapWrap.append(minimapCanvas, minimapTag);
  const mapCtx = minimapCanvas.getContext('2d');

  // Aviso de proximidade para entrar em veículo / veículo bloqueado
  const nearbyPrompt = el('div', 'hud-nearby');
  nearbyPrompt.hidden = true;

  // Aviso central (estol / impacto)
  const alertBox = el('div', 'hud-alert');
  alertBox.hidden = true;

  // Selo e atalhos discretos do Modo Apresentação (visíveis somente quando ativo)
  const presBox = el('div', 'hud-pres-wrap');
  presBox.hidden = true;
  const presBadge = el('div', 'hud-pres-badge', 'MODO APRESENTAÇÃO');
  const presKeys = el('div', 'hud-pres-keys', 'F1 Carro · F2 Tunado · F3 Heli · F4 A-29 · F5 Final · F6 +1h');
  presBox.append(presBadge, presKeys);

  // Vinheta vermelha pulsante após 23:00 + contagem regressiva grande nos últimos 60 s + "+pontos" flutuante
  const urgentVignette = el('div', 'hud-urgent-vignette');
  urgentVignette.hidden = true;

  const countdownEl = el('div', 'hud-countdown');
  countdownEl.hidden = true;

  const scorePop = el('div', 'hud-score-pop');
  scorePop.hidden = true;

  // Rodapé de atalhos
  const footer = el('div', 'hud-footer', FOOTER_BY_VEHICLE.car);

  root.append(
    urgentVignette,
    reticlesLayer,
    clockWrap,
    scorePop,
    countdownEl,
    missionMsg,
    leftCol,
    minimapWrap,
    nearbyPrompt,
    alertBox,
    presBox,
    footer,
  );
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
  let lastPresVisible: boolean | null = null;
  let lastNearbyKey = '';
  let lastAlert: AlertState = 'none';
  let lastClockText = '';
  let lastClockUrgent: boolean | null = null;
  let lastVignetteOpacity = -1;
  let lastCountdownSec = -1;
  let scorePopTimer = 0;
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
    if (nextStage === 'a29') {
      return blueprint
        ? { stage: nextStage, x: blueprint.runwayCenter.x, z: blueprint.runwayCenter.z }
        : { stage: nextStage, x: AIRPORT.x, z: AIRPORT.z };
    }
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

    // Fundo de relevo caso o recorte gire além das bordas
    mapCtx.fillStyle = '#14201b';
    mapCtx.fillRect(0, 0, size, size);

    // 1) Planta pré-renderizada de Juiz de Fora girando e centralizando no jogador
    if (blueprint) {
      mapCtx.save();
      mapCtx.translate(half, half);
      mapCtx.rotate(-hRad);
      const drawW = blueprint.spanX * scale;
      const drawH = blueprint.spanZ * scale;
      const ox = -(state.x - blueprint.minX) * scale;
      const oz = -(state.z - blueprint.minZ) * scale;
      mapCtx.drawImage(blueprint.canvas, ox, oz, drawW, drawH);
      mapCtx.restore();

      // 1b) Marcos de Juiz de Fora em texto sempre horizontal (com UniAcademia destacada)
      const uniPulse = 0.5 + 0.5 * Math.sin(animPhase * 4.2);
      mapCtx.save();
      mapCtx.textAlign = 'center';
      mapCtx.textBaseline = 'bottom';
      mapCtx.lineJoin = 'round';
      for (let i = 0; i < blueprint.landmarks.length; i++) {
        const lm = blueprint.landmarks[i];
        const p = worldToRotatedMap(lm.x, lm.z, scale, cosH, sinH, half);
        if (p.x < 10 || p.x > size - 10 || p.y < 14 || p.y > size - 10) continue;

        if (lm.highlight) {
          // UniAcademia: estrela/losango dourado pulsante + rótulo dourado em destaque
          mapCtx.beginPath();
          mapCtx.arc(p.x, p.y, 4.8 + uniPulse * 2.2, 0, Math.PI * 2);
          mapCtx.strokeStyle = 'rgba(255, 224, 96, 0.85)';
          mapCtx.lineWidth = 1.3;
          mapCtx.stroke();

          mapCtx.save();
          mapCtx.translate(p.x, p.y);
          mapCtx.rotate(Math.PI / 4);
          mapCtx.fillStyle = '#ffd84d';
          mapCtx.strokeStyle = '#1a1204';
          mapCtx.lineWidth = 1.1;
          mapCtx.fillRect(-3.4, -3.4, 6.8, 6.8);
          mapCtx.strokeRect(-3.4, -3.4, 6.8, 6.8);
          mapCtx.restore();

          mapCtx.font = '800 8.5px system-ui, sans-serif';
          mapCtx.strokeStyle = 'rgba(8, 12, 18, 0.92)';
          mapCtx.lineWidth = 2.8;
          mapCtx.strokeText(lm.name, p.x, p.y - 6);
          mapCtx.fillStyle = '#ffe26a';
          mapCtx.fillText(lm.name, p.x, p.y - 6);
        } else {
          mapCtx.beginPath();
          mapCtx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
          mapCtx.fillStyle = '#d6e4f0';
          mapCtx.fill();
          mapCtx.strokeStyle = '#0b121c';
          mapCtx.lineWidth = 0.8;
          mapCtx.stroke();

          mapCtx.font = '700 7.5px system-ui, sans-serif';
          mapCtx.strokeStyle = 'rgba(8, 12, 18, 0.86)';
          mapCtx.lineWidth = 2.4;
          mapCtx.strokeText(lm.name, p.x, p.y - 4);
          mapCtx.fillStyle = 'rgba(232, 240, 248, 0.92)';
          mapCtx.fillText(lm.name, p.x, p.y - 4);
        }
      }
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

      // Próxima entrega destacada (halo dourado pulsante) + rota de GPS sobre as vias
      if (next) {
        const route = getActiveRoute(state);
        if (route && route.points.length >= 2) {
          const routeColor = next.leadsToNext ? '#ff6ee0' : '#ffd648';
          mapCtx.save();
          mapCtx.lineCap = 'round';
          mapCtx.lineJoin = 'round';
          mapCtx.beginPath();
          for (let i = 0; i < route.points.length; i++) {
            const p = worldToRotatedMap(route.points[i].x, route.points[i].z, scale, cosH, sinH, half);
            if (i === 0) mapCtx.moveTo(p.x, p.y);
            else mapCtx.lineTo(p.x, p.y);
          }
          mapCtx.strokeStyle = 'rgba(8, 12, 20, 0.88)';
          mapCtx.lineWidth = 5.4;
          mapCtx.stroke();
          mapCtx.strokeStyle = routeColor;
          mapCtx.lineWidth = 3.2;
          mapCtx.stroke();

          // Trecho final tracejado do último ponto da via até a entrega
          if (route.finalLegDistance > 2) {
            const lastPt = route.points[route.points.length - 1];
            const pA = worldToRotatedMap(lastPt.x, lastPt.z, scale, cosH, sinH, half);
            const pB = worldToRotatedMap(route.target.x, route.target.z, scale, cosH, sinH, half);
            mapCtx.setLineDash([4, 3]);
            mapCtx.beginPath();
            mapCtx.moveTo(pA.x, pA.y);
            mapCtx.lineTo(pB.x, pB.y);
            mapCtx.strokeStyle = routeColor;
            mapCtx.lineWidth = 2.2;
            mapCtx.stroke();
            mapCtx.setLineDash([]);
          }
          mapCtx.restore();
        }

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
    const presVisible = hudVisible && rt.presentationMode;
    if (presVisible !== lastPresVisible) {
      lastPresVisible = presVisible;
      presBox.hidden = !presVisible;
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

      // A partir das 23:00: vinheta vermelha pulsando de leve + contagem grande nos últimos 60 s de jogo
      const isFinalHour = rt.mode === 'playing' && mission.status === 'playing' && mission.clockMinutes >= 23 * 60;
      if (isFinalHour) {
        const hourProg = Math.max(0, Math.min(1, (mission.clockMinutes - 23 * 60) / 60));
        const pulse = rt.settings.reduceMotion ? 0.5 : 0.5 + 0.5 * Math.sin(animPhase * (4.2 + hourProg * 4.8));
        const vOp = Math.round((0.18 + hourProg * 0.42 + pulse * 0.22) * 20) / 20;
        if (vOp !== lastVignetteOpacity) {
          lastVignetteOpacity = vOp;
          urgentVignette.hidden = false;
          urgentVignette.style.opacity = vOp.toFixed(2);
        }
        const remRealSec = Math.ceil(((1440 - mission.clockMinutes) / 1440) * rt.effectiveDaySeconds);
        const showCd = remRealSec >= 1 && remRealSec <= 60;
        const cdVal = showCd ? remRealSec : 0;
        if (cdVal !== lastCountdownSec) {
          lastCountdownSec = cdVal;
          countdownEl.hidden = !showCd;
          if (showCd) {
            countdownEl.textContent = String(cdVal);
            countdownEl.classList.remove('hud-countdown--pop');
            void countdownEl.offsetWidth;
            countdownEl.classList.add('hud-countdown--pop');
          }
        }
      } else {
        if (lastVignetteOpacity !== 0) {
          lastVignetteOpacity = 0;
          urgentVignette.hidden = true;
        }
        if (lastCountdownSec !== 0) {
          lastCountdownSec = 0;
          countdownEl.hidden = true;
        }
      }

      if (mission.score !== lastScore) {
        const gain = Number.isFinite(lastScore) ? mission.score - lastScore : 0;
        lastScore = mission.score;
        scoreBadge.textContent = `${mission.score.toLocaleString('pt-BR')} PTS`;
        if (gain > 0 && rt.mode === 'playing') {
          scorePop.textContent = `+${gain} PTS`;
          scorePop.hidden = false;
          scorePopTimer = 1.15;
          scorePop.classList.remove('hud-score-pop--show');
          void scorePop.offsetWidth;
          scorePop.classList.add('hud-score-pop--show');
        }
      }
      if (scorePopTimer > 0 && Number.isFinite(dt) && dt > 0) {
        scorePopTimer = Math.max(0, scorePopTimer - dt);
        if (scorePopTimer <= 0) scorePop.hidden = true;
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
          const route = getActiveRoute(state);
          const dist =
            route && route.deliveryId === next.id
              ? route.distance
              : Math.hypot(next.x - state.x, next.z - state.z);
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
