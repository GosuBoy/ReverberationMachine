/** Continuous dual processing means A/B changes never restart a reverb tail. */
import { ReverberationPedal, ParameterSmoother, type PedalParameters } from './engine.js';
import { CircuitCandidatePedal } from './candidate.js';

export type ModelProfile = 'classic' | 'candidate';

export class ReverberationAB {
  readonly classic: ReverberationPedal;
  readonly candidate: CircuitCandidatePedal;
  private readonly selection: ParameterSmoother;
  private readonly matching: ParameterSmoother;
  private readonly trim: ParameterSmoother;
  private outputSafety = 1;
  left = 0;
  right = 0;

  constructor(sampleRate: number, params: Partial<PedalParameters> = {}) {
    this.classic = new ReverberationPedal(sampleRate, params);
    this.candidate = new CircuitCandidatePedal(sampleRate, params);
    this.selection = new ParameterSmoother(sampleRate, 0, 28);
    this.matching = new ParameterSmoother(sampleRate, 0, 35);
    this.trim = new ParameterSmoother(sampleRate, 1, 80);
    this.outputSafety = params.safety ?? 1;
  }
  setParameters(params: Partial<PedalParameters>, immediate = false): void {
    this.classic.setParameters(params, immediate);
    this.candidate.setParameters(params, immediate);
    if (params.safety !== undefined) this.outputSafety = params.safety;
  }
  setProfile(profile: ModelProfile, immediate = false): void {
    if (immediate) this.selection.snap(profile === 'candidate' ? 1 : 0);
    else this.selection.setTarget(profile === 'candidate' ? 1 : 0);
  }
  setLevelMatch(enabled: boolean, immediate = false): void {
    if (immediate) this.matching.snap(enabled ? 1 : 0);
    else this.matching.setTarget(enabled ? 1 : 0);
  }
  setCandidateTrimDb(db: number, immediate = false): void {
    const bounded = Number.isFinite(db) ? Math.max(-12, Math.min(12, db)) : 0;
    const gain = Math.pow(10, bounded / 20);
    if (immediate) this.trim.snap(gain); else this.trim.setTarget(gain);
  }
  process(inputL: number, inputR: number): void {
    // Always run both tanks to preserve their state while the comparison switches.
    this.classic.process(inputL, inputR);
    this.candidate.process(inputL, inputR);
    const selected = this.selection.tick();
    const match = this.matching.tick();
    const trim = 1 + (this.trim.tick() - 1) * match;
    let candidateL = this.candidate.left * trim;
    let candidateR = this.candidate.right * trim;
    if (this.outputSafety > 0.5 && match > 0.00001) {
      candidateL = ReverberationPedal.softLimit(candidateL);
      candidateR = ReverberationPedal.softLimit(candidateR);
    }
    this.left = this.classic.left * (1 - selected) + candidateL * selected;
    this.right = this.classic.right * (1 - selected) + candidateR * selected;
  }
  clear(): void { this.classic.clear(); this.candidate.clear(); this.left = this.right = 0; }
}
