import type { Room } from '@calaba/protocol';
import { AtSign } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { SPECIAL, type MentionCandidate } from '../../lib/mentions';
import { can, roomPerms } from '../../lib/permissions';
import { isGuest, useWorkspaces } from '../../stores/workspaces';

export type MentionOption = { kind: 'member'; c: MentionCandidate; guest: boolean } | { kind: 'special'; v: (typeof SPECIAL)[number] };

export const optionKey = (o: MentionOption): string => (o.kind === 'member' ? o.c.id : o.v);

export interface Mentionables {
  /** Members who can see the room, except me (popover candidates). */
  candidates: MentionCandidate[];
  guests: Set<string>;
  /** Every member of the workspace with the name shown in the field (typed-name conversion). */
  all: Array<{ id: string; name: string }>;
}

/** Members of the workspace for the composer: names are nickname-aware (like memberName()). */
export function useMentionables(workspaceId: string, room: Room, me: string): Mentionables {
  const members = useWorkspaces((s) => s.byId[workspaceId]?.members);
  return useMemo(() => {
    const out: Mentionables = { candidates: [], guests: new Set(), all: [] };
    for (const m of Object.values(members ?? {})) {
      const u = m.user;
      if (!u) continue;
      const name = m.nickname || u.displayName;
      out.all.push({ id: u.id, name });
      if (u.id === me || !can(roomPerms(m.role, u.id, room), 'VIEW_ROOM')) continue;
      if (isGuest(m)) out.guests.add(u.id);
      out.candidates.push({ id: u.id, name, alt: m.nickname && m.nickname !== u.displayName ? [u.displayName] : [] });
    }
    return out;
  }, [members, me, room]);
}

/**
 * Mention autocomplete above the composer field (Discord-like). Focus stays in the field:
 * ↑/↓, Enter/Tab and Esc are handled by the composer; the mouse picks without blurring it.
 */
export function MentionPopover({
  id,
  options,
  sel,
  onPick,
  onHover,
}: {
  id: string;
  options: MentionOption[];
  sel: number;
  onPick: (o: MentionOption) => void;
  onHover: (i: number) => void;
}): ReactNode {
  const users = useWorkspaces((s) => s.users);
  return (
    <div className="mat-popover anim-in absolute bottom-full left-0 right-0 z-[var(--z-popover)] mb-2 overflow-hidden rounded-[var(--radius-card)]">
      <div className="px-3 pb-1 pt-2 text-[11px] font-semibold text-muted" aria-hidden>
        {t('chat.mentionList')}
      </div>
      <ul id={id} role="listbox" aria-label={t('chat.mentionList')} className="max-h-[min(320px,40vh)] overflow-y-auto p-1 pt-0">
        {options.map((o, i) => {
          const active = i === sel;
          const key = optionKey(o);
          return (
            <li
              key={key}
              id={`${id}-${key}`}
              role="option"
              aria-selected={active}
              ref={active ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(o);
              }}
              onMouseMove={() => (active ? undefined : onHover(i))}
              className={cx(
                'flex h-9 cursor-default items-center gap-2.5 rounded-[5px] px-2 text-[13px]',
                active ? 'bg-accent-strong text-accent-fg' : 'text-fg',
              )}
            >
              {o.kind === 'member' ? (
                <>
                  <Avatar userId={o.c.id} name={o.c.name} fileId={users[o.c.id]?.avatarFileId || undefined} size={24} />
                  <span className="min-w-0 truncate font-medium" title={o.c.name}>
                    {o.c.name}
                  </span>
                  {o.c.alt[0] ? <span className={cx('min-w-0 truncate', active ? 'text-accent-fg' : 'text-muted')}>{o.c.alt[0]}</span> : null}
                  {o.guest ? (
                    <span className={cx('ml-auto shrink-0 text-[11px]', active ? 'text-accent-fg' : 'text-muted')}>{t('chat.mentionGuest')}</span>
                  ) : null}
                </>
              ) : (
                <>
                  <span className="grid size-6 shrink-0 place-items-center rounded-full bg-hover">
                    <AtSign className="size-3.5" aria-hidden />
                  </span>
                  <span className="shrink-0 font-medium">@{o.v}</span>
                  <span className={cx('min-w-0 truncate', active ? 'text-accent-fg' : 'text-muted')}>
                    {t(o.v === 'everyone' ? 'chat.mentionEveryone' : 'chat.mentionHere')}
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
