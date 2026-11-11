import {
  Entity,
  KEY_A,
  KEY_C,
  KEY_D,
  KEY_S,
  KEY_SHIFT,
  KEY_SPACE,
  KEY_W,
  Mouse,
  Script,
  Vec3,
  math,
} from 'playcanvas';

// Temporários reutilizados (sem alocação por frame)
const hv = new Vec3(); // velocidade horizontal
const wish = new Vec3(); // direção desejada
const fwd = new Vec3();
const right = new Vec3();
const rayFrom = new Vec3();
const rayTo = new Vec3();
const outVel = new Vec3();

export const STAND_HEIGHT = 1.8;
export const CROUCH_HEIGHT = 1.1;
export const PLAYER_RADIUS = 0.4;
const EYE_STAND = 1.62;
const EYE_CROUCH = 1.0;
const EYE_SLIDE = 0.8;
const PROBE_OFFSETS: [number, number][] = [
  [0, 0],
  [0.28, 0],
  [-0.28, 0],
  [0, 0.28],
  [0, -0.28],
];

/**
 * Controle em primeira pessoa com física de aceleração/atrito (estilo "movement shooter"):
 * corrida, agachar, slide com embalo, slide-jump, coyote time e buffer de pulo.
 * Fica na entidade do jogador (cápsula com rigidbody dinâmico).
 */
export class FpsController extends Script {
  static scriptName = 'fpsController';

  /** @attribute */
  camera: Entity | null = null;

  /** @attribute */
  walkSpeed = 6.5;
  /** @attribute */
  sprintSpeed = 9.6;
  /** @attribute */
  crouchSpeed = 3.4;
  /** @attribute */
  adsSpeed = 4.2;
  /** @attribute */
  groundAccel = 10;
  /** @attribute */
  airAccel = 2.5;
  /** @attribute */
  friction = 8;
  /** @attribute */
  stopSpeed = 3;
  /** @attribute */
  jumpSpeed = 8;
  /** @attribute */
  gravity = 25;
  /** @attribute */
  coyoteTime = 0.12;
  /** @attribute */
  jumpBufferTime = 0.15;
  /** @attribute */
  slideMinSpeed = 7.5;
  /** @attribute */
  slideBoost = 13.5;
  /** @attribute */
  slideFriction = 1.2;
  /** @attribute */
  slideMaxTime = 1.0;
  /** @attribute */
  slideEndSpeed = 4.5;
  /** @attribute */
  slideCooldown = 0.5;
  /** @attribute */
  sensitivity = 0.11;
  /** @attribute */
  fovBase = 90;

  // Estado público (lido pela arma e pelo HUD)
  yaw = 0;
  pitch = 0;
  grounded = false;
  crouching = false;
  sliding = false;
  sprinting = false;
  speed = 0;
  adsAmount = 0;
  sprintAmount = 0;
  bobX = 0;
  bobY = 0;
  lookDx = 0;
  lookDy = 0;

  private height = STAND_HEIGHT;
  private groundNormal = new Vec3(0, 1, 0);
  private coyote = 0;
  private jumpBuffer = 0;
  private jumpLock = 0;
  private slideTimer = 0;
  private slideCd = 0;
  private sprintBlock = 0;
  private airVelY = 0;
  private eyeHeight = EYE_STAND;
  private bobPhase = 0;
  private landDip = 0;
  private roll = 0;
  private punch = 0;
  private strafeIn = 0;

  initialize() {
    const rb = this.entity.rigidbody!;
    rb.angularFactor = new Vec3(0, 0, 0);
    rb.friction = 0;
    rb.restitution = 0;
    this.app.systems.rigidbody!.gravity.set(0, -this.gravity, 0);

    this.app.mouse!.on('mousemove', this.onMouseMove, this);
    this.on('destroy', () => this.app.mouse?.off('mousemove', this.onMouseMove, this));
  }

