import {
  Application,
  Color,
  Entity,
  FILLMODE_FILL_WINDOW,
  FOG_LINEAR,
  Keyboard,
  Mouse,
  RESOLUTION_AUTO,
  TONEMAP_ACES,
} from 'playcanvas';
import './flight.css';
import { buildAirplane } from './flight/airplane';
import { createCameraRig } from './flight/cameras';
import { createCockpit } from './flight/cockpit';
import { createFlightController } from './flight/flight';
import { createHud } from './flight/hud';
import { createFlightState, type FlightContext, type FlightModule } from './flight/types';
import { SKY_HORIZON, buildWorld } from './flight/world';

const canvas = document.getElementById('app') as HTMLCanvasElement;
const app = new Application(canvas, {
  keyboard: new Keyboard(window),
  mouse: new Mouse(canvas),
});
app.setCanvasFillMode(FILLMODE_FILL_WINDOW);
app.setCanvasResolution(RESOLUTION_AUTO);
window.addEventListener('resize', () => app.resizeCanvas());
app.start();

// Luz de fim de tarde + névoa na cor do horizonte (esconde a borda do mundo)
app.scene.ambientLight = new Color(0.55, 0.48, 0.55);
app.scene.fog.type = FOG_LINEAR;
app.scene.fog.color = SKY_HORIZON.clone();
app.scene.fog.start = 900;
app.scene.fog.end = 4200;

const sun = new Entity('Sun');
sun.addComponent('light', {
  type: 'directional',
  color: new Color(1, 0.8, 0.6),
  intensity: 1.7,
  castShadows: false,
});
sun.setEulerAngles(58, 125, 0);
app.root.addChild(sun);

const world = buildWorld(app);
const plane = buildAirplane(app);

const camera = new Entity('Camera');
camera.addComponent('camera', {
  clearColor: SKY_HORIZON.clone(),
  fov: 65,
  nearClip: 0.3,
  farClip: 12000,
  toneMapping: TONEMAP_ACES,
});
app.root.addChild(camera);

const ctx: FlightContext = { app, world, plane, camera, state: createFlightState() };

// Ordem fixa (contrato em types.ts): voo → câmeras → cabine → HUD
const modules: FlightModule[] = [
  createFlightController(ctx),
  createCameraRig(ctx),
  createCockpit(ctx),
  createHud(ctx),
];

app.on('update', (dt: number) => {
  dt = Math.min(dt, 0.05);
  for (const m of modules) m.update(dt);
  // O céu acompanha a câmera (parece infinito)
  world.sky.setPosition(camera.getPosition());
});

// Depuração pelo console do navegador
Object.assign(window, { app, flight: ctx.state });
