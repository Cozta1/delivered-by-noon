import type { AppBase } from 'playcanvas';
import type { FpsController } from './scripts/fps-controller';
import type { Weapon } from './scripts/weapon';

const $ = (id: string) => document.getElementById(id)!;

/** HUD em HTML por cima do canvas. Só mexe no DOM quando o valor muda. */
export class Hud {
  private crosshair = $('crosshair');
  private dot = $('dot');
  private hitmarker = $('hitmarker');
  private speedEl = $('speed');
  private stateEl = $('state');
  private ammoCur = $('ammo-cur');
  private ammoMax = $('ammo-max');
  private reloadEl = $('reload');
  private hitTimer = 0;
  private last: Record<string, string> = {};

  constructor(
    app: AppBase,
    private ctrl: FpsController,
    private weapon: Weapon,
  ) {
    app.on('weapon:hit', (e: { head: boolean; kill: boolean }) => {
      this.hitTimer = e.kill ? 0.28 : 0.14;
      this.hitmarker.classList.toggle('kill', e.kill);
      this.hitmarker.style.width = this.hitmarker.style.height = e.head || e.kill ? '28px' : '22px';
      this.hitmarker.style.margin = e.head || e.kill ? '-14px 0 0 -14px' : '-11px 0 0 -11px';
    });
    this.ammoMax.textContent = `/ ${weapon.magSize}`;
  }

  update(dt: number) {
    const { ctrl, weapon } = this;

    // Mira: abre com o espalhamento, some ao mirar/correr
    const gap = 4 + weapon.spread * 6;
    this.crosshair.style.setProperty('--gap', `${gap.toFixed(1)}px`);
    this.crosshair.style.opacity = String(Math.max(0, 1 - Math.max(weapon.ads * 1.6, ctrl.sprintAmount)));
    this.dot.style.opacity = String(Math.max(0, weapon.ads * 1.6 - 0.6));

    if (this.hitTimer > 0) {
      this.hitTimer -= dt;
      this.hitmarker.style.opacity = String(Math.min(1, this.hitTimer * 8));
    }

    this.set(this.speedEl, 'speed', `${ctrl.speed.toFixed(1)} m/s`);
    const state = ctrl.sliding ? 'SLIDE' : ctrl.sprinting ? 'CORRENDO' : ctrl.crouching ? 'AGACHADO' : !ctrl.grounded ? 'NO AR' : '';
    this.set(this.stateEl, 'state', state);
    this.set(this.ammoCur, 'ammo', String(weapon.ammo));
    this.ammoCur.classList.toggle('low', weapon.ammo <= weapon.magSize * 0.2);
    this.reloadEl.style.display = weapon.reloading ? 'block' : 'none';
  }

  private set(el: HTMLElement, key: string, value: string) {
    if (this.last[key] === value) return;
    this.last[key] = value;
    el.textContent = value;
  }
}
