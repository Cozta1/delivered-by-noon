import { KEY_C, KEY_M, KEY_V, Quat, Vec3 } from 'playcanvas';
import {
  type CameraMode,
  type FlightContext,
  type FlightModule,
  type FlightState,
  type VehicleKind,
} from './types';
import { consumeCameraSnap, getRuntime } from './ui/settings';

const FOV: Record<CameraMode, number> = {
  chase: 65,
  top: 60,
  cockpit: 75,
};

const VEHICLE_CAMERAS: Record<VehicleKind, readonly CameraMode[]> = {
  foot: ['chase', 'top'],
  car: ['chase', 'top'],
  tuned: ['chase', 'top'],
  a29: ['chase', 'top', 'cockpit'],
  heli: ['chase', 'top', 'cockpit'],
};

const A29_CHASE_DISTANCE = 26;
const A29_CHASE_HEIGHT = 7.2;
const A29_CHASE_OFFSET = new Vec3(0, A29_CHASE_HEIGHT, A29_CHASE_DISTANCE);
const A29_COCKPIT_OFFSET = new Vec3(0, 1.08, -1.05);

const HELI_CHASE_DISTANCE = 18;
const HELI_CHASE_HEIGHT = 5.6;
const HELI_CHASE_OFFSET = new Vec3(0, HELI_CHASE_HEIGHT, HELI_CHASE_DISTANCE);
const HELI_COCKPIT_OFFSET = new Vec3(0, 1.68, -1.65);

const CAR_CHASE_DISTANCE = 8.4;
const CAR_CHASE_HEIGHT = 2.85;
const CAR_TOP_HEIGHT = 85;

const FOOT_CHASE_DISTANCE = 3.9;
const FOOT_SHOULDER_HEIGHT = 1.56;
const FOOT_SHOULDER_RIGHT = 0.62;
const FOOT_TOP_HEIGHT = 55;

const TOP_HEIGHT = 180;
const CHASE_SMOOTH = 10;
const CAR_SMOOTH = 12;
const FOOT_SMOOTH = 16;
const TOP_SMOOTH = 8;
const HEAD_SMOOTH = 12;
const TELEPORT_DIST_SQ = 100 * 100;
const MOUSE_SENSITIVITY = 0.15;
const AIM_LOOK_AHEAD = 120;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

function clamp(v: number, min: number, max: number) {
  return v < min ? min : v > max ? max : v;
}

function shortestAngleDiff(fromDeg: number, toDeg: number): number {
  return ((toDeg - fromDeg + 540) % 360) - 180;
}

