import { create } from 'zustand';
import { idAfter } from './rooms';

/**
 * Read receipts (docs/09 #92): per room, how far the others read — in a DM the peer, in a
 * workspace room the furthest other member (READY.peer_reads, DmSummary.peer_read_message_id,
 * READ_RECEIPT). Apart from stores/rooms.ts so a receipt wakes only the ticks it flips
 * (`useReadReceipt` selects a boolean per message), not room lists or the feed.
 */
interface ReadReceiptsState {
  byRoom: Record<string, string>;
  /** Keeps the maximum (uuidv7 ids order like messages): a stale event never un-reads. */
  set: (roomId: string, messageId: string) => void;
  reset: () => void;
}

export const useReadReceipts = create<ReadReceiptsState>()((set) => ({
  byRoom: {},
  set: (roomId, messageId) => set((s) => (idAfter(messageId, s.byRoom[roomId]) ? { byRoom: { ...s.byRoom, [roomId]: messageId } } : s)),
  reset: () => set({ byRoom: {} }),
}));

/** Whether someone else read `messageId` of `roomId` (a leaf subscription: a boolean). */
export const useReadReceipt = (roomId: string, messageId: string): boolean =>
  useReadReceipts((s) => {
    const upTo = s.byRoom[roomId];
    return upTo !== undefined && !idAfter(messageId, upTo);
  });
