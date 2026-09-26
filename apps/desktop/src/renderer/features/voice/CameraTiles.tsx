import { Maximize2, MessageSquare, MicOff, VideoOff, X } from 'lucide-react';
import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { IconButton, cx } from '../../components/ui';
import { t } from '../../i18n';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { voice } from '../../services/voice';
import { usePrefs } from '../../stores/prefs';
import { useSession } from '../../stores/session';
import { setVoice, useVoice } from '../../stores/voice';
import { useMemberName, useWorkspaces } from '../../stores/workspaces';
import { MemberContextMenu } from '../people/MemberContextMenu';
import type { Box } from './StreamArea';
import { pipSize } from './streamFormat';
import { layoutTiles, pipCamera, selectTiles, type TilePerson } from './tileLayout';

/*
 * Webcam tiles of my voice room (docs/09 #42): the grid over the chat area, the camera PiP while
 * the chat is open, and 160×90 tiles in the stream stage's strip. Each <video> is attached with
 * LiveKit's attach(), so adaptive stream sizes the subscription to the tile and pauses it when
 * the tile is gone; the engine decides what is subscribed at all (services/voice.ts
 * applyCameras). Video elements are always muted: a camera has no audio.
 */

const useMe = (): string => useSession((s) => s.me?.user?.id ?? '');

/** People in my voice room with their tile video flag (call order). */
export function useRoomPeople(wsId: string | null): TilePerson[] {
  const roomId = useVoice((s) => s.roomId);
  const states = useWorkspaces((s) => (wsId ? s.byId[wsId]?.voice : undefined));
  const cameras = useVoice((s) => s.cameras);
  const myCamera = useVoice((s) => s.camera === 'on');
  const hidden = usePrefs((s) => s.hiddenVideo);
  const me = useMe();
  return useMemo(() => {
    const list = Object.values(states ?? {})
      .filter((v) => v.roomId === roomId)
      .sort((a, b) => Number(a.joinedAt?.seconds ?? 0n) - Number(b.joinedAt?.seconds ?? 0n) || a.userId.localeCompare(b.userId))
      .map((v) => v.userId);
    if (me && !list.includes(me)) list.push(me);
    // Someone with a live camera but no voice state yet (webhook lag) still gets a tile.
    for (const c of cameras) if (!list.includes(c.userId)) list.push(c.userId);
    return list.map((userId) => ({ userId, video: userId === me ? myCamera : cameras.some((c) => c.userId === userId) && !hidden[userId] }));
  }, [states, roomId, cameras, myCamera, hidden, me]);
}

/** Any camera to show (mine or a remote one)? */
export function useAnyCamera(): boolean {
  return useVoice((s) => s.cameras.length > 0 || s.camera === 'on');
}

/** A camera <video>: mine (mirrored self-view) or a remote one; avatar until the first frame. */
function CameraVideo({ userId, wsId, avatarSize, fit = 'cover' }: { userId: string; wsId: string | null; avatarSize: number; fit?: 'cover' | 'contain' }): ReactNode {
  const ref = useRef<HTMLVideoElement>(null);
  const me = useMe();
  const isMe = userId === me;
  const epoch = useVoice((s) => s.trackEpoch);
  const present = useVoice((s) => (isMe ? s.camera === 'on' : s.cameras.some((c) => c.userId === userId)));
  const [hasFrame, setHasFrame] = useState(false);
  useEffect(() => {
    const el = ref.current;
    const track = isMe ? voice.camera.localTrack : voice.cameraTrack(userId);
    if (!el || !track) return;
    const onFrame = (): void => setHasFrame(el.videoWidth > 0);
    el.addEventListener('loadeddata', onFrame);
    el.addEventListener('resize', onFrame);
    track.attach(el);
    onFrame();
    return () => {
      el.removeEventListener('loadeddata', onFrame);
      el.removeEventListener('resize', onFrame);
      track.detach(el);
    };
  }, [userId, isMe, epoch]);
  return (
    <>
      <video
        ref={ref}
        muted
        playsInline
        autoPlay
        data-testid="camera-video"
        className={cx('absolute inset-0 size-full bg-[var(--color-video-bg)]', fit === 'cover' ? 'object-cover' : 'object-contain', isMe && '-scale-x-100')}
      />
      {hasFrame && present ? null : <AvatarFill userId={userId} wsId={wsId} size={avatarSize} />}
    </>
  );
}

function AvatarFill({ userId, wsId, size }: { userId: string; wsId: string | null; size: number }): ReactNode {
  const name = useMemberName(wsId, userId);
  const avatar = useWorkspaces((s) => s.users[userId]?.avatarFileId);
  return (
    <span className="pointer-events-none absolute inset-0 grid place-items-center bg-[var(--color-tile-bg)]" aria-hidden data-testid="tile-avatar">
      <Avatar userId={userId} name={name} fileId={avatar || undefined} size={size} />
    </span>
  );
}

