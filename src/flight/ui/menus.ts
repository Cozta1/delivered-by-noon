import type { MissionState, Stage } from '../types';
import { CITY_CREDITS } from '../world-data';
import {
  DEFAULT_SETTINGS,
  type GameMode,
  type GameSettings,
  type QualityLevel,
  sanitizeSettings,
} from './settings';

export type MenuScreen = 'main' | 'story' | 'options' | 'controls' | 'credits' | 'result';

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
  setHiddenByLoading(hidden: boolean): void;
  getScreen(): MenuScreen;
  back(): boolean;
  syncSettings(settings: GameSettings): void;
  showStageUnlocked(stage: Stage): void;
  clearStageBanner(): void;
  showEndScreen(outcome: 'won' | 'lost', mission: MissionState): void;
  destroy(): void;
}

const STAGE_UNLOCK_COPY: Record<Stage, { title: string; subtitle: string; accent: string }> = {
  car: {
    title: 'Hatch da GoPostal liberado!',
    subtitle: 'Recado de Michael De Santa, o patrão: siga os marcadores luminosos pela cidade.',
    accent: 'car',
  },
  tuned: {
    title: 'Coupé Tunado liberado!',
    subtitle: 'Recado de Michael De Santa, o patrão: mete o Shift no nitro e parte para as entregas malucas!',
    accent: 'tuned',
  },
  heli: {
    title: 'Helicóptero liberado!',
    subtitle: 'Recado de Michael De Santa, o patrão: agora o trânsito ficou lá embaixo — suba nos telhados!',
    accent: 'heli',
  },
  a29: {
    title: 'Avião A-29 liberado!',
    subtitle: 'Reta final da GoPostal! Sobrevoe os alvos e aperte Espaço para soltar as caixas!',
    accent: 'a29',
  },
};

const STAGE_LABEL: Record<Stage, string> = {
  car: '1/4 · Hatch',
  tuned: '2/4 · Coupé Tunado',
  heli: '3/4 · Helicóptero',
  a29: '4/4 · Avião A-29',
};

const CONTROLS_LIST: ReadonlyArray<[string, string]> = [
  ['E', 'Entrar ou sair do veículo próximo (Hatch, Coupé Tunado, helicóptero ou A-29)'],
  ['W / A / S / D', 'Andar (a pé), dirigir (carros) ou pilotar (helicóptero e A-29)'],
  ['Shift', 'Nitro no Coupé Tunado · acelerador / coletivo (+) em aeronaves'],
  ['Ctrl', 'Reduzir acelerador / coletivo (−) em aeronaves'],
  ['Espaço', 'Freio de mão (carros), pular (a pé) ou soltar carga aérea (A-29)'],
  ['Mouse', 'Gira a câmera (a pé, carros e helicóptero) ou move a mira de voo (somente A-29)'],
  ['Clique esquerdo', 'Trava o ponteiro para girar a câmera / mirar no A-29'],
  ['Q / E', 'Leme / pedais em aeronaves'],
  ['M', 'Alterna entre controle por Mouse e Teclado (somente A-29)'],
  ['F', 'Liga / desliga a fumaça branca na cauda do A-29'],
  ['C / V', 'Alterna câmeras disponíveis para o veículo atual'],
  ['R', 'Reinicia o veículo atual'],
  ['Esc / P', 'Pausa o jogo e congela o relógio (soltar o mouse também pausa)'],
];

