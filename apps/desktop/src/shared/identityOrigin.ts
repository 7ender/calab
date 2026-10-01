/** Only these first-party endpoints require the saved server Origin in the desktop proxy. */
export function identityOriginPath(path: string): boolean {
  return (
    /^\/api\/auth\/(?:local\/reauth|sso\/(?:finish|exchange|workspaces\/[^/]+\/(?:begin|refresh|logout|recover)))$/.test(path) ||
    /^\/api\/workspaces\/[^/]+\/(?:identity(?:\/(?:connection|test|policy|link|recovery-kit|connections\/[^/]+\/activate|directory(?:\/(?:test|sync|members(?:\/[^/]+)?))?))?|oauth\/clients(?:\/[^/]+(?:\/rotate-secret)?)?)$/.test(
      path,
    ) ||
    /^\/api\/(?:oauth\/requests\/[^/]+\/(?:bind|decision)|me\/oauth-grants(?:\/[^/]+)?)$/.test(path)
  );
}
