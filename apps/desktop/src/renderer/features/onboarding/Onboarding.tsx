import { AudioWaveform, Bell, Mic, MonitorUp, TriangleAlert } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { PermissionStatus } from '../../../shared/ipc';
import { Logo } from '../../components/Logo';
import { Button, Segmented, Select, cx } from '../../components/ui';
import { t } from '../../i18n';
import { platform } from '../../platform';
import { voice } from '../../services/voice';
import { usePrefs } from '../../stores/prefs';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { useWorkspaces } from '../../stores/workspaces';
import { MicMeter } from '../settings/AppSettingsDialog';
import { PttBinder } from '../settings/PttBinder';

/**
 * First run (docs/08 «Онбординг», docs/09 #20): one card per step — an icon illustration, a
 * title, one sentence of «why», the step's controls, and Setup-Assistant actions (Назад on the
 * left, «Позже» + the primary action on the right). The card top is anchored and its height
 * has a floor, so the progress dots never jump between steps. Everything is skippable; each
 * permission is requested at the step that needs it.
 */
type Step = 'mic' | 'mode' | 'screen' | 'notifications' | 'done';

function useIsMacDesktop(): boolean {
  const os = useSession((s) => s.appInfo?.platform);
  return os === 'darwin' && platform.kind === 'electron';
}

interface Nav {
  next: () => void;
  back: (() => void) | null;
}

