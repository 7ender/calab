import { WorkspaceRole, type Sticker, type StickerPack } from '@calaba/protocol';
import { t } from '../i18n';

/**
 * Sticker packs (ADR-0030): pure helpers — where a pack may be used, search by emoji, previews.
 * The server decides (CreateMessageRequest.sticker_id); these only shape the picker.
 */

/** Where the composer is: a workspace room, or a DM with `peerId`. */
export type StickerPlace = { workspaceId: string } | { dmPeerId: string };

/** Built-in role of a user per workspace (from the workspace store). */
export type RoleOf = (workspaceId: string, userId: string) => WorkspaceRole | undefined;

const full = (r: WorkspaceRole | undefined): boolean => r !== undefined && r !== WorkspaceRole.UNSPECIFIED && r !== WorkspaceRole.GUEST;

/**
 * A pack is usable in a room of its workspace by a non-guest member, and in a DM when both
 * participants are non-guest members of the pack's workspace (docs/04 «Стикеры»).
 */
export function packUsable(pack: Pick<StickerPack, 'workspaceId'>, place: StickerPlace, me: string, roleOf: RoleOf): boolean {
  if (!full(roleOf(pack.workspaceId, me))) return false;
  if ('workspaceId' in place) return place.workspaceId === pack.workspaceId;
  return full(roleOf(pack.workspaceId, place.dmPeerId));
}

/** Variation selectors and the ZWJ do not matter for matching «👍» against «👍️». */
export const bareEmoji = (e: string): string => e.replace(/[︎️]/g, '');

/**
 * Stickers whose emoji is the query itself (an emoji typed or pasted) or one of the emojis the
 * query names («кот» → 🐱, via the emoji picker's keywords). Order: packs, then pack order.
 */
export function searchStickers(packs: readonly StickerPack[], q: string, emojiByName: (q: string) => string[]): Sticker[] {
  const needle = q.trim();
  if (!needle) return [];
  const wanted = new Set([bareEmoji(needle), ...emojiByName(needle).map(bareEmoji)]);
  const out: Sticker[] = [];
  for (const p of packs) for (const s of p.stickers) if (wanted.has(bareEmoji(s.emoji))) out.push(s);
  return out;
}

/** The sticker that stands for a pack in pickers: its cover, else the first one. */
export function coverOf(p: Pick<StickerPack, 'coverStickerId' | 'stickers'>): Sticker | undefined {
  return p.stickers.find((s) => s.id === p.coverStickerId) ?? p.stickers[0];
}

/** One line for a sticker message in previews and notifications: «😀 Стикер» (docs/08 «Стикеры»). */
export function stickerPreview(emoji: string | undefined): string {
  return t('stk.preview', { emoji: emoji || '🧩' });
}

/** The box a sticker is drawn in: its own proportions, the longer side = `size`. */
export function stickerBox(s: Pick<Sticker, 'width' | 'height'>, size: number): { width: number; height: number } {
  const w = s.width || size;
  const h = s.height || size;
  const k = size / Math.max(w, h);
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/** Recently sent stickers resolved against the packs I have (dropped when their pack is gone). */
export function resolveRecent(ids: readonly string[], packs: readonly StickerPack[]): Sticker[] {
  const byId = new Map<string, Sticker>();
  for (const p of packs) for (const s of p.stickers) byId.set(s.id, s);
  return ids.map((id) => byId.get(id)).filter((s): s is Sticker => !!s);
}

/** Stickers in one upload request (the server's MaxBatch); file limits — lib/stickerPrepare.ts. */
export const STICKER_BATCH = 50;
