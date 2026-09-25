import { Bell, Keyboard, Mic, MonitorUp, Sparkles } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { PermissionStatus } from '../../../shared/ipc';
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
 * First run (docs/08, «Онбординг»): one screen per step, everything skippable. Each
 * permission is requested at the step that needs it, with one sentence of «why».
 */
type Step = 'mic' | 'mode' | 'screen' | 'notifications' | 'done';

function useIsMacDesktop(): boolean {
  const os = useSession((s) => s.appInfo?.platform);
  return os === 'darwin' && platform.kind === 'electron';
}

export function Onboarding(): ReactNode {
  const mac = useIsMacDesktop();
  const steps: Step[] = ['mic', 'mode', ...(mac ? (['screen'] as Step[]) : []), 'notifications', 'done'];
  const [i, setI] = useState(0);
  const step = steps[i] ?? 'done';
  const next = (): void => setI((v) => Math.min(steps.length - 1, v + 1));
  const finish = (): void => {
    voice.stopMicTest();
    usePrefs.getState().setPrefs({ onboarded: true });
  };

  return (
    <div className="mat-content drag flex h-full flex-col items-center justify-center px-4">
      <div className="no-drag flex w-full max-w-[520px] flex-col gap-6" data-testid={`onboarding-${step}`}>
        <ol className="flex justify-center gap-2" aria-label={t('onb.progress', { n: i + 1, total: steps.length })}>
          {steps.map((s, n) => (
            <li key={s} aria-current={n === i ? 'step' : undefined} className={cx('h-1.5 w-8 rounded-full', n <= i ? 'bg-accent' : 'bg-[var(--color-fill-hover)]')} />
          ))}
        </ol>
        {step === 'mic' ? <MicStep onNext={next} /> : null}
        {step === 'mode' ? <ModeStep onNext={next} /> : null}
        {step === 'screen' ? <ScreenStep onNext={next} /> : null}
        {step === 'notifications' ? <NotificationsStep onNext={next} /> : null}
        {step === 'done' ? <DoneStep onFinish={finish} /> : null}
        {step !== 'done' ? (
          <button type="button" onClick={finish} className="self-center text-[12px] text-muted hover:text-fg hover:underline">
            {t('onb.skipAll')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function StepFrame({
  icon: Icon,
  title,
  text,
  children,
  actions,
}: {
  icon: typeof Mic;
  title: string;
  text: string;
  children?: ReactNode;
  actions: ReactNode;
}): ReactNode {
  return (
    <section className="mat-popover flex flex-col gap-5 rounded-[var(--radius-panel)] p-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="grid size-12 place-items-center rounded-full bg-accent text-accent-fg">
          <Icon className="size-6" aria-hidden />
        </span>
        <h1 className="text-[26px] font-semibold leading-tight">{title}</h1>
        <p className="text-[14px] text-muted">{text}</p>
      </div>
      {children}
      <div className="flex justify-end gap-2">{actions}</div>
    </section>
  );
}

function MicStep({ onNext }: { onNext: () => void }): ReactNode {
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

  return (
    <StepFrame
      icon={Mic}
      title={t('onb.micTitle')}
      text={t('onb.micText')}
      actions={
        state === 'ok' ? (
          <>
            <Button variant="secondary" size="lg" onClick={onNext}>
              {t('onb.later')}
            </Button>
            <Button size="lg" onClick={onNext}>
              {t('onb.micGood')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" size="lg" onClick={onNext}>
              {t('onb.later')}
            </Button>
            <Button size="lg" busy={state === 'asking'} onClick={() => void ask()}>
              {t('onb.micAllow')}
            </Button>
          </>
        )
      }
    >
      {state === 'ok' ? (
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
          <p className="text-[12px] text-faint">{t('onb.micSay')}</p>
        </div>
      ) : null}
      {state === 'denied' ? (
        <div className="flex flex-col gap-2 rounded-[var(--radius-card)] bg-mention p-3 text-[13px]" role="alert">
          <p>{micError ?? t('onb.micDenied')}</p>
          {platform.kind === 'electron' && (os === 'darwin' || os === 'win32') ? (
            <Button variant="secondary" className="self-start" onClick={() => void platform.system.openPrivacySettings('microphone')}>
              {t('perm.openOs')}
            </Button>
          ) : (
            <p className="text-muted">{t('onb.micDeniedWeb')}</p>
          )}
        </div>
      ) : null}
    </StepFrame>
  );
}

function ModeStep({ onNext }: { onNext: () => void }): ReactNode {
  const p = usePrefs();
  return (
    <StepFrame
      icon={Keyboard}
      title={t('onb.modeTitle')}
      text={t('onb.modeText')}
      actions={
        <Button size="lg" onClick={onNext}>
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
          <div className="w-full rounded-[var(--radius-card)] bg-elev p-3">
            <PttBinder compact />
          </div>
        ) : (
          <p className="text-center text-[13px] text-muted">{t('onb.vadText')}</p>
        )}
      </div>
    </StepFrame>
  );
}

function ScreenStep({ onNext }: { onNext: () => void }): ReactNode {
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
      icon={MonitorUp}
      title={t('onb.screenTitle')}
      text={t('onb.screenText')}
      actions={
        <>
          <Button variant="secondary" size="lg" onClick={onNext}>
            {t('onb.later')}
          </Button>
          {granted ? (
            <Button size="lg" onClick={onNext}>
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
      <p className={cx('rounded-[var(--radius-card)] p-3 text-center text-[13px]', granted ? 'bg-elev text-ok' : 'bg-mention')}>
        {granted ? t('onb.screenOk') : t('onb.screenRestart')}
      </p>
    </StepFrame>
  );
}

function NotificationsStep({ onNext }: { onNext: () => void }): ReactNode {
  const [perm, setPerm] = useState(typeof Notification === 'undefined' ? 'denied' : Notification.permission);
  return (
    <StepFrame
      icon={Bell}
      title={t('onb.notifTitle')}
      text={t('onb.notifText')}
      actions={
        <>
          <Button variant="secondary" size="lg" onClick={onNext}>
            {t('onb.later')}
          </Button>
          {perm === 'default' ? (
            <Button size="lg" onClick={() => void Notification.requestPermission().then((p) => { setPerm(p); onNext(); })}>
              {t('onb.notifAllow')}
            </Button>
          ) : (
            <Button size="lg" onClick={onNext}>
              {t('onb.next')}
            </Button>
          )}
        </>
      }
    />
  );
}

function DoneStep({ onFinish }: { onFinish: () => void }): ReactNode {
  const hasWs = useWorkspaces((s) => s.order.length > 0);
  const open = useUi((s) => s.openDialog);
  return (
    <StepFrame
      icon={Sparkles}
      title={t('onb.doneTitle')}
      text={hasWs ? t('onb.doneText') : t('onb.doneNoWs')}
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
