import {
  Application,
  Color,
  Entity,
  FILLMODE_FILL_WINDOW,
  Keyboard,
  Mouse,
  RESOLUTION_AUTO,
  TONEMAP_ACES,
  Vec3,
  WasmModule,
} from 'playcanvas';
import { buildLevel, SPAWN } from './level';
import { FpsController, PLAYER_RADIUS, STAND_HEIGHT } from './scripts/fps-controller';
import { Weapon } from './scripts/weapon';
import { Hud } from './hud';

const base = import.meta.env.BASE_URL;

/** Carrega a física (ammo.js, versão WebAssembly com fallback em JS). */
function loadAmmo() {
  WasmModule.setConfig('Ammo', {
    glueUrl: `${base}ammo/ammo.wasm.js`,
    wasmUrl: `${base}ammo/ammo.wasm.wasm`,
    fallbackUrl: `${base}ammo/ammo.js`,
  });
  return new Promise<void>((resolve) => WasmModule.getInstance('Ammo', () => resolve()));
}

async function main() {
  await loadAmmo();

  const canvas = document.getElementById('app') as HTMLCanvasElement;
  const app = new Application(canvas, {
    keyboard: new Keyboard(window),
    mouse: new Mouse(canvas),
  });
  app.setCanvasFillMode(FILLMODE_FILL_WINDOW);
  app.setCanvasResolution(RESOLUTION_AUTO);
  window.addEventListener('resize', () => app.resizeCanvas());

  // Inicia antes de montar a cena: corpos estáticos/cinemáticos criados
  // antes do start ficavam sem forma de colisão (o jogador atravessava o chão).
  app.start();

  app.scene.ambientLight = new Color(0.5, 0.52, 0.58);

  // Luz do sol
  const sun = new Entity('Sun');
  sun.addComponent('light', {
    type: 'directional',
    color: new Color(1, 0.96, 0.9),
    intensity: 1.8,
    castShadows: true,
    shadowDistance: 60,
    shadowResolution: 2048,
    normalOffsetBias: 0.05,
    shadowBias: 0.2,
  });
  sun.setEulerAngles(50, 35, 0);
  app.root.addChild(sun);

  buildLevel(app);

  // Câmera (fica fora do jogador: o rigidbody controla a rotação dele)
  const camera = new Entity('Camera');
  camera.addComponent('camera', {
    clearColor: new Color(0.55, 0.68, 0.85),
    fov: 90,
    nearClip: 0.03,
    farClip: 400,
    toneMapping: TONEMAP_ACES,
  });
  app.root.addChild(camera);

  // Jogador: cápsula com física, sem render (primeira pessoa)
  const player = new Entity('Player');
  app.root.addChild(player);
  player.setPosition(SPAWN[0], SPAWN[1] + STAND_HEIGHT / 2 + 0.05, SPAWN[2]);
  player.addComponent('collision', { type: 'capsule', radius: PLAYER_RADIUS, height: STAND_HEIGHT, axis: 1 });
  player.addComponent('rigidbody', {
    type: 'dynamic',
    mass: 80,
    friction: 0,
    restitution: 0,
    linearDamping: 0,
    angularFactor: new Vec3(0, 0, 0),
  });
  player.addComponent('script');
  const controller = player.script!.create(FpsController, { properties: { camera } }) as FpsController;

  camera.addComponent('script');
  const weapon = camera.script!.create(Weapon, {}) as unknown as Weapon;
  weapon.controller = controller;

  const hud = new Hud(app, controller, weapon);

  // Tela de início / pausa: clique trava o mouse
  const overlay = document.getElementById('overlay')!;
  document.getElementById('loading')!.remove();
  overlay.addEventListener('click', () => app.mouse!.enablePointerLock());
  document.addEventListener('pointerlockchange', () => {
    overlay.classList.toggle('hidden', Mouse.isPointerLocked());
  });

  app.on('update', (dt: number) => hud.update(dt));

  // Útil para depurar pelo console do navegador
  Object.assign(window, { app, controller, weapon });
}

main();
