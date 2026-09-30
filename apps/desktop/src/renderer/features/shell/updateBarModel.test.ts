import { describe, expect, it } from 'vitest';
import type { UpdateStatus } from '../../../shared/ipc';
import { CLOSE_MS, LATER_MS, NAG_LATER, hasPendingUpdate, laterAllowed, nagOnStart, pendingUpdate, snooze, snoozed, type UpdateInput } from './updateBarModel';

const base: UpdateInput = { update: { state: 'none' }, webVersion: '', appVersion: '0.9.0', autoUpdate: true };
const at = (update: UpdateStatus, over: Partial<UpdateInput> = {}): UpdateInput => ({ ...base, update, ...over });

describe('pendingUpdate', () => {
  it('nothing for idle / checking / error states', () => {
    for (const s of [{ state: 'disabled' }, { state: 'checking' }, { state: 'none' }, { state: 'error', message: 'x' }] as UpdateStatus[]) {
      expect(pendingUpdate(at(s))).toBeNull();
    }
  });
  it('downloaded → the bar', () => {
    expect(pendingUpdate(at({ state: 'downloaded', version: '0.9.1' }))).toEqual({ kind: 'downloaded', version: '0.9.1' });
  });
  it('never offers a version not newer than the running one (stale feed)', () => {
    expect(pendingUpdate(at({ state: 'downloaded', version: '0.9.0' }))).toBeNull();
    expect(pendingUpdate(at({ state: 'available', version: '0.7.0', downloadPage: 'https://x/' }))).toBeNull();
    expect(pendingUpdate(at({ state: 'none' }, { webVersion: '0.8.0' }))).toBeNull();
  });
  it('available: notify-only and manual are shown; a newer version replacing a pending download in auto mode is not', () => {
    expect(pendingUpdate(at({ state: 'available', version: '0.9.1', downloadPage: 'https://x/' }))).toEqual({
      kind: 'available',
      version: '0.9.1',
      installable: false,
      downloadPage: 'https://x/',
    });
    expect(pendingUpdate(at({ state: 'available', version: '0.9.1', installable: true }, { autoUpdate: false }))).toMatchObject({ installable: true });
    expect(pendingUpdate(at({ state: 'available', version: '0.9.1', installable: true }))).toBeNull();
  });
  it('downloading: only a download the user started (auto-update off)', () => {
    const s: UpdateStatus = { state: 'downloading', version: '0.9.1', percent: 42 };
    expect(pendingUpdate(at(s))).toBeNull();
    expect(pendingUpdate(at(s, { autoUpdate: false }))).toEqual({ kind: 'downloading', version: '0.9.1', percent: 42 });
    expect(hasPendingUpdate(at(s, { autoUpdate: false }))).toBe(false);
  });
  it('web: the server is newer than the bundle', () => {
    expect(pendingUpdate(at({ state: 'disabled' }, { webVersion: '0.9.1', autoUpdate: false }))).toEqual({ kind: 'web', version: '0.9.1' });
    expect(pendingUpdate(at({ state: 'disabled' }, { webVersion: 'dev' }))).toBeNull();
    expect(hasPendingUpdate(at({ state: 'disabled' }, { webVersion: '0.9.1' }))).toBe(true);
  });
});

describe('nag cadence', () => {
  const v = '0.9.0';
  it('«Позже» hides for 4 h and is offered NAG_LATER times, then only «×» (24 h)', () => {
    let nag = null;
    let now = 1_000;
    for (let i = 0; i < NAG_LATER; i++) {
      expect(laterAllowed(nag, v)).toBe(true);
      nag = snooze(nag, v, now, 'later');
      expect(snoozed(nag, v, now + LATER_MS - 1)).toBe(true);
      now += LATER_MS;
      expect(snoozed(nag, v, now)).toBe(false);
    }
    expect(laterAllowed(nag, v)).toBe(false);
    nag = snooze(nag, v, now, 'close');
    expect(nag.later).toBe(NAG_LATER);
    expect(snoozed(nag, v, now + CLOSE_MS - 1)).toBe(true);
    expect(snoozed(nag, v, now + CLOSE_MS)).toBe(false);
    expect(laterAllowed(nag, v)).toBe(false);
  });
  it('app start: «Позже» ends, «×» keeps its 24 h, another app version forgets all', () => {
    const later = snooze(null, v, 0, 'later');
    expect(nagOnStart(later, v)).toEqual({ ...later, until: 0 });
    const closed = snooze(later, v, 0, 'close');
    expect(nagOnStart(closed, v)).toBe(closed);
    expect(nagOnStart(closed, '0.9.1')).toBeNull();
    expect(laterAllowed(closed, '0.9.1')).toBe(true);
    expect(snoozed(closed, '0.9.1', 1)).toBe(false);
  });
});
