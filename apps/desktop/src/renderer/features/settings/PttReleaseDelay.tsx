import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button, Row, Slider } from '../../components/ui';
import { useSettingsNav } from '../../components/SettingsWindow';
import { t } from '../../i18n';
import { PTT_RELEASE_STEPS_MS, releaseMs, releaseStep } from '../../lib/pttRelease';
import { usePrefs } from '../../stores/prefs';
import { isToggleBinding } from './PttBinder';

/**
 * «Задержка отпускания» (docs/02-media.md, «Push-to-talk»): how long the mic stays on after a
 * hold key-up. Fixed stops 0…2000 ms (lib/pttRelease.ts), the value beside the label like the
 * VAD threshold row. A toggle binding does not use it — said in the caption instead of hiding the row.
 */
export function PttReleaseDelay(): ReactNode {
  const ms = releaseMs(usePrefs((s) => s.pttReleaseMs));
  const toggle = usePrefs((s) => isToggleBinding(s.pttBinding));
  const setPrefs = usePrefs((s) => s.setPrefs);
  const last = PTT_RELEASE_STEPS_MS.length - 1;
  return (
    <div className="flex flex-col gap-2 px-3 py-3" data-settings-row data-testid="ptt-release">
      <div className="flex justify-between text-body">
        <span data-settings-label data-settings-hint={t('voice.pttReleaseHint')}>
          {t('voice.pttRelease')}
        </span>
        <span className="tabular-nums text-muted">{t('unit.ms', { n: ms })}</span>
      </div>
      <Slider
        label={t('voice.pttRelease')}
        value={releaseStep(ms)}
        min={0}
        max={last}
        onChange={(i) => setPrefs({ pttReleaseMs: PTT_RELEASE_STEPS_MS[Math.max(0, Math.min(last, i))] ?? ms })}
      />
      <span className="text-caption text-faint">{toggle ? t('voice.pttReleaseToggle') : t('voice.pttReleaseHint')}</span>
    </div>
  );
}

/** «Горячие клавиши»: the current delay and a link to «Голос и устройства», where it is set. */
export function PttReleaseLink(): ReactNode {
  const ms = releaseMs(usePrefs((s) => s.pttReleaseMs));
  const nav = useSettingsNav();
  return (
    <Row label={t('voice.pttRelease')} hint={t('hotkeys.pttReleaseWhere')}>
      <span className="tabular-nums text-muted">{t('unit.ms', { n: ms })}</span>
      {nav ? (
        <Button variant="ghost" size="sm" onClick={() => nav('voice')}>
          {t('hotkeys.pttReleaseOpen')}
          <ChevronRight className="size-3.5" aria-hidden />
        </Button>
      ) : null}
    </Row>
  );
}
