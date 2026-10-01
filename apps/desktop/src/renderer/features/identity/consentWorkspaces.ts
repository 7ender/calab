import type { WorkspaceIdentityAccess } from '@calaba/protocol';

export function consentWorkspaceCandidates(access: readonly WorkspaceIdentityAccess[], scopedWorkspace: string): string[] {
  // Read access can remain ALLOWED while OAuth requires a newer corporate auth_time.
  // Candidates come only from known membership summaries and the current session scope.
  return [...new Set([...access.map((a) => a.workspaceId), scopedWorkspace].filter(Boolean))];
}
