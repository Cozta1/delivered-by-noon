import { Quat, Vec3 } from 'playcanvas';
import { isSmokeActive } from './smoke';
import { CAMERA_LABEL, type CameraMode, type FlightContext, type FlightModule, type FlightState } from './types';
import { getRuntime } from './ui/settings';

type AlertState = 'none' | 'stall' | 'crashed';

interface MarkerCache {
  visible: boolean;
  x: number;
  y: number;
}

const FOOTER_TEXT =
  'Mouse mira · Clique trava · M mouse/teclado · W/S arfagem · A/D rolagem · Q/E leme · Shift/Ctrl acel · F fumaça · C câmera · R reiniciar · Esc/P pausa';
const PROJECTION_DIST = 500;

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

export function createHud({ app, plane, camera, state }: FlightContext, uiRoot?: HTMLElement | null): FlightModule {
  const ui = uiRoot ?? document.getElementById('ui');
  if (!ui) return { update() {} };

  const root = el('div', 'hud-root');

  // Camada de mira e cruz do nariz (recortada acima do painel quando em cabine)
  const reticlesLayer = el('div', 'hud-reticles');
  const aimRing = el('div', 'hud-aim-ring');
  aimRing.hidden = true;
  const noseCross = el('div', 'hud-nose-cross');
  noseCross.hidden = true;
  reticlesLayer.append(aimRing, noseCross);

  // Canto superior esquerdo: telemetria, câmera, controle e fumaça
  const panel = el('div', 'hud-telemetry');
  const badgesRow = el('div', 'hud-badges');
  const cameraBadge = el('div', 'hud-camera');
  const controlBadge = el('div', 'hud-control');
  const smokeBadge = el('div', 'hud-smoke');
  badgesRow.append(cameraBadge, controlBadge, smokeBadge);

  const lockHint = el('div', 'hud-lock-hint', 'Clique no canvas para mirar');

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
  panel.append(badgesRow, lockHint, metricsGroup);

  // Aviso central (estol / impacto)
  const alertBox = el('div', 'hud-alert');
  alertBox.hidden = true;

  // Rodapé de atalhos
  const footer = el('div', 'hud-footer', FOOTER_TEXT);

  root.append(reticlesLayer, panel, alertBox, footer);
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

  const aimCache: MarkerCache = { visible: false, x: Number.NaN, y: Number.NaN };
  const noseCache: MarkerCache = { visible: false, x: Number.NaN, y: Number.NaN };

  let lastSpeedKmh = Number.NaN;
  let lastAltM = Number.NaN;
  let lastThrottlePct = Number.NaN;
  let lastCamera: CameraMode | null = null;
  let lastControl: FlightState['controlMode'] | null = null;
  let lastLocked: boolean | null = null;
  let lastSmoke: boolean | null = null;
  let lastCockpit: boolean | null = null;
  let lastHudVisible: boolean | null = null;
  let lastAlert: AlertState = 'none';

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

    const isCockpit = state.camera === 'cockpit';
    if (isCockpit !== lastCockpit) {
      lastCockpit = isCockpit;
      metricsGroup.hidden = isCockpit;
      panel.classList.toggle('hud-telemetry--compact', isCockpit);
      reticlesLayer.classList.toggle('hud-reticles--cockpit', isCockpit);
    }

    if (state.camera !== lastCamera) {
      lastCamera = state.camera;
      cameraBadge.textContent = CAMERA_LABEL[state.camera];
    }

    const locked = typeof document !== 'undefined' && canvas !== null && document.pointerLockElement === canvas;
    if (state.controlMode !== lastControl || locked !== lastLocked) {
      lastControl = state.controlMode;
      lastLocked = locked;
      const isMouse = state.controlMode === 'mouse';
      controlBadge.textContent = isMouse ? 'MOUSE' : 'TECLADO';
      controlBadge.className = `hud-control ${isMouse ? 'hud-control--mouse' : 'hud-control--keyboard'}`;
      lockHint.hidden = !isMouse || locked;
      aimRing.classList.toggle('hud-aim-ring--unlocked', isMouse && !locked);
    }

    const smokeOn = isSmokeActive(state);
    if (smokeOn !== lastSmoke) {
      lastSmoke = smokeOn;
      smokeBadge.textContent = smokeOn ? 'FUMAÇA ON' : 'FUMAÇA OFF';
      smokeBadge.className = `hud-smoke ${smokeOn ? 'hud-smoke--on' : 'hud-smoke--off'}`;
    }

    if (!isCockpit) {
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

    const showReticles = rt.mode === 'playing' && state.controlMode === 'mouse' && !state.crashed;
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

    const alert: AlertState = state.crashed ? 'crashed' : state.stall ? 'stall' : 'none';
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
