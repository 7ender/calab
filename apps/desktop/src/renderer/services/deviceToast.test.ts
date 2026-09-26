import { describe, expect, it, vi } from 'vitest';

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
vi.mock('../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined } } }));

const { announceDeviceSwitch, DEVICE_TOAST_MS } = await import('./deviceToast');
const { useToasts } = await import('../stores/toasts');
const { useUi } = await import('../stores/ui');

describe('announceDeviceSwitch', () => {
  it('raises a short green toast whose action opens the device settings', () => {
    announceDeviceSwitch({ kind: 'output', label: 'AirPods Pro' }, 1000);
    const toast = useToasts.getState().items.at(-1);
    expect(toast).toMatchObject({ kind: 'success', text: 'Вывод: AirPods Pro', durationMs: DEVICE_TOAST_MS, action: { label: 'Изменить' } });
    toast?.action?.run();
    expect(useUi.getState().dialog).toEqual({ kind: 'settings', tab: 'voice' });
  });

  it('shows the same switch once within 5 s', () => {
    const before = useToasts.getState().items.length;
    announceDeviceSwitch({ kind: 'input', label: 'MacBook Mic' }, 10_000);
    announceDeviceSwitch({ kind: 'input', label: 'MacBook Mic' }, 12_000);
    expect(useToasts.getState().items.length).toBe(before + 1);
    expect(useToasts.getState().items.at(-1)?.text).toBe('Микрофон: MacBook Mic');
    announceDeviceSwitch({ kind: 'input', label: 'MacBook Mic' }, 20_000);
    expect(useToasts.getState().items.at(-1)?.count).toBe(2);
  });
});
