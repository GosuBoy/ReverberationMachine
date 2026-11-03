import test from 'node:test';
import assert from 'node:assert/strict';
import { CircuitCandidatePedal, effectivePotResistance, predictedClosedLoopGain, REPORTED_FEEDBACK } from '../.test-build/dsp/candidate.js';
import { ReverberationAB } from '../.test-build/dsp/ab.js';
import { ReverberationPedal, DEFAULT_PARAMETERS } from '../.test-build/dsp/engine.js';
import { estimateGainMatch } from '../.test-build/dsp/match.js';

const sampleRate = 16000;
const params = { ...DEFAULT_PARAMETERS, altitude: 0.48, volume: 0.55, verb: 0.72, safety: 1 };

function run(pedal, frames = 9000, f = 169) {
  const left = [];
  for (let i = 0; i < frames; i++) {
    const x = 0.16 * Math.sin(2 * Math.PI * f * i / sampleRate) + (i % 4000 === 0 ? 0.1 : 0);
    pedal.process(x, x);
    left.push(pedal.left);
    assert.ok(Number.isFinite(pedal.left) && Number.isFinite(pedal.right));
  }
  return left;
}

function rms(samples) { return Math.sqrt(samples.reduce((acc, v) => acc + v*v, 0) / samples.length); }

test('v0.1 Classic path remains sample-identical when A/B and matching are off', () => {
  const legacy = new ReverberationPedal(sampleRate, params);
  const comparison = new ReverberationAB(sampleRate, params);
  for (let i = 0; i < 24000; i++) {
    const x = 0.15 * Math.sin(i * 0.037);
    legacy.process(x, x * 0.7);
    comparison.process(x, x * 0.7);
    assert.equal(comparison.left, legacy.left);
    assert.equal(comparison.right, legacy.right);
  }
});

test('candidate feedback uses documented RC values and attenuates high-frequency variable gain', () => {
  assert.equal(REPORTED_FEEDBACK.feedbackResistorOhms, 68000);
  assert.equal(REPORTED_FEEDBACK.groundResistorOhms, 10000);
  assert.equal(REPORTED_FEEDBACK.feedbackCapacitanceFarads, 100e-12);
  assert.equal(effectivePotResistance(0), 0);
  assert.equal(effectivePotResistance(1), 1e6);
  assert.ok(predictedClosedLoopGain(1, 200) > predictedClosedLoopGain(1, 12000) * 2);
  assert.ok(predictedClosedLoopGain(1, 200) > predictedClosedLoopGain(0.01, 200) * 5);
});

test('Bright/Dark mode only influences the wet branch in candidate (verb=0)', () => {
  const dark = new CircuitCandidatePedal(sampleRate, { ...params, verb: 0, tone: 0 });
  const bright = new CircuitCandidatePedal(sampleRate, { ...params, verb: 0, tone: 1 });
  for (let i = 0; i < 16000; i++) {
    const input = Math.sin(i * 0.08) * 0.13;
    dark.process(input, input);
    bright.process(input, input);
    assert.equal(dark.left, bright.left);
  }
});

test('candidate bright and dark wet tails differ while staying finite and mono', () => {
  const dark = new CircuitCandidatePedal(sampleRate, { ...params, verb: 1, tone: 0 });
  const bright = new CircuitCandidatePedal(sampleRate, { ...params, verb: 1, tone: 1 });
  let accumulated = 0;
  for (let i = 0; i < 26000; i++) {
    const sample = i < 9000 ? 0.16 * Math.sin(2 * Math.PI * 220 * i / sampleRate) : 0;
    dark.process(sample, sample);
    bright.process(sample, sample);
    accumulated += Math.abs(dark.left - bright.left);
    assert.equal(dark.left, dark.right);
    assert.ok(Number.isFinite(bright.left));
    assert.ok(Math.abs(bright.left) < 1);
  }
  assert.ok(accumulated > 0.01, `expected wet-mode difference; saw ${accumulated}`);
});

test('candidate drives harder at higher Altitude with bounded output', () => {
  const low = run(new CircuitCandidatePedal(sampleRate, { ...params, altitude: 0.03 }), 7000);
  const high = run(new CircuitCandidatePedal(sampleRate, { ...params, altitude: 0.9 }), 7000);
  assert.ok(high.some((v, i) => Math.abs(v - low[i]) > 0.1));
  assert.ok(Math.max(...high.map(Math.abs)) < 1);
});

test('A/B switching crossfades over time and preserves finite output', () => {
  const ab = new ReverberationAB(sampleRate, params);
  run(ab, 4000);
  const before = ab.left;
  ab.setProfile('candidate');
  ab.setLevelMatch(true);
  ab.setCandidateTrimDb(8);
  const after = run(ab, 5000);
  assert.ok(Math.abs(after[0] - before) < 0.13, 'one-sample output discontinuity is bounded');
  assert.ok(after.every(Number.isFinite));
  ab.setProfile('classic');
  assert.ok(run(ab, 2000).every(Number.isFinite));
});

test('fixed reference calibration is reproducible and bounded, without real-time AGC', () => {
  const a = estimateGainMatch(sampleRate, params);
  const b = estimateGainMatch(sampleRate, params);
  assert.deepEqual(a, b);
  assert.ok(Number.isFinite(a.candidateTrimDb));
  assert.ok(Math.abs(a.candidateTrimDb) <= 12);
  assert.equal(a.reference, 'fixture');
  assert.ok(Number.isFinite(a.rawDifferenceDb));
});

test('explicit input source is used for calibration rather than synthetic fixture', () => {
  const input = new Float32Array(sampleRate / 2);
  for (let i = 0; i < input.length; i++) input[i] = Math.sin(i * 0.08) * 0.14;
  const result = estimateGainMatch(sampleRate, params, input);
  assert.equal(result.reference, 'source');
  assert.ok(Number.isFinite(result.candidateTrimDb));
});

test('invalid samples and extreme parameters are contained in both models', () => {
  const ab = new ReverberationAB(48000, params);
  ab.setProfile('candidate', true);
  ab.setParameters({ altitude: Number.POSITIVE_INFINITY, verb: NaN }, true);
  ab.setCandidateTrimDb(Infinity, true);
  for (let i = 0; i < 10000; i++) {
    ab.process(i%2 ? NaN : Infinity, -Infinity);
    assert.ok(Number.isFinite(ab.left) && Number.isFinite(ab.right));
  }
});
