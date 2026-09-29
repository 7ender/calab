import { create } from '@bufbuild/protobuf';
import { StickerPackSchema, StickerSchema, WorkspaceRole } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { emojiKey, singleEmoji, suggestStickers, usableWorkspaces } from './stickerSuggest';

const sticker = (id: string, emoji: string, deleted = false) => create(StickerSchema, { id, packId: 'p', emoji, url: `/api/files/${id}`, width: 160, height: 160, deleted });
const pack = (id: string, stickers: ReturnType<typeof sticker>[]) => create(StickerPackSchema, { id, workspaceId: 'w1', name: id, stickers });

describe('sticker suggestions by emoji (docs/08 «Композер — подсказка стикеров»)', () => {
  it('normalizes: skin tones and variation selectors do not matter', () => {
    expect(emojiKey('👍🏽')).toBe('👍');
    expect(emojiKey('👍️')).toBe('👍');
    expect(emojiKey('❤️')).toBe(emojiKey('❤'));
    expect(emojiKey('👨‍👩‍👧')).toBe('👨‍👩‍👧');
  });

  it('detects exactly one emoji, trailing whitespace allowed', () => {
    expect(singleEmoji('😂')).toBe('😂');
    expect(singleEmoji('😂 ')).toBe('😂');
    expect(singleEmoji('😂\n')).toBe('😂');
    expect(singleEmoji('❤️')).toBe('❤️');
    expect(singleEmoji('👍🏽')).toBe('👍🏽');
    expect(singleEmoji('👨‍👩‍👧')).toBe('👨‍👩‍👧');
    expect(singleEmoji('🇷🇺')).toBe('🇷🇺');
    expect(singleEmoji(' 😂')).toBeNull();
    expect(singleEmoji('😂😂')).toBeNull();
    expect(singleEmoji('😂 ок')).toBeNull();
    expect(singleEmoji('a')).toBeNull();
    expect(singleEmoji('1')).toBeNull();
    expect(singleEmoji('')).toBeNull();
    expect(singleEmoji('   ')).toBeNull();
  });

  it('matches by emoji key, recent first, then pack order, no repeats, capped', () => {
    const packs = [
      pack('a', [sticker('a1', '😂'), sticker('a2', '🔥'), sticker('a3', '😂️'), sticker('a4', '😂', true)]),
      pack('b', [sticker('b1', '😂'), sticker('a1', '😂')]),
    ];
    expect(suggestStickers(packs, '😂', []).map((s) => s.id)).toEqual(['a1', 'a3', 'b1']);
    expect(suggestStickers(packs, '😂', ['x', 'b1', 'a2', 'a3']).map((s) => s.id)).toEqual(['b1', 'a3', 'a1']);
    expect(suggestStickers(packs, '😂', [], 2).map((s) => s.id)).toEqual(['a1', 'a3']);
    expect(suggestStickers(packs, '👍', [])).toEqual([]);
    const toned = [pack('c', [sticker('c1', '👍'), sticker('c2', '👍🏿')])];
    expect(suggestStickers(toned, '👍🏽', []).map((s) => s.id)).toEqual(['c1', 'c2']);
  });

  it('usable workspaces: a room takes its own, a DM the ones both are members of', () => {
    const roles: Record<string, Record<string, WorkspaceRole>> = {
      w1: { me: WorkspaceRole.MEMBER, bob: WorkspaceRole.ADMIN },
      w2: { me: WorkspaceRole.OWNER, bob: WorkspaceRole.MEMBER },
      w3: { me: WorkspaceRole.GUEST, bob: WorkspaceRole.MEMBER },
    };
    const roleOf = (ws: string, u: string) => roles[ws]?.[u];
    expect(usableWorkspaces(['w1', 'w2', 'w3'], { workspaceId: 'w1' }, 'me', roleOf)).toBe('w1');
    expect(usableWorkspaces(['w3'], { workspaceId: 'w3' }, 'me', roleOf)).toBe('');
    expect(usableWorkspaces(['w2', 'w1', 'w3'], { dmPeerId: 'bob' }, 'me', roleOf)).toBe('w1,w2');
  });
});
