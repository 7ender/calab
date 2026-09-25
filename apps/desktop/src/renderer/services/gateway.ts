import { PresenceStatus } from '@calaba/protocol';
import { prefs } from '../stores/prefs';
import { GatewayClient, gatewayUrl } from '../lib/gateway/client';
import { log } from '../lib/log';
import { useSession } from '../stores/session';
import { applyDispatch } from './dispatch';

let client: GatewayClient | null = null;
/** Rooms we want typing/read-state for (SUBSCRIBE replaces the set; resent after READY/RESUMED). */
let subscribed: string[] = [];

export function startGateway(onFatal: (kind: 'auth' | 'revoked' | 'too-many-sessions') => void): void {
  stopGateway();
  const s = useSession.getState();
  const info = s.appInfo;
  client = new GatewayClient({
    url: () => gatewayUrl(useSession.getState().serverUrl),
    getToken: () => window.calaba.auth.accessToken(),
    refreshToken: () => window.calaba.auth.forceRefresh(),
    device: { name: info?.hostname ?? 'desktop', platform: info?.platform ?? '', appVersion: info?.version ?? '' },
    createSocket: (url) => new WebSocket(url),
    onDispatch: (ev) => {
      try {
        applyDispatch(ev);
        if (ev.event.case === 'ready' || ev.event.case === 'resumed') {
          if (subscribed.length) client?.subscribe(subscribed);
          const presence = prefs().presence;
          if (presence !== PresenceStatus.ONLINE) client?.setPresence(presence);
        }
      } catch (e) {
        log.error('dispatch failed', ev.event.case, e);
      }
    },
    onStatus: (gateway) => useSession.getState().set({ gateway }),
    onFatal,
    log: (m) => log.info(m),
  });
  client.start();
}

export function stopGateway(): void {
  client?.stop();
  client = null;
}

export function reconnectGateway(): void {
  client?.forceReconnect();
}

/** Fine-grained subscription (docs/05, SUBSCRIBE): the server sends TYPING_START only for these rooms. */
export function subscribeRooms(roomIds: string[]): void {
  subscribed = roomIds;
  client?.subscribe(roomIds);
}

export function sendTyping(roomId: string): void {
  client?.sendTyping(roomId);
}

export function setPresence(status: PresenceStatus): void {
  client?.setPresence(status);
}
