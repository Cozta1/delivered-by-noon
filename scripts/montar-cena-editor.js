// ============================================================================
// Monta a cena do simulador "Horizonte Dourado" (A-29) no PlayCanvas Editor.
//
// COMO USAR (UMA VEZ):
// 1. Abra a cena do projeto no PlayCanvas Editor (playcanvas.com/editor/...).
// 2. Pressione F12 e abra a aba "Console".
// 3. Cole este arquivo inteiro no Console e pressione Enter.
// 4. Confira as entidades criadas na Hierarchy e no Viewport; depois clique em Launch.
//
// Segurança: 100% local no navegador usando apenas a Editor API oficial (`editor`).
// Não envia dados para fora e pode ser executado novamente sem duplicar entidades.
// ============================================================================
(async function montarCenaHorizonteDourado() {
  if (typeof editor === 'undefined') {
    console.error('[Horizonte Dourado] Global `editor` não encontrado. Execute este snippet na aba do PlayCanvas Editor.');
    return;
  }

  const globals = editor.api && editor.api.globals ? editor.api.globals : editor;
  const entitiesApi = globals.entities || editor.entities;
  const assetsApi = globals.assets || editor.assets;
  const settingsApi = globals.settings || editor.settings;

  if (!entitiesApi || !assetsApi || !entitiesApi.root) {
    console.error('[Horizonte Dourado] Editor API indisponível (aguarde a cena terminar de carregar e tente novamente).');
    return;
  }

  const root = entitiesApi.root;
  const allAssets = typeof assetsApi.list === 'function' ? assetsApi.list() : [];

  // --- Helpers de consulta na Editor API ---
  const getVal = (obj, path) => (obj && typeof obj.get === 'function' ? obj.get(path) : undefined);

  function listEntities() {
    return typeof entitiesApi.list === 'function' ? entitiesApi.list() : [];
  }

  function findDirectChildByName(parent, name) {
    const parentId = getVal(parent, 'resource_id');
    return (
      listEntities().find(
        (e) => getVal(e, 'name') === name && getVal(e, 'parent') === parentId,
      ) || null
    );
  }

  function findChildren(parent) {
    const parentId = getVal(parent, 'resource_id');
    return listEntities().filter((e) => getVal(e, 'parent') === parentId);
  }

  async function removeEntity(entity) {
    if (!entity) return;
    if (typeof entity.delete === 'function') {
      await entity.delete({ history: true });
    } else if (typeof entitiesApi.delete === 'function') {
      await entitiesApi.delete([entity], { history: true });
    }
  }

  async function ensureEntity(name, opts) {
    let entity = findDirectChildByName(root, name);
    if (!entity) {
      entity = await entitiesApi.create(
        {
          name,
          parent: root,
          position: opts.position || [0, 0, 0],
          rotation: opts.rotation || [0, 0, 0],
          scale: opts.scale || [1, 1, 1],
          enabled: true,
        },
        { history: true },
      );
      console.log(`[Horizonte Dourado] Entidade criada: ${name}`);
    } else {
      entity.set('enabled', true);
      if (opts.position) entity.set('position', opts.position);
      if (opts.rotation) entity.set('rotation', opts.rotation);
      if (opts.scale) entity.set('scale', opts.scale);
      console.log(`[Horizonte Dourado] Entidade atualizada: ${name}`);
    }
    return entity;
  }

  function ensureComponent(entity, type, props) {
    if (!getVal(entity, `components.${type}`)) {
      entity.addComponent(type, props);
    } else {
      for (const [k, v] of Object.entries(props)) {
        entity.set(`components.${type}.${k}`, v);
      }
    }
  }

  function assetFileName(asset) {
    const file = getVal(asset, 'file');
    const fn = file && typeof file === 'object' ? file.filename : getVal(asset, 'file.filename');
    return String(fn || getVal(asset, 'name') || '');
  }

  function normalizeBaseName(raw) {
    return String(raw || '')
      .trim()
      .toLowerCase()
      .replace(/\.glb$/i, '');
  }

  // Encontra o template (preferencial) ou os render assets associados a um arquivo GLB
  function resolveGlbGroup(matcherFn) {
    const matchedSources = allAssets.filter(
      (a) => getVal(a, 'source') === true && matcherFn(assetFileName(a), String(getVal(a, 'name') || '')),
    );

    const groups = new Map();

    for (const src of matchedSources) {
      const srcId = String(getVal(src, 'id'));
      const base = normalizeBaseName(assetFileName(src) || getVal(src, 'name'));
      const derived = allAssets.filter((a) => String(getVal(a, 'source_asset_id') || '') === srcId);
      const template = derived.find((a) => getVal(a, 'type') === 'template') || null;
      const renders = derived.filter((a) => getVal(a, 'type') === 'render');
      groups.set(base, { label: String(getVal(src, 'name') || base), template, renders });
    }

    // Fallback: caso algum template/render tenha sido encontrado pelo nome mesmo sem source listado
    for (const a of allAssets) {
      const type = getVal(a, 'type');
      if (type !== 'template' && type !== 'render') continue;
      const name = String(getVal(a, 'name') || '');
      if (!matcherFn(assetFileName(a), name)) continue;
      const base = normalizeBaseName(name);
      if (!groups.has(base)) {
        groups.set(base, {
          label: name,
          template: type === 'template' ? a : null,
          renders: type === 'render' ? [a] : [],
        });
      } else {
        const g = groups.get(base);
        if (type === 'template' && !g.template) g.template = a;
        if (type === 'render' && !g.renders.includes(a)) g.renders.push(a);
      }
    }

    return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
  }

  async function instantiateGlbGroup(group, parentEntity) {
    if (group.template) {
      if (typeof group.template.instantiateTemplate === 'function') {
        const inst = await group.template.instantiateTemplate(parentEntity, { history: true });
        if (inst) {
          inst.set('position', [0, 0, 0]);
          inst.set('rotation', [0, 0, 0]);
          inst.set('scale', [1, 1, 1]);
          return `template "${group.label}"`;
        }
      }
      if (typeof assetsApi.instantiateTemplates === 'function') {
        const list = await assetsApi.instantiateTemplates([group.template], parentEntity, { history: true });
        const inst = Array.isArray(list) ? list[0] : list;
        if (inst) {
          inst.set('position', [0, 0, 0]);
          inst.set('rotation', [0, 0, 0]);
          inst.set('scale', [1, 1, 1]);
          return `template "${group.label}"`;
        }
      }
    }

    if (group.renders.length > 0) {
      for (const renderAsset of group.renders) {
        const renderId = Number(getVal(renderAsset, 'id'));
        const renderName = String(getVal(renderAsset, 'name') || group.label);
        await entitiesApi.create(
          {
            name: renderName,
            parent: parentEntity,
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
            enabled: true,
            components: {
              render: {
                type: 'asset',
                asset: renderId,
                castShadows: false,
                receiveShadows: false,
              },
            },
          },
          { history: true },
        );
      }
      return `${group.renders.length} render(s) de "${group.label}"`;
    }

    return null;
  }

  // --- 1. Desativar entidades padrão e antigas do projeto ---
  const LEGACY_NAMES = new Set(['Camera', 'Light', 'Player', 'Ground', 'Plane']);
  const LEGACY_SCRIPTS = ['playerMovement', 'cameraFollow', 'gunController'];
  const OUR_NAMES = new Set(['Jogo', 'Mundo', 'A29', 'CameraJogo', 'Sol']);
  const disabledNames = [];

  for (const entity of listEntities()) {
    const name = String(getVal(entity, 'name') || '');
    if (OUR_NAMES.has(name)) continue;

    if (LEGACY_NAMES.has(name) && getVal(entity, 'enabled') !== false) {
      entity.set('enabled', false);
      disabledNames.push(name);
    }

    // Desativa scripts antigos caso estejam ligados em outra entidade (ex.: Root)
    const scriptsObj = getVal(entity, 'components.script.scripts');
    if (scriptsObj && typeof scriptsObj === 'object') {
      for (const oldScript of LEGACY_SCRIPTS) {
        if (scriptsObj[oldScript] && scriptsObj[oldScript].enabled !== false) {
          entity.set(`components.script.scripts.${oldScript}.enabled`, false);
          disabledNames.push(`${name}.${oldScript}`);
        }
      }
    }
  }

  // --- 2. Entidade "Jogo" com o script clássico "simuladorVoo" ---
  const jogo = await ensureEntity('Jogo', { position: [0, 0, 0], rotation: [0, 0, 0] });
  const scriptOrder = getVal(jogo, 'components.script.order') || [];
  if (!scriptOrder.includes('simuladorVoo') && !scriptOrder.includes('flightSim')) {
    const hasClassic = allAssets.some((a) => {
      const scripts = getVal(a, 'data.scripts');
      return scripts && typeof scripts === 'object' && 'simuladorVoo' in scripts;
    });
    const hasEsm = allAssets.some((a) => String(getVal(a, 'name') || '').toLowerCase() === 'flight-sim.mjs');
    const scriptName = hasClassic ? 'simuladorVoo' : hasEsm ? 'flightSim' : 'simuladorVoo';
    let attached = false;
    try {
      if (typeof jogo.addScript === 'function') {
        await jogo.addScript(scriptName, { history: true });
        attached = true;
      } else if (typeof entitiesApi.addScript === 'function') {
        await entitiesApi.addScript([jogo], scriptName, { history: true });
        attached = true;
      }
    } catch (err) {
      console.warn(`[Horizonte Dourado] Aviso ao anexar script "${scriptName}" via addScript:`, err);
    }
    if (!attached) {
      ensureComponent(jogo, 'script', {
        enabled: true,
        order: [scriptName],
        scripts: { [scriptName]: { enabled: true, attributes: {} } },
      });
    }
    console.log(`[Horizonte Dourado] Script "${scriptName}" anexado em Jogo.`);
  } else {
    console.log('[Horizonte Dourado] Script já anexado em Jogo (mantido sem duplicar).');
  }

  // --- 3. Entidade "Sol" (luz direcional de fim de tarde) ---
  const sol = await ensureEntity('Sol', { position: [0, 300, 0], rotation: [58, 125, 0] });
  ensureComponent(sol, 'light', {
    enabled: true,
    type: 'directional',
    color: [1, 0.8, 0.6],
    intensity: 1.7,
    castShadows: false,
  });

  // --- 4. Entidade "CameraJogo" (enquadramento inicial atrás do A-29) ---
  const cam = await ensureEntity('CameraJogo', { position: [0, 187.2, 746], rotation: [-15.5, 0, 0] });
  ensureComponent(cam, 'camera', {
    enabled: true,
    clearColor: [0.98, 0.72, 0.55, 1],
    fov: 65,
    nearClip: 1,
    farClip: 6000,
    toneMapping: 3, // TONEMAP_ACES
  });

  // --- 5. Entidade "A29" (posição inicial SPAWN = [0, 180, 720]) ---
  const a29 = await ensureEntity('A29', { position: [0, 180, 720], rotation: [0, 0, 0], scale: [1, 1, 1] });
  // Limpa filhos antigos de A29 antes de re-instanciar (evita duplicatas ao rodar de novo)
  for (const child of findChildren(a29)) {
    await removeEntity(child);
  }
  const a29Groups = resolveGlbGroup(
    (file, name) => /^a29(\.glb)?$/i.test(file) || /^a29(\.glb)?$/i.test(name),
  );
  let a29Info = 'nenhum asset a29.glb encontrado (usará fallback procedural no Launch)';
  if (a29Groups.length > 0) {
    const mounted = await instantiateGlbGroup(a29Groups[0], a29);
    if (mounted) a29Info = mounted;
  }

  // --- 6. Entidade "Mundo" (filhos renderizáveis de todos os mundo-*.glb) ---
  const mundo = await ensureEntity('Mundo', { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
  for (const child of findChildren(mundo)) {
    await removeEntity(child);
  }
  const worldGroups = resolveGlbGroup(
    (file, name) => /^mundo-/i.test(file) || /^mundo-/i.test(name),
  );
  const mountedWorldParts = [];
  for (const g of worldGroups) {
    const info = await instantiateGlbGroup(g, mundo);
    if (info) mountedWorldParts.push(info);
  }

  // --- 7. Iluminação ambiente, névoa da cena e Settings -> Input -> Keyboard ---
  try {
    const sceneSettings = settingsApi && settingsApi.scene ? settingsApi.scene : null;
    if (sceneSettings && typeof sceneSettings.set === 'function') {
      sceneSettings.set('render.global_ambient', [0.55, 0.48, 0.55]);
      sceneSettings.set('render.fog', 'linear');
      sceneSettings.set('render.fog_color', [0.98, 0.72, 0.55]);
      sceneSettings.set('render.fog_start', 900);
      sceneSettings.set('render.fog_end', 4200);
    }
  } catch {
    // Opcional: o script do jogo também aplica luz ambiente e névoa no Launch
  }

  let keyboardConfigured = false;
  try {
    const projectSettings =
      (settingsApi && settingsApi.project) ||
      (typeof editor.call === 'function' ? editor.call('settings:project') : null);
    if (projectSettings && typeof projectSettings.set === 'function') {
      projectSettings.set('useKeyboard', true);
      keyboardConfigured = true;
    }
  } catch {
    keyboardConfigured = false;
  }

  // --- Resumo final no Console ---
  console.log('=== [Horizonte Dourado] Cena montada com sucesso ===');
  console.log('Entidades ativas: Jogo, Mundo, A29, CameraJogo, Sol');
  console.log(`A29: ${a29Info}`);
  console.log(
    `Mundo: ${mountedWorldParts.length > 0 ? mountedWorldParts.join(', ') : 'nenhum asset mundo-*.glb encontrado (o jogo criará o mundo procedural no Launch)'}`,
  );
  console.log(`Desativados: ${disabledNames.length > 0 ? disabledNames.join(', ') : 'nenhum item antigo ativo'}`);
  console.log(
    keyboardConfigured
      ? 'Settings → Input → Keyboard: ativado automaticamente.'
      : 'Settings → Input → Keyboard: confirme manualmente em Settings → Input → Keyboard.',
  );
  console.log('Dica: selecione "A29" na Hierarchy e pressione F no Viewport para focar o avião. Depois clique em Launch!');
})();
