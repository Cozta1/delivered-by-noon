import {
  ADDRESS_CLAMP_TO_EDGE,
  Color,
  type Entity,
  PIXELFORMAT_SRGBA8,
  StandardMaterial,
  Texture,
} from 'playcanvas';
import type { FlightContext, FlightModule } from './types';

interface SkyKeyframe {
  hour: number;
  zenith: [number, number, number];
  upper: [number, number, number];
  mid: [number, number, number];
  horizon: [number, number, number];
  below: [number, number, number];
  nadir: [number, number, number];
  sunColor: [number, number, number];
  sunIntensity: number;
  ambient: [number, number, number];
  fog: [number, number, number];
  night: number;
}

const KEYFRAMES: readonly SkyKeyframe[] = [
  {
    hour: 0,
    zenith: [0.02, 0.03, 0.09],
    upper: [0.04, 0.07, 0.16],
    mid: [0.07, 0.11, 0.24],
    horizon: [0.1, 0.14, 0.26],
    below: [0.06, 0.08, 0.16],
    nadir: [0.02, 0.03, 0.07],
    sunColor: [0.38, 0.54, 0.85],
    sunIntensity: 0.3,
    ambient: [0.13, 0.16, 0.26],
    fog: [0.08, 0.11, 0.21],
    night: 1.0,
  },
  {
    hour: 4.5,
    zenith: [0.04, 0.06, 0.16],
    upper: [0.08, 0.1, 0.24],
    mid: [0.16, 0.15, 0.3],
    horizon: [0.24, 0.2, 0.35],
    below: [0.11, 0.11, 0.2],
    nadir: [0.04, 0.04, 0.09],
    sunColor: [0.55, 0.58, 0.82],
    sunIntensity: 0.38,
    ambient: [0.17, 0.18, 0.29],
    fog: [0.16, 0.16, 0.28],
    night: 0.88,
  },
  {
    hour: 6,
    zenith: [0.12, 0.2, 0.42],
    upper: [0.32, 0.29, 0.48],
    mid: [0.76, 0.44, 0.46],
    horizon: [0.98, 0.68, 0.46],
    below: [0.72, 0.56, 0.48],
    nadir: [0.18, 0.22, 0.34],
    sunColor: [1.0, 0.74, 0.5],
    sunIntensity: 1.25,
    ambient: [0.42, 0.37, 0.44],
    fog: [0.85, 0.62, 0.48],
    night: 0.25,
  },
  {
    hour: 8,
    zenith: [0.14, 0.42, 0.78],
    upper: [0.3, 0.58, 0.88],
    mid: [0.55, 0.77, 0.94],
    horizon: [0.78, 0.88, 0.95],
    below: [0.62, 0.72, 0.8],
    nadir: [0.24, 0.34, 0.48],
    sunColor: [1.0, 0.95, 0.86],
    sunIntensity: 1.85,
    ambient: [0.58, 0.62, 0.68],
    fog: [0.76, 0.85, 0.92],
    night: 0.0,
  },
  {
    hour: 12,
    zenith: [0.1, 0.36, 0.76],
    upper: [0.24, 0.56, 0.9],
    mid: [0.5, 0.78, 0.96],
    horizon: [0.76, 0.89, 0.97],
    below: [0.58, 0.72, 0.82],
    nadir: [0.22, 0.34, 0.48],
    sunColor: [1.0, 0.98, 0.93],
    sunIntensity: 2.05,
    ambient: [0.64, 0.68, 0.74],
    fog: [0.74, 0.86, 0.94],
    night: 0.0,
  },
  {
    hour: 16,
    zenith: [0.14, 0.36, 0.7],
    upper: [0.34, 0.54, 0.82],
    mid: [0.66, 0.74, 0.84],
    horizon: [0.92, 0.8, 0.64],
    below: [0.68, 0.62, 0.56],
    nadir: [0.24, 0.3, 0.42],
    sunColor: [1.0, 0.9, 0.74],
    sunIntensity: 1.85,
    ambient: [0.58, 0.56, 0.58],
    fog: [0.88, 0.77, 0.64],
    night: 0.0,
  },
  {
    hour: 18,
    zenith: [0.12, 0.13, 0.28],
    upper: [0.31, 0.23, 0.43],
    mid: [0.78, 0.41, 0.41],
    horizon: [0.98, 0.72, 0.55],
    below: [0.78, 0.6, 0.53],
    nadir: [0.23, 0.27, 0.41],
    sunColor: [1.0, 0.76, 0.52],
    sunIntensity: 1.55,
    ambient: [0.52, 0.44, 0.5],
    fog: [0.92, 0.68, 0.54],
    night: 0.3,
  },
  {
    hour: 19.75,
    zenith: [0.05, 0.06, 0.16],
    upper: [0.14, 0.12, 0.26],
    mid: [0.29, 0.19, 0.32],
    horizon: [0.36, 0.23, 0.34],
    below: [0.16, 0.14, 0.24],
    nadir: [0.05, 0.06, 0.12],
    sunColor: [0.58, 0.5, 0.72],
    sunIntensity: 0.48,
    ambient: [0.2, 0.2, 0.32],
    fog: [0.24, 0.19, 0.3],
    night: 0.85,
  },
  {
    hour: 21.5,
    zenith: [0.02, 0.03, 0.1],
    upper: [0.05, 0.07, 0.17],
    mid: [0.08, 0.11, 0.24],
    horizon: [0.11, 0.14, 0.26],
    below: [0.06, 0.08, 0.16],
    nadir: [0.02, 0.03, 0.07],
    sunColor: [0.38, 0.54, 0.85],
    sunIntensity: 0.32,
    ambient: [0.14, 0.16, 0.26],
    fog: [0.09, 0.11, 0.22],
    night: 1.0,
  },
  {
    hour: 24,
    zenith: [0.02, 0.03, 0.09],
    upper: [0.04, 0.07, 0.16],
    mid: [0.07, 0.11, 0.24],
    horizon: [0.1, 0.14, 0.26],
    below: [0.06, 0.08, 0.16],
    nadir: [0.02, 0.03, 0.07],
    sunColor: [0.38, 0.54, 0.85],
    sunIntensity: 0.3,
    ambient: [0.13, 0.16, 0.26],
    fog: [0.08, 0.11, 0.21],
    night: 1.0,
  },
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpRgb(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
  out: [number, number, number],
): [number, number, number] {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

function rgbCss(c: [number, number, number]): string {
  const r = Math.round(Math.max(0, Math.min(1, c[0])) * 255);
  const g = Math.round(Math.max(0, Math.min(1, c[1])) * 255);
  const b = Math.round(Math.max(0, Math.min(1, c[2])) * 255);
  return `rgb(${r},${g},${b})`;
}

function collectMaterials(entity: Entity, out: StandardMaterial[]): void {
  const pushMeshMats = (instances: ReadonlyArray<{ material?: unknown }> | null | undefined) => {
    if (!instances) return;
    for (let i = 0; i < instances.length; i++) {
      const m = instances[i]?.material;
      if (m instanceof StandardMaterial && !out.includes(m)) out.push(m);
    }
  };
  pushMeshMats(entity.render?.meshInstances);
  pushMeshMats(entity.model?.meshInstances);
  for (let i = 0; i < entity.children.length; i++) {
    collectMaterials(entity.children[i] as Entity, out);
  }
}

function collectByName(root: Entity, exactName: string, out: Entity[]): void {
  if (root.name === exactName) out.push(root);
  for (let i = 0; i < root.children.length; i++) {
    collectByName(root.children[i] as Entity, exactName, out);
  }
}

function findCityMaterials(root: Entity, out: StandardMaterial[]): void {
  const stack: Entity[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const lower = cur.name.toLowerCase();
    if (lower === 'city' || lower.includes('mundo-cidade')) {
      collectMaterials(cur, out);
    }
    for (let i = cur.children.length - 1; i >= 0; i--) {
      stack.push(cur.children[i] as Entity);
    }
  }
}

export function sampleDayNight(clockMinutes: number) {
  const wrapped = ((clockMinutes % 1440) + 1440) % 1440;
  const hour = wrapped / 60;

  let lo = KEYFRAMES[0];
  let hi = KEYFRAMES[KEYFRAMES.length - 1];
  for (let i = 0; i < KEYFRAMES.length - 1; i++) {
    if (hour >= KEYFRAMES[i].hour && hour <= KEYFRAMES[i + 1].hour) {
      lo = KEYFRAMES[i];
      hi = KEYFRAMES[i + 1];
      break;
    }
  }
  const span = Math.max(0.001, hi.hour - lo.hour);
  const rawT = Math.max(0, Math.min(1, (hour - lo.hour) / span));
  const t = rawT * rawT * (3 - 2 * rawT);

  const zenith: [number, number, number] = [0, 0, 0];
  const upper: [number, number, number] = [0, 0, 0];
  const mid: [number, number, number] = [0, 0, 0];
  const horizon: [number, number, number] = [0, 0, 0];
  const below: [number, number, number] = [0, 0, 0];
  const nadir: [number, number, number] = [0, 0, 0];
  const sunColor: [number, number, number] = [0, 0, 0];
  const ambient: [number, number, number] = [0, 0, 0];
  const fog: [number, number, number] = [0, 0, 0];

  lerpRgb(lo.zenith, hi.zenith, t, zenith);
  lerpRgb(lo.upper, hi.upper, t, upper);
  lerpRgb(lo.mid, hi.mid, t, mid);
  lerpRgb(lo.horizon, hi.horizon, t, horizon);
  lerpRgb(lo.below, hi.below, t, below);
  lerpRgb(lo.nadir, hi.nadir, t, nadir);
  lerpRgb(lo.sunColor, hi.sunColor, t, sunColor);
  lerpRgb(lo.ambient, hi.ambient, t, ambient);
  lerpRgb(lo.fog, hi.fog, t, fog);

  return {
    hour,
    zenith,
    upper,
    mid,
    horizon,
    below,
    nadir,
    sunColor,
    sunIntensity: lerp(lo.sunIntensity, hi.sunIntensity, t),
    ambient,
    fog,
    night: lerp(lo.night, hi.night, t),
  };
}

/**
 * Ciclo de dia e noite dirigido por `ctx.mission.clockMinutes`:
 * atualiza degradê do céu (`world.sky`), sol, luz ambiente, névoa, janelas da cidade e faróis dos carros.
 */
export function createDayNight(ctx: FlightContext, sun: Entity): FlightModule {
  const { app, world, camera } = ctx;

  const prevSunColor = sun.light ? sun.light.color.clone() : null;
  const prevSunIntensity = sun.light ? sun.light.intensity : 1.7;
  const prevSunEuler = sun.getEulerAngles().clone();

  // Textura de degradê do céu atualizada dinamicamente (4x64: custo quase zero)
  let skyCanvas: HTMLCanvasElement | null = null;
  let sky2d: CanvasRenderingContext2D | null = null;
  let skyTex: Texture | null = null;
  const skyMats: StandardMaterial[] = [];
  const savedSkyMaps = new Map<StandardMaterial, Texture | null>();
  const savedSkyEmissive = new Map<StandardMaterial, Color>();

  if (typeof document !== 'undefined' && app.graphicsDevice) {
    skyCanvas = document.createElement('canvas');
    skyCanvas.width = 4;
    skyCanvas.height = 64;
    sky2d = skyCanvas.getContext('2d');
    if (sky2d) {
      skyTex = new Texture(app.graphicsDevice, {
        width: 4,
        height: 64,
        format: PIXELFORMAT_SRGBA8,
        mipmaps: false,
        addressU: ADDRESS_CLAMP_TO_EDGE,
        addressV: ADDRESS_CLAMP_TO_EDGE,
      });
      skyTex.setSource(skyCanvas);
    }
  }

  collectMaterials(world.sky, skyMats);
  if (skyTex) {
    for (const mat of skyMats) {
      savedSkyMaps.set(mat, mat.emissiveMap);
      savedSkyEmissive.set(mat, mat.emissive.clone());
      mat.emissiveMap = skyTex;
      mat.emissive.set(1, 1, 1);
      mat.update();
    }
  }

  // Materiais emissivos da cidade (janelas brilham mais à noite)
  const cityMats: StandardMaterial[] = [];
  const savedCityEmissive = new Map<StandardMaterial, number>();
  findCityMaterials(app.root, cityMats);
  for (const mat of cityMats) {
    if (mat.emissiveMap) {
      savedCityEmissive.set(mat, mat.emissiveIntensity);
    }
  }

  const headlights: Entity[] = [];
  let headlightScanTimer = 0;
  let lastAppliedMinute = Number.NaN;
  let lastHeadlightsOn: boolean | null = null;
  let destroyed = false;

  function refreshHeadlights(forceOn: boolean) {
    headlights.length = 0;
    collectByName(app.root, 'CarHeadlights', headlights);
    for (let i = 0; i < headlights.length; i++) {
      headlights[i].enabled = forceOn;
    }
  }

  function applyClock(clockMinutes: number, force = false) {
    const wrapped = ((clockMinutes % 1440) + 1440) % 1440;
    if (!force && Number.isFinite(lastAppliedMinute) && Math.abs(wrapped - lastAppliedMinute) < 0.75) {
      return;
    }
    lastAppliedMinute = wrapped;

    const s = sampleDayNight(wrapped);

    // 1) Degradê do céu
    if (sky2d && skyCanvas && skyTex) {
      const grad = sky2d.createLinearGradient(0, 0, 0, skyCanvas.height);
      grad.addColorStop(0.0, rgbCss(s.zenith));
      grad.addColorStop(0.24, rgbCss(s.upper));
      grad.addColorStop(0.42, rgbCss(s.mid));
      grad.addColorStop(0.5, rgbCss(s.horizon));
      grad.addColorStop(0.58, rgbCss(s.below));
      grad.addColorStop(1.0, rgbCss(s.nadir));
      sky2d.fillStyle = grad;
      sky2d.fillRect(0, 0, skyCanvas.width, skyCanvas.height);
      skyTex.upload();
    }

    // 2) Sol / Lua direcional (sem novas sombras)
    if (sun.light) {
      sun.light.color.set(s.sunColor[0], s.sunColor[1], s.sunColor[2]);
      sun.light.intensity = s.sunIntensity;
    }
    if (s.hour >= 5.5 && s.hour <= 19.0) {
      const dayFrac = Math.max(0, Math.min(1, (s.hour - 5.5) / 13.5));
      const elev = 12 + Math.sin(dayFrac * Math.PI) * 64;
      const yaw = 80 + dayFrac * 180;
      sun.setEulerAngles(elev, yaw, 0);
    } else {
      // Ângulo suave da lua à noite para manter silhuetas legíveis
      const nightFrac = s.hour > 19.0 ? (s.hour - 19.0) / 10.5 : (s.hour + 5.0) / 10.5;
      const moonElev = 24 + Math.sin(nightFrac * Math.PI) * 32;
      sun.setEulerAngles(moonElev, 210 + nightFrac * 70, 0);
    }

    // 3) Luz ambiente, névoa e cor de fundo da câmera
    app.scene.ambientLight.set(s.ambient[0], s.ambient[1], s.ambient[2]);
    app.scene.fog.color.set(s.fog[0], s.fog[1], s.fog[2]);
    if (camera.camera) {
      camera.camera.clearColor.set(s.fog[0], s.fog[1], s.fog[2], 1);
    }

    // 4) Janelas emissivas da cidade destacam-se à noite
    const cityGlow = lerp(0.45, 2.35, s.night);
    for (const mat of savedCityEmissive.keys()) {
      mat.emissiveIntensity = cityGlow;
      mat.update();
    }

    // 5) Faróis nos carros à noite
    const headlightsOn = s.night >= 0.35;
    if (headlightsOn !== lastHeadlightsOn || force) {
      lastHeadlightsOn = headlightsOn;
      refreshHeadlights(headlightsOn);
    }
  }

  applyClock(ctx.mission?.clockMinutes ?? 0, true);

  return {
    update(dt: number) {
      if (destroyed) return;
      const clockMinutes = ctx.mission?.clockMinutes ?? 0;
      applyClock(clockMinutes, false);

      // Revarre faróis periodicamente caso carros tenham sido recriados (ex.: reinício)
      headlightScanTimer += dt;
      if (headlightScanTimer >= 1.0) {
        headlightScanTimer = 0;
        if (lastHeadlightsOn !== null) {
          refreshHeadlights(lastHeadlightsOn);
        }
      }
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;

      for (const [mat, prevMap] of savedSkyMaps) {
        mat.emissiveMap = prevMap;
        const prevEm = savedSkyEmissive.get(mat);
        if (prevEm) mat.emissive.copy(prevEm);
        mat.update();
      }
      savedSkyMaps.clear();
      savedSkyEmissive.clear();

      for (const [mat, prevIntensity] of savedCityEmissive) {
        mat.emissiveIntensity = prevIntensity;
        mat.update();
      }
      savedCityEmissive.clear();

      if (sun.parent) {
        sun.setEulerAngles(prevSunEuler);
        if (sun.light && prevSunColor) {
          sun.light.color.copy(prevSunColor);
          sun.light.intensity = prevSunIntensity;
        }
      }

      skyTex?.destroy();
      skyTex = null;
      skyCanvas = null;
      sky2d = null;
    },
  };
}
