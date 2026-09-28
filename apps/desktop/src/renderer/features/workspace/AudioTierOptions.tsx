import { AUDIO_TIERS_KBPS } from '@calaba/protocol';
import type { ReactNode } from 'react';
import { t } from '../../i18n';
import { audioTierLabel } from '../../lib/audioTierLabel';
import { audioTierLocked } from '../../lib/plan';
import { openPlanContact, planContact } from '../../services/plan';

/*
 * Voice quality selects of the workspace defaults and a room (docs/02 «Битрейт»): tiers above the
 * plan's cap (`audio_tier_max_kbps`, owner 28.09: free = «Нормальное») are shown locked — «Хорошее 🔒»
 * — and the hint says why, with «Связаться». The server refuses them anyway (409 PLAN_LIMIT).
 */

/** The tier options; locked ones stay visible but cannot be picked (a stored one still shows). */
export function AudioTierOptions({ cap }: { cap: number }): ReactNode {
  return AUDIO_TIERS_KBPS.map((b) => {
    const locked = audioTierLocked(b, cap);
    return (
      <option key={b} value={b} disabled={locked} data-locked={locked || undefined}>
        {locked ? t('plan.lockedOption', { label: audioTierLabel(b) }) : audioTierLabel(b)}
      </option>
    );
  });
}

/** The row hint: the usual text, plus «Доступно в платном тарифе · Связаться» when the plan caps the tier. */
export function AudioTierHint({ cap }: { cap: number }): ReactNode {
  if (!AUDIO_TIERS_KBPS.some((b) => audioTierLocked(b, cap))) return t('media.bitrateHint');
  const contact = planContact();
  return (
    <>
      {t('media.bitrateHint')}
      <span className="mt-0.5 block" data-testid="audio-tier-plan">
        {t('plan.paidOnly')}
        {contact ? (
          <>
            {' · '}
            <button type="button" className="font-medium text-accent-text hover:underline" onClick={openPlanContact}>
              {t('plan.contactShort')}
            </button>
          </>
        ) : null}
      </span>
    </>
  );
}
