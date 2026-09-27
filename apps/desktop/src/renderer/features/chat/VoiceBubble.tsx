import type { FileMeta } from '@calaba/protocol';
import { Download, Pause, Play } from 'lucide-react';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { formatTime, rateLabel } from '../../lib/chatMedia';
import { drawBars } from '../../lib/voiceNote';
import { usePlayer, type Track } from '../../stores/player';
import { SeekBar, download, isSpace } from './MediaPlayer';

/**
 * A voice message in a bubble (docs/09 #43, docs/08 «Голосовые сообщения», Telegram): play /
 * pause 44 px, the waveform recorded with it (played part in the accent) as the seek bar,
 * duration → time left while active, speed chip. Plays through the chat player (one track at
 * a time, mini-player, `<audio>` on the chosen output — docs/02, echo rule 1).
 */

/** Waveform box: 2 px bars with 2 px gaps. */
const BAR = 2;
const GAP = 2;
const WAVE_H = 24;
const WAVE_W = { desktop: 176, phone: 156 };

let oggSupport: boolean | null = null;
/** Ogg/Opus plays here (Chromium, Firefox, Safari 18.4+); older Safari only downloads it. */
export function canPlayVoice(): boolean {
  if (oggSupport === null) {
    try {
      oggSupport = new Audio().canPlayType('audio/ogg; codecs=opus') !== '';
    } catch {
      oggSupport = false;
    }
  }
  return oggSupport;
}

export function VoiceAttachment({ f, messageId, roomId, author, meta }: { f: FileMeta; messageId: string; roomId: string; author: string; meta?: ReactNode }): ReactNode {
  const total = (f.voice?.durationMs ?? 0) / 1000;
  const active = usePlayer((s) => s.track?.fileId === f.id && s.track.messageId === messageId);
  const playing = usePlayer((s) => active && s.playing);
  const position = usePlayer((s) => (active ? s.position : 0));
  const rate = usePlayer((s) => s.rate);
  const failed = usePlayer((s) => active && s.error);
  const root = useRef<HTMLDivElement>(null);
  const playable = canPlayVoice();
  const track: Track = { fileId: f.id, messageId, roomId, name: f.name, title: author, subtitle: t('media.voice') };
  const waveform = f.voice?.waveform;
  const bars = useMemo(() => drawBars(waveform ?? new Uint8Array(), Math.floor((WAVE_W.desktop + GAP) / (BAR + GAP))), [waveform]);

  // The file's own duration is known up front (VoiceInfo): seeking works before it is loaded.
  useEffect(() => {
    if (total > 0) usePlayer.getState().noteDuration(f.id, total);
  }, [f.id, total]);

  useEffect(() => {
    const el = root.current;
    if (!active || !el) return;
    const io = new IntersectionObserver(([e]) => usePlayer.getState().setInView(!!e?.isIntersecting));
    io.observe(el);
    return () => {
      io.disconnect();
      usePlayer.getState().setInView(false);
    };
  }, [active]);

  const toggle = (): void => usePlayer.getState().toggle(track);
  const time = active ? formatTime(Math.max(0, total - position)) : formatTime(total);

  return (
    <div
      ref={root}
      role="group"
      tabIndex={0}
      aria-label={`${t('media.voice')}, ${formatTime(total)}`}
      data-testid="voice-player"
      data-playing={playing || undefined}
      className="flex w-[244px] max-w-full items-center gap-2.5 rounded-[var(--radius-row)] py-1 mobile:w-[224px]"
      onKeyDown={(e) => {
        if (playable && isSpace(e) && (e.target === e.currentTarget || (e.target as Element).getAttribute('role') === 'slider')) {
          e.preventDefault();
          toggle();
        }
      }}
    >
      {playable ? (
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? t('media.pause') : t('media.play')}
          className="grid size-11 shrink-0 place-items-center rounded-full bg-[var(--bubble-chip-bg)] text-[color:var(--bubble-chip-fg)] transition-opacity duration-[var(--motion-fast)] hover:opacity-90"
        >
          {playing ? <Pause className="size-5 fill-current" aria-hidden /> : <Play className="ml-0.5 size-5 fill-current" aria-hidden />}
        </button>
      ) : (
        <Tip label={t('media.voiceDownload')}>
          <button
            type="button"
            onClick={() => download(f)}
            aria-label={t('media.voiceDownload')}
            className="grid size-11 shrink-0 place-items-center rounded-full bg-[var(--bubble-chip-bg)] text-[color:var(--bubble-chip-fg)] hover:opacity-90"
          >
            <Download className="size-5" aria-hidden />
          </button>
        </Tip>
      )}
      <div className="min-w-0 flex-1">
        <SeekBar
          label={t('media.seek')}
          position={position}
          duration={playable ? total : 0}
          onSeek={(sec) => usePlayer.getState().seek(track, sec)}
          className="h-7"
          render={(pct) => <Wave bars={bars} pct={active ? pct : 0} />}
        />
        <div className="flex h-4 items-center gap-1.5 text-caption leading-4 text-[color:var(--bubble-meta)]">
          <span className="tabular-nums">{failed ? <span className="text-danger-text">{t('media.error')}</span> : time}</span>
          {!playable ? <span className="truncate">{t('chat.download')}</span> : null}
          {active ? (
            <button
              type="button"
              onClick={() => usePlayer.getState().cycleRate()}
              aria-label={t('media.speed', { rate: rateLabel(rate) })}
              className="-my-1 grid h-6 shrink-0 place-items-center mobile:-my-3.5 mobile:h-11 mobile:min-w-11"
            >
              <span
                className={cx(
                  'rounded-full px-1.5 py-px text-caption font-semibold tabular-nums',
                  rate === 1
                    ? 'bg-[color-mix(in_srgb,var(--bubble-accent)_14%,transparent)] text-[color:var(--bubble-accent)]'
                    : 'bg-[var(--bubble-chip-bg)] text-[color:var(--bubble-chip-fg)]',
                )}
              >
                {rateLabel(rate)}
              </span>
            </button>
          ) : null}
          {meta ? <span className="ml-auto shrink-0">{meta}</span> : null}
        </div>
      </div>
    </div>
  );
}

/** The waveform: bars up to `pct` in the accent (played), the rest faded. */
function Wave({ bars, pct }: { bars: number[]; pct: number }): ReactNode {
  const cut = (pct / 100) * bars.length;
  return (
    <div aria-hidden className="flex h-full w-full items-center overflow-hidden" style={{ gap: GAP }}>
      {bars.map((v, i) => (
        <span
          key={i}
          className={cx(
            'shrink-0 rounded-full',
            i < cut ? 'bg-[color:var(--bubble-accent)]' : 'bg-[color-mix(in_srgb,var(--bubble-accent)_35%,transparent)]',
          )}
          style={{ width: BAR, height: Math.max(2, Math.round(v * WAVE_H)) }}
        />
      ))}
    </div>
  );
}
