// Derived from JSBSim FGAerodynamics, FGAccelerations, FGPropagate and FGPropeller;
// aircraft/pc7/pc7.xml (Aeromatic educational model); LGPL-2.1, JSBSim-Team.
import { Quat, Vec3 } from 'playcanvas';
import aircraft from './aircraft-pc7.json';
import { standardAtmosphere } from './atmosphere';
import { lookup1, lookup2 } from './table';

export const FIXED_STEP = 1 / 120;
export const ASSISTS = {
  mass: 0.7,
  power: 1.6,
  throttleExponent: 4,
  drag: 0.65,
  maneuverLift: 3,
  rollAuthority: 3,
  pitchAuthority: 1.4,
  yawAuthority: 1.8,
  rateGain: 12,
  rollRate: Math.PI,
  pitchRate: 80 * Math.PI / 180,
  yawRate: 35 * Math.PI / 180,
  controlTime: 0.07,
  stallRecovery: 0.35,
};

export interface FlightControls {
  pitch: number;
  roll: number;
  yaw: number;
  throttle: number;
}

const G = 9.80665;
const SCALE = 10 / aircraft.span;
const AREA = aircraft.area * SCALE ** 2;
const SPAN = aircraft.span * SCALE;
const CHORD = aircraft.chord * SCALE;
const MASS = (aircraft.emptyMass + aircraft.payloadMass + aircraft.fuelMass) * SCALE ** 3 * ASSISTS.mass;
const IX = aircraft.inertia[0] * SCALE ** 5 * ASSISTS.mass;
const IY = aircraft.inertia[1] * SCALE ** 5 * ASSISTS.mass;
const IZ = aircraft.inertia[2] * SCALE ** 5 * ASSISTS.mass;
const T = aircraft.tables;
const C = aircraft.constants;
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/** Body axes follow JSBSim: X forward, Y right, Z down. World: PlayCanvas Y up, north -Z. */
export class FlightDynamics {
  readonly position = new Vec3();
  readonly rotation = new Quat();
  readonly velocity = new Vec3();
  readonly rates = new Vec3();
  readonly controls: FlightControls = { pitch: 0, roll: 0, yaw: 0, throttle: 0.6 };
  readonly worldVelocity = new Vec3();
  alpha = 0;
  beta = 0;
  dynamicPressure = 0;
  stalled = false;
  private readonly air = standardAtmosphere(0);
  private readonly inverse = new Quat();
  private readonly delta = new Quat();
  private readonly vector = new Vec3();
  private readonly gravity = new Vec3();

  get speed(): number { return this.velocity.length(); }

  reset(x: number, y: number, z: number, heading: number, speed: number, throttle: number): void {
    if (![x, y, z, heading, speed, throttle].every(Number.isFinite) || speed <= 0) {
      throw new RangeError('Invalid initial flight state');
    }
    this.position.set(x, y, z);
    standardAtmosphere(y, this.air);
    const requiredCL = MASS * G / (0.5 * this.air.density * speed * speed * AREA);
    const cmElevator = lookup1(T.Pitch_elevator, speed / this.air.soundSpeed);
    const alpha = (requiredCL - lookup1(T.Lift_alpha, 0)) / (4.96 - C.Lift_elevator * C.Pitch_alpha / cmElevator);
    this.rotation.setFromAxisAngle(Vec3.UP, -heading);
    this.delta.setFromAxisAngle(Vec3.RIGHT, alpha * 180 / Math.PI);
    this.rotation.mul(this.delta).normalize();
    this.velocity.set(speed * Math.cos(alpha), 0, speed * Math.sin(alpha));
    this.rates.set(0, 0, 0);
    this.controls.pitch = this.controls.roll = this.controls.yaw = 0;
    this.controls.throttle = clamp(throttle, 0, 1);
    this.alpha = alpha;
    this.beta = 0;
    this.stalled = false;
    this.updateWorldVelocity();
  }

  private updateWorldVelocity(): void {
    this.vector.set(this.velocity.y, -this.velocity.z, -this.velocity.x);
    this.rotation.transformVector(this.vector, this.worldVelocity);
  }