  private onMouseMove(e: { dx: number; dy: number }) {
    if (!Mouse.isPointerLocked()) return;
    const s = this.sensitivity * (1 - 0.4 * this.adsAmount);
    this.yaw -= e.dx * s;
    this.pitch = math.clamp(this.pitch - e.dy * s, -89, 89);
    this.lookDx += e.dx;
    this.lookDy += e.dy;
  }

  /** Coice da arma: sobe a mira (o jogador compensa puxando o mouse). */
  addRecoil(pitchDeg: number, yawDeg: number) {
    this.pitch = math.clamp(this.pitch + pitchDeg, -89, 89);
    this.yaw += yawDeg;
    this.punch += pitchDeg * 0.6;
  }

  /** Atirar interrompe a corrida por um instante. */
  blockSprint(seconds: number) {
    this.sprintBlock = Math.max(this.sprintBlock, seconds);
    this.sprinting = false;
  }

  update(dt: number) {
    dt = Math.min(dt, 0.05);
    const kb = this.app.keyboard!;
    const rb = this.entity.rigidbody!;
    const locked = Mouse.isPointerLocked();

    // ---- Entrada -------------------------------------------------------
    const fwdIn = locked ? (kb.isPressed(KEY_W) ? 1 : 0) - (kb.isPressed(KEY_S) ? 1 : 0) : 0;
    const strIn = locked ? (kb.isPressed(KEY_D) ? 1 : 0) - (kb.isPressed(KEY_A) ? 1 : 0) : 0;
    this.strafeIn = strIn;
    const crouchHeld = locked && kb.isPressed(KEY_C);
    const crouchPressed = locked && kb.wasPressed(KEY_C);
    if (locked && kb.wasPressed(KEY_SPACE)) this.jumpBuffer = this.jumpBufferTime;

    const yawRad = this.yaw * math.DEG_TO_RAD;
    fwd.set(-Math.sin(yawRad), 0, -Math.cos(yawRad));
    right.set(Math.cos(yawRad), 0, -Math.sin(yawRad));
    wish.set(0, 0, 0);
    wish.add(fwd.mulScalar(fwdIn)).add(right.mulScalar(strIn));
    fwd.set(-Math.sin(yawRad), 0, -Math.cos(yawRad));
    right.set(Math.cos(yawRad), 0, -Math.sin(yawRad));
    if (wish.lengthSq() > 0) wish.normalize();

    // ---- Timers e chão -----------------------------------------------
    this.jumpBuffer -= dt;
    this.jumpLock -= dt;
    this.slideCd -= dt;
    this.sprintBlock -= dt;

    const wasGrounded = this.grounded;
    this.grounded = this.jumpLock <= 0 && this.probeGround();
    if (this.grounded) this.coyote = this.coyoteTime;
    else this.coyote -= dt;

    const v = rb.linearVelocity;
    hv.set(v.x, 0, v.z);
    let vy = v.y;
    if (!this.grounded) this.airVelY = vy;

    // Aterrissagem: "afunda" a câmera conforme a velocidade de queda
    if (this.grounded && !wasGrounded && this.airVelY < -4) {
      this.landDip = math.clamp(-this.airVelY * 0.012, 0, 0.18);
    }

    let hSpeed = hv.length();

    // ---- Slide / agachar ---------------------------------------------
    if (
      crouchPressed &&
      this.grounded &&
      !this.sliding &&
      hSpeed >= this.slideMinSpeed &&
      this.slideCd <= 0
    ) {
      this.sliding = true;
      this.slideTimer = this.slideMaxTime;
      this.setHeight(CROUCH_HEIGHT);
      if (hSpeed < this.slideBoost) {
        hv.normalize().mulScalar(this.slideBoost);
        hSpeed = this.slideBoost;
      }
    }

    if (this.sliding) {
      this.slideTimer -= dt;
      if (this.slideTimer <= 0 || hSpeed < this.slideEndSpeed) this.endSlide(crouchHeld);
    } else if (crouchHeld && !this.crouching) {
      this.crouching = true;
      this.setHeight(CROUCH_HEIGHT);
    } else if (!crouchHeld && this.crouching && this.canStand()) {
      this.crouching = false;
      this.setHeight(STAND_HEIGHT);
    }

    // ---- Corrida ------------------------------------------------------
    this.sprinting =
      locked &&
      kb.isPressed(KEY_SHIFT) &&
      fwdIn > 0 &&
      !this.crouching &&
      !this.sliding &&
      this.sprintBlock <= 0 &&
      this.adsAmount < 0.3;

    let target = this.crouching ? this.crouchSpeed : this.sprinting ? this.sprintSpeed : this.walkSpeed;
    target = math.lerp(target, Math.min(target, this.adsSpeed), this.adsAmount);

    // ---- Aceleração ---------------------------------------------------
    if (this.grounded) {
      if (this.sliding) {
        this.applyFriction(this.slideFriction, dt);
        // Gravidade ao longo da rampa: slide ganha velocidade descendo
        const n = this.groundNormal;
        hv.x += this.gravity * n.y * n.x * dt;
        hv.z += this.gravity * n.y * n.z * dt;
        this.accelerate(wish, target, 1.5, dt);
      } else {
        this.applyFriction(this.friction, dt);
        this.accelerate(wish, target, this.groundAccel, dt);
      }
    } else {
      this.accelerate(wish, Math.max(target, this.walkSpeed), this.airAccel, dt);
    }

    // ---- Pulo (com coyote time e buffer) ------------------------------
    if (this.jumpBuffer > 0 && this.coyote > 0) {
      if (this.sliding) this.endSlide(false);
      if (this.crouching && this.canStand()) {
        this.crouching = false;
        this.setHeight(STAND_HEIGHT);
      }
      vy = this.jumpSpeed;
      this.jumpBuffer = 0;
      this.coyote = 0;
      this.jumpLock = 0.15;
      this.grounded = false;
    }

    // ---- Velocidade final -------------------------------------------
    if (this.grounded) {
      // Projeta no plano do chão: sobe e desce rampas sem "quicar"
      const n = this.groundNormal;
      const d = hv.dot(n);
      outVel.set(hv.x - n.x * d, -n.y * d - 0.5, hv.z - n.z * d);
    } else {
      outVel.set(hv.x, vy, hv.z);
    }
    rb.linearVelocity = outVel;
    rb.activate();

    this.speed = Math.hypot(hv.x, hv.z);
  }

