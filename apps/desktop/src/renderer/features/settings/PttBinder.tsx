import { TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PttBinding, PttRawKey, PttStatus } from '../../../shared/ipc';
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

/** Capture ids (per click of «Assign»): main / web cancel only the capture with a matching id. */
let lastCaptureId = 0;
const nextCaptureId = (): number => ++lastCaptureId;

/** Toggle bindings (incl. the legacy Caps Lock lock-state one): press on, press off. */
export function isToggleBinding(b: PttBinding | null): boolean {
  return b?.mode === 'toggle' || (b?.kind === 'key' && b.code === KEY.CAPS_LOCK_STATE);
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
  const [lastKey, setLastKey] = useState<PttRawKey | null>(null);
  const web = platform.kind === 'web';
  const mac = os === 'darwin' && !web;

  // Diagnostics: main sends every raw key event while our capture is armed (source tap / hid).
  useEffect(() => platform.ptt.onRawKey(setLastKey), []);

  useEffect(() => {
    const check = (): void => void platform.ptt.status().then(setStatus);
    check();
    window.addEventListener('focus', check); // back from System Settings
    return () => window.removeEventListener('focus', check);
  }, [b]);

  // Closing the binder (Settings / onboarding) with a capture armed must disarm it: otherwise the
  // next key typed anywhere in the OS became the PTT key (review H2).
  // Cancels by this binder's capture id: another binder on screen (settings search shows the
  // Voice and Hotkeys tabs together) must not cancel ours on its unmount (review N6).
  const mounted = useRef(true);
  const alive = (): boolean => mounted.current;
  const captureId = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (captureId.current) platform.ptt.cancelCapture(captureId.current);
    };
  }, []);

  const bind = async (): Promise<void> => {
    setCapturing(true);
    try {
      captureId.current = nextCaptureId();
      const next = await platform.ptt.captureNext(captureId.current);
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
  const toggle = isToggleBinding(b);
  const remapped = b?.kind === 'key' && b.remap === 'caps-f18';
  // macOS HID listener: the physical Caps Lock is a real hold key, the hidutil remap is not needed.
  const hid = status?.hid === 'running';
  const hidBlocked = mac && (status?.hid === 'denied' || status?.hid === 'restart');
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
          <kbd className="min-w-20 truncate rounded-[var(--radius-row)] border border-line bg-elev px-2 py-1 text-center font-sans text-caption">
            {capturing ? t('voice.pttPress') : bindingLabel(b, os)}
          </kbd>
          <Button variant="secondary" busy={capturing} onClick={() => void bind()}>
            {t('voice.pttAssign')}
          </Button>
        </span>
      </div>

      {capturing ? <p className="text-caption text-muted">{t('voice.pttCaptureHint')}</p> : null}
      {lastKey && !web ? (
        <p className="text-caption text-muted" data-testid="ptt-last-key">
          {t('voice.pttLastKey', {
            key: keyName(lastKey.code, os),
            dir: lastKey.down ? '↓' : '↑',
            source: lastKey.source === 'hid' ? 'HID' : t('voice.pttSourceTap'),
            code: String(lastKey.code),
            raw: `0x${lastKey.rawcode.toString(16)}`,
          })}
          {lastKey.dropped ? ` ${t('voice.pttLastKeyDup')}` : ''}
        </p>
      ) : null}

      {caps && toggle && !remapped && !hid ? <p className="rounded-[var(--radius-row)] bg-mention px-2 py-1.5 text-caption">{t('voice.pttCapsToggle')}</p> : null}
      {toggle && (!caps || hid) ? <p className="text-caption text-muted">{t('voice.pttToggleNote')}</p> : null}
      {hidBlocked && status.trusted ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-caption text-muted">{status.hid === 'restart' ? t('voice.pttHidRestart') : t('voice.pttHidDenied')}</span>
          {status.hid === 'denied' ? (
            <Button variant="secondary" size="sm" onClick={() => void platform.system.openPrivacySettings('input-monitoring')}>
              {t('perm.openOs')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {mac && caps && !hid ? (
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
        <div className="flex items-center justify-between gap-3 rounded-[var(--radius-row)] bg-mention px-2.5 py-2 text-caption text-fg" role="status">
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
