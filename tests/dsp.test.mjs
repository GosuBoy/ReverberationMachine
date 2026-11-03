import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DelayBuffer, OnePoleLowpass, OnePoleHighpass, ParameterSmoother,
  AllpassDiffuser, FeedbackComb, BeltonStyleReverb, ReverberationPedal,
} from '../.test-build/dsp/engine.js';

const close = (a, b, eps = 1e-5) => assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

test('delay buffer outputs an impulse at the requested exact sample', () => {
  const d = new DelayBuffer(20);
  const out = [];
  for (let i = 0; i < 30; i++) out.push(d.tick(i === 0 ? 1 : 0, 7));
  assert.equal(out.filter(v => v !== 0).length, 1);
  close(out[7], 1);
});

test('fractional delay linearly interpolates two neighbors', () => {
  const d = new DelayBuffer(12);
  for (let i = 1; i <= 5; i++) d.write(i);
  close(d.read(2.5), 3.5);
});

test('delay buffer wraps without introducing NaNs', () => {
  const d = new DelayBuffer(8);
  for (let i = 0; i < 9000; i++) assert.ok(Number.isFinite(d.tick(Math.sin(i), 3.25)));
  d.write(NaN);
  assert.ok(Number.isFinite(d.tick(1, Infinity)));
  d.clear();
  close(d.read(3), 0);
});

test('low-pass converges and high-pass rejects DC', () => {
  const lp = new OnePoleLowpass(48000, 700);
  const hp = new OnePoleHighpass(48000, 700);
  let lastHP = 0;
  for (let i = 0; i < 4800; i++) { lp.process(1); lastHP = hp.process(1); }
  close(lp.process(1), 1, 1e-4);
  close(lastHP, 0, 1e-4);
});

test('parameter smoothing is gradual and sample-rate aware', () => {
  for (const sr of [44100, 48000, 96000]) {
    const sm = new ParameterSmoother(sr, 0, 10);
    sm.setTarget(1);
    const first = sm.tick();
    assert.ok(first > 0 && first < 0.01);
    for (let i = 1; i < sr * 0.1; i++) sm.tick();
    close(sm.current, 1, 0.001);
  }
});

test('allpass diffuser and modulated feedback comb stay finite', () => {
  const ap = new AllpassDiffuser(48000, 7.7, 0.65);
  const comb = new FeedbackComb(48000, 79.3, 2.85, 0.25);
  let peak = 0;
  for (let i = 0; i < 48000 * 5; i++) {
    const out = comb.process(ap.process(i === 0 ? 0.9 : 0));
    assert.ok(Number.isFinite(out));
    peak = Math.max(peak, Math.abs(out));
  }
  assert.ok(peak > 0 && peak < 3);
});

test('reverb tail appears after input impulse and remains bounded', () => {
  const tank = new BeltonStyleReverb(48000);
  let lateEnergy = 0, peak = 0;
  for (let i = 0; i < 48000 * 4; i++) {
    tank.process(i === 0 ? 0.65 : 0, 0);
    if (i > 10000 && i < 75000) lateEnergy += Math.abs(tank.left) + Math.abs(tank.right);
    peak = Math.max(peak, Math.abs(tank.left), Math.abs(tank.right));
    assert.ok(Number.isFinite(tank.left) && Number.isFinite(tank.right));
  }
  assert.ok(lateEnergy > 0.1, `late energy ${lateEnergy}`);
  assert.ok(peak < 3, `peak ${peak}`);
});

test('pedal bypass preserves unprocessed dry input exactly', () => {
  const pedal = new ReverberationPedal(48000, { bypass: 1 });
  for (let i = 0; i < 10000; i++) {
    const a = 0.31 * Math.sin(i * 0.3), b = 0.2 * Math.cos(i * 0.2);
    pedal.process(a, b);
    close(pedal.left, a);
    close(pedal.right, b);
  }
});

test('zero volume mutes engaged path while bypass remains operational', () => {
  const pedal = new ReverberationPedal(48000, { volume: 0 });
  for (let i = 0; i < 4800; i++) {
    pedal.process(0.25, 0.25);
    close(pedal.left, 0);
  }
  pedal.setParameter('bypass', 1, true);
  pedal.process(0.21, -0.21);
  close(pedal.left, 0.21);
});

test('higher Altitude produces a different saturated gain response', () => {
  const a = new ReverberationPedal(48000, { altitude: 0.05, verb: 0, volume: 0.7 });
  const b = new ReverberationPedal(48000, { altitude: 0.98, verb: 0, volume: 0.7 });
  let aTotal = 0, bTotal = 0;
  for (let i = 0; i < 5000; i++) {
    const x = 0.07 * Math.sin(i * 0.18);
    a.process(x, x); b.process(x, x);
    aTotal += Math.abs(a.left); bTotal += Math.abs(b.left);
  }
  assert.ok(bTotal > aTotal * 1.25, `${aTotal}, ${bTotal}`);
});

test('Bright and Dark settings produce different wet signals', () => {
  const a = new ReverberationPedal(48000, { tone: 0, verb: 1 });
  const b = new ReverberationPedal(48000, { tone: 1, verb: 1 });
  let difference = 0;
  for (let i = 0; i < 48000; i++) {
    const input = Math.sin(i * 0.5) * 0.2;
    a.process(input, input); b.process(input, input);
    difference += Math.abs(a.left - b.left);
  }
  assert.ok(difference > 0.03, `difference = ${difference}`);
});

test('safety soft limiter limits extreme amplitudes but bypasses ordinary ones', () => {
  close(ReverberationPedal.softLimit(0.32), 0.32);
  assert.ok(ReverberationPedal.softLimit(100) < 1);
  assert.ok(ReverberationPedal.softLimit(-100) > -1);
});

test('non-finite and extreme inputs cannot poison the DSP state', () => {
  const p = new ReverberationPedal(96000);
  p.setParameters({ altitude: NaN, verb: Infinity, volume: -Infinity });
  for (let i = 0; i < 30000; i++) {
    const value = i % 71 === 0 ? NaN : i % 71 === 1 ? Infinity : i % 71 === 2 ? -Infinity : 0.2;
    p.process(value, -value);
    assert.ok(Number.isFinite(p.left) && Number.isFinite(p.right));
    assert.ok(Math.abs(p.left) <= 8 && Math.abs(p.right) <= 8);
  }
});

test('reverb remains present and stereo after mono input', () => {
  const p = new ReverberationPedal(44100, { verb: 1 });
  let difference = 0;
  for (let i = 0; i < 44100 * 2; i++) {
    p.process(i < 1000 ? Math.sin(i * 0.2) * 0.3 : 0, i < 1000 ? Math.sin(i * 0.2) * 0.3 : 0);
    if (i > 7000) difference += Math.abs(p.left - p.right);
  }
  assert.ok(difference > 0.1, `stereo difference ${difference}`);
});
