import { RoomType, type DmSummary, type Message, type Room } from '@calaba/protocol';
import { timestampMs } from '@bufbuild/protobuf/wkt';
import { create } from 'zustand';

/**
 * Direct messages (ADR-0020). A DM is a room without a workspace: the room itself lives in
 * stores/rooms.ts (read state, unread / mention counters, notification settings — all shared
 * with workspace rooms), the peer's profile in stores/workspaces.ts `users`. This store keeps
 * what only DMs have: who the peer is, the last activity (list order) and the last message
 * preview shown in the list.
 */
export interface DmEntry {
  roomId: string;
  peerId: string;
  /** Last activity, unix ms: the newest message, else the DM's creation. Sorts the list. */
  activity: number;
}

export interface DmPreview {
  messageId: string;
  authorId: string;
  content: string;
  attachments: number;
  at: number;
}

interface DmsState {
  byRoom: Record<string, DmEntry>;
  /** Newest message per DM (null = known to be empty); absent = not fetched yet. */
  preview: Record<string, DmPreview | null>;
  reset: () => void;
  /** READY: the whole list (replaces it; previews of DMs still there are kept). */
  setAll: (list: DmSummary[]) => void;
  upsert: (dm: DmSummary) => void;
  /** A message in a DM: newest preview + activity (older or equal ids are ignored). */
  onMessage: (m: Message) => void;
  /** An edit / deletion of the previewed message: `null` = deleted (the preview is refetched). */
  onChanged: (roomId: string, messageId: string, m: Message | null) => void;
  setPreview: (roomId: string, m: Message | null) => void;
}

/** The «Личные» pseudo-workspace id in the UI store (Discord's `@me`). Never a real workspace id. */
export const HOME = '@me';

export const isDm = (room: Pick<Room, 'type'> | undefined): boolean => room?.type === RoomType.DM;

const ms = (t: Parameters<typeof timestampMs>[0] | undefined): number => (t ? timestampMs(t) : 0);

function entryOf(dm: DmSummary): DmEntry | null {
  if (!dm.room || !dm.peer) return null;
  return { roomId: dm.room.id, peerId: dm.peer.id, activity: Math.max(ms(dm.lastMessageAt ?? dm.room.lastMessageAt), ms(dm.room.createdAt)) };
}

export function previewOf(m: Message): DmPreview {
  return { messageId: m.id, authorId: m.authorId, content: m.content, attachments: m.attachments.length, at: ms(m.createdAt) };
}

export const useDms = create<DmsState>()((set) => ({
  byRoom: {},
  preview: {},
  reset: () => set({ byRoom: {}, preview: {} }),
  setAll: (list) =>
    set((s) => {
      const byRoom: Record<string, DmEntry> = {};
      for (const dm of list) {
        const e = entryOf(dm);
        if (e) byRoom[e.roomId] = e;
      }
      // A preview older than the DM's newest message is stale (missed while disconnected).
      const preview: Record<string, DmPreview | null> = {};
      for (const dm of list) {
        const id = dm.room?.id;
        const p = id ? s.preview[id] : undefined;
        if (id && p !== undefined && (p?.messageId ?? '') === (dm.room?.lastMessageId ?? '')) preview[id] = p;
      }
      return { byRoom, preview };
    }),
  upsert: (dm) =>
    set((s) => {
      const e = entryOf(dm);
      if (!e) return {};
      const prev = s.byRoom[e.roomId];
      return { byRoom: { ...s.byRoom, [e.roomId]: prev ? { ...e, activity: Math.max(prev.activity, e.activity) } : e } };
    }),
  onMessage: (m) =>
    set((s) => {
      const e = s.byRoom[m.roomId];
      if (!e) return {};
      const cur = s.preview[m.roomId];
      if (cur && cur.messageId >= m.id) return {};
      const p = previewOf(m);
      return {
        byRoom: { ...s.byRoom, [m.roomId]: { ...e, activity: Math.max(e.activity, p.at) } },
        preview: { ...s.preview, [m.roomId]: p },
      };
    }),
  onChanged: (roomId, messageId, m) =>
    set((s) => {
      if (s.preview[roomId]?.messageId !== messageId) return {};
      const preview = { ...s.preview };
      if (m) preview[roomId] = previewOf(m);
      else delete preview[roomId];
      return { preview };
    }),
  setPreview: (roomId, m) => set((s) => ({ preview: { ...s.preview, [roomId]: m ? previewOf(m) : null } })),
}));

/** DMs, most recent activity first (ties: newest room first). */
export function sortedDms(byRoom: Record<string, DmEntry>): DmEntry[] {
  return Object.values(byRoom).sort((a, b) => b.activity - a.activity || b.roomId.localeCompare(a.roomId));
}

/** The DM with this user, if there is one. */
export function dmWith(userId: string): DmEntry | undefined {
  return Object.values(useDms.getState().byRoom).find((e) => e.peerId === userId);
}

/** The peer of a DM room ('' when unknown). */
export function dmPeer(roomId: string): string {
  return useDms.getState().byRoom[roomId]?.peerId ?? '';
}
