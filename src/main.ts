import workletUrl from './audio/pedal-worklet.ts?worker&url';
import matchWorkerUrl from './audio/match-worker.ts?worker&url';
import { OutputRouter, contextOptions, liveGuitarConstraints, readLatency, type LatencyPreset } from './audio/io.js';
import type { ModelProfile } from './dsp/ab.js';
import type { GainMatchResult } from './dsp/match.js';
import { makeDemoBuffer } from './audio/demo.js';
import { renderProcessedWav } from './audio/wav.js';
import { DEFAULT_PARAMETERS, type PedalParameters } from './dsp/engine.js';

const elem = <T extends HTMLElement>(id: string): T => {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Missing element #${id}`);
  return result as T;
};

class ReverbLab {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserData = new Float32Array(1024);
  private currentBuffer: AudioBuffer | null = null;
  private currentName = '';
  private playbackSource: AudioBufferSourceNode | null = null;
  private microphoneStream: MediaStream | null = null;
  private microphoneSource: MediaStreamAudioSourceNode | null = null;
  private playing = false;
  private offset = 0;
  private started = 0;
  private params: PedalParameters = { ...DEFAULT_PARAMETERS };
  private rendering = false;
  private activeProfile: ModelProfile = 'classic';
  private levelMatch = false;
  private matchedTrimDb = 0;
  private matchWorker: Worker | null = null;
  private calibrationId = 0;
  private calibrationTimer: number | null = null;
  private outputRouter: OutputRouter | null = null;
  private selectedOutputDevice = '';
  private latencyPreference: LatencyPreset = 'low';
  private outputBusy = false;

  constructor() {
    this.wireControls();
    this.updateDialReadouts();
    this.renderScope();
    void this.refreshOutputDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', () => { void this.refreshOutputDevices(); });
    this.updateIoReport();
  }

  private setStatus(message: string, error = false): void {
    const status = elem<HTMLElement>('status');
    status.textContent = message;
    status.classList.toggle('error', error);
  }

  private updateDialReadouts(): void {
    for (const name of ['altitude', 'verb', 'volume'] as const) {
      const input = elem<HTMLInputElement>(name);
      const value = Number(input.value);
      elem<HTMLOutputElement>(`${name}-value`).value = String(value).padStart(2, '0');
      elem<HTMLElement>(`${name}-dial`).style.setProperty('--rotation', `${-135 + 2.7 * value}deg`);
    }
  }

