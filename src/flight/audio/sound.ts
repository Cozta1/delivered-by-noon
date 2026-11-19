import type { FlightState } from '../types';
import type { GameMode, GameSettings } from '../ui/settings';

export interface FlightAudio {
  unlock(): void;
  applySettings(settings: GameSettings): void;
  update(dt: number, mode: GameMode, state: FlightState): void;
  playClick(): void;
  playConfirm(): void;
  destroy(): void;
}

// Progressão atmosférica original (Fmaj7 -> G6 -> Am9 -> Em7) em MIDI
const CHORDS: readonly (readonly number[])[] = [
  [53, 57, 60, 64, 67], // Fmaj9/7
  [55, 59, 62, 64, 67], // G6
  [57, 60, 64, 67, 71], // Am9
  [52, 55, 59, 62, 67], // Em7
];

const ARP_PATTERNS: readonly (readonly number[])[] = [
  [0, 2, 3, 4, 3, 2, 1, 3],
  [0, 1, 3, 4, 2, 3, 4, 2],
];

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function clamp(v: number, min: number, max: number) {
  return v < min ? min : v > max ? max : v;
}

function getAudioContextCtor(): (typeof AudioContext) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export function createFlightAudio(initialSettings: GameSettings): FlightAudio {
  let settings: GameSettings = { ...initialSettings };
  let ctx: AudioContext | null = null;
  let noiseBuffer: AudioBuffer | null = null;

  let masterGain: GainNode | null = null;
  let musicBus: GainNode | null = null;
  let musicDuck: GainNode | null = null;
  let musicFilter: BiquadFilterNode | null = null;
  let sfxBus: GainNode | null = null;
  let flightBus: GainNode | null = null;

  // Nós contínuos do motor turboélice e vento
  let propOsc: OscillatorNode | null = null;
  let subOsc: OscillatorNode | null = null;
  let engineFilter: BiquadFilterNode | null = null;
  let engineGain: GainNode | null = null;

  let turbineOsc: OscillatorNode | null = null;
  let turbineGain: GainNode | null = null;

  let windSrc: AudioBufferSourceNode | null = null;
  let windFilter: BiquadFilterNode | null = null;
  let windGain: GainNode | null = null;

  let stallOsc: OscillatorNode | null = null;
  let stallGain: GainNode | null = null;

  let started = false;
  let destroyed = false;
  let wasCrashed = false;
  let stallPhase = 0;

  // Sequenciador musical procedural (sem setInterval: avança dentro de update(dt))
  let musicTimer = 0;
  let musicStep = 0;
  let activeMusicNodes = new Set<AudioScheduledSourceNode>();

  function buildNoiseBuffer(audioCtx: AudioContext): AudioBuffer {
    const length = audioCtx.sampleRate * 2;
    const buf = audioCtx.createBuffer(1, length, audioCtx.sampleRate);
    const data = buf.getChannelData(0);
    // Ruído rosa suave aproximado (filtro simples) para vento e impacto naturais
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let seed = 0x1a2b3c4d;
    for (let i = 0; i < length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const white = (seed / 0xffffffff) * 2 - 1;
      b0 = 0.997 * b0 + white * 0.029;
      b1 = 0.985 * b1 + white * 0.032;
      b2 = 0.95 * b2 + white * 0.048;
      data[i] = clamp((b0 + b1 + b2 + white * 0.12) * 1.4, -1, 1);
    }
    return buf;
  }

  function applyGainLevels() {
    if (!ctx || !masterGain || !musicBus || !sfxBus) return;
    const now = ctx.currentTime;
    masterGain.gain.setTargetAtTime(clamp(settings.masterVolume, 0, 1), now, 0.04);
    musicBus.gain.setTargetAtTime(clamp(settings.musicVolume, 0, 1) * 0.42, now, 0.06);
    sfxBus.gain.setTargetAtTime(clamp(settings.sfxVolume, 0, 1), now, 0.04);
  }

  function ensureInitialized() {
    if (destroyed || started) return;
    const Ctor = getAudioContextCtor();
    if (!Ctor) return;

    try {
      ctx = new Ctor();
    } catch {
      return;
    }

    started = true;
    noiseBuffer = buildNoiseBuffer(ctx);

    masterGain = ctx.createGain();
    masterGain.gain.value = clamp(settings.masterVolume, 0, 1);
    masterGain.connect(ctx.destination);

    // Barramento de música
    musicBus = ctx.createGain();
    musicBus.gain.value = clamp(settings.musicVolume, 0, 1) * 0.42;
    musicDuck = ctx.createGain();
    musicDuck.gain.value = 1;
    musicFilter = ctx.createBiquadFilter();
    musicFilter.type = 'lowpass';
    musicFilter.frequency.value = 950;
    musicFilter.Q.value = 0.7;
    musicFilter.connect(musicDuck);
    musicDuck.connect(musicBus);
    musicBus.connect(masterGain);

    // Barramento de efeitos
    sfxBus = ctx.createGain();
    sfxBus.gain.value = clamp(settings.sfxVolume, 0, 1);
    sfxBus.connect(masterGain);

    flightBus = ctx.createGain();
    flightBus.gain.value = 0;
    flightBus.connect(sfxBus);

    // 1) Motor turboélice: hélice (serra + sub) + assobio de turbina
    engineFilter = ctx.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 280;
    engineFilter.Q.value = 1.4;

    engineGain = ctx.createGain();
    engineGain.gain.value = 0.0001;
    engineFilter.connect(engineGain);
    engineGain.connect(flightBus);

    propOsc = ctx.createOscillator();
    propOsc.type = 'sawtooth';
    propOsc.frequency.value = 72;
    propOsc.connect(engineFilter);
    propOsc.start();

    subOsc = ctx.createOscillator();
    subOsc.type = 'triangle';
    subOsc.frequency.value = 36;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.65;
    subOsc.connect(subGain);
    subGain.connect(engineFilter);
    subOsc.start();

    turbineOsc = ctx.createOscillator();
    turbineOsc.type = 'sine';
    turbineOsc.frequency.value = 920;
    turbineGain = ctx.createGain();
    turbineGain.gain.value = 0.0001;
    turbineOsc.connect(turbineGain);
    turbineGain.connect(flightBus);
    turbineOsc.start();

    // 2) Vento contínuo (ruído filtrado em loop)
    windSrc = ctx.createBufferSource();
    windSrc.buffer = noiseBuffer;
    windSrc.loop = true;
    windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 420;
    windFilter.Q.value = 1.1;
    windGain = ctx.createGain();
    windGain.gain.value = 0.0001;
    windSrc.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(flightBus);
    windSrc.start();

    // 3) Alerta de estol (beep pulsante)
    stallOsc = ctx.createOscillator();
    stallOsc.type = 'triangle';
    stallOsc.frequency.value = 880;
    stallGain = ctx.createGain();
    stallGain.gain.value = 0;
    stallOsc.connect(stallGain);
    stallGain.connect(flightBus);
    stallOsc.start();

    applyGainLevels();
  }

  function trackSource(src: AudioScheduledSourceNode) {
    activeMusicNodes.add(src);
    src.onended = () => {
      activeMusicNodes.delete(src);
    };
  }

  function playSynthVoice(
    freq: number,
    duration: number,
    peakGain: number,
    wave: OscillatorType,
    attack: number,
  ) {
    if (!ctx || !musicFilter || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = wave;
    osc.frequency.setValueAtTime(freq, now);

    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(peakGain, now + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(env);
    env.connect(musicFilter);
    trackSource(osc);
    osc.start(now);
    osc.stop(now + duration + 0.05);
  }

  function triggerMusicStep(mode: GameMode) {
    const chordIdx = Math.floor(musicStep / 8) % CHORDS.length;
    const beatInBar = musicStep % 8;
    const chord = CHORDS[chordIdx];

    // Pad suave na cabeça de cada compasso (8 passos)
    if (beatInBar === 0) {
      const padDur = mode === 'playing' ? 2.5 : 3.5;
      const padVol = mode === 'playing' ? 0.07 : 0.085;
      playSynthVoice(midiToHz(chord[0] - 12), padDur, padVol * 0.9, 'sine', 0.35);
      playSynthVoice(midiToHz(chord[0]), padDur, padVol * 0.75, 'triangle', 0.45);
      playSynthVoice(midiToHz(chord[2]), padDur, padVol * 0.6, 'sine', 0.5);
    }

    // Arpejo: mais calmo e espaçado no menu, mais fluido e animado em voo
    if (mode === 'playing') {
      const pattern = ARP_PATTERNS[chordIdx % ARP_PATTERNS.length];
      const noteMidi = chord[pattern[beatInBar]] + (beatInBar % 4 === 3 ? 12 : 0);
      playSynthVoice(midiToHz(noteMidi), 0.7, 0.06, 'triangle', 0.02);
      if (beatInBar === 0 || beatInBar === 4) {
        playSynthVoice(midiToHz(chord[0] - 12), 0.42, 0.065, 'sine', 0.015);
      }
    } else if (beatInBar === 0 || beatInBar === 3 || beatInBar === 6) {
      const noteMidi = chord[(beatInBar + chordIdx) % chord.length] + 12;
      playSynthVoice(midiToHz(noteMidi), 1.45, 0.045, 'sine', 0.08);
    }

    musicStep = (musicStep + 1) % (CHORDS.length * 8);
  }

  function triggerCrashSound() {
    if (!ctx || !sfxBus || !noiseBuffer || ctx.state !== 'running') return;
    const now = ctx.currentTime;

    // Impacto subgrave
    const boom = ctx.createOscillator();
    const boomGain = ctx.createGain();
    boom.type = 'triangle';
    boom.frequency.setValueAtTime(135, now);
    boom.frequency.exponentialRampToValueAtTime(28, now + 0.48);
    boomGain.gain.setValueAtTime(0.45, now);
    boomGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.52);
    boom.connect(boomGain);
    boomGain.connect(sfxBus);
    trackSource(boom);
    boom.start(now);
    boom.stop(now + 0.56);

    // Explosão de ruído filtrado
    const burst = ctx.createBufferSource();
    burst.buffer = noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(980, now);
    filter.frequency.exponentialRampToValueAtTime(120, now + 0.72);
    const burstGain = ctx.createGain();
    burstGain.gain.setValueAtTime(0.5, now);
    burstGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.78);
    burst.connect(filter);
    filter.connect(burstGain);
    burstGain.connect(sfxBus);
    trackSource(burst);
    burst.start(now);
    burst.stop(now + 0.82);
  }

  function playUiTone(startHz: number, endHz: number, dur: number, vol: number) {
    if (destroyed) return;
    ensureInitialized();
    if (!ctx || !sfxBus) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(startHz, now);
    osc.frequency.exponentialRampToValueAtTime(endHz, now + dur);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(vol, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(gain);
    gain.connect(sfxBus);
    trackSource(osc);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  }

  return {
    unlock() {
      if (destroyed) return;
      ensureInitialized();
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
    },

    applySettings(next: GameSettings) {
      settings = { ...next };
      applyGainLevels();
    },

    update(dt: number, mode: GameMode, state: FlightState) {
      if (destroyed || !started || !ctx || ctx.state !== 'running') {
        wasCrashed = state.crashed;
        return;
      }

      const now = ctx.currentTime;
      const inFlight = mode === 'playing';

      // Ducking e filtro da música conforme estado (menu calmo, voo animado, pausa reduzido)
      if (musicDuck && musicFilter) {
        const duckTarget = mode === 'paused' ? 0.32 : mode === 'playing' ? 1.0 : 0.88;
        const filterTarget = mode === 'paused' ? 580 : mode === 'playing' ? 1750 : 900;
        musicDuck.gain.setTargetAtTime(duckTarget, now, 0.14);
        musicFilter.frequency.setTargetAtTime(filterTarget, now, 0.2);
      }

      // Avança o sequenciador musical procedural
      const stepDuration = mode === 'playing' ? 0.28 : 0.4;
      musicTimer += dt;
      if (musicTimer >= stepDuration) {
        musicTimer %= stepDuration;
        triggerMusicStep(mode);
      }

      // Barramento de sons de voo (silencia no menu e na pausa)
      if (flightBus) {
        flightBus.gain.setTargetAtTime(inFlight ? 1 : 0, now, 0.08);
      }

      // Borda de subida da batida (toca uma vez no impacto)
      if (inFlight && state.crashed && !wasCrashed) {
        triggerCrashSound();
      }
      wasCrashed = state.crashed;

      const throttle = clamp(state.throttle, 0, 1);
      const speedNorm = clamp(state.speed / 160, 0, 1.15);
      const aliveFlight = inFlight && !state.crashed;

      // Motor turboélice seguindo throttle e speed
      if (propOsc && subOsc && engineFilter && engineGain && turbineOsc && turbineGain) {
        const baseFreq = 46 + throttle * 64 + speedNorm * 24;
        propOsc.frequency.setTargetAtTime(baseFreq, now, 0.06);
        subOsc.frequency.setTargetAtTime(baseFreq * 0.5, now, 0.06);
        engineFilter.frequency.setTargetAtTime(190 + throttle * 340 + speedNorm * 140, now, 0.08);
        engineGain.gain.setTargetAtTime(aliveFlight ? 0.055 + throttle * 0.115 : 0.0001, now, 0.07);

        turbineOsc.frequency.setTargetAtTime(720 + throttle * 520 + speedNorm * 140, now, 0.08);
        turbineGain.gain.setTargetAtTime(aliveFlight ? 0.014 + throttle * 0.036 : 0.0001, now, 0.08);
      }

      // Vento proporcional à velocidade
      if (windFilter && windGain) {
        windFilter.frequency.setTargetAtTime(240 + speedNorm * 1150, now, 0.08);
        const windLevel = aliveFlight ? Math.pow(speedNorm, 1.65) * 0.26 : 0.0001;
        windGain.gain.setTargetAtTime(windLevel, now, 0.08);
      }

      // Alerta de estol pulsante
      if (stallGain && stallOsc) {
        if (aliveFlight && state.stall) {
          stallPhase += dt * 4.2;
          const beepOn = stallPhase % 1 < 0.45;
          stallOsc.frequency.setTargetAtTime(beepOn ? 900 : 860, now, 0.01);
          stallGain.gain.setTargetAtTime(beepOn ? 0.14 : 0.0001, now, 0.015);
        } else {
          stallPhase = 0;
          stallGain.gain.setTargetAtTime(0.0001, now, 0.02);
        }
      }
    },

    playClick() {
      playUiTone(520, 680, 0.045, 0.14);
    },

    playConfirm() {
      playUiTone(440, 660, 0.075, 0.18);
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;

      for (const node of activeMusicNodes) {
        try {
          node.stop();
        } catch {
          // Já encerrado
        }
      }
      activeMusicNodes.clear();

      for (const continuous of [propOsc, subOsc, turbineOsc, windSrc, stallOsc]) {
        if (!continuous) continue;
        try {
          continuous.stop();
        } catch {
          // Já encerrado
        }
      }

      propOsc = subOsc = turbineOsc = stallOsc = null;
      windSrc = null;
      engineFilter = windFilter = musicFilter = null;
      engineGain = turbineGain = windGain = stallGain = null;
      masterGain = musicBus = musicDuck = sfxBus = flightBus = null;
      noiseBuffer = null;

      if (ctx) {
        const closing = ctx;
        ctx = null;
        closing.close().catch(() => {});
      }
    },
  };
}
