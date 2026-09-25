import { Maximize, Minimize2, MonitorPlay, Fullscreen, SquareArrowOutUpRight, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconButton, cx } from '../../components/ui';
import { t } from '../../i18n';
import { voice } from '../../services/voice';
import { useVoice, type RemoteStream } from '../../stores/voice';
import { memberName } from '../../stores/workspaces';

/** <video> bound to a remote stream track. Its on-screen size drives adaptive stream (layer choice). */
function StreamVideo({ trackSid, className }: { trackSid: string; className?: string }): ReactNode {
  const ref = useRef<HTMLVideoElement>(null);
  const epoch = useVoice((s) => s.trackEpoch);
  useEffect(() => {
    const el = ref.current;
    const track = voice.remoteVideo(trackSid);
    if (!el || !track) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [trackSid, epoch]);
  return <video ref={ref} muted playsInline autoPlay className={cx('bg-[var(--color-video-bg)] object-contain', className)} />;
}

/** Pop-out window: same-origin child window, React portal; video shows the same MediaStreamTrack. */
function Popout({ trackSid, title, onClose }: { trackSid: string; title: string; onClose: () => void }): ReactNode {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const epoch = useVoice((s) => s.trackEpoch);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const w = window.open('about:blank', `calaba-popout-${trackSid}`);
    if (!w) {
      onClose();
      return;
    }
    w.document.title = title;
    for (const node of Array.from(document.head.querySelectorAll('style, link[rel="stylesheet"]'))) {
      w.document.head.appendChild(node.cloneNode(true));
    }
    w.document.documentElement.dataset['theme'] = document.documentElement.dataset['theme'] ?? 'dark';
    w.document.body.style.margin = '0';
    w.document.body.style.background = '#000';
    const root = w.document.createElement('div');
    root.style.cssText = 'position:fixed;inset:0';
    w.document.body.appendChild(root);
    // The portal target lives in a window created here, so state must be set from the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setContainer(root);
    const timer = window.setInterval(() => {
      if (w.closed) onClose();
    }, 500);
    return () => {
      window.clearInterval(timer);
      if (!w.closed) w.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackSid]);

  // Not `attach()`: adaptive stream keeps observing the (large) element in the main window,
  // the pop-out just renders the same track.
  useEffect(() => {
    const el = videoRef.current;
    const track = voice.remoteVideo(trackSid);
    if (!el || !track) return;
    el.srcObject = new MediaStream([track.mediaStreamTrack]);
    void el.play().catch(() => undefined);
  }, [container, trackSid, epoch]);

  if (!container) return null;
  return createPortal(
    <video ref={videoRef} muted playsInline autoPlay style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }} />,
    container,
  );
}

export function StreamArea(): ReactNode {
  const streams = useVoice((s) => s.streams);
  const watching = useVoice((s) => s.watching);
  const stage = useVoice((s) => s.stage);
  const wsId = useVoice((s) => s.workspaceId);
  const set = useVoice((s) => s.set);
  const stageRef = useRef<HTMLDivElement>(null);

  if (streams.length === 0) return null;
  const current = streams.find((s) => s.trackSid === watching);
  const nameOf = (s: RemoteStream): string => memberName(wsId, s.userId);
  const others = streams.filter((s) => s.trackSid !== watching);

  const switcher =
    others.length > 0 || !current ? (
      <div className="flex flex-wrap items-center gap-1.5 border-b border-rail px-4 py-1.5 text-[12px]">
        <MonitorPlay className="size-4 text-danger" />
        <span className="text-muted">{t('stream.live')}:</span>
        {streams.map((s) => (
          <button
            key={s.trackSid}
            type="button"
            onClick={() => voice.watch(s.trackSid)}
            className={cx(
              'rounded-full px-2 py-0.5',
              s.trackSid === watching ? 'bg-accent-strong text-accent-fg' : 'bg-active text-fg hover:bg-hover',
            )}
          >
            {nameOf(s)}
          </button>
        ))}
      </div>
    ) : null;

  if (!current) return switcher;

  const fullscreen = (): void => {
    void stageRef.current?.requestFullscreen().catch(() => undefined);
  };

  if (stage === 'pip') {
    return (
      <>
        {switcher}
        <div
          data-testid="stream-pip"
          className="mat-popover group absolute right-4 z-[var(--z-pip)] w-[320px] overflow-hidden rounded-[var(--radius-panel)] bg-[var(--color-video-bg)]"
          style={{ bottom: 'calc(var(--composer-height) + 16px)' }}
        >
          <button type="button" className="block" onClick={() => set({ stage: 'expanded' })} aria-label={t('stream.expand')}>
            <StreamVideo trackSid={current.trackSid} className="h-[180px] w-[320px]" />
          </button>
          <div className="absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-black/70 px-2 py-1 opacity-0 transition-opacity group-hover:opacity-100">
            <span className="truncate text-[12px] font-semibold text-white">{nameOf(current)}</span>
            <span className="flex">
              <IconButton label={t('stream.expand')} className="text-white" onClick={() => set({ stage: 'expanded' })}>
                <Maximize className="size-4" />
              </IconButton>
              <IconButton label={t('stream.close')} className="text-white" onClick={() => voice.watch(null)}>
                <X className="size-4" />
              </IconButton>
            </span>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {switcher}
      <div ref={stageRef} className="group relative flex h-[58%] min-h-[220px] shrink-0 items-center justify-center bg-[var(--color-video-bg)]">
        <StreamVideo trackSid={current.trackSid} className="size-full" />
        {stage === 'popout' ? (
          <div className="absolute inset-0 grid place-items-center bg-black/80 text-white">
            <div className="text-center">
              <div className="font-semibold">{t('stream.inPopout')}</div>
              <button type="button" className="mt-2 text-accent-text hover:underline" onClick={() => set({ stage: 'expanded' })}>
                {t('stream.returnHere')}
              </button>
            </div>
          </div>
        ) : null}
        <div className="absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-black/70 px-3 py-2 opacity-0 transition-opacity group-hover:opacity-100">
          <span className="truncate text-[13px] font-semibold text-white">{nameOf(current)}</span>
          <span className="flex gap-0.5">
            <IconButton label={t('stream.collapse')} className="text-white" onClick={() => set({ stage: 'pip' })}>
              <Minimize2 className="size-4" />
            </IconButton>
            <IconButton label={t('stream.popout')} className="text-white" onClick={() => set({ stage: 'popout' })}>
              <SquareArrowOutUpRight className="size-4" />
            </IconButton>
            <IconButton label={t('stream.fullscreen')} className="text-white" onClick={fullscreen}>
              <Fullscreen className="size-4" />
            </IconButton>
            <IconButton label={t('stream.close')} className="text-white" onClick={() => voice.watch(null)}>
              <X className="size-4" />
            </IconButton>
          </span>
        </div>
      </div>
      {stage === 'popout' ? (
        <Popout trackSid={current.trackSid} title={`${nameOf(current)} — Calaba`} onClose={() => set({ stage: 'expanded' })} />
      ) : null}
    </>
  );
}
