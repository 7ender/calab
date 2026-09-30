/** The member's app from Presence.client_* (docs/09 #143): «Calab 1.1.0 · macOS», web → «Calab 1.1.0» + a `web` tag. */

const OS: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

export interface ClientLabel {
  /** «Calab 1.1.0 · macOS», «Calab 1.1.0» (web), «Calab · Windows» (version unknown). */
  text: string;
  /** Show the `web` tag after the text. */
  web: boolean;
}

/** Nothing when both are unknown; an unknown platform is left out. */
export function clientLabel(platform: string | undefined, version: string | undefined): ClientLabel | null {
  const v = version?.trim() ?? '';
  const os = platform ? OS[platform] : undefined;
  const web = platform === 'web';
  if (!v && !os && !web) return null;
  const app = v ? `Calab ${v}` : 'Calab';
  return { text: os ? `${app} · ${os}` : app, web };
}
