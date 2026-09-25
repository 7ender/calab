import type { Me } from '@calaba/protocol';
import { create } from 'zustand';
import type { AppInfo, AppSettings, LogoutReason, UpdateStatus } from '../../shared/ipc';
import type { GatewayStatus } from '../lib/gateway/client';

export type AuthStatus = 'booting' | 'anon' | 'authed' | 'offline';

export interface SessionState {
  status: AuthStatus;
  serverUrl: string;
  sessionId: string;
  me: Me | null;
  gateway: GatewayStatus;
  /** Gateway READY received at least once for this login. */
  ready: boolean;
  /** Close 4008 before READY: too many active devices. */
  tooManySessions: boolean;
  loggedOutReason: LogoutReason | null;
  appInfo: AppInfo | null;
  settings: AppSettings | null;
  update: UpdateStatus;
  set: (patch: Partial<SessionState>) => void;
}

export const useSession = create<SessionState>()((set) => ({
  status: 'booting',
  serverUrl: '',
  sessionId: '',
  me: null,
  gateway: 'idle',
  ready: false,
  tooManySessions: false,
  loggedOutReason: null,
  appInfo: null,
  settings: null,
  update: { state: 'disabled' },
  set: (patch) => set(patch),
}));

export const myUserId = (): string => useSession.getState().me?.user?.id ?? '';
