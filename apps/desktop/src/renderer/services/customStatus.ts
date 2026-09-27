import { t, type MessageKey } from '../i18n';
import { ApiError } from '../lib/api/client';
import { api } from '../lib/api/endpoints';
import { usePrefs } from '../stores/prefs';
import { useSession } from '../stores/session';
import { toast } from '../stores/toasts';
import { useWorkspaces } from '../stores/workspaces';
import { clearAfterSeconds, type ClearAfter } from './presenceTimer';

/**
 * «Свой статус» section of the status menu (docs/09 #29): one-click presets and my last custom
 * statuses. A choice = emoji + text + when it clears (server-side expiry, `clearAfterSeconds`).
 */
export interface StatusChoice {
  emoji: string;
  text: string;
  after: ClearAfter;
}

export interface StatusPreset {
  id: string;
  emoji: string;
  key: MessageKey;
  after: ClearAfter;
}

export const STATUS_PRESETS: readonly StatusPreset[] = [
  { id: 'meeting', emoji: '📅', key: 'presence.presetMeeting', after: '1h' },
  { id: 'lunch', emoji: '🍽️', key: 'presence.presetLunch', after: '1h' },
  { id: 'focus', emoji: '🎧', key: 'presence.presetFocus', after: 'today' },
  { id: 'vacation', emoji: '🌴', key: 'presence.presetVacation', after: 'never' },
];

/** Short «how long» next to a preset / recent row: «1 ч», «до конца дня», «без срока». */
export const AFTER_SHORT: Record<ClearAfter, MessageKey> = {
  never: 'presence.durNever',
  '30m': 'presence.dur30m',
  '1h': 'presence.dur1h',
  '4h': 'presence.dur4h',
  today: 'presence.durToday',
};

export const RECENT_STATUSES_MAX = 3;

const same = (a: { emoji: string; text: string }, b: { emoji: string; text: string }): boolean => a.emoji === b.emoji && a.text.trim() === b.text.trim();

/**
 * My recent custom statuses after `choice` was set: newest first, no duplicates (emoji + text),
 * at most 3. Presets are always in the menu, so they are not remembered; nor is an empty status.
 */
export function pushRecentStatus(list: readonly StatusChoice[], choice: StatusChoice, presets: ReadonlyArray<{ emoji: string; text: string }>): StatusChoice[] {
  const text = choice.text.trim();
  if (!text) return [...list];
  const c = { ...choice, text };
  if (presets.some((p) => same(p, c))) return [...list];
  return [c, ...list.filter((r) => !same(r, c))].slice(0, RECENT_STATUSES_MAX);
}

/** PATCH /api/me/status (text + emoji + expiry); older servers only know PATCH /api/me {statusText}. */
export async function saveCustomStatus(s: { text: string; emoji: string; expiresInSeconds: number }): Promise<boolean> {
  try {
    const r = await api.me.setStatus(s).catch((e: unknown) => {
      if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return api.me.update({ statusText: s.text });
      throw e;
    });
    if (r.me) {
      useSession.getState().set({ me: r.me });
      // My own card in the member list / profile / header reads `users[me]`, not the session.
      if (r.me.user) useWorkspaces.getState().upsertUser(r.me.user);
    }
    return true;
  } catch (e) {
    toast.fail(e, t('err.ctx.save'));
    return false;
  }
}

/**
 * Sets my custom status (a preset, a recent one or the editor's): the server clears it after
 * `after`; a set status goes to the top of «Недавние» (presets and an empty text are not kept).
 */
export async function applyCustomStatus(c: StatusChoice, now: Date = new Date()): Promise<boolean> {
  const text = c.text.trim();
  const ok = await saveCustomStatus({ text, emoji: text ? c.emoji : '', expiresInSeconds: text ? clearAfterSeconds(c.after, now) : 0 });
  if (ok && text) {
    const presets = STATUS_PRESETS.map((p) => ({ emoji: p.emoji, text: t(p.key) }));
    const { recentStatuses, setPrefs } = usePrefs.getState();
    setPrefs({ recentStatuses: pushRecentStatus(recentStatuses, { emoji: c.emoji, text, after: c.after }, presets) });
  }
  return ok;
}
