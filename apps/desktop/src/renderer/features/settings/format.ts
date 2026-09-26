import type { UpdateStatus } from '../../../shared/ipc';
import { t } from '../../i18n';

/** Human texts for the settings screens (docs/09 #10 of the UX review: no engineering jargon). */

const OS: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

/** `process.platform` / appInfo.platform → «macOS». Unknown values pass through. */
export function osLabel(platform: string | undefined): string {
  if (!platform) return '';
  if (platform === 'web') return t('about.web');
  return OS[platform] ?? platform;
}

/**
 * Session device name from the server («MacBook Pro (darwin)», «Chrome on darwin») → people's
 * words («MacBook Pro · macOS»).
 */
export function deviceLabel(name: string): string {
  const s = name.trim();
  const paren = /^(.*?)\s*\((darwin|win32|linux|macos|windows)\)$/i.exec(s);
  if (paren?.[1]) return `${paren[1]} · ${osLabel(paren[2]?.toLowerCase())}`;
  const on = /^(.*?)\s+on\s+(darwin|win32|linux)$/i.exec(s);
  if (on?.[1]) return `${on[1]} · ${osLabel(on[2]?.toLowerCase())}`;
  return s;
}

export interface CandidatePairLike {
  localType: string;
  remoteType?: string;
  protocol: string;
  relayProtocol?: string | null | undefined;
}

/** ICE candidate pair → how the voice travels, in words. */
export function voicePathLabel(p: CandidatePairLike | null | undefined): string | null {
  if (!p) return null;
  const proto = p.protocol.toUpperCase();
  if (p.localType === 'relay') return t('conn.pathRelay', { p: (p.relayProtocol || proto).toUpperCase() });
  if (p.localType === 'host' && p.remoteType === 'host') return t('conn.pathLan', { p: proto });
  return t('conn.pathDirect', { p: proto });
}

/** The update line in «О программе». `null` → nothing to say (updates are off). */
export function updateLabel(u: UpdateStatus): string | null {
  switch (u.state) {
    case 'disabled':
      return null;
    case 'checking':
      return t('about.updateChecking');
    case 'none':
      return t('about.upToDate');
    case 'available':
      return t('about.updateAvailable', { v: u.version });
    case 'downloaded':
      return t('about.updateDownloaded', { v: u.version });
    case 'error':
      return t('about.updateError');
  }
}

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** «1 дек 2025» — compact date for lists (member since, …). */
export function fmtShortDate(d: Date): string {
  return `${d.getDate()} ${MONTHS[d.getMonth()] ?? ''} ${d.getFullYear()}`;
}
