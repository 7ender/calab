import type { User } from '@calaba/protocol';
import { Search } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { Modal, Spinner, cx } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { log } from '../../lib/log';
import { startDm } from '../../services/dms';

/**
 * «Новое сообщение» (ADR-0020): search the people I may write to (GET /api/dms/candidates —
 * full members of my workspaces, by name or nickname) and open the DM with one of them
 * (get-or-create). Combobox + listbox: ↑/↓ choose, Enter opens.
 */
export function NewDmDialog({ onClose }: { onClose: () => void }): ReactNode {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ q: string; users: User[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const needle = q.trim();

  useEffect(() => {
    const ctl = new AbortController();
    const timer = window.setTimeout(
      () => {
        api.dms.candidates(needle, ctl.signal).then(
          (r) => {
            setFailed(false);
            setFound({ q: needle, users: r.users });
          },
          (e: unknown) => {
            if (ctl.signal.aborted) return;
            log.warn('dm candidates failed', e);
            setFailed(true);
            setFound({ q: needle, users: [] });
          },
        );
      },
      needle ? 200 : 0,
    );
    return () => {
      window.clearTimeout(timer);
      ctl.abort();
    };
  }, [needle]);

  const users = found?.users ?? [];
  const loading = found === null || found.q !== needle;
  const cur = Math.min(sel, Math.max(0, users.length - 1));

  const choose = async (u: User | undefined): Promise<void> => {
    if (!u || busy) return;
    setBusy(u.id);
    const ok = await startDm(u.id);
    setBusy(null);
    if (ok) onClose();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel(Math.min(users.length - 1, cur + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel(Math.max(0, cur - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void choose(users[cur]);
    }
  };

  return (
    <Modal open onClose={onClose} title={t('dm.newTitle')} description={t('dm.newHint')} initialFocus={input}>
      <div className="flex flex-col gap-2 pb-1" data-testid="new-dm">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" aria-hidden />
          <input
            ref={input}
            type="search"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={onKey}
            maxLength={64}
            role="combobox"
            aria-expanded
            aria-controls="new-dm-list"
            aria-activedescendant={users[cur] ? `new-dm-${users[cur].id}` : undefined}
            aria-label={t('dm.newSearch')}
            placeholder={t('dm.newSearch')}
            className="selectable h-8 w-full min-w-0 rounded-[var(--radius-control)] border border-line bg-elev pl-8 pr-2 text-body text-fg shadow-[var(--shadow-card)] placeholder:text-faint focus-visible:outline-offset-0 [&::-webkit-search-cancel-button]:hidden"
          />
        </div>
        <ul id="new-dm-list" role="listbox" aria-label={t('dm.newTitle')} aria-busy={loading} className="-mx-2 h-[264px] overflow-y-auto">
          {users.length === 0 ? (
            <li role="presentation" className="grid h-full place-items-center px-3 text-center text-body text-muted">
              {loading ? <Spinner /> : failed ? t('dm.newFailed') : t('dm.newEmpty')}
            </li>
          ) : (
            users.map((u, i) => (
              <li
                key={u.id}
                id={`new-dm-${u.id}`}
                role="option"
                aria-selected={i === cur}
                onMouseMove={() => i !== cur && setSel(i)}
                onClick={() => void choose(u)}
                className={cx(
                  'flex h-11 cursor-default items-center gap-2.5 rounded-[var(--radius-row)] px-2 text-body',
                  i === cur ? 'bg-accent-strong text-accent-fg' : 'text-fg',
                )}
              >
                <Avatar userId={u.id} name={u.displayName} fileId={u.avatarFileId || undefined} size={32} presence className={i === cur ? '[&>span:last-child]:border-[var(--color-accent-strong)]' : '[&>span:last-child]:border-[var(--color-popover-solid)]'} />
                <span className="min-w-0 flex-1 truncate font-medium" title={u.displayName}>
                  {u.displayName}
                </span>
                {busy === u.id ? <Spinner className={cx('size-4', i === cur && 'text-accent-fg')} /> : null}
              </li>
            ))
          )}
        </ul>
      </div>
    </Modal>
  );
}