  private wireControls(): void {
    for (const name of ['altitude', 'verb', 'volume'] as const) {
      elem<HTMLInputElement>(name).addEventListener('input', () => {
        this.params[name] = Number(elem<HTMLInputElement>(name).value) / 100;
        this.updateDialReadouts();
        this.updateParam(name);
        this.scheduleCalibration();
      });
    }
    for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-tone]')) {
      btn.addEventListener('click', () => {
        this.params.tone = btn.dataset.tone === 'bright' ? 1 : 0;
        document.querySelectorAll<HTMLButtonElement>('[data-tone]').forEach(el => {
          el.setAttribute('aria-pressed', String(el === btn));
        });
        this.updateParam('tone');
        this.scheduleCalibration();
      });
    }
    elem<HTMLButtonElement>('bypass').addEventListener('click', () => {
      this.params.bypass = this.params.bypass ? 0 : 1;
      elem<HTMLButtonElement>('bypass').setAttribute('aria-pressed', String(!!this.params.bypass));
      elem('pedal').classList.toggle('is-bypassed', !!this.params.bypass);
      elem('effect-label').textContent = this.params.bypass ? 'BYPASSED' : 'ACTIVE';
      this.updateParam('bypass');
    });
    elem<HTMLInputElement>('safety').addEventListener('change', (event) => {
      this.params.safety = (event.currentTarget as HTMLInputElement).checked ? 1 : 0;
      this.updateParam('safety');
      this.scheduleCalibration();
      this.setStatus(this.params.safety ? 'Output safety enabled.' : 'Caution: output safety disabled; start at low volume.');
    });
    elem<HTMLInputElement>('loop').addEventListener('change', () => {
      if (this.playbackSource) this.playbackSource.loop = elem<HTMLInputElement>('loop').checked;
    });
    elem<HTMLButtonElement>('demo-button').addEventListener('click', () => { void this.selectDemo(); });
    elem<HTMLInputElement>('file-input').addEventListener('change', (event) => {
      const file = (event.currentTarget as HTMLInputElement).files?.[0];
      if (file) void this.selectFile(file);
    });
    elem<HTMLButtonElement>('play-button').addEventListener('click', () => { void this.togglePlayback(); });
    elem<HTMLButtonElement>('stop-button').addEventListener('click', () => this.stopPlayback(true));
    elem<HTMLButtonElement>('mic-button').addEventListener('click', () => { void this.toggleMicrophone(); });
    elem<HTMLButtonElement>('export-button').addEventListener('click', () => { void this.exportWav(); });
    elem<HTMLSelectElement>('output-device').addEventListener('change', () => {
      void this.switchOutput(elem<HTMLSelectElement>('output-device').value);
    });
    elem<HTMLButtonElement>('output-refresh').addEventListener('click', () => { void this.refreshOutputDevices(); });
    elem<HTMLButtonElement>('output-choose').addEventListener('click', () => { void this.chooseOutput(); });
    elem<HTMLButtonElement>('latency-apply').addEventListener('click', () => { void this.applyLatencyPreference(); });
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-profile]')) {
      button.addEventListener('click', () => {
        this.activeProfile = button.dataset.profile === 'candidate' ? 'candidate' : 'classic';
        document.querySelectorAll<HTMLButtonElement>('[data-profile]').forEach(other =>
          other.setAttribute('aria-pressed', String(other === button)));
        this.updateComparisonControl('profile', this.activeProfile === 'candidate' ? 1 : 0);
        elem<HTMLElement>('model-note').textContent = this.activeProfile === 'classic'
          ? 'Original v0.1 sound, unchanged.'
          : 'v0.2 uses reported feedback RC values and provisional mono, wet-only tone and mixer stages. Not a measured original pedal.';
      });
    }
    elem<HTMLInputElement>('level-match').addEventListener('change', (event) => {
      this.levelMatch = (event.currentTarget as HTMLInputElement).checked;
      if (this.levelMatch) this.scheduleCalibration(0);
      else {
        this.calibrationId++;
        if (this.calibrationTimer !== null) window.clearTimeout(this.calibrationTimer);
        this.updateComparisonControl('match', 0);
        elem('match-result').textContent = 'Level match off · no playback AGC';
      }
    });
  }

  private supportsOutputSelection(): boolean {
    // Feature detection rather than browser sniffing: Safari/Firefox may only
    // support default output, while Chrome exposes AudioContext.setSinkId.
    return (typeof AudioContext !== 'undefined' && typeof (AudioContext.prototype as AudioContext & { setSinkId?: (id: string) => Promise<void> }).setSinkId === 'function') ||
      (typeof HTMLMediaElement !== 'undefined' && typeof HTMLMediaElement.prototype.setSinkId === 'function');
  }

  private async refreshOutputDevices(preferred?: { deviceId: string; label: string }): Promise<void> {
    const select = elem<HTMLSelectElement>('output-device');
    const supported = this.supportsOutputSelection();
    select.disabled = !supported || this.outputBusy;
    elem<HTMLButtonElement>('output-choose').disabled = !supported || this.outputBusy;
    select.replaceChildren(new Option('System default', ''));
    const devices: MediaDeviceInfo[] = [];
    try {
      if (navigator.mediaDevices?.enumerateDevices) {
        const listed = await navigator.mediaDevices.enumerateDevices();
        devices.push(...listed.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'default'));
      }
    } catch { /* Permission restrictions: the default output still works. */ }
    const seen = new Set<string>();
    let i = 0;
    for (const device of devices) {
      if (!device.deviceId || seen.has(device.deviceId)) continue;
      seen.add(device.deviceId);
      i++;
      select.add(new Option(device.label || `Audio output ${i} (permission may be required)`, device.deviceId));
    }
    if (preferred?.deviceId && !seen.has(preferred.deviceId)) {
      select.add(new Option(preferred.label || 'Selected output', preferred.deviceId));
      seen.add(preferred.deviceId);
    }
    if (this.selectedOutputDevice && !seen.has(this.selectedOutputDevice)) {
      // Some browsers hide device IDs when a permission was revoked; do not
      // silently route an existing playing stream to an unintended output.
      select.add(new Option('Previously selected output', this.selectedOutputDevice));
    }
    select.value = this.selectedOutputDevice;
    this.updateIoReport();
  }

  private async chooseOutput(): Promise<void> {
    const media = navigator.mediaDevices as (MediaDevices & {
      selectAudioOutput?: () => Promise<MediaDeviceInfo>;
    }) | undefined;
    if (!media) { this.setStatus('Output selection requires HTTPS or localhost.', true); return; }
    if (!this.supportsOutputSelection()) {
      this.setStatus('This browser cannot route to a chosen speaker. Use your OS sound output setting.', true);
      return;
    }
    try {
      if (typeof media.selectAudioOutput === 'function') {
        // Must be requested directly from this click to retain user activation.
        const device = await media.selectAudioOutput();
        await this.refreshOutputDevices({ deviceId: device.deviceId, label: device.label });
        await this.switchOutput(device.deviceId);
      } else {
        // Chromium commonly reveals audio outputs after microphone permission.
        await this.refreshOutputDevices();
        this.setStatus('Select a permitted output in the dropdown. If only Default appears, enable microphone permission or choose the output in your system settings.');
      }
    } catch (error) {
      this.setStatus(`Could not grant speaker access: ${String(error)}. Try the top-level GitHub Pages site instead of an embedded preview.`, true);
    }
  }

  private async switchOutput(deviceId: string): Promise<void> {
    if (this.outputBusy) return;
    this.outputBusy = true;
    const select = elem<HTMLSelectElement>('output-device');
    select.disabled = true;
    elem<HTMLButtonElement>('output-choose').disabled = true;
    const oldDevice = this.selectedOutputDevice;
    try {
      await this.ensureAudio();
      if (!this.outputRouter) throw new Error('Audio output graph not ready');
      const mode = await this.outputRouter.select(deviceId);
      this.selectedOutputDevice = deviceId;
      this.setStatus(mode === 'direct'
        ? 'Audio output switched. Direct Web Audio routing active.'
        : 'Audio output switched via media-element fallback; this may add latency.');
    } catch (error) {
      select.value = oldDevice;
      this.setStatus(`Output change failed: ${String(error)}. Try a permitted device or the system default.`, true);
    } finally {
      this.outputBusy = false;
      await this.refreshOutputDevices();
      this.updateIoReport();
    }
  }

  private updateIoReport(): void {
    const destination = elem<HTMLElement>('io-report');
    const context = this.context;
    if (!context) {
      destination.textContent = `Audio not started · ${this.latencyPreference === 'low' ? '5 ms low-latency request' : this.latencyPreference + ' mode'} · ${this.supportsOutputSelection() ? 'output selection available' : 'system output only in this browser'}`;
      return;
    }
    const settings = this.microphoneStream?.getAudioTracks()[0]?.getSettings() as ({ latency?: number } | undefined);
    const numbers = readLatency(context, settings, this.outputRouter?.mode === 'media-element');
    const fmt = (v: number | null): string => v === null ? 'not reported' : `${v.toFixed(1)} ms`;
    const output = numbers.knownOutputMs === null
      ? `base ${fmt(numbers.baseMs)} + device ${fmt(numbers.outputMs)}`
      : `~${fmt(numbers.knownOutputMs)} reported output (base ${fmt(numbers.baseMs)} + device ${fmt(numbers.outputMs)})`;
    const capture = this.microphoneStream ? ` · capture ${fmt(numbers.inputMs)}` : '';
    const route = numbers.fallback ? ' · media-element output (extra latency unknown)' : ' · direct Web Audio';
    destination.textContent = `${Math.round(context.sampleRate)} Hz · ${output}${capture}${route}. Not measured round-trip.`;
  }

  private async applyLatencyPreference(): Promise<void> {
    const selected = elem<HTMLSelectElement>('latency-mode').value as LatencyPreset;
    if (!['low', 'balanced', 'stable'].includes(selected)) return;
    if (!this.context) {
      this.latencyPreference = selected;
      this.updateIoReport();
      this.setStatus('Buffer preference selected. Start the audio engine to apply.');
      return;
    }
    if (selected === this.latencyPreference) {
      this.updateIoReport();
      this.setStatus('Buffer preference is already applied.');
      return;
    }
    const applyButton = elem<HTMLButtonElement>('latency-apply');
    applyButton.disabled = true;
    try {
      this.stopPlayback(true);
      await this.stopMicrophone();
      this.outputRouter?.dispose();
      this.outputRouter = null;
      this.node?.disconnect();
      this.analyser?.disconnect();
      await this.context.close();
      this.context = null;
      this.node = null;
      this.analyser = null;
      this.latencyPreference = selected;
      await this.ensureAudio();
      this.setStatus('Audio engine restarted with new latency preference. Resume playback or live monitoring.');
    } catch (error) {
      this.setStatus(`Could not restart audio: ${String(error)}`, true);
    } finally {
      applyButton.disabled = false;
      this.updateIoReport();
    }
  }

  private async ensureAudio(): Promise<AudioContext> {
    if (!this.context) {
      if (!window.AudioContext || !window.AudioWorkletNode) {
        throw new Error('This browser does not support AudioWorklet. Try a recent Chromium, Safari, or Firefox.');
      }
      // AudioContext is only created as a result of a user-initiated operation.
      let context: AudioContext;
      try { context = new AudioContext(contextOptions(this.latencyPreference)); }
      catch { context = new AudioContext({ latencyHint: 'interactive' }); }
      this.context = context;
      try {
        await context.audioWorklet.addModule(workletUrl);
        const node = new AudioWorkletNode(context, 'reverberation-lab', {
          numberOfInputs: 1, numberOfOutputs: 1,
          outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit',
        });
        node.addEventListener('processorerror', () => {
          this.setStatus('Audio processor failed. Reload to reset.', true);
          elem('engine-state').textContent = 'DSP ERROR';
        });
        this.node = node;
        for (const name of Object.keys(this.params) as Array<keyof PedalParameters>) {
          const parameter = node.parameters.get(name);
          if (parameter) parameter.value = this.params[name];
        }
        node.parameters.get('profile')!.value = this.activeProfile === 'candidate' ? 1 : 0;
        node.parameters.get('match')!.value = this.levelMatch ? 1 : 0;
        node.parameters.get('trimDb')!.value = this.matchedTrimDb;
        const analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.72;
        this.analyserData = new Float32Array(analyser.fftSize);
        this.analyser = analyser;
        node.connect(analyser);
        this.outputRouter = new OutputRouter(context, analyser);
        // A fallback MediaStream/HTMLAudioElement route needs a running
        // context before its play() promise can settle on some browsers.
        if (context.state !== 'running') await context.resume();
        if (this.selectedOutputDevice) {
          try { await this.outputRouter.select(this.selectedOutputDevice); }
          catch {
            this.selectedOutputDevice = '';
            this.setStatus('Previous output device unavailable; using system default.', true);
          }
        }
        elem('engine-state').textContent = `${Math.round(context.sampleRate / 1000)} KHZ / RUNNING`;
        elem('scope-status').textContent = 'LIVE MONITOR';
        this.updateIoReport();
        void this.refreshOutputDevices();
      } catch (err) {
        this.outputRouter?.dispose();
        this.outputRouter = null;
        this.node = null;
        this.analyser = null;
        await context.close();
        this.context = null;
        throw err;
      }
    }
    if (this.context.state !== 'running') await this.context.resume();
    this.updateIoReport();
    return this.context;
  }

  private updateParam(name: keyof PedalParameters): void {
    const parameter = this.node?.parameters.get(name);
    if (parameter && this.context) {
      parameter.cancelScheduledValues(this.context.currentTime);
      parameter.setTargetAtTime(this.params[name], this.context.currentTime, 0.012);
    }
  }

  private updateComparisonControl(name: 'profile' | 'match' | 'trimDb', value: number): void {
    const param = this.node?.parameters.get(name);
    if (!param || !this.context) return;
    param.cancelScheduledValues(this.context.currentTime);
    param.setTargetAtTime(value, this.context.currentTime, 0.012);
  }

  private scheduleCalibration(delayMs = 360): void {
    if (!this.levelMatch) return;
    const id = ++this.calibrationId;
    if (this.calibrationTimer !== null) window.clearTimeout(this.calibrationTimer);
    // Old trim is invalidated whenever knobs, the input file, or input mode changes.
    this.updateComparisonControl('match', 0);
    elem('match-result').textContent = 'Measuring both profiles…';
    this.calibrationTimer = window.setTimeout(() => this.calibrate(id), delayMs);
  }

  private calibrate(id: number): void {
    const sampleRate = this.context?.sampleRate ?? 44100;
    if (!this.matchWorker) {
      const worker = new Worker(matchWorkerUrl, { type: 'module' });
      worker.onmessage = (e: MessageEvent<{ id: number; result?: GainMatchResult; error?: string }>) => {
        if (e.data.id !== this.calibrationId || !this.levelMatch) return;
        if (!e.data.result) {
          elem<HTMLInputElement>('level-match').checked = false;
          this.levelMatch = false;
          this.updateComparisonControl('match', 0);
          elem('match-result').textContent = `Match unavailable: ${e.data.error ?? 'unknown error'}`;
          return;
        }
        this.matchedTrimDb = e.data.result.candidateTrimDb;
        this.updateComparisonControl('trimDb', this.matchedTrimDb);
        this.updateComparisonControl('match', 1);
        const label = e.data.result.reference === 'source' ? 'loaded source' : 'synthetic fixture';
        const sign = this.matchedTrimDb >= 0 ? '+' : '';
        const limited = Math.abs(e.data.result.rawDifferenceDb) > 12.01 ? ' (±12 dB limit)' : '';
        elem('match-result').textContent = `Fixed RMS trim ${sign}${this.matchedTrimDb.toFixed(1)} dB · ${label}${limited}`;
      };
      worker.onerror = () => {
        this.updateComparisonControl('match', 0);
        elem('match-result').textContent = 'Calibration worker failed. Level matching disabled.';
        this.levelMatch = false;
        elem<HTMLInputElement>('level-match').checked = false;
      };
      this.matchWorker = worker;
    }
    // For live guitar, there is no stationary reference recording: use the fixed test fixture.
    const source = this.microphoneStream ? null : this.currentBuffer;
    const n = source ? Math.min(source.length, Math.round(source.sampleRate * 4)) : 0;
    const left = source ? source.getChannelData(0).slice(0, n) : undefined;
    const right = source && source.numberOfChannels > 1 ? source.getChannelData(1).slice(0, n) : undefined;
    const transfer: Transferable[] = [];
    if (left) transfer.push(left.buffer);
    if (right) transfer.push(right.buffer);
    this.matchWorker.postMessage({ id, sampleRate, params: { ...this.params }, left, right }, transfer);
  }

  private async selectDemo(): Promise<void> {
    try {
      const ctx = await this.ensureAudio();
      await this.stopMicrophone();
      this.stopPlayback(true);
      this.currentBuffer = makeDemoBuffer(ctx);
      this.currentName = 'lab-demo-riff';
      this.onSourceLoaded('Demo riff · 8.6 s');
      await this.startPlayback();
    } catch (err) { this.setStatus(String(err), true); }
  }

  private async selectFile(file: File): Promise<void> {
    try {
      const ctx = await this.ensureAudio();
      if (file.size > 100 * 1024 * 1024) throw new Error('Choose an audio file smaller than 100 MB.');
      await this.stopMicrophone();
      this.stopPlayback(true);
      const encoded = await file.arrayBuffer();
      this.currentBuffer = await ctx.decodeAudioData(encoded);
      this.currentName = file.name.replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 70) || 'audio';
      this.onSourceLoaded(`${file.name} · ${this.currentBuffer.duration.toFixed(1)} s`);
      this.setStatus('File ready. Press Play to hear the processed sound.');
    } catch (err) { this.setStatus(`Could not load audio: ${String(err)}`, true); }
  }

  private onSourceLoaded(name: string): void {
    elem('loaded-file').textContent = name;
    elem<HTMLButtonElement>('play-button').disabled = false;
    elem<HTMLButtonElement>('stop-button').disabled = false;
    elem<HTMLButtonElement>('export-button').disabled = false;
    this.scheduleCalibration(0);
  }

  private async startPlayback(): Promise<void> {
    if (!this.currentBuffer) return;
    const context = await this.ensureAudio();
    if (!this.node) return;
    const source = context.createBufferSource();
    source.buffer = this.currentBuffer;
    source.loop = elem<HTMLInputElement>('loop').checked;
    source.connect(this.node);
    source.onended = () => {
      if (this.playbackSource !== source) return;
      this.playbackSource = null;
      this.playing = false;
      this.offset = 0;
      this.updateTransport();
      this.setStatus('Playback finished; reverb tail continues.');
    };
    this.playbackSource = source;
    this.started = context.currentTime - this.offset;
    source.start(0, this.offset);
    this.playing = true;
    this.updateTransport();
    this.setStatus(`Playing ${this.currentName} through the pedal.`);
  }

  private async togglePlayback(): Promise<void> {
    try {
      if (this.playing) { this.pausePlayback(); return; }
      await this.stopMicrophone();
      await this.startPlayback();
    } catch (err) { this.setStatus(String(err), true); }
  }

  private pausePlayback(): void {
    if (!this.playing || !this.currentBuffer || !this.context) return;
    const time = this.context.currentTime - this.started;
    this.offset = elem<HTMLInputElement>('loop').checked ? time % this.currentBuffer.duration : Math.min(time, this.currentBuffer.duration);
    this.playing = false;
    this.disconnectPlaybackSource();
    this.updateTransport();
    this.setStatus('Paused. Reverb tail still decaying.');
  }

  private disconnectPlaybackSource(): void {
    const source = this.playbackSource;
    this.playbackSource = null;
    if (source) {
      source.onended = null;
      try { source.stop(); } catch { /* source already stopped */ }
      source.disconnect();
    }
  }

  private stopPlayback(reset: boolean): void {
    this.playing = false;
    this.disconnectPlaybackSource();
    if (reset) this.offset = 0;
    this.updateTransport();
  }

  private updateTransport(): void {
    elem('play-icon').textContent = this.playing ? 'Ⅱ' : '▶';
    elem('play-text').textContent = this.playing ? 'PAUSE' : 'PLAY';
  }

  private async toggleMicrophone(): Promise<void> {
    if (this.microphoneStream) { await this.stopMicrophone(); return; }
    try {
      const context = await this.ensureAudio();
      this.stopPlayback(true);
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Live input requires a secure browser context (HTTPS or localhost).');
      const stream = await navigator.mediaDevices.getUserMedia(liveGuitarConstraints());
      if (!this.node) { stream.getTracks().forEach((t) => t.stop()); throw new Error('DSP unavailable.'); }
      this.microphoneStream = stream;
      this.microphoneSource = context.createMediaStreamSource(stream);
      this.microphoneSource.connect(this.node);
      elem<HTMLButtonElement>('mic-button').textContent = '◉ STOP LIVE INPUT';
      elem('loaded-file').textContent = 'Live microphone / audio interface input';
      this.scheduleCalibration(0);
      this.updateIoReport();
      void this.refreshOutputDevices();
      this.setStatus('Live input monitoring. Wired headphones and interface recommended; disable hardware direct monitoring to avoid hearing delayed and dry paths together.');
    } catch (err) { this.setStatus(`Live input unavailable: ${String(err)}`, true); }
  }

  private async stopMicrophone(): Promise<void> {
    this.microphoneSource?.disconnect();
    this.microphoneSource = null;
    this.microphoneStream?.getTracks().forEach((track) => track.stop());
    this.microphoneStream = null;
    elem<HTMLButtonElement>('mic-button').textContent = '◎ USE LIVE GUITAR / MICROPHONE';
    if (this.currentBuffer) elem('loaded-file').textContent = this.currentName;
    this.scheduleCalibration(0);
    this.updateIoReport();
  }

  private async exportWav(): Promise<void> {
    if (!this.currentBuffer || this.rendering) return;
    this.rendering = true;
    const btn = elem<HTMLButtonElement>('export-button');
    btn.disabled = true;
    const name = this.currentName;
    try {
      this.setStatus('Rendering processed stereo WAV locally…');
      const blob = await renderProcessedWav(this.currentBuffer, { ...this.params }, (progress) => {
        btn.textContent = `↓ RENDERING ${Math.round(progress * 100)}%`;
      }, { profile: this.activeProfile, levelMatch: this.levelMatch, candidateTrimDb: this.matchedTrimDb });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name}-${this.activeProfile}-reverberation-lab.wav`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      this.setStatus('Exported stereo WAV with a 4.2 s reverb tail.');
    } catch (err) { this.setStatus(`Export failed: ${String(err)}`, true); }
    finally { this.rendering = false; btn.textContent = '↓ EXPORT PROCESSED WAV'; btn.disabled = false; }
  }

  private renderScope(): void {
    const canvas = elem<HTMLCanvasElement>('scope');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let lastFrame = 0;
    const draw = (timestamp: number): void => {
      requestAnimationFrame(draw);
      if (timestamp - lastFrame < 32) return; // ~30 fps, independent of the audio render thread
      lastFrame = timestamp;
      const bounds = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.floor(bounds.width * devicePixelRatio));
      const height = Math.max(1, Math.floor(bounds.height * devicePixelRatio));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      ctx.clearRect(0, 0, width, height);
      ctx.lineWidth = Math.max(1, devicePixelRatio);
      ctx.strokeStyle = 'rgba(108, 117, 93, .20)';
      ctx.beginPath();
      for (let n = 1; n < 4; n++) { const y = (height * n) / 4; ctx.moveTo(0, y); ctx.lineTo(width, y); }
      ctx.stroke();
      if (this.analyser && this.context?.state === 'running') {
        this.analyser.getFloatTimeDomainData(this.analyserData as Float32Array<ArrayBuffer>);
        ctx.strokeStyle = '#dbaa64';
        ctx.lineWidth = Math.max(1.5, devicePixelRatio * 1.5);
        ctx.beginPath();
        for (let i = 0; i < width; i++) {
          const idx = Math.floor(i / width * (this.analyserData.length - 1));
          const y = height * (0.5 - Math.max(-1.2, Math.min(1.2, this.analyserData[idx])) * 0.41);
          if (i === 0) ctx.moveTo(i, y); else ctx.lineTo(i, y);
        }
        ctx.stroke();
      } else {
        ctx.strokeStyle = '#dbaa64';
        ctx.beginPath(); ctx.moveTo(0, height / 2); ctx.lineTo(width, height / 2); ctx.stroke();
      }
    };
    requestAnimationFrame(draw);
  }
}

new ReverbLab();
