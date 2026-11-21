import type { FlightState, MissionState, VehicleKind } from '../types';
import type { GameMode, GameSettings } from '../ui/settings';

export interface FlightAudio {
  unlock(): void;
  applySettings(settings: GameSettings): void;
  update(dt: number, mode: GameMode, state: FlightState, mission?: MissionState, nitroActive?: boolean): void;
  playClick(): void;
  playConfirm(): void;
  playDelivery(): void;
  playStageFanfare(): void;
  playVictory(): void;
  playDefeat(): void;
  playLocked(): void;
  destroy(): void;
}

// Progressão atmosférica original (Fmaj7 -> G6 -> Am9 -> Em7) em MIDI
const CALM_CHORDS: readonly (readonly number[])[] = [
  [53, 57, 60, 64, 67],
  [55, 59, 62, 64, 67],
  [57, 60, 64, 67, 71],
  [52, 55, 59, 62, 67],
];

// Progressão mais tensa perto da meia-noite (Am -> F -> Dm -> E7) em MIDI
const TENSE_CHORDS: readonly (readonly number[])[] = [
  [57, 60, 64, 69, 72],
  [53, 57, 60, 65, 69],
  [50, 53, 57, 62, 65],
  [52, 56, 59, 62, 68],
];

const ARP_PATTERNS: readonly (readonly number[])[] = [
  [0, 2, 3, 4, 3, 2, 1, 3],
  [0, 1, 3, 4, 2, 3, 4, 2],
];

const TENSE_ARP: readonly number[] = [0, 3, 2, 4, 1, 3, 4, 2];

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

/**
 * Gera buffer de ruído rosa contínuo com crossfade circular nas bordas
 * para evitar estalos periódicos quando tocado em loop.
 */
