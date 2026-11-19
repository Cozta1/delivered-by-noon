import {
  DEFAULT_SETTINGS,
  type GameMode,
  type GameSettings,
  type QualityLevel,
  sanitizeSettings,
} from './settings';

export type MenuScreen = 'main' | 'options' | 'controls' | 'credits';

export interface MenuCallbacks {
  onStartFlight(): void;
  onResume(): void;
  onRestart(): void;
  onReturnTitle(): void;
  onSettingsChange(next: GameSettings): void;
  onButtonClick(confirm?: boolean): void;
}

export interface GameMenus {
  setMode(mode: GameMode): void;
  getScreen(): MenuScreen;
  back(): boolean;
  syncSettings(settings: GameSettings): void;
  destroy(): void;
}

const CONTROLS_LIST: ReadonlyArray<[string, string]> = [
  ['E', 'Entrar ou sair do veículo próximo (carro, helicóptero ou A-29)'],
  ['W / A / S / D', 'Andar (a pé), dirigir (carro) ou pilotar (aeronaves)'],
  ['Espaço', 'Freio de mão (carro) ou pular (a pé)'],
  ['Mouse', 'Gira a câmera (a pé/carro) ou move a mira (aeronaves)'],
  ['Clique esquerdo', 'Trava o ponteiro para girar a câmera / mirar'],
  ['Shift / Ctrl', 'Acelerador / coletivo (+ / − em aeronaves)'],
  ['Q / E', 'Leme / pedais em aeronaves'],
  ['M', 'Alterna entre controle por Mouse e Teclado (aeronaves)'],
  ['F', 'Liga / desliga a fumaça branca na cauda do A-29'],
  ['C / V', 'Alterna câmeras disponíveis para o veículo atual'],
  ['R', 'Reinicia o veículo atual'],
  ['Esc / P', 'Pausa o jogo e abre o menu (soltar o mouse também pausa)'],
];

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

