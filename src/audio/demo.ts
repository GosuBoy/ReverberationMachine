/** Deterministic, self-contained plucked-string test passage; not copyrighted audio. */
export function makeDemoBuffer(context: BaseAudioContext): AudioBuffer {
  const rate = context.sampleRate;
  const duration = 8.6;
  const buffer = context.createBuffer(1, Math.ceil(rate * duration), rate);
  const data = buffer.getChannelData(0);
  const notes: Array<[number, number, number]> = [
    [0.10, 110, 0.85], [0.66, 164.8138, 0.7], [1.23, 196, 0.66],
    [1.80, 146.8324, 0.68], [2.65, 110, 0.9], [3.08, 220, 0.76],
    [3.58, 164.8138, 0.65], [4.11, 196, 0.74], [4.77, 130.8128, 0.84],
    [5.45, 110, 0.82], [6.05, 146.8324, 0.63], [6.74, 164.8138, 0.7],
  ];
  for (const [start, freq, volume] of notes) {
    const startIndex = Math.floor(start * rate);
    const len = Math.min(Math.floor(rate * 1.46), data.length - startIndex);
    for (let n = 0; n < len; n++) {
      const t = n / rate;
      const attack = Math.min(1, t * 1100);
      const fundamental = Math.sin(2 * Math.PI * freq * t + 0.13 * Math.sin(2 * Math.PI * 2 * t));
      const second = 0.33 * Math.sin(2 * Math.PI * freq * 2.003 * t + 0.22) * Math.exp(-2.7 * t);
      const third = 0.16 * Math.sin(2 * Math.PI * freq * 2.994 * t + 0.8) * Math.exp(-4.1 * t);
      const fourth = 0.08 * Math.sin(2 * Math.PI * freq * 4.008 * t + 1.2) * Math.exp(-6.1 * t);
      data[startIndex + n] += 0.22 * volume * attack * Math.exp(-2.9 * t) * (fundamental + second + third + fourth);
    }
  }
  return buffer;
}
