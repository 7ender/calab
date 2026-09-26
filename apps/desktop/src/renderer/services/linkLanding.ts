import { create } from 'zustand';
import { handleDeepLink, parseInviteCode, parseRoomInviteCode } from './links';

/**
 * Web link page (docs/09 #53): `https://<server>/join/<code>` and `/r/<code>` first show a card —
 * «Открыть в Calab» / «Продолжить в браузере» / «Скачать приложение» — instead of jumping straight
 * into the web flow. Web only: the desktop app handles `calab://` and pasted https links directly.
 */
export interface LinkLanding {
  kind: 'join' | 'r';
  code: string;
  /** The link as the app flow takes it (`handleDeepLink`). */
  url: string;
}

interface LinkLandingState {
  link: LinkLanding | null;
}

export const useLinkLanding = create<LinkLandingState>()(() => ({ link: null }));

export function landingFor(url: string): LinkLanding | null {
  const room = parseRoomInviteCode(url);
  if (room) return { kind: 'r', code: room, url };
  // Bare codes are not links: the landing is for /join/<code> URLs only.
  const code = /\/join\//.test(url) ? parseInviteCode(url) : null;
  return code ? { kind: 'join', code, url } : null;
}

/** Shows the card for a web link; false = not a link (the caller handles it as before). */
export function showLinkLanding(url: string): boolean {
  const link = landingFor(url);
  if (!link) return false;
  useLinkLanding.setState({ link });
  return true;
}

/** «Продолжить в браузере»: the regular web flow (login / guest screen / join dialog). */
export function continueInBrowser(): void {
  const link = useLinkLanding.getState().link;
  if (!link) return;
  useLinkLanding.setState({ link: null });
  // The address bar keeps /join/<code> while the card is shown (a reload shows it again).
  try {
    history.replaceState(null, '', '/');
  } catch {
    // not fatal
  }
  handleDeepLink(link.url);
}

/** «Всегда открывать в приложении» — a per-browser convenience, so localStorage. */
const ALWAYS_APP_KEY = 'calab-open-links-in-app';

export function alwaysOpenInApp(): boolean {
  try {
    return localStorage.getItem(ALWAYS_APP_KEY) === '1';
  } catch {
    return false;
  }
}

export function setAlwaysOpenInApp(on: boolean): void {
  try {
    if (on) localStorage.setItem(ALWAYS_APP_KEY, '1');
    else localStorage.removeItem(ALWAYS_APP_KEY);
  } catch {
    // storage blocked: the option just does not stick
  }
}
