import { create } from '@bufbuild/protobuf';
import { MicMode, UserSettingsSchema } from '@calaba/protocol';
import { describe, expect, it, vi } from 'vitest';

const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});
vi.mock('../platform', () => ({ platform: { kind: 'electron', app: { log: () => undefined } } }));
vi.mock('../lib/api/endpoints', () => ({ api: { me: { update: () => Promise.resolve({}) } } }));

const { applyUserSettings, sameBinding } = await import('./profile');
const { usePrefs } = await import('../stores/prefs');

const F13 = { kind: 'key' as const, code: 0x5b, label: 'F13', mode: 'hold' as const };
const settings = (binding: unknown) =>
  create(UserSettingsSchema, { micMode: MicMode.PUSH_TO_TALK, noiseSuppression: true, pushToTalkKey: JSON.stringify({ desktop: binding }) });

describe('applyUserSettings (review M5)', () => {
  it('keeps the current binding object when the synced one is equal → no PTT re-bind', () => {
    applyUserSettings(settings(F13));
    const first = usePrefs.getState().pttBinding;
    expect(first).toMatchObject({ code: 0x5b });
    const changes: unknown[] = [];
    const unsub = usePrefs.subscribe((s, p) => {
      if (s.pttBinding !== p.pttBinding) changes.push(s.pttBinding);
    });
    // The echo of our own PATCH / a READY: a freshly parsed, structurally equal binding.
    applyUserSettings(settings({ ...F13, label: 'F13 (renamed)' }));
    applyUserSettings(settings({ ...F13 }));
    unsub();
    expect(changes).toEqual([]);
    expect(usePrefs.getState().pttBinding).toBe(first);
  });

  it('takes a really different binding', () => {
    applyUserSettings(settings(F13));
    applyUserSettings(settings({ ...F13, mode: 'toggle' }));
    expect(usePrefs.getState().pttBinding).toMatchObject({ mode: 'toggle' });
  });

  it('sameBinding compares kind, code, mode (default hold) and remap', () => {
    expect(sameBinding(null, null)).toBe(true);
    expect(sameBinding(F13, null)).toBe(false);
    expect(sameBinding(F13, { kind: 'key', code: 0x5b, label: 'x' })).toBe(true);
    expect(sameBinding(F13, { ...F13, remap: 'caps-f18' })).toBe(false);
    expect(sameBinding(F13, { kind: 'mouse', code: 0x5b, label: 'F13' })).toBe(false);
  });
});
