import { describe, expect, it } from 'vitest';
import type { UpdateStatus } from '../../../shared/ipc';
import { bannerVersion, onUpdateStatus, type UpdateBannerState } from './updateBannerState';

describe('update banner', () => {
  it('shows only for a downloaded update', () => {
    const states: UpdateStatus[] = [
      { state: 'disabled' },
      { state: 'checking' },
      { state: 'none' },
      { state: 'available', version: '0.3.0' },
      { state: 'downloading', version: '0.3.0', percent: 40 },
      { state: 'error', message: 'x' },
    ];
    for (const s of states) expect(bannerVersion(onUpdateStatus(s))).toBeNull();
    expect(bannerVersion(onUpdateStatus({ state: 'downloaded', version: '0.3.0' }))).toBe('0.3.0');
  });

  it('closed → hidden until the next status event (main re-announces on the next check)', () => {
    let s: UpdateBannerState = onUpdateStatus({ state: 'downloaded', version: '0.3.0' });
    s = { ...s, updateDismissed: true };
    expect(bannerVersion(s)).toBeNull();
    s = onUpdateStatus({ state: 'downloaded', version: '0.3.0' });
    expect(bannerVersion(s)).toBe('0.3.0');
  });
});
