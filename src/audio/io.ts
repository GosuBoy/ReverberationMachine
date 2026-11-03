/**
 * Browser audio I/O policy and output routing.
 *
 * Prefer a direct AudioContext -> destination connection (the lowest-overhead
 * browser route). In browsers where AudioContext.setSinkId is unavailable but
 * HTMLMediaElement.setSinkId exists, a MediaStream/HTMLAudioElement fallback is
 * available; it may add latency and is never used for system-default output.
 *
 * Neither a requested latency hint nor a browser-reported latency represents
 * measured guitar-input-to-headphone round-trip latency.
 */

export type LatencyPreset = 'low' | 'balanced' | 'stable';
export type RoutingMode = 'direct' | 'media-element';

interface SinkAudioContext extends AudioContext {
  setSinkId?: (deviceId: string) => Promise<void>;
}

type SinkAudioElement = HTMLAudioElement & { setSinkId?: (deviceId: string) => Promise<void> };

export function contextOptions(preset: LatencyPreset): AudioContextOptions {
  switch (preset) {
    case 'low': return { latencyHint: 0.005 }; // a request, not a promise
    case 'stable': return { latencyHint: 'balanced' };
    case 'balanced': return { latencyHint: 'interactive' };
  }
}

export function liveGuitarConstraints(): MediaStreamConstraints {
  // Avoid browser voice processing. Ideal values never fail a device purely
  // because the hardware cannot attain them; unsupported values are ignored.
  const capture: MediaTrackConstraints & { latency?: { ideal: number } } = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      latency: { ideal: 0.005 },
      channelCount: { ideal: 1 },
  };
  return { video: false, audio: capture };
}

export interface LatencyReadout {
  baseMs: number | null;
  outputMs: number | null;
  inputMs: number | null;
  knownOutputMs: number | null;
  fallback: boolean;
}

function milliseconds(seconds: unknown): number | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 10000) / 10;
}

export function readLatency(
  context: Pick<AudioContext, 'baseLatency'> & { outputLatency?: number },
  inputSettings?: { latency?: number } | null,
  fallback = false,
): LatencyReadout {
  const baseMs = milliseconds(context.baseLatency);
  const outputMs = milliseconds(context.outputLatency);
  return {
    baseMs,
    outputMs,
    inputMs: milliseconds(inputSettings?.latency),
    knownOutputMs: baseMs !== null && outputMs !== null ? Math.round((baseMs + outputMs) * 10) / 10 : null,
    fallback,
  };
}

/** Owns exactly one downstream output connection from the analyser node. */
export class OutputRouter {
  private audio: SinkAudioElement | null = null;
  private mediaDestination: MediaStreamAudioDestinationNode | null = null;
  private currentDevice = '';
  private currentMode: RoutingMode = 'direct';

  constructor(
    private readonly context: AudioContext,
    private readonly source: AudioNode,
    private readonly makeAudio: () => SinkAudioElement = () => new Audio() as SinkAudioElement,
  ) {
    source.connect(context.destination);
  }

  get deviceId(): string { return this.currentDevice; }
  get mode(): RoutingMode { return this.currentMode; }
  get canChooseOutput(): boolean {
    const ctx = this.context as SinkAudioContext;
    if (typeof ctx.setSinkId === 'function') return true;
    try { return typeof this.makeAudio().setSinkId === 'function'; }
    catch { return false; }
  }

  async select(deviceId: string): Promise<RoutingMode> {
    const id = deviceId || '';
    const context = this.context as SinkAudioContext;
    // Do not interrupt the stream for redundant requests.
    if (this.currentDevice === id && (this.currentMode === 'media-element' || id === '')) return this.currentMode;

    if (typeof context.setSinkId === 'function') {
      // Set native sink before replacing an active fallback route; on errors
      // the previous connection and selected device remain in place.
      await context.setSinkId(id);
      if (this.mediaDestination) {
        this.source.disconnect();
        this.source.connect(this.context.destination);
        this.releaseMediaElement();
      }
      this.currentMode = 'direct';
      this.currentDevice = id;
      return this.currentMode;
    }

    if (!id) {
      if (this.mediaDestination) {
        this.source.disconnect();
        this.source.connect(this.context.destination);
        this.releaseMediaElement();
      }
      this.currentMode = 'direct';
      this.currentDevice = '';
      return this.currentMode;
    }

    const audio = this.makeAudio();
    if (typeof audio.setSinkId !== 'function') {
      throw new Error('This browser cannot select an output device. Choose the system default in your OS audio settings.');
    }
    const destination = this.context.createMediaStreamDestination();
    audio.srcObject = destination.stream;
    audio.autoplay = true;
    // Request the sink before touching the existing audio graph. Clean up if
    // the browser denies permission, without interrupting the old route.
    try { await audio.setSinkId(id); }
    catch (error) {
      audio.pause();
      audio.srcObject = null;
      destination.disconnect();
      throw error;
    }
    const oldDestination = this.mediaDestination;
    this.source.disconnect();
    this.source.connect(destination);
    try {
      await audio.play();
    } catch (err) {
      // Playback can be denied by autoplay policy even when setSinkId works.
      this.source.disconnect();
      this.source.connect(oldDestination ?? this.context.destination);
      audio.pause();
      audio.srcObject = null;
      destination.disconnect();
      throw err;
    }
    this.releaseMediaElement();
    this.audio = audio;
    this.mediaDestination = destination;
    this.currentDevice = id;
    this.currentMode = 'media-element';
    return this.currentMode;
  }

  private releaseMediaElement(): void {
    if (this.audio) {
      this.audio.pause();
      this.audio.srcObject = null;
    }
    this.mediaDestination?.disconnect();
    this.audio = null;
    this.mediaDestination = null;
  }

  dispose(): void {
    this.source.disconnect();
    this.releaseMediaElement();
    this.currentDevice = '';
    this.currentMode = 'direct';
  }
}
