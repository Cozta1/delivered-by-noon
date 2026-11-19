import { Application, FILLMODE_FILL_WINDOW, Keyboard, Mouse, RESOLUTION_AUTO } from 'playcanvas';
import './flight.css';
import { startFlightSim } from './flight/game';

const canvas = document.getElementById('app') as HTMLCanvasElement;
const app = new Application(canvas, {
  keyboard: new Keyboard(window),
  mouse: new Mouse(canvas),
});
app.setCanvasFillMode(FILLMODE_FILL_WINDOW);
app.setCanvasResolution(RESOLUTION_AUTO);
window.addEventListener('resize', () => app.resizeCanvas());
app.start();

startFlightSim(app, document.getElementById('ui')!);
