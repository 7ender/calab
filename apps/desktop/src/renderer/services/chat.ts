import { create } from '@bufbuild/protobuf';
import { timestampNow } from '@bufbuild/protobuf/wkt';
import { MessageSchema, type FileMeta, type Message, type UnfurlResponse } from '@calaba/protocol';
import { ApiError } from '../lib/api/client';
import { api, uploadFile, type UploadHandle } from '../lib/api/endpoints';
import { log } from '../lib/log';
import { useMessages, type ChatMessage, type PendingUpload } from '../stores/messages';
import { idAfter, useRooms } from '../stores/rooms';
import { myUserId } from '../stores/session';
import { toast } from '../stores/toasts';
import { sendTyping } from './gateway';

const PAGE = 50;
export const MAX_ATTACHMENTS = 20;
export const MAX_CONTENT = 4000;

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.is('ERROR_CODE_RATE_LIMITED')) return 'Слишком часто — подождите пару секунд';
    if (e.is('ERROR_CODE_FILE_TOO_LARGE')) return 'Файл слишком большой';
    if (e.is('ERROR_CODE_FILE_QUOTA_EXCEEDED')) return 'Закончилось место в workspace';
    if (e.is('ERROR_CODE_FORBIDDEN')) return 'Недостаточно прав';
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

const loading = new Set<string>();

/**
 * First load of a room. With unread messages it loads a window starting just above the
 * first unread one (the list opens there, docs/09 #39); otherwise the newest page.
 */
export async function openRoom(roomId: string): Promise<void> {
  const st = useMessages.getState().rooms[roomId];
  if (st?.loaded || loading.has(roomId)) return;
  const rooms = useRooms.getState();
  const marker = rooms.readState[roomId];
  if (marker && idAfter(rooms.lastMessage[roomId], marker)) {
    loading.add(roomId);
    useMessages.getState().setLoading(roomId, true);
    try {
      const after = await api.messages.list(roomId, { after: marker, limit: PAGE });
      const first = after.messages[0];
      if (first) {
        const before = await api.messages.list(roomId, { before: first.id, limit: 30 });
        useMessages.getState().setWindow(roomId, [...before.messages].reverse().concat(after.messages), before.hasMore, after.hasMore);
        return;
      }
    } catch (e) {
      log.warn('load unread window failed', e);
    } finally {
      loading.delete(roomId);
    }
  }
  await loadOlder(roomId);
}

/** Cursor pagination upwards (`before` = oldest loaded id). */
export async function loadOlder(roomId: string): Promise<void> {
  if (loading.has(roomId)) return;
  const st = useMessages.getState().rooms[roomId];
  if (st?.loaded && !st.hasMoreBefore) return;
  loading.add(roomId);
  useMessages.getState().setLoading(roomId, true);
  try {
    const oldest = st?.items.find((c) => c.status === 'sent')?.msg.id;
    const res = await api.messages.list(roomId, { ...(oldest ? { before: oldest } : {}), limit: PAGE });
    useMessages.getState().prependPage(roomId, res.messages, res.hasMore);
    const newest = res.messages[0];
    if (!oldest && newest) useRooms.getState().setLastMessage(roomId, newest.id);
  } catch (e) {
    log.warn('load messages failed', e);
    useMessages.getState().setLoading(roomId, false, errText(e));
  } finally {
    loading.delete(roomId);
  }
}

/** Cursor pagination downwards, while the loaded window doesn't reach the newest message. */
export async function loadNewer(roomId: string): Promise<void> {
  const key = `${roomId}:after`;
  if (loading.has(key)) return;
  const st = useMessages.getState().rooms[roomId];
  if (!st?.loaded || !st.hasMoreAfter) return;
  const newest = [...st.items].reverse().find((c) => c.status === 'sent')?.msg.id;
  if (!newest) return;
  loading.add(key);
  try {
    const res = await api.messages.list(roomId, { after: newest, limit: PAGE });
    useMessages.getState().appendPage(roomId, res.messages, res.hasMore);
    if (!res.hasMore) {
      // Events that arrived while the window was detached were skipped: one catch-up page.
      const last = res.messages.at(-1)?.id ?? newest;
      const tail = await api.messages.list(roomId, { after: last, limit: PAGE });
      useMessages.getState().appendPage(roomId, tail.messages, tail.hasMore);
    }
  } catch (e) {
    log.warn('load newer failed', e);
  } finally {
    loading.delete(key);
  }
}

/**
 * Makes sure `messageId` is in the loaded window (search result, reply quote, pin).
 * Returns false if it no longer exists.
 */
