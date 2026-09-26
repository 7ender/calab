import { RoomType, type Message, type PermissionBits, type Room } from '@calaba/protocol';
import { ChevronDown, ChevronUp, Hash, Pin, Search, Settings, UserPlus, Volume2, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button, IconButton, Spinner, cx } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { can, isAdminRole } from '../../lib/permissions';
import { loadPins } from '../../services/chat';
import { useMessages } from '../../stores/messages';
import { useUi } from '../../stores/ui';
import { memberName, useWorkspaces } from '../../stores/workspaces';
import { useChatView } from './chatView';
import { previewText } from './mentionText';
import { searchWords } from '../../lib/markdown/highlight';

const NO_PINS: Message[] = [];

/** Telegram's pinned strip under the header: newest pin first; each click jumps and moves to the next one. */
export function PinnedBar({ workspaceId, roomId }: { workspaceId: string; roomId: string }): ReactNode {
  const pins = useMessages((s) => s.pins[roomId] ?? NO_PINS);
  const jump = useChatView((s) => s.requestJump);
  const [i, setI] = useState(0);
  useEffect(() => {
    void loadPins(roomId);
  }, [roomId]);
  if (pins.length === 0) return null;
  const idx = i % pins.length;
  const m = pins[idx];
  if (!m) return null;
  const text = previewText(workspaceId, m.content) || (m.attachments.length ? t('chat.attachment') : '');
  return (
    <button
      type="button"
      data-testid="pinned-bar"
      onClick={() => {
        jump(roomId, m.id);
        setI((v) => v + 1);
      }}
      className="mat-toolbar flex h-11 w-full shrink-0 items-center gap-3 border-b border-line px-4 text-left hover:bg-hover"
    >
      <span className="flex h-7 w-[3px] shrink-0 flex-col gap-px" aria-hidden>
        {pins.slice(0, 4).map((p, j) => (
          <span key={p.id} className={j === Math.min(idx, 3) ? 'flex-1 rounded-full bg-accent' : 'flex-1 rounded-full bg-[color-mix(in_srgb,var(--color-accent)_35%,transparent)]'} />
        ))}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-body font-semibold text-accent-text">
          {pins.length > 1 ? t('chat.pinnedN', { n: idx + 1, total: pins.length }) : t('chat.pinnedOne')}
        </span>
        <span className="block truncate text-body text-fg">
          <span className="text-muted">{memberName(workspaceId, m.authorId)}: </span>
          {text}
        </span>
      </span>
      <Pin className="size-4 shrink-0 text-faint" aria-hidden />
    </button>
  );
}

/** In-room search (docs/09 #39): a strip under the header, ↑/↓ walk through results. */
export function SearchPanel({ roomId }: { roomId: string }): ReactNode {
  const setSearch = useChatView((s) => s.setSearch);
  const setHits = useChatView((s) => s.setSearchHits);
  const jump = useChatView((s) => s.requestJump);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ q: string; list: Message[] } | null>(null);
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const needle = q.trim();

  useEffect(() => {
    if (!needle) return;
    const ctl = new AbortController();
    const timer = window.setTimeout(() => {
      api.messages.searchRoom(roomId, { q: needle, limit: 50 }, ctl.signal).then(
        (r) => {
          setFound({ q: needle, list: r.messages });
          setI(0);
          const first = r.messages[0];
          if (first) jump(roomId, first.id);
        },
        () => {
          if (!ctl.signal.aborted) setFound({ q: needle, list: [] });
        },
      );
    }, 250);
    return () => {
      window.clearTimeout(timer);
      ctl.abort();
    };
  }, [needle, roomId, jump]);
  const results = needle && found?.q === needle ? found.list : null;
  const busy = !!needle && found?.q !== needle;

  // Every hit is marked in the feed, the current one stronger (Top 10 #9).
  const currentId = results?.[i]?.id ?? null;
  // Stable per query: bubbles subscribe to the words, so ↑/↓ must not hand them a new array.
  const foundQ = found?.q ?? '';
  const words = useMemo(() => searchWords(foundQ), [foundQ]);
  const ids = useMemo(() => new Set((results ?? []).map((m) => m.id)), [results]);
  useEffect(() => {
    setHits(ids.size ? { roomId, words, ids, current: currentId } : null);
  }, [ids, words, currentId, roomId, setHits]);
  useEffect(() => () => setHits(null), [setHits]);

  const go = (next: number): void => {
    if (!results?.length) return;
    const v = Math.max(0, Math.min(results.length - 1, next));
    setI(v);
    const m = results[v];
    if (m) jump(roomId, m.id);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setSearch(null);
    } else if (e.key === 'Enter' || e.key === 'ArrowUp') {
      e.preventDefault();
      go(e.shiftKey ? i - 1 : i + 1); // results are newest first: "next" = older
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      go(i - 1);
    }
  };

  const total = results?.length ?? 0;
  return (
    <div className="mat-toolbar flex h-11 shrink-0 items-center gap-2 border-b border-line px-4" role="search">
      <Search className="size-4 shrink-0 text-faint" aria-hidden />
      <input
        ref={input}
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onKey}
        placeholder={t('chat.searchPlaceholder')}
        aria-label={t('chat.searchPlaceholder')}
        className="selectable h-8 min-w-0 flex-1 bg-transparent text-body text-fg placeholder:text-faint focus:outline-none focus-visible:outline-none"
      />
      {busy ? <Spinner className="size-4" /> : null}
      {results ? (
        <span className="shrink-0 text-caption tabular-nums text-muted" aria-live="polite">
          {total ? t('chat.searchCount', { n: i + 1, total }) : t('chat.searchNone')}
        </span>
      ) : null}
      <IconButton label={t('chat.searchOlder')} size="sm" disabled={!total || i >= total - 1} onClick={() => go(i + 1)}>
        <ChevronUp className="size-4" />
      </IconButton>
      <IconButton label={t('chat.searchNewer')} size="sm" disabled={!total || i <= 0} onClick={() => go(i - 1)}>
        <ChevronDown className="size-4" />
      </IconButton>
      <IconButton label={t('chat.searchClose')} size="sm" onClick={() => setSearch(null)}>
        <X className="size-4" />
      </IconButton>
    </div>
  );
}

