/** Deterministic, fixed reference RMS trim: no in-playback AGC or pumping. */
import { CircuitCandidatePedal } from './candidate.js';
import { ReverberationPedal, type PedalParameters } from './engine.js';

export interface GainMatchResult { candidateTrimDb: number; rawDifferenceDb: number; reference: 'source' | 'fixture'; }

export function makeMatchFixture(sampleRate: number): Float32Array {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new RangeError('sampleRate out of range');
  const data = new Float32Array(Math.ceil(sampleRate * 2));
  for (let i = 0; i < data.length; i++) {
    const t = i / sampleRate;
    const p = t % 0.42;
    const env = p < 0.008 ? p / 0.008 : Math.exp(-6 * (p - 0.008));
    data[i] = 0.16 * env * (Math.sin(2 * Math.PI * 146.83 * t) + 0.31 * Math.sin(2 * Math.PI * 293.66 * t));
  }
  return data;
}

/**
 * The same fixed mono/stereo fixture is rendered through both engines.
 * Trim is clipped to +/-12 dB to avoid dangerous loudness jumps.
 * This measures reference RMS, not perceptual loudness or hardware accuracy.
 */
export function estimateGainMatch(
  sampleRate: number, params: PedalParameters, left?: Float32Array, right?: Float32Array,
): GainMatchResult {
  const source = left ?? makeMatchFixture(sampleRate);
  const other = right ?? source;
  const classic = new ReverberationPedal(sampleRate, { ...params, bypass: 0 });
  const candidate = new CircuitCandidatePedal(sampleRate, { ...params, bypass: 0 });
  const extra = Math.ceil(sampleRate * 1.2);
  let sumClassic = 0;
  let sumCandidate = 0;
  let count = 0;
  for (let i = 0; i < source.length + extra; i++) {
    const l = source[i] ?? 0;
    const r = other[i] ?? l;
    classic.process(l, r);
    candidate.process(l, r);
    if (i > sampleRate * 0.08) {
      sumClassic += classic.left * classic.left + classic.right * classic.right;
      sumCandidate += candidate.left * candidate.left + candidate.right * candidate.right;
      count += 2;
    }
  }
  const rmsC = Math.sqrt(sumClassic / Math.max(1, count));
  const rmsN = Math.sqrt(sumCandidate / Math.max(1, count));
  // If either signal is nearly silent, do not boost a noise floor.
  const rawDifferenceDb = rmsC < 0.000001 || rmsN < 0.000001 ? 0 : 20 * Math.log10(rmsC / rmsN);
  return {
    candidateTrimDb: Math.max(-12, Math.min(12, rawDifferenceDb)),
    rawDifferenceDb,
    reference: left ? 'source' : 'fixture',
  };
}
