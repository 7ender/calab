import { t } from '../../i18n';

/** The server's slug rules (workspaces.ValidateSlug) as a message, or null when the address is fine. */
export function slugError(s: string): string | null {
  if (s.length < 3 || s.length > 32 || !/^[a-z0-9-]+$/.test(s) || s.startsWith('-') || s.endsWith('-') || s.includes('--')) return t('ws.slugInvalid');
  return null;
}
