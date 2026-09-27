import type { WorkspaceMember } from '@calaba/protocol';
import { Pencil } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { IconButton, Input, cx } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { isGuest, useRoleLook, useWorkspaces } from '../../stores/workspaces';
import { peopleError } from './actions';
import { BotBadge, GuestBadge, RoleMark, roleTextClass, roleTextStyle } from './MemberBits';
import { NICK_MAX, createNickEditor, type NickEditState } from './nickEditor';

/**
 * The name cell of a row in «Участники» (docs/09 #26): the name in its role colour + RoleMark
 * (+ «Гость»); with `canEdit` a ✎ on hover / focus and a double click turn it into a field —
 * Enter or blur saves, Esc restores, an error stays under the field (features/people/nickEditor).
 */
export function NickInline({ workspaceId, member: m, canEdit }: { workspaceId: string; member: WorkspaceMember; canEdit: boolean }): ReactNode {
  const u = m.user;
  const userId = u?.id ?? '';
  const name = m.nickname || u?.displayName || '';
  const look = useRoleLook(workspaceId, userId);
  const [state, setState] = useState<NickEditState>({ mode: 'view' });
  const [editor] = useState(() =>
    createNickEditor({
      // Read at the moment of use: the stored nickname may change while the row is open.
      current: () => useWorkspaces.getState().byId[workspaceId]?.members[userId]?.nickname ?? '',
      save: async (nickname) => {
        const r = await api.workspaces.updateMember(workspaceId, userId, { nickname });
        if (r.member) useWorkspaces.getState().upsertMember(r.member);
      },
      errorText: peopleError,
      onState: setState,
    }),
  );
  // Keyboard close (Enter / Esc) returns focus to ✎ — never lost to <body>.
  const pencil = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (state.mode === 'view' && refocus.current) {
      refocus.current = false;
      pencil.current?.focus();
    }
  }, [state.mode]);
  // The right went away while the field was open (role changed): close it.
  useEffect(() => {
    if (!canEdit) editor.cancel();
  }, [canEdit, editor]);
  const errId = useId();

  if (state.mode === 'edit')
    return (
      <div className="min-w-0 flex-1">
        <Input
          autoFocus
          data-testid="nick-input"
          data-own-escape=""
          value={state.value}
          maxLength={NICK_MAX}
          placeholder={u?.displayName ?? ''}
          aria-label={t('people.nick.editOf', { name: u?.displayName ?? name })}
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? errId : undefined}
          readOnly={state.saving}
          enterKeyHint="done"
          className="h-7 text-body"
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => editor.change(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              refocus.current = true;
              void editor.commit('enter');
            } else if (e.key === 'Escape') {
              // The settings window closes on Esc: this Esc only closes the field.
              e.preventDefault();
              e.stopPropagation();
              refocus.current = true;
              editor.cancel();
            }
          }}
          onBlur={() => void editor.commit('blur')}
        />
        {state.error ? (
          <div id={errId} role="alert" className="mt-0.5 truncate text-caption text-danger-text" title={state.error}>
            {state.error}
          </div>
        ) : (
          <div className="mt-0.5 truncate text-caption text-faint">{t('people.nick.inlineHint')}</div>
        )}
      </div>
    );

  return (
    <div className="group/nick flex min-w-0 flex-1 items-center gap-1">
      <span
        className={cx('min-w-0 truncate text-body font-medium', roleTextClass(m.role, 'role', look), canEdit && 'cursor-text')}
        style={roleTextStyle(m.role, 'role', look)}
        title={name}
        data-testid="nick-name"
        onDoubleClick={canEdit ? () => editor.start() : undefined}
      >
        {name}
      </span>
      <RoleMark role={m.role} custom={look} />
      {isGuest(m) ? <GuestBadge /> : null}
      {m.user?.isBot ? <BotBadge /> : null}
      {canEdit ? (
        <IconButton
          ref={pencil}
          label={t('people.nick.editOf', { name: u?.displayName ?? name })}
          size="sm"
          className="shrink-0 text-muted opacity-0 hover:text-fg focus-visible:opacity-100 group-hover/nick:opacity-100 group-focus-within/nick:opacity-100"
          onClick={() => editor.start()}
        >
          <Pencil className="size-3.5" />
        </IconButton>
      ) : null}
    </div>
  );
}
