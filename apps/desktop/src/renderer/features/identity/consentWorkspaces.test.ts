import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { IdentityAccessReason, IdentityPolicyMode, WorkspaceAssuranceSchema, WorkspaceIdentityAccessSchema } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { consentWorkspaceCandidates } from './consentWorkspaces';
import { accessLocked } from './model';

describe('OAuth consent SSO workspace candidates', () => {
  it('keeps an enforced membership selectable for fresh SSO while its read assurance is still valid', () => {
    const now = 1_000_000;
    const membership = create(WorkspaceIdentityAccessSchema, {
      workspaceId: 'enforced-workspace',
      mode: IdentityPolicyMode.ENFORCED,
      reason: IdentityAccessReason.ALLOWED,
      validUntil: timestampFromMs(now + 30_000),
      assurance: create(WorkspaceAssuranceSchema, {
        workspaceId: 'enforced-workspace',
        authenticatedAt: timestampFromMs(now - 15 * 60_000),
        expiresAt: timestampFromMs(now + 45 * 60_000),
      }),
    });

    // This 15-minute-old proof allows reads but is too old for max_age=300 or prompt=login.
    expect(accessLocked(membership, now)).toBe(false);
    expect(consentWorkspaceCandidates([membership], '')).toEqual(['enforced-workspace']);
  });

  it('includes every known membership and the exact session scope without duplicates', () => {
    const memberships = [
      create(WorkspaceIdentityAccessSchema, { workspaceId: 'allowed', reason: IdentityAccessReason.ALLOWED }),
      create(WorkspaceIdentityAccessSchema, { workspaceId: 'needs-sso', reason: IdentityAccessReason.SSO_REQUIRED }),
      create(WorkspaceIdentityAccessSchema, { workspaceId: 'directory-denied', reason: IdentityAccessReason.DIRECTORY_DENIED }),
    ];
    expect(consentWorkspaceCandidates(memberships, 'scoped-only')).toEqual(['allowed', 'needs-sso', 'directory-denied', 'scoped-only']);
    expect(consentWorkspaceCandidates(memberships, 'allowed')).toEqual(['allowed', 'needs-sso', 'directory-denied']);
  });

  it('does not invent candidates when no membership or scoped authority is known', () => {
    expect(consentWorkspaceCandidates([], '')).toEqual([]);
    expect(consentWorkspaceCandidates([], 'exact-scope')).toEqual(['exact-scope']);
    expect(consentWorkspaceCandidates([create(WorkspaceIdentityAccessSchema)], '')).toEqual([]);
  });
});
