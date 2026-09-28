import type { ReactNode } from 'react';
import { Select, cx } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import type { CodecPref } from '../../lib/media/codecSelect';
import { usePrefs } from '../../stores/prefs';

const OPTIONS: { value: CodecPref; label: MessageKey; hint: MessageKey }[] = [
  { value: 'auto', label: 'video.codecAuto', hint: 'video.codecAutoHint' },
  { value: 'av1', label: 'video.codecAv1', hint: 'video.codecAv1Hint' },
  { value: 'h264', label: 'video.codecH264', hint: 'video.codecH264Hint' },
];

/** What the chosen «Кодек стрима» means for the user (ADR-0032). */
export function streamCodecHint(pref: CodecPref): string {
  return t(OPTIONS.find((o) => o.value === pref)?.hint ?? 'video.codecAutoHint');
}

/** «Кодек стрима» (ADR-0032): settings → «Показ экрана» and the stream picker's «Дополнительно». */
export function StreamCodecSelect({ className }: { className?: string }): ReactNode {
  const value = usePrefs((s) => s.streamCodec);
  return (
    <Select
      aria-label={t('video.streamCodec')}
      className={cx('w-60', className)}
      value={value}
      onChange={(e) => usePrefs.getState().setPrefs({ streamCodec: e.target.value as CodecPref })}
    >
      {OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {t(o.label)}
        </option>
      ))}
    </Select>
  );
}
