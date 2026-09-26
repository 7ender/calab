import { describe, expect, it } from 'vitest';
import { activeDevice, audioDevices, deviceName, deviceSwitches, type AudioDevice, type DeviceChoice } from './deviceSwitch';

const mic = (deviceId: string, label: string, groupId = deviceId): AudioDevice => ({ deviceId, groupId, kind: 'audioinput', label });
const out = (deviceId: string, label: string, groupId = deviceId): AudioDevice => ({ deviceId, groupId, kind: 'audiooutput', label });
const SYSTEM: DeviceChoice = { micDeviceId: null, outputDeviceId: null };

// Chromium on macOS: a «default» alias entry per kind + the physical devices.
const builtIn = [
  mic('default', 'Default - MacBook Pro Microphone (Built-in)', 'g-mbp'),
  mic('mbp-mic', 'MacBook Pro Microphone (Built-in)', 'g-mbp'),
  out('default', 'Default - MacBook Pro Speakers (Built-in)', 'g-mbp-out'),
  out('mbp-out', 'MacBook Pro Speakers (Built-in)', 'g-mbp-out'),
];
const withAirPods = [
  mic('default', 'Default - AirPods Pro', 'g-air'),
  mic('mbp-mic', 'MacBook Pro Microphone (Built-in)', 'g-mbp'),
  mic('air-mic', 'AirPods Pro', 'g-air'),
  out('default', 'Default - AirPods Pro', 'g-air'),
  out('mbp-out', 'MacBook Pro Speakers (Built-in)', 'g-mbp-out'),
  out('air-out', 'AirPods Pro', 'g-air'),
];

describe('deviceName', () => {
  it('drops the alias prefix and the USB id', () => {
    expect(deviceName('Default - AirPods Pro')).toBe('AirPods Pro');
    expect(deviceName('По умолчанию - Наушники')).toBe('Наушники');
    expect(deviceName('Communications - Logitech USB Headset (046d:0a8f)')).toBe('Logitech USB Headset');
    expect(deviceName('MacBook Pro Microphone (Built-in)')).toBe('MacBook Pro Microphone (Built-in)');
  });
});

describe('activeDevice', () => {
  it('uses the chosen device while present, else the default alias, else the first real one', () => {
    expect(activeDevice(withAirPods, 'audioinput', 'mbp-mic')?.deviceId).toBe('mbp-mic');
    expect(activeDevice(builtIn, 'audioinput', 'air-mic')?.deviceId).toBe('default');
    expect(activeDevice([mic('communications', 'Communications - X'), mic('a', 'A'), mic('b', 'B')], 'audioinput', null)?.deviceId).toBe('a');
    expect(activeDevice([], 'audiooutput', null)).toBeNull();
  });
});

describe('deviceSwitches', () => {
  it('headset plugged in while following the system default → both toasts', () => {
    expect(deviceSwitches(builtIn, withAirPods, SYSTEM)).toEqual([
      { kind: 'input', label: 'AirPods Pro' },
      { kind: 'output', label: 'AirPods Pro' },
    ]);
  });

  it('headset unplugged → back to the built-in devices', () => {
    expect(deviceSwitches(withAirPods, builtIn, SYSTEM)).toEqual([
      { kind: 'input', label: 'MacBook Pro Microphone (Built-in)' },
      { kind: 'output', label: 'MacBook Pro Speakers (Built-in)' },
    ]);
  });

  it('a chosen device keeps being used when another one comes and goes', () => {
    const choice = { micDeviceId: 'mbp-mic', outputDeviceId: 'mbp-out' };
    expect(deviceSwitches(builtIn, withAirPods, choice)).toEqual([]);
    expect(deviceSwitches(withAirPods, builtIn, choice)).toEqual([]);
  });

  it('the chosen device unplugged → the default takes over; plugged back → it is used again', () => {
    const choice = { micDeviceId: 'air-mic', outputDeviceId: null };
    expect(deviceSwitches(withAirPods, builtIn, choice)).toEqual([
      { kind: 'input', label: 'MacBook Pro Microphone (Built-in)' },
      { kind: 'output', label: 'MacBook Pro Speakers (Built-in)' },
    ]);
    expect(deviceSwitches(builtIn, withAirPods, choice)).toEqual([
      { kind: 'input', label: 'AirPods Pro' },
      { kind: 'output', label: 'AirPods Pro' },
    ]);
  });

  it('only the output default moved (wired headphones) → one toast', () => {
    const next = builtIn.map((d) => (d.kind === 'audiooutput' && d.deviceId === 'default' ? { ...d, label: 'Default - External Headphones' } : d));
    expect(deviceSwitches(builtIn, [...next, out('ext', 'External Headphones')], SYSTEM)).toEqual([{ kind: 'output', label: 'External Headphones' }]);
  });

  it('an unrelated device appearing changes nothing', () => {
    expect(deviceSwitches(builtIn, [...builtIn, mic('usb', 'USB Mic (1234:abcd)')], SYSTEM)).toEqual([]);
  });

  it('no toast when labels are not known yet (no permission) or a kind has no devices', () => {
    const hidden = [mic('', ''), out('', '')];
    expect(deviceSwitches(hidden, withAirPods, SYSTEM)).toEqual([]);
    expect(deviceSwitches(withAirPods, hidden, SYSTEM)).toEqual([]);
    expect(deviceSwitches([], withAirPods, SYSTEM)).toEqual([]);
    expect(deviceSwitches(withAirPods, withAirPods.filter((d) => d.kind === 'audioinput'), SYSTEM)).toEqual([]);
  });

  it('browsers without the default alias: the first device is the default', () => {
    const before = [mic('a', 'Built-in'), out('o', 'Speakers')];
    const after = [mic('h', 'Headset'), mic('a', 'Built-in'), out('o', 'Speakers')];
    expect(deviceSwitches(before, after, SYSTEM)).toEqual([{ kind: 'input', label: 'Headset' }]);
  });
});

describe('audioDevices', () => {
  it('keeps only audio entries', () => {
    const list = [
      { deviceId: 'a', groupId: 'g', kind: 'audioinput' as const, label: 'A' },
      { deviceId: 'v', groupId: 'g', kind: 'videoinput' as const, label: 'Cam' },
    ];
    expect(audioDevices(list)).toEqual([{ deviceId: 'a', groupId: 'g', kind: 'audioinput', label: 'A' }]);
  });
});
