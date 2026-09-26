import * as DialogP from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { WorkspaceRole } from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AtSign, Ellipsis, MessageCircle, Plus, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Avatar, avatarColor } from '../../components/Avatar';
import { Logo } from '../../components/Logo';
import { MediaImg, useMediaUrl } from '../../components/MediaImg';
import { Button, cx } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { api, thumbnailPath } from '../../lib/api/endpoints';
import { fmt } from '../../lib/format';
import { startDm } from '../../services/dms';
import { useTimeZoneLabel } from '../../services/timezone';
import { isGuest, useMemberName, useWorkspaces } from '../../stores/workspaces';
import { requestMention } from '../chat/mentionRequest';
import { useCanDm } from '../dm/canDm';
import { menuBox, menuItem } from '../shell/menu';
import { promoteGuest, setMemberRole } from './actions';
import { GuestBadge } from './MemberBits';
import { MemberContextMenu, useMemberActions } from './MemberContextMenu';
import { NOTE_MAX, createNoteSaver, type NoteSaveState, type NoteSaver } from './noteSaver';

const ROLE_KEY: Record<WorkspaceRole, MessageKey> = {
  [WorkspaceRole.UNSPECIFIED]: 'role.member',
  [WorkspaceRole.OWNER]: 'role.owner',
  [WorkspaceRole.ADMIN]: 'role.admin',
  [WorkspaceRole.MEMBER]: 'role.member',
  [WorkspaceRole.GUEST]: 'role.guest',
};

/** Role dot colour: owner / admin tokens, the rest neutral. */
function roleDot(role: WorkspaceRole): string {
  if (role === WorkspaceRole.OWNER) return 'bg-[var(--color-role-owner)]';
  if (role === WorkspaceRole.ADMIN) return 'bg-[var(--color-role-admin)]';
  return 'bg-[var(--color-label-tertiary)]';
}

/**
 * Banner colour (docs/09 #20: «цвет из аватара»): the average colour of the avatar picture, or the
 * identity colour behind the initial. A picture the canvas may not read (another origin) falls
 * back to the identity colour.
 */
function useBannerColor(userId: string, fileId: string | undefined): string {
  const url = useMediaUrl(fileId ? thumbnailPath(fileId) : null);
  const [picked, setPicked] = useState<{ url: string; color: string } | null>(null);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 1;
        const g = c.getContext('2d');
        if (!g) return;
        g.drawImage(img, 0, 0, 1, 1); // the browser averages the picture into one pixel
        const [r = 0, gr = 0, b = 0] = g.getImageData(0, 0, 1, 1).data;
        if (alive) setPicked({ url, color: `rgb(${r} ${gr} ${b})` });
      } catch {
        // tainted canvas: keep the identity colour
      }
    };
    img.src = url;
    return () => {
      alive = false;
    };
  }, [url]);
  return picked && picked.url === url ? picked.color : avatarColor(userId);
}

/**
 * Member profile (docs/09 #20, reference docs/images/reference/discord-profile-full.png): banner in
 * the avatar's colour, avatar 80 with presence, name + profile name + «(+N UTC)», «Написать»
 * (accent) · «Упомянуть» · «…» (the member menu), «Участник с» (registration · this workspace),
 * «Роли» chips with × and + (by rights; the server re-checks), and «Заметка (видна только вам)»
 * saved as you type (800 ms debounce, GET/PUT /api/users/{id}/note).
 */
