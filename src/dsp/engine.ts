/**
 * Reverberation Machine Lab — independent, deterministic DSP core.
 *
 * IMPORTANT: This is a deliberately approximate Belton BTDR-2H-L-style network,
 * NOT a recovered Belton algorithm or a circuit-accurate model of a DBA pedal.
 * The 2018 traced circuit remains partly unverified. See MODEL_NOTES.md.
 */

const TAU = Math.PI * 2;
const finite = (n: number): number => Number.isFinite(n) ? n : 0;
const clamp = (n: number, a: number, b: number): number => Math.min(b, Math.max(a, finite(n)));

/** A circular sample buffer supporting fractionally interpolated reads. */
export class DelayBuffer {
  readonly data: Float32Array;
  private head = 0;

  constructor(maxDelaySamples: number) {
    if (!Number.isFinite(maxDelaySamples) || maxDelaySamples < 1) {
      throw new RangeError('maxDelaySamples must be >= 1');
    }
    this.data = new Float32Array(Math.ceil(maxDelaySamples) + 3);
  }

  get capacity(): number { return this.data.length - 2; }

  /** Read one or more samples *before* the current write location. */
  read(delaySamples: number): number {
    const delay = clamp(delaySamples, 1, this.capacity);
    let p = this.head - delay;
    if (p < 0) p += this.data.length;
    const i0 = Math.floor(p);
    const i1 = i0 + 1 === this.data.length ? 0 : i0 + 1;
    const f = p - i0;
    return this.data[i0] * (1 - f) + this.data[i1] * f;
  }

  write(sample: number): void {
    this.data[this.head] = clamp(sample, -16, 16);
    this.head++;
    if (this.head >= this.data.length) this.head = 0;
  }

  tick(input: number, delaySamples: number): number {
    const output = this.read(delaySamples);
    this.write(input);
    return output;
  }

  clear(): void { this.data.fill(0); this.head = 0; }
}

export class OnePoleLowpass {
  private state = 0;
  private coeff = 0;
  constructor(private readonly sampleRate: number, cutoffHz: number) {
    this.setCutoff(cutoffHz);
  }
  setCutoff(cutoffHz: number): void {
    const hz = clamp(cutoffHz, 1, this.sampleRate * 0.48);
    this.coeff = 1 - Math.exp(-TAU * hz / this.sampleRate);
  }
  process(input: number): number {
    this.state += this.coeff * (finite(input) - this.state);
    if (!Number.isFinite(this.state)) this.state = 0;
    return this.state;
  }
  clear(): void { this.state = 0; }
}

/** One-pole high pass obtained by subtracting a low-pass estimate. */
export class OnePoleHighpass {
  private readonly lowpass: OnePoleLowpass;
  constructor(sampleRate: number, cutoffHz: number) {
    this.lowpass = new OnePoleLowpass(sampleRate, cutoffHz);
  }
  process(input: number): number { return finite(input) - this.lowpass.process(input); }
  clear(): void { this.lowpass.clear(); }
}

export class ParameterSmoother {
  private currentValue: number;
  private targetValue: number;
  private readonly coefficient: number;
  constructor(sampleRate: number, start: number, smoothingMilliseconds = 12) {
    this.currentValue = start;
    this.targetValue = start;
    this.coefficient = 1 - Math.exp(-1 / (Math.max(0.001, smoothingMilliseconds) * 0.001 * sampleRate));
  }
  get current(): number { return this.currentValue; }
  setTarget(next: number): void { this.targetValue = finite(next); }
  snap(next: number): void { this.targetValue = this.currentValue = finite(next); }
  tick(): number {
    this.currentValue += this.coefficient * (this.targetValue - this.currentValue);
    return this.currentValue;
  }
}

/** Standard feedback all-pass diffuser; |g| must remain < 1. */
export class AllpassDiffuser {
  private readonly delay: DelayBuffer;
  private readonly delaySamples: number;
  private readonly gain: number;
  constructor(sampleRate: number, milliseconds: number, gain: number) {
    this.delaySamples = Math.max(1, Math.round(milliseconds * sampleRate / 1000));
    this.delay = new DelayBuffer(this.delaySamples + 2);
    this.gain = clamp(gain, -0.85, 0.85);
  }
  process(input: number): number {
    const delayed = this.delay.read(this.delaySamples);
    const toWrite = finite(input) + this.gain * delayed;
    this.delay.write(toWrite);
    return delayed - this.gain * toWrite;
  }
  clear(): void { this.delay.clear(); }
}

