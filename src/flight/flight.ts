import {
  KEY_A, KEY_CONTROL, KEY_D, KEY_DOWN, KEY_E, KEY_LEFT, KEY_Q, KEY_R,
  KEY_RIGHT, KEY_S, KEY_SHIFT, KEY_UP, KEY_W, Quat, Vec3,
} from 'playcanvas';
import type { FlightContext, FlightModule } from './types';
import { SPAWN } from './types';

export function createFlightController({ app, world, plane, state }: FlightContext): FlightModule {
  const rotation = new Quat();
  const turn = new Quat();
  const forward = new Vec3();
  const right = new Vec3();
  const up = new Vec3();
  const angularVelocity = new Vec3();
  const collisionPoint = new Vec3();
  // Extremos do modelo em airplane.ts, incluindo as duas faces para voo invertido.
  const collisionPoints = [
    [-5, -0.54, -1.41], [-5, -0.54, 0.21], [5, -0.54, -1.41], [5, -0.54, 0.21],
    [-5, -0.36, -1.41], [-5, -0.36, 0.21], [5, -0.36, -1.41], [5, -0.36, 0.21],
    [0, -1.15, -3.325], [0, 1.05, -3.325], [-1.1, -0.05, -3.325], [1.1, -0.05, -3.325],
    [-1.8, 0.14, 4.35], [1.8, 0.14, 4.35], [-1.8, 0.26, 4.35], [1.8, 0.26, 4.35],
    [-0.06, 1.7, 3.45], [0.06, 1.7, 3.45], [-0.06, 1.7, 4.45], [0.06, 1.7, 4.45],
    [0, -0.325, 4.3], [-1.2, -1.65, -0.7], [1.2, -1.65, -0.7], [0, -1.55, -2.5],
    [-0.575, -0.625, -2.5], [0.575, -0.625, -2.5],
    [-0.475, 1.025, -1.45], [0.475, 1.025, -1.45],
  ].map(([x, y, z]) => new Vec3(x, y, z));
  const degrees = 180 / Math.PI;
  let crashTime = 0;
  let propAngle = 0;
  let returnDirection = 0;

  function attitude() {
    rotation.transformVector(Vec3.FORWARD, forward);
    rotation.transformVector(Vec3.RIGHT, right);
    rotation.transformVector(Vec3.UP, up);
    state.pitch = Math.asin(Math.max(-1, Math.min(1, forward.y))) * degrees;
    if (Math.hypot(right.y, up.y) > 0.001) {
      state.roll = Math.atan2(-right.y, up.y) * degrees;
    }
    if (Math.hypot(forward.x, forward.z) > 0.001) {
      state.heading = (Math.atan2(forward.x, -forward.z) * degrees + 360) % 360;
    }
  }

  function publish() {
    attitude();
    state.altitude = state.y;
    state.heightAboveGround = state.y - world.groundAt(state.x, state.z);
    state.stall = !state.crashed && state.speed < 25;
    plane.root.setPosition(state.x, state.y, state.z);
    plane.root.setRotation(rotation);
  }

  function reset() {
    state.x = SPAWN.x;
    state.y = SPAWN.y;
    state.z = SPAWN.z;
    state.speed = SPAWN.speed;
    state.throttle = 0.6;
    state.verticalSpeed = 0;
    state.crashed = false;
    crashTime = 0;
    propAngle = 0;
    returnDirection = 0;
    plane.prop.setLocalEulerAngles(0, 0, 0);
    rotation.setFromAxisAngle(Vec3.UP, -SPAWN.heading);
    plane.root.enabled = true;
    publish();
  }

  function yaw(angle: number) {
    turn.setFromAxisAngle(Vec3.UP, -angle);
    rotation.mul2(turn, rotation).normalize();
  }

  reset();
  return {
    update(dt) {
      if (app.keyboard?.wasPressed(KEY_R)) {
        reset();
        return;
      }
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
      const rudderInput = Number(!!keyboard?.isPressed(KEY_E)) - Number(!!keyboard?.isPressed(KEY_Q));
      const throttleInput = Number(!!keyboard?.isPressed(KEY_SHIFT)) - Number(!!keyboard?.isPressed(KEY_CONTROL));
      state.throttle = Math.max(0, Math.min(1, state.throttle + throttleInput * 0.5 * duration));

      // Subpassos curtos mantêm curvas e colisões estáveis em quadros mais longos.
      const steps = Math.ceil(duration * 60);
      const step = duration / steps;
      const oldY = state.y;
      for (let i = 0; i < steps; i++) {
        attitude();
        const stallAmount = Math.max(0, Math.min(1, (25 - state.speed) / 5));
        const ceiling = Math.max(0, Math.min(1, (state.y - 2400) / 100));
        // Sustentação no up local e gravidade projetada nos eixos do avião curvam a trajetória.
        const lift = 9.81 * (1 - stallAmount) / state.speed * degrees;
        const gravity = 9.81 / state.speed * degrees + (state.pitch > 0 ? ceiling * 65 : 0);
        angularVelocity.set(
          pitchInput * 80 * (1 - stallAmount) - stallAmount * 28 + lift - gravity * up.y,
          -rudderInput * 35 + gravity * right.y,
          -rollInput * 180,
        );
        const angularSpeed = angularVelocity.length();
        if (angularSpeed > 0) {
          turn.setFromAxisAngle(angularVelocity.mulScalar(1 / angularSpeed), angularSpeed * step);
          rotation.mul(turn).normalize();
        }

        if (Math.abs(state.x) > 2500 || Math.abs(state.z) > 2500) {
          attitude();
          const target = Math.atan2(-state.x, state.z) * degrees;
          let error = ((target - state.heading + 540) % 360) - 180;
          if (Math.abs(error) > 170 && returnDirection) error = Math.abs(error) * returnDirection;
          returnDirection = Math.sign(error);
          const strength = Math.min(1, (Math.max(Math.abs(state.x), Math.abs(state.z)) - 2500) / 400);
          yaw(Math.max(-75, Math.min(75, error * 1.5)) * strength * step);
        } else {
          returnDirection = 0;
        }

        attitude();
        const acceleration = state.throttle * 24 - 0.0012 * state.speed * state.speed - 3 * forward.y;
        state.speed = Math.max(20, Math.min(140, state.speed + acceleration * step));
        state.x = Math.max(-2980, Math.min(2980, state.x + forward.x * state.speed * step));
        const climb = forward.y * state.speed;
        state.y = Math.min(2500, state.y + (climb - stallAmount * (12 + Math.max(0, climb))) * step);
        state.z = Math.max(-2980, Math.min(2980, state.z + forward.z * state.speed * step));
        for (const point of collisionPoints) {
          rotation.transformVector(point, collisionPoint);
          collisionPoint.x += state.x;
          collisionPoint.y += state.y;
          collisionPoint.z += state.z;
          if (collisionPoint.y <= world.groundAt(collisionPoint.x, collisionPoint.z)) {
            state.crashed = true;
            state.speed = 0;
            state.verticalSpeed = 0;
            crashTime = duration - (i + 1) * step;
            plane.root.enabled = false;
            break;
          }
        }
        if (state.crashed) break;
      }
      if (!state.crashed) state.verticalSpeed = (state.y - oldY) / duration;
      propAngle = (propAngle + state.throttle * 2400 * duration) % 360;
      plane.prop.setLocalEulerAngles(0, 0, propAngle);
      publish();
    },
  };
}
