import { ReverberationAB } from '../dsp/ab.js';

declare const sampleRate: number;
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
}

class ReverberationProcessor extends AudioWorkletProcessor {
  private readonly engine = new ReverberationAB(sampleRate);

  static get parameterDescriptors(): Array<{ name: string; defaultValue: number; minValue: number; maxValue: number; automationRate: 'k-rate' }> {
    return [
      { name: 'altitude', defaultValue: 0.32, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'verb', defaultValue: 0.52, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'volume', defaultValue: 0.58, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'tone', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'bypass', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'safety', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'profile', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'match', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'trimDb', defaultValue: 0, minValue: -12, maxValue: 12, automationRate: 'k-rate' },
    ];
  }

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    this.port.onmessage = (event: MessageEvent<{ command?: string }>) => {
      if (event.data?.command === 'reset') this.engine.clear();
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    this.engine.setParameters({
      altitude: parameters.altitude?.[0] ?? 0.32,
      verb: parameters.verb?.[0] ?? 0.52,
      volume: parameters.volume?.[0] ?? 0.58,
      tone: parameters.tone?.[0] ?? 0,
      bypass: parameters.bypass?.[0] ?? 0,
      safety: parameters.safety?.[0] ?? 1,
    });
    this.engine.setProfile((parameters.profile?.[0] ?? 0) > 0.5 ? 'candidate' : 'classic');
    this.engine.setLevelMatch((parameters.match?.[0] ?? 0) > 0.5);
    this.engine.setCandidateTrimDb(parameters.trimDb?.[0] ?? 0);
    const incoming = inputs[0];
    const left = incoming?.[0];
    const right = incoming?.[1] ?? left;
    const outputL = out[0];
    const outputR = out[1];
    for (let i = 0; i < outputL.length; i++) {
      this.engine.process(left?.[i] ?? 0, right?.[i] ?? 0);
      outputL[i] = this.engine.left;
      if (outputR) outputR[i] = this.engine.right;
    }
    return true;
  }
}

registerProcessor('reverberation-lab', ReverberationProcessor);
