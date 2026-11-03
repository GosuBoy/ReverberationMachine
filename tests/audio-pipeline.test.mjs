import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDemoBuffer } from '../.test-build/audio/demo.js';
import { renderProcessedWav } from '../.test-build/audio/wav.js';
import { DEFAULT_PARAMETERS } from '../.test-build/dsp/engine.js';

function fakeAudioContext(sampleRate) {
  return {
    sampleRate,
    createBuffer(channels, frames) {
      const data = Array.from({ length: channels }, () => new Float32Array(frames));
      return { sampleRate, duration: frames / sampleRate, numberOfChannels: channels, length: frames,
        getChannelData(ch) { return data[ch]; } };
    },
  };
}

test('built-in original test riff contains audible plucked-string impulses', () => {
  const b = makeDemoBuffer(fakeAudioContext(44100));
  assert.equal(b.numberOfChannels, 1);
  assert.ok(b.duration > 8 && b.duration < 9);
  const samples = b.getChannelData(0);
  let peak = 0;
  for (const x of samples) peak = Math.max(peak, Math.abs(x));
  assert.ok(peak > 0.05 && peak < 1, `peak ${peak}`);
});

test('offline WAV renderer creates valid stereo PCM with a reverb tail', async () => {
  const context = fakeAudioContext(8000);
  const b = context.createBuffer(1, 8000);
  b.getChannelData(0)[0] = 0.5;
  let lastProgress = 0;
  const rendered = await renderProcessedWav(b, { ...DEFAULT_PARAMETERS, verb: 1 }, p => { lastProgress = p; });
  const bytes = await rendered.arrayBuffer();
  const view = new DataView(bytes);
  const ascii = (start, n) => new TextDecoder().decode(new Uint8Array(bytes, start, n));
  assert.equal(ascii(0, 4), 'RIFF');
  assert.equal(ascii(8, 4), 'WAVE');
  assert.equal(ascii(12, 4), 'fmt ');
  assert.equal(ascii(36, 4), 'data');
  assert.equal(view.getUint16(20, true), 1); // PCM
  assert.equal(view.getUint16(22, true), 2); // stereo
  assert.equal(view.getUint32(24, true), 8000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), bytes.byteLength - 44);
  assert.equal(lastProgress, 1);
  let latePeak = 0;
  for (let i = 8000; i < 16000; i++) latePeak = Math.max(latePeak, Math.abs(view.getInt16(44 + i * 4, true)));
  assert.ok(latePeak > 0, 'non-zero tail beyond source duration');
});

test('AudioWorklet wrapper registers and processes 128-frame stereo blocks', async () => {
  let registered = null;
  globalThis.sampleRate = 48000;
  globalThis.AudioWorkletProcessor = class { port = { onmessage: null }; constructor() {} };
  globalThis.registerProcessor = (name, ctor) => { registered = { name, ctor }; };
  await import('../.test-build/audio/pedal-worklet.js');
  assert.equal(registered.name, 'reverberation-lab');
  const processor = new registered.ctor();
  assert.equal(registered.ctor.parameterDescriptors.length, 9);
  const outputL = new Float32Array(128);
  const outputR = new Float32Array(128);
  const inputL = new Float32Array(128);
  inputL.fill(0.13);
  const params = Object.fromEntries(registered.ctor.parameterDescriptors.map(x => [x.name, new Float32Array([x.defaultValue])]));
  params.altitude[0] = 0.5;
  params.volume[0] = 0.5;
  assert.equal(processor.process([[inputL]], [[outputL, outputR]], params), true);
  assert.ok(outputL.some(v => v !== 0));
  assert.ok([...outputL, ...outputR].every(v => Number.isFinite(v)));
  processor.port.onmessage({ data: { command: 'reset' } });
  globalThis.registerProcessor = undefined;
  globalThis.AudioWorkletProcessor = undefined;
});

test('offline WAV export selects the circuit candidate and preserves Classic by default', async () => {
  const context = fakeAudioContext(8000);
  const b = context.createBuffer(1, 3200);
  const samples = b.getChannelData(0);
  for (let i = 0; i < samples.length; i++) samples[i] = 0.12 * Math.sin(i * 0.17);
  const options = { ...DEFAULT_PARAMETERS, altitude: 0.72, verb: 0.9 };
  const [defaultWav, candidateWav] = await Promise.all([
    renderProcessedWav(b, options),
    renderProcessedWav(b, options, () => {}, { profile: 'candidate' }),
  ]);
  const a = new Uint8Array(await defaultWav.arrayBuffer());
  const c = new Uint8Array(await candidateWav.arrayBuffer());
  assert.equal(a.length, c.length);
  assert.notDeepEqual(a.slice(44, 144), c.slice(44, 144));
});
