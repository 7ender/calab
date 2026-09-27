import { create } from '@bufbuild/protobuf';
import { WorkspaceRole, WorkspaceSchema, WorkspaceSuspensionSchema } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { isSuspended, suspendedView, suspensionChange } from './moderation';

const ws = (reason?: string) =>
  create(WorkspaceSchema, {
    id: 'w',
    name: 'Team',
    ...(reason === undefined ? {} : { suspension: create(WorkspaceSuspensionSchema, { reason }) }),
  });

describe('suspension view', () => {
  it('is null for an active workspace', () => {
    expect(isSuspended(ws())).toBe(false);
    expect(suspendedView(ws(), WorkspaceRole.OWNER)).toBeNull();
    expect(suspendedView(undefined, WorkspaceRole.OWNER)).toBeNull();
  });

  it('shows the reason and the contact to the owner and admins only', () => {
    expect(isSuspended(ws('unpaid'))).toBe(true);
    expect(suspendedView(ws(' unpaid '), WorkspaceRole.OWNER)).toEqual({
      reason: 'unpaid',
      manager: true,
    });
    expect(suspendedView(ws('unpaid'), WorkspaceRole.ADMIN)).toEqual({
      reason: 'unpaid',
      manager: true,
    });
    expect(suspendedView(ws('unpaid'), WorkspaceRole.MEMBER)).toEqual({
      reason: '',
      manager: false,
    });
    expect(suspendedView(ws(''), WorkspaceRole.GUEST)).toEqual({
      reason: '',
      manager: false,
    });
  });
});

describe('suspensionChange', () => {
  it('needs a reason to suspend and confirms the switch', () => {
    expect(suspensionChange(false, true, '  ')).toEqual({ error: 'reason' });
    expect(suspensionChange(false, true, ' spam ')).toEqual({
      suspended: true,
      reason: 'spam',
      confirm: 'suspend',
    });
  });

  it('updates the reason of a suspended workspace without a confirmation', () => {
    expect(suspensionChange(true, true, 'new')).toEqual({
      suspended: true,
      reason: 'new',
      confirm: null,
    });
  });

  it('resumes with a confirmation and drops the reason', () => {
    expect(suspensionChange(true, false, 'x')).toEqual({
      suspended: false,
      reason: '',
      confirm: 'resume',
    });
    expect(suspensionChange(false, false, 'x')).toEqual({
      suspended: false,
      reason: '',
      confirm: null,
    });
  });

  it('cuts the reason at 500 characters', () => {
    const r = suspensionChange(false, true, 'a'.repeat(600));
    expect('reason' in r && r.reason.length).toBe(500);
  });
});
