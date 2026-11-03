# Browser audio I/O — low-latency monitoring (v0.2.1)

**Goal:** improve live guitar responsiveness and allow an output device to be selected when the browser/OS exposes this permission. **No DSP voicing or original circuit behavior is changed.**

## Fastest supported signal path

```text
USB / audio-interface input → getUserMedia (voice processing disabled)
  → MediaStreamAudioSourceNode → AudioWorklet (custom DSP)
  → AnalyserNode → AudioContext.destination → selected wired output
```

The app now requests **5 ms** output buffering with `latencyHint: 0.005` and **5 ms ideal** input capture latency, using one input channel if supported. These are **requests**; the browser and hardware choose the actual buffers. Use **Audio buffer preference → Interactive** for the browser's own low-latency recommendation or **Stable** if the lower request crackles. Applying this setting stops file playback or monitoring and creates a new AudioContext; the audio file and knob settings remain.

The UI shows `AudioContext.baseLatency` and `AudioContext.outputLatency` in milliseconds (where available), plus a live input track's reported `latency` if exposed. The displayed sum is **NOT actual round-trip latency**: it excludes physical ADC/DAC, driver, capture processing, and potentially other software delays. Measure actual round-trip with an audio-interface loopback to quantify improvement on the user's machine.

## Output selection

1. Open the site as a **top-level HTTPS page**, or on localhost. Embedded StackBlitz previews may restrict the `speaker-selection` permission policy.
2. Select **Output device → System default** for direct native routing. This is the lowest-overhead cross-browser route.
3. Click **Choose / allow another output…**. Where `MediaDevices.selectAudioOutput()` is supported, the browser presents a permission prompt; the selected device will then be applied. Else, choose an existing permitted audio output from the dropdown. Press **Refresh** after granting microphone access if devices lack labels.
4. On modern Chromium, `AudioContext.setSinkId()` changes the physical output **without re-creating the DSP graph**. On browsers with only `HTMLMediaElement.setSinkId()`, the app can route through a `MediaStreamAudioDestinationNode` + audio element, but **this can increase latency**. If neither API is available, device selection is disabled: change the OS default output instead.
5. If switching fails (revoked permission, unplugged device, autoplay denial), the app reports an error and attempts to leave the previous route connected. Choosing System default returns to the simplest graph.

Devices are not persisted in local storage. Browser privacy policies may hide device labels until audio access has been granted. `devicechange` triggers enumeration. Enabling live input will not automatically switch audio outputs.

## Guitar-specific setup to lower audible delay

- Connect your guitar to a **USB audio interface**, not the built-in laptop microphone.
- Prefer **wired headphones** on that same interface. Bluetooth codecs usually dominate the delay and can't be fixed by WASM or smaller worklet buffers.
- Disable the interface's **direct monitoring** if you're hearing both the original dry sound and the delayed processed signal. Keep headphones at a low level initially, and leave the output safety limiter enabled.
- Disable echo cancellation, noise suppression and auto gain control in the browser. The app already requests this; use supported device/browser permissions where prompted.
- Start with **Low**. If audio crackles or the CPU underruns, try **Interactive** or **Stable**.

## Verification performed

- TypeScript typecheck and Node DSP/audio I/O tests cover native sink switching, media-element fallback, permission denial, rollback on failed play, and restoring system default.
- Portable browser packaging compiles.
- Actual device-dependent latency, audio output switching on Mac browsers, and full end-to-end guitar monitoring must be checked on real hardware. A headless browser may not expose output device routing, and sandboxed iframes may block it.
