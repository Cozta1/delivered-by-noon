import { type Entity, Quat, Vec3 } from 'playcanvas';
import { isSmokeActive } from './smoke';
import {
  CAMERA_LABEL,
  type CameraMode,
  type FlightContext,
  type FlightModule,
  type FlightState,
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
  a29: 'A-29',
  heli: 'HELI',
};

const NEARBY_LABEL: Record<Exclude<VehicleKind, 'foot'>, string> = {
  car: 'carro',
  a29: 'A-29',
  heli: 'helicóptero',
};

const FOOTER_BY_VEHICLE: Record<VehicleKind, string> = {
  foot: 'W/A/S/D andar · Espaço pular · Mouse gira câmera · E entrar em veículo · C câmera · Esc/P pausa',
  car: 'W/S acelerar/ré · A/D virar · Espaço freio de mão · Mouse olha ao redor · E sair · C câmera · R reiniciar · Esc/P pausa',
  a29: 'Mouse mira · M mouse/teclado · W/S arfagem · A/D rolagem · Q/E leme · Shift/Ctrl acel · F fumaça · E sair · C câmera · Esc/P pausa',
  heli: 'W/S inclinar · A/D lateral · Q/E girar · Shift/Ctrl coletivo · Mouse mira · E sair · C câmera · R reiniciar · Esc/P pausa',
};

const PROJECTION_DIST = 500;
const HELIPAD_POS = cityData().helipad;

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

