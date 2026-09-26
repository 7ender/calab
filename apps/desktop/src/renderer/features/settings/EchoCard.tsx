import { useState, type ReactNode } from 'react';
import { Button, Card, Row, Segmented, cx } from '../../components/ui';
import { t } from '../../i18n';
import type { EchoMode } from '../../lib/media/echo';
import type { EchoLevel } from '../../lib/media/echoCheck';
import { runEchoCheck } from '../../services/echoCheck';
import { humanMediaError } from '../../services/mediaErrors';
import { usePrefs } from '../../stores/prefs';
import { useVoice } from '../../stores/voice';

const HINT: Record<EchoMode, 'echo.hintHeadphones' | 'echo.hintSpeakers' | 'echo.hintAuto'> = {
  headphones: 'echo.hintHeadphones',
  speakers: 'echo.hintSpeakers',
  auto: 'echo.hintAuto',
};

const RESULT: Record<EchoLevel, { key: 'echo.none' | 'echo.weak' | 'echo.strong'; tone: string }> = {
  none: { key: 'echo.none', tone: 'text-ok' },
  weak: { key: 'echo.weak', tone: 'text-warn' },
  strong: { key: 'echo.strong', tone: 'text-danger-text' },
};

/**
 * Settings → «Голос и устройства» → «Колонки и эхо» (docs/08, docs/02 «Эхо: колонки»): how the
 * user listens (headphones / speakers with ducking / auto) and the on-demand echo check.
 */
export function EchoCard(): ReactNode {
  const p = usePrefs();
  const inCall = useVoice((s) => s.roomId !== null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ level: EchoLevel } | { error: string } | null>(null);

  const check = async (): Promise<void> => {
    setBusy(true);
    setResult(null);
    try {
      const r = await runEchoCheck({ micDeviceId: p.micDeviceId, outputDeviceId: p.outputDeviceId, rnnoise: p.rnnoise, gateDb: p.thresholdDb });
      setResult({ level: r.level });
    } catch (e) {
      setResult({ error: t('echo.failed', { error: humanMediaError(e, 'mic').text }) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t('echo.card')}>
      <Row label={t('echo.mode')} hint={t(HINT[p.echoMode])}>
        <Segmented<EchoMode>
          label={t('echo.mode')}
          value={p.echoMode}
          onChange={(m) => p.setPrefs({ echoMode: m })}
          options={[
            { value: 'headphones', label: t('echo.modeHeadphones') },
            { value: 'speakers', label: t('echo.modeSpeakers') },
            { value: 'auto', label: t('echo.modeAuto') },
          ]}
        />
      </Row>
      <Row label={t('echo.check')} hint={inCall ? t('echo.checkInCall') : t('echo.checkHint')}>
        <Button variant="secondary" busy={busy} disabled={inCall} onClick={() => void check()}>
          {t('echo.checkBtn')}
        </Button>
      </Row>
      {result ? (
        <p className={cx('px-3 py-2 text-caption', 'error' in result ? 'text-danger-text' : RESULT[result.level].tone)} role="status" data-testid="echo-check-result">
          {'error' in result ? result.error : t(RESULT[result.level].key)}
        </p>
      ) : null}
    </Card>
  );
}
