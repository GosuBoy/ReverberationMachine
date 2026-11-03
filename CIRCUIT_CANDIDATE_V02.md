# v0.2 — Original-candidate gain and interaction experiment

**Status:** review candidate; measurements against an original pedal have **not** been performed.

This experiment keeps the already-liked v0.1 DSP untouched as **A / Classic** and adds **B / Circuit candidate**. The goal is a controlled listening A/B of *analog gain, reverb-drive, wet-only voicing and nonlinear mixing*, **not** a claim that the original pedal has been fully replicated.

## Confirmed parts and source-derived connections

From recovered photographs of a genuine green-board unit: **TLC27M4AIN**, **BTDR-2H with L selected**, **L7805ABV**, C1M Altitude, A10K Verb and A100K Volume potentiometers.

The 2018 maragosspiros correction traces TLC27M4 **U1:B pin 6** (inverting) to the C1M lug 1 and a 10 kΩ-to-1 µF-to-ground branch. A **100 pF** capacitor goes between gain lug 1 and lug 2; **68 kΩ** goes from lug 2 to **pin 7** (output). This gives a plausible frequency-dependent non-inverting gain network:

```
        Z_f(s) = 68 kΩ + (R_pot || 1/(s*100 pF))
        Z_g(s) = 10 kΩ + 1/(s*1 µF)
        G(s) = 1 + Z_f(s) / Z_g(s)
```

The code uses a high-pass and adjustable one-pole low-pass to implement the useful first-order response. **R_pot** is a provisional control law `1 MΩ * altitude^2.15`: the exact effective C1M taper and orientation have not been established. Physical rail compliance is modeled with an *unmeasured* approximate soft knee (+3.15 / −2.95 V). This is **not** a verified TLC27M4AIN macromodel.

## Signal path hypotheses

- The candidate uses **mono input and output**, matching the physical pedal connectors. Classic stays stereo as before.
- **Pre-reverb gain** uses the reported 2018 frequency-dependent feedback parts. These are physically evidenced, but the entire analog input coupling and source impedance are not.
- Bright/Dark is applied to the **wet branch only**, informed by builder observations, not a complete original switch netlist. The candidate's low-pass cutoffs (1.75 kHz Dark, 6.1 kHz Light) and Light high-pass (260 Hz) are **audible placeholders**, not claimed capacitor-derived originals.
- The **same v0.1 Belton-style delay tank** feeds the candidate, deliberately. Differences heard in v0.2 should primarily arise around the tank, not from changing its topology at the same time.
- The v0.2 **post-mix saturation** makes wet tails interact with dry transients. **Its precise location and shape are unverified** in the original pedal; this is an explicit listening hypothesis.
- Volume and Verb scaling remain provisional; the manufacturer's “125% wet” language isn't treated as a literal electrical ratio.

## Comparing models

1. Play the same demo riff or upload the same DI audio file.
2. Toggle **A / Classic v0.1** and **B / Circuit candidate v0.2** during playback. Both engines process continuously so tails don't restart. A selection crossfade of about 28 ms avoids hard clicks.
3. Turn on **Match levels** to measure *fixed reference RMS* via a dedicated Worker. When an audio file is loaded, the first up-to-four seconds are used, followed by a 1.2 s synthesized tail. With live guitar or no file, a deterministic two-second synthetic reference is used. The matching result is **clamped to ±12 dB**.
4. Recalibration happens on knob or source changes; while pending, matching is temporarily disabled. There is **no playback loudness AGC** or automatic compression. Input-source RMS matching is only a convenience; it is not a calibrated perceptual listening test.
5. WAV export renders the currently selected profile and optional fixed match trim. Keep Output Safety enabled and headphones at low volume, especially at high Altitude and Verb settings.

The old v0.1 core is unmodified. In the tests, selecting Classic with matching disabled produces exactly identical samples to the old engine.

## Fidelity gates before claiming hardware accuracy

1. Resolve the corrected 2018 schematic input/output, Bright/Dark and wet/dry routing **net-by-net**, including pot orientation; don't guess from thumbnails.
2. Measure dry-only and wet-only sweeps, transients and clipping at multiple input levels and knob positions with a genuine pedal. **Level-match using the same DI recording** and record the instrument impedance/interface setup.
3. Separate **pre-reverb gain** and **post-mix saturation** measurements. Remove or adjust the proposed extra mixer knee if the hardware does not support it.
4. Obtain original or actual BTDR-2H-L isolated wet impulse responses; refit onset, timing, diffusion, decay and damping. Keep the present generic reverb separately as a creative profile.
5. Use blind, fixed-level A/B audio references in addition to spectrograms and metrics (RMS, THD+N, impulse response, decay) before selecting a “more accurate” model.

## Sources

- Recovered original-unit PCB photos saved separately in the user Space/Library; no originals redistributed in this code repository.
- [Maragosspiros correction discussion, 2018](https://tagboardeffects.blogspot.com/2015/10/death-by-audio-reverberation-machine.html), reproduced in the [corrected schematic thread](https://guitar-fx-layouts.238.s1.nabble.com/dba-reverberation-machine-corrected-schematic-td44924.html).
- [Death By Audio official product and controls](https://deathbyaudio.com/collections/fuzz/products/reverberation-machine).
- [PCB Guitar Mania 2021 building docs](https://pcbguitarmania.com/wp-content/uploads/2019/08/Death-by-Reverb-Building-Docs.pdf) and [2023 revision](https://pcbguitarmania.com/wp-content/uploads/2022/07/Death-by-Reverb-2v-Building-Docs.pdf), both **community clone** material, not manufacturer netlists.
