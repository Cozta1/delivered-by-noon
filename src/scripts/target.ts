import { Color, Script, StandardMaterial, Vec3 } from 'playcanvas';

const WHITE = new Color(1, 1, 1);
const BLACK = new Color(0, 0, 0);

/** Alvo de treino: leva dano, pisca ao ser atingido, cai e volta depois de um tempo. */
export class Target extends Script {
  static scriptName = 'target';

  /** @attribute */
  maxHealth = 100;
  /** @attribute */
  respawnTime = 3;
  /** Amplitude do vaivém lateral (0 = parado). @attribute */
  moveAmplitude = 0;
  /** @attribute */
  moveSpeed = 1.2;

  health = 100;
  materials: StandardMaterial[] = [];

  private base = new Vec3();
  private axis = new Vec3(1, 0, 0);
  private t = Math.random() * 10;
  private flash = 0;
  private respawnTimer = 0;
  private dead = false;

  initialize() {
    this.health = this.maxHealth;
    this.base.copy(this.entity.getPosition());
    const yawRad = (this.entity.getEulerAngles().y * Math.PI) / 180;
    this.axis.set(Math.cos(yawRad), 0, -Math.sin(yawRad));
  }

  /** Retorna true se o golpe derrubou o alvo. */
  takeDamage(amount: number) {
    if (this.dead) return false;
    this.health -= amount;
    this.flash = 0.08;
    this.setEmissive(WHITE);
    if (this.health <= 0) {
      this.dead = true;
      this.respawnTimer = this.respawnTime;
      this.setAlive(false);
      return true;
    }
    return false;
  }

  update(dt: number) {
    if (this.flash > 0) {
      this.flash -= dt;
      if (this.flash <= 0) this.setEmissive(BLACK);
    }

    if (this.dead) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) {
        this.dead = false;
        this.health = this.maxHealth;
        this.setEmissive(BLACK);
        this.setAlive(true);
      }
      return;
    }

    if (this.moveAmplitude > 0) {
      this.t += dt * this.moveSpeed;
      const o = Math.sin(this.t) * this.moveAmplitude;
      this.entity.setPosition(this.base.x + this.axis.x * o, this.base.y, this.base.z + this.axis.z * o);
    }
  }

  private setAlive(alive: boolean) {
    // Desliga só os componentes (o script continua rodando para o respawn)
    if (this.entity.rigidbody) this.entity.rigidbody.enabled = alive;
    if (this.entity.collision) this.entity.collision.enabled = alive;
    if (this.entity.render) this.entity.render.enabled = alive;
    for (const child of this.entity.children) (child as typeof this.entity).enabled = alive;
  }

  private setEmissive(c: Color) {
    for (const m of this.materials) {
      m.emissive.copy(c);
      m.update();
    }
  }
}
