import { useEffect, type ReactNode } from 'react';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { METER_MIN_DB } from '../../lib/media/vad';
import { voice } from '../../services/voice';
import { usePrefs } from '../../stores/prefs';
import { useSession } from '../../stores/session';
import { useVoice } from '../../stores/voice';

// Shared by settings and onboarding (both lazy chunks, docs/18 step 9).

/**
 * Mic level meter (UX review #8): 6 px track, radius 3, green level; in voice-activation mode a
 * tick marks the threshold and the level dims while the gate is closed.
 */
declare global {
  interface Window {
    /** Visual tests only (appInfo.visualTest): the level the mic meter shows, dB (default −30). */
    __calabaMeterLevel?: number;
  }
}

/** A fixed, deterministic level in visual tests (the fake mic beeps), instead of masking the meter. */
const VISUAL_TEST_LEVEL_DB = -30;

export function MicMeter(): ReactNode {
  const visualTest = useSession((s) => s.appInfo?.visualTest === true);
  const liveLevel = useVoice((s) => s.levelDb);
  const liveOpen = useVoice((s) => s.gateOpen);
  // The meter wants the denoised level at full rate: keeps RNNoise awake while shown (docs/14).
  useEffect(() => {
    voice.meterVisible(true);
    return () => voice.meterVisible(false);
  }, []);
  const threshold = usePrefs((s) => s.thresholdDb);
  const level = visualTest ? (window.__calabaMeterLevel ?? VISUAL_TEST_LEVEL_DB) : liveLevel;
  const open = visualTest ? level >= threshold : liveOpen;
  const mode = usePrefs((s) => s.micMode);
  const pct = (db: number): number => Math.max(0, Math.min(100, ((db - METER_MIN_DB) / -METER_MIN_DB) * 100));
  return (
    <div
      data-testid="mic-meter"
      role="meter"
      aria-label={t('voice.level')}
      aria-valuemin={METER_MIN_DB}
      aria-valuemax={0}
      aria-valuenow={Math.round(level)}
      className="relative h-3 w-full"
    >
      <div className="absolute inset-x-0 top-[3px] h-1.5 overflow-hidden rounded-[3px] bg-[var(--color-fill-hover)]">
        <div className={cx('h-full rounded-[3px] bg-ok', !visualTest && 'transition-[width] duration-75', mode === 'voice' && !open ? 'opacity-45' : '')} style={{ width: `${pct(level)}%` }} />
      </div>
      {mode === 'voice' ? <div className="absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-fg" style={{ left: `${pct(threshold)}%` }} aria-hidden /> : null}
    </div>
  );
}