/** Below this chat height the welcome block collapses to one row (voice room with the stream open). */
const COMPACT_BELOW = 280;

/**
 * Empty room (docs/09 #11, #56): big icon, welcome line, «Пригласить» / «Настроить», centred in
 * the message area. Under an expanded stream stage (`underStage`), or when the area is short, it
 * becomes a single row at the bottom, just above the composer.
 */
export function EmptyRoom({ workspaceId, room, perms, underStage = false }: { workspaceId: string; room: Room; perms: PermissionBits; underStage?: boolean }): ReactNode {
  const open = useUi((s) => s.openDialog);
  const role = useWorkspaces((s) => s.byId[workspaceId]?.role);
  const voice = room.type === RoomType.VOICE;
  const Icon = voice ? Volume2 : Hash;
  const canInvite = isAdminRole(role);
  const canSetup = can(perms, 'MANAGE_ROOM');
  const ref = useRef<HTMLDivElement>(null);
  const [short, setShort] = useState(false);
  const compact = underStage || short;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => setShort(el.clientHeight < COMPACT_BELOW);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const title = voice ? t('chat.welcomeVoiceTitle', { name: room.name }) : t('chat.welcomeTitle', { name: room.name });
  const actions =
    canInvite || canSetup ? (
      <div className={cx('flex shrink-0 gap-2', !compact && 'mt-5')}>
        {canInvite ? (
          <Button onClick={() => open({ kind: 'workspace-settings', workspaceId, tab: 'invites' })}>
            <UserPlus className="size-4" aria-hidden /> {t('chat.invite')}
          </Button>
        ) : null}
        {canSetup ? (
          <Button variant="secondary" onClick={() => open({ kind: 'room-settings', roomId: room.id })}>
            <Settings className="size-4" aria-hidden /> {t('chat.setup')}
          </Button>
        ) : null}
      </div>
    ) : null;
  return (
    <div ref={ref} className={cx('flex min-h-0 flex-1 flex-col overflow-y-auto bg-feed', compact ? 'px-4' : 'px-6')} data-testid="empty-room" data-compact={compact || undefined}>
      {compact ? (
        <div className="mt-auto flex min-w-0 items-center gap-3 py-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)] text-accent-text">
            <Icon className="size-4" strokeWidth={1.75} aria-hidden />
          </span>
          <h2 className="min-w-0 flex-1 truncate text-body font-semibold" title={title}>
            {title}
          </h2>
          {actions}
        </div>
      ) : (
        <div className="mx-auto my-auto flex max-w-sm flex-col items-center py-6 text-center" data-testid="empty-room-welcome">
          <span className="grid size-20 place-items-center rounded-full bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)] text-accent-text">
            <Icon className="size-10" strokeWidth={1.5} aria-hidden />
          </span>
          <h2 className="mt-4 text-title font-semibold">{title}</h2>
          <p className="mt-1 text-body text-muted">{voice ? t('chat.welcomeVoice') : t('chat.welcomeText')}</p>
          {actions}
        </div>
      )}
    </div>
  );
}
