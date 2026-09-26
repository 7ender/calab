import { useEffect, useState, type ReactNode } from 'react';
import { Button, Row } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { comboFromEvent, comboLabel, comboProblem, effectiveHotkeys, type HotkeyAction } from '../../lib/shortcuts';
import { IS_MAC, setHotkeyCapture } from '../../services/hotkeys';
import { usePrefs } from '../../stores/prefs';

const ACTION_LABEL: Record<HotkeyAction, MessageKey> = {
  search: 'shell.kbd.search',
  mute: 'shell.kbd.mute',
  deafen: 'shell.kbd.deafen',
};

/**
 * One rebindable in-window shortcut (docs/09 #18): «Изменить» records the next combo with
 * ⌘/Ctrl (Esc cancels); reserved system combos and duplicates are refused with a reason.
 */
export function HotkeyRow({ action, kbd }: { action: HotkeyAction; kbd: (label: string) => ReactNode }): ReactNode {
  const custom = usePrefs((s) => s.hotkeys);
  const setPrefs = usePrefs((s) => s.setPrefs);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const all = effectiveHotkeys(custom);

  useEffect(() => {
    if (!capturing) return;
    setHotkeyCapture(true);
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setCapturing(false);
        return;
      }
      const combo = comboFromEvent(e, IS_MAC);
      if (!combo) {
        setError(t('hotkeys.needMod', { mod: IS_MAC ? '⌘' : 'Ctrl' }));
        return;
      }
      const problem = comboProblem(action, combo, effectiveHotkeys(usePrefs.getState().hotkeys));
      if (problem === 'reserved') {
        setError(t('hotkeys.reserved', { keys: comboLabel(combo, IS_MAC) }));
        return;
      }
      if (problem) {
        setError(t('hotkeys.conflict', { keys: comboLabel(combo, IS_MAC), action: t(ACTION_LABEL[problem.conflict]) }));
        return;
      }
      setPrefs({ hotkeys: { ...usePrefs.getState().hotkeys, [action]: combo } });
      setError(null);
      setCapturing(false);
    };
    // Capture phase: the recorded combo must not also trigger the app shortcut or a dialog.
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      setHotkeyCapture(false);
    };
  }, [capturing, action, setPrefs]);

  const isCustom = !!custom[action];
  const reset = (): void => {
    const next = { ...custom };
    delete next[action];
    setPrefs({ hotkeys: next });
    setError(null);
  };

  return (
    <Row label={t(ACTION_LABEL[action])} hint={error ?? (capturing ? t('hotkeys.press') : undefined)}>
      {kbd(capturing ? '…' : comboLabel(all[action], IS_MAC))}
      {isCustom && !capturing ? (
        <Button variant="secondary" onClick={reset}>
          {t('hotkeys.reset')}
        </Button>
      ) : null}
      <Button
        variant="secondary"
        onClick={() => {
          setError(null);
          setCapturing(!capturing);
        }}
      >
        {capturing ? t('common.cancel') : t('hotkeys.change')}
      </Button>
    </Row>
  );
}
