import { create } from '@bufbuild/protobuf';
import { timestampNow } from '@bufbuild/protobuf/wkt';
import { MessageSchema, type DispatchEvent, type Sticker, type StickerPack } from '@calaba/protocol';
import { t } from '../i18n';
import { api } from '../lib/api/endpoints';
import { log } from '../lib/log';
import { useMessages } from '../stores/messages';
import { useRooms } from '../stores/rooms';
import { myUserId } from '../stores/session';
import { useStickers } from '../stores/stickers';
import { toast } from '../stores/toasts';
import { reportPlanError } from './plan';

/**
 * Sticker packs on the client (ADR-0030): loading my packs, installs, sending a sticker
 * message and applying STICKER_PACK_* events.
 */

let loading: Promise<void> | null = null;

/** GET /api/me/sticker-packs once per session (again with `force`, e.g. after a new pack). */
export function loadMyStickers(force = false): Promise<void> {
  if (useStickers.getState().loaded && !force) return Promise.resolve();
  loading ??= api.stickers
    .mine()
    .then((r) => useStickers.getState().setMine(r))
    .catch((e: unknown) => log.warn('sticker packs', e))
    .finally(() => {
      loading = null;
    });
  return loading;
}

export async function loadWorkspaceStickers(workspaceId: string): Promise<void> {
  try {
    const r = await api.stickers.list(workspaceId);
    useStickers.getState().setWorkspace(workspaceId, r.packs);
  } catch (e) {
    toast.fail(e);
  }
}

export async function installPack(p: Pick<StickerPack, 'id' | 'name'>): Promise<boolean> {
  try {
    useStickers.getState().setMine(await api.stickers.install(p.id));
    toast.success(t('stk.added', { name: p.name }));
    return true;
  } catch (e) {
    toast.fail(e);
    return false;
  }
}

export async function uninstallPack(packId: string): Promise<void> {
  try {
    useStickers.getState().setMine(await api.stickers.uninstall(packId));
  } catch (e) {
    toast.fail(e);
  }
}

export async function orderPacks(packIds: readonly string[]): Promise<void> {
  const s = useStickers.getState();
  const byId = new Map(s.installed.map((p) => [p.id, p]));
  // Optimistic: the list moves at once; the server's answer replaces it.
  s.setMine({ installed: packIds.map((id) => byId.get(id)).filter((p): p is StickerPack => !!p), available: s.available });
  try {
    useStickers.getState().setMine(await api.stickers.order(packIds));
  } catch (e) {
    toast.fail(e);
    void loadMyStickers(true);
  }
}

/** Sends a sticker message (optimistic like text; a retry keeps the nonce). */
export async function sendSticker(workspaceId: string, roomId: string, sticker: Sticker, replyToId: string | undefined, nonce = newNonce()): Promise<void> {
  useStickers.getState().pushRecent(sticker.id);
  const key = `local:${nonce}`;
  const msg = create(MessageSchema, {
    id: '',
    roomId,
    authorId: myUserId(),
    content: '',
    nonce,
    replyToId: replyToId ?? '',
    createdAt: timestampNow(),
    sticker,
  });
  const existing = useMessages.getState().rooms[roomId]?.items.find((c) => c.key === key);
  if (existing) useMessages.getState().patchPending(roomId, key, { status: 'pending', error: '' });
  else useMessages.getState().addPending(roomId, { key, msg, status: 'pending' });
  try {
    const res = await api.messages.create(roomId, { stickerId: sticker.id, replyToId: replyToId ?? '', nonce });
    if (res.message) {
      useMessages.getState().upsert(res.message, { rest: true, delivered: false });
      useRooms.getState().setLastMessage(roomId, res.message.id);
      useRooms.getState().setRead(roomId, res.message.id);
    }
  } catch (e) {
    log.warn('sticker send failed', e);
    useMessages.getState().patchPending(roomId, key, { status: 'failed', error: e instanceof Error ? e.message : String(e) });
    reportPlanError(e, workspaceId);
  }
}

function newNonce(): string {
  return crypto.randomUUID();
}

let refetch: ReturnType<typeof setTimeout> | null = null;

/** STICKER_PACK_CREATE / UPDATE / DELETE (to every member of the pack's workspace). */
export function applyStickerEvent(e: DispatchEvent['event']): void {
  const s = useStickers.getState();
  switch (e.case) {
    case 'stickerPackCreate':
      if (e.value.pack) s.upsert(e.value.pack);
      // A new pack shows up under «available» (or installed, for its creator): ask the server.
      if (s.loaded) {
        if (refetch) clearTimeout(refetch);
        refetch = setTimeout(() => {
          refetch = null;
          void loadMyStickers(true);
        }, 300);
      }
      return;
    case 'stickerPackUpdate':
      if (e.value.pack) s.upsert(e.value.pack);
      return;
    case 'stickerPackDelete':
      s.removePack(e.value.workspaceId, e.value.packId);
      return;
    default:
      return;
  }
}
