/**
 * v0.2 experimental analog-interaction candidate. NOT a verified SPICE model.
 *
 * Confirmed in a photographed unit: TLC27M4AIN, BTDR-2H-L, C1M control.
 * The 2018 tracer reports U1:B pins 6/7, 10k, 68k, 100pF and a C1M wiper.
 * Below we approximate the resulting non-inverting gain and RC feedback pole.
 * Exact pot orientation, other op-amp stages, switch and mixer nets remain open.
 */
import {
  BeltonStyleReverb, OnePoleHighpass, OnePoleLowpass, ParameterSmoother,
  ReverberationPedal, type PedalParameters, DEFAULT_PARAMETERS,
} from './engine.js';

const TWO_PI = 2 * Math.PI;
const safe = (x: number): number => Number.isFinite(x) ? x : 0;
const limited = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, safe(x)));

/** Physical component values found in the 2018 photo-corrected gain branch. */
export const REPORTED_FEEDBACK = Object.freeze({
  feedbackResistorOhms: 68_000,
  groundResistorOhms: 10_000,
  feedbackCapacitanceFarads: 100e-12,
  groundCapacitanceFarads: 1e-6,
  nominalPotentiometerOhms: 1_000_000,
});

/**
 * Effective R between lug 1 and the wiper. This deliberately is NOT claimed
 * to be a measured C1M taper: both knob orientation and loading are unknown.
 */
export function effectivePotResistance(altitude: number): number {
  return REPORTED_FEEDBACK.nominalPotentiometerOhms * Math.pow(limited(altitude, 0, 1), 2.15);
}

/**
 * Analytic small-signal |1 + (68k + (R || 100pF)) / (10k + 1/(s * 1uF))|.
 * For verification of the model's intended frequency response only.
 */
export function predictedClosedLoopGain(altitude: number, frequencyHz: number): number {
  const r = effectivePotResistance(altitude);
  const w = TWO_PI * Math.max(0.001, safe(frequencyHz));
  const a = w * r * REPORTED_FEEDBACK.feedbackCapacitanceFarads;
  const zfReal = REPORTED_FEEDBACK.feedbackResistorOhms + r / (1 + a * a);
  const zfImag = -r * a / (1 + a * a);
  const zgReal = REPORTED_FEEDBACK.groundResistorOhms;
  const zgImag = -1 / (w * REPORTED_FEEDBACK.groundCapacitanceFarads);
  const denom = zgReal * zgReal + zgImag * zgImag;
  const gainReal = 1 + (zfReal * zgReal + zfImag * zgImag) / denom;
  const gainImag = (zfImag * zgReal - zfReal * zgImag) / denom;
  return Math.hypot(gainReal, gainImag);
}

/** An approximate 9 V single-supply, mid-biased op-amp gain stage. */
class FeedbackGainStage {
  private readonly acFeedback: OnePoleHighpass;
  private readonly feedbackPole: OnePoleLowpass;
  private lastR = -1;
  constructor(private readonly sampleRate: number) {
    const fGround = 1 / (TWO_PI * REPORTED_FEEDBACK.groundResistorOhms * REPORTED_FEEDBACK.groundCapacitanceFarads);
    this.acFeedback = new OnePoleHighpass(sampleRate, fGround);
    this.feedbackPole = new OnePoleLowpass(sampleRate, 7000);
  }
  process(input: number, altitude: number): number {
    // Treat normalized input = 1 V peak for the candidate's reference gain calibration.
    // This mapping is a hypothesis, not measured guitar pickup impedance or op-amp rails.
    const volts = limited(input, -4, 4);
    const r = effectivePotResistance(altitude);
    if (Math.abs(r - this.lastR) > 80) {
      const fPole = r < 1 ? this.sampleRate * 0.45 : 1 / (TWO_PI * r * REPORTED_FEEDBACK.feedbackCapacitanceFarads);
      this.feedbackPole.setCutoff(fPole);
      this.lastR = r;
    }
    const boosted = this.acFeedback.process(volts);
    const frequencyLimited = this.feedbackPole.process(boosted);
    const outputVolts = volts +
      (REPORTED_FEEDBACK.feedbackResistorOhms / REPORTED_FEEDBACK.groundResistorOhms) * boosted +
      (r / REPORTED_FEEDBACK.groundResistorOhms) * frequencyLimited;
    // Candidate asymmetric rail knee around assumed +/- 3.1 V headroom (unmeasured).
    const upper = 3.15;
    const lower = 2.95;
    const norm = outputVolts >= 0 ? outputVolts / upper : outputVolts / lower;
    return Math.tanh(norm * 0.96) / 0.96;
  }
  clear(): void { this.acFeedback.clear(); this.feedbackPole.clear(); this.lastR = -1; }
}

