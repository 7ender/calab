import { describe, expect, it } from 'vitest';
import { deviceLabel, osLabel, updateLabel, voicePathLabel } from './format';

describe('settings format', () => {
  it('names operating systems', () => {
    expect(osLabel('darwin')).toBe('macOS');
    expect(osLabel('win32')).toBe('Windows');
    expect(osLabel('freebsd')).toBe('freebsd');
    expect(osLabel(undefined)).toBe('');
  });

  it('humanises device names', () => {
    expect(deviceLabel('MacBook Pro (darwin)')).toBe('MacBook Pro · macOS');
    expect(deviceLabel('Chrome on win32')).toBe('Chrome · Windows');
    expect(deviceLabel('  Firefox ')).toBe('Firefox');
  });

  it('describes the voice path', () => {
    expect(voicePathLabel(null)).toBeNull();
    expect(voicePathLabel({ localType: 'relay', remoteType: 'host', protocol: 'udp', relayProtocol: 'tls' })).toBe('Через ретранслятор (TLS)');
    expect(voicePathLabel({ localType: 'host', remoteType: 'host', protocol: 'udp' })).toBe('Напрямую, локальная сеть (UDP)');
    expect(voicePathLabel({ localType: 'srflx', remoteType: 'host', protocol: 'udp' })).toBe('Напрямую (UDP)');
  });

  it('describes update states', () => {
    expect(updateLabel({ state: 'disabled' })).toBeNull();
    expect(updateLabel({ state: 'available', version: '1.2.0' })).toBe('Доступна версия 1.2.0');
    expect(updateLabel({ state: 'error', message: 'ENOTFOUND' })).not.toMatch(/ENOTFOUND/);
  });
});

describe('fmtShortDate', () => {
  it('prints day, short genitive month and year', async () => {
    const { fmtShortDate } = await import('./format');
    expect(fmtShortDate(new Date(2025, 11, 1))).toBe('1 дек 2025');
    expect(fmtShortDate(new Date(2026, 4, 9))).toBe('9 мая 2026');
  });
});
