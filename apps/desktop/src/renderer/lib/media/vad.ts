/**
 * Voice-activation gate (docs/02-media.md, "Режимы микрофона").
 *
 * Input: one report per 20 ms frame (level in dBFS + RNNoise voice
 * probability, or null when RNNoise is off). A frame counts as speech when
 * the level is above the user threshold AND (if available) the RNNoise
 * probability is above `vadProbability`.
 *
 * Hysteresis: open after `openFrames` consecutive speech frames; close after
 * `hangoverMs` without speech so word endings are not cut.
 */
export interface VoiceGateConfig {
  thresholdDb: number;
  vadProbability: number;
  openFrames: number;
  hangoverMs: number;
  frameMs: number;
}

export const DEFAULT_GATE_CONFIG: VoiceGateConfig = {
  thresholdDb: -50,
  vadProbability: 0.6,
  openFrames: 2,
  hangoverMs: 400,
  frameMs: 20,
};

export interface GateFrame {
  db: number;
  vad: number | null;
}

export class VoiceGate {
  private cfg: VoiceGateConfig;
  private speechRun = 0;
  private silenceMs = 0;
  private isOpen = false;

  constructor(cfg: Partial<VoiceGateConfig> = {}) {
    this.cfg = { ...DEFAULT_GATE_CONFIG, ...cfg };
  }

  configure(cfg: Partial<VoiceGateConfig>): void {
    this.cfg = { ...this.cfg, ...cfg };
  }

  get open(): boolean {
    return this.isOpen;
  }

  isSpeech(f: GateFrame): boolean {
    return f.db > this.cfg.thresholdDb && (f.vad === null || f.vad >= this.cfg.vadProbability);
  }

  /** Feeds one 20 ms frame; returns the gate state after it. */
  push(f: GateFrame): boolean {
    if (this.isSpeech(f)) {
      this.speechRun++;
      this.silenceMs = 0;
      if (!this.isOpen && this.speechRun >= this.cfg.openFrames) this.isOpen = true;
    } else {
      this.speechRun = 0;
      if (this.isOpen) {
        this.silenceMs += this.cfg.frameMs;
        if (this.silenceMs >= this.cfg.hangoverMs) {
          this.isOpen = false;
          this.silenceMs = 0;
        }
      }
    }
    return this.isOpen;
  }

  reset(): void {
    this.speechRun = 0;
    this.silenceMs = 0;
    this.isOpen = false;
  }
}

export const METER_MIN_DB = -80;

export function rmsToDb(rms: number): number {
  return rms > 0 ? Math.max(METER_MIN_DB, 20 * Math.log10(rms)) : METER_MIN_DB;
}
