import { WorkspaceRole } from '@calaba/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/workspaces', () => ({ useWorkspaces: () => undefined }));
import { RoleMark, hasRoleMark, roleTextClass } from './MemberBits';

const mark = (role: WorkspaceRole, extra: Record<string, unknown> = {}): string => renderToStaticMarkup(createElement(RoleMark, { role, ...extra }));

describe('RoleMark (docs/09 #26)', () => {
  it('owner: a crown in the owner colour, tooltip «Владелец»', () => {
    const html = mark(WorkspaceRole.OWNER);
    expect(html).toContain('data-role-mark="owner"');
    expect(html).toContain('lucide-crown');
    expect(html).toContain('title="Владелец"');
    expect(html).toContain('aria-label="Владелец"');
    expect(html).toContain('text-role-owner');
  });

  it('admin: a 14 px shield in the admin colour, tooltip «Администратор»', () => {
    const html = mark(WorkspaceRole.ADMIN);
    expect(html).toContain('data-role-mark="admin"');
    expect(html).toContain('lucide-shield');
    expect(html).toContain('size-3.5');
    expect(html).toContain('title="Администратор"');
    expect(html).toContain('text-role-admin');
  });

  it('members and guests carry no mark', () => {
    expect(mark(WorkspaceRole.MEMBER)).toBe('');
    expect(mark(WorkspaceRole.GUEST)).toBe('');
    expect(mark(WorkspaceRole.UNSPECIFIED)).toBe('');
    expect(hasRoleMark(undefined)).toBe(false);
  });

  it('tones: muted (offline), inherit (selected row), a custom label', () => {
    expect(mark(WorkspaceRole.OWNER, { tone: 'muted' })).toContain('text-muted');
    const inherit = mark(WorkspaceRole.ADMIN, { tone: 'inherit' });
    expect(inherit).not.toContain('text-role-admin');
    expect(mark(WorkspaceRole.OWNER, { label: 'Владелец · Команда' })).toContain('title="Владелец · Команда"');
  });

  it('name colour per role', () => {
    expect(roleTextClass(WorkspaceRole.OWNER)).toBe('text-role-owner');
    expect(roleTextClass(WorkspaceRole.ADMIN)).toBe('text-role-admin');
    expect(roleTextClass(WorkspaceRole.MEMBER)).toBe('text-fg');
    expect(roleTextClass(WorkspaceRole.GUEST)).toBe('text-fg');
    expect(roleTextClass(WorkspaceRole.OWNER, 'muted')).toBe('text-muted');
    expect(roleTextClass(WorkspaceRole.OWNER, 'inherit')).toBe('');
  });
});