export async function ensureLoaded(roomId: string, messageId: string): Promise<boolean> {
  const has = (): boolean => !!useMessages.getState().rooms[roomId]?.items.some((c) => c.key === messageId);
  if (has()) return true;
  try {
    const after = await api.messages.list(roomId, { after: messageId, limit: 25 });
    const first = after.messages[0];
    const before = await api.messages.list(roomId, { ...(first ? { before: first.id } : {}), limit: first ? 26 : PAGE });
    const asc = [...before.messages].reverse().concat(after.messages);
    if (!asc.some((m) => m.id === messageId)) return false;
    useMessages.getState().setWindow(roomId, asc, before.hasMore, after.hasMore);
    return true;
  } catch (e) {
    log.warn('jump failed', e);
    toast.error(`Не удалось загрузить сообщение: ${errText(e)}`);
    return false;
  }
}

/**
 * After a fresh IDENTIFY (server deploy → INVALID_SESSION{resumable:false}) missed events are
 * not replayed: refetch the newest page of every loaded room and merge it in place (no flicker).
 */
export async function resyncLoadedRooms(): Promise<void> {
  const loaded = Object.entries(useMessages.getState().rooms).filter(([, r]) => r.loaded && !r.hasMoreAfter);
  await Promise.all(
    loaded.map(async ([roomId]) => {
      try {
        const res = await api.messages.list(roomId, { limit: PAGE });
        useMessages.getState().resyncLatest(roomId, res.messages, res.hasMore);
      } catch (e) {
        log.warn('resync failed', roomId, e);
      }
    }),
  );
}

/** Back to the newest messages after browsing an older window. */
export async function loadPresent(roomId: string): Promise<void> {
  const st = useMessages.getState().rooms[roomId];
  if (!st?.hasMoreAfter) return;
  try {
    const res = await api.messages.list(roomId, { limit: PAGE });
    useMessages.getState().setWindow(roomId, [...res.messages].reverse(), res.hasMore, false);
  } catch (e) {
    toast.error(`Не удалось загрузить сообщения: ${errText(e)}`);
  }
}

// ---- reactions / pins

export async function toggleReaction(roomId: string, m: Message, emoji: string): Promise<void> {
  const mine = m.reactions.find((r) => r.emoji === emoji)?.me ?? false;
  const add = !mine;
  useMessages.getState().applyReaction(roomId, m.id, emoji, add, true);
  try {
    await (add ? api.messages.addReaction(m.id, emoji) : api.messages.removeReaction(m.id, emoji));
  } catch (e) {
    useMessages.getState().applyReaction(roomId, m.id, emoji, !add, true);
    toast.error(`Не удалось поставить реакцию: ${errText(e)}`);
  }
}

export async function setPinned(m: Message, pin: boolean): Promise<void> {
  try {
    await (pin ? api.messages.pin(m.id) : api.messages.unpin(m.id));
    // MESSAGE_UPDATE brings pinned_at to everyone, including us.
  } catch (e) {
    toast.error(`${pin ? 'Не удалось закрепить' : 'Не удалось открепить'}: ${errText(e)}`);
  }
}

const pinsLoading = new Set<string>();

export async function loadPins(roomId: string): Promise<void> {
  if (pinsLoading.has(roomId)) return;
  pinsLoading.add(roomId);
  try {
    const res = await api.messages.pins(roomId);
    useMessages.getState().setPins(roomId, res.messages);
  } catch (e) {
    log.warn('load pins failed', e);
  } finally {
    pinsLoading.delete(roomId);
  }
}

// ---- link previews: one request per URL per session (the server caches for everyone)

const unfurlCache = new Map<string, Promise<UnfurlResponse | null>>();
const UNFURL_CACHE_MAX = 300;

export function unfurl(url: string): Promise<UnfurlResponse | null> {
  const hit = unfurlCache.get(url);
  if (hit) return hit;
  const p = api.unfurl.get(url).then(
    (r) => (r.title || r.description || r.imageUrl ? r : null),
    () => null,
  );
  unfurlCache.set(url, p);
  if (unfurlCache.size > UNFURL_CACHE_MAX) {
    const oldest = unfurlCache.keys().next().value;
    if (oldest !== undefined) unfurlCache.delete(oldest);
  }
  return p;
}

export interface OutgoingFile {
  file: Blob;
  name: string;
  previewUrl?: string;
}

function newNonce(): string {
  return crypto.randomUUID();
}

/**
 * Optimistic send: shows the message immediately (pending), uploads files
 * with progress, then POSTs with a `nonce` — retries are idempotent on the
 * server (docs/04, "Сообщения: порядок и идемпотентность").
 */
