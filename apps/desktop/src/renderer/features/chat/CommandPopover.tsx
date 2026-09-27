import type { ReactNode } from 'react';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { commandKey, type CommandOption } from '../../lib/botCommands';

/**
 * Bot command hints above the composer field (ADR-0031 §6, docs/08 «Боты»): a row per command —
 * «/cmd — описание · @bot». Focus stays in the field: ↑/↓, Enter/Tab and Esc are the composer's;
 * the mouse picks without blurring it (the same contract as MentionPopover).
 */
export function CommandPopover({
  id,
  options,
  sel,
  onPick,
  onHover,
}: {
  id: string;
  options: CommandOption[];
  sel: number;
  onPick: (o: CommandOption) => void;
  onHover: (i: number) => void;
}): ReactNode {
  return (
    <div
      className="mat-popover dense anim-in absolute bottom-full left-0 z-[var(--z-popover)] mb-2 w-full max-w-[520px] overflow-hidden rounded-[var(--radius-card)]"
      data-testid="bot-command-popover"
    >
      <div className="px-3 pb-1 pt-2 text-micro font-semibold text-muted" aria-hidden>
        {t('bots.commandList')}
      </div>
      <ul id={id} role="listbox" aria-label={t('bots.commandList')} className="max-h-[min(320px,40vh)] overflow-y-auto p-1 pt-0">
        {options.map((o, i) => {
          const active = i === sel;
          const key = commandKey(o);
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
              className={cx('flex h-8 cursor-default items-center gap-2 rounded-[5px] px-2 text-body', active ? 'bg-accent-strong text-accent-fg' : 'text-fg')}
            >
              <span className="shrink-0 font-mono font-medium">/{o.name}</span>
              {o.description ? (
                <span className={cx('min-w-0 truncate', active ? 'text-accent-fg' : 'text-muted')} title={o.description}>
                  — {o.description}
                </span>
              ) : null}
              <span className={cx('ml-auto shrink-0 pl-2 text-caption', active ? 'text-accent-fg' : 'text-muted')}>@{o.username}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
