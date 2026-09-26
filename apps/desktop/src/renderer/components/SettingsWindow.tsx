import * as DialogP from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import type { LucideIcon } from 'lucide-react';
import { X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { cx } from './ui';

export interface SettingsSection {
  id: string;
  label: string;
  icon: LucideIcon;
  content: ReactNode;
  /** Red label (e.g. «Удалить пространство»). */
  destructive?: boolean;
}

/**
 * System-Settings-like window (docs/08, «UX-правила»): list of sections with icons on
 * the left (sidebar material), the selected section on the right as card groups.
 */
export function SettingsWindow({
  title,
  sections,
  initial,
  onClose,
  footer,
}: {
  title: string;
  sections: SettingsSection[];
  initial?: string | undefined;
  onClose: () => void;
  /** Extra items under the section list (e.g. «Выйти»). */
  footer?: ReactNode;
}): ReactNode {
  const [value, setValue] = useState(initial && sections.some((s) => s.id === initial) ? initial : (sections[0]?.id ?? ''));
  const current = sections.find((s) => s.id === value);
  return (
    <DialogP.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogP.Portal>
        <DialogP.Overlay className="fixed inset-0 z-[var(--z-modal)] bg-scrim" />
        <DialogP.Content aria-modal="true"
          aria-describedby={undefined}
          className="mat-sheet anim-in fixed left-1/2 top-1/2 z-[var(--z-modal)] flex h-[min(640px,calc(100vh-48px))] w-[min(880px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[var(--radius-panel)] focus:outline-none"
        >
          <Tabs.Root value={value} onValueChange={setValue} orientation="vertical" className="flex min-w-0 flex-1">
            <div className="mat-sidebar flex w-[220px] shrink-0 flex-col border-r border-line p-2">
              <DialogP.Title className="truncate px-2 pb-2 pt-2 text-[13px] font-semibold text-muted">{title}</DialogP.Title>
              <Tabs.List aria-label={title} className="flex flex-col gap-px">
                {sections.map((s) => (
                  <Tabs.Trigger
                    key={s.id}
                    value={s.id}
                    className={cx(
                      'flex h-8 items-center gap-2.5 rounded-[var(--radius-control)] px-2 text-left text-[13px]',
                      'data-[state=active]:bg-accent-strong data-[state=active]:text-accent-fg hover:bg-hover data-[state=active]:hover:bg-accent-strong',
                      s.destructive ? 'text-danger-text' : 'text-fg',
                    )}
                  >
                    <s.icon className="size-4 shrink-0" aria-hidden />
                    <span className="min-w-0 truncate">{s.label}</span>
                  </Tabs.Trigger>
                ))}
              </Tabs.List>
              {footer ? <div className="mt-auto flex flex-col gap-px border-t border-line pt-2">{footer}</div> : null}
            </div>
            <div className="mat-content flex min-w-0 flex-1 flex-col">
              <div className="flex h-12 shrink-0 items-center justify-between border-b border-line px-5">
                <h2 className="truncate text-[16px] font-semibold">{current?.label}</h2>
                <DialogP.Close className="grid size-7 place-items-center rounded-[var(--radius-control)] text-muted hover:bg-hover hover:text-fg" aria-label="Закрыть">
                  <X className="size-4" />
                </DialogP.Close>
              </div>
              {sections.map((s) => (
                <Tabs.Content key={s.id} value={s.id} className="min-h-0 flex-1 overflow-y-auto px-5 py-5 focus-visible:-outline-offset-2">
                  <div className="flex flex-col gap-6">{s.content}</div>
                </Tabs.Content>
              ))}
            </div>
          </Tabs.Root>
        </DialogP.Content>
      </DialogP.Portal>
    </DialogP.Root>
  );
}

/** Sidebar footer item (not a section), e.g. «Выйти». */
export function SettingsAction({ label, icon: Icon, onClick, destructive }: { label: string; icon: LucideIcon; onClick: () => void; destructive?: boolean }): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx('flex h-8 items-center gap-2.5 rounded-[var(--radius-control)] px-2 text-left text-[13px] hover:bg-hover', destructive ? 'text-danger-text' : 'text-fg')}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      {label}
    </button>
  );
}
