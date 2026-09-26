import type { DmSummary } from '@calaba/protocol';
import { t } from '../i18n';
import { ApiError } from '../lib/api/client';
import { api } from '../lib/api/endpoints';
import { log } from '../lib/log';
import { HOME, dmWith, useDms } from '../stores/dms';
import { useMessages } from '../stores/messages';
import { useRooms } from '../stores/rooms';
import { toast } from '../stores/toasts';
import { useUi } from '../stores/ui';
import { useWorkspaces } from '../stores/workspaces';

/**
 * Direct messages (ADR-0020, docs/05 «Личные сообщения»): the DM room goes into the rooms store
 * like any room (messages, read state, counters, notification settings use the room code), the
 * peer's profile into the users map, the DM itself into stores/dms.ts.
 */
export function applyDm(dm: DmSummary, withReadState: boolean): void {
  const room = dm.room;
  if (!room || !dm.peer) return;
  const rooms = useRooms.getState();
  rooms.upsert(room);
  if (room.lastMessageId) rooms.setLastMessage(room.id, room.lastMessageId);
  // The peer's profile: only when we don't share a workspace (a member entry is fresher then).
  useWorkspaces.getState().upsertUser(dm.peer);
  if (withReadState && dm.readState) {
    rooms.setRead(room.id, dm.readState.lastReadMessageId);
    rooms.setCounts(room.id, dm.readState.unreadCount, dm.readState.mentionCount);
  }
  useDms.getState().upsert(dm);
}

/** Opens the DM in the «Личные» view. */
export function openDm(roomId: string): void {
  useUi.getState().openRoom(HOME, roomId);
}

/**
 * «Написать»: opens the DM with the user, creating it first when needed (POST /api/dms is
 * get-or-create; the new DM also arrives as DM_CREATE, applying it twice is harmless).
 */
export async function startDm(userId: string): Promise<boolean> {
  const known = dmWith(userId);
  if (known) {
    openDm(known.roomId);
    return true;
  }
  try {
    const res = await api.dms.create(userId);
    if (!res.dm?.room) return false;
    applyDm(res.dm, true);
    openDm(res.dm.room.id);
    return true;
  } catch (e) {
    log.warn('create dm failed', e);
    toast.error(dmErrorText(e));
    return false;
  }
}

export function dmErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 429) return t('dm.errRateLimited');
    if (e.status === 403) return t('dm.errGuest');
    if (e.status === 404) return t('dm.errNoCommon');
    if (e.status === 422) return t('dm.errSelf');
  }
  return t('dm.errCreate');
}

let refreshing: Promise<void> | null = null;

/** GET /api/dms: re-reads the list (a DM seen only through its messages). */
export function refreshDms(): Promise<void> {
  refreshing ??= api.dms
    .list()
    .then((res) => {
      for (const dm of res.dms) if (!useRooms.getState().byId[dm.room?.id ?? '']) applyDm(dm, true);
    })
    .catch((e: unknown) => log.warn('list dms failed', e))
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

const previewLoading = new Set<string>();
/** Previews fetched at once when the list opens (the rest are known from live messages or wait). */
const PREVIEW_BATCH = 40;

/**
 * The last message of each listed DM (READY only has its id): taken from the loaded chat when
 * there is one, else fetched (GET /api/rooms/{id}/messages?limit=1) — the newest DMs first,
 * a few at a time.
 */
export async function loadDmPreviews(roomIds: string[]): Promise<void> {
  const st = useDms.getState();
  const todo: string[] = [];
  for (const id of roomIds.slice(0, PREVIEW_BATCH)) {
    if (st.preview[id] !== undefined || previewLoading.has(id)) continue;
    const loaded = useMessages.getState().rooms[id];
    const newest = loaded?.loaded && !loaded.hasMoreAfter ? [...loaded.items].reverse().find((c) => c.status === 'sent')?.msg : undefined;
    if (newest) {
      useDms.getState().setPreview(id, newest);
      continue;
    }
    if (!useRooms.getState().lastMessage[id]) {
      useDms.getState().setPreview(id, null);
      continue;
    }
    todo.push(id);
  }
  const worker = async (): Promise<void> => {
    for (let id = todo.shift(); id; id = todo.shift()) {
      previewLoading.add(id);
      try {
        const res = await api.messages.list(id, { limit: 1 });
        // A live message may have landed meanwhile: onMessage keeps the newer one.
        const m = res.messages[0];
        if (useDms.getState().preview[id] === undefined) useDms.getState().setPreview(id, m ?? null);
      } catch (e) {
        log.warn('dm preview failed', id, e);
      } finally {
        previewLoading.delete(id);
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

export function resetDmCaches(): void {
  previewLoading.clear();
}
