import type { Sticker, StickerPack } from '@calaba/protocol';
import { packUsable, type RoleOf, type StickerPlace } from './stickers';

/**
 * «Стикеры по эмодзи над полем ввода» (docs/08 «Композер — подсказка стикеров», like Telegram):
 * when the composer holds exactly one emoji, the stickers carrying that emoji (ADR-0030,
 * `Sticker.emoji`) are offered above the field. Pure helpers: detection, normalization, matching.
 */

/** Tiles in the strip at most. */
export const SUGGEST_MAX = 24;

const PICTO = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u;
/** VS15/VS16 and the Fitzpatrick skin tones do not change which sticker an emoji means. */
const NOISE = /\uFE0E|\uFE0F|[\u{1F3FB}-\u{1F3FF}]/gu;

let segmenter: Intl.Segmenter | null | undefined;
function graphemes(s: string): string[] {
  if (segmenter === undefined) segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  return segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s);
}

/** The key two emojis are compared by: «👍🏽» and «👍️» are both «👍». */
export const emojiKey = (e: string): string => e.replace(NOISE, '');

/**
 * The emoji when the text is exactly one emoji (trailing whitespace allowed, nothing before it),
 * else null. Cheap for ordinary text: anything longer than one emoji can be is rejected at once.
 */
export function singleEmoji(text: string): string | null {
  const s = text.trimEnd();
  if (!s || s.length > 32 || !PICTO.test(s)) return null;
  const g = graphemes(s);
  return g.length === 1 && g[0] && PICTO.test(g[0]) && !/\s/u.test(g[0]) ? g[0] : null;
}

/**
 * Stickers whose emoji is `emoji` (skin tone / VS16 ignored) in `packs` (already filtered to the
 * ones usable here), recently sent first (in `recent` order), then pack order; ≤ `max`, no repeats.
 */
export function suggestStickers(packs: readonly StickerPack[], emoji: string, recent: readonly string[], max = SUGGEST_MAX): Sticker[] {
  const key = emojiKey(emoji);
  if (!key) return [];
  const matches: Sticker[] = [];
  const seen = new Set<string>();
  for (const p of packs) {
    for (const s of p.stickers) {
      if (!s.deleted && !seen.has(s.id) && emojiKey(s.emoji) === key) {
        seen.add(s.id);
        matches.push(s);
      }
    }
  }
  if (!matches.length) return matches;
  const rank = new Map(recent.map((id, i) => [id, i]));
  const recentFirst = matches.filter((s) => rank.has(s.id)).sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  return [...recentFirst, ...matches.filter((s) => !rank.has(s.id))].slice(0, max);
}

/**
 * The workspaces whose packs may be sent at `place` (lib/stickers packUsable), as one sorted
 * «a,b» string: a primitive a store selector can return without re-rendering on unrelated changes.
 */
export function usableWorkspaces(workspaceIds: Iterable<string>, place: StickerPlace, me: string, roleOf: RoleOf): string {
  const out: string[] = [];
  for (const w of workspaceIds) if (packUsable({ workspaceId: w }, place, me, roleOf)) out.push(w);
  return out.sort().join(',');
}
