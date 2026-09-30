import { describe, expect, it } from 'vitest';
import { outputKind, outputLabel } from './outputKind';

describe('outputKind (ADR-0052 speaker warning)', () => {
  it('recognises built-in and external speakers', () => {
    for (const l of ['MacBook Pro Speakers (Built-in)', 'MacBook Air Speakers', 'Built-in Output', 'Speakers (Realtek(R) Audio)', 'Динамики (Realtek High Definition Audio)', 'Встроенные динамики'])
      expect(outputKind(l)).toBe('speakers');
  });

  it('headphone words win over speaker words', () => {
    for (const l of ['AirPods Pro', 'External Headphones', 'Headset Earphone (Jabra)', 'Наушники (Realtek)', 'Galaxy Buds2', 'Speakers (Logitech Headset)'])
      expect(outputKind(l)).toBe('headphones');
  });

  it('unknown for anything else', () => {
    for (const l of ['', 'JBL Flip 6', 'LG HDR 4K (DisplayPort)', 'Focusrite USB'] ) expect(outputKind(l)).toBe('unknown');
  });
});

describe('outputLabel', () => {
  const devices = [
    { kind: 'audioinput' as const, deviceId: 'default', label: 'Default - MacBook Pro Microphone' },
    { kind: 'audiooutput' as const, deviceId: 'default', label: 'Default - MacBook Pro Speakers (Built-in)' },
    { kind: 'audiooutput' as const, deviceId: 'abc', label: 'AirPods Pro' },
  ];
  it('the chosen output, else the system default without its prefix', () => {
    expect(outputLabel(devices, 'abc')).toBe('AirPods Pro');
    expect(outputLabel(devices, null)).toBe('MacBook Pro Speakers (Built-in)');
    expect(outputLabel(devices, 'gone')).toBe('MacBook Pro Speakers (Built-in)');
    expect(outputLabel([], null)).toBe('');
  });
});
