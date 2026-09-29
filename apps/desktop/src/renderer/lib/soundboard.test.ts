import { describe, expect, it } from 'vitest';
import { FREQUENT_MAX, boardSections, clipVolume, createLateness, matches, toggleFavorite, type BoardSound } from './soundboard';
import { BUILTIN_SOUNDS } from './builtinSounds';

const s = (id: string, name: string, emoji = '🔊'): BoardSound => ({ id, name, emoji, durationMs: 1000 });
const builtin = [s('builtin:quack', 'Кряк', '🦆'), s('builtin:air_horn', 'Клаксон', '📯')];
const workspace = [s('w1', 'Ёлки-палки'), s('w2', 'Ба-дум-тсс', '🥁')];

describe('soundboard sections', () => {
  it('lists favourites in starred order, then frequent, workspace and built-in', () => {
    const got = boardSections({ builtin, workspace, favorites: ['builtin:air_horn', 'w1', 'gone'], usage: { w2: 3, 'builtin:quack': 5, w1: 9 }, query: '' });
    expect(got.map((x) => [x.id, x.sounds.map((y) => y.id)])).toEqual([
      ['favorites', ['builtin:air_horn', 'w1']],
      ['frequent', ['builtin:quack', 'w2']], // w1 is starred
      ['workspace', ['w1', 'w2']],
      ['builtin', ['builtin:quack', 'builtin:air_horn']],
    ]);
  });

  it('leaves out empty sections and caps «Часто используемые»', () => {
    const many = Array.from({ length: 10 }, (_, i) => s(`w${i}`, `n${i}`));
    const usage = Object.fromEntries(many.map((x, i) => [x.id, i + 1]));
    const got = boardSections({ builtin: [], workspace: many, favorites: [], usage, query: '' });
    expect(got.map((x) => x.id)).toEqual(['frequent', 'workspace']);
    expect(got[0]?.sounds).toHaveLength(FREQUENT_MAX);
    expect(got[0]?.sounds[0]?.id).toBe('w9');
  });

  it('shows one results section while searching', () => {
    expect(boardSections({ builtin, workspace, favorites: [], usage: {}, query: 'елки' })).toEqual([{ id: 'results', sounds: [workspace[0]] }]);
    expect(boardSections({ builtin, workspace, favorites: [], usage: {}, query: 'zzz' })).toEqual([]);
  });

  it('matches every word and the exact emoji', () => {
    expect(matches(s('x', 'Sad horn'), 'horn sad')).toBe(true);
    expect(matches(s('x', 'Sad horn'), 'happy')).toBe(false);
    expect(matches(s('x', 'Кряк', '🦆'), '🦆')).toBe(true);
  });

  it('toggles favourites', () => {
    expect(toggleFavorite(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleFavorite(['a', 'b'], 'a')).toEqual(['b']);
  });
});

describe('lateness of SOUND_PLAY', () => {
  it('is measured against the best recent delay, not the absolute clocks', () => {
    const late = createLateness(4);
    // My clock is 60 s ahead of the server: the first events are on time.
    expect(late(1000, 61_100)).toBe(0);
    expect(late(5000, 65_050)).toBe(0);
    // A replay 4 s after it was pressed.
    expect(late(9000, 73_050)).toBe(4000);
  });
});

describe('clip volume', () => {
  it('multiplies the headphones volume and caps at 1', () => {
    expect(clipVolume(1, 1)).toBe(1);
    expect(clipVolume(2, 0.4)).toBeCloseTo(0.8);
    expect(clipVolume(2, 1)).toBe(1);
    expect(clipVolume(0, 1)).toBe(0);
  });
});

describe('built-in clips', () => {
  it('come from the manifest with a file, an emoji and a name', () => {
    expect(BUILTIN_SOUNDS.length).toBeGreaterThanOrEqual(6);
    for (const b of BUILTIN_SOUNDS) {
      expect(b.id).toMatch(/^builtin:[a-z0-9_]{1,32}$/);
      expect(b.url).toBeTruthy();
      expect(b.emoji).toBeTruthy();
      expect(b.durationMs).toBeGreaterThan(0);
      expect(b.durationMs).toBeLessThanOrEqual(5000);
    }
  });
});