  postUpdate(dt: number) {
    dt = Math.min(dt, 0.05);
    const cam = this.camera;
    if (!cam) return;

    const pos = this.entity.getPosition();
    const eyeTarget = this.sliding ? EYE_SLIDE : this.crouching ? EYE_CROUCH : EYE_STAND;
    this.eyeHeight = math.lerp(this.eyeHeight, eyeTarget, Math.min(1, 12 * dt));
    this.sprintAmount = math.lerp(this.sprintAmount, this.sprinting ? 1 : 0, Math.min(1, 8 * dt));

    // Balanço da câmera ao andar
    const amp = this.grounded && !this.sliding ? Math.min(this.speed / this.sprintSpeed, 1.2) : 0;
    if (amp > 0.05) this.bobPhase += dt * this.speed * 1.35;
    const ampScaled = amp * (1 - 0.75 * this.adsAmount);
    this.bobY = math.lerp(this.bobY, Math.sin(this.bobPhase * 2) * 0.035 * ampScaled, Math.min(1, 15 * dt));
    this.bobX = math.lerp(this.bobX, Math.cos(this.bobPhase) * 0.025 * ampScaled, Math.min(1, 15 * dt));

    this.landDip = math.lerp(this.landDip, 0, Math.min(1, 8 * dt));
    this.punch = math.lerp(this.punch, 0, Math.min(1, 10 * dt));

    const yawRad = this.yaw * math.DEG_TO_RAD;
    const rx = Math.cos(yawRad);
    const rz = -Math.sin(yawRad);
    const feet = pos.y - this.height / 2;
    cam.setPosition(pos.x + rx * this.bobX, feet + this.eyeHeight + this.bobY - this.landDip, pos.z + rz * this.bobX);

    const rollTarget = this.sliding ? -6 : -this.strafeIn * 1.2;
    this.roll = math.lerp(this.roll, rollTarget, Math.min(1, 8 * dt));
    cam.setEulerAngles(this.pitch + this.punch, this.yaw, this.roll);

    // FOV: abre ao correr/deslizar, fecha ao mirar
    let fov = this.fovBase + this.sprintAmount * 8 + (this.sliding ? 10 : 0);
    fov = math.lerp(fov, 55, this.adsAmount);
    const c = cam.camera!;
    c.fov = math.lerp(c.fov, fov, Math.min(1, 10 * dt));
  }

