import { TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PttBinding, PttStatus } from '../../../shared/ipc';
import { KEY, keyName, mouseName } from '../../../shared/pttKeys';
import { Button, Toggle, cx } from '../../components/ui';
import { t } from '../../i18n';
import { platform } from '../../platform';
import { usePrefs } from '../../stores/prefs';
import { useSession } from '../../stores/session';
import { useVoice } from '../../stores/voice';

/** Human name of a binding, recomputed (older saved labels were raw uiohook names). */
export function bindingLabel(b: PttBinding | null, os: string): string {
  if (!b) return t('voice.pttNone');
  if (b.kind === 'key') return b.remap === 'caps-f18' ? keyName(KEY.CAPS_LOCK, os) : keyName(b.code, os);
  if (b.kind === 'mouse') return mouseName(b.code);
  return b.label;
}

function isCaps(b: PttBinding | null): boolean {
  if (!b) return false;
  if (b.kind === 'key') return b.code === KEY.CAPS_LOCK || b.code === KEY.CAPS_LOCK_STATE || b.remap === 'caps-f18';
  return b.kind === 'dom' && b.code === 'CapsLock';
}

/**
 * Push-to-talk key binder (settings + onboarding). Capture happens in main (uiohook), so any
 * key works: F13–F24, lone modifiers, Numpad, Caps Lock, mouse buttons 3+. Shows a live
 * «key is down» dot so the user can check the key right here.
 */
export function PttBinder({ compact = false }: { compact?: boolean }): ReactNode {
  const b = usePrefs((s) => s.pttBinding);
  const setPrefs = usePrefs((s) => s.setPrefs);
  const os = useSession((s) => s.appInfo?.platform ?? 'web');
  const talking = useVoice((s) => s.pttDown);
  const [capturing, setCapturing] = useState(false);
  const [status, setStatus] = useState<PttStatus | null>(null);
  const web = platform.kind === 'web';
  const mac = os === 'darwin' && !web;

  useEffect(() => {
    const check = (): void => void platform.ptt.status().then(setStatus);
    check();
    window.addEventListener('focus', check); // back from System Settings
    return () => window.removeEventListener('focus', check);
  }, [b]);

  // Closing the binder (Settings / onboarding) with a capture armed must disarm it: otherwise the
  // next key typed anywhere in the OS became the PTT key (review H2).
  const mounted = useRef(true);
  const alive = (): boolean => mounted.current;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      platform.ptt.cancelCapture();
    };
  }, []);

  const bind = async (): Promise<void> => {
    setCapturing(true);
    try {
      const next = await platform.ptt.captureNext();
      if (alive()) setPrefs({ pttBinding: next });
    } catch {
      // cancelled (Esc / closed), superseded or timed out
    } finally {
      if (alive()) {
        setCapturing(false);
        const st = await platform.ptt.status();
        if (alive()) setStatus(st);
      }
    }
  };

  const caps = isCaps(b);
  const toggle = b?.mode === 'toggle' || (b?.kind === 'key' && b.code === KEY.CAPS_LOCK_STATE);
  const remapped = b?.kind === 'key' && b.remap === 'caps-f18';
  const setRemap = (on: boolean): void => {
    setPrefs({
      pttBinding: on
        ? { kind: 'key', code: KEY.F18, label: keyName(KEY.CAPS_LOCK, os), mode: 'hold', remap: 'caps-f18' }
        : { kind: 'key', code: KEY.CAPS_LOCK_STATE, label: keyName(KEY.CAPS_LOCK, os), mode: 'toggle' },
    });
  };

  return (
    <div className={cx('flex flex-col gap-3', compact ? '' : 'px-3 py-3')} data-testid="ptt-binder" data-settings-row>
      <div className="flex items-center justify-between gap-3">
        <span className="text-body" data-settings-label data-settings-hint={t('voice.pttHint')}>
          {t('voice.pttKey')}
        </span>
        <span className="flex items-center gap-2">
          <span
            className={cx('size-2 rounded-full', talking ? 'bg-ok' : 'bg-[var(--color-fill-hover)]')}
            role="status"
            aria-label={talking ? t('voice.pttLive') : t('voice.pttIdle')}
            title={talking ? t('voice.pttLive') : t('voice.pttIdle')}
          />
          <kbd className="min-w-20 truncate rounded-[var(--radius-control)] border border-line bg-elev px-2 py-1 text-center font-sans text-caption">
            {capturing ? t('voice.pttPress') : bindingLabel(b, os)}
          </kbd>
          <Button variant="secondary" busy={capturing} onClick={() => void bind()}>
            {t('voice.pttAssign')}
          </Button>
        </span>
      </div>

      {capturing ? <p className="text-caption text-muted">{t('voice.pttCaptureHint')}</p> : null}

      {caps && toggle && !remapped ? <p className="rounded-[var(--radius-control)] bg-mention px-2 py-1.5 text-caption">{t('voice.pttCapsToggle')}</p> : null}
      {toggle && !caps ? <p className="text-caption text-muted">{t('voice.pttToggleNote')}</p> : null}
      {mac && caps ? (
        <div className="flex items-center justify-between gap-3">
          <span className="flex flex-col">
            <span className="text-body">{t('voice.pttCapsRemap')}</span>
            <span className="text-caption text-muted">{t('voice.pttCapsRemapHint')}</span>
          </span>
          <Toggle label={t('voice.pttCapsRemap')} checked={remapped} onChange={setRemap} />
        </div>
      ) : null}

      {status && !status.trusted ? (
        // A permission still to grant is a warning, not an error (UX review): yellow tint + ⚠︎.
        <div className="flex items-center justify-between gap-3 rounded-[var(--radius-control)] bg-mention px-2.5 py-2 text-caption text-fg" role="status">
          <span className="flex items-start gap-2">
            <TriangleAlert className="mt-px size-4 shrink-0 text-warn" aria-hidden />
            {t('voice.pttNoAccess')}
          </span>
          <Button variant="secondary" size="sm" onClick={() => void platform.system.openPrivacySettings('input-monitoring')}>
            {t('perm.openOs')}
          </Button>
        </div>
      ) : null}
      {status?.wayland ? <p className="text-caption text-muted">{t('voice.pttWayland')}</p> : null}
      {status?.error && status.trusted && !status.wayland ? <p className="text-caption text-danger-text">{t('voice.pttError')}</p> : null}
      <p className="text-caption text-faint">{web ? t('voice.pttHintWeb') : t('voice.pttHint')}</p>
    </div>
  );
}