export async function sendMessage(
  workspaceId: string,
  roomId: string,
  content: string,
  files: OutgoingFile[],
  replyToId: string | undefined,
  nonce = newNonce(),
): Promise<void> {
  const key = `local:${nonce}`;
  const uploads: PendingUpload[] = files.map((f, i) => ({
    key: `${nonce}:${i}`,
    name: f.name,
    size: f.file.size,
    progress: 0,
    ...(f.previewUrl ? { previewUrl: f.previewUrl } : {}),
  }));
  const msg = create(MessageSchema, {
    id: '',
    roomId,
    authorId: myUserId(),
    content,
    nonce,
    replyToId: replyToId ?? '',
    createdAt: timestampNow(),
  });
  const existing = useMessages.getState().rooms[roomId]?.items.find((c) => c.key === key);
  if (existing) useMessages.getState().patchPending(roomId, key, { status: 'pending', uploads, error: '' });
  else useMessages.getState().addPending(roomId, { key, msg, status: 'pending', uploads } satisfies ChatMessage);

  try {
    const metas: FileMeta[] = [];
    const handles: UploadHandle[] = [];
    for (const [i, f] of files.entries()) {
      const h = uploadFile(workspaceId, f.file, f.name, (p) => {
        const cur = useMessages.getState().rooms[roomId]?.items.find((c) => c.key === key);
        if (!cur?.uploads) return;
        useMessages.getState().patchPending(roomId, key, {
          uploads: cur.uploads.map((u, j) => (j === i ? { ...u, progress: p } : u)),
        });
      });
      handles.push(h);
      metas.push(await h.promise);
    }
    const res = await api.messages.create(roomId, {
      content,
      attachmentIds: metas.map((m) => m.id),
      replyToId: replyToId ?? '',
      nonce,
    });
    if (res.message) {
      useMessages.getState().upsert(res.message, { rest: true, delivered: false });
      useRooms.getState().setLastMessage(roomId, res.message.id);
      useRooms.getState().setRead(roomId, res.message.id);
    }
  } catch (e) {
    log.warn('send failed', e);
    useMessages.getState().patchPending(roomId, key, { status: 'failed', error: errText(e) });
  }
}

/** Retry keeps the same nonce, so the server never creates a duplicate. */
export function retrySend(workspaceId: string, roomId: string, c: ChatMessage, files: OutgoingFile[] = []): Promise<void> {
  return sendMessage(workspaceId, roomId, c.msg.content, files, c.msg.replyToId || undefined, c.msg.nonce);
}

export async function editMessage(id: string, content: string): Promise<void> {
  try {
    const r = await api.messages.update(id, content);
    if (r.message) useMessages.getState().upsert(r.message, { rest: true });
  } catch (e) {
    toast.error(`Не удалось изменить: ${errText(e)}`);
  }
}

export async function deleteMessage(roomId: string, id: string): Promise<void> {
  try {
    await api.messages.remove(id);
    useMessages.getState().remove(roomId, id);
  } catch (e) {
    toast.error(`Не удалось удалить: ${errText(e)}`);
  }
}

// ---- read state: move the marker forward when the newest message is on screen ----

const readTimers = new Map<string, number>();
const sentRead = new Map<string, string>();

export function markRead(roomId: string, messageId: string): void {
  if (!messageId || messageId.startsWith('local:')) return;
  useRooms.getState().setRead(roomId, messageId);
  if ((sentRead.get(roomId) ?? '') >= messageId) return;
  const t = readTimers.get(roomId);
  if (t) window.clearTimeout(t);
  readTimers.set(
    roomId,
    window.setTimeout(() => {
      readTimers.delete(roomId);
      sentRead.set(roomId, messageId);
      void api.messages.markRead(roomId, messageId).catch((e: unknown) => log.warn('mark read failed', e));
    }, 600),
  );
}

// ---- typing: at most one TYPING per 3 s per room (server rate limit 1/3 s) ----

const lastTyping = new Map<string, number>();

export function notifyTyping(roomId: string): void {
  const now = Date.now();
  if (now - (lastTyping.get(roomId) ?? 0) < 3000) return;
  lastTyping.set(roomId, now);
  sendTyping(roomId);
}

export function resetChatCaches(): void {
  loading.clear();
  pinsLoading.clear();
  unfurlCache.clear();
  sentRead.clear();
  lastTyping.clear();
  for (const t of readTimers.values()) window.clearTimeout(t);
  readTimers.clear();
}