function estimateCarGear(speedMs: number, throttle: number): { label: string; rpmRatio: number } {
  const kmh = Math.abs(speedMs) * 3.6;
  if (speedMs < -0.6) return { label: 'R', rpmRatio: Math.min(1, 0.25 + kmh / 45) };
  if (kmh < 2 && throttle < 0.05) return { label: 'N', rpmRatio: 0.14 };
  const bands = [26, 54, 86, 122, 168];
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
  const ratio = Math.max(0.18, Math.min(1, (kmh - low) / Math.max(12, high - low) * 0.78 + throttle * 0.22));
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

export function createHud({ app, plane, camera, state }: FlightContext, uiRoot?: HTMLElement | null): FlightModule {
  const ui = uiRoot ?? document.getElementById('ui');
  if (!ui) return { update() {} };

  const root = el('div', 'hud-root');

  // Camada de mira e cruz do nariz (somente aeronaves no modo mouse)
  const reticlesLayer = el('div', 'hud-reticles');
  const aimRing = el('div', 'hud-aim-ring');
  aimRing.hidden = true;
  const noseCross = el('div', 'hud-nose-cross');
  noseCross.hidden = true;
  reticlesLayer.append(aimRing, noseCross);

  // Canto superior esquerdo: telemetria, veículo, câmera e modo
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

  // Velocímetro automotivo (carro)
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
  carDash.append(carSpeedLine, carRpmTrack);

  panel.append(badgesRow, lockHint, metricsGroup, carDash);

  // Canto superior direito: Minimapa 2D
  const minimapWrap = el('div', 'hud-minimap');
  const minimapCanvas = document.createElement('canvas');
  minimapCanvas.className = 'hud-minimap-canvas';
  minimapCanvas.width = 168;
  minimapCanvas.height = 168;
  const minimapTag = el('div', 'hud-minimap-tag', 'MAPA');
  minimapWrap.append(minimapCanvas, minimapTag);
  const mapCtx = minimapCanvas.getContext('2d');

  // Aviso de proximidade para entrar em veículo ("E — entrar no <veículo>")
  const nearbyPrompt = el('div', 'hud-nearby');
  nearbyPrompt.hidden = true;

  // Aviso central (estol / impacto)
  const alertBox = el('div', 'hud-alert');
  alertBox.hidden = true;

  // Rodapé de atalhos
  const footer = el('div', 'hud-footer', FOOTER_BY_VEHICLE.car);

  root.append(reticlesLayer, panel, minimapWrap, nearbyPrompt, alertBox, footer);
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
  let lastCamera: CameraMode | null = null;
  let lastVehicle: VehicleKind | null = null;
  let lastControl: FlightState['controlMode'] | null = null;
  let lastLocked: boolean | null = null;
  let lastSmoke: boolean | null = null;
  let lastCockpit: boolean | null = null;
  let lastHudVisible: boolean | null = null;
  let lastNearbyKey = '';
  let lastAlert: AlertState = 'none';
  let minimapFrame = 0;

  function drawMinimap() {
    if (!mapCtx) return;
    const size = 168;
    const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
    const targetPx = Math.round(size * dpr);
    if (minimapCanvas.width !== targetPx || minimapCanvas.height !== targetPx) {
      minimapCanvas.width = targetPx;
      minimapCanvas.height = targetPx;
    }

    mapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const half = size * 0.5;
    const range = state.vehicle === 'foot' || state.vehicle === 'car' ? 580 : 1200;
    const scale = half / range;
    const toX = (wx: number) => half + (wx - state.x) * scale;
    const toY = (wz: number) => half + (wz - state.z) * scale;

    // Fundo terreno
    mapCtx.fillStyle = '#152522';
    mapCtx.fillRect(0, 0, size, size);

    // Mar ao sul (z > 540)
    const seaY = toY(540);
    if (seaY < size) {
      mapCtx.fillStyle = '#123446';
      mapCtx.fillRect(0, Math.max(0, seaY), size, size - Math.max(0, seaY));
    }

    // Cidade (grade de quarteirões)
    const cx0 = toX(CITY.x0);
    const cx1 = toX(CITY.x1);
    const cz0 = toY(CITY.z0);
    const cz1 = toY(CITY.z1);
    mapCtx.fillStyle = 'rgba(130, 152, 168, 0.24)';
    mapCtx.fillRect(cx0, cz0, cx1 - cx0, cz1 - cz0);
    mapCtx.strokeStyle = 'rgba(180, 204, 218, 0.25)';
    mapCtx.lineWidth = 1;
    mapCtx.strokeRect(cx0, cz0, cx1 - cx0, cz1 - cz0);

    // Pista de pouso real (AIRPORT, orientada Norte-Sul)
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

    // Heliponto real no centro da cidade
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

    // Veículos estacionados / na cena (escaneados a cada ~10 quadros para leveza)
    if (minimapFrame % 10 === 0) {
      scanSceneVehicles(app.root, blips);
    }
    minimapFrame++;

    for (let i = 0; i < blips.length; i++) {
      const b = blips[i];
      // Evita desenhar ponto duplicado exatamente sob o jogador
      if (Math.hypot(b.x - state.x, b.z - state.z) < 4) continue;
      const bx = toX(b.x);
      const by = toY(b.z);
      if (bx < 4 || bx > size - 4 || by < 4 || by > size - 4) continue;
      mapCtx.fillStyle = b.kind === 'a29' ? '#60a5fa' : b.kind === 'heli' ? '#3dd6bd' : '#ff9e4a';
      mapCtx.beginPath();
      mapCtx.arc(bx, by, b.kind === 'car' ? 2.8 : 3.6, 0, Math.PI * 2);
      mapCtx.fill();
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

  function sync() {
    const rt = getRuntime(state);
    const hudVisible = rt.mode !== 'title' && rt.settings.showHud;
    if (hudVisible !== lastHudVisible) {
      lastHudVisible = hudVisible;
      root.hidden = !hudVisible;
    }
    if (!hudVisible) return;

    const vehicle = state.vehicle;
    const isAircraft = vehicle === 'a29' || vehicle === 'heli';
    const isCockpit = isAircraft && state.camera === 'cockpit';

    if (vehicle !== lastVehicle || isCockpit !== lastCockpit) {
      lastVehicle = vehicle;
      lastCockpit = isCockpit;
      vehicleBadge.textContent = VEHICLE_BADGE[vehicle];
      vehicleBadge.className = `hud-vehicle hud-vehicle--${vehicle}`;
      footer.textContent = FOOTER_BY_VEHICLE[vehicle];

      metricsGroup.hidden = !isAircraft || isCockpit;
      carDash.hidden = vehicle !== 'car';
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

    // Velocímetro de carro
    if (vehicle === 'car') {
      const kmh = Math.round(Math.abs(state.speed) * 3.6);
      if (kmh !== lastCarSpeed) {
        lastCarSpeed = kmh;
        carSpeedVal.textContent = String(kmh);
      }
      const { label, rpmRatio } = estimateCarGear(state.speed, state.throttle);
      if (label !== lastCarGear) {
        lastCarGear = label;
        carGear.textContent = label;
      }
      carRpmFill.style.transform = `scaleX(${rpmRatio.toFixed(3)})`;
    }

    // Aviso de veículo próximo ("E — entrar no <veículo>")
    const nearbyKey =
      rt.mode === 'playing' && state.nearbyVehicleId && state.nearbyVehicleKind
        ? `${state.nearbyVehicleId}:${state.nearbyVehicleKind}`
        : '';
    if (nearbyKey !== lastNearbyKey) {
      lastNearbyKey = nearbyKey;
      if (!nearbyKey || !state.nearbyVehicleKind) {
        nearbyPrompt.hidden = true;
      } else {
        nearbyPrompt.textContent = `E — entrar no ${NEARBY_LABEL[state.nearbyVehicleKind]}`;
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

  sync();

  return {
    update() {
      sync();
    },
    destroy() {
      root.remove();
    },
  };
}
