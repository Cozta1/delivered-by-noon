import { KEY_C, KEY_V, Quat, Vec3 } from 'playcanvas';
import { CAMERA_ORDER, type CameraMode, type FlightContext, type FlightModule } from './types';

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
const TELEPORT_DIST_SQ = 100 * 100;

export function createCameraRig({ app, world, plane, camera, state }: FlightContext): FlightModule {
  const planePos = new Vec3();
  const lastPlanePos = new Vec3(state.x, state.y, state.z);
  const planeRot = new Quat();
  const camPos = new Vec3();
  const desiredPos = new Vec3();
  const camRot = new Quat();
  const targetRot = new Quat();
  const yawRot = new Quat();
  const pitchRot = new Quat();
  const dir = new Vec3();
  const fallbackUp = new Vec3();

  let activeMode: CameraMode = state.camera;
  let wasCrashed = state.crashed;
  let snapNext = true;

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
    const rad = (headingDeg * Math.PI) / 180;
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
    planeRot.transformVector(CHASE_OFFSET, desiredPos).add(planePos);
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
    safeLookAt(planePos, state.heading);
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

  function updateCockpit() {
    planeRot.transformVector(COCKPIT_OFFSET, desiredPos).add(planePos);
    camera.setPosition(desiredPos);
    camera.setRotation(planeRot);
  }

  function applyActiveMode(dt: number, snap: boolean) {
    if (activeMode === 'cockpit') {
      updateCockpit();
    } else if (activeMode === 'top') {
      updateTop(dt, snap);
    } else {
      updateChase(dt, snap);
    }
  }

  // Inicializa câmera, FOV e visibilidade externa no quadro zero.
  applyMode(state.camera);
  planePos.set(state.x, state.y, state.z);
  planeRot.copy(plane.root.getRotation());
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

      planePos.set(state.x, state.y, state.z);
      planeRot.copy(plane.root.getRotation());

      if (state.crashed) {
        if (!wasCrashed) wasCrashed = true;
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
      } else if (lastPlanePos.distanceSq(planePos) > TELEPORT_DIST_SQ) {
        snapNext = true;
      }
      lastPlanePos.copy(planePos);

      applyActiveMode(dt, snapNext);
      snapNext = false;
    },
  };
}