/** Name chip at the bottom-left of a tile: name, «(вы)», crossed mic when muted. */
function TileName({ userId, wsId, small }: { userId: string; wsId: string | null; small?: boolean }): ReactNode {
  const name = useMemberName(wsId, userId);
  const me = useMe();
  const muted = useWorkspaces((s) => (wsId ? (s.byId[wsId]?.voice[userId]?.muted ?? false) : false));
  const label = userId === me ? t('video.you', { name }) : name;
  return (
    <span
      className={cx(
        'pointer-events-none absolute flex max-w-[calc(100%-12px)] items-center gap-1 rounded-full bg-black/60 font-semibold text-white',
        small ? 'bottom-1 left-1 px-1.5 text-[11px] leading-4' : 'bottom-2 left-2 px-2 py-0.5 text-[12px]',
      )}
    >
      {muted ? <MicOff className={cx('shrink-0', small ? 'size-3' : 'size-3.5')} aria-label={t('shell.mutedState')} role="img" /> : null}
      <span className="min-w-0 truncate" title={label}>
        {label}
      </span>
    </span>
  );
}

type TileProps = ComponentPropsWithoutRef<'button'> & {
  userId: string;
  wsId: string | null;
  video: boolean;
  featured: boolean;
  small?: boolean;
  avatarSize: number;
};

/** One participant tile; a button (click = show large / back to the grid). */
const Tile = forwardRef<HTMLButtonElement, TileProps>(function Tile({ userId, wsId, video, featured, small, avatarSize, className, style, ...rest }, ref) {
  const name = useMemberName(wsId, userId);
  const speaking = useVoice((s) => s.speaking[userId] ?? false);
  const muted = useWorkspaces((s) => (wsId ? (s.byId[wsId]?.voice[userId]?.muted ?? false) : false));
  const hasCamera = useVoice((s) => s.cameras.some((c) => c.userId === userId));
  const hidden = usePrefs((s) => !!s.hiddenVideo[userId]);
  const saveTraffic = usePrefs((s) => s.saveTraffic);
  const primary = useVoice(() => voice.primaryCamera());
  const saved = saveTraffic && hasCamera && !hidden && primary !== userId;
  const focused = useVoice((s) => s.focusedTile === userId);
  const off = hasCamera && (hidden || saved);
  return (
    <button
      ref={ref}
      type="button"
      data-testid="video-tile"
      data-featured={featured || undefined}
      aria-label={video || hasCamera ? t('video.of', { name }) : name}
      aria-pressed={focused}
      title={focused ? t('video.unfocus') : t('video.focus')}
      onClick={() => voice.focusTile(userId)}
      className={cx('group/tile absolute overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-tile-bg)] text-left', className)}
      style={style}
      {...rest}
    >
      {video && !saved ? <CameraVideo userId={userId} wsId={wsId} avatarSize={avatarSize} fit={featured ? 'contain' : 'cover'} /> : <AvatarFill userId={userId} wsId={wsId} size={avatarSize} />}
      {/* Speaking ring over the video (docs/09 #30): green, 2 px inside the tile. */}
      <span
        aria-hidden
        className={cx(
          'pointer-events-none absolute inset-0 rounded-[var(--radius-card)] ring-2 ring-inset transition-shadow duration-100',
          speaking && !muted ? 'ring-[var(--color-green)]' : 'ring-transparent',
        )}
      />
      {off ? (
        <span className="pointer-events-none absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-black/60 text-white" title={hidden ? t('video.hidden') : t('video.saved')}>
          <VideoOff className="size-3.5" aria-label={hidden ? t('video.hidden') : t('video.saved')} role="img" />
        </span>
      ) : null}
      <TileName userId={userId} wsId={wsId} small={small} />
    </button>
  );
});

/** Tile with the member's right-click menu (volume, «Не показывать видео», moderation). */
function MemberTile(props: TileProps): ReactNode {
  const wsId = props.wsId;
  if (!wsId) return <Tile {...props} />;
  return (
    <MemberContextMenu workspaceId={wsId} userId={props.userId}>
      <Tile {...props} />
    </MemberContextMenu>
  );
}