export function createCameraRig({ app, world, plane, camera, state }: FlightContext): FlightModule {
  const planePos = new Vec3();
  const lastPlanePos = new Vec3(state.x, state.y, state.z);
  const planeRot = new Quat();
  const invPlaneRot = new Quat();
  const planeForward = new Vec3();
  const aimDir = new Vec3(0, 0, -1);
  const localAim = new Vec3();
  const lookTarget = new Vec3();
  const camPos = new Vec3();
  const desiredPos = new Vec3();
  const camRot = new Quat();
  const targetRot = new Quat();
  const headRot = new Quat();
  const yawRot = new Quat();
  const pitchRot = new Quat();
  const rollRot = new Quat();
  const dir = new Vec3();
  const fallbackUp = new Vec3();
  const blendedUp = new Vec3();
  const crossTmp = new Vec3();

  let activeMode: CameraMode = state.camera;
  let activeVehicle: VehicleKind = state.vehicle;
  let activeControl: FlightState['controlMode'] = state.controlMode;
  let wasCrashed = state.crashed;
  let snapNext = true;
  let destroyed = false;
  let pendingLockRequests = 0;
  let awaitingLegacyLock = false;

  let aimYaw = state.heading;
  let aimPitch = state.pitch;
  let headYaw = 0;
  let headPitch = 0;
  let carOrbitIdle = 99;

  const canvas = (app.graphicsDevice as { canvas?: HTMLCanvasElement } | undefined)?.canvas ?? null;

  function isAircraft(kind: VehicleKind) {
    return kind === 'a29' || kind === 'heli';
  }

  function isCar(kind: VehicleKind) {
    return kind === 'car' || kind === 'tuned';
  }

  function allowsMouseLook() {
    return state.vehicle === 'foot' || isCar(state.vehicle) || state.controlMode === 'mouse';
  }

  function isPointerLocked() {
    return typeof document !== 'undefined' && canvas !== null && document.pointerLockElement === canvas;
  }

  function releasePointerLock() {
    if (typeof document !== 'undefined' && document.pointerLockElement === canvas) {
      document.exitPointerLock?.();
    }
  }

  function detachTransitionListenersIfDone() {
    if (!destroyed) return;
    if (pendingLockRequests === 0 && !awaitingLegacyLock && !isPointerLocked()) {
      if (typeof document !== 'undefined') {
        document.removeEventListener('pointerlockchange', onPointerLockChange);
        document.removeEventListener('pointerlockerror', onPointerLockError);
      }
    }
  }

  function validatePointerLock() {
    if (destroyed || !allowsMouseLook() || getRuntime(state).mode !== 'playing') {
      releasePointerLock();
    }
  }

  function onPointerLockChange() {
    awaitingLegacyLock = false;
    validatePointerLock();
    detachTransitionListenersIfDone();
  }

  function onPointerLockError() {
    awaitingLegacyLock = false;
    detachTransitionListenersIfDone();
  }

  function onCanvasMouseDown(e: MouseEvent) {
    if (
      destroyed ||
      e.button !== 0 ||
      getRuntime(state).mode !== 'playing' ||
      !allowsMouseLook() ||
      !canvas ||
      isPointerLocked()
    ) {
      return;
    }
    const requestLock = (canvas as { requestPointerLock?: () => Promise<void> | void }).requestPointerLock;
    if (typeof requestLock !== 'function') return;
    try {
      const result = requestLock.call(canvas);
      if (result && typeof result.then === 'function') {
        pendingLockRequests++;
        result.then(
          () => {
            pendingLockRequests = Math.max(0, pendingLockRequests - 1);
            validatePointerLock();
            detachTransitionListenersIfDone();
          },
          () => {
            pendingLockRequests = Math.max(0, pendingLockRequests - 1);
            detachTransitionListenersIfDone();
          },
        );
      } else {
        awaitingLegacyLock = true;
        validatePointerLock();
      }
    } catch {
      // Ignora rejeição em ambientes sem suporte a pointer lock
    }
  }

  function onDocumentMouseMove(e: MouseEvent) {
    if (
      destroyed ||
      getRuntime(state).mode !== 'playing' ||
      !isPointerLocked() ||
      !allowsMouseLook() ||
      state.crashed
    ) {
      return;
    }
    const { mouseSensitivity, invertY } = getRuntime(state).settings;
    const sens = Number.isFinite(mouseSensitivity) ? mouseSensitivity : MOUSE_SENSITIVITY;
    const ySign = invertY ? 1 : -1;
    const pitchMin = state.vehicle === 'foot' ? -45 : isCar(state.vehicle) ? -25 : -85;
    const pitchMax = state.vehicle === 'foot' ? 60 : isCar(state.vehicle) ? 35 : 85;
    aimYaw = ((aimYaw + e.movementX * sens) % 360 + 360) % 360;
    aimPitch = clamp(aimPitch + e.movementY * sens * ySign, pitchMin, pitchMax);
    if (isCar(state.vehicle) && (Math.abs(e.movementX) > 0 || Math.abs(e.movementY) > 0)) {
      carOrbitIdle = 0;
    }
  }

  if (canvas) canvas.addEventListener('mousedown', onCanvasMouseDown);
  if (typeof document !== 'undefined') {
    document.addEventListener('mousemove', onDocumentMouseMove);
    document.addEventListener('pointerlockchange', onPointerLockChange);
    document.addEventListener('pointerlockerror', onPointerLockError);
  }

  function readVehicleRotation(out: Quat) {
    if (state.vehicle === 'a29') {
      out.copy(plane.root.getRotation());
      return;
    }
    yawRot.setFromAxisAngle(Vec3.UP, -state.heading);
    pitchRot.setFromAxisAngle(Vec3.RIGHT, state.pitch);
    rollRot.setFromAxisAngle(Vec3.BACK, -state.roll);
    out.mul2(yawRot, pitchRot);
    out.mul(rollRot);
  }

  function syncAimToVehicleForward() {
    if (state.vehicle === 'foot' || isCar(state.vehicle)) {
      aimYaw = ((state.heading % 360) + 360) % 360;
      aimPitch = state.vehicle === 'foot' ? -6 : -4;
      const yawRad = aimYaw * DEG_TO_RAD;
      const pitchRad = aimPitch * DEG_TO_RAD;
      const cosPitch = Math.cos(pitchRad);
      aimDir.set(Math.sin(yawRad) * cosPitch, Math.sin(pitchRad), -Math.cos(yawRad) * cosPitch);
      return;
    }

    planeRot.transformVector(Vec3.FORWARD, planeForward);
    const len = planeForward.length();
    if (len > 0.0001) planeForward.mulScalar(1 / len);
    else planeForward.set(0, 0, -1);

    aimDir.copy(planeForward);
    aimPitch = clamp(Math.asin(clamp(planeForward.y, -1, 1)) * RAD_TO_DEG, -85, 85);
    if (Math.hypot(planeForward.x, planeForward.z) > 0.001) {
      aimYaw = (Math.atan2(planeForward.x, -planeForward.z) * RAD_TO_DEG + 360) % 360;
    }
  }

  function updateAimState(dt: number) {
    if (isCar(state.vehicle)) {
      carOrbitIdle += dt;
      // Quando o carro dirige sem mexer o mouse por ~1.4 s, a câmera realinha suavemente atrás do carro
      if (!isPointerLocked() || (carOrbitIdle > 1.4 && Math.abs(state.speed) > 1.5)) {
        const alpha = 1 - Math.exp(-4.5 * Math.max(dt, 0.001));
        aimYaw = ((aimYaw + shortestAngleDiff(aimYaw, state.heading) * alpha) % 360 + 360) % 360;
        aimPitch += (-4 - aimPitch) * alpha;
      }
      const yawRad = aimYaw * DEG_TO_RAD;
      const pitchRad = aimPitch * DEG_TO_RAD;
      const cosPitch = Math.cos(pitchRad);
      aimDir.set(Math.sin(yawRad) * cosPitch, Math.sin(pitchRad), -Math.cos(yawRad) * cosPitch);
    } else if (state.vehicle === 'foot') {
      if (!isPointerLocked()) {
        aimYaw = ((state.heading % 360) + 360) % 360;
      }
      const yawRad = aimYaw * DEG_TO_RAD;
      const pitchRad = aimPitch * DEG_TO_RAD;
      const cosPitch = Math.cos(pitchRad);
      aimDir.set(Math.sin(yawRad) * cosPitch, Math.sin(pitchRad), -Math.cos(yawRad) * cosPitch);
    } else if (state.controlMode === 'mouse' && isPointerLocked() && !state.crashed) {
      const yawRad = aimYaw * DEG_TO_RAD;
      const pitchRad = aimPitch * DEG_TO_RAD;
      const cosPitch = Math.cos(pitchRad);
      aimDir.set(Math.sin(yawRad) * cosPitch, Math.sin(pitchRad), -Math.cos(yawRad) * cosPitch);
    } else {
      syncAimToVehicleForward();
    }

    state.aimX = aimDir.x;
    state.aimY = aimDir.y;
    state.aimZ = aimDir.z;
  }

  function applyMode(mode: CameraMode) {
    const allowed = VEHICLE_CAMERAS[state.vehicle] ?? VEHICLE_CAMERAS.a29;
    const resolved: CameraMode = allowed.includes(mode) ? mode : allowed[0];
    activeMode = resolved;
    state.camera = resolved;
    if (camera.camera) camera.camera.fov = FOV[resolved];
    const showExterior = resolved !== 'cockpit' || !isAircraft(state.vehicle);
    for (let i = 0; i < plane.exterior.length; i++) {
      const render = plane.exterior[i].render;
      if (render) render.enabled = showExterior;
      const modelComp = plane.exterior[i].model;
      if (modelComp) modelComp.enabled = showExterior;
    }
  }

  function computeHeadingUp(headingDeg: number, out: Vec3) {
    const rad = headingDeg * DEG_TO_RAD;
    out.set(Math.sin(rad), 0, -Math.cos(rad));
    return out;
  }

  function safeLookAt(target: Vec3, headingDeg: number) {
    dir.sub2(target, camera.getPosition());
    const len = dir.length();
    if (len < 0.01) return;
    dir.mulScalar(1 / len);

    const absY = Math.abs(dir.y);
    if (absY <= 0.94) {
      camera.lookAt(target, Vec3.UP);
      return;
    }

    // Preserva continuidade do vetor superior perto da vertical (evita inversão 180°)
    const t = clamp((absY - 0.94) / 0.05, 0, 1);
    computeHeadingUp(headingDeg, fallbackUp);
    if (dir.y > 0) fallbackUp.mulScalar(-1);

    blendedUp.set(fallbackUp.x * t, 1 - t, fallbackUp.z * t);
    crossTmp.cross(dir, blendedUp);
    if (crossTmp.lengthSq() < 1e-6) {
      const rad = headingDeg * DEG_TO_RAD;
      blendedUp.set(Math.cos(rad), 0, Math.sin(rad));
    } else {
      blendedUp.normalize();
    }
    camera.lookAt(target, blendedUp);
  }

  function surfaceFloorAt(x: number, z: number, ceiling: number): number {
    return world.surfaceAt ? world.surfaceAt(x, z, ceiling) : world.groundAt(x, z);
  }

  function updateFootChase(dt: number, snap: boolean) {
    // Terceira pessoa por cima do ombro direito; mouse gira a câmera livremente
    const yawRad = aimYaw * DEG_TO_RAD;
    const rightX = Math.cos(yawRad);
    const rightZ = Math.sin(yawRad);
    const anchorX = planePos.x + rightX * FOOT_SHOULDER_RIGHT;
    const anchorY = planePos.y + FOOT_SHOULDER_HEIGHT;
    const anchorZ = planePos.z + rightZ * FOOT_SHOULDER_RIGHT;

    desiredPos.set(
      anchorX - aimDir.x * FOOT_CHASE_DISTANCE,
      anchorY - aimDir.y * FOOT_CHASE_DISTANCE,
      anchorZ - aimDir.z * FOOT_CHASE_DISTANCE,
    );
    const ceiling = Math.max(planePos.y + 2.2, desiredPos.y + 0.6);
    const minGroundY = surfaceFloorAt(desiredPos.x, desiredPos.z, ceiling) + 0.55;
    if (desiredPos.y < minGroundY) desiredPos.y = minGroundY;

    if (snap) {
      camPos.copy(desiredPos);
    } else {
      const alpha = 1 - Math.exp(-FOOT_SMOOTH * dt);
      camPos.copy(camera.getPosition()).lerp(camPos, desiredPos, alpha);
      const minCamY = surfaceFloorAt(camPos.x, camPos.z, Math.max(planePos.y + 2.2, camPos.y + 0.6)) + 0.55;
      if (camPos.y < minCamY) camPos.y = minCamY;
    }
    camera.setPosition(camPos);
    lookTarget.set(anchorX + aimDir.x * 35, anchorY + aimDir.y * 35, anchorZ + aimDir.z * 35);
    safeLookAt(lookTarget, aimYaw);
  }

  function updateCarChase(dt: number, snap: boolean) {
    // Chase baixa automotiva: segue o rumo do carro ou órbita do mouse
    const yawRad = aimYaw * DEG_TO_RAD;
    const pitchRad = aimPitch * DEG_TO_RAD;
    const backX = -Math.sin(yawRad) * Math.cos(pitchRad);
    const backZ = Math.cos(yawRad) * Math.cos(pitchRad);

    desiredPos.set(
      planePos.x + backX * CAR_CHASE_DISTANCE,
      planePos.y + CAR_CHASE_HEIGHT - Math.sin(pitchRad) * CAR_CHASE_DISTANCE * 0.55,
      planePos.z + backZ * CAR_CHASE_DISTANCE,
    );
    const ceiling = Math.max(planePos.y + 3.5, desiredPos.y + 0.8);
    const minGroundY = surfaceFloorAt(desiredPos.x, desiredPos.z, ceiling) + 0.9;
    if (desiredPos.y < minGroundY) desiredPos.y = minGroundY;

    if (snap) {
      camPos.copy(desiredPos);
    } else {
      const alpha = 1 - Math.exp(-CAR_SMOOTH * dt);
      camPos.copy(camera.getPosition()).lerp(camPos, desiredPos, alpha);
      const minCamY = surfaceFloorAt(camPos.x, camPos.z, Math.max(planePos.y + 3.5, camPos.y + 0.8)) + 0.9;
      if (camPos.y < minCamY) camPos.y = minCamY;
    }
    camera.setPosition(camPos);
    lookTarget.set(planePos.x, planePos.y + 1.45, planePos.z);
    safeLookAt(lookTarget, aimYaw);
    if (camera.camera) {
      const targetFov =
        state.vehicle === 'tuned'
          ? FOV.chase + clamp((Math.abs(state.speed) - 26) / 36, 0, 1) * 11
          : FOV.chase;
      camera.camera.fov = snap ? targetFov : camera.camera.fov + (targetFov - camera.camera.fov) * (1 - Math.exp(-8 * dt));
    }
  }

  function updateAircraftChase(dt: number, snap: boolean) {
    const isHeli = state.vehicle === 'heli';
    const chaseDist = isHeli ? HELI_CHASE_DISTANCE : A29_CHASE_DISTANCE;
    const chaseHeight = isHeli ? HELI_CHASE_HEIGHT : A29_CHASE_HEIGHT;
    const chaseOffset = isHeli ? HELI_CHASE_OFFSET : A29_CHASE_OFFSET;

    const useMouseAim = state.controlMode === 'mouse';
    if (useMouseAim) {
      desiredPos.copy(aimDir).mulScalar(-chaseDist).add(planePos);
      desiredPos.y += chaseHeight;
      lookTarget.copy(aimDir).mulScalar(AIM_LOOK_AHEAD).add(planePos);
    } else {
      planeRot.transformVector(chaseOffset, desiredPos).add(planePos);
      lookTarget.copy(planePos);
    }

    const ceiling = Math.max(planePos.y + 4.5, desiredPos.y + 1.0);
    const minGroundY = surfaceFloorAt(desiredPos.x, desiredPos.z, ceiling) + 2.2;
    if (desiredPos.y < minGroundY) desiredPos.y = minGroundY;

    if (snap) {
      camPos.copy(desiredPos);
    } else {
      const alpha = 1 - Math.exp(-CHASE_SMOOTH * dt);
      camPos.copy(camera.getPosition()).lerp(camPos, desiredPos, alpha);
      const minCamY = surfaceFloorAt(camPos.x, camPos.z, Math.max(planePos.y + 4.5, camPos.y + 1.0)) + 2.2;
      if (camPos.y < minCamY) camPos.y = minCamY;
    }
    camera.setPosition(camPos);
    safeLookAt(lookTarget, useMouseAim ? aimYaw : state.heading);
  }

  function updateChase(dt: number, snap: boolean) {
    if (state.vehicle === 'foot') {
      updateFootChase(dt, snap);
    } else if (isCar(state.vehicle)) {
      updateCarChase(dt, snap);
    } else {
      updateAircraftChase(dt, snap);
    }
  }

  function updateTop(dt: number, snap: boolean) {
    const topHeight =
      state.vehicle === 'foot' ? FOOT_TOP_HEIGHT : isCar(state.vehicle) ? CAR_TOP_HEIGHT : TOP_HEIGHT;
    desiredPos.set(planePos.x, planePos.y + topHeight, planePos.z);
    yawRot.setFromAxisAngle(Vec3.UP, -state.heading);
    pitchRot.setFromAxisAngle(Vec3.RIGHT, -90);
    targetRot.mul2(yawRot, pitchRot);

    if (snap) {
      camPos.copy(desiredPos);
      camRot.copy(targetRot);
    } else {
      const alpha = 1 - Math.exp(-TOP_SMOOTH * dt);
      camPos.copy(camera.getPosition()).lerp(camPos, desiredPos, alpha);
      camRot.copy(camera.getRotation()).slerp(camRot, targetRot, alpha);
    }
    camera.setPosition(camPos);
    camera.setRotation(camRot);
  }

  function updateCockpit(dt: number, snap: boolean) {
    const offset = state.vehicle === 'heli' ? HELI_COCKPIT_OFFSET : A29_COCKPIT_OFFSET;
    planeRot.transformVector(offset, desiredPos).add(planePos);
    camera.setPosition(desiredPos);

    let targetHeadYaw = 0;
    let targetHeadPitch = 0;
    if (state.controlMode === 'mouse' && isPointerLocked()) {
      invPlaneRot.copy(planeRot).invert();
      invPlaneRot.transformVector(aimDir, localAim);
      // Usa asin(localAim.x) para evitar o salto ±180° do atan2 quando a mira cruza atrás da cauda
      const relYaw = Math.asin(clamp(localAim.x, -1, 1)) * RAD_TO_DEG;
      const relPitch = Math.asin(clamp(localAim.y, -1, 1)) * RAD_TO_DEG;
      targetHeadYaw = clamp(relYaw * 0.45, -26, 26);
      targetHeadPitch = clamp(relPitch * 0.45, -18, 18);
    }

    if (snap) {
      headYaw = targetHeadYaw;
      headPitch = targetHeadPitch;
    } else {
      const alpha = 1 - Math.exp(-HEAD_SMOOTH * dt);
      headYaw += (targetHeadYaw - headYaw) * alpha;
      headPitch += (targetHeadPitch - headPitch) * alpha;
    }

    if (Math.abs(headYaw) > 0.01 || Math.abs(headPitch) > 0.01) {
      yawRot.setFromAxisAngle(Vec3.UP, -headYaw);
      pitchRot.setFromAxisAngle(Vec3.RIGHT, headPitch);
      headRot.mul2(yawRot, pitchRot);
      targetRot.mul2(planeRot, headRot);
      camera.setRotation(targetRot);
    } else {
      camera.setRotation(planeRot);
    }
  }

  function applyActiveMode(dt: number, snap: boolean) {
    if (activeMode === 'cockpit' && isAircraft(state.vehicle)) {
      updateCockpit(dt, snap);
    } else if (activeMode === 'top') {
      updateTop(dt, snap);
    } else {
      updateChase(dt, snap);
    }
  }

  // Inicializa câmera, mira, FOV e visibilidade externa no quadro zero.
  applyMode(state.camera);
  planePos.set(state.x, state.y, state.z);
  readVehicleRotation(planeRot);
  syncAimToVehicleForward();
  updateAimState(0);
  applyActiveMode(0, true);
  snapNext = false;

  return {
    update(dt: number) {
      if (destroyed) return;

      let modeSwitched = false;
      const keyboard = app.keyboard;

      // Detecta troca de veículo (entrar/sair de carro, helicóptero, A-29 ou a pé)
      if (state.vehicle !== activeVehicle) {
        activeVehicle = state.vehicle;
        applyMode(state.camera);
        planePos.set(state.x, state.y, state.z);
        readVehicleRotation(planeRot);
        syncAimToVehicleForward();
        headYaw = 0;
        headPitch = 0;
        carOrbitIdle = 99;
        snapNext = true;
        modeSwitched = true;
      }

      if (keyboard?.wasPressed(KEY_C) || keyboard?.wasPressed(KEY_V)) {
        const order = VEHICLE_CAMERAS[state.vehicle] ?? VEHICLE_CAMERAS.a29;
        const idx = order.indexOf(state.camera);
        const nextMode = order[(idx + 1) % order.length];
        applyMode(nextMode);
        snapNext = true;
        modeSwitched = true;
      } else if (state.camera !== activeMode) {
        applyMode(state.camera);
        snapNext = true;
        modeSwitched = true;
      }

      if (consumeCameraSnap(state)) {
        applyMode(state.camera);
        planePos.set(state.x, state.y, state.z);
        readVehicleRotation(planeRot);
        syncAimToVehicleForward();
        headYaw = 0;
        headPitch = 0;
        carOrbitIdle = 99;
        snapNext = true;
        modeSwitched = true;
      }

      if (isAircraft(state.vehicle) && keyboard?.wasPressed(KEY_M)) {
        state.controlMode = state.controlMode === 'mouse' ? 'keyboard' : 'mouse';
      }
      if (state.controlMode !== activeControl) {
        activeControl = state.controlMode;
        if (!allowsMouseLook()) {
          releasePointerLock();
        } else {
          readVehicleRotation(planeRot);
          syncAimToVehicleForward();
        }
      } else if (!allowsMouseLook() && isPointerLocked()) {
        releasePointerLock();
      }

      planePos.set(state.x, state.y, state.z);
      readVehicleRotation(planeRot);

      if (state.crashed) {
        if (!wasCrashed) wasCrashed = true;
        updateAimState(dt);
        if (modeSwitched) {
          applyActiveMode(dt, true);
        } else if (activeMode !== 'cockpit') {
          safeLookAt(planePos, state.heading);
        }
        snapNext = false;
        lastPlanePos.copy(planePos);
        return;
      }

      if (wasCrashed) {
        wasCrashed = false;
        snapNext = true;
        syncAimToVehicleForward();
      } else if (lastPlanePos.distanceSq(planePos) > TELEPORT_DIST_SQ) {
        snapNext = true;
        syncAimToVehicleForward();
      }
      lastPlanePos.copy(planePos);

      updateAimState(dt);
      applyActiveMode(dt, snapNext);
      snapNext = false;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (canvas) canvas.removeEventListener('mousedown', onCanvasMouseDown);
      if (typeof document !== 'undefined') {
        document.removeEventListener('mousemove', onDocumentMouseMove);
      }
      releasePointerLock();
      detachTransitionListenersIfDone();
      for (let i = 0; i < plane.exterior.length; i++) {
        const render = plane.exterior[i].render;
        if (render) render.enabled = true;
        const modelComp = plane.exterior[i].model;
        if (modelComp) modelComp.enabled = true;
      }
    },
  };
}
