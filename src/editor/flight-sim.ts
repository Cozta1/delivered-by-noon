import { Script } from 'playcanvas';
import cssText from '../flight.css?inline';
import { startFlightSim } from '../flight/game';

export class FlightSim extends Script {
  static scriptName = 'flightSim';

  private styleEl: HTMLStyleElement | null = null;
  private uiEl: HTMLDivElement | null = null;
  private sim: { destroy(): void } | null = null;

  initialize() {
    const style = document.createElement('style');
    style.dataset.flightSim = 'true';
    style.textContent = cssText;
    document.head.appendChild(style);
    this.styleEl = style;

    const ui = document.createElement('div');
    ui.style.position = 'fixed';
    ui.style.inset = '0';
    ui.style.pointerEvents = 'none';
    document.body.appendChild(ui);
    this.uiEl = ui;

    this.once('destroy', () => {
      this.sim?.destroy();
      this.sim = null;
      this.uiEl?.remove();
      this.uiEl = null;
      this.styleEl?.remove();
      this.styleEl = null;
    });

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

    this.sim = startFlightSim(this.app, ui);
  }
}
