import { KEY_C, KEY_M, KEY_V, Quat, Vec3 } from 'playcanvas';
import { CAMERA_ORDER, type CameraMode, type FlightContext, type FlightModule, type FlightState } from './types';
import { consumeCameraSnap, getRuntime } from './ui/settings';

const FOV: Record<CameraMode, number> = {
  chase: 65,
  top: 60,
  cockpit: 75,
};

const CHASE_DISTANCE = 26;
const CHASE_HEIGHT = 7.2;
const CHASE_OFFSET = new Vec3(0, CHASE_HEIGHT, CHASE_DISTANCE);
// Posição dos olhos do piloto no assento dianteiro do A-29 (tandem)
const COCKPIT_OFFSET = new Vec3(0, 1.08, -1.05);
const TOP_HEIGHT = 180;
const CHASE_SMOOTH = 10;
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
  const dir = new Vec3();
  const fallbackUp = new Vec3();
  const blendedUp = new Vec3();
  const crossTmp = new Vec3();

  let activeMode: CameraMode = state.camera;
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

  const canvas = (app.graphicsDevice as { canvas?: HTMLCanvasElement } | undefined)?.canvas ?? null;

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
    if (destroyed || state.controlMode !== 'mouse' || getRuntime(state).mode !== 'playing') {
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
      state.controlMode !== 'mouse' ||
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
      state.controlMode !== 'mouse' ||
      state.crashed
    ) {
      return;
    }
    const { mouseSensitivity, invertY } = getRuntime(state).settings;
    const sens = Number.isFinite(mouseSensitivity) ? mouseSensitivity : MOUSE_SENSITIVITY;
    const ySign = invertY ? 1 : -1;
    aimYaw = ((aimYaw + e.movementX * sens) % 360 + 360) % 360;
    aimPitch = clamp(aimPitch + e.movementY * sens * ySign, -85, 85);
  }

  if (canvas) canvas.addEventListener('mousedown', onCanvasMouseDown);
  if (typeof document !== 'undefined') {
    document.addEventListener('mousemove', onDocumentMouseMove);
    document.addEventListener('pointerlockchange', onPointerLockChange);
    document.addEventListener('pointerlockerror', onPointerLockError);
  }

  function syncAimToPlaneForward() {
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

  function updateAimState() {
    if (state.controlMode === 'mouse' && isPointerLocked() && !state.crashed) {
      const yawRad = aimYaw * DEG_TO_RAD;
      const pitchRad = aimPitch * DEG_TO_RAD;
      const cosPitch = Math.cos(pitchRad);
      aimDir.set(Math.sin(yawRad) * cosPitch, Math.sin(pitchRad), -Math.cos(yawRad) * cosPitch);
    } else {
      syncAimToPlaneForward();
    }
    state.aimX = aimDir.x;
    state.aimY = aimDir.y;
    state.aimZ = aimDir.z;
  }

  function applyMode(mode: CameraMode) {
    activeMode = mode;
    state.camera = mode;
    if (camera.camera) camera.camera.fov = FOV[mode];
    const showExterior = mode !== 'cockpit';
    for (let i = 0; i < plane.exterior.length; i++) {
      const render = plane.exterior[i].render;
      if (render) render.enabled = showExterior;
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

    // Preserva continuidade do vetor superior perto da vertical:
    // ao olhar para cima (dir.y > 0), a projeção contínua de Vec3.UP aponta para -rumo;
    // ao olhar para baixo (dir.y < 0), aponta para +rumo.
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

  function updateChase(dt: number, snap: boolean) {
    const useMouseAim = state.controlMode === 'mouse';
    if (useMouseAim) {
      desiredPos.copy(aimDir).mulScalar(-CHASE_DISTANCE).add(planePos);
      desiredPos.y += CHASE_HEIGHT;
      lookTarget.copy(aimDir).mulScalar(AIM_LOOK_AHEAD).add(planePos);
    } else {
      planeRot.transformVector(CHASE_OFFSET, desiredPos).add(planePos);
      lookTarget.copy(planePos);
    }

    const minGroundY = world.groundAt(desiredPos.x, desiredPos.z) + 2.2;
    if (desiredPos.y < minGroundY) desiredPos.y = minGroundY;

    if (snap) {
      camPos.copy(desiredPos);
    } else {
      const alpha = 1 - Math.exp(-CHASE_SMOOTH * dt);
      camPos.copy(camera.getPosition()).lerp(camPos, desiredPos, alpha);
      const minCamY = world.groundAt(camPos.x, camPos.z) + 2.2;
      if (camPos.y < minCamY) camPos.y = minCamY;
    }
    camera.setPosition(camPos);
    safeLookAt(lookTarget, useMouseAim ? aimYaw : state.heading);
  }

  function updateTop(dt: number, snap: boolean) {
    desiredPos.set(planePos.x, planePos.y + TOP_HEIGHT, planePos.z);
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
    planeRot.transformVector(COCKPIT_OFFSET, desiredPos).add(planePos);
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
    if (activeMode === 'cockpit') {
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
  planeRot.copy(plane.root.getRotation());
  updateAimState();
  applyActiveMode(0, true);
  snapNext = false;

  return {
    update(dt: number) {
      if (destroyed) return;

      let modeSwitched = false;
      const keyboard = app.keyboard;
      if (keyboard?.wasPressed(KEY_C) || keyboard?.wasPressed(KEY_V)) {
        const nextIdx = (CAMERA_ORDER.indexOf(state.camera) + 1) % CAMERA_ORDER.length;
        applyMode(CAMERA_ORDER[nextIdx]);
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
        planeRot.copy(plane.root.getRotation());
        syncAimToPlaneForward();
        headYaw = 0;
        headPitch = 0;
        snapNext = true;
        modeSwitched = true;
      }

      if (keyboard?.wasPressed(KEY_M)) {
        state.controlMode = state.controlMode === 'mouse' ? 'keyboard' : 'mouse';
      }
      if (state.controlMode !== activeControl) {
        activeControl = state.controlMode;
        if (activeControl === 'keyboard') {
          releasePointerLock();
        } else {
          planeRot.copy(plane.root.getRotation());
          syncAimToPlaneForward();
        }
      } else if (state.controlMode === 'keyboard' && isPointerLocked()) {
        releasePointerLock();
      }

      planePos.set(state.x, state.y, state.z);
      planeRot.copy(plane.root.getRotation());

      if (state.crashed) {
        if (!wasCrashed) wasCrashed = true;
        updateAimState();
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
        syncAimToPlaneForward();
      } else if (lastPlanePos.distanceSq(planePos) > TELEPORT_DIST_SQ) {
        snapNext = true;
        syncAimToPlaneForward();
      }
      lastPlanePos.copy(planePos);

      updateAimState();
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
      }
    },
  };
}
