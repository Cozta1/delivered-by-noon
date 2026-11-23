import {
  type AppBase,
  type Asset,
  BLEND_NORMAL,
  BoundingBox,
  Color,
  type ContainerResource,
  Entity,
  type GraphNode,
  Mat4,
  type MeshInstance,
  StandardMaterial,
} from 'playcanvas';
import type { AirplaneModel } from '../airplane';

export function makeMaterial(r: number, g: number, b: number, gloss = 0.5, opacity = 1): StandardMaterial {
  const m = new StandardMaterial();
  m.diffuse = new Color(r, g, b);
  m.gloss = gloss;
  if (opacity < 1) {
    m.opacity = opacity;
    m.blendType = BLEND_NORMAL;
    m.depthWrite = false;
  }
  m.update();
  return m;
}

function isDescendantOrSelf(node: GraphNode, ancestor: GraphNode): boolean {
  let cur: GraphNode | null = node;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parent;
  }
  return false;
}

function relativeLocalMatrix(node: GraphNode, ancestor: GraphNode, out: Mat4): Mat4 {
  const chain: GraphNode[] = [];
  let cur: GraphNode | null = node;
  while (cur && cur !== ancestor) {
    chain.push(cur);
    cur = cur.parent;
  }
  out.setIdentity();
  const step = new Mat4();
  for (let i = chain.length - 1; i >= 0; i--) {
    const n = chain[i];
    step.setTRS(n.getLocalPosition(), n.getLocalRotation(), n.getLocalScale());
    out.mul(step);
  }
  return out;
}

export function collectVisualEntities(rootNode: Entity, out: Entity[] = []): Entity[] {
  if (rootNode.render || rootNode.model) out.push(rootNode);
  const children = rootNode.children;
  for (let i = 0; i < children.length; i++) {
    collectVisualEntities(children[i] as Entity, out);
  }
  return out;
}

export function collectNodesByPrefix(rootNode: Entity, prefixLower: string, out: Entity[] = []): Entity[] {
  if (rootNode.name.toLowerCase().startsWith(prefixLower)) out.push(rootNode);
  const children = rootNode.children;
  for (let i = 0; i < children.length; i++) {
    collectNodesByPrefix(children[i] as Entity, prefixLower, out);
  }
  return out;
}

export function computeLocalAabb(rootNode: Entity): BoundingBox | null {
  const visualEntities = collectVisualEntities(rootNode);
  const relMat = new Mat4();
  const tmpBox = new BoundingBox();
  let total: BoundingBox | null = null;

  const accumulate = (entity: Entity, meshInstances: ReadonlyArray<MeshInstance> | null | undefined) => {
    if (!meshInstances || meshInstances.length === 0) return;
    for (let j = 0; j < meshInstances.length; j++) {
      const mi = meshInstances[j];
      const meshAabb = mi?.mesh?.aabb;
      if (!meshAabb) continue;
      const refNode: GraphNode = mi.node && isDescendantOrSelf(mi.node, rootNode) ? mi.node : entity;
      relativeLocalMatrix(refNode, rootNode, relMat);
      tmpBox.setFromTransformedAabb(meshAabb, relMat);
      if (!total) {
        total = new BoundingBox(tmpBox.center.clone(), tmpBox.halfExtents.clone());
      } else {
        total.add(tmpBox);
      }
    }
  };

  for (let i = 0; i < visualEntities.length; i++) {
    const entity = visualEntities[i];
    accumulate(entity, entity.render?.meshInstances);
    accumulate(entity, entity.model?.meshInstances);
  }
  return total;
}

export function cornersHitboxFromAabb(aabb: BoundingBox): [number, number, number][] {
  const min = aabb.getMin();
  const max = aabb.getMax();
  const cx = (min.x + max.x) * 0.5;
  const cy = (min.y + max.y) * 0.5;
  const cz = (min.z + max.z) * 0.5;
  return [
    [min.x, min.y, min.z],
    [max.x, min.y, min.z],
    [min.x, min.y, max.z],
    [max.x, min.y, max.z],
    [min.x, max.y, min.z],
    [max.x, max.y, min.z],
    [min.x, max.y, max.z],
    [max.x, max.y, max.z],
    [cx, min.y, cz],
    [cx, max.y, cz],
    [cx, cy, min.z],
    [cx, cy, max.z],
  ];
}

