// Versão CLÁSSICA (pc.createScript) do script do Editor. O Editor do projeto do usuário
// não listou o script ESM (.mjs) no componente Script; o formato clássico é lido por ele.
// Mesmo comportamento de src/editor/flight-sim.ts.
import type { AppBase } from 'playcanvas';
import cssText from '../flight.css?inline';
import { startFlightSim } from '../flight/game';

type ClassicScript = {
  app: AppBase;
  once(event: string, fn: () => void): void;
};
declare const pc: { createScript(name: string): { prototype: Record<string, unknown> } };

const SimuladorVoo = pc.createScript('simuladorVoo');

SimuladorVoo.prototype.initialize = function (this: ClassicScript) {
  const style = document.createElement('style');
  style.dataset.flightSim = 'true';
  style.textContent = cssText;
  document.head.appendChild(style);

  const ui = document.createElement('div');
  ui.id = 'flight-sim-ui';
  ui.style.cssText = 'position:fixed;inset:0;z-index:100;pointer-events:none;';
  document.body.appendChild(ui);

  let sim: { destroy(): void } | null = null;
  this.once('destroy', () => {
    sim?.destroy();
    sim = null;
    ui.remove();
    style.remove();
  });

  if (!this.app.keyboard) {
    const notice = document.createElement('div');
    notice.style.cssText =
      'position:fixed;top:24px;left:50%;transform:translateX(-50%);padding:14px 20px;border-radius:10px;' +
      'background:rgba(24,18,28,0.92);color:#ffcf7d;border:1px solid #ff9e4a;' +
      'font:600 14px/1.4 system-ui,sans-serif;text-align:center;z-index:9999;';
    notice.textContent = 'Teclado desabilitado. Ative em Settings → Input → Keyboard no Editor do PlayCanvas e recarregue.';
    ui.appendChild(notice);
    return;
  }

  sim = startFlightSim(this.app, ui);
};
