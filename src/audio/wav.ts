import { ReverberationPedal, type PedalParameters } from '../dsp/engine.js';

/** Render uploaded/demo audio through the SAME DSP engine, plus a reverb tail. */
export async function renderProcessedWav(
  buffer: AudioBuffer,
  parameters: PedalParameters,
  onProgress: (fraction: number) => void = () => {},
): Promise<Blob> {
  const sampleRate = buffer.sampleRate;
  if (buffer.duration > 90) throw new Error('WAV export is limited to 90 seconds of source audio.');
  if (sampleRate < 8000 || sampleRate > 192000) throw new Error('Unsupported audio sample rate.');
  const count = Math.ceil((buffer.duration + 4.2) * sampleRate);
  const engine = new ReverberationPedal(sampleRate, parameters);
  engine.setParameters(parameters, true);
  const wav = new ArrayBuffer(44 + count * 4);
  const view = new DataView(wav);
  const writeAscii = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeAscii(0, 'RIFF'); view.setUint32(4, 36 + count * 4, true);
  writeAscii(8, 'WAVE'); writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 2, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true); view.setUint16(32, 4, true);
  view.setUint16(34, 16, true); writeAscii(36, 'data'); view.setUint32(40, count * 4, true);
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  for (let start = 0; start < count; start += 8192) {
    const end = Math.min(count, start + 8192);
    for (let i = start; i < end; i++) {
      engine.process(left[i] ?? 0, right[i] ?? 0);
      const a = Math.max(-1, Math.min(1, engine.left));
      const b = Math.max(-1, Math.min(1, engine.right));
      view.setInt16(44 + i * 4, Math.round(a < 0 ? a * 32768 : a * 32767), true);
      view.setInt16(46 + i * 4, Math.round(b < 0 ? b * 32768 : b * 32767), true);
    }
    onProgress(end / count);
    // Avoid locking the browser UI during an offline WAV render.
    if (end < count) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return new Blob([wav], { type: 'audio/wav' });
}