/**
 * URL de um GLB para `loadFromUrl(..., 'container')`.
 * No Editor online os .glb viram assets "scene" (fonte, fora do runtime); o publicador envia
 * uma cópia binária `<arquivo>.glb.bin` que existe no Launch/Publish, e o parser GLB é o padrão.
 * Localmente cai em `${BASE_URL}models/<arquivo>`.
 */
export function glbUrl(app: AppBase, filename: string): string {
  const bin = app.assets?.find?.(`${filename}.bin`, 'binary') as Asset | null | undefined;
  const fileUrl = bin?.getFileUrl?.();
  if (fileUrl) return fileUrl;
  const rawBase = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  const base = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;
  return `${base}models/${filename}`;
}

export function findGlbContainerAsset(app: AppBase, filename: string): Asset | null {
  const assets = app.assets;
  if (!assets) return null;
  const direct = assets.find?.(filename, 'container');
  if (direct) return direct;
  const lower = filename.toLowerCase();
  const base = lower.replace(/\.glb$/i, '');
  const matches = assets.filter?.((a) => {
    if (a.type !== 'container') return false;
    const name = (a.name ?? '').toLowerCase();
    const file = ((a.file as { filename?: string } | null)?.filename ?? '').toLowerCase();
    return name === lower || name === base || file.endsWith(lower);
  });
  return matches?.[0] ?? null;
}

export interface GlbLoadItem {
  id: string;
  filename: string;
  done: boolean;
}

type GlbLoadListener = (items: ReadonlyArray<GlbLoadItem>) => void;

interface GlbLoadRegistry {
  items: Map<string, GlbLoadItem>;
  listeners: Set<GlbLoadListener>;
  seq: number;
}

const glbRegistries = new WeakMap<AppBase, GlbLoadRegistry>();

function getGlbRegistry(app: AppBase): GlbLoadRegistry {
  let reg = glbRegistries.get(app);
  if (!reg) {
    reg = { items: new Map(), listeners: new Set(), seq: 0 };
    glbRegistries.set(app, reg);
  }
  return reg;
}

function notifyGlbRegistry(reg: GlbLoadRegistry): void {
  if (reg.listeners.size === 0) return;
  const snap = [...reg.items.values()];
  for (const cb of reg.listeners) cb(snap);
}

/** Permite à tela de carregamento acompanhar em tempo real os GLBs iniciados por `attachAsyncGlb`. */
export function subscribeGlbLoads(app: AppBase, listener: GlbLoadListener): () => void {
  const reg = getGlbRegistry(app);
  reg.listeners.add(listener);
  listener([...reg.items.values()]);
  return () => {
    reg.listeners.delete(listener);
  };
}

function registerGlbTask(app: AppBase, filename: string): () => void {
  const reg = getGlbRegistry(app);
  const id = `${filename}#${++reg.seq}`;
  reg.items.set(id, { id, filename, done: false });
  notifyGlbRegistry(reg);
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    const item = reg.items.get(id);
    if (item) item.done = true;
    notifyGlbRegistry(reg);
  };
}

/** Garante frustum culling ativo em todas as entidades e mesh instances sob `rootNode`. */
export function enableFrustumCulling(rootNode: Entity): void {
  if (rootNode.render?.meshInstances) {
    const mis = rootNode.render.meshInstances;
    for (let i = 0; i < mis.length; i++) {
      if (mis[i]) mis[i].cull = true;
    }
  }
  if (rootNode.model?.meshInstances) {
    const mis = rootNode.model.meshInstances;
    for (let i = 0; i < mis.length; i++) {
      if (mis[i]) mis[i].cull = true;
    }
  }
  const children = rootNode.children;
  for (let i = 0; i < children.length; i++) {
    enableFrustumCulling(children[i] as Entity);
  }
}

export interface AttachGlbOptions {
  app: AppBase;
  root: Entity;
  procedural: Entity;
  model: AirplaneModel;
  filename: string;
  onMounted?: (glbRoot: Entity, aabb: BoundingBox | null) => void;
}