export function ProfileDialog({
  workspaceId,
  userId,
  focusNote,
  onClose,
}: {
  workspaceId: string;
  userId: string;
  focusNote: boolean;
  onClose: () => void;
}): ReactNode {
  const m = useWorkspaces((s) => s.byId[workspaceId]?.members[userId]);
  const ws = useWorkspaces((s) => s.byId[workspaceId]?.ws);
  const name = useMemberName(workspaceId, userId);
  const tz = useTimeZoneLabel(userId);
  const canDm = useCanDm(workspaceId, userId);
  const u = m?.user;
  const banner = useBannerColor(userId, u?.avatarFileId || undefined);
  const content = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  // The member left (or the workspace is gone) while the dialog was open.
  useEffect(() => {
    if (!m?.user) onClose();
  }, [m, onClose]);
  if (!m || !u) return null;
  const statusLine = [u.statusEmoji, u.statusText].filter(Boolean).join(' ');
  const registered = u.createdAt ? timestampDate(u.createdAt) : null;
  const joined = m.joinedAt ? timestampDate(m.joinedAt) : null;
  const leave = (then: () => void): void => {
    onClose();
    then();
  };
  return (
    <DialogP.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogP.Portal>
        <DialogP.Overlay className="fixed inset-0 z-[var(--z-modal)] bg-scrim" />
        <DialogP.Content
          ref={content}
          aria-modal="true"
          aria-label={t('people.openProfile', { name })}
          data-testid="profile-dialog"
          tabIndex={-1}
          onOpenAutoFocus={(e) => {
            // The dialog itself (Radix would focus the close box first and show its tooltip); the
            // note on «Добавить заметку» (read-only until loaded, but focusable).
            e.preventDefault();
            (focusNote ? noteRef.current : content.current)?.focus();
          }}
          className={cx(
            'mat-sheet anim-in fixed left-1/2 top-1/2 z-[var(--z-modal)] flex max-h-[calc(100vh-64px)] w-[calc(100vw-32px)] max-w-[440px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[var(--radius-panel)] text-body focus:outline-none',
            'mobile:anim-sheet mobile:inset-x-0 mobile:bottom-0 mobile:top-auto mobile:max-h-[calc(var(--app-height)-var(--safe-top)-16px)] mobile:w-full mobile:max-w-none mobile:translate-x-0 mobile:translate-y-0 mobile:rounded-b-none mobile:rounded-t-[16px] mobile:pb-[var(--safe-bottom)]',
          )}
        >
          {/* Banner and body scroll together: the avatar overlaps the banner edge and must not be
              clipped by the scroll box. The close box stays on top, outside the scroller. */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="h-[88px]" style={{ background: banner }} data-testid="profile-banner" />
            <div className="px-5 pb-5">
              {/* Avatar 80 over the banner edge, ringed with the sheet colour (presence dot too). */}
              <div className="relative -mt-11 mb-2 inline-flex rounded-full bg-[var(--color-popover-solid)] p-1.5">
                <Avatar userId={u.id} name={name} fileId={u.avatarFileId || undefined} size={80} presence className="[&>span:last-child]:border-[var(--color-popover-solid)]" />
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <DialogP.Title className="min-w-0 truncate text-title font-semibold leading-tight" title={name}>
                  {name}
                  {tz ? <span className="font-normal text-muted"> {tz}</span> : null}
                </DialogP.Title>
                {isGuest(m) ? <GuestBadge /> : null}
              </div>
              {m.nickname && m.nickname !== u.displayName ? (
                <div className="truncate text-body text-muted" title={u.displayName}>
                  {u.displayName}
                </div>
              ) : null}
              <DialogP.Description className={statusLine ? 'selectable mt-1 break-words text-body' : 'sr-only'}>{statusLine || name}</DialogP.Description>

              <div className="mt-4 flex items-center gap-2">
                {canDm ? (
                  <Button size="lg" onClick={() => leave(() => void startDm(userId))}>
                    <MessageCircle className="size-4" aria-hidden />
                    {t('dm.write')}
                  </Button>
                ) : null}
                <Button size="lg" variant="secondary" onClick={() => leave(() => requestMention(userId, name))}>
                  <AtSign className="size-4" aria-hidden />
                  {t('people.menu.mention')}
                </Button>
                <MoreButton workspaceId={workspaceId} userId={userId} />
              </div>

              {registered || joined ? (
                <Section title={t('people.profile.memberSince')}>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body">
                    {registered ? (
                      <span className="inline-flex items-center gap-1.5" title={t('people.profile.registered', { date: fmt.date(registered) })}>
                        <Logo size={16} className="rounded-[4px]" />
                        {fmt.shortDate(registered)}
                      </span>
                    ) : null}
                    {registered && joined ? (
                      <span className="text-faint" aria-hidden>
                        •
                      </span>
                    ) : null}
                    {joined && ws ? (
                      <span className="inline-flex items-center gap-1.5" title={t('people.profile.joinedWs', { ws: ws.name, date: fmt.date(joined) })}>
                        <span className="grid size-4 shrink-0 place-items-center overflow-hidden rounded-[4px] bg-hover text-[10px] font-semibold" aria-hidden>
                          {ws.iconFileId ? <MediaImg path={thumbnailPath(ws.iconFileId)} alt="" className="size-full object-cover" /> : (ws.name.trim()[0] ?? '?').toUpperCase()}
                        </span>
                        {fmt.shortDate(joined)}
                      </span>
                    ) : null}
                  </div>
                </Section>
              ) : null}

              <Section title={t('people.profile.roles')}>
                <RoleChips workspaceId={workspaceId} userId={userId} role={m.role} />
              </Section>

              <NoteEditor userId={userId} textareaRef={noteRef} />
            </div>
          </div>
          <DialogP.Close
            aria-label={t('common.close')}
            className="absolute right-3 top-3 grid size-7 place-items-center rounded-full bg-scrim text-white transition-[filter] duration-[var(--motion-fast)] hover:brightness-125 focus-visible:outline-2 focus-visible:outline-accent"
          >
            <X className="size-4" strokeWidth={1.75} />
          </DialogP.Close>
        </DialogP.Content>
      </DialogP.Portal>
    </DialogP.Root>
  );
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }): ReactNode {
  return (
    <section className="mt-5">
      <h3 className="mb-1.5 flex items-center justify-between gap-2 text-caption font-semibold text-muted">
        <span>{title}</span>
        {aside}
      </h3>
      {children}
    </section>
  );
}

