// Integration of JSBSim-derived fdm/model.ts (FGPropagate/FGAccelerations); LGPL-2.1, JSBSim-Team.
import {
  KEY_A, KEY_CONTROL, KEY_D, KEY_DOWN, KEY_E, KEY_LEFT, KEY_Q, KEY_R,
  KEY_RIGHT, KEY_S, KEY_SHIFT, KEY_UP, KEY_W, Quat, Vec3,
} from 'playcanvas';
import type { FlightContext, FlightModule } from './types';
import { SPAWN } from './types';
import { FIXED_STEP, FlightDynamics, type FlightControls } from './fdm/model';
import { INSTRUCTOR, MouseInstructor } from './fdm/instructor';

export function createFlightController({ app, world, plane, state }: FlightContext): FlightModule {
  const fdm = new FlightDynamics();
  const instructor = new MouseInstructor();
  const rotation = fdm.rotation;
  const turn = new Quat();
  const inverse = new Quat();
  const forward = new Vec3();
  const right = new Vec3();
  const up = new Vec3();
  const collisionPoint = new Vec3();
  const velocity = new Vec3();
  const input: FlightControls = { pitch: 0, roll: 0, yaw: 0, throttle: 0.6 };
  // Extremos do modelo em airplane.ts, incluindo as duas faces para voo invertido.
  const modelHitbox = plane.hitbox;
  const collisionPoints = (modelHitbox?.length ? modelHitbox : [
    [-5, -0.54, -1.41], [-5, -0.54, 0.21], [5, -0.54, -1.41], [5, -0.54, 0.21],
    [-5, -0.36, -1.41], [-5, -0.36, 0.21], [5, -0.36, -1.41], [5, -0.36, 0.21],
    [0, -1.15, -3.325], [0, 1.05, -3.325], [-1.1, -0.05, -3.325], [1.1, -0.05, -3.325],
    [-1.8, 0.14, 4.35], [1.8, 0.14, 4.35], [-1.8, 0.26, 4.35], [1.8, 0.26, 4.35],
    [-0.06, 1.7, 3.45], [0.06, 1.7, 3.45], [-0.06, 1.7, 4.45], [0.06, 1.7, 4.45],
    [0, -0.325, 4.3], [-1.2, -1.65, -0.7], [1.2, -1.65, -0.7], [0, -1.55, -2.5],
    [-0.575, -0.625, -2.5], [0.575, -0.625, -2.5],
    [-0.475, 1.025, -1.45], [0.475, 1.025, -1.45],
  ]).map(([x, y, z]) => new Vec3(x, y, z));
  const degrees = 180 / Math.PI;
  let crashTime = 0;
  let propAngle = 0;
  let returnDirection = 0;
  let accumulator = 0;

  function attitude() {
    rotation.transformVector(Vec3.FORWARD, forward);
    rotation.transformVector(Vec3.RIGHT, right);
    rotation.transformVector(Vec3.UP, up);
    state.pitch = Math.asin(Math.max(-1, Math.min(1, forward.y))) * degrees;
    if (Math.hypot(right.y, up.y) > 0.001) state.roll = Math.atan2(-right.y, up.y) * degrees;
    if (Math.hypot(forward.x, forward.z) > 0.001) {
      state.heading = (Math.atan2(forward.x, -forward.z) * degrees + 360) % 360;
    }
  }

  function publish() {
    attitude();
    state.x = fdm.position.x;
    state.y = fdm.position.y;
    state.z = fdm.position.z;
    state.speed = state.crashed ? 0 : fdm.speed;
    state.verticalSpeed = state.crashed ? 0 : fdm.worldVelocity.y;
    state.altitude = state.y;
    state.heightAboveGround = state.y - world.groundAt(state.x, state.z);
    state.throttle = fdm.controls.throttle;
    state.stall = !state.crashed && fdm.stalled;
    plane.root.setPosition(fdm.position);
    plane.root.setRotation(rotation);
  }

  function reset() {
    fdm.reset(SPAWN.x, SPAWN.y, SPAWN.z, SPAWN.heading, SPAWN.speed, 0.6);
    instructor.reset(SPAWN.heading);
    input.pitch = input.roll = input.yaw = 0;
    input.throttle = 0.6;
    state.crashed = false;
    crashTime = propAngle = returnDirection = accumulator = 0;
    plane.prop.setLocalEulerAngles(0, 0, 0);
    plane.root.enabled = true;
    publish();
  }

  function containWorld() {
    const pos = fdm.position;
    if (Math.abs(pos.x) > 2500 || Math.abs(pos.z) > 2500) {
      attitude();
      const target = Math.atan2(-pos.x, pos.z) * degrees;
      let error = ((target - state.heading + 540) % 360) - 180;
      if (Math.abs(error) > 170 && returnDirection) error = Math.abs(error) * returnDirection;
      returnDirection = Math.sign(error);
      const strength = Math.min(1, (Math.max(Math.abs(pos.x), Math.abs(pos.z)) - 2500) / 400);
      turn.setFromAxisAngle(Vec3.UP, -Math.max(-75, Math.min(75, error * 1.5)) * strength * FIXED_STEP);
      rotation.mul2(turn, rotation).normalize();
    } else {
      returnDirection = 0;
    }
    pos.x = Math.max(-2980, Math.min(2980, pos.x));
    pos.z = Math.max(-2980, Math.min(2980, pos.z));
    velocity.set(fdm.velocity.y, -fdm.velocity.z, -fdm.velocity.x);
    rotation.transformVector(velocity, fdm.worldVelocity);
    if (pos.y > 2500) {
      pos.y = 2500;
      fdm.worldVelocity.y = Math.min(0, fdm.worldVelocity.y);
      inverse.copy(rotation).invert().transformVector(fdm.worldVelocity, velocity);
      fdm.velocity.set(-velocity.z, velocity.x, -velocity.y);
    }
  }

  reset();
  return {
    update(dt) {
      if (app.keyboard?.wasPressed(KEY_R)) { reset(); return; }
      if (!Number.isFinite(dt) || dt <= 0) return;
      const duration = Math.min(dt, 0.25);
      if (state.crashed) {
        crashTime += duration;
        if (crashTime >= 2) reset();
        else publish();
        return;
      }
      const keyboard = app.keyboard;
      const pitchInput = Number(!!(keyboard?.isPressed(KEY_S) || keyboard?.isPressed(KEY_DOWN)))
        - Number(!!(keyboard?.isPressed(KEY_W) || keyboard?.isPressed(KEY_UP)));
      const rollInput = Number(!!(keyboard?.isPressed(KEY_D) || keyboard?.isPressed(KEY_RIGHT)))
        - Number(!!(keyboard?.isPressed(KEY_A) || keyboard?.isPressed(KEY_LEFT)));
      const yawInput = Number(!!keyboard?.isPressed(KEY_E)) - Number(!!keyboard?.isPressed(KEY_Q));
      const canvas = app.graphicsDevice?.canvas;
      const pointerLocked = !!canvas && typeof document !== 'undefined' && document.pointerLockElement === canvas;
      const throttleInput = Number(!!keyboard?.isPressed(KEY_SHIFT)) - Number(!!keyboard?.isPressed(KEY_CONTROL));
      input.throttle = Math.max(0, Math.min(1, input.throttle + throttleInput * 0.5 * duration));
      accumulator += duration;
      while (accumulator >= FIXED_STEP) {
        accumulator -= FIXED_STEP;
        if (state.controlMode === 'mouse' && pointerLocked) {
          instructor.steer(fdm, state.aimX, state.aimY, state.aimZ, input);
          input.pitch = Math.max(-1, Math.min(1, input.pitch + pitchInput * INSTRUCTOR.manualTrim));
          input.roll = Math.max(-1, Math.min(1, input.roll + rollInput * INSTRUCTOR.manualTrim));
          input.yaw = Math.max(-1, Math.min(1, input.yaw + yawInput * INSTRUCTOR.manualTrim));
        } else {
          input.pitch = pitchInput;
          input.roll = rollInput;
          input.yaw = yawInput;
        }
        fdm.step(input);
        containWorld();
        for (const point of collisionPoints) {
          rotation.transformVector(point, collisionPoint).add(fdm.position);
          if (collisionPoint.y <= world.groundAt(collisionPoint.x, collisionPoint.z)) {
            state.crashed = true;
            crashTime = accumulator;
            accumulator = 0;
            plane.root.enabled = false;
            break;
          }
        }
        if (state.crashed) break;
      }
      propAngle = (propAngle + fdm.controls.throttle * 2400 * duration) % 360;
      plane.prop.setLocalEulerAngles(0, 0, propAngle);
      publish();
    },
  };
}
