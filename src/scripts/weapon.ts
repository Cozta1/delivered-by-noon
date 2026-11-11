import {
  Color,
  Entity,
  KEY_R,
  MOUSEBUTTON_LEFT,
  MOUSEBUTTON_RIGHT,
  Mouse,
  Script,
  StandardMaterial,
  Vec3,
  math,
} from 'playcanvas';
import type { FpsController } from './fps-controller';
import type { Target } from './target';

const from = new Vec3();
const to = new Vec3();
const dir = new Vec3();
const tmp = new Vec3();

const HIP = new Vec3(0.24, -0.22, -0.5);
const ADS = new Vec3(0, -0.135, -0.32);

function mat(r: number, g: number, b: number, gloss = 0.4) {
  // Sem metalness: sem mapa de ambiente, metal renderiza quase preto
  const m = new StandardMaterial();
  m.diffuse = new Color(r, g, b);
  m.gloss = gloss;
  m.update();
  return m;
}

/** Fuzil automático hitscan com mira (ADS), coice, espalhamento, recarga e marcas de impacto. */
export class Weapon extends Script {
  static scriptName = 'weapon';

  /** Segundos entre tiros (~700 tiros/min). @attribute */
  fireInterval = 0.085;
  /** @attribute */
  damage = 25;
  /** @attribute */
  headMultiplier = 2;
  /** @attribute */
  magSize = 30;
  /** @attribute */
  reloadTime = 1.6;
  /** @attribute */
  range = 300;
  /** @attribute */
  recoilPitch = 0.55;
  /** @attribute */
  recoilYaw = 0.25;

  controller!: FpsController;

  ammo = 30;
  reloading = false;
  ads = 0;
  spread = 0;

  private cooldown = 0;
  private reloadTimer = 0;
  private kick = 0;
  private kickRot = 0;
  private swayX = 0;
  private swayY = 0;
  private flashTimer = 0;
  private root!: Entity;
  private flash!: Entity;
  private impacts: Entity[] = [];
  private impactIdx = 0;

  initialize() {
    this.ammo = this.magSize;
    this.app.mouse!.disableContextMenu();
    this.buildViewModel();
    this.buildImpactPool(40);
  }

