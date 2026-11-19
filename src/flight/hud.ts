import { CAMERA_LABEL, type CameraMode, type FlightContext, type FlightModule } from './types';

type AlertState = 'none' | 'stall' | 'crashed';

const FOOTER_TEXT =
  'W/S arfagem · A/D rolagem · Q/E leme · Shift/Ctrl acelerador · C câmera · R reiniciar';

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

export function createHud({ state }: FlightContext): FlightModule {
  const ui = document.getElementById('ui');
  if (!ui) return { update() {} };

  const root = el('div', 'hud-root');

  // Canto superior esquerdo: telemetria e câmera
  const panel = el('div', 'hud-telemetry');

  const cameraBadge = el('div', 'hud-camera');
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
  panel.append(cameraBadge, metricsGroup);

  // Aviso central (estol / impacto)
  const alertBox = el('div', 'hud-alert');
  alertBox.hidden = true;

  // Rodapé de atalhos
  const footer = el('div', 'hud-footer', FOOTER_TEXT);

  root.append(panel, alertBox, footer);
  ui.append(root);

  let lastSpeedKmh = Number.NaN;
  let lastAltM = Number.NaN;
  let lastThrottlePct = Number.NaN;
  let lastCamera: CameraMode | null = null;
  let lastCockpit: boolean | null = null;
  let lastAlert: AlertState = 'none';

  function sync() {
    const isCockpit = state.camera === 'cockpit';
    if (isCockpit !== lastCockpit) {
      lastCockpit = isCockpit;
      metricsGroup.hidden = isCockpit;
      panel.classList.toggle('hud-telemetry--compact', isCockpit);
    }

    if (state.camera !== lastCamera) {
      lastCamera = state.camera;
      cameraBadge.textContent = CAMERA_LABEL[state.camera];
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