export function createGameMenus(
  uiRoot: HTMLElement,
  initialSettings: GameSettings,
  callbacks: MenuCallbacks,
): GameMenus {
  let mode: GameMode = 'title';
  let screen: MenuScreen = 'main';
  let settings: GameSettings = { ...initialSettings };

  const overlay = node('div', 'menu-overlay menu-overlay--title');
  const card = node('div', 'menu-card');
  overlay.append(card);
  uiRoot.append(overlay);

  // --- Tela Principal (Título ou Pausa) ---
  const mainView = node('div', 'menu-view');
  const header = node('div', 'menu-header');
  const eyebrow = node('div', 'menu-eyebrow', 'MUNDO ABERTO DE VEÍCULOS');
  const titleEl = node('h1', 'menu-title', 'HORIZONTE DOURADO');
  const subtitleEl = node('p', 'menu-subtitle', 'Explore a cidade de carro, a pé, de helicóptero e no A-29');
  header.append(eyebrow, titleEl, subtitleEl);

  const actions = node('div', 'menu-actions');
  const btnPrimary = node('button', 'menu-btn menu-btn--primary', 'Jogar');
  btnPrimary.type = 'button';
  const btnRestart = node('button', 'menu-btn', 'Reiniciar');
  btnRestart.type = 'button';
  const btnOptions = node('button', 'menu-btn', 'Opções');
  btnOptions.type = 'button';
  const btnControls = node('button', 'menu-btn', 'Controles');
  btnControls.type = 'button';
  const btnCredits = node('button', 'menu-btn', 'Créditos');
  btnCredits.type = 'button';
  const btnReturnTitle = node('button', 'menu-btn menu-btn--ghost', 'Voltar ao início');
  btnReturnTitle.type = 'button';

  actions.append(btnPrimary, btnRestart, btnOptions, btnControls, btnCredits, btnReturnTitle);
  mainView.append(header, actions);

  // --- Subtela: Opções ---
  const optionsView = node('div', 'menu-view menu-subview');
  optionsView.hidden = true;
  const optTitle = node('h2', 'menu-section-title', 'OPÇÕES');
  const optList = node('div', 'menu-options-list');

  function makeRangeRow(
    label: string,
    min: number,
    max: number,
    step: number,
    format: (v: number) => string,
    onChange: (v: number) => void,
  ) {
    const row = node('label', 'menu-opt-row');
    const head = node('div', 'menu-opt-head');
    const lbl = node('span', 'menu-opt-label', label);
    const val = node('span', 'menu-opt-value');
    head.append(lbl, val);

    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'menu-range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.addEventListener('input', () => {
      const num = Number(input.value);
      val.textContent = format(num);
      onChange(num);
    });
    row.append(head, input);
    optList.append(row);
    return {
      setValue(v: number) {
        input.value = String(v);
        val.textContent = format(v);
      },
    };
  }

  function makeToggleRow(label: string, onChange: (checked: boolean) => void) {
    const row = node('label', 'menu-opt-toggle');
    const lbl = node('span', 'menu-opt-label', label);
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'menu-checkbox';
    input.addEventListener('change', () => {
      callbacks.onButtonClick();
      onChange(input.checked);
    });
    row.append(lbl, input);
    optList.append(row);
    return {
      setChecked(v: boolean) {
        input.checked = v;
      },
    };
  }

  function makeSegmentRow<T extends string>(
    label: string,
    items: ReadonlyArray<[T, string]>,
    onChange: (value: T) => void,
  ) {
    const row = node('div', 'menu-opt-row');
    const lbl = node('span', 'menu-opt-label', label);
    const group = node('div', 'menu-segments');
    const buttons = new Map<T, HTMLButtonElement>();
    for (const [value, text] of items) {
      const b = node('button', 'menu-seg-btn', text);
      b.type = 'button';
      b.addEventListener('click', () => {
        callbacks.onButtonClick();
        onChange(value);
      });
      buttons.set(value, b);
      group.append(b);
    }
    row.append(lbl, group);
    optList.append(row);
    return {
      setActive(current: T) {
        for (const [val, btn] of buttons) {
          btn.classList.toggle('is-active', val === current);
        }
      },
    };
  }

  function patchSettings(partial: Partial<GameSettings>) {
    settings = sanitizeSettings({ ...settings, ...partial });
    syncOptionInputs();
    callbacks.onSettingsChange({ ...settings });
  }

  const pct = (v: number) => `${Math.round(v * 100)}%`;

  const masterCtrl = makeRangeRow('Volume geral', 0, 1, 0.05, pct, (v) => patchSettings({ masterVolume: v }));
  const musicCtrl = makeRangeRow('Música', 0, 1, 0.05, pct, (v) => patchSettings({ musicVolume: v }));
  const sfxCtrl = makeRangeRow('Efeitos sonoros', 0, 1, 0.05, pct, (v) => patchSettings({ sfxVolume: v }));
  const sensCtrl = makeRangeRow(
    'Sensibilidade do mouse',
    0.05,
    0.4,
    0.01,
    (v) => `${(v / 0.15).toFixed(2)}×`,
    (v) => patchSettings({ mouseSensitivity: v }),
  );

  const invertCtrl = makeToggleRow('Inverter eixo Y (mouse)', (v) => patchSettings({ invertY: v }));
  const hudCtrl = makeToggleRow('Mostrar HUD em voo', (v) => patchSettings({ showHud: v }));

  const controlModeCtrl = makeSegmentRow<'mouse' | 'keyboard'>(
    'Modo de controle padrão',
    [
      ['mouse', 'Mouse'],
      ['keyboard', 'Teclado'],
    ],
    (v) => patchSettings({ defaultControlMode: v }),
  );

  const qualityCtrl = makeSegmentRow<QualityLevel>(
    'Qualidade gráfica',
    [
      ['low', 'Baixa'],
      ['medium', 'Média'],
      ['high', 'Alta'],
    ],
    (v) => patchSettings({ quality: v }),
  );

  const optFooter = node('div', 'menu-sub-footer');
  const btnResetDefaults = node('button', 'menu-btn menu-btn--ghost', 'Restaurar padrões');
  btnResetDefaults.type = 'button';
  const btnOptBack = node('button', 'menu-btn menu-btn--primary', 'Voltar');
  btnOptBack.type = 'button';
  optFooter.append(btnResetDefaults, btnOptBack);
  optionsView.append(optTitle, optList, optFooter);

  // --- Subtela: Controles ---
  const controlsView = node('div', 'menu-view menu-subview');
  controlsView.hidden = true;
  const ctrlTitle = node('h2', 'menu-section-title', 'CONTROLES');
  const ctrlTable = node('div', 'menu-controls-table');
  for (const [key, desc] of CONTROLS_LIST) {
    const row = node('div', 'menu-ctrl-row');
    row.append(node('span', 'menu-ctrl-key', key), node('span', 'menu-ctrl-desc', desc));
    ctrlTable.append(row);
  }
  const ctrlFooter = node('div', 'menu-sub-footer');
  const btnCtrlBack = node('button', 'menu-btn menu-btn--primary', 'Voltar');
  btnCtrlBack.type = 'button';
  ctrlFooter.append(btnCtrlBack);
  controlsView.append(ctrlTitle, ctrlTable, ctrlFooter);

  // --- Subtela: Créditos ---
  const creditsView = node('div', 'menu-view menu-subview');
  creditsView.hidden = true;
  const credTitle = node('h2', 'menu-section-title', 'CRÉDITOS');
  const credBody = node('div', 'menu-credits-body');
  const creditEntries: ReadonlyArray<[string, string]> = [
    ['Equipe', 'João Costa'],
    ['Física de voo', 'Física baseada no JSBSim (LGPL-2.1, JSBSim-Team)'],
    ['Modelos 3D', 'A-29, helicóptero, carros e personagem originais feitos no Blender'],
    ['Motor gráfico', 'PlayCanvas'],
    ['Áudio e interface', 'Trilha, motores, passos e interface procedurais em Web Audio API'],
  ];
  for (const [role, value] of creditEntries) {
    const item = node('div', 'menu-credit-item');
    item.append(node('span', 'menu-credit-role', role), node('span', 'menu-credit-name', value));
    credBody.append(item);
  }
  const credFooter = node('div', 'menu-sub-footer');
  const btnCredBack = node('button', 'menu-btn menu-btn--primary', 'Voltar');
  btnCredBack.type = 'button';
  credFooter.append(btnCredBack);
  creditsView.append(credTitle, credBody, credFooter);

  card.append(mainView, optionsView, controlsView, creditsView);

  function syncOptionInputs() {
    masterCtrl.setValue(settings.masterVolume);
    musicCtrl.setValue(settings.musicVolume);
    sfxCtrl.setValue(settings.sfxVolume);
    sensCtrl.setValue(settings.mouseSensitivity);
    invertCtrl.setChecked(settings.invertY);
    hudCtrl.setChecked(settings.showHud);
    controlModeCtrl.setActive(settings.defaultControlMode);
    qualityCtrl.setActive(settings.quality);
  }

  function renderView() {
    const visible = mode !== 'playing';
    overlay.hidden = !visible;
    overlay.className = `menu-overlay ${mode === 'title' ? 'menu-overlay--title' : 'menu-overlay--paused'}`;
    if (!visible) return;

    mainView.hidden = screen !== 'main';
    optionsView.hidden = screen !== 'options';
    controlsView.hidden = screen !== 'controls';
    creditsView.hidden = screen !== 'credits';

    if (mode === 'title') {
      eyebrow.textContent = 'MUNDO ABERTO DE VEÍCULOS';
      titleEl.textContent = 'HORIZONTE DOURADO';
      subtitleEl.textContent = 'Explore a cidade de carro, a pé, de helicóptero e no A-29';
      subtitleEl.hidden = false;
      btnPrimary.textContent = 'Jogar';
      btnRestart.hidden = true;
      btnCredits.hidden = false;
      btnReturnTitle.hidden = true;
    } else {
      eyebrow.textContent = 'HORIZONTE DOURADO';
      titleEl.textContent = 'PAUSADO';
      subtitleEl.textContent = 'Pressione Esc ou P para continuar';
      subtitleEl.hidden = false;
      btnPrimary.textContent = 'Continuar';
      btnRestart.hidden = false;
      btnCredits.hidden = true;
      btnReturnTitle.hidden = false;
    }
  }

  btnPrimary.addEventListener('click', () => {
    callbacks.onButtonClick(true);
    if (mode === 'title') callbacks.onStartFlight();
    else callbacks.onResume();
  });

  btnRestart.addEventListener('click', () => {
    callbacks.onButtonClick(true);
    callbacks.onRestart();
  });

  btnOptions.addEventListener('click', () => {
    callbacks.onButtonClick();
    screen = 'options';
    syncOptionInputs();
    renderView();
  });

  btnControls.addEventListener('click', () => {
    callbacks.onButtonClick();
    screen = 'controls';
    renderView();
  });

  btnCredits.addEventListener('click', () => {
    callbacks.onButtonClick();
    screen = 'credits';
    renderView();
  });

  btnReturnTitle.addEventListener('click', () => {
    callbacks.onButtonClick();
    callbacks.onReturnTitle();
  });

  btnResetDefaults.addEventListener('click', () => {
    callbacks.onButtonClick();
    patchSettings({ ...DEFAULT_SETTINGS });
  });

  const goMain = () => {
    callbacks.onButtonClick();
    screen = 'main';
    renderView();
  };
  btnOptBack.addEventListener('click', goMain);
  btnCtrlBack.addEventListener('click', goMain);
  btnCredBack.addEventListener('click', goMain);

  syncOptionInputs();
  renderView();

  return {
    setMode(nextMode: GameMode) {
      mode = nextMode;
      screen = 'main';
      renderView();
    },
    getScreen() {
      return screen;
    },
    back() {
      if (screen !== 'main') {
        screen = 'main';
        renderView();
        return true;
      }
      return false;
    },
    syncSettings(next: GameSettings) {
      settings = sanitizeSettings(next);
      syncOptionInputs();
    },
    destroy() {
      overlay.remove();
    },
  };
}