  /** One fixed 120 Hz step; the caller owns the accumulator and collision checks. */
  step(input: FlightControls): void {
    if (!Number.isFinite(input.pitch) || !Number.isFinite(input.roll)
      || !Number.isFinite(input.yaw) || !Number.isFinite(input.throttle)) {
      throw new RangeError('Non-finite flight controls');
    }
    const dt = FIXED_STEP;
    const blend = 1 - Math.exp(-dt / ASSISTS.controlTime);
    this.controls.pitch += (clamp(input.pitch, -1, 1) - this.controls.pitch) * blend;
    this.controls.roll += (clamp(input.roll, -1, 1) - this.controls.roll) * blend;
    this.controls.yaw += (clamp(input.yaw, -1, 1) - this.controls.yaw) * blend;
    this.controls.throttle += (clamp(input.throttle, 0, 1) - this.controls.throttle) * blend;
    const { x: u, y: v, z: w } = this.velocity;
    const { x: p, y: q, z: r } = this.rates;
    const speed = Math.max(0.1, Math.hypot(u, v, w));
    this.alpha = Math.atan2(w, u);
    this.beta = Math.asin(clamp(v / speed, -1, 1));
    standardAtmosphere(this.position.y, this.air);
    const qbar = this.dynamicPressure = 0.5 * this.air.density * speed * speed;
    const qs = qbar * AREA;
    const mach = speed / this.air.soundSpeed;
    const reynolds = this.air.density * speed * CHORD / (1.458e-6 * this.air.temperature ** 1.5 / (this.air.temperature + 110.4));
    const phat = p * SPAN / (2 * speed);
    const qhat = q * CHORD / (2 * speed);
    const rhat = r * SPAN / (2 * speed);
    const cmElevator = lookup1(T.Pitch_elevator, mach);
    // Neutral trim follows airspeed, not bank or altitude: there is no wings-level autopilot.
    const trimAlpha = (MASS * G / Math.max(qs, 1) - lookup1(T.Lift_alpha, 0))
      / (4.96 - C.Lift_elevator * C.Pitch_alpha / cmElevator);
    const trimElevator = clamp(-C.Pitch_alpha * trimAlpha / cmElevator, -0.2, 0.2);
    const elevator = trimElevator - this.controls.pitch * aircraft.controlLimit * ASSISTS.pitchAuthority;
    const aileron = this.controls.roll * aircraft.controlLimit * ASSISTS.rollAuthority;
    const rudder = -this.controls.yaw * aircraft.controlLimit * ASSISTS.yawAuthority;
    const maneuver = 1 + Math.abs(this.controls.pitch) * (ASSISTS.maneuverLift - 1);
    let cl = lookup1(T.Lift_alpha, this.alpha) + C.Lift_pitch_rate * qhat + C.Lift_elevator * elevator;
    // shortcut: source alpha coverage is limited; flat-plate post-stall recovery replaces absent polars.
    const postStall = clamp((Math.abs(this.alpha) - 0.3) / 0.6, 0, 1);
    cl = cl * (1 - postStall) + Math.sin(2 * this.alpha) * ASSISTS.stallRecovery * postStall;
    const cd = (lookup1(T.Drag_basic, this.alpha) + C.Drag_induced * cl * cl
      + lookup1(T.Drag_beta, this.beta) + lookup1(T.Drag_mach, mach)
      + C.Drag_elevator * Math.abs(elevator)) * ASSISTS.drag;
    cl *= maneuver;
    const cy = C.Side_beta * this.beta + lookup1(T.Side_roll_rate, reynolds) * phat
      + C.Side_yaw_rate * rhat + C.Side_rudder * rudder;
    const roll = lookup2(T.Roll_beta, this.alpha, reynolds) * this.beta + C.Roll_damp * phat
      + lookup2(T.Roll_yaw, this.alpha, reynolds) * rhat + lookup1(T.Roll_aileron, mach) * aileron
      + C.Roll_rudder * rudder;
    const pitch = C.Pitch_alpha * this.alpha + cmElevator * elevator + C.Pitch_damp * qhat;
    const yaw = C.Yaw_beta * this.beta + lookup1(T.Yaw_roll_rate, reynolds) * phat
      + C.Yaw_damp * rhat + C.Yaw_rudder * rudder + C.Yaw_aileron * aileron;
    const densityRatio = this.air.density / 1.225;
    const thrust = this.controls.throttle ** ASSISTS.throttleExponent * ASSISTS.power * densityRatio * Math.min(
      aircraft.engine.staticThrustNewtons,
      aircraft.engine.powerWatts * aircraft.engine.efficiency / Math.max(speed, 15),
    );
    const sa = Math.sin(this.alpha), ca = Math.cos(this.alpha);
    const sb = Math.sin(this.beta), cb = Math.cos(this.beta);
    const fx = qs * (-cd * ca * cb - cy * ca * sb + cl * sa) + thrust;
    const fy = qs * (-cd * sb + cy * cb);
    const fz = qs * (-cd * sa * cb - cy * sa * sb - cl * ca);
    this.inverse.copy(this.rotation).invert();
    this.vector.set(0, -G, 0);
    this.inverse.transformVector(this.vector, this.gravity);
    const du = fx / MASS - (q * w - r * v) - this.gravity.z;
    const dv = fy / MASS - (r * u - p * w) + this.gravity.x;
    const dw = fz / MASS - (p * v - q * u) - this.gravity.y;
    this.velocity.set(u + du * dt, v + dv * dt, w + dw * dt);
    const l = qs * SPAN * roll + IX * ASSISTS.rateGain * (this.controls.roll * ASSISTS.rollRate - p);
    const m = qs * CHORD * pitch + IY * ASSISTS.rateGain * (this.controls.pitch * ASSISTS.pitchRate - q);
    const n = qs * SPAN * yaw + IZ * ASSISTS.rateGain * (this.controls.yaw * ASSISTS.yawRate - r);
    this.rates.set(
      clamp(p + (l - (IZ - IY) * q * r) / IX * dt, -6, 6),
      clamp(q + (m - (IX - IZ) * r * p) / IY * dt, -6, 6),
      clamp(r + (n - (IY - IX) * p * q) / IZ * dt, -6, 6),
    );
    this.vector.set(this.rates.y, -this.rates.z, -this.rates.x);
    const rate = this.vector.length();
    if (rate > 1e-10) {
      this.delta.setFromAxisAngle(this.vector.mulScalar(1 / rate), rate * dt * 180 / Math.PI);
      this.rotation.mul(this.delta).normalize();
    }
    this.updateWorldVelocity();
    this.position.x += this.worldVelocity.x * dt;
    this.position.y += this.worldVelocity.y * dt;
    this.position.z += this.worldVelocity.z * dt;
    this.stalled = speed < 25 || Math.abs(this.alpha) > 0.35;
  }
}
