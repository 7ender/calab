import type { ReactNode } from 'react';
import { Card, Row, Select } from '../../components/ui';
import { t } from '../../i18n';
import { usePrefs } from '../../stores/prefs';

const OPTIONS = [5, 10, 15, 30, 0] as const;

/** Settings → Profile: AFK threshold (docs/09 #34): 5/10/15/30 min or off. */
export function AfkCard(): ReactNode {
  const minutes = usePrefs((s) => s.afkMinutes);
  const setPrefs = usePrefs((s) => s.setPrefs);
  return (
    <Card title={t('card.presence')} footer={t('shell.afkHint')}>
      <Row label={t('shell.afk')} htmlFor="afk-minutes">
        <Select id="afk-minutes" className="w-60" value={minutes} onChange={(e) => setPrefs({ afkMinutes: Number(e.target.value) })}>
          {OPTIONS.map((m) => (
            <option key={m} value={m}>
              {m === 0 ? t('shell.afkOff') : t('shell.afkMin', { n: m })}
            </option>
          ))}
        </Select>
      </Row>
    </Card>
  );
}