/**
 * Carrega um GLB (asset container no Editor ou `${BASE_URL}models/${filename}` local)
 * e substitui o modelo procedural in-place, mantendo o contrato `AirplaneModel`.
 */
export function attachAsyncGlb({ app, root, procedural, model, filename, onMounted }: AttachGlbOptions): void {
  if (!app.assets) return;

  let destroyed = false;
  let applied = false;
  const finishLoad = registerGlbTask(app, filename);

  root.once('destroy', () => {
    destroyed = true;
    finishLoad();
  });

  function applyResource(resource: ContainerResource) {
    if (destroyed || applied || !root.parent || typeof resource.instantiateRenderEntity !== 'function') return;
    const glbRoot = resource.instantiateRenderEntity({ castShadows: false, receiveShadows: false });
    if (!glbRoot) return;
    applied = true;

    const showExterior = model.exterior.length === 0 ? true : (model.exterior[0].render?.enabled ?? true);
    root.addChild(glbRoot);
    enableFrustumCulling(glbRoot);

    const glbExterior = collectVisualEntities(glbRoot);
    for (let i = 0; i < glbExterior.length; i++) {
      const r = glbExterior[i].render;
      if (r) r.enabled = showExterior;
      const m = glbExterior[i].model;
      if (m) m.enabled = showExterior;
    }

    const aabb = computeLocalAabb(glbRoot);
    if (aabb && aabb.halfExtents.x > 0.05 && aabb.halfExtents.y > 0.05 && aabb.halfExtents.z > 0.05) {
      const nextHitbox = cornersHitboxFromAabb(aabb);
      model.hitbox.length = 0;
      for (let i = 0; i < nextHitbox.length; i++) model.hitbox.push(nextHitbox[i]);
      const min = aabb.getMin();
      const max = aabb.getMax();
      const midY = (min.y + max.y) * 0.5;
      const midZ = (min.z + max.z) * 0.5;
      model.wingTips[0].setLocalPosition(min.x, midY, midZ);
      model.wingTips[1].setLocalPosition(max.x, midY, midZ);
    }

    onMounted?.(glbRoot, aabb);

    const resMats = (resource as { materials?: Asset[] }).materials;
    if (Array.isArray(resMats)) {
      for (let i = 0; i < resMats.length; i++) {
        const resMat = resMats[i]?.resource;
        if (resMat instanceof StandardMaterial && !model.materials.includes(resMat)) {
          model.materials.push(resMat);
        }
      }
    }

    model.exterior.length = 0;
    for (let i = 0; i < glbExterior.length; i++) model.exterior.push(glbExterior[i]);
    procedural.destroy();
  }

  // No Editor o container importado fica velho (o Editor não reimporta o GLB); a cópia binária
  // `<arquivo>.glb.bin` enviada pelo publicador é sempre a versão atual, igual à local.
  const hasFreshBinary = !!app.assets.find?.(`${filename}.bin`, 'binary');
  const editorAsset = hasFreshBinary ? null : findGlbContainerAsset(app, filename);
  if (editorAsset) {
    if (editorAsset.resource) {
      applyResource(editorAsset.resource as ContainerResource);
      finishLoad();
    } else {
      editorAsset.ready((loaded) => {
        if (loaded.resource) applyResource(loaded.resource as ContainerResource);
        finishLoad();
      });
      editorAsset.once?.('error', () => finishLoad());
      app.assets.load(editorAsset);
    }
    return;
  }

  if (typeof app.assets.loadFromUrl === 'function') {
    const url = glbUrl(app, filename);
    try {
      app.assets.loadFromUrl(url, 'container', (err, asset) => {
        if (!err && asset?.resource) {
          applyResource(asset.resource as ContainerResource);
        } else {
          console.warn(`[Delivered by Noon] não carregou ${filename} (${url}):`, err);
        }
        finishLoad();
      });
    } catch {
      // Sem arquivo ou loader: mantém o fallback procedural
      finishLoad();
    }
  } else {
    finishLoad();
  }
}
