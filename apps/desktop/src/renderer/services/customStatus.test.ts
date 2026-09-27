import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STATUS_PRESETS, pushRecentStatus, type StatusChoice } from './customStatus';

const setStatus = vi.fn((_s: { text: string; emoji: string; expiresInSeconds: number }) => Promise.resolve({ me: undefined }));
vi.mock('../lib/api/endpoints', () => ({ api: { me: { setStatus: (s: { text: string; emoji: string; expiresInSeconds: number }) => setStatus(s), update: vi.fn() } } }));
vi.mock('../stores/toasts', () => ({ toast: { fail: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined } } }));
vi.mock('./gateway', () => ({ setPresence: vi.fn() }));

const { applyCustomStatus } = await import('./customStatus');
const { usePrefs } = await import('../stores/prefs');
const { t } = await import('../i18n');

const c = (text: string, emoji = '🙂', after: StatusChoice['after'] = 'never'): StatusChoice => ({ emoji, text, after });

describe('pushRecentStatus', () => {
  it('puts the new status first, drops duplicates, keeps 3', () => {
    let list: StatusChoice[] = [];
    for (const s of ['a', 'b', 'c', 'd']) list = pushRecentStatus(list, c(s), []);
    expect(list.map((r) => r.text)).toEqual(['d', 'c', 'b']);
    list = pushRecentStatus(list, c('b', '🙂', '1h'), []);
    expect(list.map((r) => [r.text, r.after])).toEqual([
      ['b', '1h'],
      ['d', 'never'],
      ['c', 'never'],
    ]);
  });

  it('skips presets and empty text; the same text with another emoji is another status', () => {
    const presets = [{ emoji: '📅', text: 'На встрече' }];
    expect(pushRecentStatus([], c('На встрече', '📅'), presets)).toEqual([]);
    expect(pushRecentStatus([], c('  ', '📅'), presets)).toEqual([]);
    expect(pushRecentStatus([], c('На встрече', '🎉'), presets)).toHaveLength(1);
    expect(pushRecentStatus([c('x', '🙂')], c(' x ', '🎉'), [])).toHaveLength(2);
  });
});

describe('applyCustomStatus', () => {
  beforeEach(() => {
    setStatus.mockClear();
    usePrefs.getState().setPrefs({ recentStatuses: [] });
  });

  it('a preset sets its emoji, text and expiry — and is not added to recents', async () => {
    const [meeting, , focus] = STATUS_PRESETS;
    if (!meeting || !focus) throw new Error('presets');
    expect(await applyCustomStatus({ emoji: meeting.emoji, text: t(meeting.key), after: meeting.after })).toBe(true);
    expect(setStatus).toHaveBeenLastCalledWith({ text: t(meeting.key), emoji: '📅', expiresInSeconds: 3600 });
    // «До конца дня» = the next local midnight.
    await applyCustomStatus({ emoji: focus.emoji, text: t(focus.key), after: focus.after }, new Date(2026, 8, 27, 22, 30));
    expect(setStatus).toHaveBeenLastCalledWith({ text: t(focus.key), emoji: '🎧', expiresInSeconds: 90 * 60 });
    expect(usePrefs.getState().recentStatuses).toEqual([]);
  });

  it('a custom status goes to the top of recents; an empty one clears without a record', async () => {
    await applyCustomStatus(c('Пишу ADR', '✍️', '4h'));
    await applyCustomStatus(c('  Code review ', '👀'));
    expect(setStatus).toHaveBeenLastCalledWith({ text: 'Code review', emoji: '👀', expiresInSeconds: 0 });
    expect(usePrefs.getState().recentStatuses).toEqual([c('Code review', '👀'), c('Пишу ADR', '✍️', '4h')]);
    await applyCustomStatus(c('', '👀', '1h'));
    expect(setStatus).toHaveBeenLastCalledWith({ text: '', emoji: '', expiresInSeconds: 0 });
    expect(usePrefs.getState().recentStatuses).toHaveLength(2);
  });

  it('a failed save leaves recents alone', async () => {
    setStatus.mockRejectedValueOnce(new Error('offline'));
    expect(await applyCustomStatus(c('Не сохранится'))).toBe(false);
    expect(usePrefs.getState().recentStatuses).toEqual([]);
  });
});
