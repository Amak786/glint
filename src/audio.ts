// All sound in Glint is synthesised at runtime — no audio files to load.

let ctx: AudioContext | undefined;
let master: GainNode | undefined;

const SCALE = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25];

/** Browsers only allow audio after a user gesture, so call this from input handlers. */
export function wakeAudio() {
  try {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
      startPad();
    }
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    // No audio available: the game stays fully playable in silence.
  }
}

function tone(
  freq: number,
  at: number,
  length: number,
  volume: number,
  type: OscillatorType = 'sine',
) {
  if (!ctx || !master) return;
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(volume, t + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
  osc.connect(gain).connect(master);
  osc.start(t);
  osc.stop(t + length + 0.05);
}

/** A soft, slowly breathing drone under everything. */
function startPad() {
  if (!ctx || !master) return;
  const gain = ctx.createGain();
  gain.gain.value = 0.035;
  gain.connect(master);
  for (const f of [65.41, 98.0, 130.81]) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = f;
    osc.detune.value = (Math.random() - 0.5) * 8;
    osc.connect(gain);
    osc.start();
  }
  const lfo = ctx.createOscillator();
  const depth = ctx.createGain();
  lfo.frequency.value = 0.07;
  depth.gain.value = 0.015;
  lfo.connect(depth).connect(gain.gain);
  lfo.start();
}

export const sfx = {
  turn(slash: boolean) {
    tone(slash ? 880 : 740, 0, 0.09, 0.16, 'triangle');
    tone(slash ? 1320 : 1110, 0.02, 0.06, 0.05);
  },
  locked() {
    tone(160, 0, 0.12, 0.2, 'square');
  },
  button() {
    tone(520, 0, 0.07, 0.12, 'triangle');
  },
  crystal(index: number) {
    const f = SCALE[(index * 2) % SCALE.length] * 2;
    tone(f, 0, 0.7, 0.13);
    tone(f * 2, 0.01, 0.4, 0.04);
  },
  win(stars: number) {
    const notes = [0, 2, 4, 5, 7].slice(0, 2 + stars);
    notes.forEach((n, i) => {
      tone(SCALE[n] * 2, i * 0.11, 0.9, 0.14);
      tone(SCALE[n] * 4, i * 0.11, 0.5, 0.04);
    });
  },
};
