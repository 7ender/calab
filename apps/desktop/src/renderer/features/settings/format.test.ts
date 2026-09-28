import { describe, expect, it } from 'vitest';
import { deviceLabel, osLabel, updateAction, updateLabel, voicePathLabel } from './format';

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
    expect(updateLabel({ state: 'downloading', version: '1.2.0', percent: 42 })).toBe('Загружается версия 1.2.0 — 42 %');
    expect(updateLabel({ state: 'downloading', version: '1.2.0', percent: 42, bytesPerSecond: 1.5 * 1024 * 1024 })).toBe(
      'Загружается версия 1.2.0 — 42 % · 1,5 МБ/с',
    );
  });

  it('picks the «О программе» update button by state (docs/09 #93)', () => {
    expect(updateAction({ state: 'disabled' }, false)).toBe('check');
    expect(updateAction({ state: 'none' }, false)).toBe('check');
    expect(updateAction({ state: 'none' }, true)).toBe('checking');
    expect(updateAction({ state: 'checking' }, false)).toBe('checking');
    expect(updateAction({ state: 'available', version: '1', installable: true, downloadPage: 'https://x/' }, false)).toBe('install');
    expect(updateAction({ state: 'available', version: '1', downloadPage: 'https://x/' }, false)).toBe('page');
    expect(updateAction({ state: 'available', version: '1' }, false)).toBe('check');
    expect(updateAction({ state: 'downloading', version: '1', percent: 3 }, false)).toBe('downloading');
    expect(updateAction({ state: 'downloaded', version: '1' }, false)).toBe('restart');
    expect(updateAction({ state: 'error', message: 'x' }, false)).toBe('retry');
    expect(updateAction({ state: 'error', message: 'x' }, true)).toBe('checking');
  });
});

describe('fmt.shortDate', () => {
  it('prints day, short genitive month and year', async () => {
    const { fmt } = await import('../../lib/format');
    expect(fmt.shortDate(new Date(2025, 11, 1))).toBe('1 дек 2025');
    expect(fmt.shortDate(new Date(2026, 4, 9))).toBe('9 мая 2026');
  });
});
