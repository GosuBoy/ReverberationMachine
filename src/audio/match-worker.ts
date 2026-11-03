import { estimateGainMatch } from '../dsp/match.js';
import type { PedalParameters } from '../dsp/engine.js';

interface CalibrationRequest {
  id: number;
  sampleRate: number;
  params: PedalParameters;
  left?: Float32Array;
  right?: Float32Array;
}

self.onmessage = (event: MessageEvent<CalibrationRequest>): void => {
  const { id, sampleRate, params, left, right } = event.data;
  try {
    const result = estimateGainMatch(sampleRate, params, left, right);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