  update(dt: number) {
    dt = Math.min(dt, 0.05);
    const ctrl = this.controller;
    const mouse = this.app.mouse!;
    const kb = this.app.keyboard!;
    const locked = Mouse.isPointerLocked();

    this.cooldown -= dt;

    // ---- Mira (ADS) ----------------------------------------------------
    const wantAds = locked && mouse.isPressed(MOUSEBUTTON_RIGHT) && !this.reloading;
    this.ads = math.lerp(this.ads, wantAds ? 1 : 0, Math.min(1, 14 * dt));
    if (this.ads < 0.001) this.ads = 0;
    ctrl.adsAmount = this.ads;

    // ---- Recarga -------------------------------------------------------
    if (locked && kb.wasPressed(KEY_R) && !this.reloading && this.ammo < this.magSize) this.startReload();
    if (this.reloading) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        this.reloading = false;
        this.ammo = this.magSize;
      }
    }

    // ---- Espalhamento --------------------------------------------------
    const moveFactor = Math.min(ctrl.speed / ctrl.sprintSpeed, 1.3);
    let hip = 1.6 + moveFactor * 1.8 + (ctrl.grounded ? 0 : 2.5) + (ctrl.sliding ? 0.8 : 0);
    if (ctrl.crouching) hip *= 0.75;
    const targetSpread = math.lerp(hip, 0.12, this.ads);
    this.spread = math.lerp(this.spread, targetSpread, Math.min(1, 12 * dt));

    // ---- Tiro ------------------------------------------------------------
    if (locked && mouse.isPressed(MOUSEBUTTON_LEFT) && !this.reloading) {
      if (this.ammo <= 0) {
        this.startReload();
      } else {
        if (ctrl.sprinting) {
          // "sprint-to-fire": primeiro tiro sai depois de abaixar a corrida
          ctrl.blockSprint(0.3);
          this.cooldown = Math.max(this.cooldown, 0.09);
        }
        ctrl.blockSprint(0.25);
        if (this.cooldown <= 0) this.shoot();
      }
    }

    this.updateViewModel(dt);
  }

  private startReload() {
    if (this.reloading) return;
    this.reloading = true;
    this.reloadTimer = this.reloadTime;
  }

  private shoot() {
    const ctrl = this.controller;
    this.cooldown = this.fireInterval;
    this.ammo--;

    // Direção com espalhamento aleatório dentro de um cone
    const cam = this.entity;
    from.copy(cam.getPosition());
    const ang = Math.random() * Math.PI * 2;
    const rad = Math.sqrt(Math.random()) * this.spread * math.DEG_TO_RAD;
    dir.copy(cam.forward);
    tmp.copy(cam.right).mulScalar(Math.cos(ang) * Math.tan(rad));
    dir.add(tmp);
    tmp.copy(cam.up).mulScalar(Math.sin(ang) * Math.tan(rad));
    dir.add(tmp).normalize();
    to.copy(dir).mulScalar(this.range).add(from);

    const hits = this.app.systems.rigidbody!.raycastAll(from, to);
    let best = null;
    for (const h of hits) {
      if (h.entity === ctrl.entity) continue;
      if (!best || h.hitFraction < best.hitFraction) best = h;
    }

    if (best) {
      this.placeImpact(best.point, best.normal);
      const head = best.entity.tags.has('head');
      let e: Entity | null = best.entity;
      while (e && !e.script?.has('target')) e = e.parent as Entity | null;
      if (e) {
        const t = e.script!.get('target') as Target;
        const kill = t.takeDamage(this.damage * (head ? this.headMultiplier : 1));
        this.app.fire('weapon:hit', { head, kill });
      }
    }

    // Coice: sobe a mira + empurra a arma
    const k = 1 - 0.45 * this.ads;
    ctrl.addRecoil(this.recoilPitch * k, (Math.random() * 2 - 1) * this.recoilYaw * k);
    this.kick += 0.05 * (1 - 0.5 * this.ads);
    this.kickRot += 3;
    this.flashTimer = 0.045;
    this.flash.enabled = true;
    this.app.fire('weapon:fire');
  }

  private updateViewModel(dt: number) {
    const ctrl = this.controller;
    const look = ctrl.consumeLook();
    this.swayX = math.clamp(math.lerp(this.swayX, -look.dx * 0.0006, Math.min(1, 10 * dt)), -0.04, 0.04);
    this.swayY = math.clamp(math.lerp(this.swayY, look.dy * 0.0006, Math.min(1, 10 * dt)), -0.04, 0.04);
    this.kick = math.lerp(this.kick, 0, Math.min(1, 16 * dt));
    this.kickRot = math.lerp(this.kickRot, 0, Math.min(1, 14 * dt));

    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) this.flash.enabled = false;
    }

    const a = this.ads;
    const s = ctrl.sprintAmount * (1 - a);
    const notAds = 1 - a * 0.85;
    const x = math.lerp(HIP.x, ADS.x, a) - 0.06 * s + ctrl.bobX * 0.8 * notAds + this.swayX * notAds;
    const y = math.lerp(HIP.y, ADS.y, a) - 0.05 * s + ctrl.bobY * 0.8 * notAds + this.swayY * notAds;
    const z = math.lerp(HIP.z, ADS.z, a) + 0.04 * s + this.kick;

    let rx = -12 * s + this.kickRot;
    let ry = 38 * s;
    let rz = 14 * s + (ctrl.sliding ? 8 * (1 - a) : 0);
    if (this.reloading) {
      const t = 1 - this.reloadTimer / this.reloadTime; // 0..1
      const dip = Math.sin(Math.PI * t);
      rx -= 35 * dip;
      rz += 20 * dip;
    }
    this.root.setLocalPosition(x, y - (this.reloading ? 0.06 : 0), z);
    this.root.setLocalEulerAngles(rx, ry, rz);
  }

  private buildViewModel() {
    this.root = new Entity('ViewModel');
    this.entity.addChild(this.root);

    const body = mat(0.22, 0.23, 0.26, 0.55);
    const accent = mat(0.85, 0.45, 0.12, 0.5);
    const grip = mat(0.12, 0.12, 0.13, 0.2);

    const part = (name: string, m: StandardMaterial, p: [number, number, number], s: [number, number, number]) => {
      const e = new Entity(name);
      e.addComponent('render', { type: 'box', material: m, castShadows: false });
      e.setLocalPosition(...p);
      e.setLocalScale(...s);
      this.root.addChild(e);
      return e;
    };

    part('receiver', body, [0, 0, 0], [0.07, 0.09, 0.42]);
    part('barrel', body, [0, 0.012, -0.34], [0.03, 0.03, 0.3]);
    part('handguard', accent, [0, -0.005, -0.2], [0.075, 0.07, 0.18]);
    part('mag', grip, [0, -0.1, -0.06], [0.05, 0.14, 0.07]).setLocalEulerAngles(12, 0, 0);
    part('grip', grip, [0, -0.09, 0.09], [0.05, 0.12, 0.05]).setLocalEulerAngles(-15, 0, 0);
    part('stock', body, [0, -0.02, 0.27], [0.06, 0.08, 0.14]);
    part('sightRear', grip, [0, 0.06, 0.1], [0.04, 0.03, 0.02]);
    part('sightFront', accent, [0, 0.055, -0.2], [0.01, 0.025, 0.01]);

    // Clarão do disparo
    this.flash = new Entity('MuzzleFlash');
    const fm = new StandardMaterial();
    fm.emissive = new Color(1, 0.75, 0.3);
    fm.emissiveIntensity = 4;
    fm.diffuse = new Color(0, 0, 0);
    fm.update();
    this.flash.addComponent('render', { type: 'box', material: fm, castShadows: false });
    this.flash.setLocalScale(0.06, 0.06, 0.08);
    this.flash.setLocalPosition(0, 0.012, -0.52);
    this.flash.setLocalEulerAngles(0, 0, 45);
    this.flash.addComponent('light', {
      type: 'omni',
      color: new Color(1, 0.7, 0.35),
      intensity: 2,
      range: 6,
      castShadows: false,
    });
    this.flash.enabled = false;
    this.root.addChild(this.flash);
  }

  private buildImpactPool(count: number) {
    const m = mat(0.05, 0.05, 0.05, 0.1);
    for (let i = 0; i < count; i++) {
      const e = new Entity('Impact');
      e.addComponent('render', { type: 'box', material: m, castShadows: false });
      e.setLocalScale(0.07, 0.07, 0.07);
      e.enabled = false;
      this.app.root.addChild(e);
      this.impacts.push(e);
    }
  }

  private placeImpact(point: Vec3, normal: Vec3) {
    const e = this.impacts[this.impactIdx];
    this.impactIdx = (this.impactIdx + 1) % this.impacts.length;
    tmp.copy(normal).mulScalar(0.01).add(point);
    e.setPosition(tmp);
    e.enabled = true;
  }
}
