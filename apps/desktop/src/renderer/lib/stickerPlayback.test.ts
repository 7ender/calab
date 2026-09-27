import { describe, expect, it } from 'vitest';
import { createPlayback } from './stickerPlayback';

describe('sticker playback budget (ADR-0030 §8)', () => {
  it('plays only visible stickers, at most `max`, first visible first', () => {
    const p = createPlayback(2);
    const log: string[] = [];
    for (const id of [1, 2, 3]) p.add(id, (on) => log.push(`${id}:${on ? 'play' : 'still'}`));
    p.setVisible(1, true);
    p.setVisible(2, true);
    p.setVisible(3, true);
    expect([p.isPlaying(1), p.isPlaying(2), p.isPlaying(3)]).toEqual([true, true, false]);
    // One scrolls away: the waiting one takes its slot.
    p.setVisible(1, false);
    expect([p.isPlaying(1), p.isPlaying(2), p.isPlaying(3)]).toEqual([false, true, true]);
    expect(log).toEqual(['1:play', '2:play', '1:still', '3:play']);
  });

  it('stops everything while disabled (hidden window, reduced motion) and resumes after', () => {
    const p = createPlayback(6);
    p.add(1, () => undefined);
    p.setVisible(1, true);
    p.setEnabled(false);
    expect(p.isPlaying(1)).toBe(false);
    p.setEnabled(true);
    expect(p.isPlaying(1)).toBe(true);
  });

  it('removing a playing sticker frees its slot', () => {
    const p = createPlayback(1);
    p.add(1, () => undefined);
    p.add(2, () => undefined);
    p.setVisible(1, true);
    p.setVisible(2, true);
    expect(p.isPlaying(2)).toBe(false);
    p.remove(1);
    expect(p.isPlaying(2)).toBe(true);
  });
});
