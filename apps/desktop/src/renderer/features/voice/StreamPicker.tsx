import { ScreenSharePreset, clampStreamPreset, type ConcreteScreenSharePreset } from '@calaba/protocol';
import * as DialogP from '@radix-ui/react-dialog';
import * as TooltipP from '@radix-ui/react-tooltip';
import { AppWindow, Monitor, MonitorUp, Settings2, TriangleAlert, X } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { CaptureSource } from '../../../shared/ipc';
import { Button, Segmented, Spinner, Toggle, cx } from '../../components/ui';
import { t } from '../../i18n';
import { encodableCodecs } from '../../lib/media/screenShare';
import { platform } from '../../platform';
import { voice } from '../../services/voice';
import { usePrefs } from '../../stores/prefs';
import { useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { useVoice } from '../../stores/voice';
import { presetOptions, presetSummary, splitSources } from './streamFormat';

// Room / workspace settings import these from here.
export { PRESETS, PRESET_LABEL, presetDetail, presetText } from './streamFormat';

type Tab = 'apps' | 'screens';

/**
 * Tooltip rendered inside the dialog (no portal): the shared Tip portals to <body> at the popover
 * layer, which sits under the modal layer (docs/08, z-index scale).
 */
function InlineTip({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <TooltipP.Root delayDuration={400}>
      <TooltipP.Trigger asChild>{children}</TooltipP.Trigger>
      <TooltipP.Content
        side="top"
        sideOffset={6}
        collisionPadding={8}
        className="mat-popover anim-in z-[var(--z-popover)] max-w-72 rounded-[var(--radius-control)] px-2 py-1 text-[12px] text-fg"
      >
        {label}
      </TooltipP.Content>
    </TooltipP.Root>
  );
}

/** Quality segment: presets above the room limit stay visible but disabled, with the reason on hover. */
function QualitySegment({
  max,
  value,
  onChange,
}: {
  max: ConcreteScreenSharePreset;
  value: ConcreteScreenSharePreset;
  onChange: (p: ConcreteScreenSharePreset) => void;
}): ReactNode {
  return (
    <div role="radiogroup" aria-label={t('streamPick.quality')} className="inline-flex rounded-[var(--radius-control)] bg-hover p-0.5">
      {presetOptions(max).map((o) => {
        const btn = (
          <button
            key={o.preset}
            type="button"
            role="radio"
            aria-checked={value === o.preset}
            aria-disabled={o.disabledReason ? true : undefined}
            onClick={() => {
              if (!o.disabledReason) onChange(o.preset);
            }}
            className={cx(
              'h-6 rounded-[5px] px-2.5 text-[12px] font-medium transition-colors duration-[var(--motion-fast)]',
              value === o.preset ? 'bg-elev text-fg shadow-[var(--shadow-card)]' : o.disabledReason ? 'cursor-default text-faint' : 'text-fg hover:bg-[var(--color-fill)]',
            )}
          >
            {o.label}
          </button>
        );
        return o.disabledReason ? (
          <InlineTip key={o.preset} label={o.disabledReason}>
            {btn}
          </InlineTip>
        ) : (
          btn
        );
      })}
    </div>
  );
}

/** One capture source: 16:9 preview + app icon + name; hover (or keyboard focus) shows «Стримить». */
function SourceCard({ source, selected, onSelect, onStart }: { source: CaptureSource; selected: boolean; onSelect: () => void; onStart: () => void }): ReactNode {
  const Fallback = source.kind === 'screen' ? Monitor : AppWindow;
  return (
    <div
      data-testid="stream-source"
      className={cx(
        'group relative rounded-[var(--radius-card)] p-1.5 transition-colors duration-[var(--motion-fast)]',
        selected ? 'bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] ring-2 ring-accent' : 'hover:bg-hover',
      )}
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-label={source.name}
        onClick={onSelect}
        onDoubleClick={onStart}
        className="flex w-full flex-col gap-1.5 rounded-[var(--radius-control)] text-left"
      >
        <span className="grid aspect-video w-full place-items-center overflow-hidden rounded-[var(--radius-control)] bg-[var(--color-video-bg)]">
          {source.thumbnail ? (
            <img src={source.thumbnail} alt="" draggable={false} className="size-full object-contain" />
          ) : (
            <Fallback className="size-10 text-faint" aria-hidden />
          )}
        </span>
        <span className="flex min-w-0 items-center gap-2 px-1 pb-0.5">
          {source.appIcon ? (
            <img src={source.appIcon} alt="" draggable={false} className="size-4 shrink-0 rounded-[3px]" />
          ) : (
            <Fallback className="size-4 shrink-0 text-muted" aria-hidden />
          )}
          <span className="min-w-0 flex-1 truncate text-[13px]" title={source.name}>
            {source.name}
          </span>
        </span>
      </button>
      {/* Over the preview; the card button stays the click target around it. */}
      <div className="pointer-events-none absolute inset-x-1.5 top-1.5 grid aspect-video place-items-center rounded-[var(--radius-control)] bg-black/45 opacity-0 transition-opacity duration-[var(--motion-fast)] group-focus-within:opacity-100 group-hover:opacity-100">
        <Button size="lg" className="pointer-events-auto" aria-label={t('streamPick.streamSource', { name: source.name })} onClick={onStart}>
          <MonitorUp className="size-4" aria-hidden />
          {t('streamPick.stream')}
        </Button>
      </div>
    </div>
  );
}

/** Stream picker (docs/09 #13, Discord-like): sources grid + preset bar. */
export function StreamPicker({ onClose }: { onClose: () => void }): ReactNode {
  const roomId = useVoice((s) => s.roomId);
  const codec = useVoice((s) => s.streamCodec);
  const room = useRooms((s) => (roomId ? s.byId[roomId] : undefined));
  const info = useSession((s) => s.appInfo);
  const prefs = usePrefs();
  const web = platform.kind === 'web';
  const [sources, setSources] = useState<CaptureSource[] | null>(web ? [] : null);
  const [tab, setTab] = useState<Tab>('apps');
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [systemAudio, setSystemAudio] = useState(info?.systemAudioLoopback === 'supported');
  const [advanced, setAdvanced] = useState(false);
  const max = room?.media?.maxStreamPreset || ScreenSharePreset.H1080;
  const preset = clampStreamPreset(prefs.streamPreset, max);
  const loopback = info?.systemAudioLoopback ?? 'unsupported';
  const available = useMemo(() => encodableCodecs(), []);

  useEffect(() => {
    if (web) return; // the browser shows its own picker on getDisplayMedia()
    let alive = true;
    void platform.capture.listSources().then((list) => {
      if (!alive) return;
      const { apps, screens } = splitSources(list);
      const first: Tab = apps.length > 0 ? 'apps' : 'screens';
      setSources(list);
      setTab(first);
      setPickedId((first === 'apps' ? apps[0] : screens[0])?.id ?? null);
    });
    return () => {
      alive = false;
    };
  }, [web]);

  const groups = splitSources(sources ?? []);
  const shown = tab === 'apps' ? groups.apps : groups.screens;
  const picked = sources?.find((s) => s.id === pickedId) ?? null;

  const switchTab = (next: Tab): void => {
    setTab(next);
    const list = next === 'apps' ? groups.apps : groups.screens;
    if (!list.some((s) => s.id === pickedId)) setPickedId(list[0]?.id ?? null);
  };

  const start = (src: CaptureSource | null = picked): void => {
    if (!src && !web) return;
    onClose();
    const source = src ? { id: src.id, name: src.name } : { id: '', name: '' };
    void voice.startStream({ source, preset, contentHint: prefs.contentHint, systemAudio });
  };

  const noThumbs = sources !== null && sources.length > 0 && sources.every((s) => !s.thumbnail);
  // Visual tests: synthetic sources, and the machine's real TCC state must not leak into shots.
  const denied = noThumbs || (!info?.visualTest && info?.screenAccess === 'denied');
  const hasH264 = available.has('h264');

  return (
    <DialogP.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogP.Portal>
        <DialogP.Overlay className="fixed inset-0 z-[var(--z-modal)] bg-scrim" />
        <DialogP.Content
          aria-modal="true"
          aria-describedby={undefined}
          data-testid="stream-picker"
          // Desktop: 900×600 like a macOS sheet — never above y = 46 (the 38 px title bar and the
          // traffic lights stay visible), shrinking to 100vh − 62 px (16 px bottom margin); the grid
          // scrolls inside. Centred when the window is tall enough, top-anchored otherwise, hence
          // data-layout-anchor (same as SettingsWindow). The web has no source grid (the browser
          // picks), so its sheet only needs its content height and stays centred.
          data-layout-anchor={web ? undefined : ''}
          className={cx(
            'mat-sheet anim-in fixed left-1/2 z-[var(--z-modal)] flex -translate-x-1/2 flex-col overflow-hidden rounded-[var(--radius-panel)] text-[13px] focus:outline-none',
            web ? 'top-1/2 max-h-[calc(100vh-62px)] -translate-y-1/2' : 'top-[max(46px,calc(50vh-300px))] h-[min(600px,calc(100vh-62px))]',
          )}
          style={{ width: web ? 'min(720px, calc(100vw - 32px))' : 'min(900px, calc(100vw - 32px))' }}
        >
          <TooltipP.Provider>
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 px-5 pb-3 pt-4">
              <DialogP.Title className="truncate text-[16px] font-semibold">{t('streamPick.title')}</DialogP.Title>
              {web ? (
                <span />
              ) : (
                <Segmented
                  label={t('streamPick.kind')}
                  value={tab}
                  onChange={switchTab}
                  options={[
                    { value: 'apps', label: t('streamPick.apps') },
                    { value: 'screens', label: t('streamPick.screens') },
                  ]}
                />
              )}
              <DialogP.Close
                className="-mr-1 grid size-7 shrink-0 place-items-center justify-self-end rounded-[var(--radius-control)] text-muted hover:bg-hover hover:text-fg"
                aria-label={t('streamPick.close')}
              >
                <X className="size-4" aria-hidden />
              </DialogP.Close>
            </div>

            {denied && !web ? (
              <div className="mx-5 mb-3 flex items-center gap-3 rounded-[var(--radius-control)] bg-mention px-3 py-2 text-[13px]" role="alert">
                <TriangleAlert className="size-4 shrink-0 text-warn" aria-hidden />
                <span className="min-w-0 flex-1">{t('stream.noScreenAccess')}</span>
                <Button size="sm" variant="secondary" onClick={() => void platform.system.openPrivacySettings('screen')}>
                  {t('common.openSettings')}
                </Button>
              </div>
            ) : null}

            {/* The last 16 px (the bottom padding) fade out, so a row cut by the footer reads as «more below». */}
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 [mask-image:linear-gradient(to_bottom,black_calc(100%-16px),transparent)]">
              {web ? (
                <div className="flex flex-col items-center justify-center gap-2 px-8 py-6 text-center">
                  <MonitorUp className="size-10 text-faint" aria-hidden />
                  <div className="text-[16px] font-semibold">{t('streamPick.webTitle')}</div>
                  <p className="max-w-md text-muted">{t('stream.webPicker')}</p>
                </div>
              ) : sources === null ? (
                <div className="grid h-full place-items-center">
                  <Spinner />
                </div>
              ) : shown.length === 0 ? (
                <div className="grid h-full place-items-center text-muted">{tab === 'apps' ? t('streamPick.noApps') : t('streamPick.noScreens')}</div>
              ) : (
                <div className="grid grid-cols-2 gap-3 p-0.5">
                  {shown.map((s) => (
                    <SourceCard key={s.id} source={s} selected={s.id === pickedId} onSelect={() => setPickedId(s.id)} onStart={() => start(s)} />
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-3 border-t border-line px-5 py-3">
              {systemAudio && loopback === 'experimental' ? (
                <p className="flex items-start gap-2 rounded-[var(--radius-control)] bg-mention px-3 py-2 text-[12px]" role="note">
                  <TriangleAlert className="mt-px size-4 shrink-0 text-warn" aria-hidden />
                  {t('stream.systemAudioMac')}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                <QualitySegment max={max} value={preset} onChange={(p) => prefs.setPrefs({ streamPreset: p })} />
                <InlineTip label={prefs.contentHint === 'motion' ? t('streamPick.videoHint') : t('streamPick.textHint')}>
                  <span>
                    <Segmented
                      label={t('streamPick.content')}
                      value={prefs.contentHint}
                      onChange={(v) => prefs.setPrefs({ contentHint: v })}
                      options={[
                        { value: 'detail', label: t('streamPick.text') },
                        { value: 'motion', label: t('streamPick.video') },
                      ]}
                    />
                  </span>
                </InlineTip>
                <span className={cx('flex items-center gap-2', loopback === 'unsupported' && 'opacity-50')}>
                  <span className="text-[13px]">{t('streamPick.sound')}</span>
                  {loopback === 'unsupported' ? (
                    <InlineTip label={t('stream.systemAudioNo')}>
                      <span>
                        <Toggle checked={false} disabled onChange={() => undefined} label={t('streamPick.sound')} />
                      </span>
                    </InlineTip>
                  ) : (
                    <Toggle checked={systemAudio} onChange={setSystemAudio} label={t('streamPick.sound')} />
                  )}
                </span>
                <button
                  type="button"
                  aria-label={t('streamPick.advanced')}
                  aria-expanded={advanced}
                  onClick={() => setAdvanced(!advanced)}
                  className={cx(
                    'ml-auto grid size-7 place-items-center rounded-[var(--radius-control)] transition-colors duration-[var(--motion-fast)]',
                    advanced ? 'bg-active text-fg' : 'text-muted hover:bg-hover hover:text-fg',
                  )}
                >
                  <Settings2 className="size-4" aria-hidden />
                </button>
              </div>
              {advanced ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[var(--radius-card)] bg-hover px-3 py-2" data-testid="stream-advanced">
                  <span>{t('streamPick.compat')}</span>
                  {/* Plain-language codec preference (review §3): «best» = auto (ADR-0012: AV1 → VP9 → VP8),
                      «weak computers» = H.264, which the GPU can encode. Explicit codecs set earlier read as «best». */}
                  <Segmented
                    label={t('streamPick.compat')}
                    value={codec === 'h264' ? 'light' : 'best'}
                    onChange={(v) => useVoice.getState().set({ streamCodec: v === 'light' && hasH264 ? 'h264' : 'auto' })}
                    options={[
                      { value: 'best', label: t('streamPick.compatBest') },
                      ...(hasH264 ? [{ value: 'light' as const, label: t('streamPick.compatLight') }] : []),
                    ]}
                  />
                  <span className="basis-full text-[12px] text-muted">{codec === 'h264' && hasH264 ? t('streamPick.compatLightHint') : t('streamPick.compatBestHint')}</span>
                </div>
              ) : null}
              <div className="flex items-center gap-2">
                <span className="flex min-w-0 flex-1 items-center gap-2 text-muted" data-testid="stream-summary">
                  <MonitorUp className="size-4 shrink-0" aria-hidden />
                  <span className="truncate">{presetSummary(preset, prefs.contentHint)}</span>
                </span>
                <Button variant="secondary" onClick={onClose}>
                  {t('common.cancel')}
                </Button>
                <Button onClick={() => start()} disabled={!picked && !web}>
                  {t('stream.go')}
                </Button>
              </div>
            </div>
          </TooltipP.Provider>
        </DialogP.Content>
      </DialogP.Portal>
    </DialogP.Root>
  );
}
