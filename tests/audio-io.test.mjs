import test from 'node:test';
import assert from 'node:assert/strict';
import { OutputRouter, contextOptions, liveGuitarConstraints, readLatency } from '../.test-build/audio/io.js';

function fakeGraph(native = true) {
  const events = [];
  const defaultDestination = { id: 'default-destination' };
  const connections = new Set();
  const source = {
    connect(to) { connections.add(to); events.push(['connect', to.id]); },
    disconnect() { connections.clear(); events.push(['disconnect']); },
  };
  const context = {
    destination: defaultDestination,
    createMediaStreamDestination() {
      const destination = { id: 'stream-destination', stream: { id: 'fake-stream' }, disconnect() { events.push(['stream-disconnect']); } };
      return destination;
    },
  };
  if (native) {
    context.setSinkId = async (id) => { events.push(['native-sink', id]); };
  }
  return { context, source, defaultDestination, connections, events };
}

function audioFactory(logs, failPlay = false, failSink = false) {
  return () => ({
    srcObject: null,
    autoplay: false,
    setSinkId: async (id) => { logs.push(['media-sink', id]); if (failSink) throw Error('No output permission'); },
    play: async () => { logs.push(['media-play']); if (failPlay) throw Error('Autoplay denied'); },
    pause: () => { logs.push(['media-pause']); },
  });
}

test('numeric low-latency hint and non-voice-processing capture constraints', () => {
  assert.deepEqual(contextOptions('low'), { latencyHint: 0.005 });
  assert.deepEqual(contextOptions('balanced'), { latencyHint: 'interactive' });
  assert.deepEqual(contextOptions('stable'), { latencyHint: 'balanced' });
  const constraints = liveGuitarConstraints();
  assert.equal(constraints.video, false);
  assert.equal(constraints.audio.echoCancellation, false);
  assert.equal(constraints.audio.noiseSuppression, false);
  assert.equal(constraints.audio.autoGainControl, false);
  assert.equal(constraints.audio.latency.ideal, 0.005);
  assert.equal(constraints.audio.channelCount.ideal, 1);
});

test('reported output latency never claims an unmeasured round-trip latency', () => {
  assert.deepEqual(readLatency({ baseLatency: 0.003, outputLatency: 0.014 }, { latency: 0.008 }, false), {
    baseMs: 3, outputMs: 14, inputMs: 8, knownOutputMs: 17, fallback: false,
  });
  assert.equal(readLatency({ baseLatency: 0.003 }, null, true).knownOutputMs, null);
  assert.equal(readLatency({ baseLatency: NaN, outputLatency: Infinity }).knownOutputMs, null);
});

test('native sink selection preserves direct Web Audio graph without duplicate connections', async () => {
  const g = fakeGraph(true);
  const router = new OutputRouter(g.context, g.source);
  assert.equal(g.connections.size, 1);
  assert.equal(router.mode, 'direct');
  assert.equal(await router.select('usb-headphones'), 'direct');
  assert.equal(router.deviceId, 'usb-headphones');
  assert.deepEqual([...g.connections], [g.defaultDestination]);
  assert.equal(await router.select(''), 'direct');
  assert.equal(router.deviceId, '');
  assert.ok(g.events.some(e => e[0] === 'native-sink' && e[1] === 'usb-headphones'));
  assert.ok(g.events.some(e => e[0] === 'native-sink' && e[1] === ''));
  router.dispose();
  assert.equal(g.connections.size, 0);
});

test('fallback routes only selected outputs through a media element; default stays direct', async () => {
  const g = fakeGraph(false);
  const router = new OutputRouter(g.context, g.source, audioFactory(g.events));
  assert.equal(await router.select('headphones'), 'media-element');
  assert.equal(router.mode, 'media-element');
  assert.equal(router.deviceId, 'headphones');
  assert.equal(g.connections.size, 1);
  assert.equal([...g.connections][0].id, 'stream-destination');
  assert.ok(g.events.some(e => e[0] === 'media-play'));
  assert.equal(await router.select(''), 'direct');
  assert.deepEqual([...g.connections], [g.defaultDestination]);
  assert.ok(g.events.some(e => e[0] === 'media-pause'));
  router.dispose();
});

test('fallback rejects autoplay failure and restores the original audio connection', async () => {
  const g = fakeGraph(false);
  const router = new OutputRouter(g.context, g.source, audioFactory(g.events, true));
  await assert.rejects(router.select('headphones'), /Autoplay denied/);
  assert.equal(router.deviceId, '');
  assert.equal(router.mode, 'direct');
  assert.deepEqual([...g.connections], [g.defaultDestination]);
  router.dispose();
});

test('unsupported audio output selection does not interrupt the default output', async () => {
  const g = fakeGraph(false);
  const router = new OutputRouter(g.context, g.source, () => ({}));
  await assert.rejects(router.select('not-allowed'), /cannot select an output device/);
  assert.deepEqual([...g.connections], [g.defaultDestination]);
  router.dispose();
});

test('native setSinkId permission denial keeps previous sink and graph intact', async () => {
  const g = fakeGraph(true);
  g.context.setSinkId = async () => { throw Error('Permission denied'); };
  const router = new OutputRouter(g.context, g.source);
  await assert.rejects(router.select('not-granted'), /Permission denied/);
  assert.equal(router.deviceId, '');
  assert.deepEqual([...g.connections], [g.defaultDestination]);
  router.dispose();
});

test('failed element permission check leaves the previous selected output playing', async () => {
  const g = fakeGraph(false);
  let created = 0;
  const goodFactory = audioFactory(g.events);
  const badFactory = audioFactory(g.events, false, true);
  const router = new OutputRouter(g.context, g.source, () => (++created === 1 ? goodFactory() : badFactory()));
  await router.select('first-output');
  const old = [...g.connections][0];
  await assert.rejects(router.select('denied-output'), /No output permission/);
  assert.equal(router.mode, 'media-element');
  assert.equal(router.deviceId, 'first-output');
  assert.deepEqual([...g.connections], [old]);
  router.dispose();
});

test('switching between two element sinks leaves exactly one output route', async () => {
  const g = fakeGraph(false);
  const router = new OutputRouter(g.context, g.source, audioFactory(g.events));
  await router.select('headphones-A');
  await router.select('headphones-B');
  assert.equal(router.deviceId, 'headphones-B');
  assert.equal(g.connections.size, 1);
  assert.ok(g.events.filter(e => e[0] === 'media-pause').length >= 1);
  router.dispose();
});
