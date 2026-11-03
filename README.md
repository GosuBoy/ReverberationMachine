# Reverberation Lab — browser-first pedal

An **unofficial, experimental** reverb/distortion pedal inspired by the Death By Audio Reverberation Machine. Pure TypeScript DSP running in a Web Audio `AudioWorklet`, with custom fractional delay buffers, damped feedback combs, all-pass diffusers, filters, nonlinear saturation and a default soft limiter. No WASM and no remote audio processing.

> **Not a verified clone.** This is an initial listening model. The Belton BTDR-2H-L algorithm has not been recovered, and the full original circuit wiring has not been conclusively traced. See [MODEL_NOTES.md](MODEL_NOTES.md).

## Quick start (Bun + Vite)

```bash
bun install
bun run dev
```

Open the URL printed by Vite (usually `http://127.0.0.1:5173`). Use **Play demo riff** to hear the DSP before loading any files. You can adjust Altitude, Verb, Volume, Bright/Dark, bypass, and output safety. Upload an audio recording to play/loop or export a processed 16-bit stereo WAV with a 4.2 s reverb tail. The live microphone/audio-interface button requests unprocessed input (`echoCancellation`, `noiseSuppression`, `autoGainControl` disabled where supported).

`AudioWorklet` requires HTTPS or `localhost`. A hardware audio interface and headphones are strongly recommended for live guitar monitoring. Browsers do not guarantee a low-latency path.

### Alternate reproducible local build (no Vite install needed once TypeScript is available)

```bash
npm run build:portable
python3 -m http.server 5173 -d dist
```

The fallback build serves native ES modules; it is tested in Chromium. Standard Vite builds are the recommended distribution format.

## Tests

```bash
bun run check       # TypeScript typecheck + deterministic DSP tests
bun run build       # Production Vite build
```

The test suite uses Node's built-in test runner after compiling only the dependency-free DSP engine. Tests cover delay timing/interpolation, long-tail boundedness, sample-rate behavior, parameter smoothing, bypass, tone/drive response, non-finite handling and stereo output.

## Architecture

```text
src/main.ts                     UI, upload/decode, playback, live input, export
src/audio/pedal-worklet.ts      AudioWorklet wrapper + k-rate parameter automation
src/audio/demo.ts               Deterministic synthesized input fixture
src/audio/wav.ts                Offline stereo WAV export through same DSP engine
src/dsp/engine.ts               Self-contained DSP; zero per-sample heap allocation
scripts/build-portable.mjs      Optional native-ESM portable build
MODEL_NOTES.md                  Evidence, approximations and validation gates
```

AudioWorklet runs on the browser's audio rendering thread. The worklet asks the DSP to process only the block size the browser provides (not a hard-coded 128). The engine supports sample rates from 8 to 192 kHz.

## Status

- Initial runnable browser prototype, not a circuit-equivalent implementation.
- Test and build results should be verified in the target environment before release.
- No physical pedal or audio reference response has been measured against this implementation.

## License

MIT (source code). All pedal and third-party product names remain property of their respective owners.