/** Damped, slowly modulated feedback comb; no allocation in process(). */
export class FeedbackComb {
  private readonly delay: DelayBuffer;
  private readonly nominalSamples: number;
  private readonly damp: OnePoleLowpass;
  private readonly feedback: number;
  private phase = 0;
  private readonly phaseStep: number;
  private readonly modulationDepth: number;
  constructor(sampleRate: number, delayMs: number, t60Seconds: number, modRateHz: number) {
    this.nominalSamples = Math.round(delayMs * sampleRate / 1000);
    this.delay = new DelayBuffer(this.nominalSamples + Math.ceil(sampleRate * 0.00012) + 4);
    this.feedback = Math.min(0.92, Math.pow(10, -3 * (delayMs / 1000) / t60Seconds));
    this.damp = new OnePoleLowpass(sampleRate, 4300);
    this.phaseStep = TAU * modRateHz / sampleRate;
    this.modulationDepth = 0.00008 * sampleRate;
  }
  process(input: number): number {
    // < 0.1 ms pitch modulation. Not a verified internal Belton characteristic.
    const mod = Math.sin(this.phase) * this.modulationDepth;
    this.phase += this.phaseStep;
    if (this.phase >= TAU) this.phase -= TAU;
    const delayed = this.delay.read(this.nominalSamples + mod);
    const filtered = this.damp.process(delayed);
    this.delay.write(clamp(input + filtered * this.feedback, -8, 8));
    return delayed;
  }
  clear(): void { this.delay.clear(); this.damp.clear(); this.phase = 0; }
}

class ReverbChannel {
  private readonly diffuser1: AllpassDiffuser;
  private readonly diffuser2: AllpassDiffuser;
  private readonly diffuser3: AllpassDiffuser;
  private readonly combs: FeedbackComb[];
  private readonly tone: OnePoleLowpass;
  private readonly dc: OnePoleHighpass;

  constructor(sampleRate: number, right: boolean) {
    const spread = right ? 1.117 : 1;
    this.diffuser1 = new AllpassDiffuser(sampleRate, 7.7 * spread, 0.62);
    this.diffuser2 = new AllpassDiffuser(sampleRate, 11.3 * spread, 0.61);
    this.diffuser3 = new AllpassDiffuser(sampleRate, 16.9 * spread, 0.54);
    const times = right ? [67.1, 83.9, 103.1, 127.7] : [61.7, 79.3, 97.1, 113.9];
    this.combs = times.map((ms, idx) => new FeedbackComb(sampleRate, ms, 2.85, 0.19 + idx * 0.071));
    this.tone = new OnePoleLowpass(sampleRate, 5300);
    this.dc = new OnePoleHighpass(sampleRate, 110);
  }

  process(sample: number): number {
    let x = this.diffuser1.process(sample);
    x = this.diffuser2.process(x);
    x = this.diffuser3.process(x);
    const result = (this.combs[0].process(x * 0.32) +
      this.combs[1].process(x * 0.32) +
      this.combs[2].process(x * 0.32) +
      this.combs[3].process(x * 0.32)) * 0.47;
    return this.dc.process(this.tone.process(result));
  }

  clear(): void {
    this.diffuser1.clear(); this.diffuser2.clear(); this.diffuser3.clear();
    for (const c of this.combs) c.clear();
    this.tone.clear(); this.dc.clear();
  }
}

/** Approximation using custom delay buffers, damped comb feedback, and diffusers. */
export class BeltonStyleReverb {
  private readonly leftTank: ReverbChannel;
  private readonly rightTank: ReverbChannel;
  left = 0;
  right = 0;
  constructor(sampleRate: number) {
    this.leftTank = new ReverbChannel(sampleRate, false);
    this.rightTank = new ReverbChannel(sampleRate, true);
  }
  process(inputL: number, inputR: number): void {
    const mid = (finite(inputL) + finite(inputR)) * 0.5;
    const side = (finite(inputL) - finite(inputR)) * 0.5;
    this.left = this.leftTank.process(mid + side * 0.14);
    this.right = this.rightTank.process(mid - side * 0.14);
  }
  clear(): void { this.leftTank.clear(); this.rightTank.clear(); this.left = 0; this.right = 0; }
}

export interface PedalParameters {
  altitude: number; // 0–1; hypothetical nonlinear gain range
  verb: number;     // 0–1; wet gain, from off to above unity
  volume: number;   // 0–1
  tone: number;     // 0 dark, 1 bright
  bypass: number;   // 0 effect on, 1 true dry passthrough
  safety: number;   // 1 = soft output limiting
}

export const DEFAULT_PARAMETERS: Readonly<PedalParameters> = Object.freeze({
  altitude: 0.32, verb: 0.52, volume: 0.58, tone: 0, bypass: 0, safety: 1,
});