/** «…»: the member menu (the same one as a right click), opened under the button. */
function MoreButton({ workspaceId, userId }: { workspaceId: string; userId: string }): ReactNode {
  return (
    <MemberContextMenu workspaceId={workspaceId} userId={userId} inProfile>
      <button
        type="button"
        aria-label={t('people.profile.more')}
        aria-haspopup="menu"
        data-testid="profile-more"
        className="inline-grid size-8 shrink-0 place-items-center rounded-full bg-[var(--color-fill-hover)] text-fg transition-[filter] duration-[var(--motion-fast)] hover:brightness-125 focus-visible:outline-2 focus-visible:outline-accent"
        onClick={(e) => {
          // Radix opens a context menu at the pointer: a synthetic contextmenu under the button.
          const r = e.currentTarget.getBoundingClientRect();
          e.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left, clientY: r.bottom + 4 }));
        }}
      >
        <Ellipsis className="size-4" aria-hidden />
      </button>
    </MemberContextMenu>
  );
}

/**
 * «Роли»: the member's workspace role as a chip (roles are one per member, docs/04). × and + by
 * the same rights as the menu's «Роли ›»: only the owner grants / revokes admin; a guest becomes
 * a member through «Сделать участником». The server re-checks; MEMBER_UPDATE updates the chip.
 */
