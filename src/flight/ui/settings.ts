import type { FlightState } from '../types';

export type GameMode = 'title' | 'playing' | 'paused' | 'ended';
export type QualityLevel = 'low' | 'medium' | 'high';

export interface GameSettings {
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  mouseSensitivity: number;
  invertY: boolean;
  defaultControlMode: 'mouse' | 'keyboard';
  quality: QualityLevel;
  showHud: boolean;
  showFps: boolean;
}

export const DEFAULT_SETTINGS: Readonly<GameSettings> = {
  masterVolume: 0.75,
  musicVolume: 0.45,
  sfxVolume: 0.8,
  mouseSensitivity: 0.15,
  invertY: false,
  defaultControlMode: 'mouse',
  quality: 'high',
  showHud: true,
  showFps: false,
};

const STORAGE_KEY = 'horizonte-dourado:settings:v1';

function clamp(v: number, min: number, max: number) {
  return v < min ? min : v > max ? max : v;
}

export function sanitizeSettings(raw: Partial<GameSettings> | null | undefined): GameSettings {
  const s = raw ?? {};
  const num = (val: unknown, def: number, min: number, max: number) =>
    typeof val === 'number' && Number.isFinite(val) ? clamp(val, min, max) : def;
  const quality: QualityLevel =
    s.quality === 'low' || s.quality === 'medium' || s.quality === 'high' ? s.quality : DEFAULT_SETTINGS.quality;
  const defaultControlMode: 'mouse' | 'keyboard' =
    s.defaultControlMode === 'keyboard' || s.defaultControlMode === 'mouse'
      ? s.defaultControlMode
      : DEFAULT_SETTINGS.defaultControlMode;

  return {
    masterVolume: num(s.masterVolume, DEFAULT_SETTINGS.masterVolume, 0, 1),
    musicVolume: num(s.musicVolume, DEFAULT_SETTINGS.musicVolume, 0, 1),
    sfxVolume: num(s.sfxVolume, DEFAULT_SETTINGS.sfxVolume, 0, 1),
    mouseSensitivity: num(s.mouseSensitivity, DEFAULT_SETTINGS.mouseSensitivity, 0.04, 0.45),
    invertY: typeof s.invertY === 'boolean' ? s.invertY : DEFAULT_SETTINGS.invertY,
    defaultControlMode,
    quality,
    showHud: typeof s.showHud === 'boolean' ? s.showHud : DEFAULT_SETTINGS.showHud,
    showFps: typeof s.showFps === 'boolean' ? s.showFps : DEFAULT_SETTINGS.showFps,
  };
}

export function loadSettings(): GameSettings {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_SETTINGS };
    const text = localStorage.getItem(STORAGE_KEY);
    if (!text) return { ...DEFAULT_SETTINGS };
    return sanitizeSettings(JSON.parse(text) as Partial<GameSettings>);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: GameSettings): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeSettings(settings)));
  } catch {
    // Ignora erros de quota ou storage bloqueado
  }
}

export interface FlightRuntime {
  mode: GameMode;
  settings: GameSettings;
  cameraSnap: boolean;
  presentationMode: boolean;
}

const runtimeByState = new WeakMap<FlightState, FlightRuntime>();
const FALLBACK_RUNTIME: FlightRuntime = {
  mode: 'playing',
  settings: { ...DEFAULT_SETTINGS },
  cameraSnap: false,
  presentationMode: false,
};

export function initRuntime(state: FlightState, settings: GameSettings, mode: GameMode = 'title'): FlightRuntime {
  const rt: FlightRuntime = {
    mode,
    settings: sanitizeSettings(settings),
    cameraSnap: false,
    presentationMode: false,
  };
  runtimeByState.set(state, rt);
  return rt;
}

export function getRuntime(state: FlightState): FlightRuntime {
  return runtimeByState.get(state) ?? FALLBACK_RUNTIME;
}

export function setRuntimeMode(state: FlightState, mode: GameMode): void {
  const rt = runtimeByState.get(state);
  if (rt) rt.mode = mode;
}

export function setRuntimeSettings(state: FlightState, settings: GameSettings): void {
  const rt = runtimeByState.get(state);
  if (rt) rt.settings = sanitizeSettings(settings);
}

export function setRuntimePresentationMode(state: FlightState, enabled: boolean): void {
  const rt = runtimeByState.get(state);
  if (rt) rt.presentationMode = enabled;
}

export function requestCameraSnap(state: FlightState): void {
  const rt = runtimeByState.get(state);
  if (rt) rt.cameraSnap = true;
}

export function consumeCameraSnap(state: FlightState): boolean {
  const rt = runtimeByState.get(state);
  if (!rt || !rt.cameraSnap) return false;
  rt.cameraSnap = false;
  return true;
}

export function clearRuntime(state: FlightState): void {
  runtimeByState.delete(state);
}
