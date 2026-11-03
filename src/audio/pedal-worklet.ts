import { ReverberationPedal } from '../dsp/engine.js';

declare const sampleRate: number;
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
}

class ReverberationProcessor extends AudioWorkletProcessor {
  private readonly engine = new ReverberationPedal(sampleRate);

  static get parameterDescriptors(): Array<{ name: string; defaultValue: number; minValue: number; maxValue: number; automationRate: 'k-rate' }> {
    return [
      { name: 'altitude', defaultValue: 0.32, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'verb', defaultValue: 0.52, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'volume', defaultValue: 0.58, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'tone', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'bypass', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'safety', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
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
    this.engine.setParameter('altitude', parameters.altitude?.[0] ?? 0.32);
    this.engine.setParameter('verb', parameters.verb?.[0] ?? 0.52);
    this.engine.setParameter('volume', parameters.volume?.[0] ?? 0.58);
    this.engine.setParameter('tone', parameters.tone?.[0] ?? 0);
    this.engine.setParameter('bypass', parameters.bypass?.[0] ?? 0);
    this.engine.setParameter('safety', parameters.safety?.[0] ?? 1);
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
    return true; // Tail time: keep reverb alive after source ends.
  }
}

registerProcessor('reverberation-lab', ReverberationProcessor);