function RoleChips({ workspaceId, userId, role }: { workspaceId: string; userId: string; role: WorkspaceRole }): ReactNode {
  const a = useMemberActions(workspaceId, userId);
  const label = t(ROLE_KEY[role]);
  const removable = role === WorkspaceRole.ADMIN && a?.roles?.admin === true;
  const options: { key: string; label: string; run: () => void }[] = [];
  if (role === WorkspaceRole.MEMBER && a?.roles?.admin) options.push({ key: 'admin', label: t('role.admin'), run: () => setMemberRole(workspaceId, userId, WorkspaceRole.ADMIN) });
  if (role === WorkspaceRole.GUEST && a?.promote) options.push({ key: 'member', label: t('role.member'), run: () => promoteGuest(workspaceId, userId) });
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line pl-2.5 pr-2.5 text-caption" data-testid="role-chip">
        <span className={cx('size-2.5 shrink-0 rounded-full', roleDot(role))} aria-hidden />
        {label}
        {removable ? (
          <button
            type="button"
            aria-label={t('people.profile.removeRole', { role: label })}
            className="-mr-1 grid size-5 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
            onClick={() => setMemberRole(workspaceId, userId, WorkspaceRole.MEMBER)}
          >
            <X className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </span>
      {options.length > 0 ? (
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger
            aria-label={t('people.profile.addRole')}
            className="grid size-7 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
          >
            <Plus className="size-4" aria-hidden />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className={menuBox} align="start" sideOffset={4} collisionPadding={8}>
              {options.map((o) => (
                <DropdownMenu.Item key={o.key} className={menuItem} onSelect={o.run}>
                  {o.label}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      ) : null}
    </div>
  );
}

const SAVE_LABEL: Partial<Record<NoteSaveState, MessageKey>> = {
  saving: 'people.profile.noteSaving',
  saved: 'people.profile.noteSaved',
  error: 'people.profile.noteFailed',
};

/**
 * «Заметка (видна только вам)»: an inline, auto-growing field; saved 800 ms after the last
 * keystroke and at once on blur / close (noteSaver.ts). Loaded per open (no gateway event: only
 * the author ever sees it).
 */
function NoteEditor({ userId, textareaRef }: { userId: string; textareaRef: RefObject<HTMLTextAreaElement | null> }): ReactNode {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['user-note', userId], queryFn: ({ signal }) => api.users.note(userId, signal), staleTime: 0 });
  const loaded = q.data ? (q.data.note?.text ?? '') : null;
  const [text, setText] = useState<string | null>(null);
  const [state, setState] = useState<NoteSaveState>('idle');
  const saver = useRef<NoteSaver | null>(null);
  if (loaded !== null && text === null) setText(loaded);
  useEffect(() => {
    if (loaded === null || saver.current) return;
    saver.current = createNoteSaver({
      initial: loaded,
      save: async (value) => {
        const r = await api.users.setNote(userId, value);
        qc.setQueryData(['user-note', userId], r);
        return r.note?.text ?? '';
      },
      onState: setState,
    });
  }, [loaded, userId, qc]);
  // Closing the dialog keeps the last keystrokes.
  useEffect(
    () => () => {
      void saver.current?.flush();
      saver.current?.dispose();
    },
    [],
  );
  // Auto-grow: the field is as tall as its text.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text, textareaRef]);
  const status = SAVE_LABEL[state];
  return (
    <Section
      title={t('people.profile.note')}
      aside={
        status ? (
          <span className={cx('font-normal', state === 'error' ? 'text-danger-text' : 'text-faint')} role="status" data-testid="note-status">
            {t(status)}
          </span>
        ) : null
      }
    >
      <textarea
        ref={textareaRef}
        data-testid="profile-note"
        aria-label={t('people.profile.note')}
        rows={1}
        maxLength={NOTE_MAX}
        readOnly={text === null}
        aria-busy={text === null || undefined}
        value={text ?? ''}
        placeholder={t('people.profile.notePlaceholder')}
        className="selectable -ml-1.5 block w-[calc(100%+6px)] resize-none rounded-[6px] bg-transparent px-1.5 py-1 text-body leading-5 text-fg outline-none transition-colors duration-[var(--motion-fast)] placeholder:italic placeholder:text-faint hover:bg-hover focus:bg-hover focus-visible:outline-2 focus-visible:outline-accent"
        onChange={(e) => {
          setText(e.target.value);
          saver.current?.change(e.target.value);
        }}
        onBlur={() => void saver.current?.flush()}
      />
    </Section>
  );
}