export function fillSeamlessPinkNoise(target: Float32Array, crossfadeSamples = 2048): void {
  const length = target.length;
  const fade = Math.min(crossfadeSamples, Math.floor(length / 4));
  const total = length + fade;
  const raw = new Float32Array(total);

  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let seed = 0x1a2b3c4d;
  for (let i = 0; i < total; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const white = (seed / 0xffffffff) * 2 - 1;
    b0 = 0.997 * b0 + white * 0.029;
    b1 = 0.985 * b1 + white * 0.032;
    b2 = 0.95 * b2 + white * 0.048;
    raw[i] = clamp((b0 + b1 + b2 + white * 0.12) * 1.4, -1, 1);
  }

  for (let i = 0; i < length; i++) {
    target[i] = raw[i];
  }
  // Crossfade suave (curva cosseno) entre a cauda extra e o início do buffer
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    const wStart = 0.5 - 0.5 * Math.cos(Math.PI * t);
    const wEnd = 1 - wStart;
    target[i] = raw[i] * wStart + raw[length + i] * wEnd;
  }
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
  let worldBus: GainNode | null = null;

  // Motor A-29 turboélice
  let propOsc: OscillatorNode | null = null;
  let subOsc: OscillatorNode | null = null;
  let engineFilter: BiquadFilterNode | null = null;
  let engineGain: GainNode | null = null;
  let turbineOsc: OscillatorNode | null = null;
  let turbineGain: GainNode | null = null;

  // Motor de carro / carro tunado
  let carOsc: OscillatorNode | null = null;
  let carSubOsc: OscillatorNode | null = null;
  let carFilter: BiquadFilterNode | null = null;
  let carGain: GainNode | null = null;

  // Nitro do carro tunado (sopro turbo contínuo)
  let nitroSrc: AudioBufferSourceNode | null = null;
  let nitroFilter: BiquadFilterNode | null = null;
  let nitroGain: GainNode | null = null;

  // Rotor do helicóptero (ruído grave pulsado + LFO de pás)
  let heliNoiseSrc: AudioBufferSourceNode | null = null;
  let heliFilter: BiquadFilterNode | null = null;
  let heliPulseGain: GainNode | null = null;
  let heliLfo: OscillatorNode | null = null;
  let heliLfoDepth: GainNode | null = null;
  let heliMasterGain: GainNode | null = null;

  // Vento contínuo em loop sem emenda
  let windSrc: AudioBufferSourceNode | null = null;
  let windFilter: BiquadFilterNode | null = null;
  let windGain: GainNode | null = null;

  // Alerta de estol
  let stallOsc: OscillatorNode | null = null;
  let stallGain: GainNode | null = null;

  let started = false;
  let destroyed = false;
  let wasCrashed = false;
  let lastVehicle: VehicleKind | null = null;
  let stallPhase = 0;
  let stepTimer = 0;
  let tickTimer = 0;
  let tickParity = false;

  // Sequenciador musical procedural
  let musicTimer = 0;
  let musicStep = 0;
  const activeNodes = new Set<AudioScheduledSourceNode>();

  function buildNoiseBuffer(audioCtx: AudioContext): AudioBuffer {
    const length = audioCtx.sampleRate * 2;
    const buf = audioCtx.createBuffer(1, length, audioCtx.sampleRate);
    fillSeamlessPinkNoise(buf.getChannelData(0), Math.min(2048, Math.floor(audioCtx.sampleRate * 0.08)));
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

    worldBus = ctx.createGain();
    worldBus.gain.value = 0;
    worldBus.connect(sfxBus);

    // 1) Motor A-29 turboélice
    engineFilter = ctx.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 280;
    engineFilter.Q.value = 1.4;
    engineGain = ctx.createGain();
    engineGain.gain.value = 0.0001;
    engineFilter.connect(engineGain);
    engineGain.connect(worldBus);

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
    turbineGain.connect(worldBus);
    turbineOsc.start();

    // 2) Motor de carro / carro tunado
    carFilter = ctx.createBiquadFilter();
    carFilter.type = 'lowpass';
    carFilter.frequency.value = 240;
    carFilter.Q.value = 1.8;
    carGain = ctx.createGain();
    carGain.gain.value = 0.0001;
    carFilter.connect(carGain);
    carGain.connect(worldBus);

    carOsc = ctx.createOscillator();
    carOsc.type = 'sawtooth';
    carOsc.frequency.value = 54;
    carOsc.connect(carFilter);
    carOsc.start();

    carSubOsc = ctx.createOscillator();
    carSubOsc.type = 'triangle';
    carSubOsc.frequency.value = 27;
    const carSubGain = ctx.createGain();
    carSubGain.gain.value = 0.7;
    carSubOsc.connect(carSubGain);
    carSubGain.connect(carFilter);
    carSubOsc.start();

    // 2b) Nitro do carro tunado (jato bandpass contínuo)
    nitroSrc = ctx.createBufferSource();
    nitroSrc.buffer = noiseBuffer;
    nitroSrc.loop = true;
    nitroFilter = ctx.createBiquadFilter();
    nitroFilter.type = 'bandpass';
    nitroFilter.frequency.value = 820;
    nitroFilter.Q.value = 1.4;
    nitroGain = ctx.createGain();
    nitroGain.gain.value = 0.0001;
    nitroSrc.connect(nitroFilter);
    nitroFilter.connect(nitroGain);
    nitroGain.connect(worldBus);
    nitroSrc.start();

    // 3) Rotor do helicóptero ("whup-whup-whup" com LFO em 11..18 Hz)
    heliNoiseSrc = ctx.createBufferSource();
    heliNoiseSrc.buffer = noiseBuffer;
    heliNoiseSrc.loop = true;
    heliFilter = ctx.createBiquadFilter();
    heliFilter.type = 'lowpass';
    heliFilter.frequency.value = 260;
    heliFilter.Q.value = 2.0;
    heliPulseGain = ctx.createGain();
    heliPulseGain.gain.value = 0.55;
    heliMasterGain = ctx.createGain();
    heliMasterGain.gain.value = 0.0001;

    heliLfo = ctx.createOscillator();
    heliLfo.type = 'sine';
    heliLfo.frequency.value = 12;
    heliLfoDepth = ctx.createGain();
    heliLfoDepth.gain.value = 0.42;
    heliLfo.connect(heliLfoDepth);
    heliLfoDepth.connect(heliPulseGain.gain);

    heliNoiseSrc.connect(heliFilter);
    heliFilter.connect(heliPulseGain);
    heliPulseGain.connect(heliMasterGain);
    heliMasterGain.connect(worldBus);
    heliNoiseSrc.start();
    heliLfo.start();

    // 4) Vento contínuo sem estalo
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
    windGain.connect(worldBus);
    windSrc.start();

    // 5) Alerta de estol
    stallOsc = ctx.createOscillator();
    stallOsc.type = 'triangle';
    stallOsc.frequency.value = 880;
    stallGain = ctx.createGain();
    stallGain.gain.value = 0;
    stallOsc.connect(stallGain);
    stallGain.connect(worldBus);
    stallOsc.start();

    applyGainLevels();
  }

  function trackSource(src: AudioScheduledSourceNode) {
    activeNodes.add(src);
    src.onended = () => {
      activeNodes.delete(src);
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

  function playSfxTone(
    freq: number,
    endFreq: number,
    duration: number,
    peakGain: number,
    wave: OscillatorType,
    delay = 0,
  ) {
    if (destroyed) return;
    ensureInitialized();
    if (!ctx || !sfxBus) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    const start = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = wave;
    osc.frequency.setValueAtTime(freq, start);
    if (endFreq !== freq) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), start + duration);
    }
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(peakGain, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain);
    gain.connect(sfxBus);
    trackSource(osc);
    osc.start(start);
    osc.stop(start + duration + 0.03);
  }

  function triggerMusicStep(mode: GameMode, tension: number) {
    const useTense = mode === 'playing' && tension > 0.4;
    const chords = useTense ? TENSE_CHORDS : CALM_CHORDS;
    const chordIdx = Math.floor(musicStep / 8) % chords.length;
    const beatInBar = musicStep % 8;
    const chord = chords[chordIdx];

    if (beatInBar === 0) {
      const padDur = mode === 'playing' ? (useTense ? 1.85 : 2.5) : 3.5;
      const padVol = mode === 'playing' ? 0.07 : 0.085;
      playSynthVoice(midiToHz(chord[0] - 12), padDur, padVol * 0.9, 'sine', 0.25);
      playSynthVoice(midiToHz(chord[0]), padDur, padVol * 0.72, 'triangle', 0.35);
      playSynthVoice(midiToHz(chord[2]), padDur, padVol * 0.58, 'sine', 0.4);
    }

    if (mode === 'playing') {
      const pattern = useTense ? TENSE_ARP : ARP_PATTERNS[chordIdx % ARP_PATTERNS.length];
      const noteMidi = chord[pattern[beatInBar]] + (beatInBar % 4 === 3 ? 12 : 0);
      const arpWave: OscillatorType = useTense ? 'sawtooth' : 'triangle';
      const arpVol = useTense ? 0.042 + tension * 0.022 : 0.06;
      const arpDur = useTense ? 0.34 : 0.7;
      playSynthVoice(midiToHz(noteMidi), arpDur, arpVol, arpWave, 0.015);

      // Pulso de baixo acelera quando a meia-noite se aproxima
      const bassHit = useTense ? beatInBar % 2 === 0 : beatInBar === 0 || beatInBar === 4;
      if (bassHit) {
        const bassMidi = chord[0] - 12 + (useTense && beatInBar % 4 === 2 ? 7 : 0);
        playSynthVoice(midiToHz(bassMidi), useTense ? 0.22 : 0.42, 0.065 + tension * 0.025, 'sine', 0.01);
      }
    } else if (beatInBar === 0 || beatInBar === 3 || beatInBar === 6) {
      const noteMidi = chord[(beatInBar + chordIdx) % chord.length] + 12;
      playSynthVoice(midiToHz(noteMidi), 1.45, 0.045, 'sine', 0.08);
    }

    musicStep = (musicStep + 1) % (chords.length * 8);
  }

  function triggerClockTick(high: boolean, urgency: number) {
    if (!ctx || !sfxBus || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    const baseHz = high ? 1320 : 980;
    osc.frequency.setValueAtTime(baseHz, now);
    osc.frequency.exponentialRampToValueAtTime(baseHz * 0.62, now + 0.032);
    const vol = 0.09 + urgency * 0.1;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(vol, now + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.042);
    osc.connect(gain);
    gain.connect(sfxBus);
    trackSource(osc);
    osc.start(now);
    osc.stop(now + 0.05);
  }

  function triggerFootstep() {
    if (!ctx || !worldBus || !noiseBuffer || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(340 + ((musicStep * 37) % 120), now);
    filter.Q.value = 1.6;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.16, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.085);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(worldBus);
    trackSource(src);
    src.start(now, (now * 0.37) % 1.4, 0.1);
  }

  function triggerDoorSound(entering: boolean) {
    if (!ctx || !sfxBus || !noiseBuffer || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const latch = ctx.createOscillator();
    const latchGain = ctx.createGain();
    latch.type = 'triangle';
    latch.frequency.setValueAtTime(entering ? 420 : 540, now);
    latch.frequency.exponentialRampToValueAtTime(entering ? 240 : 320, now + 0.05);
    latchGain.gain.setValueAtTime(0.12, now);
    latchGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
    latch.connect(latchGain);
    latchGain.connect(sfxBus);
    trackSource(latch);
    latch.start(now);
    latch.stop(now + 0.07);

    const thudTime = now + (entering ? 0.07 : 0.03);
    const thud = ctx.createOscillator();
    const thudGain = ctx.createGain();
    thud.type = 'sine';
    thud.frequency.setValueAtTime(145, thudTime);
    thud.frequency.exponentialRampToValueAtTime(48, thudTime + 0.11);
    thudGain.gain.setValueAtTime(0.28, thudTime);
    thudGain.gain.exponentialRampToValueAtTime(0.0001, thudTime + 0.13);
    thud.connect(thudGain);
    thudGain.connect(sfxBus);
    trackSource(thud);
    thud.start(thudTime);
    thud.stop(thudTime + 0.14);
  }

  function triggerCrashSound() {
    if (!ctx || !sfxBus || !noiseBuffer || ctx.state !== 'running') return;
    const now = ctx.currentTime;

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

    update(dt: number, mode: GameMode, state: FlightState, mission?: MissionState, nitroActive = false) {
      if (destroyed || !started || !ctx || ctx.state !== 'running') {
        wasCrashed = state.crashed;
        lastVehicle = state.vehicle;
        return;
      }

      const now = ctx.currentTime;
      const playing = mode === 'playing';
      const vehicle = state.vehicle;
      const isCar = vehicle === 'car' || vehicle === 'tuned';

      // Som de porta ao entrar ou sair de qualquer veículo
      if (playing && lastVehicle !== null && vehicle !== lastVehicle) {
        triggerDoorSound(vehicle !== 'foot');
      }
      lastVehicle = vehicle;

      // Tensão musical cresce das 19:00 até as 24:00
      const clockMin = mission && mission.status === 'playing' ? mission.clockMinutes : 0;
      const tension = playing && mission?.status === 'playing' ? clamp((clockMin - 19 * 60) / (5 * 60), 0, 1) : 0;

      // Música ambiente (calma no menu, animada jogando, tensa perto da meia-noite, reduzida na pausa)
      if (musicDuck && musicFilter) {
        const duckTarget = mode === 'paused' || mode === 'ended' ? 0.3 : playing ? 1.0 : 0.88;
        const filterTarget =
          mode === 'paused' || mode === 'ended' ? 560 : playing ? 1650 + tension * 1250 : 900;
        musicDuck.gain.setTargetAtTime(duckTarget, now, 0.14);
        musicFilter.frequency.setTargetAtTime(filterTarget, now, 0.2);
      }

      const stepDuration = playing ? 0.28 - tension * 0.1 : 0.4;
      musicTimer += dt;
      if (musicTimer >= stepDuration) {
        musicTimer %= stepDuration;
        triggerMusicStep(mode, tension);
      }

      // Tique-taque do relógio nos últimos minutos (depois das 22:00)
      if (playing && mission?.status === 'playing' && clockMin >= 22 * 60) {
        const urgency = clamp((clockMin - 22 * 60) / 120, 0, 1);
        const tickInterval = 0.85 - urgency * 0.52;
        tickTimer += dt;
        if (tickTimer >= tickInterval) {
          tickTimer %= tickInterval;
          tickParity = !tickParity;
          triggerClockTick(tickParity, urgency);
        }
      } else {
        tickTimer = 0;
      }

      if (worldBus) {
        worldBus.gain.setTargetAtTime(playing ? 1 : 0, now, 0.08);
      }

      if (playing && state.crashed && !wasCrashed) {
        triggerCrashSound();
      }
      wasCrashed = state.crashed;

      const throttle = clamp(state.throttle, 0, 1);
      const speedAbs = Math.abs(state.speed);
      const alive = playing && !state.crashed;

      // 1) Motor A-29 turboélice + assobio de turbina (A-29, heli ou turbo do tunado)
      const a29On = alive && vehicle === 'a29';
      const a29Speed = clamp(speedAbs / 160, 0, 1.15);
      if (propOsc && subOsc && engineFilter && engineGain && turbineOsc && turbineGain) {
        const baseFreq = 46 + throttle * 64 + a29Speed * 24;
        propOsc.frequency.setTargetAtTime(baseFreq, now, 0.06);
        subOsc.frequency.setTargetAtTime(baseFreq * 0.5, now, 0.06);
        engineFilter.frequency.setTargetAtTime(190 + throttle * 340 + a29Speed * 140, now, 0.08);
        engineGain.gain.setTargetAtTime(a29On ? 0.055 + throttle * 0.115 : 0.0001, now, 0.07);

        const tunedTurbo = alive && vehicle === 'tuned' && (nitroActive || speedAbs > 18);
        const turbineOn = alive && (vehicle === 'a29' || vehicle === 'heli' || tunedTurbo);
        const turbHz =
          vehicle === 'tuned'
            ? 680 + clamp(speedAbs / 65, 0, 1.2) * 580 + (nitroActive ? 360 : 0)
            : vehicle === 'heli'
              ? 840 + throttle * 380
              : 720 + throttle * 520 + a29Speed * 140;
        const turbLevel =
          vehicle === 'tuned'
            ? nitroActive
              ? 0.042
              : 0.016
            : 0.014 + throttle * 0.034;
        turbineOsc.frequency.setTargetAtTime(turbHz, now, 0.08);
        turbineGain.gain.setTargetAtTime(turbineOn ? turbLevel : 0.0001, now, 0.08);
      }

      // 2) Motor de carro / carro tunado (mais agudo e encorpado no tunado)
      const carOn = alive && isCar;
      if (carOsc && carSubOsc && carFilter && carGain) {
        const kmh = speedAbs * 3.6;
        const tunedBoost = vehicle === 'tuned' ? 1.28 : 1.0;
        const gearBand = vehicle === 'tuned' ? 42 : 34;
        const gearCycle = kmh < 2 ? 0 : ((kmh % gearBand) / gearBand) * 0.72 + Math.min(1, kmh / 180) * 0.28;
        const rpmFreq = (42 + gearCycle * 96 + throttle * 24 + (nitroActive ? 28 : 0)) * tunedBoost;
        carOsc.frequency.setTargetAtTime(rpmFreq, now, 0.05);
        carSubOsc.frequency.setTargetAtTime(rpmFreq * 0.5, now, 0.05);
        carFilter.frequency.setTargetAtTime(
          (175 + gearCycle * 480 + throttle * 170 + (nitroActive ? 380 : 0)) * (vehicle === 'tuned' ? 1.2 : 1),
          now,
          0.06,
        );
        carGain.gain.setTargetAtTime(
          carOn ? (0.055 + throttle * 0.075 + gearCycle * 0.045) * (vehicle === 'tuned' ? 1.15 : 1) : 0.0001,
          now,
          0.06,
        );
      }

      // 2b) Nitro contínuo (sopro de turbo)
      if (nitroFilter && nitroGain) {
        const nitroOn = alive && vehicle === 'tuned' && nitroActive;
        nitroFilter.frequency.setTargetAtTime(nitroOn ? 950 + clamp(speedAbs / 70, 0, 1) * 750 : 600, now, 0.06);
        nitroGain.gain.setTargetAtTime(nitroOn ? 0.24 : 0.0001, now, 0.05);
      }

      // 3) Rotor do helicóptero ("whup-whup-whup")
      const heliOn = alive && vehicle === 'heli';
      if (heliLfo && heliFilter && heliMasterGain) {
        const rotorRate = 11.5 + throttle * 6.5 + clamp(speedAbs / 80, 0, 1) * 2.0;
        heliLfo.frequency.setTargetAtTime(rotorRate, now, 0.08);
        heliFilter.frequency.setTargetAtTime(210 + throttle * 200, now, 0.08);
        heliMasterGain.gain.setTargetAtTime(heliOn ? 0.24 + throttle * 0.14 : 0.0001, now, 0.08);
      }

      // 4) Passos a pé
      if (alive && vehicle === 'foot' && speedAbs > 0.6 && state.heightAboveGround < 1.1) {
        const cadence = clamp(0.46 - speedAbs * 0.025, 0.26, 0.48);
        stepTimer += dt;
        if (stepTimer >= cadence) {
          stepTimer = 0;
          triggerFootstep();
        }
      } else {
        stepTimer = 0.25;
      }

      // 5) Vento proporcional à velocidade
      if (windFilter && windGain) {
        const windNorm = clamp(speedAbs / (isCar ? 90 : 160), 0, 1.15);
        windFilter.frequency.setTargetAtTime(240 + windNorm * 1100, now, 0.08);
        const windScale = vehicle === 'foot' ? 0.04 : isCar ? 0.16 : 0.26;
        const windLevel = alive ? Math.pow(windNorm, 1.6) * windScale : 0.0001;
        windGain.gain.setTargetAtTime(windLevel, now, 0.08);
      }

      // 6) Alerta de estol (somente aeronaves)
      if (stallGain && stallOsc) {
        if (alive && (vehicle === 'a29' || vehicle === 'heli') && state.stall) {
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
      playSfxTone(520, 680, 0.045, 0.14, 'triangle');
    },

    playConfirm() {
      playSfxTone(440, 660, 0.075, 0.18, 'triangle');
    },

    playDelivery() {
      playSfxTone(784, 784, 0.11, 0.2, 'triangle', 0);
      playSfxTone(1046.5, 1046.5, 0.14, 0.22, 'triangle', 0.08);
      playSfxTone(1318.5, 1318.5, 0.22, 0.18, 'sine', 0.16);
    },

    playStageFanfare() {
      const notes = [523.25, 659.25, 783.99, 1046.5];
      for (let i = 0; i < notes.length; i++) {
        playSfxTone(notes[i], notes[i], i === notes.length - 1 ? 0.42 : 0.13, 0.22, 'triangle', i * 0.09);
      }
      playSfxTone(523.25, 523.25, 0.42, 0.14, 'sine', 0.27);
    },

    playVictory() {
      const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
      for (let i = 0; i < notes.length; i++) {
        playSfxTone(notes[i], notes[i], i === notes.length - 1 ? 0.65 : 0.14, 0.2, 'triangle', i * 0.085);
      }
    },

    playDefeat() {
      // Badalada de meia-noite + queda menor
      playSfxTone(440, 430, 0.55, 0.22, 'sine', 0);
      playSfxTone(392, 385, 0.42, 0.18, 'triangle', 0.28);
      playSfxTone(329.63, 293.66, 0.65, 0.2, 'triangle', 0.52);
    },

    playLocked() {
      playSfxTone(210, 165, 0.09, 0.18, 'sawtooth', 0);
      playSfxTone(170, 135, 0.11, 0.16, 'sawtooth', 0.1);
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;

      for (const node of activeNodes) {
        try {
          node.stop();
        } catch {
          // Já encerrado
        }
      }
      activeNodes.clear();

      for (const continuous of [
        propOsc,
        subOsc,
        turbineOsc,
        carOsc,
        carSubOsc,
        nitroSrc,
        heliNoiseSrc,
        heliLfo,
        windSrc,
        stallOsc,
      ]) {
        if (!continuous) continue;
        try {
          continuous.stop();
        } catch {
          // Já encerrado
        }
      }

      propOsc = subOsc = turbineOsc = carOsc = carSubOsc = heliLfo = stallOsc = null;
      nitroSrc = heliNoiseSrc = windSrc = null;
      engineFilter = carFilter = nitroFilter = heliFilter = windFilter = musicFilter = null;
      engineGain =
        turbineGain =
        carGain =
        nitroGain =
        heliPulseGain =
        heliLfoDepth =
        heliMasterGain =
        windGain =
        stallGain =
          null;
      masterGain = musicBus = musicDuck = sfxBus = worldBus = null;
      noiseBuffer = null;

      if (ctx) {
        const closing = ctx;
        ctx = null;
        closing.close().catch(() => {});
      }
    },
  };
}
