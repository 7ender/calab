import { create } from '@bufbuild/protobuf';
import { timestampNow } from '@bufbuild/protobuf/wkt';
import { MessageSchema, type FileMeta } from '@calaba/protocol';
import { ApiError } from '../lib/api/client';
import { api, uploadFile, type UploadHandle } from '../lib/api/endpoints';
import { log } from '../lib/log';
import { useMessages, type ChatMessage, type PendingUpload } from '../stores/messages';
import { useRooms } from '../stores/rooms';
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

/** First page of a room (newest 50). */
export async function openRoom(roomId: string): Promise<void> {
  const st = useMessages.getState().rooms[roomId];
  if (st?.loaded || loading.has(roomId)) return;
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
      useMessages.getState().upsert(res.message);
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
    if (r.message) useMessages.getState().upsert(r.message);
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
  sentRead.clear();
  lastTyping.clear();
  for (const t of readTimers.values()) window.clearTimeout(t);
  readTimers.clear();
}