function formatClock(minutes: number): string {
  const clamped = Math.max(0, Math.min(1440, Math.floor(minutes)));
  if (clamped >= 1440) return '24:00';
  const hh = Math.floor(clamped / 60);
  const mm = clamped % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

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
  let hiddenByLoading = false;
  let settings: GameSettings = { ...initialSettings };
  let stageBannerTimer: ReturnType<typeof setTimeout> | null = null;

  const overlay = node('div', 'menu-overlay menu-overlay--title');
  const card = node('div', 'menu-card');
  overlay.append(card);
  uiRoot.append(overlay);

  // Banner comemorativo de estágio liberado (aparece sobre o jogo sem travar o movimento)
  const stageBanner = node('div', 'stage-banner');
  stageBanner.hidden = true;
  const stageBannerEyebrow = node('div', 'stage-banner-eyebrow', 'NOVO ESTÁGIO DESBLOQUEADO · GOPOSTAL');
  const stageBannerTitle = node('div', 'stage-banner-title', 'Coupé Tunado liberado!');
  const stageBannerSub = node('div', 'stage-banner-sub', '');
  stageBanner.append(stageBannerEyebrow, stageBannerTitle, stageBannerSub);
  uiRoot.append(stageBanner);

  // --- Tela Principal (Título ou Pausa) ---
  const mainView = node('div', 'menu-view');
  const header = node('div', 'menu-header');
  const eyebrow = node('div', 'menu-eyebrow', 'GOPOSTAL · CORRIDA CONTRA O RELÓGIO 00:00 → 24:00');
  const titleEl = node('h1', 'menu-title', 'DELIVERED BY MIDNIGHT');
  const subtitleEl = node('p', 'menu-subtitle', 'Entregue tudo antes da próxima meia-noite com veículos cada vez mais malucos');
  header.append(eyebrow, titleEl, subtitleEl);

  const actions = node('div', 'menu-actions');
  const btnPrimary = node('button', 'menu-btn menu-btn--primary', 'Jogar');
  btnPrimary.type = 'button';
  const btnRestart = node('button', 'menu-btn', 'Respawn no relógio!');
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

  // --- Tela de História (antes de começar o turno) ---
  const storyView = node('div', 'menu-view menu-subview');
  storyView.hidden = true;
  const storyEyebrow = node('div', 'menu-eyebrow', 'TURNO DA MEIA-NOITE · GOPOSTAL');
  const storyTitle = node('h2', 'menu-section-title', 'ENTREGUE TUDO ATÉ AS 24:00');
  const storyBody = node('div', 'menu-story-body');
  storyBody.append(
    node(
      'p',
      'menu-story-p',
      'A GoPostal prometeu o impossível na cidade inteira: todas as encomendas serão entregues até a próxima meia-noite — sem atraso e sem desculpa.',
    ),
    node(
      'p',
      'menu-story-p',
      'Michael De Santa, o patrão, deixou um recado no rádio das 00:00: só sobrou você no plantão. A cada etapa concluída, a garagem libera veículos ainda mais insanos para vencer o relógio!',
    ),
  );
  const storyLadder = node('div', 'menu-story-ladder');
  for (const [num, label] of [
    ['1', 'Hatch'],
    ['2', 'Coupé Tunado'],
    ['3', 'Helicóptero'],
    ['4', 'Avião A-29'],
  ] as const) {
    const step = node('div', 'menu-story-step');
    step.append(node('span', 'menu-story-num', num), node('span', 'menu-story-veh', label));
    storyLadder.append(step);
  }
  const storyTip = node(
    'p',
    'menu-story-tip',
    'Siga as colunas luminosas e a planta da cidade no minimapa. A última entrega de cada estágio leva direto ao próximo veículo!',
  );
  const storyFooter = node('div', 'menu-sub-footer');
  const btnStoryBack = node('button', 'menu-btn menu-btn--ghost', 'Voltar');
  btnStoryBack.type = 'button';
  const btnStoryPlay = node('button', 'menu-btn menu-btn--primary', 'Jogar');
  btnStoryPlay.type = 'button';
  storyFooter.append(btnStoryBack, btnStoryPlay);
  storyView.append(storyEyebrow, storyTitle, storyBody, storyLadder, storyTip, storyFooter);

  // --- Tela de Resultado (Vitória ou Derrota) ---
  const resultView = node('div', 'menu-view menu-subview');
  resultView.hidden = true;
  const resultEyebrow = node('div', 'menu-eyebrow', 'FIM DO TURNO');
  const resultTitle = node('h2', 'menu-title menu-result-title', 'MISSÃO CUMPRIDA!');
  const resultMsg = node('p', 'menu-result-msg', '');
  const resultStats = node('div', 'menu-result-stats');
  const statTimeVal = node('span', 'menu-stat-value', '00:00');
  const statScoreVal = node('span', 'menu-stat-value', '0');
  const statDeliveriesVal = node('span', 'menu-stat-value', '0/0');
  const statStageVal = node('span', 'menu-stat-value', '1/4 · Hatch');

  const makeStat = (label: string, valEl: HTMLElement) => {
    const box = node('div', 'menu-stat-box');
    box.append(node('span', 'menu-stat-label', label), valEl);
    return box;
  };
  resultStats.append(
    makeStat('Horário', statTimeVal),
    makeStat('Pontos', statScoreVal),
    makeStat('Entregas', statDeliveriesVal),
    makeStat('Estágio', statStageVal),
  );

  const resultActions = node('div', 'menu-actions');
  const btnPlayAgain = node('button', 'menu-btn menu-btn--primary', 'Jogar de novo');
  btnPlayAgain.type = 'button';
  const btnResultTitle = node('button', 'menu-btn menu-btn--ghost', 'Voltar ao início');
  btnResultTitle.type = 'button';
  resultActions.append(btnPlayAgain, btnResultTitle);
  resultView.append(resultEyebrow, resultTitle, resultMsg, resultStats, resultActions);

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
  const hudCtrl = makeToggleRow('Mostrar HUD', (v) => patchSettings({ showHud: v }));
  const fpsCtrl = makeToggleRow('Mostrar FPS', (v) => patchSettings({ showFps: v }));

  const controlModeCtrl = makeSegmentRow<'mouse' | 'keyboard'>(
    'Modo de controle do A-29',
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
    ['Equipe', 'João Victor da Costa, Gabriel Monteiro, Rafael Lima Henriques, Lucas Tostes'],
    ['Mapa e relevo (Juiz de Fora)', CITY_CREDITS],
    ['Física de voo', 'Física baseada no JSBSim (LGPL-2.1)'],
    ['Motor gráfico', 'PlayCanvas'],
    ['Modelos 3D', 'Modelos feitos no Blender (A-29, helicóptero, Hatch, Coupé Tunado, carros, UniAcademia e personagem)'],
    ['Homenagens (texto)', 'GoPostal, Michael De Santa (o patrão) e entregas com nomes em homenagem a clássicos dos games'],
    ['Áudio e interface', 'Trilha dinâmica, efeitos procedurais, ciclo dia/noite e HUD em Web Audio API'],
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

  card.append(mainView, storyView, resultView, optionsView, controlsView, creditsView);

  function clearStageBanner() {
    if (stageBannerTimer !== null) {
      clearTimeout(stageBannerTimer);
      stageBannerTimer = null;
    }
    stageBanner.hidden = true;
  }

  function syncOptionInputs() {
    masterCtrl.setValue(settings.masterVolume);
    musicCtrl.setValue(settings.musicVolume);
    sfxCtrl.setValue(settings.sfxVolume);
    sensCtrl.setValue(settings.mouseSensitivity);
    invertCtrl.setChecked(settings.invertY);
    hudCtrl.setChecked(settings.showHud);
    fpsCtrl.setChecked(settings.showFps);
    controlModeCtrl.setActive(settings.defaultControlMode);
    qualityCtrl.setActive(settings.quality);
  }

  function renderView() {
    const visible = !hiddenByLoading && mode !== 'playing';
    overlay.hidden = !visible;
    overlay.className = `menu-overlay ${
      mode === 'title' ? 'menu-overlay--title' : mode === 'ended' ? 'menu-overlay--ended' : 'menu-overlay--paused'
    }`;
    if (!visible) return;

    mainView.hidden = screen !== 'main';
    storyView.hidden = screen !== 'story';
    resultView.hidden = screen !== 'result';
    optionsView.hidden = screen !== 'options';
    controlsView.hidden = screen !== 'controls';
    creditsView.hidden = screen !== 'credits';

    if (mode === 'title') {
      eyebrow.textContent = 'GOPOSTAL · CORRIDA CONTRA O RELÓGIO 00:00 → 24:00';
      titleEl.textContent = 'DELIVERED BY MIDNIGHT';
      subtitleEl.textContent = 'Entregue tudo antes da próxima meia-noite com veículos cada vez mais malucos';
      subtitleEl.hidden = false;
      btnPrimary.textContent = 'Jogar';
      btnRestart.hidden = true;
      btnCredits.hidden = false;
      btnReturnTitle.hidden = true;
    } else if (mode === 'paused') {
      eyebrow.textContent = 'DELIVERED BY MIDNIGHT · GOPOSTAL';
      titleEl.textContent = 'PAUSADO';
      subtitleEl.textContent = 'Relógio congelado — pressione Esc ou P para voltar ao expediente';
      subtitleEl.hidden = false;
      btnPrimary.textContent = 'Continuar';
      btnRestart.textContent = 'Respawn no relógio!';
      btnRestart.hidden = false;
      btnCredits.hidden = true;
      btnReturnTitle.hidden = false;
    }
  }

  btnPrimary.addEventListener('click', () => {
    callbacks.onButtonClick(true);
    if (mode === 'title') {
      screen = 'story';
      renderView();
    } else {
      callbacks.onResume();
    }
  });

  btnStoryPlay.addEventListener('click', () => {
    callbacks.onButtonClick(true);
    callbacks.onStartFlight();
  });

  btnStoryBack.addEventListener('click', () => {
    callbacks.onButtonClick();
    screen = 'main';
    renderView();
  });

  btnRestart.addEventListener('click', () => {
    callbacks.onButtonClick(true);
    callbacks.onRestart();
  });

  btnPlayAgain.addEventListener('click', () => {
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

  btnResultTitle.addEventListener('click', () => {
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
      if (nextMode !== 'ended') {
        screen = 'main';
      }
      renderView();
    },
    setHiddenByLoading(hidden: boolean) {
      hiddenByLoading = hidden;
      renderView();
    },
    getScreen() {
      return screen;
    },
    back() {
      if (screen !== 'main' && screen !== 'result') {
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
    showStageUnlocked(stage: Stage) {
      clearStageBanner();
      const copy = STAGE_UNLOCK_COPY[stage];
      stageBanner.className = `stage-banner stage-banner--${copy.accent}`;
      stageBannerTitle.textContent = copy.title;
      stageBannerSub.textContent = copy.subtitle;
      stageBanner.hidden = false;
      stageBannerTimer = setTimeout(() => {
        stageBannerTimer = null;
        stageBanner.hidden = true;
      }, 4500);
    },
    clearStageBanner,
    showEndScreen(outcome: 'won' | 'lost', mission: MissionState) {
      clearStageBanner();
      mode = 'ended';
      screen = 'result';
      const remaining = Math.max(0, mission.total - mission.delivered);

      resultView.className = `menu-view menu-subview menu-result--${outcome}`;
      if (outcome === 'won') {
        resultEyebrow.textContent = 'GOPOSTAL · MISSÃO CUMPRIDA!';
        resultTitle.textContent = 'MISSÃO CUMPRIDA!';
        resultMsg.textContent = `Michael De Santa, o patrão, aprovou o serviço: todas as ${mission.delivered} entregas da GoPostal chegaram às ${formatClock(mission.clockMinutes)}!`;
      } else {
        resultEyebrow.textContent = 'GOPOSTAL · RESPAWN NO RELÓGIO!';
        resultTitle.textContent = 'MEIA-NOITE!';
        resultMsg.textContent =
          remaining === 1
            ? 'Meia-noite! Faltou 1 entrega — Michael De Santa, o patrão, quer respawn no relógio!'
            : `Meia-noite! Faltaram ${remaining} entregas — Michael De Santa, o patrão, quer respawn no relógio!`;
      }

      statTimeVal.textContent = formatClock(outcome === 'lost' ? 1440 : mission.clockMinutes);
      statScoreVal.textContent = `${mission.score.toLocaleString('pt-BR')} pts`;
      statDeliveriesVal.textContent = `${mission.delivered}/${mission.total}`;
      statStageVal.textContent = STAGE_LABEL[mission.stage];

      renderView();
    },
    destroy() {
      clearStageBanner();
      overlay.remove();
      stageBanner.remove();
    },
  };
}
