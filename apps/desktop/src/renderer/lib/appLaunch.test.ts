import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindLaunchSignals, createLaunchProbe, deepLinkFor, launchMethod, type LaunchState } from './appLaunch';

describe('launch probe', () => {
  let states: LaunchState[];
  beforeEach(() => {
    vi.useFakeTimers();
    states = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const probe = (): ReturnType<typeof createLaunchProbe> => createLaunchProbe({ timeoutMs: 1800, lateMs: 10_000, onChange: (s) => states.push(s) });

  it('starts idle and goes trying on start', () => {
    const p = probe();
    expect(p.state).toBe('idle');
    p.start();
    expect(p.state).toBe('trying');
    expect(states).toEqual(['trying']);
  });

  it.each(['blur', 'hidden', 'pagehide'] as const)('%s within the timeout → opened', (sig) => {
    const p = probe();
    p.start();
    vi.advanceTimersByTime(1000);
    p.signal(sig);
    expect(p.state).toBe('opened');
    vi.advanceTimersByTime(5000);
    expect(p.state).toBe('opened'); // the timer was cleared
    expect(states).toEqual(['trying', 'opened']);
  });

  it('no signal within the timeout → not-found', () => {
    const p = probe();
    p.start();
    vi.advanceTimersByTime(1799);
    expect(p.state).toBe('trying');
    vi.advanceTimersByTime(1);
    expect(p.state).toBe('not-found');
  });

  it('a late signal (user confirmed the browser prompt) still flips to opened', () => {
    const p = probe();
    p.start();
    vi.advanceTimersByTime(1800 + 3000);
    p.signal('blur');
    expect(p.state).toBe('opened');
    expect(states).toEqual(['trying', 'not-found', 'opened']);
  });

  it('a signal after the late window is ignored', () => {
    const p = probe();
    p.start();
    vi.advanceTimersByTime(1800 + 10_000);
    p.signal('blur');
    expect(p.state).toBe('not-found');
  });

  it('signals before start are ignored', () => {
    const p = probe();
    p.signal('blur');
    expect(p.state).toBe('idle');
    expect(states).toEqual([]);
  });

  it('a second start restarts the attempt', () => {
    const p = probe();
    p.start();
    vi.advanceTimersByTime(1800);
    expect(p.state).toBe('not-found');
    p.start();
    expect(p.state).toBe('trying');
    vi.advanceTimersByTime(1000);
    p.signal('hidden');
    expect(p.state).toBe('opened');
  });

  it('dispose stops the timer and ignores signals', () => {
    const p = probe();
    p.start();
    p.dispose();
    vi.advanceTimersByTime(5000);
    p.signal('blur');
    expect(p.state).toBe('trying');
    expect(states).toEqual(['trying']);
  });
});

describe('bindLaunchSignals', () => {
  it('maps window/document events and unsubscribes', () => {
    const win = new EventTarget() as unknown as Window;
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' }) as unknown as Document & { visibilityState: string };
    const got: string[] = [];
    const off = bindLaunchSignals({ signal: (s) => got.push(s) }, win, doc);
    win.dispatchEvent(new Event('blur'));
    doc.dispatchEvent(new Event('visibilitychange')); // still visible: ignored
    (doc as { visibilityState: string }).visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    win.dispatchEvent(new Event('pagehide'));
    expect(got).toEqual(['blur', 'hidden', 'pagehide']);
    off();
    win.dispatchEvent(new Event('blur'));
    expect(got).toHaveLength(3);
  });
});

describe('launch helpers', () => {
  it('uses an iframe in Firefox only', () => {
    expect(launchMethod('Mozilla/5.0 (Macintosh) Gecko/20100101 Firefox/130.0')).toBe('iframe');
    expect(launchMethod('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130.0 Safari/537.36')).toBe('location');
    expect(launchMethod('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15')).toBe('location');
  });
  it('builds the internal deep link', () => {
    expect(deepLinkFor('join', 'abcd1234')).toBe('calab://join/abcd1234');
    expect(deepLinkFor('r', 'abcd1234')).toBe('calab://r/abcd1234');
  });
});
