import { platform } from '../platform';
import { badgeCount, useRooms } from '../stores/rooms';

let started = false;
let shown = -1;

/**
 * The app badge (docs/09 item 22): Dock / taskbar / tray and the window title show mentions of
 * me + unread DM messages (stores/rooms.ts badgeCount), not every unread message. Recomputed on
 * every rooms-store change; reading a room clears its share.
 */
export function startAppBadge(): void {
  if (started) return;
  started = true;
  const apply = (): void => {
    const n = badgeCount(useRooms.getState());
    if (n === shown) return;
    shown = n;
    platform.app.setBadge(n);
    document.title = n > 0 ? `(${n > 99 ? '99+' : n}) Calab` : 'Calab';
  };
  apply();
  useRooms.subscribe(apply);
}