/** Candidate with the tone switch on WET only and a shared post-mix gain knee. */
export class CircuitCandidatePedal {
  private readonly gain: FeedbackGainStage;
  private readonly tank: BeltonStyleReverb;
  private readonly lowWet: OnePoleLowpass;
  private readonly highWet: OnePoleLowpass;
  private readonly wetHighpass: OnePoleHighpass;
  private readonly altitude: ParameterSmoother;
  private readonly verb: ParameterSmoother;
  private readonly volume: ParameterSmoother;
  private readonly tone: ParameterSmoother;
  private readonly bypass: ParameterSmoother;
  private readonly safety: ParameterSmoother;
  left = 0;
  right = 0;

  constructor(sampleRate: number, parameters: Partial<PedalParameters> = {}) {
    if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new RangeError('sampleRate must be 8–192 kHz');
    const p = { ...DEFAULT_PARAMETERS, ...parameters };
    this.gain = new FeedbackGainStage(sampleRate);
    this.tank = new BeltonStyleReverb(sampleRate); // same provisional tank as v0.1, for a controlled comparison
    this.lowWet = new OnePoleLowpass(sampleRate, 1750);
    this.highWet = new OnePoleLowpass(sampleRate, 6100);
    this.wetHighpass = new OnePoleHighpass(sampleRate, 260);
    this.altitude = new ParameterSmoother(sampleRate, limited(p.altitude, 0, 1));
    this.verb = new ParameterSmoother(sampleRate, limited(p.verb, 0, 1));
    this.volume = new ParameterSmoother(sampleRate, limited(p.volume, 0, 1));
    this.tone = new ParameterSmoother(sampleRate, limited(p.tone, 0, 1), 24);
    this.bypass = new ParameterSmoother(sampleRate, limited(p.bypass, 0, 1), 4);
    this.safety = new ParameterSmoother(sampleRate, limited(p.safety, 0, 1), 4);
  }

  setParameter(name: keyof PedalParameters, value: number, immediate = false): void {
    const target = this[name];
    if (!(target instanceof ParameterSmoother)) return;
    const v = limited(value, 0, 1);
    if (immediate) target.snap(v); else target.setTarget(v);
  }
  setParameters(parameters: Partial<PedalParameters>, immediate = false): void {
    for (const key of ['altitude', 'verb', 'volume', 'tone', 'bypass', 'safety'] as const) {
      if (Object.prototype.hasOwnProperty.call(parameters, key)) this.setParameter(key, parameters[key] as number, immediate);
    }
  }

  process(inputL: number, inputR: number): void {
    const rawL = limited(inputL, -4, 4);
    const rawR = limited(inputR, -4, 4);
    // Original pedal is mono; sum incoming stereo only for this candidate profile.
    const mono = (rawL + rawR) * 0.5;
    const drive = this.gain.process(mono, this.altitude.tick());
    this.tank.process(drive, drive);
    const wetMono = (this.tank.left + this.tank.right) * 0.5;
    const dark = this.lowWet.process(wetMono);
    const light = this.highWet.process(this.wetHighpass.process(wetMono));
    const tone = this.tone.tick();
    const wet = dark * (1 - tone) + light * tone * 1.08;
    const verb = this.verb.tick();
    // Both reverb and dry gain enter a shared, provisional output clipping stage.
    // This wet/dry interaction is explicitly NOT yet traced to the original output net.
    const mixed = 0.65 * drive + (1.65 * verb * verb) * wet;
    const postMix = Math.tanh(mixed * 1.08) / 1.08;
    const volume = this.volume.tick();
    const signal = postMix * volume;
    const safety = this.safety.tick();
    const protectedSignal = signal * (1 - safety) + ReverberationPedal.softLimit(signal) * safety;
    const bypass = this.bypass.tick();
    // Preserve original mono dry passthrough in candidate mode, not stereo-enhanced output.
    this.left = limited(mono * bypass + protectedSignal * (1 - bypass), -8, 8);
    this.right = this.left;
  }

  clear(): void {
    this.gain.clear(); this.tank.clear();
    this.lowWet.clear(); this.highWet.clear(); this.wetHighpass.clear();
    this.left = this.right = 0;
  }
}
