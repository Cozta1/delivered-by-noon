import { KEY_C, KEY_M, KEY_V, Quat, Vec3 } from 'playcanvas';
import { CAMERA_ORDER, type CameraMode, type FlightContext, type FlightModule, type FlightState } from './types';

const FOV: Record<CameraMode, number> = {
  chase: 65,
  top: 60,
  cockpit: 75,
};

const CHASE_OFFSET = new Vec3(0, 6, 22);
const COCKPIT_OFFSET = new Vec3(0, 0.9, -0.3);
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

  let activeMode: CameraMode = state.camera;
  let activeControl: FlightState['controlMode'] = state.controlMode;
  let wasCrashed = state.crashed;
  let snapNext = true;

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

  function onCanvasMouseDown(e: MouseEvent) {
    if (e.button !== 0 || state.controlMode !== 'mouse' || !canvas || isPointerLocked()) return;
    try {
      const result = canvas.requestPointerLock?.() as Promise<void> | undefined;
      result?.catch?.(() => {});
    } catch {
      // Ignora rejeição em ambientes sem suporte a pointer lock
    }
  }

  function onDocumentMouseMove(e: MouseEvent) {
    if (!isPointerLocked() || state.controlMode !== 'mouse' || state.crashed) return;
    aimYaw = ((aimYaw + e.movementX * MOUSE_SENSITIVITY) % 360 + 360) % 360;
    aimPitch = clamp(aimPitch - e.movementY * MOUSE_SENSITIVITY, -85, 85);
  }

  if (canvas) canvas.addEventListener('mousedown', onCanvasMouseDown);
  if (typeof document !== 'undefined') document.addEventListener('mousemove', onDocumentMouseMove);

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
    if (Math.abs(dir.y) > len * 0.985) {
      camera.lookAt(target, computeHeadingUp(headingDeg, fallbackUp));
    } else {
      camera.lookAt(target, Vec3.UP);
    }
  }

  function updateChase(dt: number, snap: boolean) {
    const useMouseAim = state.controlMode === 'mouse';
    if (useMouseAim) {
      desiredPos.copy(aimDir).mulScalar(-22).add(planePos);
      desiredPos.y += 6;
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
      const relYaw = Math.atan2(localAim.x, -localAim.z) * RAD_TO_DEG;
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
      if (canvas) canvas.removeEventListener('mousedown', onCanvasMouseDown);
      if (typeof document !== 'undefined') document.removeEventListener('mousemove', onDocumentMouseMove);
      releasePointerLock();
    },
  };
}
