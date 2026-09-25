import type { ReactNode } from 'react';
import { useSpike } from '../../app/store';
import { METER_MIN_DB } from '../../lib/media/vad';

const pct = (db: number): number => Math.max(0, Math.min(100, ((db - METER_MIN_DB) / -METER_MIN_DB) * 100));

/** Live level (dBFS, post-processing) with the VAD threshold marker, Discord-style. */
export function LevelMeter(): ReactNode {
  const levelDb = useSpike((s) => s.rt.levelDb);
  const gateOpen = useSpike((s) => s.rt.gateOpen);
  const thresholdDb = useSpike((s) => s.settings.thresholdDb);
  const setSettings = useSpike((s) => s.setSettings);
  return (
    <div className="meter-wrap">
      <div className="meter">
        <div className={`meter-fill ${gateOpen ? 'open' : ''}`} style={{ width: `${pct(levelDb)}%` }} />
        <div className="meter-threshold" style={{ left: `${pct(thresholdDb)}%` }} />
      </div>
      <input
        className="meter-slider"
        type="range"
        min={METER_MIN_DB}
        max={0}
        step={1}
        value={thresholdDb}
        onChange={(e) => setSettings({ thresholdDb: Number(e.target.value) })}
        aria-label="Порог активации"
      />
    </div>
  );
}