function useSize(ref: React.RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const next = { w: el.clientWidth, h: el.clientHeight };
      setSize((s) => (s.w === next.w && s.h === next.h ? s : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

const avatarFor = (w: number, h: number): number => Math.round(Math.max(32, Math.min(96, Math.min(w, h) * 0.36)));

/**
 * The call view (stage «expanded» without a watched stream): up to 6 tiles, the active speaker
 * (or the clicked tile) large, avatars for people without a camera, «Ещё N» for the rest.
 */
export function CameraGrid({ box, wsId, top }: { box: Box; wsId: string | null; top?: ReactNode }): ReactNode {
  const people = useRoomPeople(wsId);
  const focused = useVoice((s) => s.focusedTile);
  const lastSpoke = useVoice((s) => s.lastSpoke);
  const area = useRef<HTMLDivElement>(null);
  const { w, h } = useSize(area);
  const sel = useMemo(() => selectTiles(people, { focused, lastSpoke }), [people, focused, lastSpoke]);
  const n = sel.tiles.length + (sel.overflow > 0 ? 1 : 0);
  const rects = layoutTiles(n, sel.featured !== null, w, h, 8);
  return (
    <div
      data-testid="video-grid"
      role="region"
      aria-label={t('video.grid')}
      className="absolute inset-x-0 z-[var(--z-sticky)] flex flex-col gap-2 bg-feed px-3 pb-3 pt-3"
      style={{ top: box.top, bottom: 'var(--composer-height)' }}
    >
      <div className="flex min-h-7 shrink-0 items-center gap-2">
        <div className="min-w-0 flex-1">{top}</div>
        <button
          type="button"
          onClick={() => voice.setStage('pip')}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-hover px-2.5 text-[12px] font-medium text-fg transition-colors duration-[var(--motion-fast)] hover:bg-active"
        >
          <MessageSquare className="size-3.5" aria-hidden />
          {t('video.showChat')}
        </button>
      </div>
      <div ref={area} className="relative min-h-0 flex-1">
        {sel.tiles.map((p, i) => {
          const r = rects[i];
          if (!r) return null;
          return (
            <MemberTile
              key={p.userId}
              userId={p.userId}
              wsId={wsId}
              video={p.video}
              featured={p.userId === sel.featured}
              small={r.w < 240}
              avatarSize={avatarFor(r.w, r.h)}
              style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
            />
          );
        })}
        {sel.overflow > 0 && rects[n - 1] ? (
          <div
            className="absolute grid place-items-center rounded-[var(--radius-card)] bg-[var(--color-tile-bg)] text-headline font-semibold text-fg"
            style={{ left: rects[n - 1]?.x, top: rects[n - 1]?.y, width: rects[n - 1]?.w, height: rects[n - 1]?.h }}
            data-testid="video-overflow"
          >
            {t('video.more', { n: sel.overflow })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 160×90 camera tile in the stream stage's strip (the low simulcast layer). */
export function CameraStripTile({ userId, wsId }: { userId: string; wsId: string | null }): ReactNode {
  const people = useRoomPeople(wsId);
  const video = people.find((p) => p.userId === userId)?.video ?? false;
  return <MemberTile userId={userId} wsId={wsId} video={video} featured={false} small avatarSize={32} className="!relative h-[90px] w-[160px] shrink-0 ring-1 ring-[var(--color-border-popover)]" />;
}

/** Who has a camera tile in the strip: cameras first (mine too), in call order. */
export function useStripCameras(wsId: string | null): string[] {
  const people = useRoomPeople(wsId);
  return people.filter((p) => p.video).map((p) => p.userId);
}

const PIP_GAP = 12;

/** The active speaker's camera over the chat (no stream watched): click = the call view. */
export function CameraPip({ box, wsId }: { box: Box; wsId: string | null }): ReactNode {
  const wide = useMediaQuery('(min-width: 1200px)');
  const me = useMe();
  const cameras = useVoice((s) => s.cameras);
  const mine = useVoice((s) => s.camera === 'on');
  const lastSpoke = useVoice((s) => s.lastSpoke);
  const focused = useVoice((s) => s.focusedTile);
  const hidden = usePrefs((s) => s.hiddenVideo);
  const ids = cameras.map((c) => c.userId).filter((id) => !hidden[id]);
  if (mine) ids.push(me);
  const userId = focused && ids.includes(focused) ? focused : pipCamera(ids, me, lastSpoke);
  const { w, h } = pipSize(wide, box.height, PIP_GAP);
  const name = useMemberName(wsId, userId ?? '');
  if (!userId) return null;
  return (
    <div
      data-testid="camera-pip"
      role="region"
      aria-label={t('video.of', { name })}
      className="mat-popover group absolute right-4 z-[var(--z-pip)] overflow-hidden rounded-[var(--radius-panel)]"
      style={{ top: box.top + PIP_GAP, width: w, height: h, background: 'var(--color-video-bg)' }}
    >
      <CameraVideo userId={userId} wsId={wsId} avatarSize={w < 240 ? 32 : 48} />
      <button type="button" className="absolute inset-0 rounded-[var(--radius-panel)]" onClick={() => voice.showVideo()} aria-label={t('video.expand')} />
      <TileName userId={userId} wsId={wsId} small={w < 240} />
      <span className="absolute right-1.5 top-1.5 flex gap-0.5 rounded-[var(--radius-card)] bg-black/60 p-0.5 opacity-0 transition-opacity duration-[var(--motion-fast)] group-focus-within:opacity-100 group-hover:opacity-100">
        <IconButton size="sm" label={t('video.expand')} className="text-white hover:bg-white/15 hover:text-white" onClick={() => voice.showVideo()}>
          <Maximize2 className="size-4" aria-hidden />
        </IconButton>
        <IconButton size="sm" label={t('video.close')} className="text-white hover:bg-white/15 hover:text-white" onClick={() => setVoice({ videoPip: false })}>
          <X className="size-4" aria-hidden />
        </IconButton>
      </span>
    </div>
  );
}
