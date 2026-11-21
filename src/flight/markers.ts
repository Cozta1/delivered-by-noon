import {
  BLEND_ADDITIVE,
  Color,
  Entity,
  Mesh,
  MeshInstance,
  Quat,
  StandardMaterial,
  Vec3,
  createCylinder,
} from 'playcanvas';
import type { DeliveryPoint, FlightContext, FlightModule, Stage } from './types';
import { getRuntime } from './ui/settings';

const MAX_MARKERS = 16;

interface MarkerSlot {
  root: Entity;
  beam: Entity;
  ringOuter: Entity;
  ringInner: Entity;
  beamMi: MeshInstance | null;
  outerMi: MeshInstance | null;
  innerMi: MeshInstance | null;
}

function makeBeaconMaterial(r: number, g: number, b: number, opacity: number, intensity = 2.0): StandardMaterial {
  const m = new StandardMaterial();
  m.useLighting = false;
  m.useFog = false;
  m.diffuse = new Color(0, 0, 0);
  m.emissive = new Color(r, g, b);
  m.emissiveIntensity = intensity;
  m.opacity = opacity;
  m.blendType = BLEND_ADDITIVE;
  m.depthWrite = false;
  m.update();
  return m;
}

function formatDistance(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters)} m`;
}

/**
 * Marcadores 3D nas entregas pendentes do estágio atual (coluna de luz + anéis no chão,
 * visíveis de longe e à noite, com a próxima entrega destacada) + seta na borda da tela
 * quando a entrega ativa estiver fora do campo de visão.
 */
export function createMarkers(ctx: FlightContext, uiRoot?: HTMLElement | null): FlightModule {
  const { app, camera, state } = ctx;
  const ui = uiRoot ?? (typeof document !== 'undefined' ? document.getElementById('ui') : null);

  // Materiais aditivos (sem iluminação e sem névoa → visíveis de longe e à noite)
  const matNextBeam = makeBeaconMaterial(1.0, 0.8, 0.16, 0.42, 2.6);
  const matNextRing = makeBeaconMaterial(1.0, 0.88, 0.28, 0.88, 3.0);
  const matOtherBeam = makeBeaconMaterial(0.16, 0.9, 0.82, 0.24, 1.9);
  const matOtherRing = makeBeaconMaterial(0.24, 0.95, 0.88, 0.68, 2.2);
  const matAirBeam = makeBeaconMaterial(0.24, 0.72, 1.0, 0.44, 2.7);
  const matAirRing = makeBeaconMaterial(0.45, 0.92, 1.0, 0.9, 3.1);
  const matLeadBeam = makeBeaconMaterial(1.0, 0.32, 0.78, 0.42, 2.6);
  const matLeadRing = makeBeaconMaterial(1.0, 0.56, 0.9, 0.9, 3.0);

  const allMaterials = [
    matNextBeam,
    matNextRing,
    matOtherBeam,
    matOtherRing,
    matAirBeam,
    matAirRing,
    matLeadBeam,
    matLeadRing,
  ];

  const sharedCylinder: Mesh | null = app.graphicsDevice
    ? createCylinder(app.graphicsDevice, { radius: 0.5, height: 1, heightSegments: 1, capSegments: 14 })
    : null;

  const markersRoot = new Entity('DeliveryMarkers', app);
  app.root.addChild(markersRoot);

  const slots: MarkerSlot[] = [];

  function makePart(
    name: string,
    parent: Entity,
    mat: StandardMaterial,
  ): { entity: Entity; mi: MeshInstance | null } {
    const e = new Entity(name, app);
    let mi: MeshInstance | null = null;
    if (sharedCylinder) {
      mi = new MeshInstance(sharedCylinder, mat);
      e.addComponent('render', {
        meshInstances: [mi],
        castShadows: false,
        receiveShadows: false,
      });
    } else {
      e.addComponent('render', {
        type: 'cylinder',
        material: mat,
        castShadows: false,
        receiveShadows: false,
      });
      mi = e.render?.meshInstances?.[0] ?? null;
    }
    parent.addChild(e);
    return { entity: e, mi };
  }

  for (let i = 0; i < MAX_MARKERS; i++) {
    const root = new Entity(`DeliveryMarker_${i}`, app);
    root.enabled = false;
    markersRoot.addChild(root);

    const beam = makePart('beam', root, matOtherBeam);
    const ringOuter = makePart('ringOuter', root, matOtherRing);
    const ringInner = makePart('ringInner', root, matOtherRing);

    slots.push({
      root,
      beam: beam.entity,
      ringOuter: ringOuter.entity,
      ringInner: ringInner.entity,
      beamMi: beam.mi,
      outerMi: ringOuter.mi,
      innerMi: ringInner.mi,
    });
  }

  // Seta na borda da tela quando a entrega destacada estiver fora da visão
  let edgeArrow: HTMLDivElement | null = null;
  let edgeChevron: HTMLDivElement | null = null;
  let edgeLabel: HTMLDivElement | null = null;
  if (ui && typeof document !== 'undefined') {
    edgeArrow = document.createElement('div');
    edgeArrow.className = 'hud-edge-arrow';
    edgeArrow.hidden = true;

    edgeChevron = document.createElement('div');
    edgeChevron.className = 'hud-edge-chevron';

    edgeLabel = document.createElement('div');
    edgeLabel.className = 'hud-edge-label';

    edgeArrow.append(edgeChevron, edgeLabel);
    ui.append(edgeArrow);
  }

  const canvas = (app.graphicsDevice as { canvas?: HTMLCanvasElement } | undefined)?.canvas ?? null;
  const camPos = new Vec3();
  const camRot = new Quat();
  const camFwd = new Vec3();
  const targetPt = new Vec3();
  const delta = new Vec3();
  const screenPt = new Vec3();

  let pulseTime = 0;
  let lastArrowVisible = false;
  let lastArrowText = '';
  let destroyed = false;

  function hideAll() {
    for (let i = 0; i < slots.length; i++) {
      slots[i].root.enabled = false;
    }
    if (edgeArrow && lastArrowVisible) {
      lastArrowVisible = false;
      edgeArrow.hidden = true;
    }
  }

  function selectActiveDeliveries(): { pending: DeliveryPoint[]; next: DeliveryPoint | null } {
    const mission = ctx.mission;
    if (!mission || mission.status !== 'playing' || mission.deliveries.length === 0) {
      return { pending: [], next: null };
    }

    const activeStage: Stage = mission.carrying ?? mission.stage;
    const allStagePending: DeliveryPoint[] = [];
    let next: DeliveryPoint | null = null;

    for (let i = 0; i < mission.deliveries.length; i++) {
      const d = mission.deliveries[i];
      if (d.delivered || d.stage !== activeStage) continue;
      allStagePending.push(d);
      if (mission.nextDeliveryId && d.id === mission.nextDeliveryId) {
        next = d;
      }
    }

    // Espelha a regra do mission.ts: a última entrega do estágio (leadsToNext / a29-4) só ativa após as demais
    const pending =
      allStagePending.length > 1
        ? allStagePending.filter((p) => !p.leadsToNext && p.id !== 'a29-4')
        : allStagePending;

    // Se nextDeliveryId aponta para outro estágio ainda pendente, garanta visibilidade
    if (!next && mission.nextDeliveryId) {
      for (let i = 0; i < mission.deliveries.length; i++) {
        const d = mission.deliveries[i];
        if (!d.delivered && d.id === mission.nextDeliveryId) {
          next = d;
          if (!pending.includes(d)) pending.push(d);
          break;
        }
      }
    }

    // Fallback: entrega pendente mais próxima
    if (!next && pending.length > 0) {
      let bestDistSq = Infinity;
      for (let i = 0; i < pending.length; i++) {
        const d = pending[i];
        const dx = d.x - state.x;
        const dz = d.z - state.z;
        const dSq = dx * dx + dz * dz;
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          next = d;
        }
      }
    }

    return { pending, next };
  }

  function updateEdgeArrow(next: DeliveryPoint | null, showHud: boolean) {
    if (!edgeArrow || !edgeChevron || !edgeLabel) return;
    const cam = camera.camera;
    if (!next || !showHud || !cam) {
      if (lastArrowVisible) {
        lastArrowVisible = false;
        edgeArrow.hidden = true;
      }
      return;
    }

    const cw = canvas?.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 0);
    const ch = canvas?.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 0);
    if (cw <= 0 || ch <= 0) return;

    cam.onAppPrerender?.();
    camPos.copy(camera.getPosition());
    camRot.copy(camera.getRotation());
    camRot.transformVector(Vec3.FORWARD, camFwd);

    targetPt.set(next.x, next.y + (next.airDrop ? 18 : 6), next.z);
    delta.sub2(targetPt, camPos);
    const inFront = delta.dot(camFwd) > 0;

    cam.worldToScreen(targetPt, screenPt, cw, ch);
    const marginX = 48;
    const marginTop = 86;
    const marginBottom = 64;

    const onScreen =
      inFront &&
      Number.isFinite(screenPt.x) &&
      Number.isFinite(screenPt.y) &&
      screenPt.x >= marginX &&
      screenPt.x <= cw - marginX &&
      screenPt.y >= marginTop &&
      screenPt.y <= ch - marginBottom;

    if (onScreen) {
      if (lastArrowVisible) {
        lastArrowVisible = false;
        edgeArrow.hidden = true;
      }
      return;
    }

    const cx = cw * 0.5;
    const cy = ch * 0.5;
    let dx = screenPt.x - cx;
    let dy = screenPt.y - cy;
    if (!inFront) {
      dx = -dx;
      dy = -dy;
    }
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 1e-3) {
      dx = 0;
      dy = -1;
    }

    const maxX = Math.max(20, cx - marginX);
    const maxY = Math.max(20, cy - Math.max(marginTop, marginBottom));
    const scale = Math.max(Math.abs(dx) / maxX, Math.abs(dy) / maxY, 1e-4);
    const ex = Math.max(marginX, Math.min(cw - marginX, cx + dx / scale));
    const ey = Math.max(marginTop, Math.min(ch - marginBottom, cy + dy / scale));
    const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;

    const dist = Math.hypot(next.x - state.x, next.z - state.z);
    const labelText = formatDistance(dist);
    if (labelText !== lastArrowText) {
      lastArrowText = labelText;
      edgeLabel.textContent = labelText;
    }

    edgeArrow.classList.toggle('hud-edge-arrow--airdrop', Boolean(next.airDrop));
    edgeArrow.style.transform = `translate3d(${Math.round(ex)}px, ${Math.round(ey)}px, 0) translate(-50%, -50%)`;
    edgeChevron.style.transform = `rotate(${angleDeg.toFixed(1)}deg)`;

    if (!lastArrowVisible) {
      lastArrowVisible = true;
      edgeArrow.hidden = false;
    }
  }

  return {
    update(dt: number) {
      if (destroyed) return;
      const rt = getRuntime(state);
      if (rt.mode !== 'playing' || !ctx.mission || ctx.mission.status !== 'playing') {
        hideAll();
        return;
      }

      if (Number.isFinite(dt) && dt > 0) {
        pulseTime = (pulseTime + dt) % (Math.PI * 200);
      }

      const { pending, next } = selectActiveDeliveries();
      const isAir = state.vehicle === 'a29' || state.vehicle === 'heli';

      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        if (i >= pending.length) {
          slot.root.enabled = false;
          continue;
        }

        const d = pending[i];
        const isNext = next !== null && d.id === next.id;
        const pulse = 0.5 + 0.5 * Math.sin(pulseTime * (isNext ? 4.4 : 2.3) + i * 0.9);

        const beamMat = d.airDrop
          ? matAirBeam
          : d.leadsToNext
            ? matLeadBeam
            : isNext
              ? matNextBeam
              : matOtherBeam;
        const ringMat = d.airDrop
          ? matAirRing
          : d.leadsToNext
            ? matLeadRing
            : isNext
              ? matNextRing
              : matOtherRing;

        if (slot.beamMi && slot.beamMi.material !== beamMat) slot.beamMi.material = beamMat;
        if (slot.outerMi && slot.outerMi.material !== ringMat) slot.outerMi.material = ringMat;
        if (slot.innerMi && slot.innerMi.material !== ringMat) slot.innerMi.material = ringMat;

        const baseRadius = Math.max(3.5, Math.min(d.radius || 8, 28));
        const beamH = isNext ? (isAir || d.airDrop ? 190 : 120) : isAir ? 120 : 70;
        const beamDiam = (isNext ? 3.2 : 1.9) * (0.9 + pulse * 0.25);

        slot.root.setPosition(d.x, d.y, d.z);
        slot.beam.setLocalPosition(0, beamH * 0.5, 0);
        slot.beam.setLocalScale(beamDiam, beamH, beamDiam);

        const outerDiam = baseRadius * 2 * (0.96 + pulse * (isNext ? 0.14 : 0.06));
        slot.ringOuter.setLocalPosition(0, 0.32, 0);
        slot.ringOuter.setLocalScale(outerDiam, 0.35, outerDiam);

        const innerDiam = baseRadius * (0.72 + pulse * 0.42);
        slot.ringInner.setLocalPosition(0, 0.55 + pulse * 0.4, 0);
        slot.ringInner.setLocalScale(innerDiam, 0.22, innerDiam);

        slot.root.enabled = true;
      }

      updateEdgeArrow(next, rt.settings.showHud);
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      markersRoot.destroy();
      sharedCylinder?.destroy();
      for (const m of allMaterials) m.destroy();
      edgeArrow?.remove();
    },
  };
}
