import { create } from 'zustand';

/**
 * The public meeting page of an invited address without an account (ADR-0038 «Диплинки для
 * приглашённых»), web only: `/e/<id>?t=<view token>` (the meeting link of the mail) and
 * `/e/<id>/rsvp?t=<answer token>` (an answer link: applied once on arrival). Shown before any
 * sign-in, whatever the session — the token, not an account, says who answers.
 */
export interface EventPage {
  eventId: string;
  token: string;
  /** An answer link: POST it once, then show the page. */
  answer: boolean;
}

export const useEventPage = create<{ page: EventPage | null }>()(() => ({ page: null }));

const ID = '[0-9a-fA-F-]{36}';

/** Parses a page URL (path + query); null = not the public meeting page. */
export function eventPageOf(pathname: string, search: string): EventPage | null {
  const m = new RegExp(`^/e/(${ID})(/rsvp)?/?$`).exec(pathname);
  const token = new URLSearchParams(search).get('t') ?? '';
  if (!m?.[1] || !token) return null;
  return { eventId: m[1].toLowerCase(), token, answer: !!m[2] };
}

/** At start on the web: a public meeting page in the address bar → shown instead of the app. */
export function takeEventPage(): boolean {
  if (import.meta.env.VITE_PLATFORM !== 'web' || typeof location === 'undefined') return false;
  const page = eventPageOf(location.pathname, location.search);
  if (!page) return false;
  useEventPage.setState({ page });
  return true;
}

/** «Открыть Calab»: leave the page for the app at `/`. */
export function leaveEventPage(): void {
  useEventPage.setState({ page: null });
  try {
    history.replaceState(null, '', '/');
  } catch {
    // not fatal
  }
}