export function Onboarding(): ReactNode {
  const mac = useIsMacDesktop();
  const steps: Step[] = ['mic', 'mode', ...(mac ? (['screen'] as Step[]) : []), 'notifications', 'done'];
  const [i, setI] = useState(0);
  const step = steps[i] ?? 'done';
  const nav: Nav = {
    next: () => setI((v) => Math.min(steps.length - 1, v + 1)),
    back: i > 0 ? () => setI((v) => Math.max(0, v - 1)) : null,
  };
  const finish = (): void => {
    voice.stopMicTest();
    usePrefs.getState().setPrefs({ onboarded: true });
  };

  return (
    <div className="mat-content drag flex h-full flex-col items-center overflow-y-auto px-4 pb-8 pt-[max(40px,10vh)]">
      <div className="no-drag flex w-full max-w-[520px] flex-col gap-5" data-testid={`onboarding-${step}`}>
        <ol className="flex h-2 items-center justify-center gap-2" aria-label={t('onb.progress', { n: i + 1, total: steps.length })}>
          {steps.map((s, n) => (
            <li
              key={s}
              aria-current={n === i ? 'step' : undefined}
              className={cx('h-2 rounded-full transition-[width,background-color] duration-[var(--motion)]', n === i ? 'w-5 bg-accent' : n < i ? 'w-2 bg-accent' : 'w-2 bg-[var(--color-fill-hover)]')}
            />
          ))}
        </ol>
        {step === 'mic' ? <MicStep nav={nav} /> : null}
        {step === 'mode' ? <ModeStep nav={nav} /> : null}
        {step === 'screen' ? <ScreenStep nav={nav} /> : null}
        {step === 'notifications' ? <NotificationsStep nav={nav} /> : null}
        {step === 'done' ? <DoneStep nav={nav} onFinish={finish} /> : null}
        {step !== 'done' ? (
          <button type="button" onClick={finish} className="self-center rounded-[var(--radius-control)] px-2 py-1 text-caption text-muted hover:text-fg hover:underline">
            {t('onb.skipAll')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function StepFrame({
  illustration,
  title,
  text,
  children,
  actions,
  back,
}: {
  illustration: ReactNode;
  title: string;
  text: string;
  children?: ReactNode;
  actions: ReactNode;
  back: (() => void) | null;
}): ReactNode {
  return (
    <section className="mat-popover flex min-h-[360px] flex-col gap-5 rounded-[var(--radius-panel)] p-6">
      <div className="flex flex-col items-center gap-3 text-center">
        {illustration}
        <h1 className="text-large font-semibold">{title}</h1>
        <p className="max-w-[420px] text-body text-muted">{text}</p>
      </div>
      {children}
      <div className="mt-auto flex items-center gap-2 pt-1">
        {back ? (
          <Button variant="ghost" size="lg" onClick={back}>
            {t('onb.back')}
          </Button>
        ) : null}
        <div className="ml-auto flex gap-2">{actions}</div>
      </div>
    </section>
  );
}

/** Step illustration: a large glyph on a soft accent disc (no gradients, docs/08). */
function Illustration({ icon: Icon }: { icon: typeof Mic }): ReactNode {
  return (
    <span className="grid size-16 place-items-center rounded-full bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)] text-accent" aria-hidden>
      <Icon className="size-8" strokeWidth={1.75} />
    </span>
  );
}

/** Yellow-tint note with ⚠︎ for something still to do (not an error). */
function WarnNote({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="flex items-start gap-2 rounded-[var(--radius-card)] bg-mention px-3 py-2.5 text-left text-body text-fg" role="status">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
      <div className="flex min-w-0 flex-col gap-2">{children}</div>
    </div>
  );
}

function MicStep({ nav }: { nav: Nav }): ReactNode {
  const [state, setState] = useState<'idle' | 'asking' | 'ok' | 'denied'>('idle');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const micId = usePrefs((s) => s.micDeviceId);
  const setPrefs = usePrefs((s) => s.setPrefs);
  const micError = useVoice((s) => s.micError);
  const os = useSession((s) => s.appInfo?.platform);

  const ask = async (): Promise<void> => {
    setState('asking');
    const granted = await platform.system.requestMic();
    if (!granted) {
      setState('denied');
      return;
    }
    await voice.startMicTest();
    setDevices((await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default'));
    setState(useVoice.getState().micError ? 'denied' : 'ok');
  };

  const ok = state === 'ok';
  return (
    <StepFrame
      illustration={<Illustration icon={Mic} />}
      title={ok ? t('onb.micCheckTitle') : t('onb.micTitle')}
      text={ok ? t('onb.micCheckText') : t('onb.micText')}
      back={nav.back}
      actions={
        <>
          <Button variant="secondary" size="lg" onClick={nav.next}>
            {t('onb.later')}
          </Button>
          {ok ? (
            <Button size="lg" onClick={nav.next}>
              {t('onb.micGood')}
            </Button>
          ) : (
            <Button size="lg" busy={state === 'asking'} onClick={() => void ask()}>
              {t('onb.micAllow')}
            </Button>
          )}
        </>
      }
    >
      {ok ? (
        <div className="flex flex-col gap-3">
          <Select aria-label={t('voice.input')} value={micId ?? ''} onChange={(e) => setPrefs({ micDeviceId: e.target.value || null })}>
            <option value="">{t('voice.defaultDevice')}</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || d.deviceId.slice(0, 8)}
              </option>
            ))}
          </Select>
          <MicMeter />
        </div>
      ) : null}
      {state === 'denied' ? (
        <WarnNote>
          <p>{micError ?? t('onb.micDenied')}</p>
          {platform.kind === 'electron' && (os === 'darwin' || os === 'win32') ? (
            <Button variant="secondary" size="sm" className="self-start" onClick={() => void platform.system.openPrivacySettings('microphone')}>
              {t('perm.openOs')}
            </Button>
          ) : (
            <p className="text-muted">{t('onb.micDeniedWeb')}</p>
          )}
        </WarnNote>
      ) : null}
    </StepFrame>
  );
}

function ModeStep({ nav }: { nav: Nav }): ReactNode {
  const p = usePrefs();
  return (
    <StepFrame
      illustration={<Illustration icon={AudioWaveform} />}
      title={t('onb.modeTitle')}
      text={t('onb.modeText')}
      back={nav.back}
      actions={
        <Button size="lg" onClick={nav.next}>
          {t('onb.next')}
        </Button>
      }
    >
      <div className="flex flex-col items-center gap-4">
        <Segmented
          label={t('voice.mode')}
          value={p.micMode}
          onChange={(m) => p.setPrefs({ micMode: m })}
          options={[
            { value: 'voice', label: t('voice.modeVad') },
            { value: 'ptt', label: t('voice.modePtt') },
          ]}
        />
        {p.micMode === 'ptt' ? (
          <div className="w-full rounded-[var(--radius-card)] bg-[var(--color-card)] p-3">
            <PttBinder compact />
          </div>
        ) : (
          <p className="text-center text-body text-muted">{t('onb.vadText')}</p>
        )}
      </div>
    </StepFrame>
  );
}

function ScreenStep({ nav }: { nav: Nav }): ReactNode {
  const [p, setP] = useState<PermissionStatus | null>(null);
  useEffect(() => {
    const check = (): void => void platform.system.permissions().then(setP);
    check();
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, []);
  const granted = p?.screen === 'granted';
  return (
    <StepFrame
      illustration={<Illustration icon={MonitorUp} />}
      title={t('onb.screenTitle')}
      text={t('onb.screenText')}
      back={nav.back}
      actions={
        <>
          <Button variant="secondary" size="lg" onClick={nav.next}>
            {t('onb.later')}
          </Button>
          {granted ? (
            <Button size="lg" onClick={nav.next}>
              {t('onb.next')}
            </Button>
          ) : (
            <Button size="lg" onClick={() => void platform.system.openPrivacySettings('screen')}>
              {t('perm.openOs')}
            </Button>
          )}
        </>
      }
    >
      {granted ? <p className="rounded-[var(--radius-card)] bg-[var(--color-card)] p-3 text-center text-body text-ok">{t('onb.screenOk')}</p> : <WarnNote>{t('onb.screenRestart')}</WarnNote>}
    </StepFrame>
  );
}

function NotificationsStep({ nav }: { nav: Nav }): ReactNode {
  const [perm, setPerm] = useState(typeof Notification === 'undefined' ? 'denied' : Notification.permission);
  return (
    <StepFrame
      illustration={<Illustration icon={Bell} />}
      title={t('onb.notifTitle')}
      text={t('onb.notifText')}
      back={nav.back}
      actions={
        <>
          <Button variant="secondary" size="lg" onClick={nav.next}>
            {t('onb.later')}
          </Button>
          {perm === 'default' ? (
            <Button
              size="lg"
              onClick={() =>
                void Notification.requestPermission().then((p) => {
                  setPerm(p);
                  nav.next();
                })
              }
            >
              {t('onb.notifAllow')}
            </Button>
          ) : (
            <Button size="lg" onClick={nav.next}>
              {t('onb.next')}
            </Button>
          )}
        </>
      }
    />
  );
}

function DoneStep({ nav, onFinish }: { nav: Nav; onFinish: () => void }): ReactNode {
  const hasWs = useWorkspaces((s) => s.order.length > 0);
  const open = useUi((s) => s.openDialog);
  return (
    <StepFrame
      illustration={<Logo size={64} />}
      title={t('onb.doneTitle')}
      text={hasWs ? t('onb.doneText') : t('onb.doneNoWs')}
      back={nav.back}
      actions={
        hasWs ? (
          <Button size="lg" onClick={onFinish}>
            {t('onb.start')}
          </Button>
        ) : (
          <>
            <Button
              variant="secondary"
              size="lg"
              onClick={() => {
                onFinish();
                open({ kind: 'join-workspace' });
              }}
            >
              {t('ws.join')}
            </Button>
            <Button
              size="lg"
              onClick={() => {
                onFinish();
                open({ kind: 'create-workspace' });
              }}
            >
              {t('ws.create')}
            </Button>
          </>
        )
      }
    />
  );
}
