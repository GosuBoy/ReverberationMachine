# Model assumptions and limitations

This repository is **an original, deliberately approximate software recreation**, not an exact simulation of the Death By Audio Reverberation Machine or the Belton BTDR-2H-L.

## Evidence-backed parts (one photographed original unit)

- Accutronics/Belton Digi-Log Reverb **BTDR-2H**, long-decay **L** option marked.
- TI **TLC27M4AIN** quad op-amp.
- ST **L7805ABV** 5 V linear regulator.
- Control values documented by the original photo and community reconstructions: A100K, C1M, A10K.
- A corrected 2018 gain-network tracing calls out 100 pF, 68 kΩ, 10 kΩ and a further 100 kΩ feedback connection, but our source image is not high enough resolution to verify every physical trace independently.

## Approximate parts in this DSP

- Multi-stage delay reverb using three serial all-pass diffusers and four damped feedback combs per output side. This **is not** the internal Belton topology, even though the general reverb/delay category is similar.
- Nominal 2.85 s late-decay target, chosen as a starting approximation for the L selection; **not measured** on original hardware. Actual decay depends on frequency and signal level.
- Mild sinusoidal delay modulation for a richer diffuse tail (not proven in the module).
- One-pole filtering for a broad Dark/Bright contrast. No claim of matching the real switch topology.
- Soft saturation via `tanh` to approximate nonlinear gain. This is **not** an SPICE model of the TLC27M4AIN, its supply rails or feedback path.
- Volume and wet-level mappings are chosen for listening, not fitted to component values.
- Output safety is an additional *software-only* feature, enabled by default.

## Accuracy plan

1. Complete the KiCad net-by-net reconstruction using legible original trace evidence, especially the tone switch and wet/dry mixer.
2. Capture a reference unit through a calibrated audio interface: dry-through, swept sine, impulses at multiple settings, transient inputs at multiple levels, full tail decay, clipping curves, stereo/mono output routing.
3. Fit pre/post EQ and nonlinearity separately from tank response.
4. Replace generic reverberation with a model fit to measured impulse responses or recorded wet-only signals. Add numerical A/B tests.
5. Keep configuration snapshots and tests for every change.

## Safety

Live audio monitoring can cause acoustic feedback. Wear headphones, start with low interface monitoring volume, and leave **Output Safety** on. Browser processing latency depends on your audio interface and OS. Do not treat this emulation as a validated guitar amplifier protection device.

## Trademarks

This independent research prototype is not affiliated with or endorsed by Death By Audio, Accutronics, or Belton. No original product graphics or proprietary firmware are included.
