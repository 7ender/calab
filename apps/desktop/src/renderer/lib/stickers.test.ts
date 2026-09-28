import { create } from '@bufbuild/protobuf';
import { StickerPackSchema, StickerSchema, WorkspaceRole } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { coverOf, packUsable, resolveRecent, searchStickers, stickerBox, type RoleOf } from './stickers';

const sticker = (id: string, emoji: string) => create(StickerSchema, { id, packId: 'p', emoji, url: `/api/files/${id}`, width: 160, height: 160 });
const pack = (id: string, ws: string, stickers = [sticker(`${id}-1`, '😺'), sticker(`${id}-2`, '👍️')]) =>
  create(StickerPackSchema, { id, workspaceId: ws, name: id, stickers });

describe('stickers (ADR-0030)', () => {
  const roles: Record<string, Record<string, WorkspaceRole>> = {
    w1: { me: WorkspaceRole.MEMBER, bob: WorkspaceRole.ADMIN, gus: WorkspaceRole.GUEST },
    w2: { me: WorkspaceRole.GUEST, bob: WorkspaceRole.MEMBER },
  };
  const roleOf: RoleOf = (ws, u) => roles[ws]?.[u];

  it('a pack is usable in its workspace rooms and in DMs of two non-guest members', () => {
    expect(packUsable(pack('a', 'w1'), { workspaceId: 'w1' }, 'me', roleOf)).toBe(true);
    expect(packUsable(pack('a', 'w1'), { workspaceId: 'w2' }, 'me', roleOf)).toBe(false);
    expect(packUsable(pack('a', 'w1'), { dmPeerId: 'bob' }, 'me', roleOf)).toBe(true);
    expect(packUsable(pack('a', 'w1'), { dmPeerId: 'gus' }, 'me', roleOf)).toBe(false);
    expect(packUsable(pack('a', 'w1'), { dmPeerId: 'stranger' }, 'me', roleOf)).toBe(false);
    // I am a guest of w2: its packs are not mine to send anywhere.
    expect(packUsable(pack('b', 'w2'), { workspaceId: 'w2' }, 'me', roleOf)).toBe(false);
  });

  it('searches by the emoji itself (variation selectors ignored) and by emoji names', () => {
    const packs = [pack('a', 'w1')];
    expect(searchStickers(packs, '👍', () => []).map((s) => s.id)).toEqual(['a-2']);
    expect(searchStickers(packs, 'кот', (q) => (q === 'кот' ? ['😺'] : [])).map((s) => s.id)).toEqual(['a-1']);
    expect(searchStickers(packs, '  ', () => ['😺'])).toEqual([]);
    // By pack name (case-insensitive), after the emoji matches, without duplicates.
    const named = [create(StickerPackSchema, { id: 'cats', workspaceId: 'w1', name: 'Котики', stickers: [sticker('c-1', '😺'), sticker('c-2', '🙀')] }), ...packs];
    expect(searchStickers(named, 'кот', (q) => (q === 'кот' ? ['😺'] : [])).map((s) => s.id)).toEqual(['c-1', 'a-1', 'c-2']);
  });

  it('cover, box, recent', () => {
    const p = pack('a', 'w1');
    expect(coverOf(p)?.id).toBe('a-1');
    p.coverStickerId = 'a-2';
    expect(coverOf(p)?.id).toBe('a-2');
    expect(stickerBox({ width: 512, height: 256 }, 160)).toEqual({ width: 160, height: 80 });
    expect(resolveRecent(['gone', 'a-2', 'a-1'], [p]).map((s) => s.id)).toEqual(['a-2', 'a-1']);
  });
});
