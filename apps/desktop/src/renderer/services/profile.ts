import { create } from '@bufbuild/protobuf';
import { MicMode, UserSettingsSchema, type UserSettings } from '@calaba/protocol';
import type { PttBinding } from '../../shared/ipc';
import { api } from '../lib/api/endpoints';
import { log } from '../lib/log';
import { prefs, usePrefs } from '../stores/prefs';
import { platform } from '../platform';
import { useSession } from '../stores/session';

/**
 * UserSettings (synced across the user's devices, USER_UPDATE on change) ↔ local prefs.
 * The server fills defaults for new users (RNNoise on, VAD). push_to_talk_key is
 * client-defined: we store the uiohook binding as JSON.
 */
let applying = false;

/**
 * push_to_talk_key holds one binding per platform: `{"desktop": …, "web": …}` — a desktop
 * uiohook keycode means nothing in a browser and vice versa. A bare binding (older client)
 * is read as the desktop one.
 */
type SyncedBindings = { desktop?: PttBinding; web?: PttBinding };
let synced: SyncedBindings = {};
const mine = (): keyof SyncedBindings => (platform.kind === 'web' ? 'web' : 'desktop');

export function parseBindings(raw: string): SyncedBindings {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as SyncedBindings | PttBinding;
    if ('kind' in v) return { desktop: v };
    return v;
  } catch {
    return {};
  }
}

export function applyUserSettings(s: UserSettings): void {
  applying = true;
  synced = parseBindings(s.pushToTalkKey);
  const own = synced[mine()];
  const fits = own && (platform.kind === 'web' ? own.kind === 'dom' : own.kind !== 'dom');
  const binding: PttBinding | null = fits ? own : prefs().pttBinding;
  usePrefs.getState().setPrefs({
    rnnoise: s.noiseSuppression,
    red: s.unstableNetworkRed,
    micMode: s.micMode === MicMode.PUSH_TO_TALK ? 'ptt' : 'voice',
    pttBinding: binding,
    personalBitrateKbps: s.audioBitrateKbps ?? null,
  });
  applying = false;
}

function snapshot(): UserSettings {
  const p = prefs();
  return create(UserSettingsSchema, {
    noiseSuppression: p.rnnoise,
    unstableNetworkRed: p.red,
    micMode: p.micMode === 'ptt' ? MicMode.PUSH_TO_TALK : MicMode.VAD,
    pushToTalkKey: JSON.stringify({ ...synced, [mine()]: p.pttBinding ?? undefined }),
    ...(p.personalBitrateKbps !== null ? { audioBitrateKbps: p.personalBitrateKbps } : {}),
  });
}

let timer: number | null = null;

function pushNow(): void {
  void api.me.update({ settings: snapshot() }).then(
    (r) => {
      if (r.me) useSession.getState().set({ me: r.me });
    },
    (e: unknown) => log.warn('settings sync failed', e),
  );
}

/** Debounced PATCH /api/me {settings} whenever a synced pref changes locally. */
export function watchSyncedPrefs(): void {
  usePrefs.subscribe((s, p) => {
    if (applying) return;
    if (
      s.rnnoise === p.rnnoise &&
      s.red === p.red &&
      s.micMode === p.micMode &&
      s.pttBinding === p.pttBinding &&
      s.personalBitrateKbps === p.personalBitrateKbps
    ) {
      return;
    }
    if (useSession.getState().status !== 'authed') return;
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      pushNow();
    }, 800);
  });
}
