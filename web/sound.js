/**
 * Synthesized table sounds via the Web Audio API (no audio files).
 * The AudioContext is created lazily on first use, which always follows a
 * click or key press, so browser autoplay rules are satisfied.
 */
(function (root) {
  'use strict';

  let ctx = null;
  let muted = false;
  let volume = 0.8; // 0..1, multiplies every cue

  function audio() {
    if (!ctx) {
      const Ctx = root.AudioContext || root.webkitAudioContext;
      if (!Ctx) return null;
      ctx = new Ctx();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  /** One enveloped oscillator note. `at` is seconds from now. */
  function tone(freq, { at = 0, dur = 0.15, type = 'sine', gain = 0.15 } = {}) {
    const ac = audio();
    if (!ac) return;
    const t = ac.currentTime + at;
    const osc = ac.createOscillator();
    const amp = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * volume), t + 0.01);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(amp).connect(ac.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** Short filtered noise burst: a card sliding onto felt. */
  function swish(at) {
    const ac = audio();
    if (!ac) return;
    const t = ac.currentTime + at;
    const len = Math.floor(ac.sampleRate * 0.08);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ac.createBufferSource();
    const filter = ac.createBiquadFilter();
    const amp = ac.createGain();
    src.buffer = buf;
    filter.type = 'bandpass';
    filter.frequency.value = 3000;
    amp.gain.value = 0.25 * volume;
    src.connect(filter).connect(amp).connect(ac.destination);
    src.start(t);
  }

  const cues = {
    card: (at = 0) => swish(at),
    chip: (at = 0) => { tone(1800, { at, dur: 0.05, type: 'triangle', gain: 0.1 }); tone(2400, { at: at + 0.03, dur: 0.05, type: 'triangle', gain: 0.08 }); },
    win: (at = 0) => [523, 659, 784].forEach((f, i) => tone(f, { at: at + i * 0.09, dur: 0.25, type: 'triangle' })),
    blackjack: (at = 0) => [523, 659, 784, 1047].forEach((f, i) => tone(f, { at: at + i * 0.08, dur: 0.35, type: 'triangle', gain: 0.18 })),
    lose: (at = 0) => { tone(220, { at, dur: 0.3, type: 'sawtooth', gain: 0.06 }); tone(165, { at: at + 0.18, dur: 0.4, type: 'sawtooth', gain: 0.06 }); },
    push: (at = 0) => tone(440, { at, dur: 0.2, type: 'sine', gain: 0.1 }),
  };

  function play(name, at = 0) {
    if (muted || volume <= 0 || !cues[name]) return;
    try { cues[name](at); } catch (_) { /* audio is best-effort */ }
  }

  root.BlackjackSound = {
    play,
    get muted() { return muted; },
    set muted(v) { muted = !!v; },
    get volume() { return volume; },
    set volume(v) { volume = Math.min(1, Math.max(0, Number(v) || 0)); },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