/** Safe, deterministic, testable pedal core with allocation-free per-sample processing. */
export class ReverberationPedal {
  readonly sampleRate: number;
  private readonly altitude: ParameterSmoother;
  private readonly verb: ParameterSmoother;
  private readonly volume: ParameterSmoother;
  private readonly tone: ParameterSmoother;
  private readonly bypass: ParameterSmoother;
  private readonly safety: ParameterSmoother;
  private readonly inputHPLeft: OnePoleHighpass;
  private readonly inputHPRight: OnePoleHighpass;
  private readonly darkL: OnePoleLowpass;
  private readonly darkR: OnePoleLowpass;
  private readonly brightL: OnePoleLowpass;
  private readonly brightR: OnePoleLowpass;
  readonly reverb: BeltonStyleReverb;
  left = 0;
  right = 0;

  constructor(sampleRate: number, parameters: Partial<PedalParameters> = {}) {
    if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
      throw new RangeError('sampleRate must be 8–192 kHz');
    }
    this.sampleRate = sampleRate;
    const p = { ...DEFAULT_PARAMETERS, ...parameters };
    this.altitude = new ParameterSmoother(sampleRate, clamp(p.altitude, 0, 1));
    this.verb = new ParameterSmoother(sampleRate, clamp(p.verb, 0, 1));
    this.volume = new ParameterSmoother(sampleRate, clamp(p.volume, 0, 1));
    this.tone = new ParameterSmoother(sampleRate, clamp(p.tone, 0, 1), 24);
    this.bypass = new ParameterSmoother(sampleRate, clamp(p.bypass, 0, 1), 4);
    this.safety = new ParameterSmoother(sampleRate, clamp(p.safety, 0, 1), 4);
    this.inputHPLeft = new OnePoleHighpass(sampleRate, 25);
    this.inputHPRight = new OnePoleHighpass(sampleRate, 25);
    this.darkL = new OnePoleLowpass(sampleRate, 1950);
    this.darkR = new OnePoleLowpass(sampleRate, 1950);
    this.brightL = new OnePoleLowpass(sampleRate, 8000);
    this.brightR = new OnePoleLowpass(sampleRate, 8000);
    this.reverb = new BeltonStyleReverb(sampleRate);
  }

  setParameter(name: keyof PedalParameters, value: number, immediate = false): void {
    const sm = this[name];
    if (!(sm instanceof ParameterSmoother)) return;
    if (immediate) sm.snap(clamp(value, 0, 1));
    else sm.setTarget(clamp(value, 0, 1));
  }
  setParameters(parameters: Partial<PedalParameters>, immediate = false): void {
    for (const name of ['altitude', 'verb', 'volume', 'tone', 'bypass', 'safety'] as const) {
      if (Object.prototype.hasOwnProperty.call(parameters, name)) {
        this.setParameter(name, parameters[name] as number, immediate);
      }
    }
  }

  static softLimit(x: number): number {
    const v = clamp(x, -16, 16);
    const a = Math.abs(v);
    if (a <= 0.84) return v;
    return Math.sign(v) * (0.84 + 0.15 * Math.tanh((a - 0.84) / 0.15));
  }

  process(inputL: number, inputR: number): void {
    const rawL = clamp(inputL, -4, 4);
    const rawR = clamp(inputR, -4, 4);
    const altitude = this.altitude.tick();
    const verb = this.verb.tick();
    const volume = this.volume.tick();
    const tone = this.tone.tick();
    const bypass = this.bypass.tick();
    const safety = this.safety.tick();

    const drive = 1 + 30 * altitude * altitude;
    const conditionedL = this.inputHPLeft.process(rawL);
    const conditionedR = this.inputHPRight.process(rawR);
    const gainL = Math.tanh(conditionedL * drive) * 0.8;
    const gainR = Math.tanh(conditionedR * drive) * 0.8;
    const reverbInL = this.darkL.process(gainL) * (1 - tone) + this.brightL.process(gainL) * tone;
    const reverbInR = this.darkR.process(gainR) * (1 - tone) + this.brightR.process(gainR) * tone;

    this.reverb.process(reverbInL, reverbInR);
    // Approximate balance: 'verb' goes above unity at maximum, as on the hardware.
    const wetGain = verb * verb * 3.1;
    const signalL = (gainL * 0.77 + this.reverb.left * wetGain) * volume;
    const signalR = (gainR * 0.77 + this.reverb.right * wetGain) * volume;
    const protectedL = signalL * (1 - safety) + ReverberationPedal.softLimit(signalL) * safety;
    const protectedR = signalR * (1 - safety) + ReverberationPedal.softLimit(signalR) * safety;
    this.left = clamp(rawL * bypass + protectedL * (1 - bypass), -8, 8);
    this.right = clamp(rawR * bypass + protectedR * (1 - bypass), -8, 8);
  }

  clear(): void {
    this.inputHPLeft.clear(); this.inputHPRight.clear();
    this.darkL.clear(); this.darkR.clear(); this.brightL.clear(); this.brightR.clear();
    this.reverb.clear(); this.left = 0; this.right = 0;
  }
}