  /** Consumido pela arma (balanço do mouse). */
  consumeLook() {
    const d = { dx: this.lookDx, dy: this.lookDy };
    this.lookDx = 0;
    this.lookDy = 0;
    return d;
  }

  // ---------------------------------------------------------------------

  private accelerate(dir: Vec3, wishSpeed: number, accel: number, dt: number) {
    if (dir.lengthSq() === 0) return;
    const current = hv.dot(dir);
    const add = wishSpeed - current;
    if (add <= 0) return;
    const accelSpeed = Math.min(accel * wishSpeed * dt, add);
    hv.x += dir.x * accelSpeed;
    hv.z += dir.z * accelSpeed;
  }

  private applyFriction(friction: number, dt: number) {
    const speed = hv.length();
    if (speed < 0.01) {
      hv.set(0, 0, 0);
      return;
    }
    const drop = Math.max(speed, this.stopSpeed) * friction * dt;
    hv.mulScalar(Math.max(speed - drop, 0) / speed);
  }

  private endSlide(stayCrouched: boolean) {
    this.sliding = false;
    if (stayCrouched || !this.canStand()) {
      this.crouching = true;
    } else {
      this.crouching = false;
      this.setHeight(STAND_HEIGHT);
    }
    this.slideCd = this.slideCooldown;
  }

  /** Troca a altura da cápsula mantendo os pés no mesmo lugar. */
  private setHeight(h: number) {
    if (h === this.height) return;
    const p = this.entity.getPosition();
    const dy = (h - this.height) / 2;
    this.height = h;
    this.entity.collision!.height = h;
    this.entity.rigidbody!.teleport(p.x, p.y + dy, p.z);
  }

  private canStand() {
    if (this.height >= STAND_HEIGHT) return true;
    const p = this.entity.getPosition();
    rayFrom.set(p.x, p.y, p.z);
    rayTo.set(p.x, p.y + this.height / 2 + (STAND_HEIGHT - this.height) + 0.05, p.z);
    return !this.firstHit(rayFrom, rayTo);
  }

  private probeGround() {
    const p = this.entity.getPosition();
    const feet = p.y - this.height / 2;
    let found = false;
    let bestY = -Infinity;
    for (const [ox, oz] of PROBE_OFFSETS) {
      rayFrom.set(p.x + ox, feet + 0.4, p.z + oz);
      rayTo.set(p.x + ox, feet - 0.2, p.z + oz);
      const hit = this.firstHit(rayFrom, rayTo);
      if (hit && hit.normal.y > 0.65 && hit.point.y > bestY) {
        bestY = hit.point.y;
        this.groundNormal.copy(hit.normal);
        found = true;
      }
    }
    if (!found) this.groundNormal.set(0, 1, 0);
    return found;
  }

  private firstHit(from: Vec3, to: Vec3) {
    const hits = this.app.systems.rigidbody!.raycastAll(from, to);
    let best = null;
    for (const h of hits) {
      if (h.entity === this.entity) continue;
      if (!best || h.hitFraction < best.hitFraction) best = h;
    }
    return best;
  }
}
