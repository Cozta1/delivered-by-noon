// Versão CLÁSSICA (pc.createScript) do script do Editor. O Editor do projeto do usuário
// não listou o script ESM (.mjs) no componente Script; o formato clássico é lido por ele.
// Mesmo comportamento de src/editor/flight-sim.ts, incluindo ciclo de vida enable/disable/destroy.
import type { AppBase } from 'playcanvas';
import cssText from '../flight.css?inline';
import { startFlightSim } from '../flight/game';

type ClassicScript = {
  app: AppBase;
  enabled: boolean;
  on(event: string, fn: () => void, scope?: unknown): void;
  off(event: string, fn: () => void, scope?: unknown): void;
  once(event: string, fn: () => void, scope?: unknown): void;
};
declare const pc: { createScript(name: string): { prototype: Record<string, unknown> } };

const SimuladorVoo = pc.createScript('simuladorVoo');

SimuladorVoo.prototype.initialize = function (this: ClassicScript) {
  let styleEl: HTMLStyleElement | null = null;
  let uiEl: HTMLDivElement | null = null;
  let sim: { destroy(): void } | null = null;

  const unmount = () => {
    sim?.destroy();
    sim = null;
    uiEl?.remove();
    uiEl = null;
    styleEl?.remove();
    styleEl = null;
  };

  const mount = () => {
    if (sim || uiEl || this.enabled === false) return;

    const style = document.createElement('style');
    style.dataset.flightSim = 'true';
    style.textContent = cssText;
    document.head.appendChild(style);
    styleEl = style;

    const ui = document.createElement('div');
    ui.id = 'flight-sim-ui';
    ui.style.cssText = 'position:fixed;inset:0;z-index:100;pointer-events:none;';
    document.body.appendChild(ui);
    uiEl = ui;

    if (!this.app.keyboard) {
      const notice = document.createElement('div');
      notice.style.cssText =
        'position:fixed;top:24px;left:50%;transform:translateX(-50%);padding:14px 20px;border-radius:10px;' +
        'background:rgba(24,18,28,0.92);color:#ffcf7d;border:1px solid #ff9e4a;' +
        'font:600 14px/1.4 system-ui,sans-serif;text-align:center;z-index:9999;';
      notice.textContent =
        'Teclado desabilitado. Ative em Settings → Input → Keyboard no Editor do PlayCanvas e recarregue.';
      ui.appendChild(notice);
      return;
    }

    sim = startFlightSim(this.app, ui);
  };

  this.on('disable', unmount);
  this.on('enable', mount);
  this.once('destroy', () => {
    this.off('disable', unmount);
    this.off('enable', mount);
    unmount();
  });

  mount();
};
